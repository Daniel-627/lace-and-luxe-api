import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../lib/db.js";
import { env } from "../env.js";
import { ah } from "../lib/async.js";
import { stkPush } from "../lib/daraja.js";
import * as paystack from "../lib/paystack.js";

const r = Router();

async function markPaid(where: Prisma.OrderWhereUniqueInput, data: Prisma.OrderUpdateInput) {
  const o = await db.order.findUnique({ where, include: { items: true } });
  if (!o || o.status === "PAID") return; // idempotent
  await db.$transaction([
    db.order.update({ where, data: { status: "PAID", ...data } }),
    ...o.items.map((i) => db.variant.update({ where: { id: i.variantId }, data: { stock: { decrement: i.qty } } })),
  ]);
}

const message = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

// Payments are started with the private tracking token, not a guessable id.
const MpesaBody = z.object({ token: z.string().min(10), phone: z.string().optional() });

r.post("/mpesa", ah(async (req, res) => {
  try {
    const body = MpesaBody.parse(req.body);
    const order = await db.order.findUnique({ where: { trackingToken: body.token } });
    if (!order || order.status === "PAID") return res.status(400).json({ error: "Invalid order" });
    const checkoutId = await stkPush({ phone: body.phone || order.contactPhone, amount: order.total, orderId: order.id });
    await db.order.update({ where: { id: order.id }, data: { method: "MPESA", mpesaCheckoutId: checkoutId, status: "PENDING" } });
    res.json({ message: "Check your phone and enter your M-Pesa PIN", checkoutId });
  } catch (e) { res.status(500).json({ error: message(e) }); }
}));

interface StkCallback {
  Body?: { stkCallback?: { CheckoutRequestID: string; ResultCode: number; CallbackMetadata?: { Item: { Name: string; Value?: string | number }[] } } };
}

r.post("/mpesa/callback", ah(async (req, res) => {
  const cb = (req.body as StkCallback)?.Body?.stkCallback;
  if (cb) {
    const where = { mpesaCheckoutId: cb.CheckoutRequestID };
    if (cb.ResultCode === 0) {
      const receipt = cb.CallbackMetadata?.Item.find((i) => i.Name === "MpesaReceiptNumber")?.Value;
      await markPaid(where, { mpesaReceipt: receipt === undefined ? null : String(receipt) });
    } else {
      await db.order.updateMany({ where: { ...where, status: "PENDING" }, data: { status: "FAILED" } });
    }
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
}));

r.post("/paystack", ah(async (req, res) => {
  try {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const order = await db.order.findUnique({ where: { trackingToken: token } });
    if (!order || order.status === "PAID") return res.status(400).json({ error: "Invalid order" });
    if (!order.email) return res.status(400).json({ error: "An email is needed for card payments" });
    const reference = `${order.reference}-${Date.now()}`;
    const d = await paystack.initialize({ email: order.email, amountKes: order.total, reference, callbackUrl: `${env.WEB_URL}/track/${order.trackingToken}` });
    await db.order.update({ where: { id: order.id }, data: { method: "PAYSTACK", paystackRef: reference } });
    res.json({ url: d.authorization_url });
  } catch (e) { res.status(500).json({ error: message(e) }); }
}));

r.post("/paystack/webhook", ah(async (req, res) => {
  if (!paystack.validSignature(req.rawBody, req.header("x-paystack-signature"))) return void res.sendStatus(401);
  const evt = req.body as { event: string; data: { reference: string } };
  if (evt.event === "charge.success") await markPaid({ paystackRef: evt.data.reference }, {});
  res.sendStatus(200);
}));

export default r;
