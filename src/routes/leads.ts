import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { limited } from "../lib/rateLimit.js";
import { newLeadReference } from "../lib/security.js";
import { optionalAuth } from "../middleware/auth.js";

const r = Router();

const Body = z.object({
  source: z.enum(["product", "cart"]),
  items: z.array(z.object({ variantId: z.number().int().positive(), qty: z.number().int().min(1).max(20) })).min(1).max(30),
});

const kes = (n: number) => `KES ${n.toLocaleString("en-US")}`;

// Saves a WhatsApp lead (prices computed server-side) and returns the wa.me link with the order written out.
r.post("/", optionalAuth, ah(async (req, res) => {
  if (limited(`lead:${req.ip}`, 10, 10 * 60 * 1000)) return res.status(429).json({ error: "Too many requests. Try again shortly." });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
  const { source, items } = parsed.data;

  const setting = await db.setting.findUnique({ where: { key: "whatsappNumber" } });
  const number = setting?.value.replace(/\D/g, "");
  if (!number) return res.status(503).json({ error: "WhatsApp ordering is not set up yet" });

  const variants = await db.variant.findMany({ where: { id: { in: items.map((i) => i.variantId) } }, include: { product: true } });
  const lines: { variantId: number; name: string; size: string; colour: string; price: number; qty: number }[] = [];
  for (const i of items) {
    const v = variants.find((x) => x.id === i.variantId);
    if (!v || !v.product.active || v.stock < i.qty) return res.status(400).json({ error: `Unavailable: ${v ? `${v.product.name} (${v.size}, ${v.colour})` : i.variantId}` });
    lines.push({ variantId: v.id, name: v.product.name, size: v.size, colour: v.colour, price: v.price, qty: i.qty });
  }
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);

  let reference = newLeadReference();
  while (await db.lead.findUnique({ where: { reference } })) reference = newLeadReference();
  await db.lead.create({ data: { reference, source, items: lines as Prisma.InputJsonArray, total, customerId: req.customerId ?? null } });

  const text = [
    `Hi Lace & Luxe, I'd like to order (ref ${reference}):`,
    ...lines.map((l) => `• ${l.name} (${l.size}, ${l.colour}) × ${l.qty}: ${kes(l.price * l.qty)}`),
    `Total: ${kes(total)}`,
  ].join("\n");

  res.status(201).json({ reference, url: `https://wa.me/${number}?text=${encodeURIComponent(text)}` });
}));

export default r;
