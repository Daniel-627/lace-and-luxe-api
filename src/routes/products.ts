import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { ah } from "../lib/async.js";

const r = Router();
const inc = { category: true, variants: { orderBy: { id: "asc" as const } } };

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL"];
const sizeSort = (a: string, b: string) => {
  const ia = SIZE_ORDER.indexOf(a.toUpperCase()), ib = SIZE_ORDER.indexOf(b.toUpperCase());
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return 1;
  if (ib >= 0) return -1;
  return a.localeCompare(b, undefined, { numeric: true });
};

async function ratingsFor(ids: number[]) {
  if (!ids.length) return new Map<number, { avg: number; count: number }>();
  const rows = await db.review.groupBy({ by: ["productId"], where: { productId: { in: ids }, status: "APPROVED" }, _avg: { rating: true }, _count: { _all: true } });
  return new Map(rows.map((x) => [x.productId, { avg: Math.round((x._avg.rating ?? 0) * 10) / 10, count: x._count._all }]));
}
const withRating = <T extends { id: number }>(items: T[], m: Map<number, { avg: number; count: number }>) => items.map((p) => ({ ...p, rating: m.get(p.id) ?? null }));
const minPrice = (p: { variants: { price: number }[] }) => Math.min(...p.variants.map((v) => v.price));
const inStock = (p: { variants: { stock: number }[] }) => p.variants.some((v) => v.stock > 0);

r.get("/", ah(async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const products = await db.product.findMany({
    where: { active: true, ...(category && { category: { slug: category } }), ...(q && { name: { contains: q, mode: "insensitive" } }) },
    include: inc, orderBy: { id: "desc" },
  });
  res.json(withRating(products, await ratingsFor(products.map((p) => p.id))));
}));

const Search = z.object({
  q: z.string().trim().max(80).optional(), category: z.string().trim().max(60).optional(),
  size: z.string().trim().max(20).optional(), colour: z.string().trim().max(30).optional(),
  min: z.coerce.number().int().min(0).optional(), max: z.coerce.number().int().min(0).optional(),
  inStock: z.enum(["1"]).optional(), sort: z.enum(["new", "price_asc", "price_desc", "name", "rating"]).default("new"),
  page: z.coerce.number().int().min(1).default(1),
});

// Search, filters, sorting and paging. Facets list what is available so the shop can offer the right choices.
r.get("/search", ah(async (req, res) => {
  const p = Search.safeParse(req.query);
  if (!p.success) return res.status(400).json({ error: "Invalid search" });
  const { q, category, size, colour, min, max, sort, page } = p.data;
  const words = (q ?? "").split(/\s+/).filter(Boolean).slice(0, 5);
  const scope = await db.product.findMany({
    where: {
      active: true, ...(category && { category: { slug: category } }),
      ...(words.length && { AND: words.map((w) => ({ OR: [
        { name: { contains: w, mode: "insensitive" as const } }, { description: { contains: w, mode: "insensitive" as const } }, { category: { name: { contains: w, mode: "insensitive" as const } } },
      ] })) }),
    },
    include: inc,
  });

  const items = scope.filter((pr) => pr.variants.some((v) =>
    (!size || v.size.toLowerCase() === size.toLowerCase()) && (!colour || v.colour.toLowerCase() === colour.toLowerCase()) &&
    (!p.data.inStock || v.stock > 0) && (min === undefined || v.price >= min) && (max === undefined || v.price <= max)));

  const ratings = await ratingsFor(items.map((x) => x.id));
  items.sort((a, b) =>
    sort === "price_asc" ? minPrice(a) - minPrice(b) : sort === "price_desc" ? minPrice(b) - minPrice(a) : sort === "name" ? a.name.localeCompare(b.name)
    : sort === "rating" ? (ratings.get(b.id)?.avg ?? 0) - (ratings.get(a.id)?.avg ?? 0) || (ratings.get(b.id)?.count ?? 0) - (ratings.get(a.id)?.count ?? 0)
    : b.id - a.id);

  const prices = scope.flatMap((x) => x.variants.map((v) => v.price));
  const cats = await db.category.findMany({ include: { _count: { select: { products: { where: { active: true } } } } }, orderBy: { name: "asc" } });
  res.json({
    products: withRating(items.slice((page - 1) * 24, page * 24), ratings), total: items.length, page, pageSize: 24,
    facets: {
      sizes: Array.from(new Set(scope.flatMap((x) => x.variants.map((v) => v.size)))).sort(sizeSort),
      colours: Array.from(new Map(scope.flatMap((x) => x.variants.map((v) => [v.colour, v.colourHex] as const))).entries()).map(([name, hex]) => ({ name, hex })),
      priceMin: prices.length ? Math.min(...prices) : 0, priceMax: prices.length ? Math.max(...prices) : 0,
      categories: cats.filter((c) => c._count.products > 0).map((c) => ({ slug: c.slug, name: c.name, count: c._count.products })),
    },
  });
}));

r.get("/by-ids", ah(async (req, res) => {
  const ids = String(req.query.ids ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
  const found = await db.product.findMany({ where: { id: { in: ids }, active: true }, include: inc });
  const ordered = ids.flatMap((id) => found.filter((x) => x.id === id));
  res.json(withRating(ordered, await ratingsFor(ordered.map((x) => x.id))));
}));

r.get("/:slug", ah(async (req, res) => {
  const p = await db.product.findFirst({ where: { slug: req.params.slug, active: true }, include: { ...inc, media: { orderBy: { position: "asc" } } } });
  if (!p) return res.status(404).json({ error: "Not found" });
  // Related: same category first, then the newest others, only what can be bought.
  const others = await db.product.findMany({ where: { active: true, id: { not: p.id } }, include: inc, orderBy: { id: "desc" }, take: 40 });
  const buyable = others.filter(inStock);
  const related = [...buyable.filter((x) => p.categoryId && x.categoryId === p.categoryId), ...buyable.filter((x) => !(p.categoryId && x.categoryId === p.categoryId))].slice(0, 4);
  const ratings = await ratingsFor([p.id, ...related.map((x) => x.id)]);
  res.json({ ...p, rating: ratings.get(p.id) ?? null, related: withRating(related, ratings) });
}));

r.get("/:slug/reviews", ah(async (req, res) => {
  const p = await db.product.findFirst({ where: { slug: req.params.slug, active: true }, select: { id: true } });
  if (!p) return res.status(404).json({ error: "Not found" });
  const [rows, agg] = await Promise.all([
    db.review.findMany({ where: { productId: p.id, status: "APPROVED" }, include: { customer: { select: { name: true } } }, orderBy: { id: "desc" }, take: 50 }),
    db.review.groupBy({ by: ["rating"], where: { productId: p.id, status: "APPROVED" }, _count: { _all: true } }),
  ]);
  const distribution = [1, 2, 3, 4, 5].map((n) => agg.find((a) => a.rating === n)?._count._all ?? 0);
  const count = distribution.reduce((s, n) => s + n, 0);
  const avg = count ? Math.round((distribution.reduce((s, n, i) => s + n * (i + 1), 0) / count) * 10) / 10 : 0;
  res.json({
    summary: { count, avg, distribution },
    reviews: rows.map((x) => ({ id: x.id, rating: x.rating, title: x.title, body: x.body, reply: x.reply, createdAt: x.createdAt, name: x.showName && x.customer.name ? x.customer.name.split(" ")[0] : null })),
  });
}));

export default r;
