import { Router } from "express";
import { db } from "../lib/db.js";

const r = Router();

r.get("/", async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const products = await db.product.findMany({
    where: {
      ...(category && { category: { slug: category } }),
      ...(q && { name: { contains: q, mode: "insensitive" } }),
    },
    include: { category: true },
    orderBy: { id: "desc" },
  });
  res.json(products);
});

r.get("/:slug", async (req, res) => {
  const p = await db.product.findUnique({ where: { slug: req.params.slug }, include: { category: true } });
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json(p);
});

export default r;
