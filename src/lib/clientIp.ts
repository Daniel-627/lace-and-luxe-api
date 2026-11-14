import type { Request } from "express";
import { env } from "../env.js";
import { safeEqual } from "./security.js";

/**
 * Calls made by the shop's own server all arrive from the same address. When they carry the shared
 * secret, trust the visitor address they forward, so rate limits apply per customer, not to everyone at once.
 */
export function clientIp(req: Request): string {
  const key = req.header("x-shop-key");
  if (env.SHOP_API_KEY && key && safeEqual(key, env.SHOP_API_KEY)) return req.header("x-client-ip") ?? req.ip ?? "unknown";
  return req.ip ?? "unknown";
}
