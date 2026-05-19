import fs from "fs";
import path from "path";
import { Router } from "express";

const router = Router();

/** 供前端「生成后优化」拉取评测约束。 */
router.get("/api/mwgl/eval-dataset", (_req, res) => {
  const cwd = process.cwd();
  const rel = "data/eval_dataset.jsonl";
  const abs = path.join(cwd, rel);
  if (!fs.existsSync(abs)) {
    return res.json({ source: null, count: 0, items: [] });
  }
  try {
    const text = fs.readFileSync(abs, "utf8");
    const items = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line, idx) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          throw new Error(`${rel} line ${idx + 1}: ${e.message}`);
        }
      });
    return res.json({ source: rel, count: items.length, items });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

export default router;
