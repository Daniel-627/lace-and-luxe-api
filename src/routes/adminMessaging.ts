import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { audit } from "../lib/audit.js";
import { normalizeKePhone } from "../lib/phone.js";
import { requireOwner, requireStaff } from "../middleware/staff.js";
import { ADAPTERS } from "../lib/messaging/channels.js";
import { CATEGORIES, CHANNELS, defaultChain, loadConfig, saveConfig, withDefaults } from "../lib/messaging/config.js";
import { deliver } from "../lib/messaging/service.js";

// Outbox: all staff. Setup: owner only. Mounted before the owner-only commerce routes.
const r = Router();
r.use(requireStaff);

const idOf = (v: string) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

r.get("/messages", ah(async (req, res) => {
  const tab = typeof req.query.status === "string" ? req.query.status : "NEEDS";
  const page = Math.max(1, Number(req.query.page) || 1);
  const where = tab === "SENT" ? { status: "SENT" } : tab === "PENDING" ? { status: { in: ["PENDING", "SENDING"] } } : tab === "ALL" ? {} : { status: { in: ["MANUAL", "FAILED"] } };
  const [total, messages, needs, pending] = await Promise.all([
    db.message.count({ where }),
    db.message.findMany({ where, orderBy: { id: "desc" }, skip: (page - 1) * 30, take: 30 }),
    db.message.count({ where: { status: { in: ["MANUAL", "FAILED"] } } }),
    db.message.count({ where: { status: { in: ["PENDING", "SENDING"] } } }),
  ]);
  res.json({ total, page, pageSize: 30, counts: { needs, pending }, messages });
}));

r.post("/messages/:id/retry", ah(async (req, res) => {
  const id = idOf(req.params.id); if (!id) return res.status(400).json({ error: "Bad id" });
  const g = await db.message.updateMany({ where: { id, status: { in: ["MANUAL", "FAILED"] } }, data: { status: "PENDING", attempts: 0, nextTryAt: new Date(), lastError: null } });
  if (!g.count) return res.status(400).json({ error: "That message can't be retried" });
  audit(req, "message.retry", String(id));
  void deliver(id).catch(() => undefined);
  res.json({ ok: true });
}));

r.post("/messages/:id/sent", ah(async (req, res) => {
  const id = idOf(req.params.id); if (!id) return res.status(400).json({ error: "Bad id" });
  await db.message.updateMany({ where: { id, status: { in: ["MANUAL", "FAILED", "PENDING"] } }, data: { status: "SENT", channel: "manual", sentAt: new Date(), nextTryAt: null } });
  audit(req, "message.sent-by-hand", String(id));
  res.json({ ok: true });
}));

// ---------- Setup (owner) ----------
r.get("/messaging/config", requireOwner, ah(async (_req, res) => {
  res.json({
    config: await loadConfig(),
    channels: Object.fromEntries(CHANNELS.map((c) => [c, { configured: ADAPTERS[c].configured(), hint: ADAPTERS[c].hint }])),
    categories: Object.entries(CATEGORIES).map(([key, m]) => ({ key, ...m, defaultChain: defaultChain(key) })),
  });
}));

const ConfigIn = z.object({
  channels: z.object({ whatsapp: z.boolean(), sms: z.boolean(), email: z.boolean() }),
  chains: z.record(z.array(z.enum(CHANNELS))),
  templates: z.record(z.string().trim().max(80)),
  waLanguage: z.string().trim().min(2).max(10),
  staff: z.array(z.object({ name: z.string().trim().max(60), phone: z.string().trim().max(20), email: z.string().trim().max(120) })).max(10),
  customerMessages: z.boolean(),
  staffAlerts: z.boolean(),
});

r.patch("/messaging/config", requireOwner, ah(async (req, res) => {
  const b = ConfigIn.safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "Some of those settings aren't valid" });
  const staff = [];
  for (const s of b.data.staff) {
    if (!s.phone && !s.email) continue;
    const phone = s.phone ? normalizeKePhone(s.phone) : "";
    if (s.phone && !phone) return res.status(400).json({ error: `"${s.phone}" isn't a valid Kenyan phone number` });
    if (s.email && !/^\S+@\S+\.\S+$/.test(s.email)) return res.status(400).json({ error: `"${s.email}" isn't a valid email address` });
    staff.push({ name: s.name, phone: phone || "", email: s.email });
  }
  const templates = Object.fromEntries(Object.entries(b.data.templates).filter(([k, v]) => k in CATEGORIES && v));
  const cfg = withDefaults({ ...b.data, staff, templates });
  await saveConfig(cfg);
  audit(req, "messaging.update");
  res.json({ config: cfg });
}));

r.post("/messaging/test", requireOwner, ah(async (req, res) => {
  const b = z.object({ channel: z.enum(CHANNELS), to: z.string().trim().min(5).max(120) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "Choose a channel and enter where to send" });
  const a = ADAPTERS[b.data.channel];
  if (!a.configured()) return res.status(400).json({ error: `Not set up on the server yet. ${a.hint}` });
  const phone = b.data.channel === "email" ? null : normalizeKePhone(b.data.to);
  if (b.data.channel !== "email" && !phone) return res.status(400).json({ error: "Enter a valid Kenyan phone number" });
  try {
    await a.send({ category: "TEST", toPhone: phone, toEmail: b.data.channel === "email" ? b.data.to : null, subject: "Test from Lace & Luxe", body: "This is a test message from your Lace & Luxe admin.", params: [] }, await loadConfig());
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e instanceof Error ? e.message : "Could not send" }); }
}));

export default r;
