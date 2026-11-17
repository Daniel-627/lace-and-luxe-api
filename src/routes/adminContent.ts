import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { audit } from "../lib/audit.js";
import { requireStaff } from "../middleware/staff.js";
import { GuideIn, readGuide } from "../lib/sizeGuide.js";

// Reviews and the size guide: all staff. Mounted before the owner-only commerce routes.
const r = Router();
r.use(requireStaff);

const idOf = (v: string) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

r.get("/reviews", ah(async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "PENDING";
  const [pending, reviews] = await Promise.all([
    db.review.count({ where: { status: "PENDING" } }),
    db.review.findMany({
      where: status === "ALL" ? {} : { status },
      include: { product: { select: { name: true, slug: true } }, customer: { select: { name: true, phone: true } } },
      orderBy: { id: "desc" }, take: 100,
    }),
  ]);
  res.json({ pending, reviews });
}));

r.patch("/reviews/:id", ah(async (req, res) => {
  const id = idOf(req.params.id);
  const b = z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(), reply: z.string().trim().max(500).nullish() }).safeParse(req.body);
  if (!id || !b.success) return res.status(400).json({ error: "Invalid input" });
  const rv = await db.review.update({ where: { id }, data: { ...(b.data.status && { status: b.data.status }), ...(b.data.reply !== undefined && { reply: b.data.reply || null }) } });
  audit(req, "review.update", `${id} ${rv.status}`);
  res.json(rv);
}));

r.get("/size-guide", ah(async (_req, res) => { res.json(await readGuide()); }));

r.put("/size-guide", ah(async (req, res) => {
  const b = GuideIn.safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: b.error.issues[0]?.message ?? "Invalid size guide" });
  const value = JSON.stringify(b.data);
  await db.setting.upsert({ where: { key: "sizeGuide" }, update: { value }, create: { key: "sizeGuide", value } });
  audit(req, "sizeguide.update");
  res.json(b.data);
}));

export default r;
