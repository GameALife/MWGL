# MWGL Studio v2

MWGL Studio v2 是一个面向工作流设计与优化的可视化工具，提供从自然语言到流程图、伪代码、可执行代码的完整链路，并内置约束校验与优化能力。

## 项目能力总览

- 可视化编辑 MWGL v2 工作流（节点、连线、画布操作、会话管理）
- 自然语言生成工作流：`NL -> DAG`
- 工作流转伪代码：`DAG -> Pseudocode`
- 伪代码转代码：`Pseudocode -> Code`
- 代码快速自检运行（Python / JavaScript）
- 基于评测集的工作流优化（Beam / MCTS）
- 评测集读取、合成、合并、校验与检索（支持 Token 与 FAISS 两种检索策略）

## 项目结构

```text
.
├── index.html / styles.css / js/      # 前端应用（画布编辑器 + API 调用）
├── server.js                           # Node.js 服务入口
├── routes/                             # 后端接口
│   ├── skill1-nl2dag.js                # 生成 workflow
│   ├── skill2-dag2pseudo.js            # 生成伪代码
│   ├── skill3-pseudo2code.js           # 生成代码
│   ├── optimize.js                     # 工作流优化
│   ├── eval-dataset-read.js            # 读取 full 评测集
│   ├── mock-evaluator.js               # 模拟评测器（联调用）
│   └── run-check.js                    # 代码快速自检
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

可选高级参数（用于容错重试）：

- `MWGL_GENERATE_MAX_RETRY`：`/api/mwgl/generate` 自动修复轮数，默认 `3`
- `MWGL_PSEUDO_MAX_RETRY`：`/api/mwgl/pseudocode` 自动修复轮数，默认 `2`
- `MWGL_CODE_MAX_RETRY`：`/api/mwgl/code` 自动修复轮数，默认 `2`

## MWGL v2 数据模型

```json
{
  "mwgl_version": 2,
  "rule_id": "R_xxx",
  "rule_name": "示例规则",
  "nodes": [
    { "id": "n_start", "type": "start", "text": "开始", "x": 120, "y": 180 }
  ],
  "edges": [
    { "id": "e_1", "from": "n_start", "to": "n_x", "label": "" }
  ]
}
```

### 节点字段

- `id`：唯一标识
- `type`：节点类型
- `text`：业务语义文本
- `x` / `y`：画布坐标
- `failure_kind`：仅 `failure` 可选，推荐值：
  - `game_lose`
  - `goal_not_met`
  - `precondition_not_met`
  - `risk_blocked`

### 边字段

- `id`：唯一标识
- `from` / `to`：起止节点 ID
- `label`：边语义（`switch` 的出边必须非空且有业务意义）

## 节点类型

当前支持 9 类节点：

- `start`：唯一入口
- `wait_user`：等待用户输入
- `switch`：条件分支（允许单分支）
- `loop_start`：循环入口
- `loop_end`：循环出口/收束点
- `parallel`：并发分发（至少两条出边）
- `case`：普通动作
- `success`：业务成功终态
- `failure`：业务失败终态（不是系统异常）

## 校验与规范

### 编辑态最小拦截

- 禁止自环（`from === to`）
- 禁止新增边后产生有向环

### 导出前全量硬校验

由 `validateWorkflowConstraints` 执行，核心包括：

- 图必须为 DAG；边端点必须存在
- 仅允许一个 `start`，且 `start` 无入边且至少一条出边
- `success` / `failure` 不能有出边
- `switch`：
  - 至少一条出边
  - 每条出边 `label` 非空、不可重复
  - 禁止占位标签（如纯数字、`分支1`）
- `loop_start` 必须且仅能 1 条出边
- `loop_end` 至少 1 条出边
- `parallel` 至少 2 条出边
- `case` 与 `wait_user` 最多 1 条出边
- 允许不可达草稿节点；但从 `start` 可达路径必须至少到达一个终态
- 从 `start` 可达的每个非终态节点都必须能通向某个终态
- `failure` 文案必须具体，不能使用泛化“失败/fail/failure”

### 语义建模建议

- 分流用 `switch`
- 重试/迭代用 `loop_start` + `loop_end`
- 并发用 `parallel`，建议后续汇聚
- 边标签尽量使用可判定条件（如 `已认证`、`超时`、`库存不足`）

## 归一化策略

`normalizeWorkflow` 会做结构修复与保底：

- 清理无效边、移除导致环的边，保持 DAG
- 为 `loop_start` / `parallel` 补最低出边约束
- 不会把 `switch` 改成其他类型，也不会为 `switch` 自动补完整分支语义

## 前端交互

- 拖拽节点移动位置
- 拖拽画布平移视图
- `Ctrl + 滚轮` 缩放
- `Shift + 拖节点` 快速连线
- 点击边可选中，再按 `Delete/Backspace` 删除
- 侧栏与画布双向联动编辑

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

读取 `data/eval_dataset.full.jsonl`，返回 `items` 数组给前端优化流程使用。

### `POST /api/mwgl/optimize`

基于初始工作流 + 评测集进行优化，支持：

- `algorithm`: `beam` / `mcts`
- 可配置迭代次数、beam 宽度、探索参数、权重
- 可挂接外部 evaluator 或 LLM mutator

返回 `best_workflow`、`best_score`、搜索历史、保留/丢弃变异说明等信息。

### `POST /api/mwgl/mock-evaluator`

内置 mock 评测器，用于联调与本地测试，不代表真实线上评估质量。

## 脚本说明

`package.json` 已定义如下脚本：

- `npm start`：启动服务
- `npm run validate:eval-dataset`：校验评测集格式与标签合法性
- `npm run synthesize:dataset`：合成评测集（默认输出 `data/synthetic_eval.jsonl`）
- `npm run merge:eval-datasets`：合并 seed + synthetic 到 full
- `npm run build:eval-dataset`：先合成再合并
- `npm run import:chat2workflow-dataset`：从 `query.json` 生成评测数据
- `npm run faiss:check`：用 Python 脚本做 FAISS Top-K 选样测试
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
- `switch` 标签不通过：改为有语义条件（避免 `1/2/分支1`）
- `failure` 文案不通过：把“失败”改成具体业务失败语义
- 优化效果不稳定：增加评测样本、提高迭代轮数，或接入真实 evaluator

