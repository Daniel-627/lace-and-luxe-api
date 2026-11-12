import type { NextFunction, Request, Response } from "express";
import { db } from "../lib/db.js";
import { hash } from "../lib/security.js";

async function resolve(req: Request): Promise<void> {
  const h = req.header("authorization");
  if (!h?.startsWith("Bearer ")) return;
  const s = await db.session.findUnique({ where: { tokenHash: hash(h.slice(7)) } });
  if (s && s.expiresAt > new Date()) req.customerId = s.customerId;
}

export const optionalAuth = (req: Request, _res: Response, next: NextFunction) => {
  resolve(req).then(() => next(), next);
};

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  resolve(req).then(() => {
    if (!req.customerId) return void res.status(401).json({ error: "Sign in required" });
    next();
  }, next);
};
