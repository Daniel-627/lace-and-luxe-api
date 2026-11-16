import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { limited } from "../lib/rateLimit.js";
import { clientIp } from "../lib/clientIp.js";
import { quote } from "../lib/pricing.js";

const r = Router();

const Body = z.object({
  items: z.array(z.object({ variantId: z.number().int().positive(), qty: z.number().int().min(1).max(20) })).min(1).max(30),
  county: z.string().trim().max(40).optional(),
  area: z.string().trim().max(100).optional(),
  serviceId: z.number().int().optional(),
  code: z.string().trim().max(30).optional(),
});

r.post("/quote", ah(async (req, res) => {
  if (limited(`quote:${clientIp(req)}`, 200, 10 * 60 * 1000)) return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  const b = Body.safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "Invalid request" });
  const { cfg: _cfg, lines: _lines, ...publicQuote } = await quote(b.data);
  res.json(publicQuote);
}));

// Towns and estates with their own rates in a county (used as suggestions).
r.get("/areas", ah(async (req, res) => {
  const county = typeof req.query.county === "string" ? req.query.county.trim() : "";
  if (!county) return res.json([]);
  const rows = await db.deliveryRate.findMany({ where: { county: { equals: county, mode: "insensitive" }, area: { not: null }, service: { active: true } }, select: { area: true }, distinct: ["area"], orderBy: { area: "asc" }, take: 100 });
  res.json(rows.map((x) => x.area));
}));

export default r;
