import { z } from "zod";
import { db } from "./db.js";

export interface GuideSection { title: string; text: string; table: string }
export interface SizeGuide { intro: string; sections: GuideSection[] }

export const DEFAULT_GUIDE: SizeGuide = {
  intro: "The right size makes all the difference. Measure yourself with a soft tape, then compare with our charts.",
  sections: [{
    title: "How to measure",
    text: "Band: measure snugly around your ribcage, just under your bust.\nBust: measure around the fullest part of your bust, keeping the tape level.\nHips: measure around the fullest part of your hips.\nIf you are between two sizes, choose the larger one for comfort.",
    table: "",
  }],
};

export const GuideIn = z.object({
  intro: z.string().trim().max(1000),
  sections: z.array(z.object({ title: z.string().trim().min(1).max(80), text: z.string().trim().max(2000), table: z.string().max(4000) })).max(12),
});

export async function readGuide(): Promise<SizeGuide> {
  const row = await db.setting.findUnique({ where: { key: "sizeGuide" } });
  if (!row) return DEFAULT_GUIDE;
  try { const g = GuideIn.safeParse(JSON.parse(row.value)); return g.success ? g.data : DEFAULT_GUIDE; } catch { return DEFAULT_GUIDE; }
}
