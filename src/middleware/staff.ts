import type { NextFunction, Request, Response } from "express";
import { db } from "../lib/db.js";
import { hash } from "../lib/security.js";

async function resolve(req: Request): Promise<void> {
  const h = req.header("authorization");
  if (!h?.startsWith("Bearer ")) return;
  const s = await db.staffSession.findUnique({ where: { tokenHash: hash(h.slice(7)) }, include: { staff: true } });
  if (s && s.expiresAt > new Date() && s.staff.active) {
    req.staff = { id: s.staff.id, name: s.staff.name, email: s.staff.email, role: s.staff.role, mustChangePassword: s.staff.mustChangePassword };
  }
}

/** Signed in, even if they still have to choose a new password (used for sign-out and the password change itself). */
export const requireStaffAny = (req: Request, res: Response, next: NextFunction) => {
  resolve(req).then(() => {
    if (!req.staff) return void res.status(401).json({ error: "Sign in required" });
    next();
  }, next);
};

/** Signed in and past the forced password change. */
export const requireStaff = (req: Request, res: Response, next: NextFunction) => {
  resolve(req).then(() => {
    if (!req.staff) return void res.status(401).json({ error: "Sign in required" });
    if (req.staff.mustChangePassword) return void res.status(403).json({ error: "Please choose a new password first", code: "PASSWORD_CHANGE_REQUIRED" });
    next();
  }, next);
};

export const requireOwner = (req: Request, res: Response, next: NextFunction) => {
  if (req.staff?.role !== "OWNER") return void res.status(403).json({ error: "Owner access only" });
  next();
};
