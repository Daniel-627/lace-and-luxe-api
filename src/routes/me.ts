import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { phoneSchema } from "../lib/phone.js";
import { requireAuth } from "../middleware/auth.js";
import { orderView } from "../lib/views.js";

const r = Router();
r.use(requireAuth);

r.get("/", ah(async (req, res) => {
  const c = await db.customer.findUniqueOrThrow({ where: { id: req.customerId! } });
  res.json({ id: c.id, phone: c.phone, name: c.name, email: c.email });
}));

r.patch("/", ah(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(80).optional(), email: z.string().email().optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid details" });
  const c = await db.customer.update({ where: { id: req.customerId! }, data: body.data });
  res.json({ id: c.id, phone: c.phone, name: c.name, email: c.email });
}));

r.get("/orders", ah(async (req, res) => {
  // The verified phone number is the key: orders placed with it belong to this customer, signed in or not.
  const me = await db.customer.findUniqueOrThrow({ where: { id: req.customerId! } });
  const orders = await db.order.findMany({ where: { OR: [{ customerId: me.id }, { contactPhone: me.phone }] }, include: { items: true }, orderBy: { createdAt: "desc" } });
  res.json(orders.map((o) => ({ ...orderView(o), trackingToken: o.trackingToken })));
}));

const AddressBody = z.object({
  label: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(80),
  phone: phoneSchema,
  county: z.string().trim().min(2).max(60),
  area: z.string().trim().min(2).max(100),
  details: z.string().trim().max(300).default(""),
});

r.get("/addresses", ah(async (req, res) => {
  res.json(await db.address.findMany({ where: { customerId: req.customerId! }, orderBy: { id: "asc" } }));
}));

r.post("/addresses", ah(async (req, res) => {
  const body = AddressBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid address" });
  res.status(201).json(await db.address.create({ data: { ...body.data, customerId: req.customerId! } }));
}));

r.delete("/addresses/:id", ah(async (req, res) => {
  await db.address.deleteMany({ where: { id: Number(req.params.id), customerId: req.customerId! } });
  res.json({ ok: true });
}));

// ---------- Wishlist ----------
r.get("/wishlist", ah(async (req, res) => {
  const rows = await db.wishlistItem.findMany({ where: { customerId: req.customerId! }, orderBy: { createdAt: "desc" } });
  res.json(rows.map((x) => x.productId));
}));

r.post("/wishlist", ah(async (req, res) => {
  const b = z.object({ productId: z.number().int().positive() }).safeParse(req.body);
  if (!b.success || !(await db.product.findFirst({ where: { id: b.data.productId, active: true }, select: { id: true } }))) return res.status(400).json({ error: "Unknown product" });
  await db.wishlistItem.upsert({ where: { customerId_productId: { customerId: req.customerId!, productId: b.data.productId } }, update: {}, create: { customerId: req.customerId!, productId: b.data.productId } });
  res.json({ ok: true });
}));

r.delete("/wishlist/:productId", ah(async (req, res) => {
  await db.wishlistItem.deleteMany({ where: { customerId: req.customerId!, productId: Number(req.params.productId) } });
  res.json({ ok: true });
}));

// Merges what a visitor saved on this device with what is on their account, and returns the full list.
r.post("/wishlist/sync", ah(async (req, res) => {
  const b = z.object({ ids: z.array(z.number().int().positive()).max(200) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "Invalid list" });
  const valid = await db.product.findMany({ where: { id: { in: b.data.ids }, active: true }, select: { id: true } });
  await db.wishlistItem.createMany({ data: valid.map((p) => ({ customerId: req.customerId!, productId: p.id })), skipDuplicates: true });
  const rows = await db.wishlistItem.findMany({ where: { customerId: req.customerId! }, orderBy: { createdAt: "desc" } });
  res.json(rows.map((x) => x.productId));
}));

// ---------- Reviews: only customers who received the product, one each, approved by staff before they show ----------
async function eligibility(customerId: number, productId: number) {
  const me = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
  const existing = await db.review.findUnique({ where: { productId_customerId: { productId, customerId } } });
  if (existing) return { eligible: false, reason: existing.status === "APPROVED" ? "You've already reviewed this product." : "Thanks! Your review is waiting to be approved." };
  const bought = await db.order.findFirst({ where: { OR: [{ customerId }, { contactPhone: me.phone }], fulfilment: "DELIVERED", items: { some: { productId } } }, select: { id: true } });
  return bought ? { eligible: true } : { eligible: false, reason: "Only customers who have received this product can review it." };
}

r.get("/reviewable/:productId", ah(async (req, res) => {
  const productId = Number(req.params.productId);
  if (!Number.isInteger(productId)) return res.status(400).json({ error: "Bad id" });
  res.json(await eligibility(req.customerId!, productId));
}));

r.post("/reviews", ah(async (req, res) => {
  const b = z.object({
    productId: z.number().int().positive(), rating: z.number().int().min(1).max(5),
    title: z.string().trim().max(80).default(""), body: z.string().trim().min(10, "Please write at least a few words").max(1000), showName: z.boolean().default(false),
  }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: b.error.issues[0]?.message ?? "Invalid review" });
  const e = await eligibility(req.customerId!, b.data.productId);
  if (!e.eligible) return res.status(403).json({ error: e.reason });
  await db.review.create({ data: { ...b.data, customerId: req.customerId! } });
  res.status(201).json({ ok: true });
}));

export default r;
