import type { Order, OrderItem } from "@prisma/client";
import { maskPhone } from "./phone.js";

/** What a customer may see about an order. Never include other people's data here. */
export const orderView = (o: Order & { items: OrderItem[] }) => ({
  reference: o.reference,
  status: o.status,
  fulfilment: o.fulfilment,
  payTiming: o.payTiming,
  subtotal: o.subtotal,
  deliveryFee: o.deliveryFee,
  deliveryServiceName: o.deliveryServiceName,
  discountCode: o.discountCode,
  discountAmount: o.discountAmount,
  payNote: o.payNote,
  claimedCode: o.paymentClaim,
  expiresAt: o.expiresAt,
  method: o.method,
  total: o.total,
  createdAt: o.createdAt,
  mpesaReceipt: o.mpesaReceipt,
  delivery: { county: o.county, area: o.area },
  phoneHint: maskPhone(o.contactPhone),
  items: o.items.map((i) => ({ name: i.name, size: i.size, colour: i.colour, price: i.price, qty: i.qty })),
});
