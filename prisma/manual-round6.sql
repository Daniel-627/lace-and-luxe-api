-- Same change as `npx prisma db push` makes for the new Product.soldOutBehavior field.
-- Safe to run more than once; existing products keep showing when sold out (the old behaviour).
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "soldOutBehavior" TEXT NOT NULL DEFAULT 'SHOW';
