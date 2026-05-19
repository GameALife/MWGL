#!/usr/bin/env node
/**
 * 合并种子评测集与合成评测集（顺序：先 seed，后 synthetic），校验 id 唯一后写出。
 *
 *   node scripts/merge-eval-datasets.js
 *   node scripts/merge-eval-datasets.js --out data/eval_dataset.jsonl
 */

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

function parseArgs(argv) {
  const o = {
    seed: "data/eval_dataset.seed.jsonl",
    synthetic: "data/synthetic_eval.jsonl",
    out: "data/eval_dataset.jsonl"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--seed") o.seed = argv[++i] || o.seed;
    else if (a === "--synthetic") o.synthetic = argv[++i] || o.synthetic;
    else if (a === "--out") o.out = argv[++i] || o.out;
  }
  return o;
}

function readLines(file) {
  const abs = path.resolve(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.error(`Missing file: ${abs}`);
    process.exit(1);
  }
  const text = fs.readFileSync(abs, "utf8");
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const seedLines = readLines(args.seed);
  const synLines = readLines(args.synthetic);
  const seen = new Set();
  const outLines = [];

  for (const line of seedLines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (e) {
      console.error(`Invalid JSON in seed: ${e.message}`);
      process.exit(1);
    }
    const id = String(row?.id || "").trim();
    if (!id) {
      console.error("Seed row missing id");
      process.exit(1);
    }
    if (seen.has(id)) {
      console.error(`Duplicate id in seed: ${id}`);
      process.exit(1);
    }
    seen.add(id);
    outLines.push(line);
  }

  for (const line of synLines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (e) {
      console.error(`Invalid JSON in synthetic: ${e.message}`);
      process.exit(1);
    }
    const id = String(row?.id || "").trim();
    if (!id) {
      console.error("Synthetic row missing id");
      process.exit(1);
    }
    if (seen.has(id)) {
      console.error(`Duplicate id across files: ${id}`);
      process.exit(1);
    }
    seen.add(id);
    outLines.push(line);
  }

  const outPath = path.resolve(ROOT, args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outLines.join("\n") + "\n", "utf8");
  console.log(`Merged ${seedLines.length} + ${synLines.length} = ${outLines.length} rows -> ${outPath}`);
}

main();
