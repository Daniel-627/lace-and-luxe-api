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

export default r;
