import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const COLOURS: Record<string, string> = { Claret: "#5B1F2E", Black: "#1C1C1C", Nude: "#D8B8A0", Blush: "#E3C6C3" };

const categories: [string, string][] = [
  ["Bras", "bras"], ["Panties", "panties"], ["Lingerie Sets", "lingerie-sets"],
  ["Sleepwear", "sleepwear"], ["Men's Underwear", "mens-underwear"],
];

const products: { name: string; slug: string; cat: string; price: number; sizes: string[]; colours: string[] }[] = [
  { name: "Lace Bralette", slug: "lace-bralette", cat: "bras", price: 1800, sizes: ["32B", "34B", "34C", "36C"], colours: ["Claret", "Black", "Nude"] },
  { name: "Satin Lingerie Set", slug: "satin-lingerie-set", cat: "lingerie-sets", price: 3500, sizes: ["S", "M", "L"], colours: ["Blush", "Black"] },
  { name: "Seamless Panty 3-Pack", slug: "seamless-panty-3-pack", cat: "panties", price: 1500, sizes: ["S", "M", "L", "XL"], colours: ["Nude", "Black"] },
  { name: "Silk Night Gown", slug: "silk-night-gown", cat: "sleepwear", price: 4200, sizes: ["S", "M", "L"], colours: ["Claret", "Blush"] },
  { name: "Cotton Boxer 3-Pack", slug: "cotton-boxer-3-pack", cat: "mens-underwear", price: 1600, sizes: ["S", "M", "L", "XL"], colours: ["Black"] },
];

for (const [name, slug] of categories)
  await db.category.upsert({ where: { slug }, update: {}, create: { name, slug } });

for (const p of products) {
  const category = await db.category.findUniqueOrThrow({ where: { slug: p.cat } });
  const product = await db.product.upsert({
    where: { slug: p.slug }, update: {},
    create: { name: p.name, slug: p.slug, categoryId: category.id },
  });
  for (const colour of p.colours)
    for (const size of p.sizes) {
      const sku = `${p.slug}-${size}-${colour}`.toUpperCase().replace(/\s+/g, "-");
      await db.variant.upsert({
        where: { sku }, update: {},
        create: { sku, productId: product.id, size, colour, colourHex: COLOURS[colour], price: p.price, stock: 10 },
      });
    }
}
console.log("Seeded");
await db.$disconnect();
