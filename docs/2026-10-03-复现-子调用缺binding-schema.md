# 复现：工具箱子调用在 Auto review 下必然被拒（2026-10-03）

## 现象（真机）

desktop profile，权限预设切到 **Auto**（自动授权审查）之后：

```
Auto review of tool "call_tool" failed; its body was not executed:
auto-review: the pending PTC binding schema is missing or inconsistent
```

- `call_tool` 转发任何工具 → **15ms 内失败**，body 从未执行
- `call_tools` 里 `tools.call_tool(...)` → 同样失败
- `find_tools` → **正常**（它不派发子调用）
- 切回工作区权限后工具立刻恢复

**结论：Auto 开着的时候，网关的元工具全废。**

## 根因（字段级对照）

| 字段 | 官方 PTC（`core/tools/src/ptc.ts:538-550`） | 网关（`src/meta-tools.js:156-164`） |
|---|---|---|
| `signal` | ✓ | ✓ |
| `rootCallId` | ✓ | ✓ |
| `parent` | ✓ | ✓ |
| `callId` | ✓ | ✓ |
| `name` | ✓ | ✓ |
| **`schema`** | ✓ `binding(deepFreeze(schema))` | **✗ 缺** |
| `arguments` | ✓ | ✓ |
| `agent` | ✓ | ✓ |

auto-review `src/index.ts:342`：

```ts
if (exec.schema === undefined || exec.schema.name !== exec.name) {
  throw new Error('auto-review: the pending PTC binding schema is missing or inconsistent')
}
```

`ToolExecutionInput.schema` 的契约（`core/tools/src/index.ts:334-335`）：

> Binding-time tool schema for a PTC inner call; frozen by its producer and never logged.

网关带了 `parent`（正确地声明"我是子派发"），却没带 `schema` —— 审查者拿不到"这一步要执行什么"，
于是**在执行之前**就关掉了。

## 复现（跑真实代码，无桩）

文件：`deepseek-harness/packages/experimental/auto-review/tests/repro-gateway-inner-call.spec.ts`

夹具照抄本包自己的 spec（真 Context、真 tools 流水线、真 auto-review；只有 LLM adapter 是桩，
那是外部服务）。唯一不同的是把 `ctx.tools.execute()` 的参数换成网关那份。

```sh
cd D:/dev/deepseek-harness
node_modules/.bin/vitest.cmd run packages/experimental/auto-review/tests/repro-gateway-inner-call.spec.ts \
  --project=thread-safe --reporter=default --no-color
```

结果：

| 用例 | `probe.runs()` | reviewer 请求数 | 结果 |
|---|---|---|---|
| 有 parent、**无 schema**（网关的实际形状） | 0 | 0 | 拒绝：`the pending PTC binding schema is missing or inconsistent` |
| 有 parent、**有 schema**（官方 PTC 的形状） | 1 | 1 | 正常执行 |

**唯一变量是 `schema` 这一个字段。**

## 修法

`invokeTool`（`src/meta-tools.js`）派发子调用时补上目标工具的 schema。
网关里已经有现成的东西：`createMetaTools` 那个按名字索引的 schema 表（`meta-tools.js:198` 起）。

两个注意点：

1. **名字必须等于被派发的 `name`** —— 审查者检查 `exec.schema.name === exec.name`。
2. **要冻结** —— 契约写着 "frozen by its producer"。

## 边界

- 本文件只证明"缺 schema 会被拒"与"补上就通过"。
- 真机报错里的工具名是 `call_tool`，而按网关派发的形状应报被派发的那个工具名。
  这个差异指向"失败发生在网关派发的哪一跳"，**不影响修法**，但真机验证时要盯这一条。
- 那个 spec 文件放在 DSH 仓库里是为了能跑真实的 tools 流水线；**留还是删，等哥哥定**。

（本次清理：删掉了调试期间落在 deepseek-harness 根目录的 4 个 json 产物。）
