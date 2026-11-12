import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt) as unknown as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [s, k] = stored.split(":");
  if (!s || !k) return false;
  const key = await scrypt(pw, Buffer.from(s, "hex"), 64);
  const expected = Buffer.from(k, "hex");
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export const tempPassword = () => crypto.randomBytes(9).toString("base64url");
