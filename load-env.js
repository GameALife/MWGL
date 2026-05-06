/**
 * 在任意 cwd 下从项目根目录加载 .env（dotenv 默认只读 process.cwd()/.env）。
 * 必须作为 server 入口的第一个 import，以便 routes 模块初始化时能读到 QWEN_* / DEEPSEEK_*。
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });
