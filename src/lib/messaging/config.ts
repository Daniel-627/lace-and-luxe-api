import { db } from "../db.js";

export const CHANNELS = ["whatsapp", "sms", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface CategoryMeta { label: string; audience: "CUSTOMER" | "STAFF"; description: string; params: string[] }

// "params" are the values a WhatsApp template receives, in order: {{1}}, {{2}}, ...
export const CATEGORIES: Record<string, CategoryMeta> = {
  CODE: { label: "Sign-in codes", audience: "CUSTOMER", description: "The 6-digit code for signing in.", params: ["code"] },
  ORDER_PLACED: { label: "Order received", audience: "CUSTOMER", description: "When a customer places an order.", params: ["firstName", "reference", "total", "link"] },
  PAYMENT_RECEIVED: { label: "Payment received", audience: "CUSTOMER", description: "When an order is marked paid.", params: ["firstName", "reference", "total", "link"] },
  ORDER_PACKED: { label: "Order packed", audience: "CUSTOMER", description: "When you set an order to Packed.", params: ["firstName", "reference", "link"] },
  OUT_FOR_DELIVERY: { label: "Out for delivery", audience: "CUSTOMER", description: "When you set an order to Out for delivery.", params: ["firstName", "reference", "link"] },
  DELIVERED: { label: "Delivered", audience: "CUSTOMER", description: "When you set an order to Delivered.", params: ["firstName", "reference"] },
  ORDER_CANCELLED: { label: "Order cancelled", audience: "CUSTOMER", description: "When you cancel an order.", params: ["firstName", "reference"] },
  ORDER_EXPIRED: { label: "Order expired", audience: "CUSTOMER", description: "When an unpaid order is released.", params: ["firstName", "reference"] },
  STAFF_NEW_ORDER: { label: "New order alert", audience: "STAFF", description: "Tells your team about every new order.", params: ["reference", "total", "customer", "county", "paymentType"] },
  STAFF_PAYMENT_CLAIM: { label: "Payment to check", audience: "STAFF", description: "A customer sent an M-Pesa code to confirm.", params: ["reference", "total", "claimCode"] },
  STAFF_NEW_LEAD: { label: "New WhatsApp lead", audience: "STAFF", description: "Someone tapped Order on WhatsApp.", params: ["reference", "total"] },
  STAFF_STOCK_SHORT: { label: "Stock short alert", audience: "STAFF", description: "A late payment arrived but stock ran out.", params: ["reference"] },
};

export const defaultChain = (category: string): Channel[] =>
  category === "CODE" ? ["whatsapp", "sms"] : CATEGORIES[category]?.audience === "STAFF" ? ["sms", "whatsapp", "email"] : ["whatsapp", "sms", "email"];

export interface StaffRecipient { name: string; phone: string; email: string }
export interface MsgConfig {
  channels: Record<Channel, boolean>;
  chains: Record<string, Channel[]>;
  templates: Record<string, string>;
  waLanguage: string;
  staff: StaffRecipient[];
  customerMessages: boolean;
  staffAlerts: boolean;
}

const isChannel = (c: unknown): c is Channel => (CHANNELS as readonly unknown[]).includes(c);

export function withDefaults(raw: Partial<MsgConfig> | null): MsgConfig {
  const r = raw ?? {};
  const chains: Record<string, Channel[]> = {};
  for (const cat of Object.keys(CATEGORIES)) {
    const c = r.chains?.[cat];
    chains[cat] = Array.isArray(c) ? Array.from(new Set(c.filter(isChannel))) : defaultChain(cat);
  }
  return {
    channels: { whatsapp: r.channels?.whatsapp !== false, sms: r.channels?.sms !== false, email: r.channels?.email !== false },
    chains, templates: r.templates ?? {}, waLanguage: r.waLanguage || "en", staff: Array.isArray(r.staff) ? r.staff : [],
    customerMessages: r.customerMessages !== false, staffAlerts: r.staffAlerts !== false,
  };
}

export async function loadConfig(): Promise<MsgConfig> {
  const row = await db.setting.findUnique({ where: { key: "msg.config" } });
  let raw: Partial<MsgConfig> | null = null;
  try { raw = row ? (JSON.parse(row.value) as Partial<MsgConfig>) : null; } catch { raw = null; }
  return withDefaults(raw);
}

export async function saveConfig(c: MsgConfig): Promise<void> {
  const value = JSON.stringify(c);
  await db.setting.upsert({ where: { key: "msg.config" }, update: { value }, create: { key: "msg.config", value } });
}
