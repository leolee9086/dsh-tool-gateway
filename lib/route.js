/**
 * 会话标题栏那个开关的宿主侧接口。
 *
 * 浏览器侧的 chip 只负责显示与点击，权威状态在宿主这里。两端之间走一条同源 HTTP 路由：
 * 这是独立插件包做"客户端 → 宿主"的正规通道（`ctx.webServer.register`），
 * 和 DSH 内部那些 typert Remote 不是一回事，也不需要生成任何代码。
 *
 * **鉴权必须自己做。** `webServer.register` 注册的是**裸路由**，它不带任何自动鉴权，
 * 所以每个请求都要先过 `connection.requestRejection(req)`：
 * `undefined` 放行，`401` 未通过 Cookie 身份验证，`403` Host/Origin 校验失败。
 *
 * **会话必须活着。** 路由只服务「当前打开着的会话」—— chip 与面板都长在那个会话的
 * 界面里，冷会话根本不会渲染它们。所以查不到 live agent 就如实返回 404，不猜、不兜底。
 *
 * **两个用途共用一条路由**（同一个会话、同一份鉴权、同一份权威状态，没有理由开两条）：
 *
 * - 工具箱模式的总开关：`{enabled}`；
 * - 单个工具的开关：`{tool, disabled}`。它写进会话记录的 `disabledTools`，然后由
 *   网关的守卫拒绝执行、并从 find_tools 的目录里摘掉。
 *
 * **单工具开关刻意不碰模型可见工具表。** 它不加 `restrict()`、不改工具定义 —— 网关开着
 * 时那张表里本来就只有三个元工具，动它换来的只是整段前缀缓存失效。所以这里没有
 * 「隐藏」这个动作，只有「拒绝 + 从检索目录里摘掉」。
 *
 * @module dsh-tool-gateway/route
 */

import { ownerSessionId, parentLookup } from './session-key.js'
import { createSwitchNotice, createToolNotice } from './switch-notice.js'

/** 路由路径。`/api/` 前缀跟 DSH web 自己的路由保持一致。 */
export const ROUTE = '/api/tool-gateway'

/** 请求体上限。这个接口的 body 只有一个 sessionId 和一个布尔值。 */
const MAX_BODY_BYTES = 4096

/** sessionId 的合理长度上限，防超长垃圾。 */
const MAX_SESSION_ID_LENGTH = 512

/**
 * 发一个 JSON 响应。响应可能已经被对端断开，所以先看两个失效标志。
 *
 * @param {object} res 响应对象
 * @param {number} status HTTP 状态码
 * @param {object} payload 响应体
 * @returns {void}
 */
function json(res, status, payload) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * 读一个有上限的请求体，并在完成或取消时释放全部监听器。
 *
 * 三条边界都要照顾到：超过上限立刻回 413 并把剩下的包排空（不然半包会吊住连接）、
 * 对端断开走 `aborted`/`close`、正常读完走 `end`。
 *
 * @param {object} req 请求对象
 * @returns {Promise<string>} 请求体文本
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks = []
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
    }
    const finish = (error, text) => {
      cleanup()
      if (error) reject(error)
      else resolve(text)
    }
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_BODY_BYTES) {
        // 先排空再回错误：不 resume 的话剩下的包会一直挂在连接上。
        req.resume()
        finish(Object.assign(new Error('请求体过大'), { status: 413 }))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => finish(undefined, Buffer.concat(chunks).toString('utf8'))
    const onError = (error) => finish(error)
    const onAborted = () => finish(Object.assign(new Error('请求被断开'), { status: 499 }))
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

/**
 * 校验一个 sessionId 字面量。
 *
 * @param {unknown} value 待校验的值
 * @returns {string} 合法的 sessionId
 * @throws {Error} 不是非空字符串、或超长时抛错（带 status 400）
 */
function requireSessionId(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_SESSION_ID_LENGTH) {
    throw Object.assign(new Error('需要一个非空的 sessionId'), { status: 400 })
  }
  return value
}

/**
 * 校验一个工具名字面量。
 *
 * @param {unknown} value 待校验的值
 * @returns {string} 合法的工具名
 * @throws {Error} 不是非空字符串、或超长时抛错（带 status 400）
 */
function requireToolName(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    throw Object.assign(new Error('需要一个非空的工具名'), { status: 400 })
  }
  return value
}

/**
 * 从 query string 里取 sessionId。
 *
 * @param {string} requestUrl 请求的 url（可能只有路径部分）
 * @returns {string} 合法的 sessionId
 */
function sessionIdFromQuery(requestUrl) {
  const url = new URL(requestUrl ?? '/', 'http://localhost')
  return requireSessionId(url.searchParams.get('sessionId'))
}

/**
 * 把客户端给的 sessionId 换算成"开关记在哪个会话名下"，并把 agent 一并带回来。
 *
 * 子代理会话跟随父会话（理由见 session-key.js）。这里要求目标会话是活的：
 * 冷会话不会渲染 chip，也就不会走到这条路上来。
 *
 * 为什么要把 agent 带回来：写操作之后要往这个会话注入一条通知
 * （见 switch-notice.js）。通知发给**用户正在看的那个会话**，而开关记在它的
 * 归属会话名下 —— 子代理的情况下这两者不是同一个，所以两个都要。
 *
 * @param {object} ctx 插件上下文
 * @param {string} sessionId 客户端报上来的会话 id
 * @returns {{ownerId: string, agent: object}} 归属会话 id 与这个会话的 agent
 * @throws {Error} 会话不活时抛错（带 status 404）
 */
function resolveOwner(ctx, sessionId) {
  const agent = ctx.get('agents')?.get(sessionId)
  if (agent === undefined) {
    throw Object.assign(new Error('会话不在运行中'), { status: 404 })
  }
  return { ownerId: ownerSessionId(agent.session, parentLookup(ctx)), agent }
}

/**
 * 造这个插件的 HTTP handler。
 *
 * @param {object} ctx 插件上下文
 * @param {object} state 开关状态句柄（{@link createSwitchState} 的产物）
 * @param {object} [helpers] 面板要用的两个回调
 * @param {(agent: object) => Array<object>} [helpers.listTools] 这个 agent 能看到的工具清单
 * @param {() => void} [helpers.invalidate] 会话级偏好变了：让目录视图缓存失效
 * @param {Set<string>} [helpers.coreNames] 不可关闭的工具名（三个元工具）
 * @returns {(req: object, res: object) => Promise<void>} handler
 */
export function createGatewayRoute(ctx, state, helpers = {}) {
  const listTools = typeof helpers.listTools === 'function' ? helpers.listTools : () => []
  const invalidate = typeof helpers.invalidate === 'function' ? helpers.invalidate : () => {}
  const coreNames = helpers.coreNames instanceof Set ? helpers.coreNames : new Set()

  return async function handle(req, res) {
    // 整个 handler 都在 try 里，包括鉴权那一步 —— `connection.requestRejection` 自己
    // 也可能抛，而 handler 返回的 promise 没有别人接。最外层这一层保证任何一条路径
    // 都给出一个响应，不会有静默失败。
    try {
      const connection = ctx.get('connection')
      if (connection === undefined) {
        json(res, 503, { ok: false, reason: 'service-unavailable', error: '连接鉴权服务不可用' })
        return
      }
      const rejected = connection.requestRejection(req)
      if (rejected !== undefined) {
        json(res, rejected, { ok: false, reason: rejected === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
      if (req.method === 'GET') {
        // 一条路由服务两个界面：标题栏的 chip 只取 enabled，右侧栏的面板还要这份工具清单。
        // 清单**按 agent 出** —— preset 注册的工具在 agent 自己的作用域层，全局视图看不全。
        const { ownerId, agent } = resolveOwner(ctx, sessionIdFromQuery(req.url))
        json(res, 200, {
          ok: true,
          enabled: state.isEnabled(ownerId),
          tools: listTools(agent),
        })
        return
      }
      if (req.method === 'POST') {
        const raw = await readBody(req)
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          throw Object.assign(new Error('请求体必须是 JSON'), { status: 400 })
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw Object.assign(new Error('请求体必须是一个 JSON 对象'), { status: 400 })
        }
        const { ownerId, agent } = resolveOwner(ctx, requireSessionId(parsed.sessionId))

        // 形式二：开关单个工具。两个 form 的字段互不重叠（一个给 enabled、一个给 tool），
        // 所以先判它不影响下面对 enabled 的校验。
        if (parsed.tool !== undefined) {
          const tool = requireToolName(parsed.tool)
          if (typeof parsed.disabled !== 'boolean') {
            throw Object.assign(new Error('disabled 必须是布尔值'), { status: 400 })
          }
          if (coreNames.has(tool)) {
            throw Object.assign(new Error('三个元工具不能关：关了就没有工具入口了'), { status: 400 })
          }
          // 状态没变就什么都不做，理由与总开关那一支相同。
          if (state.disabledTools(ownerId).has(tool) === parsed.disabled) {
            json(res, 200, { ok: true, tool, disabled: parsed.disabled, unchanged: true })
            return
          }
          await state.setToolDisabled(ownerId, tool, parsed.disabled)
          // 目录里刚摘掉的工具要立刻从 find_tools 的结果里消失，所以要作废视图缓存。
          invalidate()
          // 通知发给**用户正在看的这个会话**。子代理时「正在看的会话」与「偏好记在哪个
          // 会话名下」不是同一个，而通知要落在前者。
          agent.inject(createToolNotice(tool, parsed.disabled))
          json(res, 200, { ok: true, tool, disabled: parsed.disabled })
          return
        }

        if (typeof parsed.enabled !== 'boolean') {
          throw Object.assign(new Error('enabled 必须是布尔值'), { status: 400 })
        }
        // 状态没变就什么都不做：不写库、也不给模型发通知。
        // 用户连点两下（或者页面重复提交）不该在会话里堆两条“模式已开启”。
        if (state.isEnabled(ownerId) === parsed.enabled) {
          json(res, 200, { ok: true, enabled: parsed.enabled, unchanged: true })
          return
        }
        await state.setEnabled(ownerId, parsed.enabled)
        // 通知模型“刚刚变了什么”。`inject` 把消息排进下一次 pre-step，
        // 不唤醒 driver —— 用户点完开关再发一条消息，模型就在同一次请求里看到它。
        agent.inject(createSwitchNotice(parsed.enabled))
        json(res, 200, { ok: true, enabled: parsed.enabled })
        return
      }
      res.setHeader('Allow', 'GET, POST')
      json(res, 405, { ok: false, reason: 'method-not-allowed' })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500
      json(res, status, {
        ok: false,
        reason: status === 400 ? 'bad-request' : status === 404 ? 'not-found' : 'failed',
        error: String(error?.message ?? error),
      })
    }
  }
}
