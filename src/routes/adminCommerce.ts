import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { audit } from "../lib/audit.js";
import { normalizeKePhone } from "../lib/phone.js";
import { requireOwner, requireStaff } from "../middleware/staff.js";

// Delivery, payment accounts and discount codes: owner only.
const r = Router();
r.use(requireStaff, requireOwner);

const idOf = (v: string) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const first = (e: z.ZodError) => e.issues[0]?.message ?? "Invalid input";
const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

// ---------- Delivery ----------
const RateIn = z.object({
  county: z.string().trim().min(2).max(40),
  area: z.string().trim().max(60).nullish(),
  fee: z.number().int().min(0).max(100_000),
  freeAbove: z.number().int().min(1).max(10_000_000).nullish(),
  etaText: z.string().trim().max(60).nullish(),
});
const ServiceIn = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).default(""),
  etaText: z.string().trim().max(60).default(""),
  active: z.boolean().default(true),
  allowsCod: z.boolean().default(false),
  rates: z.array(RateIn).max(400),
});
const rateRows = (rates: z.infer<typeof RateIn>[]) =>
  rates.map((x) => ({ county: x.county, area: x.area?.trim() || null, fee: x.fee, freeAbove: x.freeAbove ?? null, etaText: x.etaText?.trim() || null }));
const dupe = (rates: z.infer<typeof RateIn>[]) => {
  const seen = new Set<string>();
  for (const x of rates) {
    const k = `${x.county.toLowerCase()}|${(x.area ?? "").trim().toLowerCase()}`;
    if (seen.has(k)) return `${x.county}${x.area ? ` / ${x.area}` : ""} is listed twice`;
    seen.add(k);
  }
  return null;
};
const svcInclude = { rates: { orderBy: [{ county: "asc" as const }, { area: "asc" as const }] } };

r.get("/delivery", ah(async (_req, res) => {
  res.json(await db.deliveryService.findMany({ include: svcInclude, orderBy: [{ position: "asc" }, { id: "asc" }] }));
}));

r.post("/delivery", ah(async (req, res) => {
  const b = ServiceIn.safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: first(b.error) });
  const d = b.data; const bad = dupe(d.rates);
  if (bad) return res.status(400).json({ error: bad });
  const position = await db.deliveryService.count();
  const s = await db.deliveryService.create({ data: { name: d.name, description: d.description, etaText: d.etaText, active: d.active, allowsCod: d.allowsCod, position, rates: { create: rateRows(d.rates) } }, include: svcInclude });
  audit(req, "delivery.create", s.name);
  res.status(201).json(s);
}));

// Full replace: the editor sends the whole service with every rate. Rates left out are removed.
r.put("/delivery/:id", ah(async (req, res) => {
  const id = idOf(req.params.id); const b = ServiceIn.safeParse(req.body);
  if (!id) return res.status(400).json({ error: "Bad id" });
  if (!b.success) return res.status(400).json({ error: first(b.error) });
  const d = b.data; const bad = dupe(d.rates);
  if (bad) return res.status(400).json({ error: bad });
  if (!(await db.deliveryService.findUnique({ where: { id } }))) return res.status(404).json({ error: "Not found" });
  await db.$transaction([
    db.deliveryRate.deleteMany({ where: { serviceId: id } }),
    db.deliveryService.update({ where: { id }, data: { name: d.name, description: d.description, etaText: d.etaText, active: d.active, allowsCod: d.allowsCod } }),
    db.deliveryRate.createMany({ data: rateRows(d.rates).map((x) => ({ ...x, serviceId: id })) }),
  ]);
  audit(req, "delivery.update", d.name);
  res.json(await db.deliveryService.findUnique({ where: { id }, include: svcInclude }));
}));

r.delete("/delivery/:id", ah(async (req, res) => {
  const id = idOf(req.params.id); if (!id) return res.status(400).json({ error: "Bad id" });
  const s = await db.deliveryService.delete({ where: { id } });
  audit(req, "delivery.delete", s.name);
  res.json({ ok: true });
}));

// ---------- Payments ----------
const PAY_KEYS = ["pay.stk", "pay.cod", "pay.hold"];
async function readPay() {
  const rows = await db.setting.findMany({ where: { key: { in: PAY_KEYS } } });
  const m = Object.fromEntries(rows.map((x) => [x.key, x.value]));
  const accounts = await db.paymentAccount.findMany({ orderBy: [{ position: "asc" }, { id: "asc" }] });
  return { stk: m["pay.stk"] !== "off", cod: m["pay.cod"] === "on", holdMinutes: Number(m["pay.hold"]) || 30, accounts };
}
const setKey = (key: string, value: string) => db.setting.upsert({ where: { key }, update: { value }, create: { key, value } });

r.get("/payments", ah(async (_req, res) => { res.json(await readPay()); }));

r.patch("/payments", ah(async (req, res) => {
  const b = z.object({ stk: z.boolean().optional(), cod: z.boolean().optional(), holdMinutes: z.number().int().min(5).max(1440).optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "Hold time must be between 5 and 1440 minutes" });
  if (b.data.stk !== undefined) await setKey("pay.stk", b.data.stk ? "on" : "off");
  if (b.data.cod !== undefined) await setKey("pay.cod", b.data.cod ? "on" : "off");
  if (b.data.holdMinutes !== undefined) await setKey("pay.hold", String(b.data.holdMinutes));
  audit(req, "payments.update", JSON.stringify(b.data));
  res.json(await readPay());
}));

const AccountIn = z.object({
  kind: z.enum(["TILL", "PAYBILL", "POCHI"]),
  displayName: z.string().trim().min(2).max(60),
  number: z.string().trim().min(5).max(15),
  accountNumber: z.string().trim().max(30).nullish(),
  useOrderRef: z.boolean().default(false),
  active: z.boolean().default(true),
}).transform((a, ctx) => {
  if (a.kind === "POCHI") {
    const p = normalizeKePhone(a.number);
    if (!p) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter the Pochi la Biashara phone number" }); return z.NEVER; }
    return { ...a, number: p, accountNumber: null, useOrderRef: false };
  }
  if (!/^\d{5,8}$/.test(a.number)) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: a.kind === "TILL" ? "A till number is 5 to 8 digits" : "A paybill number is 5 to 8 digits" }); return z.NEVER; }
  if (a.kind === "TILL") return { ...a, accountNumber: null, useOrderRef: false };
  if (!a.useOrderRef && !a.accountNumber) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Add the account number, or choose to use the order reference" }); return z.NEVER; }
  return { ...a, accountNumber: a.useOrderRef ? null : a.accountNumber ?? null };
});

r.post("/payments/accounts", ah(async (req, res) => {
  const b = AccountIn.safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: first(b.error) });
  const a = await db.paymentAccount.create({ data: { ...b.data, accountNumber: b.data.accountNumber ?? null, position: await db.paymentAccount.count() } });
  audit(req, "payments.account", `${a.kind} ${a.displayName}`);
  res.status(201).json(a);
}));

r.put("/payments/accounts/:id", ah(async (req, res) => {
  const id = idOf(req.params.id); const b = AccountIn.safeParse(req.body);
  if (!id) return res.status(400).json({ error: "Bad id" });
  if (!b.success) return res.status(400).json({ error: first(b.error) });
  const a = await db.paymentAccount.update({ where: { id }, data: { ...b.data, accountNumber: b.data.accountNumber ?? null } });
  audit(req, "payments.account", `${a.kind} ${a.displayName}`);
  res.json(a);
}));

r.delete("/payments/accounts/:id", ah(async (req, res) => {
  const id = idOf(req.params.id); if (!id) return res.status(400).json({ error: "Bad id" });
  const a = await db.paymentAccount.delete({ where: { id } });
  audit(req, "payments.account.delete", `${a.kind} ${a.displayName}`);
  res.json({ ok: true });
}));

// ---------- Discount codes ----------
const when = z.union([z.string().datetime({ offset: true }), z.literal("")]).nullish().transform((v) => (v ? new Date(v) : null));
const DiscountIn = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{3,20}$/, "Codes use 3 to 20 letters, numbers, - or _").transform((c) => c.toUpperCase()),
  description: z.string().trim().max(120).default(""),
  kind: z.enum(["PERCENT", "FIXED"]),
  value: z.number().int().min(1).max(1_000_000),
  minSubtotal: z.number().int().min(0).max(10_000_000).default(0),
  startsAt: when, endsAt: when,
  maxUses: z.number().int().min(1).max(1_000_000).nullish(),
  active: z.boolean().default(true),
}).superRefine((d, ctx) => {
  if (d.kind === "PERCENT" && d.value > 100) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A percentage can't be more than 100" });
  if (d.startsAt && d.endsAt && d.endsAt <= d.startsAt) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The end must be later than the start" });
});

r.get("/discounts", ah(async (_req, res) => { res.json(await db.discountCode.findMany({ orderBy: { id: "desc" } })); }));

r.post("/discounts", ah(async (req, res) => {
  const b = DiscountIn.safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: first(b.error) });
  try {
    const d = await db.discountCode.create({ data: { ...b.data, maxUses: b.data.maxUses ?? null } });
    audit(req, "discount.create", d.code);
    res.status(201).json(d);
  } catch (e) { if (isUnique(e)) return res.status(409).json({ error: "That code already exists" }); throw e; }
}));

r.put("/discounts/:id", ah(async (req, res) => {
  const id = idOf(req.params.id); const b = DiscountIn.safeParse(req.body);
  if (!id) return res.status(400).json({ error: "Bad id" });
  if (!b.success) return res.status(400).json({ error: first(b.error) });
  try {
    const d = await db.discountCode.update({ where: { id }, data: { ...b.data, maxUses: b.data.maxUses ?? null } });
    audit(req, "discount.update", d.code);
    res.json(d);
  } catch (e) { if (isUnique(e)) return res.status(409).json({ error: "That code already exists" }); throw e; }
}));

r.delete("/discounts/:id", ah(async (req, res) => {
  const id = idOf(req.params.id); if (!id) return res.status(400).json({ error: "Bad id" });
  const d = await db.discountCode.delete({ where: { id } });
  audit(req, "discount.delete", d.code);
  res.json({ ok: true });
}));

export default r;
