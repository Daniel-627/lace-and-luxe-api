import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";

const r = Router();

const CreateOrder = z.object({
  email: z.string().email(),
  phone: z.string().min(9).max(15),
  items: z.array(z.object({ productId: z.number().int().positive(), qty: z.number().int().min(1).max(20) })).min(1),
});

// Prices are always computed server-side; never trust a client total.
r.post("/", async (req, res) => {
  const parsed = CreateOrder.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  const { email, phone, items } = parsed.data;

  const products = await db.product.findMany({ where: { id: { in: items.map((i) => i.productId) } } });
  const lines: { productId: number; name: string; price: number; qty: number }[] = [];
  for (const i of items) {
    const p = products.find((x) => x.id === i.productId);
    if (!p || p.stock < i.qty) return res.status(400).json({ error: `Unavailable: ${p?.name ?? i.productId}` });
    lines.push({ productId: p.id, name: p.name, price: p.price, qty: i.qty });
  }
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const order = await db.order.create({ data: { email, phone, total, items: { create: lines } }, include: { items: true } });
  res.status(201).json(order);
});

r.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
  const o = await db.order.findUnique({ where: { id }, include: { items: true } });
  if (!o) return res.status(404).json({ error: "Not found" });
  res.json(o);
});

export default r;
