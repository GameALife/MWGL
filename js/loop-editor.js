import { uid } from "./ids.js";
import {
  createEmptyLoop,
  createLoopStepItem,
  createEmptySubworkflow,
  resolveLoopContext
} from "./mwgl-loop.js";

/**
 * 循环体 / 子工作流侧栏编辑器（主图仍为 DAG，循环体在 node.loop.steps 树内）。
 */
export function createLoopEditor({ elements, state, onChange, setStatus }) {
  let mode = "loop"; // loop | subflow
  let nodeId = null;
  let path = [];
  let subflowRef = null;

  const panel = elements.loopPanel;
  const titleEl = elements.loopPanelTitle;
  const breadcrumbEl = elements.loopPanelBreadcrumb;
  const listEl = elements.loopLoopStepList;
  const conditionEl = elements.loopCondition;
  const kindEl = elements.loopKind;

  function hide() {
    panel?.classList.add("hidden");
    nodeId = null;
    path = [];
    subflowRef = null;
    mode = "loop";
  }

  function show() {
    panel?.classList.remove("hidden");
  }

  function getHostNode() {
    return state.workflow.nodes.find((n) => n.id === nodeId) || null;
  }

  function getCurrentLoop() {
    const node = getHostNode();
    if (!node?.loop) return null;
    return resolveLoopContext(node.loop, path);
  }

  function breadcrumbText() {
    if (mode === "subflow") return `子工作流 · ${subflowRef}`;
    const parts = ["主图循环"];
    path.forEach((idx, depth) => {
      parts.push(`嵌套#${idx + 1}`);
    });
    return parts.join(" › ");
  }

  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = "";

    if (mode === "subflow") {
      const sub = state.workflow.subworkflows?.[subflowRef];
      titleEl.textContent = "子工作流（DAG）";
      breadcrumbEl.textContent = breadcrumbText();
      if (conditionEl) conditionEl.closest(".loop-field")?.classList.add("hidden");
      if (kindEl) kindEl.closest(".loop-field")?.classList.add("hidden");

      const hint = document.createElement("p");
      hint.className = "loop-hint";
      hint.textContent = sub
        ? `节点 ${sub.nodes?.length || 0} 个，边 ${sub.edges?.length || 0} 条。在画布上编辑子图；此处可返回循环体。`
        : "子工作流不存在。";
      listEl.appendChild(hint);
      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.textContent = "返回循环体编辑";
      backBtn.addEventListener("click", () => {
        mode = "loop";
        renderList();
      });
      listEl.appendChild(backBtn);
      return;
    }

    titleEl.textContent = "循环体 loop.steps";
    breadcrumbEl.textContent = breadcrumbText();
    conditionEl?.closest(".loop-field")?.classList.remove("hidden");
    kindEl?.closest(".loop-field")?.classList.remove("hidden");

    const loop = getCurrentLoop();
    if (!loop) {
      listEl.innerHTML = "<p class='loop-hint'>无法解析循环上下文。</p>";
      return;
    }
    if (conditionEl) conditionEl.value = loop.condition || "";
    if (kindEl) kindEl.value = loop.kind === "while" ? "while" : "for";

    const steps = loop.steps || [];
    if (!steps.length) {
      const empty = document.createElement("p");
      empty.className = "loop-hint";
      empty.textContent = "暂无步骤，请下方添加。";
      listEl.appendChild(empty);
    }

    steps.forEach((step, index) => {
      const row = document.createElement("div");
      row.className = "loop-step-row";
      const head = document.createElement("div");
      head.className = "loop-step-head";
      const badge = document.createElement("span");
      badge.className = `loop-badge loop-badge-${step.type}`;
      badge.textContent = step.type;
      const text = document.createElement("span");
      text.className = "loop-step-text";
      if (step.type === "step") text.textContent = step.text || "";
      else if (step.type === "loop") {
        text.textContent = `${step.text || "嵌套循环"} (${step.loop?.steps?.length || 0} 步)`;
      } else if (step.type === "branch") {
        text.textContent = `${step.text || "分支"} (${step.arms?.length || 0} 臂)`;
      } else if (step.type === "subflow") {
        text.textContent = `${step.text || step.ref} → 子工作流`;
      }
      head.append(badge, text);

      const actions = document.createElement("div");
      actions.className = "loop-step-actions";
      if (step.type === "loop") {
        const drill = document.createElement("button");
        drill.type = "button";
        drill.textContent = "进入";
        drill.addEventListener("click", () => {
          path = [...path, index];
          renderList();
        });
        actions.appendChild(drill);
      }
      if (step.type === "subflow") {
        const openSub = document.createElement("button");
        openSub.type = "button";
        openSub.textContent = "编辑子图";
        openSub.addEventListener("click", () => {
          mode = "subflow";
          subflowRef = step.ref;
          renderList();
        });
        actions.appendChild(openSub);
      }
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn-danger";
      del.textContent = "删";
      del.addEventListener("click", () => {
        loop.steps.splice(index, 1);
        onChange();
        renderList();
      });
      actions.appendChild(del);

      row.append(head, actions);
      listEl.appendChild(row);
    });

    if (path.length > 0) {
      const up = document.createElement("button");
      up.type = "button";
      up.textContent = "↑ 返回上层循环";
      up.addEventListener("click", () => {
        path = path.slice(0, -1);
        renderList();
      });
      listEl.appendChild(up);
    }
  }

  function saveLoopMeta() {
    const loop = getCurrentLoop();
    if (!loop) return;
    loop.condition = conditionEl?.value?.trim() || "";
    loop.kind = kindEl?.value === "while" ? "while" : "for";
    onChange();
  }

  function addStep(type) {
    const node = getHostNode();
    if (!node?.loop) return;
    const loop = getCurrentLoop();
    if (!loop) return;

    if (type === "subflow") {
      if (!state.workflow.subworkflows) state.workflow.subworkflows = {};
      const ref = uid("R_sub_");
      state.workflow.subworkflows[ref] = createEmptySubworkflow("子工作流");
      loop.steps.push(
        createLoopStepItem("subflow", { ref, text: state.workflow.subworkflows[ref].rule_name })
      );
    } else {
      loop.steps.push(createLoopStepItem(type));
    }
    onChange();
    renderList();
  }

  function bindToolbar() {
    elements.loopAddStep?.addEventListener("click", () => addStep("step"));
    elements.loopAddFor?.addEventListener("click", () => addStep("loop"));
    elements.loopAddSubflow?.addEventListener("click", () => addStep("subflow"));
    elements.loopSaveMeta?.addEventListener("click", () => {
      saveLoopMeta();
      setStatus?.("已保存循环条件。");
    });
    elements.loopPanelClose?.addEventListener("click", hide);
    conditionEl?.addEventListener("change", saveLoopMeta);
    kindEl?.addEventListener("change", saveLoopMeta);
  }

  bindToolbar();

  return {
    openForNode(id) {
      const node = state.workflow.nodes.find((n) => n.id === id);
      if (!node) return false;
      if (!node.loop) return false;
      nodeId = id;
      path = [];
      mode = "loop";
      subflowRef = null;
      show();
      renderList();
      return true;
    },
    close: hide,
    isOpen() {
      return Boolean(nodeId) && !panel?.classList.contains("hidden");
    },
    refresh: renderList
  };
}
