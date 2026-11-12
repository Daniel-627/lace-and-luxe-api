import { z } from "zod";

/** 0712 345 678 / +254712345678 / 712345678 -> 254712345678, or null if not a Kenyan mobile. */
export function normalizeKePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("254")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);
  return /^[71]\d{8}$/.test(d) ? "254" + d : null;
}

export const phoneSchema = z
  .string()
  .refine((p) => normalizeKePhone(p) !== null, "Enter a valid Kenyan phone number")
  .transform((p) => normalizeKePhone(p) as string);

export const maskPhone = (p: string) => p.slice(0, 6) + "***" + p.slice(-3);
