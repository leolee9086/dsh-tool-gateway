/**
 * 硬禁用名单：某些工具在**任何**会话、**任何**调用路径上都不许执行。
 *
 * 这一模块原本是独立插件 dsh-tool-ban，现在并进网关。合并的理由是两者共用同一个
 * 接口 `ctx.tools.guard`：网关的守卫是「除元工具外一律拒绝」，禁用名单是「这几个名字
 * 一律拒绝」，它们本来就该是同一条守卫上的两段判断，分成两个插件只会让拒绝理由的
 * 先后顺序变成两个包之间的隐式约定。
 *
 * **并入之后的两条判断顺序（写在 gateway.js 的守卫里）：**
 *
 * 1. 硬禁用先判，而且不看 `execution.parent` —— 于是 `ask_user_question` 这类名字连
 *    `call_tool` 的子分发也绕不过去。这是「禁用」与「没露面」的区别：没露面只挡住
 *    模型直接调用，禁用挡住一切路径。
 * 2. 网关规则后判，它对子分发是放行的（理由见 gateway.js）。
 *
 * 这一模块自己只留**可见性屏蔽**那一半（`installBanVisibility`）：让模型连看都看不到。
 * 它在网关关掉的会话里仍然有用 —— 那种会话暴露完整工具表。
 */

/**
 * 没有配置 `ban.deny` 时用的默认名单。
 *
 * `ask_user_question` 是**选择题卡片**那一类交互：它把决策权用选项菜单收走，
 * 而本部署希望模型把推理、约束、默认取法写清楚，让用户用打字回答。
 * 注意禁的是这个工具，不是「提问」本身 —— 模型在正文里提问仍然允许。
 */
export const DEFAULT_DENY = ['ask_user_question']

/**
 * 默认拒绝理由。会被写进工具结果交给模型读，因此写的是"接下来该怎么办"，
 * 而不是一条内部错误码。
 *
 * 措辞要点：禁的是这个工具（卡片式选择范式），不是"提问"本身。模型在正文里
 * 提问仍然允许，而且应当把推理、约束、默认取法和假设讲清楚，让用户用打字回答。
 */
export const DEFAULT_REASON = 'ask_user_question（选择题卡片）已被部署策略禁用：不要用选项菜单让用户做决定。'
  + '真的无法自己拍板时，仍然可以在正文里直接提问——把你的推理、约束、默认取法，'
  + '以及你打算据此进行的假设讲清楚，让用户用打字回答，由用户来设框架。'

/** 可见性屏蔽的重试次数上限（按 agent 计）。 */
export const DEFAULT_MAX_HIDE_ATTEMPTS = 5

/**
 * 归一化工具名列表：丢弃非字符串与空白项，去重并保持顺序。
 * @param value - 配置里给的 `deny`，可以是数组、单个字符串，或未提供。
 * @returns 干净的工具名数组。
 */
export function normalizeNames(value) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  const names = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name === '' || names.includes(name)) continue
    names.push(name)
  }
  return names
}

/**
 * 把配置折算成一份确定的选项。
 *
 * `deny` 的两种缺省是**刻意分开**的：完全没写 `deny` 时用 {@link DEFAULT_DENY}，
 * 显式写成空数组则表示「这次一个都不禁」。合并之前这一条是反过来的（空数组也回落
 * 到默认值），理由是「配置写空了就等于没装」；但网关本来就装着，禁用只是它的一项
 * 附加能力，把空数组当成显式关闭更符合读配置的人的预期。
 *
 * @param {object} [config] - 插件配置里的 ban 段。
 * @returns {{deny: string[], hide: boolean, reason: string, maxHideAttempts: number}} 归一化后的选项。
 */
export function resolveBanOptions(config = {}) {
  const explicit = normalizeNames(config.deny)
  const attempts = Number.isInteger(config.maxHideAttempts) && config.maxHideAttempts > 0
    ? config.maxHideAttempts
    : DEFAULT_MAX_HIDE_ATTEMPTS
  return {
    deny: config.deny === undefined ? [...DEFAULT_DENY] : explicit,
    hide: config.hide !== false,
    reason: typeof config.reason === 'string' && config.reason.trim() !== ''
      ? config.reason
      : DEFAULT_REASON,
    maxHideAttempts: attempts,
  }
}

/**
 * 造一个纯函数：命中禁用名单就返回拒绝理由，否则返回 `undefined` 放行。
 *
 * 它**不自己注册** —— 而是交给 gateway.js 的守卫当作第一段判断调用，这样禁用与网关
 * 规则共用同一条单调守卫，拒绝的先后顺序在代码里就是可见的。
 *
 * @param {string[]} deny - 禁用的工具名。
 * @param {string} reason - 拒绝理由（会被模型读到）。
 * @returns {(execution: object) => string|undefined} 判定函数。
 */
export function createBanGuard(deny, reason) {
  const banned = new Set(deny)
  return execution => banned.has(execution?.name) ? reason : undefined
}

/**
 * 安全读一个可选服务；读不到就返回 `undefined`，让插件优雅降级而不是激活失败。
 * @param ctx - 插件上下文。
 * @param name - 服务名。
 * @returns 服务实例或 `undefined`。
 */
function optionalService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    // 可选服务的读取失败只影响它自己那点增强能力（例如装载时补扫已有 agent），
    // 调用方已经按 undefined 降级，这里可以安全吞掉。
    return undefined
  }
}

/**
 * 安装可见性屏蔽：按 agent 抹掉模型可见工具表。
 *
 * **执行那一半不在这里**，它由 gateway.js 的守卫统一执行（理由见模块顶部）。这里只负责
 * 让模型看不见 —— 它在网关被关掉的会话里仍然有用，那种会话暴露的是完整工具表。
 *
 * @param {object} ctx - 插件上下文（profile 层，即根作用域）。
 * @param {object} options - 已经归一化的选项，即 {@link resolveBanOptions} 的产物。
 * @returns {object} 原样返回 options，供自检与测试断言。
 */
export function installBanVisibility(ctx, options) {
  const { deny, hide, maxHideAttempts } = options

  if (!hide) return options

  // ── 可见性屏蔽 ────────────────────────────────────────────────────────────
  const hidden = new WeakSet()
  const attempts = new WeakMap()
  // 限制本身归 agent 作用域所有、随 agent 销毁自动撤销；这里额外握住它的卸载函数，
  // 是为了让生命周期显式化：作用域一旦先走一步，也不会留下悬空的限制。
  const releases = new Map()

  /** 该 agent 此刻实际看得见哪些被屏蔽的名字。 */
  const visibleTo = agent => {
    const found = []
    for (const name of deny) {
      try {
        if (ctx.tools.get(name, agent) !== undefined) found.push(name)
      } catch {
        // 读视图失败按"看不见"处理：真正的强制由守卫负责，这里不作为不影响安全。
      }
    }
    return found
  }

  /**
   * 尝试为这个 agent 抹掉工具表。
   * @returns 本次是否真的注册了限制。
   */
  const hideFor = agent => {
    if (agent === undefined || agent === null || hidden.has(agent)) return false
    const scope = agent.ctx
    if (scope === undefined || scope === null || scope.tools === undefined) {
      hidden.add(agent)
      return false
    }
    const targets = visibleTo(agent)
    // 一个都看不见有两种可能：该 preset 本就没有这个工具，或者 preset 还没挂载完。
    // 前者无需处理，后者要留给下一次尝试，所以这里不标记完成。
    if (targets.length === 0) return false
    try {
      const release = scope.tools.restrict({ deny: targets })
      if (typeof release === 'function') releases.set(agent, release)
      hidden.add(agent)
      return true
    } catch {
      // agent 已销毁、注册被拒、或该名字不可限制：交给守卫兜底，不打断 agent 生命周期。
      return false
    }
  }

  /** 带次数上限的尝试：给"这个 preset 本来就没有这个工具"的 agent 收口。 */
  const tryHide = agent => {
    if (agent === undefined || agent === null || hidden.has(agent)) return
    if (hideFor(agent)) return
    const used = (attempts.get(agent) ?? 0) + 1
    attempts.set(agent, used)
    if (used >= maxHideAttempts) hidden.add(agent)
  }

  // 新 agent：创建时就抹掉，早于它的第一次请求组装。
  ctx.on('agent/created', ({ agent }) => {
    try {
      tryHide(agent)
    } catch {
      // 事件处理器不能把异常抛回 agent 创建流程（那会否决创建）。
    }
  })

  // 兜底重试：preset 尚未挂载完、或工具是后来才注册的，在下一次请求组装前补上。
  // pre-step 是瀑布，必须把 next() 交下去，否则会短路整条链路。
  ctx.on('agent/pre-step', ({ agent }, next) => {
    try {
      tryHide(agent)
    } catch {
      // 同上：屏蔽失败绝不能让这一步走不下去。
    }
    return next()
  })

  // agent 走完就撤销它那份限制，不让悬空条目留在进程里。
  ctx.on('agent/disposed', ({ agent }) => {
    const release = releases.get(agent)
    if (release === undefined) return
    releases.delete(agent)
    try {
      release()
    } catch {
      // 作用域已经先行撤销时，卸载函数抛错无意义，忽略。
    }
  })

  // 装载时补扫：已经活着的会话（插件是热挂上去的）也要立刻生效。
  const agents = optionalService(ctx, 'agents')
  let existing = []
  try {
    existing = agents?.list?.() ?? []
  } catch {
    existing = []
  }
  for (const agent of existing) {
    try {
      tryHide(agent)
    } catch {
      // 单个 agent 处理失败不影响其余 agent。
    }
  }

  return options
}
