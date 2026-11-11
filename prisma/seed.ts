import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const categories: [string, string][] = [
  ["Bras", "bras"], ["Panties", "panties"], ["Lingerie Sets", "lingerie-sets"],
  ["Sleepwear", "sleepwear"], ["Men's Underwear", "mens-underwear"],
];
const products: [name: string, slug: string, price: number, category: string][] = [
  ["Lace Bralette", "lace-bralette", 1800, "bras"],
  ["Satin Lingerie Set", "satin-lingerie-set", 3500, "lingerie-sets"],
  ["Seamless Panty 3-Pack", "seamless-panty-3-pack", 1500, "panties"],
  ["Silk Night Gown", "silk-night-gown", 4200, "sleepwear"],
  ["Cotton Boxer 3-Pack", "cotton-boxer-3-pack", 1600, "mens-underwear"],
];

for (const [name, slug] of categories)
  await db.category.upsert({ where: { slug }, update: {}, create: { name, slug } });

for (const [name, slug, price, cat] of products) {
  const category = await db.category.findUniqueOrThrow({ where: { slug: cat } });
  await db.product.upsert({ where: { slug }, update: {}, create: { name, slug, price, stock: 20, categoryId: category.id } });
}
console.log("Seeded");
await db.$disconnect();
