import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(4000),
  WEB_URL: z.string().url(),
  API_URL: z.string().url(),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  SMS_PROVIDER: z.enum(["console", "africastalking"]).default("console"),
  AT_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  AT_USERNAME: z.string().default("sandbox"),
  AT_API_KEY: z.string().default(""),
  AT_SENDER_ID: z.string().default(""),
  PAYSTACK_SECRET: z.string().default(""),
  DARAJA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  DARAJA_KEY: z.string().default(""),
  DARAJA_SECRET: z.string().default(""),
  DARAJA_SHORTCODE: z.string().default(""),
  DARAJA_PASSKEY: z.string().default(""),
});

export const env = schema.parse(process.env);
