import { Router } from "express";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";

const r = Router();

r.get("/", ah(async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  res.json(await db.product.findMany({
    where: {
      ...(category && { category: { slug: category } }),
      ...(q && { name: { contains: q, mode: "insensitive" } }),
    },
    include: { category: true, variants: { orderBy: { id: "asc" } } },
    orderBy: { id: "desc" },
  }));
}));

r.get("/:slug", ah(async (req, res) => {
  const p = await db.product.findUnique({ where: { slug: req.params.slug }, include: { category: true, variants: { orderBy: { id: "asc" } } } });
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json(p);
}));

export default r;
