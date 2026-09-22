# dsh-tool-gateway

把 DSH 的工具目录收成两个元工具：**`find_tools` 查、`call_tool` 调**。
其余工具不出现在模型可见的工具表里，但**仍然可以被调用** —— 只是入口变成了这两个。

## 它解决什么

工具一多，真正的挑战不是上下文长度，而是**模型会不会只盯着被截断的那份工具列表将就**。
表越长越容易挑错；表被截断，模型就会忘掉那些没露面的工具，转而用几个熟面孔凑合。

这个插件把工具目录收起来，逼出"**每一次动手之前先查清楚有什么**"这个动作：
那份长列表不在眼前了，模型只能先 `find_tools` 问、再 `call_tool` 调。

## 装

```sh
# 在 DSH Web profile 目录（默认 ~/.dsh/profiles/web）
pnpm add 'github:leolee9086/dsh-tool-gateway#v0.1.0'
```

装完在 profile 里启用（`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- insert:
    - id: tool-gateway
      name: "dsh-tool-gateway"
```

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
  两个元工具仍然在（它们只是不再是唯一入口）。
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
   模型可见的工具表只剩两个元工具。这一步**不碰注册表**。
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
| `src/host.js` | 入口：接线，不实现任何一件具体的事 |
| `src/catalog.js` | 检索索引（jieba 切词 + 拼音 + minisearch 倒排） |
| `src/meta-tools.js` | `find_tools` / `call_tool` 两个元工具 |
| `src/gateway.js` | 可见性过滤、执行守卫、提示段落，都按 `enabledFor(agent)` 分支 |
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
  上下文送出，不做转码或裁剪。
- 依赖三个包：`@node-rs/jieba`（原生模块）、`pinyin-pro`、`minisearch`。前两个都是
  预编译分发、无 install 脚本、零运行时依赖树。

## 开发

```sh
pnpm install
pnpm test          # 91 个测试
pnpm build         # 校验后逐字节拷贝 src/ → lib/
```

`lib/` 随仓库提交，安装方不需要在自己机器上跑构建。
客户端半边（`src/client.js`）是手写的 `window.__ModuleLoader__.load` 自注册脚本，
构建只做语法校验、不转换 —— 它由 web server 原样下发。
