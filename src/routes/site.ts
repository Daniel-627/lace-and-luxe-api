import { Router } from "express";
import { ah } from "../lib/async.js";
import { readGuide } from "../lib/sizeGuide.js";

const r = Router();
r.get("/size-guide", ah(async (_req, res) => { res.json(await readGuide()); }));
export default r;
