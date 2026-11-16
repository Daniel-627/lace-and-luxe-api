import { CATEGORIES } from "./config.js";

export interface Ctx {
  firstName?: string; reference?: string; total?: string; link?: string; customer?: string; county?: string;
  paymentLine?: string; paymentType?: string; claimCode?: string; code?: string;
}

// Customer messages never name the items, so nothing private shows on a lock screen.
export function render(category: string, c: Ctx): { body: string; subject: string; params: string[] } {
  const hi = `Hi ${c.firstName || "there"}`;
  const sig = "Lace & Luxe";
  let body = ""; let subject = "Lace & Luxe";
  switch (category) {
    case "ORDER_PLACED": subject = `We've received your order ${c.reference}`; body = `${hi}, we've received your order ${c.reference} (${c.total}). ${c.paymentLine ?? ""} Track it: ${c.link} - ${sig}`; break;
    case "PAYMENT_RECEIVED": subject = `Payment received for ${c.reference}`; body = `${hi}, we've received your payment of ${c.total} for order ${c.reference}. Thank you! Track it: ${c.link} - ${sig}`; break;
    case "ORDER_PACKED": subject = `Your order ${c.reference} is packed`; body = `${hi}, your order ${c.reference} is packed and will be on its way soon. Track it: ${c.link} - ${sig}`; break;
    case "OUT_FOR_DELIVERY": subject = `Your order ${c.reference} is on its way`; body = `${hi}, your order ${c.reference} is on its way to you. Track it: ${c.link} - ${sig}`; break;
    case "DELIVERED": subject = `Your order ${c.reference} was delivered`; body = `${hi}, your order ${c.reference} has been delivered. Thank you for shopping with ${sig}!`; break;
    case "ORDER_CANCELLED": subject = `Your order ${c.reference} was cancelled`; body = `${hi}, your order ${c.reference} has been cancelled. Please get in touch if you have any questions. - ${sig}`; break;
    case "ORDER_EXPIRED": subject = `Your order ${c.reference} expired`; body = `${hi}, your order ${c.reference} wasn't paid in time, so we released the items. You're welcome to order again. - ${sig}`; break;
    case "STAFF_NEW_ORDER": subject = `New order ${c.reference}`; body = `New order ${c.reference}: ${c.total}, ${c.customer}, ${c.county}. ${c.paymentType}.`; break;
    case "STAFF_PAYMENT_CLAIM": subject = `Check payment for ${c.reference}`; body = `Check M-Pesa: order ${c.reference}, ${c.total}, code ${c.claimCode}.`; break;
    case "STAFF_NEW_LEAD": subject = `New WhatsApp lead ${c.reference}`; body = `New WhatsApp lead ${c.reference}: ${c.total}.`; break;
    case "STAFF_STOCK_SHORT": subject = `Stock short for ${c.reference}`; body = `Order ${c.reference} was paid late and some items are out of stock. Contact the customer.`; break;
    case "CODE": body = `Your Lace & Luxe code is ${c.code}.`; break;
  }
  const params = (CATEGORIES[category]?.params ?? []).map((k) => String((c as Record<string, string | undefined>)[k] ?? ""));
  return { body: body.replace(/\s+/g, " ").trim(), subject, params };
}
