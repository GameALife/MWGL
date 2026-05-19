import fs from "fs";
import path from "path";
import { normalizeFinalState } from "./eval-lang.js";

const DATASET_PATH = process.argv[2] || "data/eval_dataset.jsonl";
const FORBIDDEN_LABELS = [/^\d+$/, /^分支\d+$/i, /^branch\d+$/i];

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeLabel(value) {
  return String(value || "").trim();
}

function validateLine(item, index) {
  const errors = [];
  if (!isObject(item)) {
    return [`line ${index}: not a JSON object`];
  }

  const id = String(item.id || "").trim();
  if (!id) errors.push(`line ${index}: missing id`);

  if (!isObject(item.input)) errors.push(`line ${index}: input must be object`);

  if (!isObject(item.expected)) {
    errors.push(`line ${index}: expected must be object`);
    return errors;
  }

  const finalState = normalizeFinalState(item.expected.final_state);
  if (finalState !== "success" && finalState !== "failure") {
    errors.push(
      `line ${index}: expected.final_state must be success|failure|成功|失败`
    );
  }

  if (item.input && Object.prototype.hasOwnProperty.call(item.input, "user_text_en")) {
    errors.push(`line ${index}: input.user_text_en is deprecated; use user_text only`);
  }

  if (!Array.isArray(item.expected.must_have_path_labels)) {
    errors.push(`line ${index}: expected.must_have_path_labels must be array`);
    return errors;
  }

  if (item.expected.needs_branch != null && typeof item.expected.needs_branch !== "boolean") {
    errors.push(`line ${index}: expected.needs_branch must be boolean`);
  }
  if (item.expected.needs_loop != null && typeof item.expected.needs_loop !== "boolean") {
    errors.push(`line ${index}: expected.needs_loop must be boolean`);
  }
  if (item.expected.input_vars != null && !Array.isArray(item.expected.input_vars)) {
    errors.push(`line ${index}: expected.input_vars must be array`);
  }
  if (item.expected.output_vars != null && !Array.isArray(item.expected.output_vars)) {
    errors.push(`line ${index}: expected.output_vars must be array`);
  }

  const labels = item.expected.must_have_path_labels.map(normalizeLabel);
  if (labels.some((x) => !x)) {
    errors.push(`line ${index}: labels cannot be empty`);
  }
  const dupSet = new Set();
  for (const label of labels) {
    if (dupSet.has(label)) errors.push(`line ${index}: duplicate label "${label}"`);
    dupSet.add(label);
    if (FORBIDDEN_LABELS.some((re) => re.test(label))) {
      errors.push(`line ${index}: label "${label}" is placeholder-like`);
    }
  }

  return errors;
}

function main() {
  const absolutePath = path.resolve(process.cwd(), DATASET_PATH);
  if (!fs.existsSync(absolutePath)) {
    console.error(`Dataset not found: ${absolutePath}`);
    process.exit(1);
  }

  const text = fs.readFileSync(absolutePath, "utf8");
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    console.error("Dataset is empty.");
    process.exit(1);
  }

  const errors = [];
  const seenIds = new Set();
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push(`line ${lineNo}: invalid JSON (${error.message})`);
      return;
    }

    const lineErrors = validateLine(parsed, lineNo);
    errors.push(...lineErrors);

    const id = String(parsed?.id || "").trim();
    if (id) {
      if (seenIds.has(id)) errors.push(`line ${lineNo}: duplicate id "${id}"`);
      seenIds.add(id);
    }
  });

  if (errors.length > 0) {
    console.error(`Validation failed. total_errors=${errors.length}`);
    errors.forEach((e) => console.error(`- ${e}`));
    process.exit(1);
  }

  console.log(`Validation passed. rows=${lines.length}, unique_ids=${seenIds.size}`);
}

main();
