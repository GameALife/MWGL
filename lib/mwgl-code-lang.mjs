export const CODE_LANG = {
  Python: {
    indent: 4,
    comment: "#",
    imports: "import asyncio\n",
    def: (fn) => `async def ${fn}(ctx):`,
    endDef: "",
    call: (fn, sp) => `${sp}ctx = await ${fn}(ctx)`,
    callSwitch: (fn, sp) => `${sp}branch = await ${fn}(ctx)`,
    ifStart: (cond, sp) => `${sp}if branch == "${cond}":`,
    elif: (cond, sp) => `${sp}elif branch == "${cond}":`,
    parallel: (fns, sp) => `${sp}await asyncio.gather(${fns.map((f) => `${f}(ctx)`).join(", ")})`,
    success: (fn, sp) => `${sp}return await ${fn}(ctx)`,
    failure: (fn, sp) => `${sp}await ${fn}(ctx)\n${sp}return`,
    mainStart: "async def main():",
    mainCtx: (sp) => `${sp}ctx = {}`,
    mainEnd: "",
    footer: "\nasyncio.run(main())",
    stub: (fn, sp) =>
      `${sp}# TODO: 未生成节点函数，请补充业务逻辑\n${sp}pass\n${sp}return ctx`
  },
  JavaScript: {
    indent: 2,
    comment: "//",
    imports: "",
    def: (fn) => `async function ${fn}(ctx) {`,
    endDef: "}",
    call: (fn, sp) => `${sp}ctx = await ${fn}(ctx);`,
    callSwitch: (fn, sp) => `${sp}const branch = await ${fn}(ctx);`,
    ifStart: (cond, sp) => `${sp}if (branch === "${cond}") {`,
    elif: (cond, sp) => `${sp}} else if (branch === "${cond}") {`,
    blockEnd: (sp) => `${sp}}`,
    parallel: (fns, sp) => `${sp}await Promise.all([${fns.map((f) => `${f}(ctx)`).join(", ")}]);`,
    success: (fn, sp) => `${sp}return await ${fn}(ctx);`,
    failure: (fn, sp) => `${sp}await ${fn}(ctx);\n${sp}return;`,
    mainStart: "async function main() {",
    mainCtx: (sp) => `${sp}let ctx = {};`,
    mainEnd: "}",
    footer: "\nmain();",
    stub: (fn, sp) =>
      `${sp}// TODO: 未生成节点函数\n${sp}return ctx;`
  },
  Go: {
    indent: 2,
    comment: "//",
    imports: 'import (\n\t"fmt"\n\t"sync"\n)\n',
    def: (fn) => `func ${fn}(ctx map[string]interface{}) map[string]interface{} {`,
    endDef: "}",
    call: (fn, sp) => `${sp}ctx = ${fn}(ctx)`,
    callSwitch: (fn, sp) => `${sp}branch := fmt.Sprint(${fn}(ctx)["branch"])`,
    ifStart: (cond, sp) => `${sp}if branch == "${cond}" {`,
    elif: (cond, sp) => `${sp}} else if branch == "${cond}" {`,
    blockEnd: (sp) => `${sp}}`,
    parallel: (fns, sp) => {
      const calls = fns
        .map((f) => `${sp}\tgo func() { defer wg.Done(); ${f}(ctx) }()`)
        .join("\n");
      return `${sp}var wg sync.WaitGroup\n${sp}wg.Add(${fns.length})\n${calls}\n${sp}wg.Wait()`;
    },
    success: (fn, sp) => `${sp}${fn}(ctx)\n${sp}return`,
    failure: (fn, sp) => `${sp}${fn}(ctx)\n${sp}return`,
    mainStart: "func main() {",
    mainCtx: (sp) => `${sp}ctx := map[string]interface{}{}`,
    mainEnd: "}",
    footer: "",
    stub: (fn, sp) => `${sp}// TODO: 未生成\n${sp}return ctx`
  },
  Java: {
    indent: 2,
    comment: "//",
    imports: "import java.util.*;\nimport java.util.concurrent.*;\n",
    def: (fn) => `static Map<String, Object> ${fn}(Map<String, Object> ctx) {`,
    endDef: "}",
    call: (fn, sp) => `${sp}ctx = ${fn}(ctx);`,
    callSwitch: (fn, sp) => `${sp}String branch = (String) ${fn}(ctx).get("branch");`,
    ifStart: (cond, sp) => `${sp}if ("${cond}".equals(branch)) {`,
    elif: (cond, sp) => `${sp}} else if ("${cond}".equals(branch)) {`,
    blockEnd: (sp) => `${sp}}`,
    parallel: (fns, sp) =>
      `${sp}CompletableFuture.allOf(${fns.map((f) => `CompletableFuture.supplyAsync(() -> ${f}(ctx))`).join(", ")}).join();`,
    success: (fn, sp) => `${sp}${fn}(ctx); return;`,
    failure: (fn, sp) => `${sp}${fn}(ctx); return;`,
    mainStart: "  public static void main(String[] args) {",
    mainCtx: (sp) => `${sp}Map<String, Object> ctx = new HashMap<>();`,
    mainEnd: "  }",
    footer: "",
    classWrap: true,
    className: "WorkflowApp",
    stub: (fn, sp) => `${sp}// TODO: 未生成\n${sp}return ctx;`
  },
  "C++": {
    indent: 2,
    comment: "//",
    imports: "#include <iostream>\n#include <map>\n#include <string>\n#include <future>\n#include <vector>\nusing namespace std;\n",
    def: (fn) => `map<string, string> ${fn}(map<string, string> ctx) {`,
    endDef: "}",
    call: (fn, sp) => `${sp}ctx = ${fn}(ctx);`,
    callSwitch: (fn, sp) => `${sp}string branch = ${fn}(ctx)["branch"];`,
    ifStart: (cond, sp) => `${sp}if (branch == "${cond}") {`,
    elif: (cond, sp) => `${sp}} else if (branch == "${cond}") {`,
    blockEnd: (sp) => `${sp}}`,
    parallel: (fns, sp) => {
      const launches = fns
        .map(
          (f, i) =>
            `${sp}  futures.push_back(async(launch::async, [&](){ return ${f}(ctx); }));`
        )
        .join("\n");
      return `${sp}{\n${sp}  vector<future<map<string,string>>> futures;\n${launches}\n${sp}  for (auto& f : futures) f.get();\n${sp}}`;
    },
    success: (fn, sp) => `${sp}${fn}(ctx); return 0;`,
    failure: (fn, sp) => `${sp}${fn}(ctx); return 1;`,
    mainStart: "int main() {",
    mainCtx: (sp) => `${sp}map<string, string> ctx;`,
    mainEnd: "}",
    footer: "",
    stub: (fn, sp) => `${sp}// TODO: 未生成\n${sp}return ctx;`
  }
};

export function getCodeLang(language) {
  return CODE_LANG[language] || CODE_LANG.Python;
}
