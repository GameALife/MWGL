import {
  buildWorkflowByDeepSeek,
  dagToPseudocode,
  fetchEvalDataset,
  optimizeWorkflow,
  pseudoToCode,
  runCodeQuickCheck
} from "./api.js";
import {
  wouldEdgeCreateCycle,
  layoutWorkflowLeftToRight,
  mwglToWorkflow,
  validateWorkflowConstraints,
  workflowToMwgl
} from "./mwgl.js";
import { state, uid } from "./state.js";
import { NODE_LAYOUT_HEIGHT, NODE_LAYOUT_WIDTH, WORLD_HEIGHT, WORLD_WIDTH, screenToUser } from "./viewport.js";

export function bindInteractions(elements, renderer) {
  const { setStatus, getSelectedNode, syncEditor, render, applyViewportTransform } = renderer;
  const SVG_NS = "http://www.w3.org/2000/svg";
  let linking = null;
  let panning = null;
  const MIN_SCALE = 0.4;
  const MAX_SCALE = 2.4;
  const SESSION_STORAGE_KEY = "mwgl_sessions_v1";
  let sessions = [];
  let activeSessionId = "";

  function createBlankWorkflow() {
    return {
      mwgl_version: 2,
      rule_id: uid("R_"),
      rule_name: "空白工作流",
      nodes: [],
      edges: []
    };
  }

  function cloneWorkflow(wf) {
    return JSON.parse(JSON.stringify(wf || state.workflow));
  }

  function newSessionName(index) {
    return `窗口 ${index}`;
  }

  function createSessionPayload(name = "新窗口") {
    return {
      id: uid("s_"),
      name,
      prompt: "",
      workflow: createBlankWorkflow(),
      undoStack: [],
      redoStack: [],
      pseudocode: "",
      code: "",
      codeLanguage: elements.codeLanguage?.value || "Python",
      runResult: ""
    };
  }

  function getActiveSession() {
    return sessions.find((s) => s.id === activeSessionId) || null;
  }

  function cloneWorkflowSnapshot() {
    return cloneWorkflow(state.workflow);
  }

  function updateHistoryButtons() {
    const cur = getActiveSession();
    const undoCount = Array.isArray(cur?.undoStack) ? cur.undoStack.length : 0;
    const redoCount = Array.isArray(cur?.redoStack) ? cur.redoStack.length : 0;
    if (elements.btnUndoWorkflow) elements.btnUndoWorkflow.disabled = undoCount === 0;
    if (elements.btnRedoWorkflow) elements.btnRedoWorkflow.disabled = redoCount === 0;
    if (elements.historyHint) {
      elements.historyHint.textContent = `后退 ${undoCount} | 前进 ${redoCount}`;
    }
  }

  function recordWorkflowCheckpoint() {
    const cur = getActiveSession();
    if (!cur) return;
    if (!Array.isArray(cur.undoStack)) cur.undoStack = [];
    if (!Array.isArray(cur.redoStack)) cur.redoStack = [];
    cur.undoStack.push(cloneWorkflowSnapshot());
    if (cur.undoStack.length > 80) cur.undoStack = cur.undoStack.slice(-80);
    cur.redoStack = [];
    updateHistoryButtons();
    persistSessions();
  }

  function applyWorkflowSnapshot(snapshot) {
    state.workflow = cloneWorkflow(snapshot || createBlankWorkflow());
    state.selectedNodeId = state.workflow.nodes[0]?.id || null;
    state.selectedEdgeId = null;
    state.pendingCenterViewport = true;
    render();
  }

  function undoWorkflowChange() {
    const cur = getActiveSession();
    if (!cur || !Array.isArray(cur.undoStack) || cur.undoStack.length === 0) return;
    if (!Array.isArray(cur.redoStack)) cur.redoStack = [];
    const previous = cur.undoStack.pop();
    cur.redoStack.push(cloneWorkflowSnapshot());
    applyWorkflowSnapshot(previous);
    persistActiveSessionNow();
    updateHistoryButtons();
    setStatus("已后退一步。");
  }

  function redoWorkflowChange() {
    const cur = getActiveSession();
    if (!cur || !Array.isArray(cur.redoStack) || cur.redoStack.length === 0) return;
    if (!Array.isArray(cur.undoStack)) cur.undoStack = [];
    const next = cur.redoStack.pop();
    cur.undoStack.push(cloneWorkflowSnapshot());
    applyWorkflowSnapshot(next);
    persistActiveSessionNow();
    updateHistoryButtons();
    setStatus("已前进一步。");
  }

  function saveCurrentSessionSnapshot() {
    const cur = sessions.find((s) => s.id === activeSessionId);
    if (!cur) return;
    cur.prompt = elements.userPrompt.value || "";
    cur.workflow = cloneWorkflow(state.workflow);
    cur.pseudocode = elements.pseudocodeText.value || "";
    cur.code = elements.codeText.value || "";
    cur.codeLanguage = elements.codeLanguage.value || "Python";
    cur.runResult = elements.runResultText.value || "";
  }

  function persistSessions() {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ activeSessionId, sessions }));
    } catch {
      /* ignore storage error */
    }
  }

  function syncSessionSelect() {
    const html = sessions
      .map((s) => `<option value="${s.id}">${s.name}</option>`)
      .join("");
    elements.sessionSelect.innerHTML = html;
    if (activeSessionId) elements.sessionSelect.value = activeSessionId;
  }

  function applySession(session) {
    state.workflow = cloneWorkflow(session.workflow);
    state.selectedNodeId = state.workflow.nodes[0]?.id || null;
    state.selectedEdgeId = null;
    state.pendingCenterViewport = true;
    elements.userPrompt.value = session.prompt || "";
    elements.pseudocodeText.value = session.pseudocode || "";
    elements.codeText.value = session.code || "";
    elements.codeLanguage.value = session.codeLanguage || "Python";
    elements.runResultText.value = session.runResult || "";
    state.pseudocode = session.pseudocode || "";
    state.code = session.code || "";
    render();
    updateHistoryButtons();
  }

  function switchSession(nextId) {
    if (!nextId || nextId === activeSessionId) return;
    saveCurrentSessionSnapshot();
    activeSessionId = nextId;
    const target = sessions.find((s) => s.id === nextId);
    if (!target) return;
    applySession(target);
    syncSessionSelect();
    persistSessions();
    setStatus(`已切换到${target.name}。`);
  }

  function persistActiveSessionNow() {
    saveCurrentSessionSnapshot();
    persistSessions();
  }

  function bootstrapSessions() {
    let loaded = null;
    try {
      loaded = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "null");
    } catch {
      loaded = null;
    }
    const loadedSessions = Array.isArray(loaded?.sessions) ? loaded.sessions : [];
    sessions = loadedSessions.length
      ? loadedSessions.map((s, idx) => ({
          id: String(s.id || uid("s_")),
          name: String(s.name || newSessionName(idx + 1)),
          prompt: String(s.prompt || ""),
          workflow: cloneWorkflow(s.workflow || createBlankWorkflow()),
          undoStack: Array.isArray(s.undoStack) ? s.undoStack.map((wf) => cloneWorkflow(wf)) : [],
          redoStack: Array.isArray(s.redoStack) ? s.redoStack.map((wf) => cloneWorkflow(wf)) : [],
          pseudocode: String(s.pseudocode || ""),
          code: String(s.code || ""),
          codeLanguage: String(s.codeLanguage || "Python"),
          runResult: String(s.runResult || "")
        }))
      : [createSessionPayload(newSessionName(1))];
    activeSessionId = String(loaded?.activeSessionId || sessions[0].id);
    if (!sessions.some((s) => s.id === activeSessionId)) activeSessionId = sessions[0].id;
    syncSessionSelect();
    applySession(sessions.find((s) => s.id === activeSessionId));
    persistSessions();
  }

  const selectPostOptimizeEl = document.getElementById("selectPostOptimize");
  const chkContextModeEl = document.getElementById("chkContextMode");
  if (selectPostOptimizeEl) {
    let savedOpt = localStorage.getItem("mwgl_post_optimize");
    if (savedOpt === null) {
      const legacy = localStorage.getItem("mwgl_post_mcts");
      savedOpt = legacy === "0" ? "none" : "mcts";
    }
    if (savedOpt === "none" || savedOpt === "beam" || savedOpt === "mcts") {
      selectPostOptimizeEl.value = savedOpt;
    }
    selectPostOptimizeEl.addEventListener("change", () => {
      localStorage.setItem("mwgl_post_optimize", selectPostOptimizeEl.value);
    });
  }
  if (chkContextModeEl) {
    const saved = localStorage.getItem("mwgl_context_mode");
    if (saved !== null) chkContextModeEl.checked = saved === "1";
    chkContextModeEl.addEventListener("change", () => {
      localStorage.setItem("mwgl_context_mode", chkContextModeEl.checked ? "1" : "0");
    });
  }

  function buildContextAwarePrompt(prompt) {
    const useContext = Boolean(chkContextModeEl?.checked);
    if (!useContext) return { effectivePrompt: prompt, usedContext: false };

    const contextWorkflow = state.workflow;
    const hasWorkflowContext = Array.isArray(contextWorkflow?.nodes) && contextWorkflow.nodes.length > 0;
    const previousPrompt = String(localStorage.getItem("mwgl_last_user_prompt") || "").trim();
    if (!hasWorkflowContext && !previousPrompt) {
      return { effectivePrompt: prompt, usedContext: false };
    }

    const contextChunks = [];
    if (previousPrompt) {
      contextChunks.push(`上一轮用户输入：\n${previousPrompt}`);
    }
    if (hasWorkflowContext) {
      contextChunks.push(
        `当前已生成工作流 JSON（请在此基础上做增量修改，不要完全重写）：\n${JSON.stringify(
          contextWorkflow,
          null,
          2
        )}`
      );
    }

    const effectivePrompt = [
      "你现在处于 MWGL 增量修改模式。",
      ...contextChunks,
      `本轮新增修改需求：\n${prompt}`,
      "请尽量复用原有节点/边与 ID，仅在必要处增删改。输出完整可校验的 MWGL JSON。"
    ].join("\n\n");

    return { effectivePrompt, usedContext: true };
  }

  function constraintErrors(workflow) {
    const result = validateWorkflowConstraints(workflow);
    return result.ok ? [] : result.errors;
  }

  function formatConstraintErrors(errors) {
    if (!errors?.length) return "";
    return errors.map((msg, idx) => `${idx + 1}. ${msg}`).join(" | ");
  }

  function guessLabelForEdge(fromId) {
    const fromNode = state.workflow.nodes.find((n) => n.id === fromId);
    if (!fromNode) return "";
    const labels = new Set(
      (state.workflow.edges || [])
        .filter((e) => e.from === fromId)
        .map((e) => String(e.label || "").trim())
        .filter(Boolean)
    );
    if (fromNode.type === "switch") {
      if (!labels.has("是")) return "是";
      if (!labels.has("否")) return "否";
      for (let i = 3; i <= 99; i += 1) {
        const opt = `条件${i}`;
        if (!labels.has(opt)) return opt;
      }
      return `条件_${uid("").slice(-4)}`;
    }
    return "";
  }

  function focusEdgeLabelInput() {
    const el = elements.edgeLabel;
    if (!el || typeof el.focus !== "function") return;
    el.focus();
    if (typeof el.select === "function") el.select();
  }

  const defaultTextForType = {
    start: "开始 新入口",
    wait_user: "等待用户 输入或确认",
    switch: "条件 新分支",
    loop_start: "循环开始 进入循环体（退出统一在 loop_end 后）",
    loop_end: "循环结束 本轮结束后的收束节点",
    parallel: "并行分支 可同时执行多个动作",
    case: "新动作",
    success: "成功 任务完成",
    failure: "任务未达成 超时未完成"
  };

  function inferFailureKindFromText(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return "goal_not_met";
    if (/结局|lose|死亡|团灭|败北/.test(t)) return "game_lose";
    if (/前置|未认证|未授权|不满足|资格/.test(t)) return "precondition_not_met";
    if (/风控|拦截|封禁|黑名单|命中规则/.test(t)) return "risk_blocked";
    return "goal_not_met";
  }

  function addNode(type) {
    recordWorkflowCheckpoint();
    if (type === "switch" || type === "loop_start" || type === "parallel") {
      const x = 120 + Math.floor(Math.random() * 220);
      const y = 120 + Math.floor(Math.random() * 260);
      const br = {
        id: uid(),
        type,
        text: defaultTextForType[type]
      };
      Object.assign(br, { x, y });
      const c1 = { id: uid(), type: "case", text: "新动作", x: x + 280, y: y - 48 };
      state.workflow.nodes.push(br, c1);
      state.workflow.edges = state.workflow.edges || [];
      if (type === "switch" || type === "parallel") {
        const c2 = { id: uid(), type: "case", text: "新动作", x: x + 280, y: y + 48 };
        state.workflow.nodes.push(c2);
        const l1 = type === "switch" ? "是" : "";
        const l2 = type === "switch" ? "否" : "";
        state.workflow.edges.push(
          { id: uid("e"), from: br.id, to: c1.id, label: l1 },
          { id: uid("e"), from: br.id, to: c2.id, label: l2 }
        );
      } else {
        state.workflow.edges.push({ id: uid("e"), from: br.id, to: c1.id, label: "" });
      }
      state.selectedNodeId = br.id;
      state.selectedEdgeId = null;
      layoutWorkflowLeftToRight(state.workflow);
      state.pendingCenterViewport = true;
      render();
      persistActiveSessionNow();
      return;
    }
    const node = {
      id: uid(),
      type,
      text: defaultTextForType[type] || "新节点",
      x: Math.round(-120 + Math.random() * 240),
      y: Math.round(-100 + Math.random() * 200)
    };
    if (type === "failure") {
      node.failure_kind = inferFailureKindFromText(node.text);
    }
    state.workflow.nodes.push(node);
    state.selectedNodeId = node.id;
    state.selectedEdgeId = null;
    state.workflow.edges = state.workflow.edges || [];
    render();
    persistActiveSessionNow();
  }

  function saveEditorToNode() {
    const node = getSelectedNode();
    if (!node) return;
    recordWorkflowCheckpoint();
    const nextType = elements.nodeType.value;
    node.type = nextType;
    node.text = elements.nodeText.value.trim() || "未命名节点";
    if (nextType === "failure") {
      node.failure_kind = inferFailureKindFromText(node.text);
    } else if (Object.prototype.hasOwnProperty.call(node, "failure_kind")) {
      delete node.failure_kind;
    }
    node.x = Number(elements.nodeX.value || 0);
    node.y = Number(elements.nodeY.value || 0);
    render();
    persistActiveSessionNow();
  }

  function deleteNodeById(nodeId) {
    if (!nodeId) return false;
    const before = state.workflow.nodes.length;
    recordWorkflowCheckpoint();
    const removedId = nodeId;
    state.workflow.nodes = state.workflow.nodes.filter((n) => n.id !== nodeId);
    state.workflow.edges = (state.workflow.edges || []).filter((e) => e.from !== removedId && e.to !== removedId);
    if (state.workflow.nodes.length === before) return false;
    state.selectedNodeId = state.workflow.nodes[0] ? state.workflow.nodes[0].id : null;
    state.selectedEdgeId = null;
    render();
    persistActiveSessionNow();
    return true;
  }

  function deleteSelectedNode() {
    if (!state.selectedNodeId) return;
    deleteNodeById(state.selectedNodeId);
  }

  function saveEdge() {
    const from = elements.edgeFrom.value;
    const to = elements.edgeTo.value;
    let label = elements.edgeLabel.value.trim();
    const selectedEdgeId = elements.edgeSelect.value;
    if (!from || !to) return setStatus("请先选择连线起点和终点。", true);
    if (from === to) return setStatus("连线起点和终点不能相同。", true);
    state.workflow.edges = state.workflow.edges || [];

    const fromNodeForLabel = state.workflow.nodes.find((n) => n.id === from);
    if (!label && fromNodeForLabel?.type === "switch") {
      label = guessLabelForEdge(from);
      elements.edgeLabel.value = label;
    }
    const edgeError = validateEdgeAtEditTime({
      from,
      to,
      label,
      editingEdgeId: selectedEdgeId || null
    });
    if (edgeError) return setStatus(edgeError, true);

    if (selectedEdgeId) {
      const edge = state.workflow.edges.find((e) => e.id === selectedEdgeId);
      if (!edge) return setStatus("未找到要更新的连线。", true);
      recordWorkflowCheckpoint();
      edge.from = from;
      edge.to = to;
      edge.label = label;
      state.selectedEdgeId = edge.id;
      elements.edgeSelect.value = edge.id;
      render();
      persistActiveSessionNow();
      setStatus("连线已更新。");
      return;
    }

    const exists = state.workflow.edges.some((e) => e.from === from && e.to === to && e.label === label);
    if (exists) return setStatus("该连线已存在。", true);
    recordWorkflowCheckpoint();
    state.workflow.edges.push({ id: uid("e"), from, to, label });
    const createdEdge = state.workflow.edges[state.workflow.edges.length - 1];
    state.selectedEdgeId = createdEdge.id;
    elements.edgeSelect.value = createdEdge.id;
    render();
    persistActiveSessionNow();
    if (fromNodeForLabel?.type === "switch" && label) {
      setTimeout(() => focusEdgeLabelInput(), 0);
    }
    setStatus("连线已新增。");
  }

  function deleteEdge() {
    const selectedEdgeId = state.selectedEdgeId || elements.edgeSelect.value;
    if (!selectedEdgeId) return setStatus("请先选择要删除的连线。", true);
    const before = (state.workflow.edges || []).length;
    recordWorkflowCheckpoint();
    const kept = (state.workflow.edges || []).filter((e) => e.id !== selectedEdgeId);
    state.workflow.edges = kept;
    if (state.workflow.edges.length === before) return setStatus("未找到要删除的连线。", true);
    state.selectedEdgeId = null;
    elements.edgeSelect.value = "";
    elements.edgeLabel.value = "";
    render();
    persistActiveSessionNow();
    setStatus("连线已删除。");
  }

  function validateEdgeAtEditTime({ from, to, label, editingEdgeId = null }) {
    const nodes = state.workflow.nodes || [];
    const edges = state.workflow.edges || [];

    if (!from || !to) return "请先选择连线起点和终点。";
    if (from === to) return "连线起点和终点不能相同。";
    if (!nodes.some((n) => n.id === from)) return "未找到连线起点节点。";
    if (!nodes.some((n) => n.id === to)) return "未找到连线终点节点。";

    const nextEdges = editingEdgeId
      ? edges.map((e) => (e.id === editingEdgeId ? { ...e, from, to, label } : e))
      : [...edges, { id: "__new__", from, to, label }];
    const cycleBaseEdges = editingEdgeId ? edges.filter((e) => e.id !== editingEdgeId) : edges;
    if (wouldEdgeCreateCycle(cycleBaseEdges, from, to)) {
      return "该连线不允许：会形成有向环（必须保持 DAG）。";
    }

    return "";
  }

  function bindEdgeEvents() {
    elements.edgeSelect.addEventListener("change", () => {
      const selectedEdgeId = elements.edgeSelect.value;
      state.selectedEdgeId = selectedEdgeId || null;
      const edge = (state.workflow.edges || []).find((e) => e.id === selectedEdgeId);
      if (!edge) {
        elements.edgeLabel.value = "";
        render();
        return;
      }
      elements.edgeFrom.value = edge.from;
      elements.edgeTo.value = edge.to;
      elements.edgeLabel.value = edge.label || "";
      render();
    });
  }

  async function callDeepSeekAndBuildWorkflow() {
    const prompt = elements.userPrompt.value.trim();
    const base = elements.apiBase.value.trim().replace(/\/$/, "");

    if (!prompt) return setStatus("请先输入业务描述。", true);
    const { effectivePrompt, usedContext } = buildContextAwarePrompt(prompt);

    localStorage.setItem("mwgl_api_base", base);
    setStatus(usedContext ? "正在调用 DeepSeek（上下文增量模式）..." : "正在调用 DeepSeek...");

    try {
      let workflow = await buildWorkflowByDeepSeek({ base, prompt: effectivePrompt });

      const postOpt = selectPostOptimizeEl?.value || "none";
      let optFail = "";
      let optDone = false;
      let optTail = "";
      if (postOpt === "beam" || postOpt === "mcts") {
        const label = postOpt === "beam" ? "束搜索" : "MCTS";
        setStatus(`DeepSeek 已完成，正在进行 ${label} 优化（可能需十余秒）...`);
        try {
          const evalDataset = await fetchEvalDataset({ base });
          workflow = await optimizeWorkflow({
            base,
            workflow,
            prompt,
            evalDataset,
            algorithm: postOpt,
            iterations: 12
          });
          optDone = true;
          optTail = `（已做 ${label} 优化）`;
        } catch (optErr) {
          optFail = ` ${label} 优化失败（已保留 DeepSeek 结果）：${optErr.message}`;
        }
      }

      recordWorkflowCheckpoint();
      state.workflow = workflow;
      localStorage.setItem("mwgl_last_user_prompt", prompt);
      state.selectedNodeId = state.workflow.nodes[0]?.id || null;
      state.selectedEdgeId = null;
      state.pendingCenterViewport = true;
      render();
      persistActiveSessionNow();
      const errs = constraintErrors(workflow);
      const tail = optDone ? optTail : "";
      const msg =
        errs.length
          ? `已生成并渲染${tail}（草稿态，最终导出前请修复）：${formatConstraintErrors(errs)}`
          : `已生成 MWGL 并渲染到画布${tail}。`;
      setStatus(optFail ? `${msg}${optFail}` : msg, Boolean(optFail));
    } catch (error) {
      setStatus(`生成失败：${error.message}`, true);
    }
  }

  async function callDeepSeekForPseudocode() {
    const base = elements.apiBase.value.trim().replace(/\/$/, "");
    const workflow = state.workflow;

    if (!workflow || !workflow.nodes || !workflow.nodes.length) {
      return setStatus("当前没有可转换的工作流。", true);
    }

    localStorage.setItem("mwgl_api_base", base);
    setStatus("正在调用 DeepSeek 生成伪代码...");

    try {
      const pseudocode = await dagToPseudocode({ base, workflow });
      state.pseudocode = pseudocode;
      elements.pseudocodeText.value = pseudocode;
      persistActiveSessionNow();
      setStatus("已生成伪代码。");
    } catch (error) {
      setStatus(`伪代码生成失败：${error.message}`, true);
    }
  }

  async function callDeepSeekForCode() {
    const base = elements.apiBase.value.trim().replace(/\/$/, "");
    const pseudocode = elements.pseudocodeText.value.trim();
    const language = elements.codeLanguage.value;

    if (!pseudocode) {
      return setStatus("请先生成或输入伪代码。", true);
    }

    localStorage.setItem("mwgl_api_base", base);
    setStatus(`正在调用 DeepSeek 生成 ${language} 代码...`);

    try {
      const code = await pseudoToCode({ base, pseudocode, language });
      state.code = code;
      elements.codeText.value = code;
      persistActiveSessionNow();
      setStatus(`已生成 ${language} 代码。`);
    } catch (error) {
      setStatus(`代码生成失败：${error.message}`, true);
    }
  }

  async function runQuickCheck() {
    const base = elements.apiBase.value.trim().replace(/\/$/, "");
    const code = elements.codeText.value.trim();
    const language = elements.codeLanguage.value;
    if (!code) {
      return setStatus("请先生成或输入代码。", true);
    }
    setStatus(`正在运行 ${language} 快速自检...`);
    try {
      const result = await runCodeQuickCheck({ base, code, language });
      const output = [
        `language: ${result.language}`,
        `exitCode: ${result.exitCode}`,
        "",
        "stdout:",
        String(result.stdout || "").trim() || "(empty)",
        "",
        "stderr:",
        String(result.stderr || "").trim() || "(empty)"
      ].join("\n");
      elements.runResultText.value = output;
      saveCurrentSessionSnapshot();
      persistSessions();
      setStatus(result.exitCode === 0 ? "快速自检完成（退出码 0）。" : "快速自检完成（存在报错）。", result.exitCode !== 0);
    } catch (error) {
      setStatus(`快速自检失败：${error.message}`, true);
    }
  }

  function bindCanvasEvents() {
    function syncEdgeSelectionToEditor(edgeId) {
      const edge = (state.workflow.edges || []).find((e) => e.id === edgeId);
      if (!edge) return;
      state.selectedEdgeId = edgeId;
      elements.edgeSelect.value = edgeId;
      elements.edgeFrom.value = edge.from;
      elements.edgeTo.value = edge.to;
      elements.edgeLabel.value = edge.label || "";
    }

    function isTypingTarget(target) {
      if (!target) return false;
      const el = target instanceof Element ? target : null;
      if (!el) return false;
      return !!el.closest("input, textarea, select, [contenteditable='true']");
    }

    function getCanvasPoint(event) {
      const rect = elements.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      return screenToUser(px, py, state.canvasOffset || { x: 0, y: 0 }, state.canvasScale);
    }

    function getCanvasWorldPoint(event) {
      const user = getCanvasPoint(event);
      return {
        x: WORLD_WIDTH / 2 + user.x + NODE_LAYOUT_WIDTH / 2,
        y: WORLD_HEIGHT / 2 + user.y + NODE_LAYOUT_HEIGHT / 2
      };
    }

    function getNodeCenterById(id) {
      const node = state.workflow.nodes.find((n) => n.id === id);
      if (!node) return null;
      return {
        x: WORLD_WIDTH / 2 + node.x + NODE_LAYOUT_WIDTH / 2,
        y: WORLD_HEIGHT / 2 + node.y + NODE_LAYOUT_HEIGHT / 2
      };
    }

    function upsertPreviewPath(fromId, x, y) {
      const layer = elements.canvasWorld.querySelector(".edge-layer");
      if (!layer) return;
      const start = getNodeCenterById(fromId);
      if (!start) return;
      let preview = layer.querySelector(".edge-preview");
      if (!preview) {
        preview = document.createElementNS(SVG_NS, "path");
        preview.setAttribute("class", "edge-preview");
        layer.appendChild(preview);
      }
      const midX = Math.round((start.x + x) / 2);
      const d = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${y}, ${x} ${y}`;
      preview.setAttribute("d", d);
    }

    function clearPreviewPath() {
      const layer = elements.canvasWorld.querySelector(".edge-layer");
      const preview = layer ? layer.querySelector(".edge-preview") : null;
      if (preview) preview.remove();
    }

    elements.canvasWorld.addEventListener("pointerdown", (event) => {
      elements.canvas.focus();
      const deleteBtn = event.target.closest(".node-delete");
      if (deleteBtn) {
        const nodeElForDelete = deleteBtn.closest(".node");
        const nodeId = nodeElForDelete?.dataset?.id || "";
        if (deleteNodeById(nodeId)) {
          setStatus("节点已删除。");
        } else {
          setStatus("未找到要删除的节点。", true);
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const edgeEl = event.target.closest(".edge-hit");
      if (edgeEl?.dataset?.edgeId) {
        state.selectedNodeId = null;
        syncEdgeSelectionToEditor(edgeEl.dataset.edgeId);
        render();
        setStatus("已选中连线。按 Delete/Backspace 或点「删除连线」可删除。");
        event.preventDefault();
        return;
      }
      const nodeEl = event.target.closest(".node");
      if (!nodeEl) {
        state.selectedEdgeId = null;
        elements.edgeSelect.value = "";
        state.pendingCenterViewport = false;
        panning = {
          startX: event.clientX,
          startY: event.clientY,
          offsetX: state.canvasOffset?.x || 0,
          offsetY: state.canvasOffset?.y || 0
        };
        event.preventDefault();
        return;
      }
      const id = nodeEl.dataset.id;
      const node = state.workflow.nodes.find((n) => n.id === id);
      if (!node) return;
      const point = getCanvasPoint(event);

      if (event.shiftKey) {
        linking = { fromId: id };
        const wp = getCanvasWorldPoint(event);
        upsertPreviewPath(id, wp.x, wp.y);
        return;
      }

      state.selectedNodeId = id;
      state.selectedEdgeId = null;
      elements.edgeSelect.value = "";
      syncEditor();
      state.drag = {
        id,
        originX: node.x,
        originY: node.y,
        originWorkflow: cloneWorkflowSnapshot(),
        offsetX: point.x - node.x,
        offsetY: point.y - node.y
      };
      nodeEl.classList.add("dragging");
      render();
    });

    window.addEventListener("pointermove", (event) => {
      if (panning) {
        const dx = event.clientX - panning.startX;
        const dy = event.clientY - panning.startY;
        state.canvasOffset = {
          x: panning.offsetX + dx,
          y: panning.offsetY + dy
        };
        applyViewportTransform();
        return;
      }
      if (linking) {
        const wp = getCanvasWorldPoint(event);
        upsertPreviewPath(linking.fromId, wp.x, wp.y);
        return;
      }
      if (!state.drag) return;
      const node = state.workflow.nodes.find((n) => n.id === state.drag.id);
      if (!node) return;
      const point = getCanvasPoint(event);
      node.x = Math.round(point.x - state.drag.offsetX);
      node.y = Math.round(point.y - state.drag.offsetY);
      render();
    });

    window.addEventListener("pointerup", (event) => {
      if (panning) {
        panning = null;
      }
      if (linking) {
        const targetEl = event.target.closest ? event.target.closest(".node") : null;
        if (targetEl) {
          const toId = targetEl.dataset.id;
          const fromId = linking.fromId;
          if (fromId !== toId) {
            const label = guessLabelForEdge(fromId);
            const edgeError = validateEdgeAtEditTime({
              from: fromId,
              to: toId,
              label,
              editingEdgeId: null
            });
            if (edgeError) {
              setStatus(edgeError, true);
              clearPreviewPath();
              linking = null;
              return;
            }
            const exists = (state.workflow.edges || []).some((e) => e.from === fromId && e.to === toId);
            if (!exists) {
              state.workflow.edges = state.workflow.edges || [];
              recordWorkflowCheckpoint();
              const edge = { id: uid("e"), from: fromId, to: toId, label };
              state.workflow.edges.push(edge);
              elements.edgeFrom.value = fromId;
              elements.edgeTo.value = toId;
              elements.edgeLabel.value = label;
              state.selectedEdgeId = edge.id;
              elements.edgeSelect.value = edge.id;
              render();
              persistActiveSessionNow();
              setTimeout(() => focusEdgeLabelInput(), 0);
              setStatus("已通过拖线创建连线。");
            } else {
              setStatus("该连线已存在。", true);
            }
          }
        }
        clearPreviewPath();
        linking = null;
      }

      const dragState = state.drag;
      state.drag = null;
      const dragging = document.querySelector(".node.dragging");
      if (dragging) dragging.classList.remove("dragging");
      if (dragState) {
        const movedNode = state.workflow.nodes.find((n) => n.id === dragState.id);
        const moved = movedNode && (movedNode.x !== dragState.originX || movedNode.y !== dragState.originY);
        if (moved) {
          const cur = getActiveSession();
          if (cur) {
            if (!Array.isArray(cur.undoStack)) cur.undoStack = [];
            cur.undoStack.push(cloneWorkflow(dragState.originWorkflow));
            if (cur.undoStack.length > 80) cur.undoStack = cur.undoStack.slice(-80);
            cur.redoStack = [];
            updateHistoryButtons();
          }
        }
      }
      if (!linking) persistActiveSessionNow();
    });

    elements.canvasWorld.addEventListener("click", (event) => {
      if (event.target.closest(".node-delete")) return;
      const nodeEl = event.target.closest(".node");
      if (!nodeEl) return;
      state.selectedEdgeId = null;
      elements.edgeSelect.value = "";
      state.selectedNodeId = nodeEl.dataset.id;
      render();
    });

    window.addEventListener("keydown", (event) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const ctrlOrCmd = isMac ? event.metaKey : event.ctrlKey;
      if (ctrlOrCmd && !isTypingTarget(event.target) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoWorkflowChange();
        else undoWorkflowChange();
        return;
      }
      if (ctrlOrCmd && !isTypingTarget(event.target) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoWorkflowChange();
        return;
      }
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isTypingTarget(event.target)) return;
      if (!state.selectedEdgeId) return;
      event.preventDefault();
      deleteEdge();
    });

    elements.canvas.addEventListener("wheel", (event) => {
      if (!event.ctrlKey) return;
      if (document.activeElement !== elements.canvas) return;
      event.preventDefault();

      const oldScale = state.canvasScale || 1;
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * (event.deltaY < 0 ? 1.08 : 0.92)));
      if (nextScale === oldScale) return;

      state.pendingCenterViewport = false;
      const rect = elements.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const offset = state.canvasOffset || { x: 0, y: 0 };
      const ratio = nextScale / oldScale;

      state.canvasOffset = {
        x: Math.round(px - (px - offset.x) * ratio),
        y: Math.round(py - (py - offset.y) * ratio)
      };
      state.canvasScale = nextScale;
      applyViewportTransform();
    }, { passive: false });
  }

  function bindActions() {
    document.getElementById("btnGenerate").addEventListener("click", callDeepSeekAndBuildWorkflow);
    document.getElementById("btnParseMwgl").addEventListener("click", () => {
      try {
        const workflow = mwglToWorkflow(elements.mwglText.value);
        recordWorkflowCheckpoint();
        state.workflow = workflow;
        state.selectedNodeId = state.workflow.nodes[0]?.id || null;
        state.selectedEdgeId = null;
        state.pendingCenterViewport = true;
        render();
        const errs = constraintErrors(workflow);
        setStatus(
          errs.length
            ? `已导入（草稿态，最终导出前请修复）：${formatConstraintErrors(errs)}`
            : "已从 MWGL 文本导入。"
        );
      } catch (error) {
        setStatus(`MWGL 导入失败：${error.message}`, true);
      }
    });

    document.getElementById("btnExportMwgl").addEventListener("click", async () => {
      const errs = constraintErrors(state.workflow);
      if (errs.length) return setStatus(`当前工作流未通过约束校验：${formatConstraintErrors(errs)}`, true);
      const text = workflowToMwgl(state.workflow);
      elements.mwglText.value = text;
      await navigator.clipboard.writeText(text).catch(() => {});
      setStatus("已导出 MWGL（并尝试复制到剪贴板）。");
    });

    document.getElementById("btnPseudocode").addEventListener("click", callDeepSeekForPseudocode);

    document.getElementById("btnGenCode").addEventListener("click", callDeepSeekForCode);
    document.getElementById("btnRunCode").addEventListener("click", runQuickCheck);
    if (elements.btnUndoWorkflow) {
      elements.btnUndoWorkflow.addEventListener("click", undoWorkflowChange);
    }
    if (elements.btnRedoWorkflow) {
      elements.btnRedoWorkflow.addEventListener("click", redoWorkflowChange);
    }

    elements.sessionSelect.addEventListener("change", () => {
      switchSession(elements.sessionSelect.value);
    });
    elements.btnNewSession.addEventListener("click", () => {
      saveCurrentSessionSnapshot();
      const next = createSessionPayload(newSessionName(sessions.length + 1));
      sessions.push(next);
      activeSessionId = next.id;
      syncSessionSelect();
      applySession(next);
      persistSessions();
      updateHistoryButtons();
      setStatus(`已新建${next.name}。`);
    });
    elements.btnDeleteSession.addEventListener("click", () => {
      if (sessions.length <= 1) return setStatus("至少保留一个会话窗口。", true);
      const deleting = sessions.find((s) => s.id === activeSessionId);
      sessions = sessions.filter((s) => s.id !== activeSessionId);
      activeSessionId = sessions[0].id;
      syncSessionSelect();
      applySession(sessions[0]);
      persistSessions();
      updateHistoryButtons();
      setStatus(`已删除${deleting?.name || "当前窗口"}。`);
    });

    elements.userPrompt.addEventListener("input", () => {
      saveCurrentSessionSnapshot();
      persistSessions();
    });
    elements.pseudocodeText.addEventListener("input", () => {
      saveCurrentSessionSnapshot();
      persistSessions();
    });
    elements.codeText.addEventListener("input", () => {
      saveCurrentSessionSnapshot();
      persistSessions();
    });
    elements.codeLanguage.addEventListener("change", () => {
      saveCurrentSessionSnapshot();
      persistSessions();
    });

    document.getElementById("btnExportJson").addEventListener("click", async () => {
      const errs = constraintErrors(state.workflow);
      if (errs.length) return setStatus(`当前工作流未通过约束校验：${formatConstraintErrors(errs)}`, true);
      const text = JSON.stringify(state.workflow, null, 2);
      await navigator.clipboard.writeText(text).catch(() => {});
      setStatus("已导出 JSON（并尝试复制到剪贴板）。");
    });

    document.getElementById("addEvent").addEventListener("click", () => addNode("start"));
    document.getElementById("addWaitUser").addEventListener("click", () => addNode("wait_user"));
    document.getElementById("addSwitch").addEventListener("click", () => addNode("switch"));
    document.getElementById("addLoopStart").addEventListener("click", () => addNode("loop_start"));
    document.getElementById("addLoopEnd").addEventListener("click", () => addNode("loop_end"));
    document.getElementById("addParallel").addEventListener("click", () => addNode("parallel"));
    document.getElementById("addCase").addEventListener("click", () => addNode("case"));
    document.getElementById("addSuccess").addEventListener("click", () => addNode("success"));
    document.getElementById("addFailure").addEventListener("click", () => addNode("failure"));
    document.getElementById("btnLayoutLr").addEventListener("click", () => {
      recordWorkflowCheckpoint();
      layoutWorkflowLeftToRight(state.workflow);
      state.pendingCenterViewport = true;
      render();
      setStatus("已按执行顺序从左到右排列。");
    });

    document.getElementById("saveNode").addEventListener("click", () => {
      saveEditorToNode();
      setStatus("节点已更新。");
    });

    document.getElementById("deleteNode").addEventListener("click", () => {
      deleteSelectedNode();
      setStatus("节点已删除。");
    });

    document.getElementById("saveEdge").addEventListener("click", saveEdge);
    document.getElementById("deleteEdge").addEventListener("click", deleteEdge);
  }

  bootstrapSessions();
  updateHistoryButtons();
  bindActions();
  bindCanvasEvents();
  bindEdgeEvents();
}
