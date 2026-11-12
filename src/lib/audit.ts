import type { Request } from "express";
import { db } from "./db.js";

/** Records who did what. Never blocks or fails the request. */
export const audit = (req: Request, action: string, detail = ""): void => {
  void db.auditLog
    .create({ data: { staffId: req.staff?.id ?? null, staffName: req.staff?.name ?? "system", action, detail } })
    .catch(() => undefined);
};
