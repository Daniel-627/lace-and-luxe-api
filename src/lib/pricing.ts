import type { PaymentAccount } from "@prisma/client";
import { db } from "./db.js";
import { env } from "../env.js";

export const darajaReady = () => !!(env.DARAJA_KEY && env.DARAJA_SECRET && env.DARAJA_SHORTCODE && env.DARAJA_PASSKEY);

export interface PricedLine { variantId: number; productId: number; name: string; size: string; colour: string; price: number; qty: number }

export async function priceItems(items: { variantId: number; qty: number }[]) {
  const variants = await db.variant.findMany({ where: { id: { in: items.map((i) => i.variantId) } }, include: { product: true } });
  const lines: PricedLine[] = [];
  const problems: string[] = [];
  const flags = { payNow: true, payOnDelivery: true };
  for (const i of items) {
    const v = variants.find((x) => x.id === i.variantId);
    if (!v || !v.product.active) { problems.push("An item in your basket is no longer available."); continue; }
    if (v.stock < i.qty) problems.push(v.stock <= 0 ? `${v.product.name} (${v.size}, ${v.colour}) is sold out.` : `${v.product.name} (${v.size}, ${v.colour}): only ${v.stock} left.`);
    lines.push({ variantId: v.id, productId: v.productId, name: v.product.name, size: v.size, colour: v.colour, price: v.price, qty: i.qty });
    if (!v.product.payNow) flags.payNow = false;
    if (!v.product.payOnDelivery) flags.payOnDelivery = false;
  }
  return { lines, problems, flags, subtotal: lines.reduce((s, l) => s + l.price * l.qty, 0) };
}

export interface DeliveryOption { serviceId: number; name: string; description: string; etaText: string; fee: number; free: boolean; allowsCod: boolean }

/** Services that reach this place. A town or estate rate beats the county rate. */
export async function deliveryOptions(county: string | undefined, area: string | undefined, subtotal: number): Promise<DeliveryOption[]> {
  if (!county?.trim()) return [];
  const c = county.trim().toLowerCase();
  const a = (area ?? "").trim().toLowerCase();
  const services = await db.deliveryService.findMany({ where: { active: true }, include: { rates: true }, orderBy: [{ position: "asc" }, { id: "asc" }] });
  const out: DeliveryOption[] = [];
  for (const s of services) {
    const here = s.rates.filter((r) => r.county.toLowerCase() === c);
    const rate = (a ? here.find((r) => (r.area ?? "").toLowerCase() === a) : undefined) ?? here.find((r) => !r.area);
    if (!rate) continue;
    const free = !!rate.freeAbove && subtotal >= rate.freeAbove;
    out.push({ serviceId: s.id, name: s.name, description: s.description, etaText: rate.etaText || s.etaText, fee: free ? 0 : rate.fee, free, allowsCod: s.allowsCod });
  }
  return out;
}

export async function checkDiscount(code: string | undefined, subtotal: number): Promise<{ code: string; amount: number } | { error: string } | null> {
  const c = code?.trim().toUpperCase();
  if (!c) return null;
  const d = await db.discountCode.findUnique({ where: { code: c } });
  const now = new Date();
  if (!d || !d.active) return { error: "That code isn't valid." };
  if (d.startsAt && d.startsAt > now) return { error: "That code isn't active yet." };
  if (d.endsAt && d.endsAt <= now) return { error: "That code has expired." };
  if (d.maxUses !== null && d.uses >= d.maxUses) return { error: "That code has been fully used." };
  if (subtotal < d.minSubtotal) return { error: `Spend at least KES ${d.minSubtotal.toLocaleString("en-US")} on items to use this code.` };
  return { code: d.code, amount: d.kind === "PERCENT" ? Math.floor((subtotal * d.value) / 100) : Math.min(d.value, subtotal) };
}

export async function payConfig() {
  const rows = await db.setting.findMany({ where: { key: { in: ["pay.stk", "pay.cod", "pay.hold"] } } });
  const m = Object.fromEntries(rows.map((x) => [x.key, x.value]));
  const accounts = await db.paymentAccount.findMany({ where: { active: true }, orderBy: [{ position: "asc" }, { id: "asc" }] });
  return { stk: m["pay.stk"] !== "off" && darajaReady(), cod: m["pay.cod"] === "on", holdMinutes: Number(m["pay.hold"]) || 30, accounts };
}

export const publicAccount = (a: PaymentAccount) => ({ id: a.id, kind: a.kind, displayName: a.displayName, number: a.number, accountNumber: a.accountNumber, useOrderRef: a.useOrderRef });

export interface QuoteInput { items: { variantId: number; qty: number }[]; county?: string; area?: string; serviceId?: number; code?: string }

/** One place that works out prices and what is allowed, used both for the live checkout and when the order is placed. */
export async function quote(input: QuoteInput) {
  const priced = await priceItems(input.items);
  const options = await deliveryOptions(input.county, input.area, priced.subtotal);
  const selected = options.find((o) => o.serviceId === input.serviceId) ?? null;
  const disc = await checkDiscount(input.code, priced.subtotal);
  const discount = disc && "amount" in disc ? disc : null;
  const discountError = disc && "error" in disc ? disc.error : undefined;
  const deliveryFee = selected?.fee ?? 0;
  const cfg = await payConfig();
  const nowAvailable = priced.flags.payNow && (cfg.stk || cfg.accounts.length > 0);
  const codReason = !cfg.cod ? "Pay on delivery isn't available."
    : !priced.flags.payOnDelivery ? "Something in your basket has to be paid for now."
    : selected && !selected.allowsCod ? "This delivery option can't collect cash."
    : null;
  return {
    lines: priced.lines, problems: priced.problems, subtotal: priced.subtotal, discount, discountError, deliveryFee,
    total: priced.subtotal - (discount?.amount ?? 0) + deliveryFee,
    delivery: { options, selected },
    pay: {
      now: { available: nowAvailable, stk: cfg.stk, accounts: cfg.accounts.map(publicAccount) },
      onDelivery: { available: codReason === null, reason: codReason },
    },
    cfg,
  };
}
