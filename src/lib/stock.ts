import type { Prisma } from "@prisma/client";
import { db } from "./db.js";
import { notifyOrder } from "./messaging/service.js";

export class SoldOut extends Error {}

/** Puts an order's stock back (cancelled, expired). Safe to call twice: only the first call does anything. */
export async function releaseStock(orderId: number): Promise<void> {
  await db.$transaction(async (tx) => {
    const gate = await tx.order.updateMany({ where: { id: orderId, stockReserved: true }, data: { stockReserved: false } });
    if (gate.count === 0) return;
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    for (const i of o.items) await tx.variant.updateMany({ where: { id: i.variantId }, data: { stock: { increment: i.qty } } });
    if (o.discountCode) await tx.discountCode.updateMany({ where: { code: o.discountCode, uses: { gt: 0 } }, data: { uses: { decrement: 1 } } });
  });
}

/** For orders staff create by hand: takes the stock now if there is enough. */
export async function reserveForOrder(orderId: number): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const o = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!o) return false;
    if (o.stockReserved) return true;
    const vs = await tx.variant.findMany({ where: { id: { in: o.items.map((i) => i.variantId) } } });
    if (o.items.some((i) => (vs.find((v) => v.id === i.variantId)?.stock ?? 0) < i.qty)) return false;
    for (const i of o.items) await tx.variant.updateMany({ where: { id: i.variantId }, data: { stock: { decrement: i.qty } } });
    await tx.order.update({ where: { id: orderId }, data: { stockReserved: true } });
    return true;
  });
}

/**
 * Marks an order paid. Stock was already held when the order was placed. If the hold had ended
 * (a late payment), it takes the stock now, or flags the order for staff when there isn't enough.
 */
export async function settleOrder(orderId: number, extra: Prisma.OrderUpdateInput = {}): Promise<{ ok: boolean; shortStock: boolean }> {
  const result = await db.$transaction(async (tx) => {
    const gate = await tx.order.updateMany({ where: { id: orderId, status: { not: "PAID" } }, data: { status: "PAID" } });
    if (gate.count === 0) return { ok: false, shortStock: false };
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    let reserved = o.stockReserved;
    let short = false;
    if (!reserved) {
      const vs = await tx.variant.findMany({ where: { id: { in: o.items.map((i) => i.variantId) } } });
      if (o.items.every((i) => (vs.find((v) => v.id === i.variantId)?.stock ?? 0) >= i.qty)) {
        for (const i of o.items) await tx.variant.updateMany({ where: { id: i.variantId }, data: { stock: { decrement: i.qty } } });
        reserved = true;
      } else short = true;
    }
    await tx.order.update({
      where: { id: orderId },
      data: {
        stockReserved: reserved, expiresAt: null, payNote: null,
        ...(o.fulfilment === "CANCELLED" && { fulfilment: "NEW" }),
        ...(short && { notes: `${o.notes ? o.notes + "\n" : ""}STOCK SHORT: paid after the hold ended and some items are no longer in stock. Contact the customer.` }),
        ...extra,
      },
    });
    return { ok: true, shortStock: short };
  });
  if (result.ok) {
    void notifyOrder("PAYMENT_RECEIVED", orderId);
    if (result.shortStock) void notifyOrder("STAFF_STOCK_SHORT", orderId);
  }
  return result;
}
