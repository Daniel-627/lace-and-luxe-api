import crypto from "node:crypto";
import { env } from "../env.js";

// Short-lived secrets (sign-in codes) are stored encrypted, so a copy of the database alone does not reveal them.
const key = () => crypto.createHash("sha256").update(`vault:${env.SESSION_SECRET}`).digest();

export function seal(text: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function unseal(sealed: string): string | null {
  try {
    const [iv, tag, enc] = sealed.split(".").map((s) => Buffer.from(s, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch { return null; }
}
