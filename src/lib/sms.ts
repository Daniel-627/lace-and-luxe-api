import { env } from "../env.js";

/** `to` is 254XXXXXXXXX. Swap provider here only. */
export async function sendSms(to: string, message: string): Promise<void> {
  if (env.SMS_PROVIDER !== "africastalking") {
    console.log(`[SMS -> ${to}] ${message}`);
    return;
  }
  const base = env.AT_ENV === "production" ? "https://api.africastalking.com" : "https://api.sandbox.africastalking.com";
  const body = new URLSearchParams({ username: env.AT_USERNAME, to: `+${to}`, message });
  if (env.AT_SENDER_ID) body.set("from", env.AT_SENDER_ID);
  const r = await fetch(`${base}/version1/messaging`, {
    method: "POST",
    headers: { apiKey: env.AT_API_KEY, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error("SMS provider rejected the request");
}
