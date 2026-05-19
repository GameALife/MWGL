# MWGL Studio

MWGL Studio 是一个面向**基于MWGL语言**的**工作流**的设计与优化的可视化工具，提供从自然语言到流程图、伪代码、可执行代码的完整链路，并内置约束校验与优化能力。

## MWGL 语言是什么

MWGL（`Minimal Workflow Graph Language`，意为**最小化工作流图语言**）用于把业务流程表示为机器可处理的有向图。  
在 MWGL 中：

- `nodes` 表示流程中的步骤与决策（仅 **4 种类型**）
- `edges` 表示顺序或分支转移；`branch` 的多条出边用 `label` 表达条件
- 循环、并行、等待用户等**不占用图语法**，写在 `step` 文案或由伪代码/代码生成表达

MWGL 的目标是同时兼顾三件事：

- **可读性**：人能直接看懂业务逻辑
- **可校验性**：可用约束规则自动判定结构是否合法
- **可执行映射**：可稳定转换到伪代码和真实代码

本项目（MWGL Studio v3）是 MWGL v3 的工程化工作台：负责编辑、生成、校验、优化与代码落地。导入的 v2 JSON 会在 `normalize` 时自动迁移。

## 项目能力总览

- 可视化编辑 MWGL v3 工作流（4 类节点、连线、画布、会话）
- 自然语言生成工作流：`NL -> DAG`
- 工作流转伪代码：`DAG -> Pseudocode`
- 伪代码转代码：`Pseudocode -> Code`
- 代码快速自检运行（Python / JavaScript）
- 基于评测集的 **Top-4 优化**（默认 **束搜索**；可选 **MCTS**；DeepSeek 初池 + Qwen 内容/结构双路改写）
- 内置评测集，支持优化时检索与校验（Token / FAISS）

## 项目结构

```text
.
├── index.html / styles.css / js/      # 前端应用（画布编辑器 + API 调用）
├── server.js                           # Node.js 服务入口
├── lib/                                # Top-4 搜索、DeepSeek 初池生成
│   ├── mwgl-top4-search.mjs
│   └── mwgl-generate-validate.mjs
├── routes/                             # 后端接口
│   ├── skill1-nl2dag.js                # 生成 workflow
│   ├── skill2-dag2pseudo.js            # 生成伪代码
│   ├── skill3-pseudo2code.js           # 生成代码
│   ├── optimize.js                     # 工作流优化 API
│   ├── optimize-scoring.js             # 统一打分
│   ├── optimize-mutations.js           # 算子提示（llm_generate 邻域）
│   ├── eval-dataset-read.js            # 读取评测集
│   ├── mock-evaluator.js               # 模拟评测器（联调用）
│   ├── graph-edit-eval.js              # 可选图编辑距离 API
│   └── run-check.js                    # 代码快速自检
├── lib/
│   ├── mwgl-graph-edit-adapter.mjs     # MWGL → RobustFlow 图格式
│   └── mwgl-graph-edit-eval.mjs        # Python graph_evaluator 桥接
├── tools/
│   ├── graph_edit_score.py             # stdin/stdout 图 F1 评测
│   └── mwgl_workflow_adapter.py
├── scripts/                            # 数据集与优化脚本
├── data/                               # 评测集与优化结果
└── README.md
```

## 快速开始

### 1) 安装与启动

```bash
cd /home/jikaining/workspace/workflow/MWGL
npm install
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
npm start
```

默认地址：

- 前端：`http://localhost:3001`
- 健康检查：`http://localhost:3001/api/health`

### 2) 环境变量

`.env.example` 中已有示例：

- `DEEPSEEK_API_KEY`：必填，模型调用密钥
- `DEEPSEEK_API_BASE`：默认 `https://api.deepseek.com/v1`
- `PORT`：服务端口，默认 `3001`
- `CORS_ORIGIN`：跨域来源，默认 `*`

**Top-4 优化（生成后优化）还需配置 Qwen（DashScope 兼容 OpenAI）：**

- `QWEN_API_KEY`：必填（优化阶段整图改写）
- `QWEN_BASE_URL`：如 `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `QWEN_MODEL`：默认 `qwen-turbo`
- `MWGL_EXPAND_MODEL`：可选，覆盖 expand 用模型

可选高级参数（用于容错重试）：

- `MWGL_GENERATE_MAX_RETRY`：`/api/mwgl/generate` 自动修复轮数，默认 `3`
- `MWGL_PSEUDO_MAX_RETRY`：`/api/mwgl/pseudocode` 自动修复轮数，默认 `2`
- `MWGL_CODE_MAX_RETRY`：`/api/mwgl/code` 自动修复轮数，默认 `2`

## MWGL v3 数据模型

```json
{
  "mwgl_version": 3,
  "rule_id": "R_xxx",
  "rule_name": "示例规则",
  "nodes": [
    { "id": "n_start", "type": "start", "text": "开始", "x": 120, "y": 180 },
    { "id": "n_end", "type": "end", "outcome": "success", "text": "任务完成", "x": 520, "y": 180 }
  ],
  "edges": [
    { "id": "e_1", "from": "n_start", "to": "n_step", "label": "" }
  ]
}
```

### 节点类型（4 种）

| type | 含义 | 出边 |
|------|------|------|
| `start` | 唯一入口 | ≥1 |
| `step` | 顺序动作 | ≤1 |
| `branch` | 条件分支 | ≥2，每条 label 非空且不重复 |
| `end` | 终态 | 0；须 `outcome`: `success` \| `failure` |

### 边字段

- `from` / `to` / `label`（从 `branch` 出发时 label 必填且有业务语义）

## 校验与规范

- 全图 DAG；唯一 `start`；可达非 `end` 节点须能到达某个 `end`
- `end` + `outcome=failure` 的文案须具体（禁单独「失败」）
- v2 图在 `normalizeWorkflow` 时自动迁移为 v3（`switch`→`branch`，`case`/`wait_user`→`step`，`success`/`failure`→`end`）

## 工作流优化（Top-4）

前端「生成后优化」默认 **开启 Top-4 + 束搜索**；可切换 **MCTS**。二者共用：

1. **第 0 轮**：DeepSeek 并行初池（默认 **8** 份，含 UI 种子则少生成）→ 打分 → **保留 top4**
2. **第 1+ 轮**：对每个被选中的父图，**Qwen 并行 2 路**整图改写：
   - **content**：主要优化节点/边文案，尽量保持拓扑
   - **structure**：主要优化 DAG（分支、end、可达性）
3. **输出**：全程 **`globalBest`**（历史最高分，避免子代全变差时回退失败）

| 搜索方式 | 每轮扩谁 | 默认宏轮数 | 粗算 Qwen 次数/轮 |
|----------|----------|------------|-------------------|
| **束搜索**（默认） | 当前 top4 **全部**父代 | `top4_rounds=2` | 4×2=**8** |
| **MCTS** | **UCT** 选约 4 个节点 | `2+1=3` | 4×2=**8**（选路不同） |

实现见 `lib/mwgl-top4-search.mjs`；打分见 `routes/optimize-scoring.js`。

## 归一化策略

- 清理无效边、保持 DAG
- `branch` 不足两条出边时自动补 step 与 label

## 前端交互

- 拖拽节点移动位置
- 拖拽画布平移视图
- `Ctrl + 滚轮` 缩放
- `Shift + 拖节点` 快速连线
- 点击边可选中，再按 `Delete/Backspace` 删除
- 侧栏与画布双向联动编辑
- **生成后优化**：工具栏「开启 Top-4」+「束搜索 / MCTS」；下方提示说明调用量与需 `QWEN_*`

## API 文档

### `GET /api/health`

返回服务状态、是否已配置 key、模型 Base URL 概览。

### `POST /api/mwgl/generate`

输入：

```json
{ "prompt": "根据业务描述生成流程图" }
```

输出：

```json
{ "content": "{...workflow json string...}" }
```

说明：服务端会做解析、归一化、硬校验；失败时自动修复重试，仍失败返回 `422` 和 `details`。

### `POST /api/mwgl/pseudocode`

输入：

```json
{ "workflow": { "...": "..." } }
```

输出：

```json
{ "content": "BEGIN WORKFLOW\n..." }
```

说明：会校验伪代码结构关键字（如 `BEGIN/END WORKFLOW`、`WHILE/END WHILE`）。

### `POST /api/mwgl/code`

输入：

```json
{ "pseudocode": "BEGIN WORKFLOW ...", "language": "Python" }
```

输出：

```json
{ "content": "可执行代码字符串" }
```

说明：默认语言是 `Python`；支持重试修复，失败返回 `422`。

### `POST /api/mwgl/run-check`

输入代码并快速执行检查：

- `language=Python` -> `python3 -c`
- `language=JavaScript` -> `node -e`

输出含 `exitCode`、`stdout`、`stderr`。

### `GET /api/mwgl/eval-dataset`

读取 `data/eval_dataset.jsonl`，返回 `items` 数组给前端优化流程使用。

### `POST /api/mwgl/optimize`

基于初始工作流 + 评测集进行 Top-4 优化（需 **`DEEPSEEK_API_KEY`** + **`QWEN_*`**）。

**请求示例（束搜索，与前端默认一致）：**

```json
{
  "prompt": "用户业务描述",
  "initial_workflow": { "mwgl_version": 3, "nodes": [], "edges": [] },
  "eval_dataset": [],
  "config": {
    "algorithm": "top4",
    "top4_search_mode": "beam",
    "top4_initial_pool": 8,
    "top4_keep": 4,
    "top4_rounds": 2,
    "eval_topk": 24,
    "retrieval_mode": "faiss"
  }
}
```

**MCTS** 将 `top4_search_mode` 设为 `"mcts"`，并可用 `top4_mcts_extra_rounds`（默认 1）、`top4_mcts_exploration`（默认 1.2）。

| 参数 | 默认 | 说明 |
|------|------|------|
| `top4_search_mode` | `beam` | `beam` \| `mcts` |
| `top4_initial_pool` | 8 | 第 0 轮候选总数（含种子） |
| `top4_keep` | 4 | 每轮保留父代数 |
| `top4_rounds` | 2 | 束搜索宏轮数 / MCTS 基础宏轮 |
| `top4_mcts_extra_rounds` | 1 | 仅 mcts：额外宏轮 |
| `top4_mcts_exploration` | 1.2 | UCT 探索系数 |
| `eval_topk` | 24 | 打分用评测条 Top-K |
| `weights` | 见下表 | 覆盖 `optimize-scoring` 权重 |

返回 `best_workflow`、`best_score`、`history`（含每轮 `phase`/`global_best_score`）、`explain.search_mode` 等。

#### 评分方式（`routes/optimize-scoring.js`）

对每个候选图在 **Top-K 评测条**（默认 24）上打分，综合项为：

| 维度 | 含义 |
|------|------|
| `structural` | 可达性、success/failure 终态、分支语义 label、`loop` 等（见下表，权重为 0.1 步长） |
| `requirements` | 按条目的 `expected` + 从任务描述推断：需分支/循环、输出变量是否出现在节点文案 |
| `prompt_fit` | 用户 prompt 与图/评测条文本的 token 贴合 |
| `cost` / `latency` / `complexity` | 图规模惩罚（越小越好） |

`score = task_success − 惩罚项`，裁剪到 `[0, 1]`。Top-4 束搜索/MCTS 按 `score` 选父代与 `globalBest`；MCTS 另将 `score` 回传到树节点 `rewardSum`/`visits` 供 UCT 使用。

默认权重：`structural 0.3`、`requirements 0.5`、`prompt_fit 0.2`；惩罚项 `cost`/`latency`/`complexity` 见 `DEFAULT_SCORE_WEIGHTS`。

**结构分 `structural`**（`STRUCTURAL_SCORE_WEIGHTS`，\(n>0\) 时）：

\[
s = 0.2\rho + 0.4\,[S] + 0.1\,[F] + 0.2\,[P] + B + 0.1\,[H]
\]

| 符号 | 条件 | 加分 |
|------|------|------|
| \(\rho\) | 从 start 可达节点数 / 总节点数 | \(0.2\times\rho\) |
| \([S]\) | 可达子图有 `outcome=success` 的 end | \(+0.4\) |
| \([F]\) | 可达子图有 `outcome=failure` 的 end | \(+0.1\) |
| \([P]\) | 可达非 end 节点均能到达 end | \(+0.2\) |
| \(B\) | 有分支：label 合法 \(+0.1\)，否则 \(+0\)；无分支：\(+0.1\) | |
| \([H]\) | 存在带 `loop.steps` 的 step | \(+0.1\) |

\(\text{structural}=\mathrm{clamp}(s,0,1)\)。理论满分 \(s=1.1\) 时截断为 1。

**需求分 `requirements`**：对 Top-K 评测条逐条算通过率再平均。单条 \(r_i=\text{通过检查数}/\text{总检查数}\)：

| 检查项 | 权重 | 通过条件 |
|--------|------|----------|
| 终态 | 1 | `expected.final_state` 为成功且有 success end，或为失败且有 failure end |
| 路径标签 | 各 1 | `must_have_path_labels` 出现在边 label 上 |
| 需分支 | 1 | `needs_branch` 时：≥1 个分支且 label 合法 |
| 需循环 | 1 | `needs_loop` 时：存在 `loop.steps` |
| 输出变量 | 各 1 | 变量名（小写）出现在节点/边/loop 文案 `textBlob` 中 |
| 输入变量 | 各 0.5 | 最多检查 2 个，规则同上 |

\[
\text{requirements}=\frac{1}{K}\sum_{i=1}^{K} r_i,\quad K=0\text{ 时为 }1
\]

**贴合度 `prompt_fit`**（无 prompt 时为 1）。token 重叠（英文词 + 单字）：

\[
\text{overlap}(a,b)=\frac{|T_a\cap T_b|}{\sqrt{|T_a|\cdot|T_b|}}
\]

\[
\text{prompt\_fit}=\max\Big(\text{overlap}(p,W),\ \max_i\big[0.9\,\text{overlap}(p,t_i)+0.1\,\text{overlap}(W,t_i)\big]\Big)
\]

\(p\)=用户 prompt，\(W\)=全文案，\(t_i\)=第 \(i\) 条评测 `user_text`。

**惩罚项**（原始量 \(\in[0,1]\)，图越大越大）：

\[
\text{complexity}=\mathrm{clamp}\frac{n+0.5e+1.5b}{50},\quad
\text{cost}=\mathrm{clamp}\frac{50n+20e+30b}{3000},\quad
\text{latency}=\mathrm{clamp}\frac{n}{100}
\]

\[
\text{task\_success}=0.3\cdot\text{structural}+0.5\cdot\text{requirements}+0.2\cdot\text{prompt\_fit}
\]

\[
\text{score}=\mathrm{clamp}\big(\text{task\_success}-0.1\cdot\text{cost}-0.1\cdot\text{latency}-0.1\cdot\text{complexity},\,0,\,1\big)
\]

系数见 `TASK_SUCCESS_WEIGHTS`、`PENALTY_SCORE_WEIGHTS`、`PENALTY_SCALE`（可用请求 `weights` 覆盖）。

### `POST /api/mwgl/mock-evaluator`

与优化接口共用同一套 `scoreWorkflow`；仅用于联调或自定义 HTTP evaluator 入口。

可选 **图编辑距离**（RobustFlow `graph_evaluator`）：请求体带 `reference_workflow` 且 `graph_edit_eval.enabled: true`（或环境变量 `MWGL_GRAPH_EDIT_EVAL=1`），将 `(node_f1 + graph_f1) / 2` 按权重 `MWGL_GRAPH_EDIT_WEIGHT`（默认 `0.2`）混入最终 `score`。Python 不可用时可用 `lexical_fallback: true` 做粗粒度字面相似度。

| 接口 | 说明 |
|------|------|
| `GET /api/mwgl/graph-edit-eval/status` | 查看默认开关与环境变量 |
| `POST /api/mwgl/graph-edit-score` | 仅算图相似度（需 `reference_workflow` + `candidate_workflow` 或 `candidates`） |
| `POST /api/mwgl/score-with-graph-edit` | 本地 `scoreWorkflow` + 图编辑混合分 |

优化接口 `POST /api/mwgl/optimize` 同样支持 `graph_edit_eval` 与可选 `reference_workflow`；未传参照图时，优先用首个种子图，否则用初池 top1（第 1 轮扩展起生效）。

依赖（仅开启时安装）：

```bash
git clone https://github.com/DEFENSE-SEU/RobustFlow.git ../RobustFlow   # 或设置 ROBUSTFLOW_ROOT
pip install -r tools/requirements-graph-edit.txt
# 可选：export MWGL_GRAPH_EDIT_EVAL=1
```

## 评测数据与版权

`data/eval_dataset.jsonl` 随本仓库提供，供工作流生成后的优化与评测使用。其中的自然语言任务描述来自 **[Chat2Workflow](https://github.com/zjunlp/Chat2Workflow)** 基准（论文：[Chat2Workflow: A Benchmark for Generating Executable Visual Workflows with Natural Language](https://arxiv.org/abs/2604.19667)）。引用、再分发或商用时请遵守原仓库许可并注明出处。

每条仅保留 `input.user_text`（中文任务描述），不再使用 `user_text_en`。`expected` 含中文终态与显式约束：

- `final_state`：`成功` / `失败`
- `needs_branch` / `needs_loop`：是否应有分支、循环
- `input_vars` / `output_vars`：与 Chat2Workflow check 对齐的变量名
- `must_have_path_labels`：边上应出现的中文标签（如 `无效`）

从英文版重建全文：

```bash
npm run localize:eval-dataset-zh
```

仅刷新 `expected`（不改 `user_text`）：

```bash
npm run refresh:eval-expected
```

校验：`npm run validate:eval-dataset`

## 脚本说明

`package.json` 已定义如下脚本：

- `npm start`：启动服务
- `npm run validate:eval-dataset`：校验评测集格式
- `npm run localize:eval-dataset-zh`：将评测集译为中文并写入 `expected`（成功/失败）
- `npm run faiss:check`：FAISS Top-K 选样测试
- `npm run run:optimize`：调用优化 API 并输出结果到 `data/optimize_result.json`

## 典型工作流

1. 启动服务，配置 API key  
2. 在前端输入业务需求，调用生成接口得到初版 workflow  
3. 可选：拉取评测集并执行优化  
4. 转伪代码，再转目标语言代码  
5. 使用 run-check 进行快速执行验证  
6. 导出前进行全量约束校验

## 常见问题

- 生成接口报错：优先检查 `DEEPSEEK_API_KEY` 与 `DEEPSEEK_API_BASE`
- 导出失败：查看前端约束面板中的完整错误列表
- `branch` 标签不通过：改为有语义条件（避免 `1/2/分支1`）
- `end` failure 文案不通过：写明具体业务失败语义
- 优化报错 `requires Qwen`：在 `.env` 配置 `QWEN_API_KEY`、`QWEN_BASE_URL`、`QWEN_MODEL`
- 优化很慢：可关闭「生成后优化」，或仅用束搜索（比 MCTS 少一轮）；初池可保持 8→4
- 优化效果不稳定：调高 `eval_topk`、检查 `data/eval_dataset.jsonl` 的 `expected`，或调整 `config.weights`

