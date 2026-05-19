#!/usr/bin/env node
/**
 * 仅刷新 eval_dataset.jsonl 的 expected 字段（不重新翻译 user_text）。
 *
 *   node scripts/refresh-eval-expected.mjs
 */

import fs from "fs";
import path from "path";
import { buildExpectedFromItem } from "./eval-lang.js";

const file = process.argv[2] || "data/eval_dataset.jsonl";
const abs = path.resolve(process.cwd(), file);
const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/).filter((x) => x.trim());
const rows = lines.map((line, i) => {
  try {
    return JSON.parse(line);
  } catch (e) {
    throw new Error(`line ${i + 1}: ${e.message}`);
  }
});

let branchN = 0;
let loopN = 0;
const out = rows.map((item) => {
  // 全量重算：仅保留终态偏好，不沿用旧的 needs_* / 变量列表 / 路径标签
  const expected = buildExpectedFromItem({
    ...item,
    expected: { final_state: item?.expected?.final_state || "成功" }
  });
  if (expected.needs_branch) branchN += 1;
  if (expected.needs_loop) loopN += 1;
  return { ...item, expected };
});

fs.writeFileSync(abs, out.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
console.log(
  `refreshed expected: rows=${out.length} needs_branch=${branchN} needs_loop=${loopN} -> ${abs}`
);
