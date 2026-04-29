/**
 * MWGL 语言实现（v2）。具体规则见 mwgl-v2.js。
 */
export {
  MWGL_VERSION,
  NODE_TYPES,
  filterEdgesAcyclic,
  hasDirectedPath,
  isAllowedMwglEdge,
  layoutWorkflowLeftToRight,
  mwglToWorkflow,
  normalizeWorkflow,
  validateWorkflowConstraints,
  wouldEdgeCreateCycle,
  workflowToMwgl
} from "./mwgl-v2.js";
