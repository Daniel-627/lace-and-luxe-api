import { env } from "../env.js";

const lastSent = new Map<string, number>();
const QUIET_MS = 5 * 60_000;

/**
 * Tells the owner something is wrong, by posting to ALERT_WEBHOOK_URL (a Slack, Discord or any
 * webhook that accepts JSON). Does nothing when the variable is empty. The same alert is sent at
 * most once every 5 minutes, so a failing job cannot flood a phone. Never throws.
 */
export async function alertOps(title: string, detail = ""): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return;
  const now = Date.now();
  if ((lastSent.get(title) ?? 0) > now - QUIET_MS) return;
  if (lastSent.size > 200) lastSent.clear();
  lastSent.set(title, now);
  const text = `Lace & Luxe API: ${title}${detail ? `\n${detail.slice(0, 1500)}` : ""}`;
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // "text" is what Slack reads, "content" is what Discord reads.
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error("alert webhook failed", e);
  }
}
