import { env } from "../../env.js";
import { sendSms } from "../sms.js";
import type { Channel, MsgConfig } from "./config.js";

export interface Outgoing { category: string; toPhone: string | null; toEmail: string | null; subject: string | null; body: string; params: string[] }
export interface Adapter {
  configured(): boolean;
  canReach(m: Outgoing): boolean;
  send(m: Outgoing, cfg: MsgConfig): Promise<void>;
  hint: string; // what must be set on the server
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim() || "-"; // WhatsApp template values can't contain line breaks

// Add a new provider by adding an adapter here and listing it in config.ts.
export const ADAPTERS: Record<Channel, Adapter> = {
  sms: {
    hint: "On Render set SMS_PROVIDER=africastalking, AT_API_KEY, AT_USERNAME, AT_ENV=production and AT_SENDER_ID.",
    configured: () => env.SMS_PROVIDER === "africastalking" && !!env.AT_API_KEY,
    canReach: (m) => !!m.toPhone,
    send: (m) => sendSms(m.toPhone!, m.body),
  },
  whatsapp: {
    hint: "On Render set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID (and WHATSAPP_API_VERSION if Meta retires the default).",
    configured: () => !!env.WHATSAPP_TOKEN && !!env.WHATSAPP_PHONE_ID,
    canReach: (m) => !!m.toPhone,
    async send(m, cfg) {
      // Messages we start need an approved template. Free text only works inside a 24-hour window after the customer wrote to us.
      const template = cfg.templates[m.category];
      if (m.category === "CODE" && !template) throw new Error("WhatsApp: no template name is set for Sign-in codes (Admin > Messaging)");
      const lang = { code: cfg.waLanguage };
      // Sign-in codes must use a template created in the "Authentication" category. Meta requires the code twice: in the body,
      // and in the template's copy-code button, otherwise it rejects the message as missing a parameter.
      const components = m.category === "CODE"
        ? [{ type: "body", parameters: [{ type: "text", text: m.params[0] ?? "" }] }, { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: m.params[0] ?? "" }] }]
        : m.params.length ? [{ type: "body", parameters: m.params.map((text) => ({ type: "text", text: oneLine(text) })) }] : [];
      const payload = template
        ? { messaging_product: "whatsapp", to: m.toPhone, type: "template", template: { name: template, language: lang, components } }
        : { messaging_product: "whatsapp", to: m.toPhone, type: "text", text: { body: m.body } };
      const r = await fetch(`https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_ID}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => null)) as { error?: { message?: string; code?: number } } | null;
        throw new Error(`WhatsApp: ${d?.error?.message ?? r.status}${d?.error?.code ? ` (code ${d.error.code})` : ""}`);
      }
    },
  },
  email: {
    hint: "On Render set RESEND_API_KEY and EMAIL_FROM (an address on a domain you have verified with Resend).",
    configured: () => !!env.RESEND_API_KEY && !!env.EMAIL_FROM,
    canReach: (m) => !!m.toEmail,
    async send(m) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [m.toEmail], subject: m.subject ?? "Lace & Luxe", text: m.body }), signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`Email: ${(await r.text()).slice(0, 200)}`);
    },
  },
};
