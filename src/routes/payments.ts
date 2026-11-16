import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { env } from "../env.js";
import { ah } from "../lib/async.js";
import { limited } from "../lib/rateLimit.js";
import { clientIp } from "../lib/clientIp.js";
import { normalizeKePhone } from "../lib/phone.js";
import { stkPush } from "../lib/daraja.js";
import { payConfig } from "../lib/pricing.js";
import { settleOrder } from "../lib/stock.js";
import * as paystack from "../lib/paystack.js";

const r = Router();
const MIN = 60 * 1000;
const message = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

// ---- M-Pesa prompt (Daraja STK push) ----
r.post("/mpesa", ah(async (req, res) => {
  const b = z.object({ token: z.string().min(10), phone: z.string().optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "Invalid request" });
  if (limited(`stk:${b.data.token}`, 5, 60 * MIN)) return res.status(429).json({ error: "Too many tries for this order. Pay to our till instead, or try again later." });
  const order = await db.order.findUnique({ where: { trackingToken: b.data.token } });
  if (!order || order.payTiming !== "NOW") return res.status(400).json({ error: "Invalid order" });
  if (order.status !== "PENDING") return res.status(400).json({ error: order.status === "PAID" ? "This order is already paid." : "This order has expired. Please place a new order." });
  if (!(await payConfig()).stk) return res.status(400).json({ error: "The M-Pesa prompt isn't available right now." });
  const phone = b.data.phone ? normalizeKePhone(b.data.phone) : order.contactPhone;
  if (!phone) return res.status(400).json({ error: "Enter a valid Safaricom number." });
  try {
    const checkoutId = await stkPush({ phone, amount: order.total, orderId: order.id });
    await db.order.update({ where: { id: order.id }, data: { method: "MPESA", mpesaCheckoutId: checkoutId, payNote: null } });
    res.json({ message: "Check your phone and enter your M-Pesa PIN" });
  } catch (e) {
    await db.order.update({ where: { id: order.id }, data: { payNote: "The M-Pesa prompt couldn't be sent." } });
    res.status(502).json({ error: message(e) });
  }
}));

interface StkCallback {
  Body?: { stkCallback?: { CheckoutRequestID: string; ResultCode: number; ResultDesc?: string; CallbackMetadata?: { Item: { Name: string; Value?: string | number }[] } } };
}
const WHY: Record<number, string> = { 1032: "The M-Pesa prompt was cancelled.", 1037: "The M-Pesa prompt timed out.", 2001: "The M-Pesa PIN was wrong.", 1: "There wasn't enough money in M-Pesa." };

r.post(["/mpesa/callback", "/mpesa/callback/:secret"], ah(async (req, res) => {
  if (env.MPESA_CALLBACK_SECRET && req.params.secret !== env.MPESA_CALLBACK_SECRET) return void res.sendStatus(404);
  const cb = (req.body as StkCallback)?.Body?.stkCallback;
  if (cb) {
    const order = await db.order.findUnique({ where: { mpesaCheckoutId: cb.CheckoutRequestID } });
    if (order) {
      if (cb.ResultCode === 0) {
        const receipt = cb.CallbackMetadata?.Item.find((i) => i.Name === "MpesaReceiptNumber")?.Value;
        await settleOrder(order.id, { method: "MPESA", mpesaReceipt: receipt === undefined ? null : String(receipt) });
      } else {
        // The order stays open so the customer can try again or pay to the till.
        await db.order.updateMany({ where: { id: order.id, status: "PENDING" }, data: { payNote: WHY[cb.ResultCode] ?? cb.ResultDesc ?? "The M-Pesa payment wasn't completed." } });
      }
    }
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
}));

// ---- Paying by hand to a till, paybill or Pochi la Biashara: the customer sends the M-Pesa code, staff confirm it ----
r.post("/manual", ah(async (req, res) => {
  const b = z.object({ token: z.string().min(10), code: z.string().trim(), accountId: z.number().int().positive().optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "Invalid request" });
  if (limited(`claim:${b.data.token}`, 10, 60 * MIN) || limited(`claim-ip:${clientIp(req)}`, 30, 60 * MIN)) return res.status(429).json({ error: "Too many tries. Please wait a while." });
  const code = b.data.code.toUpperCase();
  if (!/^[A-Z0-9]{8,12}$/.test(code)) return res.status(400).json({ error: "That doesn't look like an M-Pesa code. It has 10 letters and numbers, like QGH7XYZ123." });
  const order = await db.order.findUnique({ where: { trackingToken: b.data.token } });
  if (!order || order.payTiming !== "NOW" || order.status !== "PENDING") return res.status(400).json({ error: "This order can't take a payment right now." });
  const accounts = (await payConfig()).accounts;
  if (accounts.length && b.data.accountId && !accounts.some((a) => a.id === b.data.accountId)) return res.status(400).json({ error: "Choose where you paid." });
  const used = await db.order.findFirst({ where: { id: { not: order.id }, OR: [{ mpesaReceipt: code }, { paymentClaim: code }] }, select: { id: true } });
  if (used) return res.status(409).json({ error: "That M-Pesa code has already been used on another order." });
  await db.order.update({ where: { id: order.id }, data: { paymentClaim: code, paymentClaimAt: new Date(), method: "MPESA_MANUAL", paymentAccountId: b.data.accountId ?? order.paymentAccountId } });
  res.json({ ok: true });
}));

// ---- Cards (Paystack): paused for now ----
r.post("/paystack", (_req, res) => { res.status(503).json({ error: "Card payments aren't available yet." }); });

r.post("/paystack/webhook", ah(async (req, res) => {
  if (!paystack.validSignature(req.rawBody, req.header("x-paystack-signature"))) return void res.sendStatus(401);
  const evt = req.body as { event: string; data: { reference: string } };
  if (evt.event === "charge.success") {
    const o = await db.order.findUnique({ where: { paystackRef: evt.data.reference } });
    if (o) await settleOrder(o.id, { method: "PAYSTACK" });
  }
  res.sendStatus(200);
}));

export default r;
