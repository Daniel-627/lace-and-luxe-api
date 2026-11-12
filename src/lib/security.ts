import crypto from "node:crypto";
import { env } from "../env.js";

export const hash = (v: string) => crypto.createHmac("sha256", env.SESSION_SECRET).update(v).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const newOtp = () => String(crypto.randomInt(100000, 1000000));

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export const newReference = () =>
  "LL-" + Array.from(crypto.randomBytes(4), (b) => ALPHABET[b % ALPHABET.length]).join("");

export const newLeadReference = () =>
  "WA-" + Array.from(crypto.randomBytes(4), (b) => ALPHABET[b % ALPHABET.length]).join("");
