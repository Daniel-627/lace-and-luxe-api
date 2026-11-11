import crypto from "node:crypto";
import { env } from "../env.js";

interface InitResponse { status: boolean; message: string; data: { authorization_url: string; reference: string } }

export async function initialize(args: { email: string; amountKes: number; reference: string; callbackUrl: string }) {
  const r = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: args.email, amount: args.amountKes * 100, currency: "KES", reference: args.reference, callback_url: args.callbackUrl }),
  });
  const d = (await r.json()) as InitResponse;
  if (!d.status) throw new Error(d.message);
  return d.data;
}

export function validSignature(raw: Buffer | undefined, sig: string | undefined): boolean {
  if (!raw || !sig) return false;
  const expected = crypto.createHmac("sha512", env.PAYSTACK_SECRET).update(raw).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
