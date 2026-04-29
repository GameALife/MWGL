#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const out = {
    source: "query.json",
    fullOut: "data/eval_dataset.full.jsonl"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i] || out.source;
    else if (a === "--full-out") out.fullOut = argv[++i] || out.fullOut;
  }
  return out;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const CATEGORY_ZH = {
  Research: "科研",
  Document: "文档",
  Enterprise: "企业",
  Developer: "开发",
  Education: "教育",
  AIGC: "内容生成"
};

const TASK_ZH = {
  PaperDeepReader: "论文深读",
  PaperQA: "论文问答",
  SciencePopularization: "科普讲解",
  BookCharacter: "图书角色总结",
  DeepResearch: "深度研究报告",
  BatchFiles: "批量文件处理",
  InvoiceParsing: "发票解析",
  ExcelExtract: "表格提取",
  FormulaOCR: "公式识别",
  Translation: "文档翻译",
  ContractReview: "合同审查",
  ResumeScreening: "简历筛选",
  MeetingSummary: "会议纪要",
  PerformanceChart: "经营图表",
  GithubSummary: "仓库总结",
  Mermaid: "Mermaid图生成",
  Code: "代码处理",
  StudyPlanner: "学习规划",
  ExamQuestion: "试题生成",
  ErrorNotebook: "错题本",
  HomeworkGrading: "作业批改",
  StoryPPT: "故事课件",
  HTML: "网页生成",
  LogoSVG: "Logo设计",
  Podcast: "播客生成",
  Creation: "文章创作",
  Copywriting: "文案改写"
};

function pickLabels(text, isFailure) {
  const s = text.toLowerCase();
  if (s.includes("parallel") || s.includes("branch")) return ["并行分支A", "并行分支B"];
  if (s.includes("retry") || s.includes("loop")) return ["重试上限"];
  if (s.includes("timeout")) return ["超时"];
  if (s.includes("login") || s.includes("auth")) return [isFailure ? "未认证" : "已认证"];
  if (s.includes("invoice") || s.includes("excel") || s.includes("extract")) return ["已认证"];
  if (s.includes("risk") || s.includes("review") || s.includes("audit")) return [isFailure ? "审核拒绝" : "审核通过"];
  if (s.includes("chart") || s.includes("code") || s.includes("github")) return ["已认证"];
  if (s.includes("image") || s.includes("audio") || s.includes("story")) return [isFailure ? "超时" : "已认证"];
  return [isFailure ? "超时" : "已认证"];
}

function inferFinalState(text) {
  const s = text.toLowerCase();
  const failureHints = ["invalid", "fail", "failed", "reject", "timeout", "error", "refuse"];
  return failureHints.some((x) => s.includes(x)) ? "failure" : "success";
}

function toChinesePrompt(category, task, prompt) {
  const catZh = CATEGORY_ZH[category] || "通用";
  const taskZh = TASK_ZH[task] || task;
  const s = String(prompt || "").toLowerCase();
  const hints = [];
  if (s.includes("branch") || s.includes("classifier")) hints.push("按条件进行分支路由");
  if (s.includes("json")) hints.push("结构化输出为 JSON");
  if (s.includes("markdown")) hints.push("输出为 Markdown");
  if (s.includes("pdf")) hints.push("生成 PDF 文件");
  if (s.includes("docx")) hints.push("生成 DOCX 文件");
  if (s.includes("ppt")) hints.push("生成 PPT 文件");
  if (s.includes("image") || s.includes("picture") || s.includes("illustration")) hints.push("生成配图或图像文件");
  if (s.includes("audio") || s.includes("podcast")) hints.push("生成音频输出");
  if (s.includes("extract")) hints.push("先抽取关键信息再处理");
  if (s.includes("translate")) hints.push("执行翻译并保留目标语言风格");
  if (s.includes("review") || s.includes("evaluate")) hints.push("增加审查或评估环节");
  if (s.includes("github") || s.includes("code")) hints.push("进行代码/仓库分析");
  if (hints.length === 0) {
    return `${catZh}场景：构建${taskZh}工作流，满足输入输出约束并保证可执行。`;
  }
  return `${catZh}场景：构建${taskZh}工作流，要求${hints.join("、")}。`;
}

function toRows(items) {
  const rows = [];
  for (const item of items) {
    const task = sanitizeId(item?.task || "task");
    const category = normalizeText(item?.category || "unknown");
    const taskRaw = normalizeText(item?.task || "task");
    const keys = Object.keys(item || {})
      .filter((k) => /^query\d+$/.test(k))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    let seq = 0;
    for (const key of keys) {
      const prompt = normalizeText(item[key]);
      if (!prompt) continue;
      seq += 1;
      const finalState = inferFinalState(prompt);
      rows.push({
        id: `c2w_${task}_${String(seq).padStart(3, "0")}`,
        domain: category,
        input: {
          user_text: toChinesePrompt(category, taskRaw, prompt),
          user_text_en: prompt
        },
        expected: {
          final_state: finalState,
          must_have_path_labels: pickLabels(prompt, finalState === "failure")
        },
        meta: {
          source: "MWGL/query.json",
          category_en: category,
          task_en: taskRaw,
          query_key: key
        }
      });
    }
  }
  return rows;
}

function writeJsonl(filePath, rows) {
  const abs = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(abs, text, "utf8");
  return abs;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceAbs = path.resolve(__dirname, "..", args.source);
  if (!fs.existsSync(sourceAbs)) {
    console.error(`Source not found: ${sourceAbs}`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(sourceAbs, "utf8"));
  if (!Array.isArray(payload) || payload.length === 0) {
    console.error("Source dataset is empty or invalid.");
    process.exit(1);
  }
  const rows = toRows(payload);
  const fullPath = writeJsonl(args.fullOut, rows);
  console.log(`Imported query dataset -> rows=${rows.length}`);
  console.log(`full: ${fullPath}`);
}

main();
