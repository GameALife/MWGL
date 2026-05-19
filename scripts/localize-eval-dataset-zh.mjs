#!/usr/bin/env node
/**
 * 将 eval_dataset.jsonl 本地化为中文：
 * - user_text：由英文译为中文（需 QWEN_API_KEY）
 * - 删除 user_text_en
 * - expected.final_state：成功 / 失败
 * - must_have_path_labels：按任务描述推断（如「无效」）
 *
 *   node scripts/localize-eval-dataset-zh.mjs
 *   node scripts/localize-eval-dataset-zh.mjs --in data/eval_dataset.jsonl --out data/eval_dataset.jsonl
 */

import fs from "fs";
import path from "path";
import { config as loadEnv } from "dotenv";
import { buildExpectedFromItem } from "./eval-lang.js";

const ROOT = process.cwd();
loadEnv({ path: path.join(ROOT, ".env") });

function parseArgs(argv) {
  const o = {
    in: "data/eval_dataset.jsonl",
    out: "data/eval_dataset.jsonl",
    batch: 8,
    dry: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--in") o.in = argv[++i] || o.in;
    else if (a === "--out") o.out = argv[++i] || o.out;
    else if (a === "--batch") o.batch = Math.max(1, Number(argv[++i]) || 8);
    else if (a === "--dry") o.dry = true;
  }
  return o;
}

function readJsonl(file) {
  const abs = path.resolve(ROOT, file);
  const lines = fs
    .readFileSync(abs, "utf8")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw new Error(`${file} line ${idx + 1}: ${e.message}`);
    }
  });
}

async function translateBatch(texts, client) {
  const numbered = texts.map((t, i) => `[${i + 1}]\n${t}`).join("\n\n");
  const system = [
    "你是技术文档翻译。将用户给出的英文工作流需求逐条译为简体中文。",
    "保留英文变量名（如 paper、summary、question_1）与格式要求（XML、JSON、Markdown、PDF 等）不译。",
    "按相同编号 [1]、[2]… 输出，每条一段，不要合并、不要解释。"
  ].join("");
  const apiUrl = `${client.base_url}/chat/completions`;
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${client.api_key}`
    },
    body: JSON.stringify({
      model: client.model,
      temperature: 0.1,
      max_tokens: 8192,
      messages: [
        { role: "system", content: system },
        { role: "user", content: numbered }
      ]
    })
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`translate HTTP ${response.status}: ${raw.slice(0, 400)}`);
  const payload = JSON.parse(raw);
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("translate: empty content");

  const out = [];
  for (let i = 0; i < texts.length; i += 1) {
    const re = new RegExp(`\\[${i + 1}\\]\\s*([\\s\\S]*?)(?=\\n\\[${i + 2}\\]|$)`);
    const m = content.match(re);
    out.push(m ? m[1].trim() : texts[i]);
  }
  if (out.length !== texts.length) {
    throw new Error(`translate: expected ${texts.length} segments, got ${out.length}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = readJsonl(args.in);
  if (rows.length === 0) {
    console.error("empty dataset");
    process.exit(1);
  }

  const apiKey = String(process.env.QWEN_API_KEY || "").trim();
  const baseUrl = String(process.env.QWEN_BASE_URL || "").trim().replace(/\/$/, "");
  const model = String(process.env.QWEN_MODEL || "qwen-turbo").trim();
  if (!args.dry && (!apiKey || !baseUrl)) {
    console.error("需要 QWEN_API_KEY 与 QWEN_BASE_URL（.env）");
    process.exit(1);
  }
  const client = { api_key: apiKey, base_url: baseUrl, model };

  const outRows = [];
  for (let i = 0; i < rows.length; i += args.batch) {
    const chunk = rows.slice(i, i + args.batch);
    const sources = chunk.map(
      (r) =>
        String(r?.input?.user_text_en || r?.input?.user_text || "").trim()
    );
    let translated = sources;
    if (!args.dry) {
      console.log(`translate ${i + 1}-${i + chunk.length} / ${rows.length}...`);
      translated = await translateBatch(sources, client);
    }
    for (let j = 0; j < chunk.length; j += 1) {
      const item = { ...chunk[j] };
      const userTextZh = args.dry ? sources[j] : translated[j];
      item.input = { user_text: userTextZh };
      item.expected = buildExpectedFromItem({ ...item, input: { user_text: userTextZh } });
      if (item.meta && typeof item.meta === "object") {
        item.meta = { ...item.meta, locale: "zh" };
      }
      outRows.push(item);
    }
  }

  const outPath = path.resolve(ROOT, args.out);
  const body = outRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  if (!args.dry) fs.writeFileSync(outPath, body, "utf8");
  console.log(
    `done: rows=${outRows.length} out=${outPath} dry=${args.dry} locale=zh (no user_text_en)`
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
