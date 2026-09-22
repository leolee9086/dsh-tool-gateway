# dsh-tool-gateway

把 DSH 的工具目录收成**三个元工具**：**`find_tools` 查、`call_tool` 调、`call_tools` 批量调**。
其余工具不出现在模型可见的工具表里，但**仍然可以被调用** —— 只是入口变成了这几个。

## 它解决什么

工具一多，真正的挑战不是上下文长度，而是**模型会不会只盯着被截断的那份工具列表将就**。
表越长越容易挑错；表被截断，模型就会忘掉那些没露面的工具，转而用几个熟面孔凑合。

这个插件把工具目录收起来，逼出"**每一次动手之前先查清楚有什么**"这个动作：
那份长列表不在眼前了，模型只能先 `find_tools` 问、再 `call_tool` 调。

## 三个元工具

| 工具 | 干什么 | 什么时候用 |
|---|---|---|
| `find_tools` | 按名字、描述、中文或拼音检索，返回完整参数 schema | 不知道有什么工具、或不知道参数怎么写 |
| `call_tool` | 调一个工具，参数 `{tool_name, arguments}` | 一次调一个 |
| `call_tools` | 写一段程序批量调用工具 | 要连着调好几个，而中间结果不必进对话 |

`call_tools` 干活的是一段**模型写的 TypeScript 程序**（DSH 的 PTC 运行时负责跑它）。
程序里只有两个函数可调：`tools.find_tools({query})` 与 `tools.call_tool({tool_name, arguments})`。
**只有程序 `return` 的值会回到对话里** —— 读十个文件、跑十次搜索，中间那些内容不必挤进上下文。

它的参数、输出与界面呈现都对齐 DSH 官方 PTC 模式的 `run_code`：`description` 必填
（那是卡片标题，也是审批弹窗里给人看的第一行字）、控制参数只在运行时真的支持时才出现、
输出是结构化的 `{logs, result?, sandbox?}`、失败是带 `kind` 的 `CodeRunFailedError`。

**唯一刻意不一样的地方**：官方 `run_code` 的 SDK 段落是遍历注册表生成的（把一百多个工具
的名字和参数全喂给模型），我们这里是手写的两条声明 —— 那正是这个插件要消掉的东西。

### 什么时候不挂 `call_tools`

- **PTC 模式已经开着**（`mode: 'ptc'` 或 `'both'`）：那时 DSH 自己的 `run_code` 就在工具表里，
  再加一个功能重叠的只会让模型困惑该用哪个（而在 `mode: 'ptc'` 下它本来也调不到 ——
  那个模式的执行守卫只放行 `run_code`）。
- **部署里没挂 PTC 运行时**（`ctx.ptcRuntime` 缺席）：挂了也跑不了。

检测用公开的 `tools.schemas(agent)` 看 `run_code` 在不在可见集里 —— 那正好是
`modeFor(scope) !== 'native'` 的判据。检测**按会话算**（preset 可以用 `tools.presentAs()`
单独选一个呈现模式），读不出来时保守地**不挂**：少一个能力不等于出错，
而抢 PTC 的位置会真的出错。

## 装

```sh
dsh plugin --profile web add github:leolee9086/dsh-tool-gateway#v0.1.1
```

`dsh plugin --profile <name> <args...>` 在 profile 目录里转发给 pnpm。装完它会依据本包
`package.json` 的 `dsh.bundle.patch` 声明，把本包追加进 `dsh.profile.bundles` ——
于是每次启动自动插入加载行，**不需要手工编辑 profile 的 `cordis.patch.yml`**。

本包的 `lib/` 随仓库提交，所以从 git 安装**不需要 pnpm 的构建授权**（`allowBuilds`）：
拉下来就是能直接加载的产物，包里没有 `prepare` 脚本，安装时不会在你机器上跑构建。
想锁得更死，把 `#v0.1.0` 换成具体的 commit sha。

重启 DSH 生效。**不需要改任何 preset** —— 它挂在 profile 层（根作用域）一次，
对所有 preset、所有会话生效。

（本地开发时也可以用 `file://` 直接引用源码目录的 `lib/host.js`，
客户端半边仍然走 `package.json` 的 `exports["./client"]` 与 `dsh.client` 声明。）

## 会话级开关

会话标题栏上有一个 chip（`工具箱 开` / `工具箱 关`），点一下切换**这个会话**
要不要施加约束。默认是开 —— 装上这个插件就是要约束行为；关掉是你在某个会话里的显式选择。

- 状态持久在 `$DSH_HOME/storages` 下的 `tool_gateway/sessions` 里，重启后仍然生效。
- **子代理会话跟随父会话**：你只看得见父会话，而子代理的工具组合本来也是从父那里继承的。
- 关掉之后：模型看到完整工具表、可以直接调用任何工具、系统提示里也不再出现那段使用说明。
  元工具仍然在（它们只是不再是唯一入口）。
- **生效时机**：执行守卫**立刻**生效（下一次工具调用就放开或拦住）；
  工具表与提示段落**从下一轮请求开始**生效（装配发生在每一轮开始的时候）。
- **切换时会往会话里注入一条通知给模型看。** 模型看不见"装配"这件事本身，没有这条通知，
  它只能在"我明明刚用过 read、怎么现在调不了了"的困惑里自己猜。通知走 `agent.inject()`，
  作为一条 `user` 消息进会话日志（所以模型可见的东西仍然可以从日志重建），不唤醒 driver：
  点完开关再发一条消息，模型就在同一次请求里看到它。
  通知说的是"**刚刚变了什么**"（事件），系统提示里那段说的是"**现在该怎么用**"（状态），
  所以两者措辞不同、不会互相替代。**状态没变时不写库也不通知** ——
  连点两下或者页面重复提交不该在会话里堆两条"模式已关闭"。

没有 `webServer` / `connection` 服务的部署（比如 headless）不会挂这个界面，
网关本身照常工作，开关固定为默认的"开"。

## 它怎么工作

两层，缺一不可：

1. **可见性** —— 在 `system-prompt/assemble` 瀑布里过滤 `assembled.tools`，
   模型可见的工具表只剩那几个元工具（具体几个按会话算，见上）。这一步**不碰注册表**。
2. **执行守卫** —— `ctx.tools.guard()` 拒绝模型对其它工具的直接调用。
   少了这一层，模型只要从历史里记得某个工具名、或者猜中一个，直接调用就会成功 ——
   注册表里那些工具一直都在。

放行条件是"子分发"（`execution.parent !== undefined`）而不是"名字在白名单里"：
`call_tool` 内部发起的调用带着 parent，模型直接发起的没有。这与 DSH 自己 PTC 模式的
塌缩是同一种机制 —— 限制调用**路径**，不限制可见性。

`call_tool` 走 `ctx.tools.execute()`，也就是注册表的公开执行入口：审批、守卫、
沙箱策略、会话日志一步不少，与模型直接调用一个工具没有任何区别。

### 文件

| 文件 | 职责 |
|---|---|
| `src/host.js` | 入口：接线，不实现任何一件具体的事。`keepFor(agent)` 在这里（含 PTC 检测） |
| `src/catalog.js` | 检索索引（jieba 切词 + 拼音 + minisearch 倒排） |
| `src/meta-tools.js` | `find_tools` / `call_tool`，以及三个元工具共用的 `invokeTool` |
| `src/code-tools.js` | `call_tools`：把一段程序交给 PTC 运行时，只绑两个函数 |
| `src/gateway.js` | 可见性过滤、执行守卫、提示段落，都按 `keepFor(agent)` / `enabledFor(agent)` 分支 |
| `src/session-key.js` | 一个 agent 的开关记在哪个会话名下（子代理跟随父） |
| `src/switch-state.js` | 开关状态的读写与持久化（默认开） |
| `src/route.js` | 给浏览器 chip 用的 HTTP 接口（含"状态变了才通知"的判断） |
| `src/switch-notice.js` | 开关变化时写给模型的那条通知 |
| `src/client.js` | 浏览器半边：会话标题栏的 chip |

## 检索

`find_tools` 支持中文、英文、拼音全拼、拼音首字母：

| 查询 | 命中 |
|---|---|
| `zhihu` / `知乎` | 知乎相关工具 |
| `sousuo` / `zhanneisousuo` | 描述里含"搜索"的工具 |
| `tupian` | 图片相关工具 |
| `搜索` | 描述里含该词的工具 |

实现是 jieba 搜索引擎模式切词 + 按词分段的拼音 + minisearch 倒排索引。
索引按 agent 惰性构建（preset 注册的工具在 agent 自己的作用域层，全局视图看不到它们），
`tools/change` 时失效重建。

实测结论（包括踩过的坑）记在 [`docs/检索栈实测.md`](docs/检索栈实测.md)。

## 配置

```yaml
- insert:
    - id: tool-gateway
      name: "dsh-tool-gateway"
      config:
        maxResults: 5      # find_tools 一次返回几条，默认 5
```

## 边界

- **不动会话历史。** 不改写、不压缩、不按历史分档、不扫会话事件判断状态。
  已经跑过一段的会话里那些直接调用 `read`、`bash` 的记录原样留着，
  说明里讲清楚了"入口变了"，模型会遵守。
- **开关也不写会话日志。** 它不是"懒"而是"不能"：`Session.append` 没有写
  `ignorable` 标记的通道，而读者遇到不认识的、没有该标记的事件**必须拒绝重建整个会话**。
  所以开关状态走 storage domain（`$DSH_HOME/storages`），与会话日志无关。
- **覆盖子代理。** 子代理加入父方的组装、走同一条装配瀑布，全局监听器与根作用域守卫
  都生效；开关也跟随父会话。父方通过 `toolFilter` 限制掉的工具，子代理既查不到也调不到。
- **过滤出错时降级**：白名单一个都没匹配上就放行完整目录并告警一次 ——
  工具多一点只是浪费，会话起不来是事故。
- **不处理非文本块的内容**：`call_tool` 把图片等非文本块经 `deferContext` 作为独立
  上下文送出，不做转码或裁剪。`call_tools` 的子调用也一样（程序里调到的图片会附在那次结果之后）。
- **`call_tools` 的程序里能调到的，就只有那两个函数。** 绑定只给
  `tools.find_tools` 与 `tools.call_tool` —— 程序不能直接写 `tools.read({...})`。
  这不是限制调用（子调用走的还是注册表的公开执行入口，审批、守卫、沙箱一样不少），
  而是**不让工具目录再被喂回模型**：官方 PTC 的 SDK 段落会列出全部工具的签名，
  我们这段只有两行。
- **程序结束就中止还在飞的子调用。** 程序写了 `tools.call_tool(...)` 却没 `await`，
  那个调用不会在结果返回之后继续跑下去 —— 它会随这次运行一起停掉，而且会等它
  收完尾才把结果交出去（不等的话，它的会话日志会落在这次调用之后）。
- 依赖三个包：`@node-rs/jieba`（原生模块）、`pinyin-pro`、`minisearch`。前两个都是
  预编译分发、无 install 脚本、零运行时依赖树。

## 开发

```sh
pnpm install
pnpm test          # 126 个测试
pnpm build         # 校验后逐字节拷贝 src/ → lib/
```

`lib/` 随仓库提交，安装方不需要在自己机器上跑构建。
客户端半边（`src/client.js`）是手写的 `window.__ModuleLoader__.load` 自注册脚本，
构建只做语法校验、不转换 —— 它由 web server 原样下发。
