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
 * 这里只做接线，不实现任何一件具体的事。
 */
import { createCatalog } from './catalog.js'
import { META_TOOL_NAMES, createMetaTools } from './meta-tools.js'
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

  // 目录索引按 agent 惰性构建并缓存。
  //
  // 不能建一份全局的：preset 注册的工具进的是 agent 自己的作用域层，
  // `ctx.tools.schemas()` 不传 scope 只看全局层，那些工具会全部漏掉
  // （社区插件在这里踩过，见 dev-tool-search 的注释）。
  //
  // 缓存用代际号失效：tools/change（注册、注销、作用域限制变化）一响，
  // 已缓存的索引就地作废，下次用到时重建。
  let generation = 0
  const catalogs = new WeakMap()

  ctx.on('tools/change', () => { generation++ })

  const resolveCatalog = (agent) => {
    // 诊断路径的装配没有 agent。现建一份全局视图的索引，不缓存。
    if (agent === undefined || agent === null) {
      const catalog = createCatalog()
      catalog.rebuild(ctx.tools.schemas())
      return catalog
    }
    const cached = catalogs.get(agent)
    if (cached !== undefined && cached.generation === generation) return cached.catalog
    const catalog = createCatalog()
    catalog.rebuild(ctx.tools.schemas(agent))
    catalogs.set(agent, { generation, catalog })
    return catalog
  }

  const keep = new Set(META_TOOL_NAMES)

  for (const definition of createMetaTools({ ctx, resolveCatalog, maxResults })) {
    ctx.effect(() => ctx.tools.register(definition), `${name}: ${definition.name}`)
  }

  installAssembleFilter(ctx, keep, enabledFor, warnOnce)
  installGuard(ctx, keep, enabledFor)
  installNotice(ctx, enabledFor)

  // 会话开关的 HTTP 接口。webServer 或 connection 不在时整块跳过：
  // 那样就没有浏览器侧的开关，但网关本身照常工作。
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && ctx.get('connection') !== undefined) {
    const handler = createGatewayRoute(ctx, state)
    ctx.effect(() => {
      const unregister = webServer.register({ kind: 'exact', path: ROUTE, handler })
      return () => { unregister() }
    }, `${name}: 会话开关路由`)
  } else {
    warnOnce(new Error('webServer 或 connection 不可用，会话开关没有界面（网关本身照常工作）'))
  }
}
