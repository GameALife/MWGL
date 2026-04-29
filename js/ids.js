export function uid(prefix = "n") {
  return prefix + Math.random().toString(36).slice(2, 8);
}
