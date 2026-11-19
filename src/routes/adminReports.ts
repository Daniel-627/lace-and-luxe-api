import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { normalizeKePhone } from "../lib/phone.js";
import { requireOwner, requireStaff } from "../middleware/staff.js";

// Customers (staff and owner) and sales reports (owner only).
const r = Router();
r.use(requireStaff);

const EAT = 3 * 3600 * 1000; // Kenya is UTC+3, no daylight saving
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayKey = (d: Date) => new Date(d.getTime() + EAT).toISOString().slice(0, 10);

// ---------- Customers ----------
// A customer is anyone who has ordered, grouped by phone number, so guest checkouts count too.
r.get("/customers", ah(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 60) : "";
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = 30;
  const phone = q ? normalizeKePhone(q) : null;
  const where: Prisma.OrderWhereInput = {
    status: { not: "EXPIRED" },
    ...(q && { OR: [{ contactName: { contains: q, mode: "insensitive" as const } }, ...(phone ? [{ contactPhone: phone }] : [])] }),
  };

  const [groups, everyone] = await Promise.all([
    db.order.groupBy({
      by: ["contactPhone"], where, _count: { _all: true }, _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } }, skip: (page - 1) * size, take: size,
    }),
    db.order.findMany({ where, distinct: ["contactPhone"], select: { contactPhone: true } }),
  ]);
  const phones = groups.map((g) => g.contactPhone);
  const [paid, latest, accounts] = await Promise.all([
    db.order.groupBy({ by: ["contactPhone"], where: { contactPhone: { in: phones }, status: "PAID", fulfilment: { not: "CANCELLED" } }, _sum: { total: true } }),
    db.order.findMany({ where: { contactPhone: { in: phones } }, orderBy: { createdAt: "desc" }, distinct: ["contactPhone"], select: { contactPhone: true, contactName: true, email: true } }),
    db.customer.findMany({ where: { phone: { in: phones } }, select: { phone: true } }),
  ]);
  const spent = new Map(paid.map((p) => [p.contactPhone, p._sum.total ?? 0]));
  const who = new Map(latest.map((l) => [l.contactPhone, l]));
  const hasAccount = new Set(accounts.map((a) => a.phone));

  res.json({
    total: everyone.length, page, pageSize: size,
    customers: groups.map((g) => ({
      phone: g.contactPhone,
      name: who.get(g.contactPhone)?.contactName ?? "",
      email: who.get(g.contactPhone)?.email ?? null,
      orders: g._count._all,
      spent: spent.get(g.contactPhone) ?? 0,
      lastOrderAt: g._max.createdAt,
      hasAccount: hasAccount.has(g.contactPhone),
    })),
  });
}));

r.get("/customers/:phone", ah(async (req, res) => {
  const phone = req.params.phone;
  if (!/^\d{9,15}$/.test(phone)) return res.status(400).json({ error: "Bad phone number" });
  const [orders, account] = await Promise.all([
    db.order.findMany({ where: { contactPhone: phone }, include: { items: true }, orderBy: { createdAt: "desc" }, take: 100 }),
    db.customer.findUnique({ where: { phone }, include: { addresses: true, _count: { select: { reviews: true, wishlist: true } } } }),
  ]);
  if (!orders.length && !account) return res.status(404).json({ error: "Not found" });
  const real = orders.filter((o) => o.status === "PAID" && o.fulfilment !== "CANCELLED");
  res.json({
    phone,
    name: account?.name ?? orders[0]?.contactName ?? "",
    email: account?.email ?? orders.find((o) => o.email)?.email ?? null,
    account: account && { joinedAt: account.createdAt, addresses: account.addresses, reviews: account._count.reviews, wishlist: account._count.wishlist },
    stats: { orders: orders.filter((o) => o.status !== "EXPIRED").length, paidOrders: real.length, spent: real.reduce((s, o) => s + o.total, 0) },
    orders,
  });
}));

// ---------- Sales report (owner only) ----------
// Counts paid orders that were not cancelled, by the day the order was placed (Kenya time).
r.get("/reports/sales", requireOwner, ah(async (req, res) => {
  const today = dayKey(new Date());
  const str = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : "");
  const to = DATE.test(str("to")) ? str("to") : today;
  const from = DATE.test(str("from")) ? str("from") : dayKey(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY));
  const startMs = Date.parse(`${from}T00:00:00Z`), endMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return res.status(400).json({ error: "The end date must be on or after the start date" });
  const days = Math.round((endMs - startMs) / DAY) + 1;
  if (days > 366) return res.status(400).json({ error: "Pick a range of one year or less" });
  const range = { gte: new Date(startMs - EAT), lt: new Date(endMs - EAT + DAY) };

  const [paid, outstanding, cancelledPaid] = await Promise.all([
    db.order.findMany({ where: { status: "PAID", fulfilment: { not: "CANCELLED" }, createdAt: range }, include: { items: true } }),
    db.order.aggregate({ where: { status: "PENDING", fulfilment: { not: "CANCELLED" }, createdAt: range }, _count: { _all: true }, _sum: { total: true } }),
    db.order.aggregate({ where: { status: "PAID", fulfilment: "CANCELLED", createdAt: range }, _count: { _all: true }, _sum: { total: true } }),
  ]);

  const daily = new Map<string, { date: string; revenue: number; orders: number }>();
  for (let i = 0; i < days; i++) { const d = dayKey(new Date(startMs + i * DAY - EAT + 12 * 3600_000)); daily.set(d, { date: d, revenue: 0, orders: 0 }); }
  const method = new Map<string, { method: string; orders: number; revenue: number }>();
  const county = new Map<string, { county: string; orders: number; revenue: number }>();
  const product = new Map<number, { productId: number; name: string; units: number; revenue: number }>();
  let revenue = 0, units = 0, deliveryFees = 0, discounts = 0;

  for (const o of paid) {
    revenue += o.total; deliveryFees += o.deliveryFee; discounts += o.discountAmount;
    const d = daily.get(dayKey(o.createdAt)); if (d) { d.revenue += o.total; d.orders += 1; }
    const mk = o.method ?? "UNKNOWN"; const m = method.get(mk) ?? { method: mk, orders: 0, revenue: 0 }; m.orders += 1; m.revenue += o.total; method.set(mk, m);
    const c = county.get(o.county) ?? { county: o.county, orders: 0, revenue: 0 }; c.orders += 1; c.revenue += o.total; county.set(o.county, c);
    for (const i of o.items) {
      units += i.qty;
      const p = product.get(i.productId) ?? { productId: i.productId, name: i.name, units: 0, revenue: 0 };
      p.units += i.qty; p.revenue += i.price * i.qty; product.set(i.productId, p);
    }
  }

  const top = <T extends { revenue: number }>(m: { values(): Iterable<T> }, n: number) => [...m.values()].sort((a, b) => b.revenue - a.revenue).slice(0, n);
  res.json({
    from, to, days,
    totals: { revenue, orders: paid.length, units, avgOrder: paid.length ? Math.round(revenue / paid.length) : 0, deliveryFees, discounts },
    daily: [...daily.values()],
    byMethod: top(method, 10),
    byCounty: top(county, 10),
    topProducts: top(product, 10),
    outstanding: { count: outstanding._count._all, value: outstanding._sum.total ?? 0 },
    cancelledPaid: { count: cancelledPaid._count._all, value: cancelledPaid._sum.total ?? 0 },
  });
}));

export default r;
