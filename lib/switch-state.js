/**
 * 会话级开关状态：这个会话要不要施加"工具箱"行为约束。
 *
 * **默认开。** 插件装上了就是要约束行为 —— 让 agent 每次都先去工具箱里挑工具，
 * 而不是对着一份被截断的工具列表将就。"关"是用户在某个会话里的**显式覆盖**。
 * 所以这里没有记录 == 开，`{ enabled: false }` 才是关。
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
 * 而为了一个布尔值引入 zod 这个运行时依赖也不划算。所以这里提供一个满足同一契约的
 * 普通对象。用到的只有 `parse`（`spec.ts` 的 `defineDomain` 还会对 global 调
 * `safeParse`，但本 spec 不声明 global，所以不涉及）。
 *
 * @module dsh-tool-gateway/switch-state
 */

/** 开关的持久化 domain 名。必须匹配 `UNIT_NAME_RE`（`/^[a-z][a-z0-9_]*$/`，不允许连字符）。 */
export const DOMAIN_NAME = 'tool_gateway'

/** 会话记录表名。 */
const TABLE_NAME = 'sessions'

/**
 * 一条会话记录的形状校验。
 *
 * 只认 `{ enabled: boolean }`，并把结果规范化成只有这一个字段 —— 记录里多余的键
 * 不会跟着进内存，避免旧版本写下的字段在新版本里阴魂不散。
 */
const ENABLED_RECORD_SCHEMA = {
  parse(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('tool-gateway 会话开关记录必须是一个对象')
    }
    if (typeof value.enabled !== 'boolean') {
      throw new Error('tool-gateway 会话开关记录的 enabled 字段必须是布尔值')
    }
    return { enabled: value.enabled }
  },
}

/**
 * domain 声明。
 *
 * 用默认的 `single` 布局（整个 domain 一个文档）：记录少而小（只有被用户显式关掉的
 * 会话），不值得为它走 `per-record`；`single` 布局下 key 也不受 `[a-zA-Z0-9_-]+` 约束。
 */
const DOMAIN_SPEC = {
  name: DOMAIN_NAME,
  version: 1,
  tables: {
    [TABLE_NAME]: { valueSchema: ENABLED_RECORD_SCHEMA },
  },
}

/**
 * domain 用不了时的替身：行为与真身一致，只是不持久。
 *
 * @param {Map<string, boolean>} store 内存里的开关表
 * @returns {object} 与 createSwitchState 同形的句柄
 */
function memoryOnly(store) {
  return {
    isEnabled(sessionId) {
      return store.get(sessionId) ?? true
    },
    async setEnabled(sessionId, enabled) {
      store.set(sessionId, enabled)
    },
    async close() {},
  }
}

/**
 * 打开开关状态。
 *
 * @param {object} ctx 插件上下文
 * @param {(error: unknown) => void} warnOnce 降级时的告警回调（只喊一次）
 * @returns {Promise<{isEnabled: (sessionId: string) => boolean, setEnabled: (sessionId: string, enabled: boolean) => Promise<void>, close: () => Promise<void>}>}
 *   开关状态的读写句柄
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

  return {
    /**
     * 这个会话的开关是不是开着。
     * @param {string} sessionId 归属会话 id（见 session-key.js）
     * @returns {boolean} true = 施加工具箱约束
     */
    isEnabled(sessionId) {
      // 没有记录就是默认开 —— 这是产品定义的默认值，不是"读不到就猜一个"。
      return table.get(sessionId)?.enabled ?? true
    },

    /**
     * 写下一个会话的开关。总是写入显式记录（而不是删除记录回到默认）：
     * 用户切回"开"也是一个决定，将来默认值若变化，这个会话不该跟着变。
     * @param {string} sessionId 归属会话 id
     * @param {boolean} enabled 新状态
     * @returns {Promise<void>} 落盘之后 resolve
     */
    async setEnabled(sessionId, enabled) {
      await table.put(sessionId, { enabled })
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
