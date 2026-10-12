/**
 * 会话级开关状态：这个会话要不要施加"工具箱"行为约束，以及哪些工具被单独开关过。
 *
 * **总开关默认开。** 插件装上了就是要约束行为 —— 让 agent 每次都先去工具箱里挑工具，
 * 而不是对着一份被截断的工具列表将就。「关」是用户在某个会话里的**显式覆盖**。
 * 所以这里没有记录 == 开，`{ enabled: false }` 才是关。
 *
 * **一个会话记录里存三样偏好**（同一张表，一起读写，因为它们同属「这个会话怎么用工具」）：
 *
 * - `enabled` —— 要不要施加工具箱约束；
 * - `disabledTools` / `enabledTools` —— 用户在面板里逐个开关过的工具名。
 *   它们**互斥**：写入口保证同一个名字不会同时出现在两边，所以判定（groups.js）
 *   可以按"先看关、再看开"的固定顺序读，而不必去定义"两边都有时算哪个"；
 * - `groups` —— 整个工具组的显式覆盖（`组 id → 布尔`）。只有**写过的**组才在这里，
 *   没写过的组跟随它自己声明的默认值（见 groups.js）。
 *
 * 这三样合起来就是面板上的三态：没设置、显式开、显式关。
 *
 * **为什么要有这一层而不是直接在 host.js 里放个 Map**：开关必须跨重启活着。
 * 用户的会话是长寿命的，他给某个会话关掉网关之后重启 DSH，那个会话又开了 —— 那是 bug。
 * 持久化走 DSH 的 storage domain（`$DSH_HOME/storages`），不自己写文件、不自己造轮子。
 *
 * **为什么读是同步的**：`isEnabled` 在两条热路径上被调用 —— `system-prompt/assemble`
 * （每一轮每一次装配）和 `tools.guard`（每一次工具调用）。storage domain 的
 * `table.get(key)` 本来就是同步读内存的（只有写才排队落盘），所以这条路是通的。
 *
 * **schema 为什么是手写的对象**：`DomainTableSpec.valueSchema` 的运行时契约就是
 * 「有一个 `parse(value)` 方法，校验失败就抛」。DSH 用 zod 实现它，但插件**不能**
 * import 任何 `@deepseek-ai/*` 包（那会把插件版本和某个 DSH 版本焊死），
 * 而为了几个布尔值引入 zod 这个运行时依赖也不划算。所以这里提供一个满足同一契约的
 * 普通对象。用到的只有 `parse`（`spec.ts` 的 `defineDomain` 还会对 global 调
 * `safeParse`，但本 spec 不声明 global，所以不涉及）。
 *
 * @module dsh-tool-gateway/switch-state
 */
import { normalizeNames } from './ban.js'

/** 开关的持久化 domain 名。必须匹配 `UNIT_NAME_RE`（`/^[a-z][a-z0-9_]*$/`，不允许连字符）。 */
export const DOMAIN_NAME = 'tool_gateway'

/** 会话记录表名。 */
const TABLE_NAME = 'sessions'

/**
 * 把一条记录里的组覆盖规范化：丢掉非布尔的项，不去改键名。
 *
 * 这一层校验是必要的：`groups` 的键是**别的插件给的组 id**，写进存储之后又读回来，
 * 中间隔着一次磁盘往返。一个被改坏的值（字符串 `"false"` 这种）在这里折叠成
 * 「没写过」，而不是在判定里被当成真值。
 *
 * @param {unknown} value 记录里的 groups 字段
 * @returns {Record<string, boolean>} 只含布尔值的覆盖表
 */
function normalizeGroupOverrides(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const overrides = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.trim() === '' || typeof item !== 'boolean') continue
    overrides[key] = item
  }
  return overrides
}

/**
 * 一条会话记录的形状校验。
 *
 * 认 `{ enabled, disabledTools, enabledTools, groups }`，并把结果规范化成只有这四个
 * 字段 —— 记录里多余的键不会跟着进内存，避免旧版本写下的字段在新版本里阴魂不散。
 *
 * 后三个字段都缺省成空：加它们之前写下的记录只有 `enabled`，仍然要能读，
 * 所以这些是向后兼容的扩展，不需要动 domain 的 version。
 */
const SESSION_RECORD_SCHEMA = {
  parse(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('tool-gateway 会话记录必须是一个对象')
    }
    if (typeof value.enabled !== 'boolean') {
      throw new Error('tool-gateway 会话记录的 enabled 字段必须是布尔值')
    }
    return {
      enabled: value.enabled,
      disabledTools: normalizeNames(value.disabledTools),
      enabledTools: normalizeNames(value.enabledTools),
      groups: normalizeGroupOverrides(value.groups),
    }
  },
}

/**
 * domain 声明。
 *
 * 用默认的 `single` 布局（整个 domain 一个文档）：记录少而小（只有被用户显式改过
 * 的会话），不值得为它走 `per-record`；`single` 布局下 key 也不受 `[a-zA-Z0-9_-]+` 约束。
 */
const DOMAIN_SPEC = {
  name: DOMAIN_NAME,
  version: 1,
  tables: {
    [TABLE_NAME]: { valueSchema: SESSION_RECORD_SCHEMA },
  },
}

/**
 * 把一条读到的记录补全成完整形状。
 *
 * 默认值是产品定义的，不是「读不到就猜一个」：约束默认开，开关过的工具默认为空。
 * 补全过程写在一处，所有读接口就不会对「没有记录」给出两种答案。
 *
 * @param {object|undefined} stored 存储里读到的记录
 * @returns {{enabled: boolean, disabledTools: string[], enabledTools: string[], groups: Record<string, boolean>}}
 *   补全后的记录
 */
function complete(stored) {
  return {
    enabled: stored?.enabled ?? true,
    disabledTools: stored?.disabledTools ?? [],
    enabledTools: stored?.enabledTools ?? [],
    groups: stored?.groups ?? {},
  }
}

/**
 * 改写记录里的工具开关。
 *
 * 互斥就发生在这一处：关掉一个名字就把它从 `enabledTools` 里拿走，反之亦然。
 * 两个集合天然不相交，判定那边就不用去定义"两边都有算哪个"。
 *
 * @param {object} record 当前记录（不会被改）
 * @param {string[]} names 要改的名字
 * @param {boolean} disabled true = 关掉它们
 * @returns {object} 新的记录
 */
function withTools(record, names, disabled) {
  const off = new Set(record.disabledTools)
  const on = new Set(record.enabledTools)
  for (const name of names) {
    if (disabled) { off.add(name); on.delete(name) } else { off.delete(name); on.add(name) }
  }
  return {
    enabled: record.enabled,
    disabledTools: [...off],
    enabledTools: [...on],
    groups: record.groups,
  }
}

/**
 * 造一条按会话串行的写入链。
 *
 * **为什么必须有它**：每个写接口都是「读当前记录 → 改一个字段 → 写回」，而 `table.put`
 * 是异步的。面板上连着点两下开关（或者整组开关与单工具开关先后到达）就是两次这样的
 * 读-改-写，两次都读到同一份旧记录，后写的那次把先写的那次抹掉 —— 用户会看到自己
 * 刚打开的工具又关上了。串行化把这一段变成原子的。
 *
 * 串行只按会话分：不同会话之间没有共享字段，没有理由让它们互相等。
 *
 * 前一次失败不该卡住后面：`then(task, task)` 让本次无论上一轮成败都照常执行。
 * 链条上只留一个「已结束」的信号，不留结果也不让异常往上冒 —— 异常要交给**本次**的
 * 调用方（它就是 `result`），而不是变成下一次写入的前置错误。
 *
 * @returns {(sessionId: string, task: () => Promise<void>) => Promise<void>} 串行执行器
 */
function createWriteChain() {
  /** 会话 id → 该会话当前那条链的结束信号。链排空后条目会被清掉，不随会话数增长。 */
  const chains = new Map()
  return (sessionId, task) => {
    const previous = chains.get(sessionId) ?? Promise.resolve()
    const result = previous.then(task, task)
    const settled = result.then(() => {}, () => {})
    chains.set(sessionId, settled)
    void settled.then(() => {
      if (chains.get(sessionId) === settled) chains.delete(sessionId)
    })
    return result
  }
}

/**
 * 一个会话的偏好，摊成判定要的形状（见 groups.js 的 toolEnabled）。
 *
 * @param {object} record 完整记录
 * @returns {{enabled: boolean, disabledTools: Set<string>, enabledTools: Set<string>, groups: Map<string, boolean>}}
 *   会话偏好
 */
function toPrefs(record) {
  return {
    enabled: record.enabled,
    disabledTools: new Set(record.disabledTools),
    enabledTools: new Set(record.enabledTools),
    groups: new Map(Object.entries(record.groups)),
  }
}

/**
 * domain 用不了时的替身：行为与真身一致，只是不持久。
 *
 * "行为一致"是刻意的：降级路径上如果少支持一种写法，用户会在存储出故障的那次会话里
 * 看到一个和平时不一样的面板，而那种差异最难归因。
 *
 * @param {Map<string, object>} store 内存里的会话记录表
 * @returns {object} 与 createSwitchState 同形的句柄
 */
function memoryOnly(store) {
  const chain = createWriteChain()
  const recordOf = (sessionId) => complete(store.get(sessionId))
  /**
   * 一次读-改-写。改法（`change`）与真身共用同一批函数，两条路不会分叉。
   *
   * @param {string} sessionId 归属会话 id
   * @param {(record: object) => object} change 把当前记录变成新记录
   * @returns {Promise<void>} 写完（内存里是同步的）之后 resolve
   */
  const update = (sessionId, change) => chain(sessionId, async () => {
    store.set(sessionId, change(recordOf(sessionId)))
  })
  return {
    isEnabled(sessionId) {
      return recordOf(sessionId).enabled
    },
    prefs(sessionId) {
      return toPrefs(recordOf(sessionId))
    },
    setEnabled(sessionId, enabled) {
      return update(sessionId, (record) => ({ ...record, enabled }))
    },
    setToolsDisabled(sessionId, names, disabled) {
      if (names.length === 0) return Promise.resolve()
      return update(sessionId, (record) => withTools(record, names, disabled))
    },
    setToolDisabled(sessionId, name, disabled) {
      return update(sessionId, (record) => withTools(record, [name], disabled))
    },
    setGroupEnabled(sessionId, groupId, enabled) {
      return update(sessionId, (record) => ({ ...record, groups: { ...record.groups, [groupId]: enabled } }))
    },
    async close() {},
  }
}

/**
 * 打开开关状态。
 *
 * @param {object} ctx 插件上下文
 * @param {(error: unknown) => void} warnOnce 降级时的告警回调（只喊一次）
 * @returns {Promise<object>} 开关状态的读写句柄
 */
export async function createSwitchState(ctx, warnOnce) {
  // 降级路径用的内存表。domain 可用时不用它 —— 那种情况下 domain 自己的表
  // 就是内存权威（它同样是"内存为准 + 异步落盘"），再存一份只会让两份状态不同步。
  const fallback = new Map()

  const facility = ctx.get('storageDomain')
  if (facility === undefined) {
    warnOnce(new Error('storageDomain 服务不可用，开关将只存在于内存里（重启后复位）'))
    return memoryOnly(fallback)
  }

  let domain
  try {
    domain = await facility.open(DOMAIN_SPEC)
  } catch (error) {
    // open 失败（后端路由缺失、介质损坏、记录不合法……）不该让整个插件加载失败：
    // 网关的核心功能是把工具目录收窄，那件事和持久化无关。降级到内存并如实报告。
    warnOnce(error)
    return memoryOnly(fallback)
  }

  const table = domain.table(TABLE_NAME)
  const recordOf = (sessionId) => complete(table.get(sessionId))

  const chain = createWriteChain()

  /**
   * 一次读-改-写。所有写入口都走它，于是两件事只有一个地方能违背：
   * 「四个字段一起写」与「同一个会话的写入串行」。
   *
   * 总是写入显式记录（而不是删除记录回到默认）：用户切回「开」也是一个决定，
   * 将来默认值若变化，这个会话不该跟着变。
   *
   * 读必须发生在链**内**：链外读到的可能是上一次写入还没落盘时的旧记录。
   *
   * @param {string} sessionId 归属会话 id
   * @param {(record: object) => object} change 把当前记录变成新记录
   * @returns {Promise<void>} 落盘之后 resolve
   */
  const update = (sessionId, change) => chain(sessionId, async () => {
    const record = change(recordOf(sessionId))
    await table.put(sessionId, {
      enabled: record.enabled,
      disabledTools: record.disabledTools,
      enabledTools: record.enabledTools,
      groups: record.groups,
    })
  })

  return {
    /**
     * 这个会话的开关是不是开着。
     * @param {string} sessionId 归属会话 id
     * @returns {boolean} true = 施加工具箱约束
     */
    isEnabled(sessionId) {
      return recordOf(sessionId).enabled
    },

    /**
     * 这个会话的完整偏好，摊成判定要的形状。
     * @param {string} sessionId 归属会话 id
     * @returns {object} 会话偏好（见 {@link toPrefs}）
     */
    prefs(sessionId) {
      return toPrefs(recordOf(sessionId))
    },

    /**
     * 写下一个会话的总开关。
     * @param {string} sessionId 归属会话 id
     * @param {boolean} enabled 新状态
     * @returns {Promise<void>} 落盘之后 resolve
     */
    setEnabled(sessionId, enabled) {
      return update(sessionId, (record) => ({ ...record, enabled }))
    },

    /**
     * 开关一个工具。
     * @param {string} sessionId 归属会话 id
     * @param {string} name 工具名
     * @param {boolean} disabled true = 关掉它，false = 显式打开它
     * @returns {Promise<void>} 落盘之后 resolve
     */
    setToolDisabled(sessionId, name, disabled) {
      return update(sessionId, (record) => withTools(record, [name], disabled))
    },

    /**
     * 一次开或关一批工具。
     *
     * 批量走一次 `put` 是有意的：面板上的"整组开关"可能涉及几百个名字，逐条落盘
     * 会写出一串中间态，用户在那之间刷新会看到一个自己没下过的组合。
     *
     * @param {string} sessionId 归属会话 id
     * @param {string[]} names 工具名数组
     * @param {boolean} disabled true = 关掉它们
     * @returns {Promise<void>} 落盘之后 resolve
     */
    setToolsDisabled(sessionId, names, disabled) {
      if (names.length === 0) return Promise.resolve()
      return update(sessionId, (record) => withTools(record, names, disabled))
    },

    /**
     * 写下一个工具组的显式覆盖。
     *
     * 只影响**没有**被逐个开关过的成员：单个工具的显式开关优先于组（见 groups.js）。
     *
     * @param {string} sessionId 归属会话 id
     * @param {string} groupId 组 id
     * @param {boolean} enabled true = 整组打开
     * @returns {Promise<void>} 落盘之后 resolve
     */
    setGroupEnabled(sessionId, groupId, enabled) {
      return update(sessionId, (record) => ({ ...record, groups: { ...record.groups, [groupId]: enabled } }))
    },

    /**
     * 释放 domain。由 `ctx.effect` 的 disposer 调用；domain 的写入链会先排空。
     * @returns {Promise<void>} 关闭完成
     */
    async close() {
      await domain.close()
    },
  }
}
