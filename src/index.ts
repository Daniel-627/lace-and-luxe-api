import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { env } from "./env.js";
import products from "./routes/products.js";
import orders from "./routes/orders.js";
import payments from "./routes/payments.js";
import auth from "./routes/auth.js";
import me from "./routes/me.js";
import leads from "./routes/leads.js";

const app = express();
app.set("trust proxy", 1); // behind Render's proxy, so req.ip is the real client
app.use(cors({ origin: env.WEB_URL }));
app.use(express.json({ limit: "100kb", verify: (req, _res, buf) => { (req as Request).rawBody = buf; } }));

app.use("/api/products", products);
app.use("/api/orders", orders);
app.use("/api/pay", payments);
app.use("/api/auth", auth);
app.use("/api/me", me);
app.use("/api/leads", leads);
app.get("/health", (_req, res) => res.json({ ok: true }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(env.PORT, () => console.log(`API listening on :${env.PORT}`));
