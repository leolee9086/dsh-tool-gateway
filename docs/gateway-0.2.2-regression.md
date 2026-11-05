# DSH 0.2.2 工具箱回归与修复验证

## 当前状态

2026-11-05 22:23 +08:00，位置 D:/dev/dsh-tool-gateway。意图：先完成新版可见性与实际可用性修复，再验证构建产物；旧版验证按要求后置。结果：新版构建完成，`lib/host.js` 已通过全部 10 组真实 Loader、AgentLoop、HTTP、Node PTC 集成测试（22.36 秒，0 失败）；17 个 src/lib 模块逐字节一致，git diff --check 通过。

宿主源码提交：`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。插件修复前 HEAD：`68f2e2e4c35a6e55c13173b98f0ed7f660f128c4`。

## 根因

`9d0c97b9d2` 把 `system-prompt/assemble` 瀑布改为仅处理文本；最终返回 `{ ...transformed, tools }`，覆盖旧插件在瀑布中的工具过滤。新版 `tools.execute` 也已改为 batch 输入，不接受旧单调用输入和 parent。

已用相同真实宿主测试运行修复前 HEAD：模型收到 `call_tool, call_tools, find_tools, probe`，预期只有 `call_tool, find_tools`，测试失败。换修复代码后通过。因此不是只跑假服务断言或语法检查。

## 当前实现

- 新版包装完整 `SystemPrompt.assemble` 返回值，保留原方法的 `this`，通过 Cordis effect 在卸载时恢复。旧版保留装配瀑布路径。
- 可见性与实际禁用共用会话/工具组偏好；即使关掉工具箱，禁用工具仍隐藏且拒绝执行。禁用检查先于 parent 放行。
- 新版子调用从 tools 服务自己的 Loader 导入公开 `@deepseek-ai/dsh-tools/pipeline`，验证 ToolsService 实例身份，执行 prepare/dispatch/complete。继承真实 parent、rootCallId、toolSet、signal、schema，不伪造准入，不回退全局目录。
- `find_tools` 查询也使用本步真实准入集合；条件未满足或宿主限制掉的工具不能被目录补回。
- `call_tool` 失败向外抛出，`call_tools` 程序中的 try/catch 收到真正的 ToolCallError。附加上下文、图片和结束回合信号逐层传回。
- `call_tools` 适配函数体、REPL、script 格式；当前目录从 workingDirectory 获取；持久状态按 agent 隔离并在卸载时释放。程序结束、取消、网关卸载都会中止并等待子调用收尾。
- 官方 PTC 保留 run_code，通过官方 SDK renderer 过滤 SDK 声明，不向 SDK 嵌套公开 call_tools。执行守卫继续拦截禁用工具。
- 删除本次错误的 restrict/fakeToolSet 方案与假 ctx 测试；替换旧的两个元工具桩测试及旧 lib 集成入口。

## 真实验证入口

```powershell
$env:DSH_TEST_CHECKOUT='D:\dev\deepseek-harness'
pnpm run test:integration
```

测试由 `scripts/test-integration.mjs` 加载 checkout 的 tsx/esm，明确设置 tsconfig paths，源码与旧 lib 不混用。`tests/fixtures/real-host.cordis.yml` 经真实 Loader 启动生产服务。仅外部模型响应为 scripted adapter；注册表、Agent、Session、执行流水线、HTTP 鉴权、PTC 运行时与子进程全部真实。

覆盖：ON/OFF/ON 下一请求、另一会话隔离、单工具和组禁用三条调用路径、全局/ancestor/agent shadow、when 条件、宿主 restrict、撤销恢复、PTC 三种程序格式及状态隔离、上下文与 concludesTurn、组装后禁用、取消、当前工作目录、输入错误、ToolCallError、超时、子调用日志 id、插件卸载时活跃程序 drain、子会话偏好继承与真实审批/pre/post。

`pnpm test`：181 项现有回归通过；不能代替上述真实集成。

## 剩余与部署

- 已用 `GATEWAY_TEST_ENTRY=file:///D:/dev/dsh-tool-gateway/lib/host.js` 运行同一真实宿主集成，10/10 通过。
- 当前 GUI 进程仍持有旧模块；构建不会自动替换已加载的宿主模块，需完整重启后现场验证。
- 旧版本完整验证按哥哥要求后置；隔离源码工作树位于 D:/dev/dsh-gateway-compat-021，尚未跑过，不能宣称旧版兼容已验证。
- DSH 源码未修改；仅按锁文件补装了新版 PTC 缺少的依赖，旧临时探针已删除。
