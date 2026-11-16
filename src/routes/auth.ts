import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { phoneSchema } from "../lib/phone.js";
import { hash, newOtp, newToken, safeEqual } from "../lib/security.js";
import { limited } from "../lib/rateLimit.js";
import { sendCode } from "../lib/messaging/service.js";
import { clientIp } from "../lib/clientIp.js";
import { seal } from "../lib/vault.js";

const r = Router();
const MIN = 60 * 1000;

// Same response whether or not the number has an account.
r.post("/request-code", ah(async (req, res) => {
  const parsed = z.object({ phone: phoneSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid phone" });
  const { phone } = parsed.data;

  const [recent, daily] = await Promise.all([
    db.otpCode.count({ where: { phone, createdAt: { gt: new Date(Date.now() - 10 * MIN) } } }),
    db.otpCode.count({ where: { phone, createdAt: { gt: new Date(Date.now() - 24 * 60 * MIN) } } }),
  ]);
  if (recent >= 3 || daily >= 10 || limited(`otp:${clientIp(req)}`, 10, 60 * MIN))
    return res.status(429).json({ error: "Too many requests. Please try again later." });

  // When "manual codes" is on, staff can read the code in the admin and send it on WhatsApp.
  const manual = (await db.setting.findUnique({ where: { key: "manualCodes" } }))?.value === "on";
  const minutes = manual ? 10 : 5;
  await db.otpCode.updateMany({
    where: { codeEnc: { not: null }, OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date() } }] },
    data: { codeEnc: null },
  });

  const code = newOtp();
  await db.otpCode.create({ data: { phone, codeHash: hash(`${phone}:${code}`), codeEnc: manual ? seal(code) : null, expiresAt: new Date(Date.now() + minutes * MIN) } });
  const sent = await sendCode(phone, code, minutes);
  // If channels are set up but none could deliver, say so (unless staff will send the code by hand).
  if (sent.configured && !sent.sent && !manual) throw new Error("We couldn't send the code. Please try again.");
  res.json({ ok: true, manual });
}));

r.post("/verify", ah(async (req, res) => {
  const parsed = z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid or expired code" });
  const { phone, code } = parsed.data;
  const fail = () => res.status(400).json({ error: "Invalid or expired code" });

  const otp = await db.otpCode.findFirst({
    where: { phone, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp || otp.attempts >= 5) return fail();
  if (!safeEqual(otp.codeHash, hash(`${phone}:${code}`))) {
    await db.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    return fail();
  }
  await db.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date(), codeEnc: null } });

  const now = new Date();
  const customer = await db.customer.upsert({ where: { phone }, update: { verifiedAt: now }, create: { phone, verifiedAt: now } });
  // The code proves they own this number, so earlier guest orders with it join their history.
  await db.order.updateMany({ where: { contactPhone: phone, customerId: null }, data: { customerId: customer.id } });

  const token = newToken();
  await db.session.create({ data: { tokenHash: hash(token), customerId: customer.id, expiresAt: new Date(Date.now() + 30 * 24 * 60 * MIN) } });
  res.json({ token, customer: { id: customer.id, phone: customer.phone, name: customer.name } });
}));

r.post("/logout", ah(async (req, res) => {
  const h = req.header("authorization");
  if (h?.startsWith("Bearer ")) await db.session.deleteMany({ where: { tokenHash: hash(h.slice(7)) } });
  res.json({ ok: true });
}));

export default r;
