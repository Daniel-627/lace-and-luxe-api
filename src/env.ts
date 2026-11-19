import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(4000),
  WEB_URL: z.string().url(),
  API_URL: z.string().url(),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  SHOP_API_KEY: z.string().default(""),
  MPESA_CALLBACK_SECRET: z.string().default(""),
  WHATSAPP_TOKEN: z.string().default(""),
  WHATSAPP_PHONE_ID: z.string().default(""),
  WHATSAPP_API_VERSION: z.string().default("v24.0"),
  RESEND_API_KEY: z.string().default(""),
  EMAIL_FROM: z.string().default(""),
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
  // Slack/Discord/any JSON webhook that receives an alert when the API hits a real error. Optional.
  ALERT_WEBHOOK_URL: z.union([z.string().url(), z.literal("")]).default(""),
});

export const env = schema.parse(process.env);
