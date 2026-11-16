import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { env } from "./env.js";
import products from "./routes/products.js";
import orders from "./routes/orders.js";
import payments from "./routes/payments.js";
import auth from "./routes/auth.js";
import me from "./routes/me.js";
import leads from "./routes/leads.js";
import adminAuth from "./routes/adminAuth.js";
import admin from "./routes/admin.js";
import adminCommerce from "./routes/adminCommerce.js";
import checkout from "./routes/checkout.js";
import { expireUnpaid } from "./lib/jobs.js";
import adminMessaging from "./routes/adminMessaging.js";
import { sweepMessages } from "./lib/messaging/service.js";

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
app.use("/api/admin", adminAuth);
app.use("/api/admin", admin);
app.use("/api/admin", adminMessaging); // before adminCommerce, which is owner-only
app.use("/api/admin", adminCommerce);
app.use("/api/checkout", checkout);
app.get("/health", (_req, res) => res.json({ ok: true }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(env.PORT, () => console.log(`API listening on :${env.PORT}`));

// Unpaid pay-now orders are released after the hold time (set in Admin > Payments).
const sweep = () => expireUnpaid().catch((e) => console.error("expiry job failed", e));
const sweepMsgs = () => sweepMessages().catch((e) => console.error("message sweep failed", e));
setInterval(sweep, 60_000);
setInterval(sweepMsgs, 30_000);
sweep();
sweepMsgs();
