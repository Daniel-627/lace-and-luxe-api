import { db } from "./db.js";
import { releaseStock } from "./stock.js";

/** Cancels unpaid pay-now orders whose hold has ended and puts their stock back. Orders with a submitted M-Pesa code are left for staff. */
export async function expireUnpaid(): Promise<number> {
  const stale = await db.order.findMany({
    where: { status: "PENDING", payTiming: "NOW", expiresAt: { lt: new Date() }, paymentClaim: null },
    select: { id: true }, take: 50,
  });
  let n = 0;
  for (const { id } of stale) {
    const g = await db.order.updateMany({ where: { id, status: "PENDING" }, data: { status: "EXPIRED", fulfilment: "CANCELLED" } });
    if (g.count) { await releaseStock(id); n++; }
  }
  return n;
}
