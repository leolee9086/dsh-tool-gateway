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
import { createBanGuard, installBanVisibility, resolveBanOptions } from './ban.js'
import { createCatalog } from './catalog.js'
import { CALL_TOOLS, createCodeTools } from './code-tools.js'
import { CALL_TOOL, FIND_TOOLS, createMetaTools } from './meta-tools.js'
import { installAssembleFilter, installGuard, installNotice } from './gateway.js'
import { createGroupRegistry, toolEnabled } from './groups.js'
import { createSwitchState } from './switch-state.js'
import { createGatewayRoute, ROUTE } from './route.js'
import { ownerSessionId, parentLookup } from './session-key.js'
import { resultTokenBudget } from './search-results.js'
import { authorizeDisabledQuery } from './disabled-query.js'

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

/** 三个元工具名。它们在面板里不可关 —— 关了就等于把这个会话的工具入口全部封死。 */
const META_TOOL_NAMES = new Set([FIND_TOOLS, CALL_TOOL, CALL_TOOLS])

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
  const budget = resultTokenBudget(config.search?.resultTokenBudget)
  const measure = text => {
    const meter = ctx.get('tokenMeter')
    if (typeof meter?.estimateMessage !== 'function') throw new Error('工具搜索需要 tokenMeter.estimateMessage 服务')
    return meter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] })
  }
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

  // ── 硬禁用名单（原 dsh-tool-ban 的能力） ──────────────────────────────────
  //
  // 配置放在 config.ban 里，与网关自己的 maxResults 分开：前者是「任何会话都不许」，
  // 后者是「网关怎么工作」。混在同一层里，读配置的人迟早会把两者看成一回事。
  const banOptions = resolveBanOptions(config?.ban)

  /** 静态名单的判定。纯函数，命中就给出拒绝理由，不命中返回 undefined。 */
  const staticBan = createBanGuard(banOptions.deny, banOptions.reason)

  // ── 工具组与会话偏好 ────────────────────────────────────────────────────
  //
  // 「这个工具现在能不能用」= 会话偏好（显式开 / 显式关）+ 它所属工具组的默认值，
  // 判定在 groups.js。这一层负责把两者接起来，并按代际号缓存每个 agent 的偏好 ——
  // 守卫在**每一次**工具调用上都要问这个问题，每次现读存储、现建三个集合是不必要的开销。

  // 每个 agent 的工具视图（目录索引 + 可见名字），按代际号缓存。
  //
  // 不能建一份全局的：preset 注册的工具进的是 agent 自己的作用域层，
  // `ctx.tools.schemas()` 不传 scope 只看全局层，那些工具会全部漏掉
  // （社区插件在这里踩过，见 dev-tool-search 的注释）。
  //
  // 缓存用代际号失效：tools/change（注册、注销、作用域限制变化）一响，
  // 已缓存的视图就地作废，下次用到时重建。
  let generation = 0
  // 面板改了「这个会话关掉哪些工具」也要让视图失效 —— 否则 find_tools 还会把刚关掉的
  // 工具列出来，模型照着调一次又被守卫拒绝。两件事都改变视图，所以各有一个计数。
  let prefs = 0
  const views = new WeakMap()

  ctx.on('tools/change', () => { generation++ })

  /** 会话级偏好变了：作废所有已缓存的视图，下次用到时重建。 */
  const invalidate = () => { prefs++ }

  /**
   * 工具组名册。
   *
   * 组由**别的插件**注册（见下面 `toolGateway` 服务的 `registerGroup`）：它们才能
   * 说清楚「这一批工具默认先关着」，而网关自己不该认识任何具体插件。
   * 组内容一变就作废视图缓存 —— 默认值变了，模型看得见的目录跟着变。
   */
  const registry = createGroupRegistry(invalidate)

  /** 每个 agent 的会话偏好，按代际号失效（与 views 同一种做法）。 */
  const prefsViews = new WeakMap()

  /**
   * 取一个 agent 的会话偏好。
   *
   * agent 缺席时不查（诊断装配与插件自己发起的调用都属于这一类）：它们不是某个会话里
   * 模型的手，会话级的偏好管不到它们。
   *
   * @param {object} agent 目标 agent
   * @returns {object} 会话偏好（见 switch-state.js 的 prefs）
   */
  const prefsFor = (agent) => {
    const cached = prefsViews.get(agent)
    if (cached !== undefined && cached.generation === prefs) return cached.prefs
    const value = state.prefs(ownerSessionId(agent.session, lookup))
    prefsViews.set(agent, { generation: prefs, prefs: value })
    return value
  }

  /**
   * 这个工具此刻能不能用。
   *
   * 两件事合在这里：部署级的静态禁用名单（任何会话都不许）与会话偏好 + 工具组
   * （这个会话用不用它）。守卫和面板都问它，于是两处的答案不会分叉。
   *
   * agent 缺席时只算静态名单 —— 会话偏好本来就不该管到诊断路径上。
   *
   * @param {object|undefined} agent 目标 agent
   * @param {string} name 工具名
   * @returns {boolean} true = 模型可以用它
   */
  const usableNow = (agent, name) => {
    if (banOptions.deny.includes(name)) return false
    if (agent === undefined || agent === null) return true
    return toolEnabled(name, prefsFor(agent), registry.groupOf(name))
  }

  /**
   * 这条调用是不是被硬禁用。**这是守卫里的第一段判断**（见 gateway.js）。
   *
   * 两段合起来才是完整语义：静态名单管「部署不让用」，会话记录与工具组管
   * 「我这次不想让它用」。两段都不看 parent —— 所以 call_tool 也绕不过去。
   *
   * 拒绝理由里**不区分**「你关的」与「它所在的组默认关着」：模型要做的是同一件事
   * （告诉用户去面板里打开它），而说清楚是哪一种只会把面板的内部概念塞进工具结果。
   *
   * @param {object} execution 工具执行身份
   * @returns {string|undefined} 拒绝理由，放行时 undefined
   */
  const banFor = (execution) => {
    const name = execution?.name
    if (typeof name !== 'string') return undefined
    const staticReason = staticBan(execution)
    if (staticReason !== undefined) return staticReason
    if (usableNow(execution?.agent, name)) return undefined
    return '工具「' + name + '」现在用不了（本会话里关掉了它，或者它所在的工具组默认关着）。'
      + '要重新用它，先在右侧栏的工具箱面板里打开它。'
  }

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

  /**
   * 取某个 agent 这一轮的工具视图。
   *
   * 索引与可见名字集共用同一份 `ctx.tools.schemas()` 的结果 —— 那个调用要把注册表里
   * 每个定义投影成 schema，在装配与守卫两条热路径上不该走两遍。
   *
   * 同一份结果还要给出「按名字取 schema」—— 派发子调用时要用（见下面 resolveSchema），
   * 而投影成本已经付过了，没有理由为它再算一遍。
   *
   * @param {object|undefined} agent 目标 agent
   * @returns {{ catalog: object, names: Set<string>, schemas: Map<string, object> }}
   *   目录索引、可见工具名、按名字索引的 schema
   */
  const viewOf = (agent) => {
    // 诊断路径的装配没有 agent（`AssembleContext.agent` 的 JSDoc 写着
    // "absent on diagnostics"）。现建一份全局视图，不缓存 —— 这条路很少走，
    // 缓存反而多一份要失效的状态。
    if (agent === undefined || agent === null) {
      const schemas = ctx.tools.schemas()
      const catalog = createCatalog()
      catalog.rebuild(schemas)
      return {
        catalog,
        names: new Set(schemas.map((schema) => schema.name)),
        schemas: new Map(schemas.map((schema) => [schema.name, schema])),
      }
    }
    const cached = views.get(agent)
    if (cached !== undefined && cached.generation === generation && cached.prefs === prefs) return cached
    const schemas = ctx.tools.schemas(agent)
    // 索引里只放**没被关掉**的工具：关掉的工具模型调不动（守卫拒绝），
    // 让它出现在 find_tools 的结果里只会把模型引向一次必然失败的调用。
    // `names` 不过滤 —— 它是 PTC 判据的输入，回答的是「注册表里有什么」，
    // 不是「模型能用什么」。
    const catalog = createCatalog()
    catalog.rebuild(schemas.filter((schema) => usableNow(agent, schema.name)))
    const view = {
      generation,
      prefs,
      catalog,
      names: new Set(schemas.map((schema) => schema.name)),
      schemas: new Map(schemas.map((schema) => [schema.name, schema])),
    }
    views.set(agent, view)
    return view
  }

  const resolveCatalog = (agent) => viewOf(agent).catalog
  const resolveDisabledCatalog = agent => {
    // 部署级禁用的工具**不进**这份目录：它们不是「现在关着、去面板里能打开」，
    // 而是「这个部署不让用」，列在这里只会让模型建议用户去做一件做不到的事。
    const catalog = createCatalog()
    catalog.rebuild([...viewOf(agent).schemas.values()]
      .filter(schema => !banOptions.deny.includes(schema.name) && !usableNow(agent, schema.name)))
    return catalog
  }

  /**
   * 按名字取某个 agent 看得见的工具 schema。
   *
   * 派发子调用时把它交给注册表（见 meta-tools.js 的 invokeTool）：逐调用审查靠它回答
   * "这一步要执行什么"，缺了就只能在那次调用执行之前拒掉。走 viewOf 是为了跟装配、
   * 守卫共用同一份投影结果 —— 那份成本没必要为每一次子调用再付。
   *
   * @param {object|undefined} agent 目标 agent
   * @param {string} name 工具名
   * @returns {object|undefined} 不在这个 agent 的可见集里时是 undefined
   */
  const resolveSchema = (agent, name) => viewOf(agent).schemas.get(name)

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

  /**
   * 面板要的工具清单。
   *
   * **这是给人看的数据，不是模型可见工具表。** 它包含被网关收起来的全部工具 ——
   * 那正是面板存在的理由：网关让模型看不见它们，面板让人看得见、管得着。
   *
   * 每一条都带三样面板需要的东西：`enabled`（这个会话现在能不能用它）、
   * `explicit`（用户单独开过或关过它没有）和 `group`（它属于哪个组）。
   * `explicit` 是给显示用的：**「你关的」和「这个组默认关着」是两件事**，
   * 混在一起用户会以为自己关过几百个工具。
   *
   * 契约：这个函数不抛。面板读不到清单只是面板空着，不该让插件加载失败。
   *
   * @param {object|undefined} agent 目标 agent
   * @returns {Array<object>} 工具清单，按名字排序
   */
  const listTools = (agent) => {
    let schemas = []
    try {
      schemas = ctx.tools.schemas(agent)
    } catch (error) {
      warnOnce(error)
      return []
    }
    const prefs = agent === undefined || agent === null ? null : prefsFor(agent)
    return schemas.map((schema) => {
      const group = registry.groupOf(schema.name)
      return {
        name: schema.name,
        description: typeof schema.description === 'string' ? schema.description : '',
        enabled: usableNow(agent, schema.name),
        banned: banOptions.deny.includes(schema.name),
        core: META_TOOL_NAMES.has(schema.name),
        explicit: prefs === null ? null
          : prefs.disabledTools.has(schema.name) ? 'off'
            : prefs.enabledTools.has(schema.name) ? 'on' : null,
        group: group === undefined ? null : group.id,
        groupTitle: group === undefined ? null : group.title,
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 把「注册工具组」作为服务提供给别的插件。
   *
   * 这是本插件唯一对外发布的能力，也是「新增工具默认关闭」的落地方式：注册方能声明
   * 一批工具默认关着（见 groups.js），用户再在面板里按组或按单个工具打开。
   * 网关自己不认识任何具体插件 —— 思源那套端点、将来别的插件要加的工具，都走这里。
   *
   * 服务对象是冻结的：拿到它的插件只能调这几个方法，不能顺着它摸到网关的内部状态。
   * 组句柄也重新包了一层，为的是**每一次改动都作废视图缓存** —— 否则注册方加完成员，
   * 模型那边要等到下一次 tools/change 才看得见新的默认值。
   */
  /**
   * 已注册的组，摊成给面板与诊断读的形状。
   *
   * 只给出注册方能声明的那几样，不把内部的 `names` 集合漏出去：面板要的是「这一组多大」，
   * 不是名单本身 —— 每个工具连同它的组已经在那份清单里了。
   *
   * @returns {Array<object>} 组列表，按注册顺序
   */
  const describeGroups = () => registry.list().map((group) => ({
    id: group.id,
    title: group.title,
    origin: group.origin,
    defaultEnabled: group.defaultEnabled,
    size: group.names.size,
  }))

  ctx.provide('toolGateway', Object.freeze({
    /**
     * 注册一个工具组。
     *
     * @param {object} spec 组声明（见 groups.js 的 register）
     * @returns {object} 组句柄：add / remove / setDefaultEnabled / dispose
     */
    registerGroup(spec) {
      const handle = registry.register(spec)
      invalidate()
      return Object.freeze({
        add: (toolName) => { handle.add(toolName); invalidate() },
        remove: (toolName) => { handle.remove(toolName); invalidate() },
        setDefaultEnabled: (value) => { handle.setDefaultEnabled(value); invalidate() },
        dispose: () => { handle.dispose(); invalidate() },
      })
    },

    /**
     * 已注册的组。面板用它分组显示，诊断时也读它。
     *
     * @returns {Array<object>} 组列表，按注册顺序
     */
    listGroups: describeGroups,
  }))

  for (const definition of createMetaTools({
    ctx, resolveCatalog, resolveSchema, maxResults, siblings: [CALL_TOOLS],
    budget, measure, resolveDisabledCatalog, authorizeDisabled: exec => authorizeDisabledQuery(ctx, exec),
  })) {
    ctx.effect(() => ctx.tools.register(definition), `${name}: ${definition.name}`)
  }
  // 第三个元工具无条件注册：apply 时没有 agent 上下文，而“该不该让它露面”
  // 是按 agent 判的（见 keepFor）。它只是躺在注册表里，模型看不到也调不到。
  for (const definition of createCodeTools({ ctx, resolveSchema })) {
    ctx.effect(() => ctx.tools.register(definition), `${name}: ${definition.name}`)
  }

  installAssembleFilter(ctx, keepFor, enabledFor, warnOnce)
  installGuard(ctx, keepFor, enabledFor, banFor)
  installNotice(ctx, keepFor, enabledFor)
  // 可见性那一半（原 dsh-tool-ban 的 restrict 逻辑）。网关开着的会话里它是多余的 ——
  // 目录本来就只剩元工具；网关被关掉的会话才用得上它，那种会话暴露的是完整工具表。
  installBanVisibility(ctx, banOptions)

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
    const handler = createGatewayRoute(ctx, state, {
      listTools, invalidate, coreNames: META_TOOL_NAMES, listGroups: describeGroups,
    })
    ctx.effect(() => webServer.register({ kind: 'exact', path: ROUTE, handler }), `${name}: 会话开关与工具箱面板路由`)
  })
}
