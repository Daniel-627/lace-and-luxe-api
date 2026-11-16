import type { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { env } from "../../env.js";
import { normalizeKePhone } from "../phone.js";
import { ADAPTERS, type Outgoing } from "./channels.js";
import { CATEGORIES, loadConfig, type Channel, type MsgConfig } from "./config.js";
import { render, type Ctx } from "./templates.js";

export interface Trail { channel: string; ok: boolean; error?: string; at: string }
const BACKOFF_MINUTES = [1, 5, 15];
const kes = (n: number) => `KES ${n.toLocaleString("en-US")}`;
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("Timed out")), ms))]);
const chainFor = (category: string, cfg: MsgConfig): Channel[] => (cfg.chains[category] ?? []).filter((c) => cfg.channels[c]);

/** Tries each channel in the order set in Admin > Messaging until one works. Retries later if all fail, then hands over to staff. */
export async function deliver(id: number): Promise<void> {
  const gate = await db.message.updateMany({ where: { id, status: "PENDING" }, data: { status: "SENDING" } });
  if (gate.count === 0) return;
  const m = await db.message.findUniqueOrThrow({ where: { id } });
  const cfg = await loadConfig();
  const trail = ((m.trail as Trail[] | null) ?? []).slice(-12);
  const out: Outgoing = { category: m.category, toPhone: m.toPhone, toEmail: m.toEmail, subject: m.subject, body: m.body, params: (m.params as string[] | null) ?? [] };

  let used: Channel | null = null;
  let tried = 0;
  let lastError = "";
  for (const ch of chainFor(m.category, cfg)) {
    const a = ADAPTERS[ch];
    if (!a.configured() || !a.canReach(out)) continue;
    tried++;
    try {
      await withTimeout(a.send(out, cfg), 20000);
      trail.push({ channel: ch, ok: true, at: new Date().toISOString() });
      used = ch;
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      trail.push({ channel: ch, ok: false, error: lastError, at: new Date().toISOString() });
    }
  }

  const attempts = m.attempts + (tried ? 1 : 0);
  const trailJson = trail as unknown as Prisma.InputJsonArray;
  const handOver = m.toPhone ? "MANUAL" : "FAILED";
  if (used) {
    await db.message.update({ where: { id }, data: { status: "SENT", channel: used, attempts, trail: trailJson, lastError: null, sentAt: new Date(), nextTryAt: null } });
  } else if (tried === 0) {
    await db.message.update({ where: { id }, data: { status: handOver, trail: trailJson, lastError: "No messaging channel is set up that can reach this person.", nextTryAt: null } });
  } else if (attempts > BACKOFF_MINUTES.length) {
    await db.message.update({ where: { id }, data: { status: handOver, attempts, trail: trailJson, lastError, nextTryAt: null } });
  } else {
    await db.message.update({ where: { id }, data: { status: "PENDING", attempts, trail: trailJson, lastError, nextTryAt: new Date(Date.now() + BACKOFF_MINUTES[attempts - 1] * 60000) } });
  }
}

/** Run every 30 seconds: retries due messages, frees any that got stuck, and clears old ones. */
export async function sweepMessages(): Promise<void> {
  await db.message.updateMany({ where: { status: "SENDING", updatedAt: { lt: new Date(Date.now() - 5 * 60000) } }, data: { status: "PENDING" } });
  const due = await db.message.findMany({ where: { status: "PENDING", OR: [{ nextTryAt: null }, { nextTryAt: { lte: new Date() } }] }, orderBy: { id: "asc" }, take: 20, select: { id: true } });
  for (const { id } of due) await deliver(id);
  await db.message.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 90 * 86400000) } } }); // keep 90 days
}

async function enqueue(a: { category: string; audience: "CUSTOMER" | "STAFF"; toPhone: string | null; toEmail: string | null; orderId?: number; ctx: Ctx }): Promise<void> {
  const r = render(a.category, a.ctx);
  const row = await db.message.create({
    data: { category: a.category, audience: a.audience, toPhone: a.toPhone, toEmail: a.toEmail || null, subject: r.subject, body: r.body, params: r.params, orderId: a.orderId ?? null, nextTryAt: new Date() },
  });
  void deliver(row.id).catch((e) => console.error("deliver failed", e));
}

/** Customer updates and staff alerts about an order. Never throws, and sends each kind once per order. */
export async function notifyOrder(category: string, orderId: number, extra: Ctx = {}): Promise<void> {
  try {
    const meta = CATEGORIES[category];
    const cfg = await loadConfig();
    const o = await db.order.findUnique({ where: { id: orderId } });
    if (!meta || !o) return;
    const ctx: Ctx = {
      firstName: o.contactName.split(" ")[0], reference: o.reference, total: kes(o.total), link: `${env.WEB_URL.replace(/\/$/, "")}/track/${o.trackingToken}`,
      customer: o.contactName, county: o.county, claimCode: o.paymentClaim ?? "",
      paymentLine: o.payTiming === "ON_DELIVERY" ? `Please pay ${kes(o.total)} when it arrives.` : "Please complete your payment on your tracking page.",
      paymentType: o.payTiming === "ON_DELIVERY" ? "Pay on delivery" : "Pay now", ...extra,
    };
    if (await db.message.findFirst({ where: { orderId, category }, select: { id: true } })) return;
    if (meta.audience === "CUSTOMER") {
      if (!cfg.customerMessages) return;
      await enqueue({ category, audience: "CUSTOMER", toPhone: o.contactPhone, toEmail: o.email, orderId, ctx });
    } else {
      if (!cfg.staffAlerts) return;
      for (const s of cfg.staff) {
        const phone = s.phone ? normalizeKePhone(s.phone) : null;
        if (phone || s.email) await enqueue({ category, audience: "STAFF", toPhone: phone, toEmail: s.email || null, orderId, ctx });
      }
    }
  } catch (e) { console.error("notify failed", category, e); }
}

export async function notifyLead(reference: string, total: number): Promise<void> {
  try {
    const cfg = await loadConfig();
    if (!cfg.staffAlerts) return;
    for (const s of cfg.staff) {
      const phone = s.phone ? normalizeKePhone(s.phone) : null;
      if (phone || s.email) await enqueue({ category: "STAFF_NEW_LEAD", audience: "STAFF", toPhone: phone, toEmail: s.email || null, ctx: { reference, total: kes(total) } });
    }
  } catch (e) { console.error("notify lead failed", e); }
}

/** Sign-in codes go out through the "Sign-in codes" fallback order. They are never stored in the outbox. */
export async function sendCode(phone: string, code: string, minutes: number): Promise<{ sent: boolean; configured: boolean }> {
  const cfg = await loadConfig();
  const body = `Your Lace & Luxe code is ${code}. It expires in ${minutes} minutes.`;
  const out: Outgoing = { category: "CODE", toPhone: phone, toEmail: null, subject: null, body, params: [code] };
  let configured = false;
  for (const ch of chainFor("CODE", cfg)) {
    const a = ADAPTERS[ch];
    if (!a.configured() || !a.canReach(out)) continue;
    configured = true;
    try { await withTimeout(a.send(out, cfg), 15000); return { sent: true, configured }; }
    catch (e) { console.error(`code via ${ch} failed:`, e instanceof Error ? e.message : e); }
  }
  if (!configured) console.log(`[CODE -> ${phone}] ${body}`); // nothing set up yet (development)
  return { sent: false, configured };
}
