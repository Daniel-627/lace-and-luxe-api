import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { normalizeKePhone, phoneSchema } from "../lib/phone.js";
import { newReference, newToken } from "../lib/security.js";
import { limited } from "../lib/rateLimit.js";
import { optionalAuth } from "../middleware/auth.js";
import { orderView } from "../lib/views.js";

const r = Router();
const MIN = 60 * 1000;

const CreateOrder = z.object({
  contact: z.object({ name: z.string().trim().min(2).max(80), phone: phoneSchema }),
  email: z.union([z.string().email(), z.literal("")]).optional().transform((v) => v || undefined),
  delivery: z.object({
    name: z.string().trim().min(2).max(80),
    phone: phoneSchema,
    county: z.string().trim().min(2).max(60),
    area: z.string().trim().min(2).max(100),
    details: z.string().trim().max(300).default(""),
  }),
  items: z.array(z.object({ variantId: z.number().int().positive(), qty: z.number().int().min(1).max(20) })).min(1),
});

// Prices are computed server-side. The response includes the tracking token ONCE; keep it private.
r.post("/", optionalAuth, ah(async (req, res) => {
  const parsed = CreateOrder.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  const { contact, email, delivery, items } = parsed.data;

  const variants = await db.variant.findMany({ where: { id: { in: items.map((i) => i.variantId) } }, include: { product: true } });
  const lines: { productId: number; variantId: number; name: string; size: string; colour: string; price: number; qty: number }[] = [];
  for (const i of items) {
    const v = variants.find((x) => x.id === i.variantId);
    if (!v || !v.product.active || v.stock < i.qty)
      return res.status(400).json({ error: `Unavailable: ${v ? `${v.product.name} (${v.size}, ${v.colour})` : i.variantId}` });
    lines.push({ productId: v.productId, variantId: v.id, name: v.product.name, size: v.size, colour: v.colour, price: v.price, qty: i.qty });
  }
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);

  let reference = newReference();
  while (await db.order.findUnique({ where: { reference } })) reference = newReference();

  const order = await db.order.create({
    data: {
      reference, trackingToken: newToken(16), customerId: req.customerId ?? null,
      contactName: contact.name, contactPhone: contact.phone, email,
      deliveryName: delivery.name, deliveryPhone: delivery.phone,
      county: delivery.county, area: delivery.area, addressDetails: delivery.details,
      total, items: { create: lines },
    },
    include: { items: true },
  });
  res.status(201).json({ ...orderView(order), trackingToken: order.trackingToken });
}));

// Guests follow the link they were sent. The long random token is the key.
r.get("/track/:token", ah(async (req, res) => {
  if (limited(`track:${req.ip}`, 60, 10 * MIN)) return res.status(429).json({ error: "Too many requests" });
  const o = await db.order.findUnique({ where: { trackingToken: req.params.token }, include: { items: true } });
  if (!o) return res.status(404).json({ error: "Order not found" });
  res.json(orderView(o));
}));

// Manual lookup: reference + phone. Same answer for "no such order" and "wrong phone".
r.post("/lookup", ah(async (req, res) => {
  if (limited(`lookup:${req.ip}`, 10, 10 * MIN)) return res.status(429).json({ error: "Too many attempts. Try again later." });
  const body = z.object({ reference: z.string().trim().toUpperCase(), phone: z.string() }).safeParse(req.body);
  const phone = body.success ? normalizeKePhone(body.data.phone) : null;
  const o = body.success && phone
    ? await db.order.findUnique({ where: { reference: body.data.reference }, include: { items: true } })
    : null;
  if (!o || o.contactPhone !== phone) return res.status(404).json({ error: "No matching order" });
  res.json({ ...orderView(o), trackingToken: o.trackingToken });
}));

export default r;
