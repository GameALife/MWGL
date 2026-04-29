#!/usr/bin/env node
/**
 * 合成 MWGL v2 **评测集**（与 `validate-eval-dataset.js`、`run-optimize.js` / MCTS 所用 JSONL 一致）。
 * 不写任何 SFT / Alpaca 产物。
 *
 * 用法：
 *   node scripts/synthesize-dataset.js
 *   node scripts/synthesize-dataset.js --eval-out data/synthetic_eval.jsonl
 */

import fs from "fs";
import path from "path";
import { uid } from "../js/ids.js";
import { normalizeWorkflow, validateWorkflowConstraints } from "../js/mwgl.js";

function parseArgs(argv) {
  const out = {
    evalOut: "data/synthetic_eval.jsonl",
    append: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--eval-out") out.evalOut = argv[++i] || out.evalOut;
    else if (a === "--append") out.append = true;
  }
  return out;
}

function assertValid(wf, tag) {
  const n = normalizeWorkflow(wf);
  const v = validateWorkflowConstraints(n);
  if (!v.ok) {
    console.error(`[${tag}] validation failed:`, v.errors);
    process.exit(1);
  }
  return n;
}

/** @returns {{ workflow: object, user_text: string, eval: { final_state: string, must_have_path_labels: string[] } }}} */
function templateSwitchPaidOrFail() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "下单支付分支",
    nodes: [
      { id: "n_start", type: "start", text: "开始 用户提交订单", x: 80, y: 180 },
      { id: "n_sw_pay", type: "switch", text: "判断支付状态", x: 360, y: 180 },
      { id: "n_case_ship", type: "case", text: "校验库存并发货", x: 640, y: 120 },
      { id: "n_ok", type: "success", text: "订单完成", x: 920, y: 120 },
      { id: "n_fail", type: "failure", text: "订单失败", x: 920, y: 260 }
    ],
    edges: [
      { id: "e_st_sw", from: "n_start", to: "n_sw_pay", label: "" },
      { id: "e_paid", from: "n_sw_pay", to: "n_case_ship", label: "已支付" },
      { id: "e_unpaid", from: "n_sw_pay", to: "n_fail", label: "支付失败" },
      { id: "e_ship_ok", from: "n_case_ship", to: "n_ok", label: "库存充足" }
    ]
  };
  return {
    workflow: assertValid(raw, "switchPaidOrFail"),
    user_text: "用户下单后若已支付则校验库存并发货成功；支付失败则订单失败。成功路径需体现已支付与库存充足。",
    eval: {
      final_state: "success",
      must_have_path_labels: ["已支付", "库存充足"]
    }
  };
}

function templateParallelMerge() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "并行扣库存与发券",
    nodes: [
      { id: "n_start", type: "start", text: "开始 订单已创建", x: 80, y: 240 },
      { id: "n_par", type: "parallel", text: "并行执行后续动作", x: 360, y: 240 },
      { id: "n_stock", type: "case", text: "扣减库存", x: 640, y: 140 },
      { id: "n_coupon", type: "case", text: "发放优惠券", x: 640, y: 340 },
      { id: "n_join", type: "case", text: "汇总并行结果", x: 920, y: 240 },
      { id: "n_ok", type: "success", text: "流程成功", x: 1180, y: 240 }
    ],
    edges: [
      { id: "e1", from: "n_start", to: "n_par", label: "" },
      { id: "e_pa", from: "n_par", to: "n_stock", label: "并行分支A" },
      { id: "e_pb", from: "n_par", to: "n_coupon", label: "并行分支B" },
      { id: "e_sa", from: "n_stock", to: "n_join", label: "" },
      { id: "e_sb", from: "n_coupon", to: "n_join", label: "" },
      { id: "e_j", from: "n_join", to: "n_ok", label: "" }
    ]
  };
  return {
    workflow: assertValid(raw, "parallelMerge"),
    user_text: "订单创建后并行扣库存与发放优惠券，两支完成后汇总并成功结束。",
    eval: {
      final_state: "success",
      must_have_path_labels: ["并行分支A", "并行分支B"]
    }
  };
}

function templateLoopRetry() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "仓储调用重试",
    nodes: [
      { id: "n_start", type: "start", text: "开始 调用仓储接口", x: 80, y: 200 },
      { id: "n_ls", type: "loop_start", text: "进入重试段", x: 320, y: 200 },
      { id: "n_sw", type: "switch", text: "判断是否继续重试", x: 560, y: 200 },
      { id: "n_retry_case", type: "case", text: "执行一次重试", x: 840, y: 120 },
      { id: "n_le", type: "loop_end", text: "本轮重试结束", x: 840, y: 280 },
      { id: "n_ok", type: "success", text: "调用成功", x: 1120, y: 160 },
      { id: "n_fail", type: "failure", text: "达到重试上限", x: 1120, y: 280 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_ls", label: "" },
      { id: "e_ls", from: "n_ls", to: "n_sw", label: "" },
      { id: "e_a", from: "n_sw", to: "n_retry_case", label: "重试中" },
      { id: "e_b", from: "n_sw", to: "n_ok", label: "退出循环" },
      { id: "e_c", from: "n_retry_case", to: "n_le", label: "" },
      { id: "e_d", from: "n_le", to: "n_fail", label: "重试上限" }
    ]
  };
  return {
    workflow: assertValid(raw, "loopRetry"),
    user_text: "调用仓储失败时可重试；继续重试走重试中；成功则退出循环结束；否则到达重试上限失败。",
    eval: {
      final_state: "success",
      must_have_path_labels: ["重试中", "退出循环"]
    }
  };
}

function templateAuthGate() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "登录认证门禁",
    nodes: [
      { id: "n_start", type: "start", text: "开始 访问下单页", x: 80, y: 200 },
      { id: "n_sw", type: "switch", text: "检查登录态", x: 360, y: 200 },
      { id: "n_login", type: "wait_user", text: "等待用户登录", x: 640, y: 120 },
      { id: "n_place", type: "case", text: "提交订单", x: 920, y: 200 },
      { id: "n_ok", type: "success", text: "下单成功", x: 1180, y: 160 },
      { id: "n_fail", type: "failure", text: "拒绝访问", x: 920, y: 320 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_sw", label: "" },
      { id: "e1", from: "n_sw", to: "n_place", label: "已认证" },
      { id: "e2", from: "n_sw", to: "n_login", label: "未认证" },
      { id: "e3", from: "n_login", to: "n_place", label: "登录成功" },
      { id: "e4", from: "n_place", to: "n_ok", label: "" },
      { id: "e5", from: "n_sw", to: "n_fail", label: "黑名单" }
    ]
  };
  return {
    workflow: assertValid(raw, "authGate"),
    user_text: "已认证可直接下单；未认证先等待登录成功后下单；黑名单用户拒绝访问。评测关注已认证路径。",
    eval: {
      final_state: "success",
      must_have_path_labels: ["已认证"]
    }
  };
}

function templateRiskDeny() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "风控拦截",
    nodes: [
      { id: "n_start", type: "start", text: "开始 风控扫描", x: 80, y: 180 },
      { id: "n_sw", type: "switch", text: "命中策略分支", x: 380, y: 180 },
      { id: "n_ok", type: "success", text: "放行", x: 720, y: 120 },
      { id: "n_fail", type: "failure", text: "拦截", x: 720, y: 260 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_sw", label: "" },
      { id: "e1", from: "n_sw", to: "n_fail", label: "黑名单" },
      { id: "e2", from: "n_sw", to: "n_ok", label: "正常用户" }
    ]
  };
  return {
    workflow: assertValid(raw, "riskDeny"),
    user_text: "命中黑名单则直接拦截失败；正常用户放行成功。样本用于失败路径含黑名单。",
    eval: {
      final_state: "failure",
      must_have_path_labels: ["黑名单"]
    }
  };
}

function templatePaymentTimeout() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "支付超时处理",
    nodes: [
      { id: "n_start", type: "start", text: "开始 发起支付", x: 80, y: 180 },
      { id: "n_sw", type: "switch", text: "监听支付结果", x: 380, y: 180 },
      { id: "n_ok", type: "success", text: "支付完成", x: 720, y: 120 },
      { id: "n_fail", type: "failure", text: "支付失败收尾", x: 720, y: 260 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_sw", label: "" },
      { id: "e1", from: "n_sw", to: "n_ok", label: "支付回调成功" },
      { id: "e2", from: "n_sw", to: "n_fail", label: "超时" }
    ]
  };
  return {
    workflow: assertValid(raw, "paymentTimeout"),
    user_text: "支付超时则进入失败处理并结束；回调成功则成功。评测要求失败路径含超时。",
    eval: { final_state: "failure", must_have_path_labels: ["超时"] }
  };
}

function templateInventoryShort() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "库存校验",
    nodes: [
      { id: "n_start", type: "start", text: "开始 下单", x: 80, y: 180 },
      { id: "n_sw", type: "switch", text: "检查库存", x: 380, y: 180 },
      { id: "n_ship", type: "case", text: "出库发货", x: 680, y: 120 },
      { id: "n_ok", type: "success", text: "交易成功", x: 960, y: 120 },
      { id: "n_fail", type: "failure", text: "无法履约", x: 680, y: 260 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_sw", label: "" },
      { id: "e1", from: "n_sw", to: "n_ship", label: "库存充足" },
      { id: "e2", from: "n_sw", to: "n_fail", label: "库存不足" },
      { id: "e3", from: "n_ship", to: "n_ok", label: "" }
    ]
  };
  return {
    workflow: assertValid(raw, "inventoryShort"),
    user_text: "库存不足时直接失败结束；库存充足则发货成功。",
    eval: { final_state: "failure", must_have_path_labels: ["库存不足"] }
  };
}

function templateAmountReviewPass() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "高额订单审核",
    nodes: [
      { id: "n_start", type: "start", text: "开始 提交订单", x: 80, y: 200 },
      { id: "n_sw_amt", type: "switch", text: "判断订单金额", x: 340, y: 200 },
      { id: "n_sw_audit", type: "switch", text: "风控审核结论", x: 620, y: 140 },
      { id: "n_ok", type: "success", text: "订单通过", x: 920, y: 120 },
      { id: "n_ok_quick", type: "success", text: "小额直接通过", x: 620, y: 280 },
      { id: "n_fail", type: "failure", text: "审核拒绝", x: 920, y: 260 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_sw_amt", label: "" },
      { id: "e1", from: "n_sw_amt", to: "n_sw_audit", label: "金额>1000" },
      { id: "e2", from: "n_sw_amt", to: "n_ok_quick", label: "金额正常" },
      { id: "e3", from: "n_sw_audit", to: "n_ok", label: "审核通过" },
      { id: "e4", from: "n_sw_audit", to: "n_fail", label: "审核拒绝" }
    ]
  };
  return {
    workflow: assertValid(raw, "amountReviewPass"),
    user_text: "金额大于1000需风控审核，审核通过后成功；小额可走快速成功。评测关注高额与审核通过。",
    eval: { final_state: "success", must_have_path_labels: ["金额>1000", "审核通过"] }
  };
}

function templateAmountReviewReject() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "高额订单拒绝",
    nodes: [
      { id: "n_start", type: "start", text: "开始 高额订单", x: 80, y: 200 },
      { id: "n_sw_amt", type: "switch", text: "判断订单金额", x: 340, y: 200 },
      { id: "n_sw_audit", type: "switch", text: "风控审核结论", x: 620, y: 180 },
      { id: "n_ok", type: "success", text: "订单通过", x: 920, y: 120 },
      { id: "n_fail", type: "failure", text: "审核拒绝关单", x: 920, y: 280 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_sw_amt", label: "" },
      { id: "e1", from: "n_sw_amt", to: "n_sw_audit", label: "金额>1000" },
      { id: "e2", from: "n_sw_amt", to: "n_ok", label: "金额正常" },
      { id: "e3", from: "n_sw_audit", to: "n_ok", label: "审核通过" },
      { id: "e4", from: "n_sw_audit", to: "n_fail", label: "审核拒绝" }
    ]
  };
  return {
    workflow: assertValid(raw, "amountReviewReject"),
    user_text: "高额订单风控审核拒绝则失败结束。评测含金额条件与审核拒绝。",
    eval: { final_state: "failure", must_have_path_labels: ["金额>1000", "审核拒绝"] }
  };
}

function templateCouponAbandon() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "优惠券放弃支付",
    nodes: [
      { id: "n_start", type: "start", text: "开始 结算页", x: 80, y: 200 },
      { id: "n_sw", type: "switch", text: "优惠券状态", x: 360, y: 200 },
      { id: "n_pay", type: "case", text: "发起支付", x: 640, y: 120 },
      { id: "n_wait", type: "wait_user", text: "等待用户决定", x: 640, y: 280 },
      { id: "n_sw2", type: "switch", text: "用户选择", x: 900, y: 280 },
      { id: "n_ok", type: "success", text: "支付成功", x: 1180, y: 120 },
      { id: "n_fail", type: "failure", text: "订单取消", x: 1180, y: 360 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_sw", label: "" },
      { id: "e1", from: "n_sw", to: "n_pay", label: "优惠券有效" },
      { id: "e2", from: "n_sw", to: "n_wait", label: "优惠券失效" },
      { id: "e3", from: "n_pay", to: "n_ok", label: "" },
      { id: "e4", from: "n_wait", to: "n_sw2", label: "" },
      { id: "e5", from: "n_sw2", to: "n_fail", label: "用户取消" },
      { id: "e6", from: "n_sw2", to: "n_pay", label: "继续支付" }
    ]
  };
  return {
    workflow: assertValid(raw, "couponAbandon"),
    user_text: "优惠券失效后用户仍可继续支付或取消；取消则失败。评测需含优惠券失效与用户取消。",
    eval: { final_state: "failure", must_have_path_labels: ["优惠券失效", "用户取消"] }
  };
}

function templateParallelOneBranchFail() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "并行单支异常",
    nodes: [
      { id: "n_start", type: "start", text: "开始 拆单处理", x: 80, y: 240 },
      { id: "n_par", type: "parallel", text: "并行子任务", x: 360, y: 240 },
      { id: "n_a", type: "case", text: "子任务A", x: 640, y: 160 },
      { id: "n_b", type: "case", text: "子任务B", x: 640, y: 320 },
      { id: "n_fail", type: "failure", text: "整体失败", x: 920, y: 320 },
      { id: "n_ok", type: "success", text: "整体成功", x: 920, y: 160 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_par", label: "" },
      { id: "e1", from: "n_par", to: "n_a", label: "并行分支A" },
      { id: "e2", from: "n_par", to: "n_b", label: "并行分支B" },
      { id: "e3", from: "n_a", to: "n_ok", label: "" },
      { id: "e4", from: "n_b", to: "n_fail", label: "异常" }
    ]
  };
  return {
    workflow: assertValid(raw, "parallelOneBranchFail"),
    user_text: "并行两支中第二支返回异常则走失败终态；需保留并行分支与异常边标签。",
    eval: { final_state: "failure", must_have_path_labels: ["并行分支A", "异常"] }
  };
}

function templateAuthLoginSuccess() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "未登录转登录成功",
    nodes: [
      { id: "n_start", type: "start", text: "开始 结算", x: 80, y: 200 },
      { id: "n_sw", type: "switch", text: "登录态", x: 360, y: 200 },
      { id: "n_login", type: "wait_user", text: "引导登录", x: 640, y: 120 },
      { id: "n_case", type: "case", text: "提交订单", x: 920, y: 200 },
      { id: "n_ok", type: "success", text: "下单成功", x: 1180, y: 200 },
      { id: "n_ok_direct", type: "success", text: "已登录直达成功", x: 640, y: 320 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_sw", label: "" },
      { id: "e1", from: "n_sw", to: "n_case", label: "已认证" },
      { id: "e2", from: "n_sw", to: "n_login", label: "未认证" },
      { id: "e3", from: "n_login", to: "n_case", label: "登录成功" },
      { id: "e4", from: "n_case", to: "n_ok", label: "" },
      { id: "e5", from: "n_sw", to: "n_ok_direct", label: "免密已登录" }
    ]
  };
  return {
    workflow: assertValid(raw, "authLoginSuccess"),
    user_text: "未认证用户先登录再下单成功。成功路径需出现未认证与登录成功两条边标签。",
    eval: { final_state: "success", must_have_path_labels: ["未认证", "登录成功"] }
  };
}

function templateAuthLoginFail() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "登录失败拒绝",
    nodes: [
      { id: "n_start", type: "start", text: "开始 结算", x: 80, y: 200 },
      { id: "n_sw", type: "switch", text: "登录态", x: 360, y: 200 },
      { id: "n_try", type: "case", text: "尝试登录", x: 640, y: 200 },
      { id: "n_ok", type: "success", text: "下单成功", x: 920, y: 120 },
      { id: "n_fail", type: "failure", text: "无法继续", x: 920, y: 280 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_sw", label: "" },
      { id: "e1", from: "n_sw", to: "n_try", label: "未认证" },
      { id: "e2", from: "n_sw", to: "n_ok", label: "已认证" },
      { id: "e3", from: "n_try", to: "n_fail", label: "登录失败" }
    ]
  };
  return {
    workflow: assertValid(raw, "authLoginFail"),
    user_text: "未认证且登录失败则无法下单。评测需含未认证与登录失败。",
    eval: { final_state: "failure", must_have_path_labels: ["未认证", "登录失败"] }
  };
}

function templateShippingDelivered() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "发货成功通知",
    nodes: [
      { id: "n_start", type: "start", text: "开始 仓储出库", x: 80, y: 180 },
      { id: "n_sw", type: "switch", text: "发货结果", x: 380, y: 180 },
      { id: "n_notify", type: "case", text: "通知用户", x: 680, y: 120 },
      { id: "n_ok", type: "success", text: "流程闭环", x: 960, y: 120 },
      { id: "n_fail", type: "failure", text: "发货异常", x: 680, y: 260 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_sw", label: "" },
      { id: "e1", from: "n_sw", to: "n_notify", label: "发货成功" },
      { id: "e2", from: "n_sw", to: "n_fail", label: "发货失败" },
      { id: "e3", from: "n_notify", to: "n_ok", label: "" }
    ]
  };
  return {
    workflow: assertValid(raw, "shippingDelivered"),
    user_text: "发货成功后通知用户并结束成功。需包含发货成功标签。",
    eval: { final_state: "success", must_have_path_labels: ["发货成功"] }
  };
}

function templateRetryCapFail() {
  const rid = uid("R_");
  const raw = {
    mwgl_version: 2,
    rule_id: rid,
    rule_name: "重试耗尽失败",
    nodes: [
      { id: "n_start", type: "start", text: "开始 调用外部接口", x: 80, y: 200 },
      { id: "n_ls", type: "loop_start", text: "重试区间", x: 320, y: 200 },
      { id: "n_sw", type: "switch", text: "本次调用结果", x: 560, y: 200 },
      { id: "n_retry", type: "case", text: "记录失败并准备下次", x: 840, y: 120 },
      { id: "n_le", type: "loop_end", text: "离开重试区间", x: 840, y: 280 },
      { id: "n_sw_fin", type: "switch", text: "失败归类", x: 1080, y: 280 },
      { id: "n_ok", type: "success", text: "调用成功", x: 1120, y: 160 },
      { id: "n_fail", type: "failure", text: "调用失败收尾", x: 1320, y: 280 }
    ],
    edges: [
      { id: "e0", from: "n_start", to: "n_ls", label: "" },
      { id: "e1", from: "n_ls", to: "n_sw", label: "" },
      { id: "e2", from: "n_sw", to: "n_ok", label: "调用成功" },
      { id: "e3", from: "n_sw", to: "n_retry", label: "调用失败" },
      { id: "e4", from: "n_retry", to: "n_le", label: "" },
      { id: "e5", from: "n_le", to: "n_sw_fin", label: "" },
      { id: "e6", from: "n_sw_fin", to: "n_fail", label: "重试上限" },
      { id: "e7", from: "n_sw_fin", to: "n_fail", label: "异常" }
    ]
  };
  return {
    workflow: assertValid(raw, "retryCapFail"),
    user_text: "多次调用失败后离开重试区间，按重试上限或异常归类失败终态；成功可走调用成功。评测失败场景图内需同时出现重试上限与异常边标签。",
    eval: { final_state: "failure", must_have_path_labels: ["重试上限", "异常"] }
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const samples = [];
  let seq = 0;

  const addVariations = (factory, prefix, variations) => {
    for (const row of variations) {
      seq += 1;
      const base = factory();
      const wf = JSON.parse(JSON.stringify(base.workflow));
      wf.rule_name = `${base.workflow.rule_name}${row.ruleSuffix || ""}`;
      const pay = wf.nodes.find((n) => n.id === row.retextId);
      if (pay && row.nodeText) pay.text = row.nodeText;
      assertValid(wf, `${prefix}_${seq}`);
      samples.push({
        id: `${prefix}_${String(seq).padStart(3, "0")}`,
        user_text: row.user_text || base.user_text,
        eval: row.eval || base.eval
      });
    }
  };

  addVariations(templateSwitchPaidOrFail, "syn_pay", [{ ruleSuffix: "" }]);
  addVariations(templateParallelMerge, "syn_par", [{ ruleSuffix: "" }]);
  addVariations(templateLoopRetry, "syn_loop", [{ ruleSuffix: "" }]);
  addVariations(templateAuthGate, "syn_auth", [{ ruleSuffix: "" }]);
  addVariations(templateRiskDeny, "syn_risk", [{ ruleSuffix: "" }]);

  addVariations(templatePaymentTimeout, "syn_timeout", [{ ruleSuffix: "" }]);
  addVariations(templateInventoryShort, "syn_inv", [{ ruleSuffix: "" }]);
  addVariations(templateAmountReviewPass, "syn_amt_ok", [{ ruleSuffix: "" }]);
  addVariations(templateAmountReviewReject, "syn_amt_fail", [{ ruleSuffix: "" }]);
  addVariations(templateCouponAbandon, "syn_coupon", [{ ruleSuffix: "" }]);
  addVariations(templateParallelOneBranchFail, "syn_par_fail", [{ ruleSuffix: "" }]);
  addVariations(templateAuthLoginSuccess, "syn_auth_path", [{ ruleSuffix: "" }]);
  addVariations(templateAuthLoginFail, "syn_auth_fail", [{ ruleSuffix: "" }]);
  addVariations(templateShippingDelivered, "syn_ship", [{ ruleSuffix: "" }]);
  addVariations(templateRetryCapFail, "syn_retry_cap", [{ ruleSuffix: "" }]);

  addVariations(templateSwitchPaidOrFail, "syn_pay", [
    {
      ruleSuffix: "（变体B）",
      nodeText: "履约发货检查",
      user_text: "支付成功后检查库存并发货；支付失败结束。路径需包含已支付、库存充足。",
      eval: {
        final_state: "success",
        must_have_path_labels: ["已支付", "库存充足"]
      }
    }
  ]);

  addVariations(templateParallelMerge, "syn_par", [
    {
      ruleSuffix: "（变体B）",
      user_text: "创建订单后并行处理库存与营销券，再汇聚完成。",
      eval: {
        final_state: "success",
        must_have_path_labels: ["并行分支A", "并行分支B"]
      }
    }
  ]);

  const evalLines = samples.map((s) =>
    JSON.stringify({
      id: s.id,
      input: { user_text: s.user_text },
      expected: {
        final_state: s.eval.final_state,
        must_have_path_labels: s.eval.must_have_path_labels
      }
    })
  );

  const evalPath = path.resolve(process.cwd(), args.evalOut);
  fs.mkdirSync(path.dirname(evalPath), { recursive: true });
  const evalBody = evalLines.join("\n") + "\n";

  if (args.append && fs.existsSync(evalPath)) {
    fs.appendFileSync(evalPath, evalBody);
  } else {
    fs.writeFileSync(evalPath, evalBody);
  }

  console.log(
    `Wrote ${samples.length} rows -> ${evalPath}\nValidate: npm run validate:eval-dataset -- ${args.evalOut}`
  );
}

main();
