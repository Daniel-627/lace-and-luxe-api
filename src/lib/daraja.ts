import { env } from "../env.js";

const base = () => (env.DARAJA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke");

/** 07xx / 01xx / +254... -> 254xxxxxxxxx */
export const normalizePhone = (p: string): string => {
  const d = p.replace(/\D/g, "");
  return d.startsWith("254") ? d : "254" + d.replace(/^0/, "");
};

async function token(): Promise<string> {
  const auth = Buffer.from(`${env.DARAJA_KEY}:${env.DARAJA_SECRET}`).toString("base64");
  const r = await fetch(`${base()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) throw new Error("Daraja auth failed");
  return ((await r.json()) as { access_token: string }).access_token;
}

interface StkResponse { ResponseCode?: string; ResponseDescription?: string; errorMessage?: string; CheckoutRequestID?: string }

export async function stkPush(args: { phone: string; amount: number; orderId: number }): Promise<string> {
  const ts = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const sc = env.DARAJA_SHORTCODE;
  const msisdn = normalizePhone(args.phone);
  const r = await fetch(`${base()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: sc,
      Password: Buffer.from(sc + env.DARAJA_PASSKEY + ts).toString("base64"),
      Timestamp: ts,
      TransactionType: "CustomerPayBillOnline",
      Amount: args.amount,
      PartyA: msisdn,
      PartyB: sc,
      PhoneNumber: msisdn,
      CallBackURL: `${env.API_URL}/api/pay/mpesa/callback`,
      AccountReference: `ORDER${args.orderId}`,
      TransactionDesc: `Order ${args.orderId}`,
    }),
  });
  const data = (await r.json()) as StkResponse;
  if (data.ResponseCode !== "0" || !data.CheckoutRequestID)
    throw new Error(data.errorMessage || data.ResponseDescription || "STK push failed");
  return data.CheckoutRequestID;
}
