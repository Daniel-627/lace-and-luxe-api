import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";
import { limited } from "../lib/rateLimit.js";
import { hash, newToken } from "../lib/security.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { audit } from "../lib/audit.js";
import { requireStaffAny } from "../middleware/staff.js";

const r = Router();
const MIN = 60 * 1000;
const DUMMY = "00".repeat(16) + ":" + "00".repeat(64); // keeps timing the same for unknown emails

r.post("/login", ah(async (req, res) => {
  const bad = () => res.status(401).json({ error: "Invalid email or password" });
  const b = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!b.success) return bad();
  const email = b.data.email.toLowerCase();
  if (limited(`staff-ip:${req.ip}`, 30, 15 * MIN) || limited(`staff:${email}`, 8, 15 * MIN))
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });

  const staff = await db.staff.findUnique({ where: { email } });
  const ok = staff && staff.active ? await verifyPassword(b.data.password, staff.passwordHash) : (await verifyPassword(b.data.password, DUMMY), false);
  if (!staff || !ok) return bad();

  const token = newToken();
  await db.staffSession.create({ data: { tokenHash: hash(token), staffId: staff.id, expiresAt: new Date(Date.now() + 12 * 60 * MIN) } });
  req.staff = { id: staff.id, name: staff.name, email: staff.email, role: staff.role, mustChangePassword: staff.mustChangePassword };
  audit(req, "login");
  res.json({ token, staff: req.staff });
}));

r.get("/me", requireStaffAny, (req, res) => { res.json(req.staff); });

r.post("/logout", requireStaffAny, ah(async (req, res) => {
  await db.staffSession.deleteMany({ where: { tokenHash: hash(req.header("authorization")!.slice(7)) } });
  res.json({ ok: true });
}));

r.post("/password", requireStaffAny, ah(async (req, res) => {
  const b = z.object({ current: z.string().min(1), next: z.string().min(10, "Use at least 10 characters").max(200) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: b.error.issues[0]?.message ?? "Invalid input" });
  const staff = await db.staff.findUniqueOrThrow({ where: { id: req.staff!.id } });
  if (!(await verifyPassword(b.data.current, staff.passwordHash))) return res.status(400).json({ error: "Current password is wrong" });
  if (b.data.next === b.data.current) return res.status(400).json({ error: "Choose a different password from the current one" });
  await db.staff.update({ where: { id: staff.id }, data: { passwordHash: await hashPassword(b.data.next), mustChangePassword: false } });
  await db.staffSession.deleteMany({ where: { staffId: staff.id, tokenHash: { not: hash(req.header("authorization")!.slice(7)) } } });
  audit(req, "password.change");
  res.json({ ok: true });
}));

export default r;
