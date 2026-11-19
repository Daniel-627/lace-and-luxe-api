import { db } from "./db.js";

const KEY = "categoryOrder";

/** The owner's chosen order of category slugs (first ones appear in the shop menu). Empty if never set. */
export async function readCategoryOrder(): Promise<string[]> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  if (!row) return [];
  try {
    const v: unknown = JSON.parse(row.value);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export async function saveCategoryOrder(slugs: string[]): Promise<void> {
  const value = JSON.stringify(slugs);
  await db.setting.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
}

/** Ordered slugs first, in the owner's order; everything else after, A to Z. */
export function sortByOrder<T extends { slug: string; name: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((s, i) => [s, i] as const));
  return [...items].sort((a, b) => (rank.get(a.slug) ?? 1e9) - (rank.get(b.slug) ?? 1e9) || a.name.localeCompare(b.name));
}
