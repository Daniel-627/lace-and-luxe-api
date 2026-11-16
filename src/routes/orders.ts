import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { normalizeKePhone, phoneSchema } from "../lib/phone.js";
import { newReference, newToken } from "../lib/security.js";
import { limited } from "../lib/rateLimit.js";
import { clientIp } from "../lib/clientIp.js";
import { optionalAuth } from "../middleware/auth.js";
import { orderView } from "../lib/views.js";
import { payConfig, publicAccount, quote } from "../lib/pricing.js";
import { SoldOut } from "../lib/stock.js";
import { notifyOrder } from "../lib/messaging/service.js";

const r = Router();
const MIN = 60 * 1000;

const CreateOrder = z.object({
  contact: z.object({ name: z.string().trim().min(2).max(80), phone: phoneSchema }),
  email: z.union([z.string().email(), z.literal("")]).optional().transform((v) => v || undefined),
  delivery: z.object({
    name: z.string().trim().min(2).max(80), phone: phoneSchema,
    county: z.string().trim().min(2).max(60), area: z.string().trim().min(2).max(100), details: z.string().trim().max(300).default(""),
    serviceId: z.number().int().positive(),
  }),
  payment: z.object({ timing: z.enum(["NOW", "ON_DELIVERY"]), method: z.enum(["STK", "MANUAL", "COD"]), accountId: z.number().int().positive().optional() }),
  code: z.string().trim().max(30).optional(),
  items: z.array(z.object({ variantId: z.number().int().positive(), qty: z.number().int().min(1).max(20) })).min(1).max(30),
});

// Everything is priced and checked on the server. The stock is held the moment the order is placed.
r.post("/", optionalAuth, ah(async (req, res) => {
  const parsed = CreateOrder.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  const { contact, email, delivery, payment, code, items } = parsed.data;

  const q = await quote({ items, county: delivery.county, area: delivery.area, serviceId: delivery.serviceId, code });
  if (q.problems.length) return res.status(409).json({ error: q.problems[0] });
  const chosen = q.delivery.selected;
  if (!chosen) return res.status(400).json({ error: "That delivery option isn't available for your location." });
  if (code && q.discountError) return res.status(400).json({ error: q.discountError });

  let method: string;
  let accountId: number | null = null;
  let expiresAt: Date | null = null;
  if (payment.timing === "NOW") {
    if (!q.pay.now.available) return res.status(400).json({ error: "Paying now isn't available for this basket." });
    if (payment.method === "STK") {
      if (!q.cfg.stk) return res.status(400).json({ error: "The M-Pesa prompt isn't available right now." });
      method = "MPESA";
    } else if (payment.method === "MANUAL") {
      const acc = q.cfg.accounts.find((a) => a.id === payment.accountId);
      if (!acc) return res.status(400).json({ error: "Choose where you will pay." });
      accountId = acc.id; method = "MPESA_MANUAL";
    } else return res.status(400).json({ error: "Invalid payment choice." });
    expiresAt = new Date(Date.now() + q.cfg.holdMinutes * MIN);
  } else {
    if (!q.pay.onDelivery.available) return res.status(400).json({ error: q.pay.onDelivery.reason ?? "Pay on delivery isn't available." });
    if (payment.method !== "COD") return res.status(400).json({ error: "Invalid payment choice." });
    // Pay on delivery needs a verified phone number: the customer must be signed in as the number they are ordering with.
    const me = req.customerId ? await db.customer.findUnique({ where: { id: req.customerId } }) : null;
    if (!me || me.phone !== contact.phone) return res.status(403).json({ error: "Please verify your phone number to pay on delivery.", code: "VERIFY_PHONE" });
    method = "CASH";
  }

  let reference = newReference();
  while (await db.order.findUnique({ where: { reference } })) reference = newReference();

  try {
    const order = await db.$transaction(async (tx) => {
      for (const l of q.lines) {
        const g = await tx.variant.updateMany({ where: { id: l.variantId, stock: { gte: l.qty } }, data: { stock: { decrement: l.qty } } });
        if (g.count === 0) throw new SoldOut(`${l.name} (${l.size}, ${l.colour}) has just sold out.`);
      }
      if (q.discount) {
        const d = await tx.discountCode.findUniqueOrThrow({ where: { code: q.discount.code } });
        if (d.maxUses !== null && d.uses >= d.maxUses) throw new SoldOut("That discount code has just been fully used.");
        await tx.discountCode.update({ where: { id: d.id }, data: { uses: { increment: 1 } } });
      }
      return tx.order.create({
        data: {
          reference, trackingToken: newToken(16), customerId: req.customerId ?? null,
          contactName: contact.name, contactPhone: contact.phone, email,
          deliveryName: delivery.name, deliveryPhone: delivery.phone, county: delivery.county, area: delivery.area, addressDetails: delivery.details,
          subtotal: q.subtotal, deliveryFee: chosen.fee, deliveryServiceId: chosen.serviceId, deliveryServiceName: chosen.name,
          discountCode: q.discount?.code ?? null, discountAmount: q.discount?.amount ?? 0,
          total: q.total, method, payTiming: payment.timing, paymentAccountId: accountId, stockReserved: true, expiresAt,
          items: { create: q.lines.map((l) => ({ productId: l.productId, variantId: l.variantId, name: l.name, size: l.size, colour: l.colour, price: l.price, qty: l.qty })) },
        },
        include: { items: true },
      });
    });
    res.status(201).json({ ...orderView(order), trackingToken: order.trackingToken });
    void notifyOrder("ORDER_PLACED", order.id);
    void notifyOrder("STAFF_NEW_ORDER", order.id);
  } catch (e) {
    if (e instanceof SoldOut) return res.status(409).json({ error: e.message });
    throw e;
  }
}));

// Guests follow the link they were sent. For an unpaid pay-now order it also says how they can pay.
r.get("/track/:token", ah(async (req, res) => {
  if (limited(`track:${clientIp(req)}`, 60, 10 * MIN)) return res.status(429).json({ error: "Too many requests" });
  const o = await db.order.findUnique({ where: { trackingToken: req.params.token }, include: { items: true } });
  if (!o) return res.status(404).json({ error: "Order not found" });
  let pay = null;
  if (o.status === "PENDING" && o.payTiming === "NOW") {
    const cfg = await payConfig();
    pay = { stk: cfg.stk, accounts: cfg.accounts.map(publicAccount) };
  }
  res.json({ ...orderView(o), pay });
}));

// Manual lookup: reference + phone. Same answer for "no such order" and "wrong phone".
r.post("/lookup", ah(async (req, res) => {
  if (limited(`lookup:${clientIp(req)}`, 10, 10 * MIN)) return res.status(429).json({ error: "Too many attempts. Try again later." });
  const body = z.object({ reference: z.string().trim().toUpperCase(), phone: z.string() }).safeParse(req.body);
  const phone = body.success ? normalizeKePhone(body.data.phone) : null;
  const o = body.success && phone ? await db.order.findUnique({ where: { reference: body.data.reference }, include: { items: true } }) : null;
  if (!o || o.contactPhone !== phone) return res.status(404).json({ error: "No matching order" });
  res.json({ ...orderView(o), trackingToken: o.trackingToken });
}));

export default r;
