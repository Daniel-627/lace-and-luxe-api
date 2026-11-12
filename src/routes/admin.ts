import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { audit } from "../lib/audit.js";
import { normalizeKePhone, phoneSchema } from "../lib/phone.js";
import { hashPassword, tempPassword } from "../lib/password.js";
import { newReference, newToken } from "../lib/security.js";
import { requireOwner, requireStaff } from "../middleware/staff.js";

const r = Router();
r.use(requireStaff);

const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
const idOf = (req: Request): number | null => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };
const makeSku = (slug: string, v: { size: string; colour: string }) => `${slug}-${v.size}-${v.colour}`.toUpperCase().replace(/\s+/g, "-");
const first = (e: z.ZodError) => e.issues[0]?.message ?? "Invalid input";

// ---------- Dashboard ----------
r.get("/stats", ah(async (_req, res) => {
  const EAT = 3 * 3600 * 1000; // Kenya is UTC+3
  const startToday = new Date(Math.floor((Date.now() + EAT) / 86400000) * 86400000 - EAT);
  const [ordersToday, paid, pendingOrders, newLeads, low] = await Promise.all([
    db.order.count({ where: { createdAt: { gte: startToday } } }),
    db.order.aggregate({ _sum: { total: true }, where: { status: "PAID", createdAt: { gte: startToday } } }),
    db.order.count({ where: { status: "PENDING" } }),
    db.lead.count({ where: { status: "NEW" } }),
    db.variant.findMany({ where: { stock: { lte: 3 }, product: { active: true } }, include: { product: { select: { name: true } } }, orderBy: { stock: "asc" }, take: 10 }),
  ]);
  res.json({
    ordersToday, revenueToday: paid._sum.total ?? 0, pendingOrders, newLeads,
    lowStock: low.map((v) => ({ variantId: v.id, name: v.product.name, size: v.size, colour: v.colour, stock: v.stock })),
  });
}));

// ---------- Categories ----------
r.get("/categories", ah(async (_req, res) => {
  res.json(await db.category.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { products: true } } } }));
}));

r.post("/categories", ah(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(2).max(60) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: first(b.error) });
  try {
    const c = await db.category.create({ data: { name: b.data.name, slug: slugify(b.data.name) } });
    audit(req, "category.create", c.name);
    res.status(201).json(c);
  } catch (e) { if (isUnique(e)) return res.status(409).json({ error: "That category already exists" }); throw e; }
}));

r.patch("/categories/:id", ah(async (req, res) => {
  const id = idOf(req); const b = z.object({ name: z.string().trim().min(2).max(60) }).safeParse(req.body);
  if (!id || !b.success) return res.status(400).json({ error: "Invalid input" });
  res.json(await db.category.update({ where: { id }, data: { name: b.data.name } }));
}));

// ---------- Products ----------
const VariantIn = z.object({
  id: z.number().int().positive().optional(),
  sku: z.string().trim().min(1).max(80).optional(),
  size: z.string().trim().min(1).max(20),
  colour: z.string().trim().min(1).max(30),
  colourHex: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colour must look like #5B1F2E").nullable().optional(),
  price: z.number().int().min(1).max(10_000_000),
  stock: z.number().int().min(0).max(100_000),
});
const ProductIn = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().max(120).optional(),
  description: z.string().max(4000).default(""),
  image: z.string().url().nullable().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  active: z.boolean().default(true),
  variants: z.array(VariantIn).min(1, "Add at least one size/colour").max(100),
});
const productInclude = { category: true, variants: { orderBy: { id: "asc" as const } } };

r.get("/products", ah(async (_req, res) => {
  res.json(await db.product.findMany({ include: productInclude, orderBy: { id: "desc" } }));
}));

r.get("/products/:id", ah(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: "Bad id" });
  const p = await db.product.findUnique({ where: { id }, include: productInclude });
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json(p);
}));

r.post("/products", ah(async (req, res) => {
  const b = ProductIn.safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: first(b.error) });
  const d = b.data; const slug = slugify(d.slug || d.name);
  if (!slug) return res.status(400).json({ error: "Name needs letters or numbers" });
  try {
    const p = await db.product.create({
      data: {
        name: d.name, slug, description: d.description, image: d.image ?? null, categoryId: d.categoryId ?? null, active: d.active,
        variants: { create: d.variants.map((v) => ({ sku: v.sku || makeSku(slug, v), size: v.size, colour: v.colour, colourHex: v.colourHex ?? null, price: v.price, stock: v.stock })) },
      },
      include: productInclude,
    });
    audit(req, "product.create", p.name);
    res.status(201).json(p);
  } catch (e) { if (isUnique(e)) return res.status(409).json({ error: "That slug or SKU already exists" }); throw e; }
}));

// Full replace: the form sends the whole product with all its variants. Variants left out are removed.
r.put("/products/:id", ah(async (req, res) => {
  const id = idOf(req); const b = ProductIn.safeParse(req.body);
  if (!id) return res.status(400).json({ error: "Bad id" });
  if (!b.success) return res.status(400).json({ error: first(b.error) });
  const d = b.data;
  const existing = await db.product.findUnique({ where: { id }, include: { variants: true } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  const own = new Set(existing.variants.map((v) => v.id));
  const keep = d.variants.flatMap((v) => (v.id ? [v.id] : []));
  if (keep.some((vid) => !own.has(vid))) return res.status(400).json({ error: "A variant does not belong to this product" });
  const slug = d.slug ? slugify(d.slug) : existing.slug;
  try {
    await db.$transaction([
      db.variant.deleteMany({ where: { productId: id, id: { notIn: keep } } }),
      db.product.update({ where: { id }, data: { name: d.name, slug, description: d.description, image: d.image ?? null, categoryId: d.categoryId ?? null, active: d.active } }),
      ...d.variants.map((v) => {
        const data = { size: v.size, colour: v.colour, colourHex: v.colourHex ?? null, price: v.price, stock: v.stock };
        return v.id
          ? db.variant.update({ where: { id: v.id }, data: { ...data, ...(v.sku && { sku: v.sku }) } })
          : db.variant.create({ data: { ...data, productId: id, sku: v.sku || makeSku(slug, v) } });
      }),
    ]);
  } catch (e) { if (isUnique(e)) return res.status(409).json({ error: "That slug or SKU already exists" }); throw e; }
  audit(req, "product.update", d.name);
  res.json(await db.product.findUnique({ where: { id }, include: productInclude }));
}));

r.delete("/products/:id", requireOwner, ah(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: "Bad id" });
  const p = await db.product.delete({ where: { id } });
  audit(req, "product.delete", p.name);
  res.json({ ok: true });
}));

// ---------- Orders ----------
async function markPaid(orderId: number, extra: Prisma.OrderUpdateInput) {
  const o = await db.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!o || o.status === "PAID") return;
  await db.$transaction([
    db.order.update({ where: { id: orderId }, data: { status: "PAID", ...extra } }),
    ...o.items.map((i) => db.variant.updateMany({ where: { id: i.variantId }, data: { stock: { decrement: i.qty } } })),
  ]);
}

r.get("/orders", ah(async (req, res) => {
  const str = (k: string) => (typeof req.query[k] === "string" && req.query[k] ? (req.query[k] as string) : undefined);
  const status = str("status"), fulfilment = str("fulfilment"), q = str("q");
  const page = Math.max(1, Number(req.query.page) || 1);
  const phone = q ? normalizeKePhone(q) : null;
  const where: Prisma.OrderWhereInput = {
    ...(status && { status }), ...(fulfilment && { fulfilment }),
    ...(q && { OR: [{ reference: { contains: q.toUpperCase() } }, { contactName: { contains: q, mode: "insensitive" as const } }, ...(phone ? [{ contactPhone: phone }] : [])] }),
  };
  const [total, orders] = await Promise.all([
    db.order.count({ where }),
    db.order.findMany({ where, include: { items: true }, orderBy: { createdAt: "desc" }, skip: (page - 1) * 30, take: 30 }),
  ]);
  res.json({ total, page, pageSize: 30, orders });
}));

r.get("/orders/:id", ah(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: "Bad id" });
  const o = await db.order.findUnique({ where: { id }, include: { items: true } });
  if (!o) return res.status(404).json({ error: "Not found" });
  res.json(o);
}));

const Method = z.enum(["MPESA", "CASH", "BANK", "WHATSAPP"]);
r.patch("/orders/:id", ah(async (req, res) => {
  const id = idOf(req);
  const b = z.object({
    fulfilment: z.enum(["NEW", "PACKED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"]).optional(),
    notes: z.string().max(1000).optional(), markPaid: z.boolean().optional(),
    method: Method.optional(), mpesaReceipt: z.string().trim().max(40).optional(),
  }).safeParse(req.body);
  if (!id || !b.success) return res.status(400).json({ error: "Invalid input" });
  const d = b.data;
  const o = await db.order.findUnique({ where: { id } });
  if (!o) return res.status(404).json({ error: "Not found" });
  await db.order.update({ where: { id }, data: { ...(d.fulfilment && { fulfilment: d.fulfilment }), ...(d.notes !== undefined && { notes: d.notes }) } });
  if (d.markPaid) await markPaid(id, { method: d.method ?? o.method ?? "WHATSAPP", mpesaReceipt: d.mpesaReceipt });
  audit(req, "order.update", `${o.reference} ${JSON.stringify(d)}`);
  res.json(await db.order.findUnique({ where: { id }, include: { items: true } }));
}));

// ---------- WhatsApp leads ----------
r.get("/leads", ah(async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json(await db.lead.findMany({ where: status ? { status } : {}, orderBy: { createdAt: "desc" }, take: 100 }));
}));

r.patch("/leads/:id", ah(async (req, res) => {
  const id = idOf(req); const b = z.object({ status: z.enum(["NEW", "CONTACTED", "CONVERTED", "LOST"]) }).safeParse(req.body);
  if (!id || !b.success) return res.status(400).json({ error: "Invalid input" });
  const l = await db.lead.update({ where: { id }, data: { status: b.data.status } });
  audit(req, "lead.update", `${l.reference} ${l.status}`);
  res.json(l);
}));

const LeadItems = z.array(z.object({ variantId: z.number(), name: z.string(), size: z.string(), colour: z.string(), price: z.number(), qty: z.number() }));

// Turns a WhatsApp lead into a real order once the customer has confirmed in chat.
r.post("/leads/:id/convert", ah(async (req, res) => {
  const id = idOf(req);
  const b = z.object({
    name: z.string().trim().min(2).max(80), phone: phoneSchema,
    email: z.union([z.string().email(), z.literal("")]).optional().transform((v) => v || undefined),
    delivery: z.object({ name: z.string().trim().max(80).optional(), phone: phoneSchema.optional(), county: z.string().trim().min(2).max(60), area: z.string().trim().min(2).max(100), details: z.string().trim().max(300).default("") }),
    paid: z.boolean().default(false), method: Method.default("WHATSAPP"), mpesaReceipt: z.string().trim().max(40).optional(),
  }).safeParse(req.body);
  if (!id) return res.status(400).json({ error: "Bad id" });
  if (!b.success) return res.status(400).json({ error: first(b.error) });
  const d = b.data;

  const lead = await db.lead.findUnique({ where: { id } });
  if (!lead) return res.status(404).json({ error: "Not found" });
  if (lead.orderId) return res.status(409).json({ error: "This lead was already converted" });
  const items = LeadItems.parse(lead.items);
  const variants = await db.variant.findMany({ where: { id: { in: items.map((i) => i.variantId) } } });
  const missing = items.find((i) => !variants.some((v) => v.id === i.variantId));
  if (missing) return res.status(400).json({ error: `${missing.name} (${missing.size}, ${missing.colour}) no longer exists` });

  let reference = newReference();
  while (await db.order.findUnique({ where: { reference } })) reference = newReference();
  const order = await db.order.create({
    data: {
      reference, trackingToken: newToken(16), contactName: d.name, contactPhone: d.phone, email: d.email, method: "WHATSAPP",
      deliveryName: d.delivery.name || d.name, deliveryPhone: d.delivery.phone || d.phone,
      county: d.delivery.county, area: d.delivery.area, addressDetails: d.delivery.details, total: lead.total,
      items: { create: items.map((i) => ({ productId: variants.find((v) => v.id === i.variantId)!.productId, variantId: i.variantId, name: i.name, size: i.size, colour: i.colour, price: i.price, qty: i.qty })) },
    },
  });
  await db.lead.update({ where: { id }, data: { status: "CONVERTED", orderId: order.id } });
  if (d.paid) await markPaid(order.id, { method: d.method, mpesaReceipt: d.mpesaReceipt });
  audit(req, "lead.convert", `${lead.reference} -> ${order.reference}`);
  res.status(201).json(await db.order.findUnique({ where: { id: order.id }, include: { items: true } }));
}));

// ---------- Settings (owner) ----------
r.get("/settings", requireOwner, ah(async (_req, res) => {
  const s = await db.setting.findUnique({ where: { key: "whatsappNumber" } });
  res.json({ whatsappNumber: s?.value ?? null });
}));

r.patch("/settings", requireOwner, ah(async (req, res) => {
  const b = z.object({ whatsappNumber: z.string() }).safeParse(req.body);
  const number = b.success ? normalizeKePhone(b.data.whatsappNumber) : null;
  if (!number) return res.status(400).json({ error: "Enter a valid Kenyan phone number" });
  await db.setting.upsert({ where: { key: "whatsappNumber" }, update: { value: number }, create: { key: "whatsappNumber", value: number } });
  audit(req, "settings.update", `whatsappNumber ${number}`);
  res.json({ whatsappNumber: number });
}));

// ---------- Staff (owner) ----------
const staffView = (s: { id: number; email: string; name: string; role: string; active: boolean }) => ({ id: s.id, email: s.email, name: s.name, role: s.role, active: s.active });

r.get("/staff", requireOwner, ah(async (_req, res) => {
  res.json((await db.staff.findMany({ orderBy: { id: "asc" } })).map(staffView));
}));

r.post("/staff", requireOwner, ah(async (req, res) => {
  const b = z.object({ email: z.string().email(), name: z.string().trim().min(2).max(80), role: z.enum(["OWNER", "STAFF"]).default("STAFF") }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: first(b.error) });
  const password = tempPassword();
  try {
    const s = await db.staff.create({ data: { email: b.data.email.toLowerCase(), name: b.data.name, role: b.data.role, passwordHash: await hashPassword(password) } });
    audit(req, "staff.create", s.email);
    res.status(201).json({ ...staffView(s), temporaryPassword: password }); // shown once
  } catch (e) { if (isUnique(e)) return res.status(409).json({ error: "That email already has an account" }); throw e; }
}));

r.patch("/staff/:id", requireOwner, ah(async (req, res) => {
  const id = idOf(req);
  const b = z.object({ active: z.boolean().optional(), role: z.enum(["OWNER", "STAFF"]).optional(), resetPassword: z.boolean().optional() }).safeParse(req.body);
  if (!id || !b.success) return res.status(400).json({ error: "Invalid input" });
  if (id === req.staff!.id && (b.data.active === false || (b.data.role && b.data.role !== "OWNER")))
    return res.status(400).json({ error: "You can't remove your own owner access" });
  const password = b.data.resetPassword ? tempPassword() : undefined;
  const s = await db.staff.update({ where: { id }, data: { ...(b.data.active !== undefined && { active: b.data.active }), ...(b.data.role && { role: b.data.role }), ...(password && { passwordHash: await hashPassword(password) }) } });
  if (b.data.active === false || password) await db.staffSession.deleteMany({ where: { staffId: id } });
  audit(req, "staff.update", s.email);
  res.json({ ...staffView(s), ...(password && { temporaryPassword: password }) });
}));

r.get("/audit", requireOwner, ah(async (_req, res) => {
  res.json(await db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 }));
}));

export default r;
