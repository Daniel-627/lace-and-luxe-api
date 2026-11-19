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
import adminContent from "./routes/adminContent.js";
import site from "./routes/site.js";
import { sweepMessages } from "./lib/messaging/service.js";
import adminReports from "./routes/adminReports.js";
import { alertOps } from "./lib/alerts.js";
import { db } from "./lib/db.js";

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
app.use("/api/admin", adminContent);
app.use("/api/admin", adminReports); // customers + reports; before adminCommerce, which is owner-only
app.use("/api/site", site);
app.use("/api/admin", adminCommerce);
app.use("/api/checkout", checkout);
app.get("/health", (_req, res) => res.json({ ok: true }));
// For uptime monitors: also proves the database answers, which is what a sleeping host or a paused database breaks.
app.get("/health/deep", async (_req, res) => {
  try { await db.$queryRaw`SELECT 1`; res.json({ ok: true, db: true }); }
  catch { res.status(503).json({ ok: false, db: false }); }
});

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  // Bad JSON, oversized bodies and the like are the caller's mistake: answer plainly, no alert.
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) return void res.status(status).json({ error: "Invalid request" });
  console.error(`[error] ${req.method} ${req.originalUrl.split("?")[0]}`, err);
  void alertOps(`500 on ${req.method} ${req.baseUrl}${req.route?.path ?? ""}`, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  res.status(500).json({ error: "Server error" });
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
  void alertOps("Unhandled promise rejection", reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
});
// After an uncaught exception the process is in an unknown state: tell the owner, then exit so the host restarts it.
process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e);
  void alertOps("API crashed (uncaught exception)", `${e.name}: ${e.message}`).finally(() => process.exit(1));
});

app.listen(env.PORT, () => console.log(`API listening on :${env.PORT}`));

// Unpaid pay-now orders are released after the hold time (set in Admin > Payments).
const sweep = () => expireUnpaid().catch((e) => { console.error("expiry job failed", e); void alertOps("Order expiry job failed", String(e)); });
const sweepMsgs = () => sweepMessages().catch((e) => { console.error("message sweep failed", e); void alertOps("Message sending job failed", String(e)); });
setInterval(sweep, 60_000);
setInterval(sweepMsgs, 30_000);
sweep();
sweepMsgs();
