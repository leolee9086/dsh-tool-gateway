# 进度笔记 2：Auto review 的「层数」问题（2026-10-04 下午）

接 `2026-10-04-进度-Auto review修复与find_tools新功能.md`。那份记的是"补接线 + 修名字清单"，
这份记的是**哥哥重启后真机测出来的新问题**。

## 已经验证通过的部分（find_tools 新功能全部可用）

哥重启后实测，四条都对着：

1. `find_tools({detail:"name"})` → 列出 **134 个工具名**（`- bazaar_install` 这样的清单）
2. `find_tools({names:["read","edit","write"], detail:"params"})` → 每个工具「名字 —— 描述」+ 参数清单
   （必填/可选、类型、一句说明），没有完整 JSON
3. `names` 里混进不存在的名字（`zhihu_searchh`、`mcp__comfyui__generate`）→ 如实报
   「没有这些工具：…。名字要精确（也可以拿 query 模糊找一个）；被本会话关掉的工具同样不在目录里。」
   **没有推荐"最像的"** ✓
4. `find_tools({query:"视频生成", detail:"name"})` → 「匹配「视频生成」的工具 5 个」+ 纯名字清单

## 新问题：Auto review 开着时，程序里的子调用失败

### 现象（真机，Auto 开着 = file policy 是 danger-full-access）

- **模型直接调 `call_tool({tool_name:"read",...})` → 成功**（耗时约 8370ms，审查者在跑）
- **程序里 `tools.call_tool({tool_name:"read",...})` → 失败**，错误：
  ```
  Auto review of tool "read" failed; its body was not executed:
  auto-review: the pending PTC call disagrees with its logged action
  ```
- 程序里 `tools.call_tool({tool_name:"pwsh",...})` → 同样失败
- 连续两次 read（都在程序里）→ **两次都失败**（不是"第二次才失败"）

**注意这个错误与之前那个不同**：
- 之前的 `the pending PTC binding schema is missing or inconsistent` → **schema 没带**（已修，接线补上后不再出现）
- 现在的 `disagrees with its logged action` → **日志与执行对不上**（新问题）

### 根因：层数不对（已定位到两边代码）

**auto-review 侧** `packages/experimental/auto-review/src/index.ts`：

- `visibleParentKeys`（420 行）是**遍历 surface 节点**收集的（422-425 行的循环，
  注释原文："Surface nodes are event indexes produced by this Session's validated fold."）
- `ptcAction`（330-341 行）的第一个条件就是：
  ```js
  if (!visibleParentKeys.has(scopedCallKey(start.step, event.data.parentCallId))
    || event.data.rootCallId !== exec.rootCallId
    || event.data.name !== exec.name
    || !sameJson(event.data.arguments, exec.arguments)) {
    throw new Error('auto-review: the pending PTC call disagrees with its logged action')
  }
  ```
  → **父调用必须出现在 surface 上**，否则这一条就挂。

**DSH 侧** `packages/core/session/src/index.ts:874` 的注释写死了什么能进 surface：

> A surface node is one of the **five message-producing types**, …

→ `tool/ptc-dispatch-start` / `tool/ptc-dispatch` 这类观测事件**进不了 surface**
（所以"给 gateway 的事件加 surfaceOp"这条修法走不通）。

**官方 PTC 为什么没事**（`packages/core/tools/src/ptc.ts:612`）：

```js
exec.agent?.session.append('tool/ptc-dispatch-start', {
  rootCallId: exec.rootCallId,
  parentCallId: exec.callId,
  subCallId,
  name,
  arguments: normalized.logged,
})
```

它也没带 surfaceOp —— 但它**只有一层**：`run_code`（模型直调，在 surface）→ 工具。
父调用天然在 surface 上。

**网关是两层**：

1. 模型直调 `call_tools`（在 surface ✓）
2. 程序里 `tools.call_tool({tool_name:"read"})` → **派发 `call_tool` 这个工具本身**
   （`code-tools.js:436-437`：`for (const name of [FIND_TOOLS, CALL_TOOL]) … bind(name)`）
   → 这一跳的父是 `call_tools` ✓ 在 surface
3. `call_tool` 的 execute 里再 `invokeTool({name:"read"})` → **派发 read**
   → 这一跳的**父是第 2 步那个程序内部派发的 `call_tool`**，它**不在 surface** ✗
   → **就是这一跳挂的**（所以报错名是 `read`）

### 修法（已确定，尚未实施）

**让程序里的 `tools.call_tool` 直接落到目标工具上，省掉中间那一层。**

即改 `src/code-tools.js` 的 `bind`：当绑定名是 `CALL_TOOL` 时，不从
`rawArgs` 里取"目标工具"再交给 `invokeTool` 去派发 `call_tool` 工具，而是
**直接 `invokeTool({name: <rawArgs.tool_name>, args: rawArgs.arguments, …})`**。

要保留的检查（现在在 `meta-tools.js:436-455` 的 `call_tool.execute` 里）：

```js
const name = typeof args?.tool_name === 'string' ? args.tool_name.trim() : ''
if (name.length === 0) return { text: '请提供 tool_name。不知道名字就先用 find_tools 查。' }
if (blocked.has(name)) return { text: `${name} 不能通过 call_tool 调用（会递归）。直接用它的参数调用它自己即可。` }
if (ctx.tools.get(name, exec?.agent) === undefined) {
  return { text: `没有名为「${name}」的工具。用 find_tools 查一下确切名字 —— 注意工具名区分下划线与大小写。` }
}
```

**建议**：把这三条检查抽成一个共用函数（比如 `resolveTarget(ctx, args, exec, blocked)`），
`call_tool.execute` 和 `bind` 都用它 —— 别写两份（会跑偏）。

**模型直接调 `call_tool` 的路径不受影响**（那一层父在 surface，是好的）。

### 顺带发现的测试方法坑

程序里 `tools.call_tool(...)` 失败时，**我的程序没有捕获到异常**，于是打了 "read #1 : OK" ——
**哥哥用截图纠正了我**：那次 read 其实失败了。

真相（`code-tools.js` 的 `bind` 里）：

```js
const outcome = await flight
deliverContext(exec, outcome.context)
if (outcome.isError) throw new Error(outcome.text)
return { text: outcome.text }
```

它**应该**抛。但我那次收到的是**返回的文本**（`Auto review of tool "read" failed; …`），
说明 `outcome.isError` 在真机上不是 `true`（集成测试里明明是 `true`）。
**待查**：`invokeTool` 里 `isError: result?.isError === true`，真机 `ctx.tools.execute` 返回的形状
可能与测试里不同。

**教训**：程序里调 `tools.*` 之后**必须检查返回值**，不能只看"有没有抛异常"。

## 会话日志怎么查（哥哥指的路）

**别去翻磁盘**（`C:\Users\al765\.dsh\sessions\--D-dev--\session-*` 是目录形式，而且目录 mtime
不随追加写更新，按 mtime 找不到当前会话）。**用现成的工具**：

- `session_blocks_query` —— 按元数据查（时间区间、字数、块类型、**事件类型**、surface），可跨会话；
  `granularity=messages` 按事件聚合，`granularity=blocks` 逐块返回
- `session_blocks_search` —— 块级全文检索，给 sessionId + seq + 块路径
- `session_blocks_read` —— 读某个事件里的块原文（按 seq 或 blockId），走官方会话读取
- `session_blocks_sql` —— 直接查索引表
- 另有 `session_blocks_list` / `session_blocks_status` / `session_blocks_workspaces` / `session_blocks_recall` / `session_blocks_remember`

## 当前状态

- **已提交**（分支 main，工作区干净）：
  ```
  8192a36 fix: 补上漏掉的两处接线，并修掉 catalog 的名字清单
  f853dec feat(find_tools): 加"只给名字"的档位，以及按确切名字取 schema
  6b8c3ad fix: 派发子调用时带上目标工具的 schema，修掉 Auto review 下元工具全废
  ```
- **修复方向已定，代码未改**：`src/code-tools.js` 的 `bind` 要去掉中间那一层
- **验证依赖**：改完要 build，并且**需要哥哥再开一次 Auto review** 才能测（那次他可能已经关了 ——
  file policy 现在是 workspace-write）
- **另外**：那次 `call_tools` 查日志的调用被审查者中止过
  （`auto-review: reviewer ended with aborted ABORTED: Request aborted`）—— 审查者本身也会超时/被取消

## 关键路径

- 仓库 `D:\dev\dsh-tool-gateway`；源码 `src/{host,meta-tools,code-tools,catalog}.js`
- 构建 `node scripts/build.mjs`；单测 `node --test tests\<name>.test.mjs`（**要提权 + cmd.exe**）
- 集成测试 `DSH_TEST_CHECKOUT=D:\dev\deepseek-harness node tests\integration\host-pipeline.test.mjs`
- DSH 加载 `file:///D:/dev/dsh-tool-gateway/lib/host.js`；**host 侧无 HMR，改 lib/ 必须重启**
- auto-review 源码 `D:\dev\deepseek-harness\packages\experimental\auto-review\src\index.ts`
- DSH session 源码 `D:\dev\deepseek-harness\packages\core\session\src\index.ts`
- 官方 PTC `D:\dev\deepseek-harness\packages\core\tools\src\ptc.ts`
- 本文档路径：`D:\dev\dsh-tool-gateway\docs\2026-10-04-进度2-Auto review层数问题.md`
