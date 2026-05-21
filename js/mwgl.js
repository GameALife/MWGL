/**
 * MWGL 语言实现（v3）。v2 图在 normalize 时自动迁移。
 */
export {
  MWGL_VERSION,
  NODE_TYPES,
  filterEdgesAcyclic,
  hasDirectedPath,
  isAllowedMwglEdge,
  layoutWorkflowLeftToRight,
  migrateWorkflowV2ToV3,
  mwglToWorkflow,
  normalizeWorkflow,
  parallelJoinStatus,
  validateWorkflowConstraints,
  wouldEdgeCreateCycle,
  workflowToMwgl
} from "./mwgl-v3.js";

export {
  createEmptyLoop,
  createLoopStepItem,
  validateWorkflowLoops,
  appendLoopPseudoForNode
} from "./mwgl-loop.js";
