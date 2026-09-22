/**
 * dsh-tool-gateway 的宿主入口。
 *
 * 挂 profile 层一次，对所有 preset、所有会话生效 —— 这是刻意的。它要接管的是
 * "模型看到哪些工具"，而那件事本来就发生在每一轮请求的组装上，与 preset 无关。
 * 挂进 preset 会退化成"每个 preset 各挂一遍、老会话还得按 sessionId 打补丁"。
 *
 * **会话级开关**：约束可以按会话关掉，开关状态持久在 storage domain 里，
 * 浏览器侧的 chip 通过一条同源 HTTP 路由读写它。四件事拼在一起：
 *
 *   session-key.js   一个 agent 的开关记在哪个会话名下（子代理跟随父）
 *   switch-state.js  开关状态的读写与持久化（默认开）
 *   gateway.js       拿 enabledFor(agent) 决定这一轮要不要施加约束
 *   route.js         给浏览器 chip 用的 HTTP 接口
 *
 * **“谁提供哪些工具”也是这一层的知识**（下面的 keepFor）：gateway 只管“按名单过滤”，
 * 而名单里是三个还是两个元工具，取决于这个会话的 PTC 模式 —— 那是接线，不是网关。
 *
 * 这里只做接线，不实现任何一件具体的事。
 */
import { createCatalog } from './catalog.js'
import { CALL_TOOLS, createCodeTools } from './code-tools.js'
import { CALL_TOOL, FIND_TOOLS, createMetaTools } from './meta-tools.js'
import { installAssembleFilter, installGuard, installNotice } from './gateway.js'
import { createSwitchState } from './switch-state.js'
import { createGatewayRoute, ROUTE } from './route.js'
import { ownerSessionId, parentLookup } from './session-key.js'

export const name = 'dsh-tool-gateway'

/**
 * 注册表与系统提示词是它唯一依赖的两个服务 —— 全部通过运行时契约拿，不 import 任何 DSH 包。
 *
 * `webServer` / `connection`（开关的 HTTP 接口）、`storageDomain`（开关的持久化）、
 * `agents`（按 id 找会话）都**故意不写进 inject**：它们只在"开关的界面与持久化"
 * 这一块用得上，缺了它们网关本身照样工作（headless profile 就是这种情况）。
 * 写进 inject 会让插件在缺任何一个服务时一直停在 PENDING，那是拿核心功能给附件陪葬。
 */
export const inject = ['tools', 'systemPrompt']

/** find_tools 一次返回几条。 */
const DEFAULT_MAX_RESULTS = 5

/**
 * DSH 自己的 PTC 呈现通道的名字。它被注册表无条件保留（`tools.register()` 对它直接抛错），
 * 所以这里只是**读**它 —— 它在可见集里就是“PTC 开着”的判据。
 */
const RUN_CODE_NAME = 'run_code'

/**
 * 安装插件。
 *
 * 是 async 的：开关状态要先打开 storage domain 才能读，而 `isEnabled` 会被
 * assemble 与 guard 在热路径上同步调用。先把状态准备好再注册监听器，
 * 就不会出现"监听器已经挂上、状态还没就绪"的窗口。
 *
 * @param {object} ctx 插件上下文
 * @param {object} [config] 插件配置
 * @param {number} [config.maxResults] find_tools 一次返回几条工具
 * @returns {Promise<void>} 装配完成
 */
export async function apply(ctx, config = {}) {
  const maxResults = Number.isSafeInteger(config?.maxResults) && config.maxResults > 0
    ? config.maxResults
    : DEFAULT_MAX_RESULTS

  // 降级路径的告警只喊一次：过滤出错时每轮都喊会把日志刷爆，
  // 而这个回调的唯一职责就是让人知道"目录没被收窄"。
  let warned = false
  const warnOnce = (error) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn?.(`${name}: ${String(error?.message ?? error)}`)
    } catch {
      // 日志服务不可用时静默 —— 它不影响过滤本身的降级行为。
    }
  }

  // 开关状态。storage 用不了时它自己会降级到内存并 warn，不会让插件加载失败。
  const state = await createSwitchState(ctx, warnOnce)
  ctx.effect(() => () => state.close(), `${name}: 会话开关状态`)

  // 归属会话换算：子代理会话跟随父会话（理由见 session-key.js）。
  const lookup = parentLookup(ctx)

  /**
   * 这个 agent 的会话要不要施加约束。
   *
   * `agent` 缺席的装配是**诊断装配**（`AssembleContext.agent` 的 JSDoc 写着
   * "absent on diagnostics"），不是模型请求；工具执行那边不带 agent 的调用
   * 则是插件自己发起的。两种情况都按默认值处理 —— 而默认值就是开
   * （见 switch-state.js：没有记录 == 开）。换句话说：**"关"必须知道是哪个会话，
   * 不知道就维持约束**，这个方向是刻意选的。
   *
   * @param {object|undefined} agent 目标 agent
   * @returns {boolean} true = 施加工具箱约束
   */
  const enabledFor = (agent) => {
    if (agent === undefined || agent === null) return true
    return state.isEnabled(ownerSessionId(agent.session, lookup))
  }

  // 每个 agent 的工具视图（目录索引 + 可见名字），按代际号缓存。
  //
  // 不能建一份全局的：preset 注册的工具进的是 agent 自己的作用域层，
  // `ctx.tools.schemas()` 不传 scope 只看全局层，那些工具会全部漏掉
  // （社区插件在这里踩过，见 dev-tool-search 的注释）。
  //
  // 缓存用代际号失效：tools/change（注册、注销、作用域限制变化）一响，
  // 已缓存的视图就地作废，下次用到时重建。
  let generation = 0
  const views = new WeakMap()

  ctx.on('tools/change', () => { generation++ })

  /**
   * 取某个 agent 这一轮的工具视图。
   *
   * 索引与可见名字集共用同一份 `ctx.tools.schemas()` 的结果 —— 那个调用要把注册表里
   * 每个定义投影成 schema，在装配与守卫两条热路径上不该走两遍。
   *
   * @param {object|undefined} agent 目标 agent
   * @returns {{ catalog: object, names: Set<string> }} 目录索引与可见工具名
   */
  const viewOf = (agent) => {
    // 诊断路径的装配没有 agent（`AssembleContext.agent` 的 JSDoc 写着
    // "absent on diagnostics"）。现建一份全局视图，不缓存 —— 这条路很少走，
    // 缓存反而多一份要失效的状态。
    if (agent === undefined || agent === null) {
      const schemas = ctx.tools.schemas()
      const catalog = createCatalog()
      catalog.rebuild(schemas)
      return { catalog, names: new Set(schemas.map((schema) => schema.name)) }
    }
    const cached = views.get(agent)
    if (cached !== undefined && cached.generation === generation) return cached
    const schemas = ctx.tools.schemas(agent)
    const catalog = createCatalog()
    catalog.rebuild(schemas)
    const view = { generation, catalog, names: new Set(schemas.map((schema) => schema.name)) }
    views.set(agent, view)
    return view
  }

  const resolveCatalog = (agent) => viewOf(agent).catalog

  /**
   * 这个 agent 现在能不能用 `call_tools`。
   *
   * 两个条件：运行时挂上了，而且 PTC 没开着。
   *
   * **PTC 检测**用公开的 `tools.schemas(agent)`：`view()` 在 `modeFor(scope) !== 'native'`
   * 时把 `run_code` 放进可见集（`core/tools/src/index.ts:1195-1196`），所以三个 mode 全对 ——
   * `native` 没有它，`ptc` / `both` 有。（`wireSchemas` 更直接，但它是 private，不该依赖。）
   *
   * 运行时是**另一个插件**提供的服务，可能在本插件挂载之后才来，也可能根本没来，
   * 所以每次现读，不在 apply 时缓存。
   *
   * 读不出来（服务缺失、注册表抛错）就当**不能用**：少一个能力 ≠ 出错，
   * 而抢 PTC 的位置会真的出错。这不是兼底值，是能力不可用时的降级。
   *
   * @param {object|undefined} agent 目标 agent
   * @returns {boolean} true = 这个会话该有 `call_tools`
   */
  const codeToolsAvailable = (agent) => {
    if (ctx.get('ptcRuntime') === undefined) return false
    try {
      return !viewOf(agent).names.has(RUN_CODE_NAME)
    } catch (error) {
      warnOnce(error)
      return false
    }
  }

  /**
   * 这个 agent 现在能直接调用的元工具。
   *
   * **契约：这个函数永不抛。** 它在装配与守卫两条热路径上被调用，而“会话起不来”
   * 比“少一个工具”严重得多 —— 所以检测失败走降级，不把异常扔给调用方。
   *
   * 为什么要按 agent 算而不是算一次：“PTC 开不开”是**按会话**的事实（preset 可以用
   * `tools.presentAs()` 单独选一个呈现模式），而集合的内容随之变。
   *
   * @param {object|undefined} agent 目标 agent
   * @returns {Set<string>} 可直接调用的元工具名
   */
  const keepFor = (agent) => {
    const names = new Set([FIND_TOOLS, CALL_TOOL])
    if (codeToolsAvailable(agent)) names.add(CALL_TOOLS)
    return names
  }

  for (const definition of createMetaTools({
    ctx, resolveCatalog, maxResults, siblings: [CALL_TOOLS],
  })) {
    ctx.effect(() => ctx.tools.register(definition), `${name}: ${definition.name}`)
  }
  // 第三个元工具无条件注册：apply 时没有 agent 上下文，而“该不该让它露面”
  // 是按 agent 判的（见 keepFor）。它只是躺在注册表里，模型看不到也调不到。
  for (const definition of createCodeTools({ ctx })) {
    ctx.effect(() => ctx.tools.register(definition), `${name}: ${definition.name}`)
  }

  installAssembleFilter(ctx, keepFor, enabledFor, warnOnce)
  installGuard(ctx, keepFor, enabledFor)
  installNotice(ctx, keepFor, enabledFor)

  // 会话开关的 HTTP 接口。
  //
  // **必须用 ctx.inject 延迟取得，不能急切 ctx.get。** webServer 与 connection 都可能比
  // 本插件更晚加载，急切读会拿到 undefined，于是整块被静默跳过 —— 现象是"插件装上了、
  // 网关也照常工作，只有标题栏那个 chip 永远失败"，日志里一个字都不留。
  // （dsh-marduk 与 dsh-better-session-query 都在同一个坑里待过。）
  //
  // 写进 `inject` 也不对：headless profile 没有这两个服务，插件会一直停在 PENDING，
  // 那是拿核心功能给附件陪葬。ctx.inject 两边都不占 —— 服务到了再挂，没到就只是没有界面，
  // 而"没有界面"在 headless 下是设计内的形态，不是错误，所以这里不告警。
  //
  // 回调**绝不能有返回值**：Cordis 把插件回调的返回值当 Effect 处理，返回一个非函数
  // 非对象的值会抛 TypeError("Invalid effect")，让这个 fiber 加载失败、并把已经挂上的
  // 东西一起回滚掉，同样一个字都不留。
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    const connection = webCtx.get('connection')
    if (webServer === undefined || typeof webServer.register !== 'function'
      || connection === undefined || typeof connection.requestRejection !== 'function') {
      warnOnce(new Error('webServer 或 connection 形状不对，会话开关没有界面（网关本身照常工作）'))
      return
    }
    const handler = createGatewayRoute(ctx, state)
    ctx.effect(() => webServer.register({ kind: 'exact', path: ROUTE, handler }), `${name}: 会话开关路由`)
  })
}
