/**
 * HTTP 路由的测试：鉴权、方法、参数校验、错误码，以及**归属会话换算**。
 *
 * 请求桩用 `node:stream` 的 `Readable`：它天然按异步顺序推 data/end，和真实
 * `IncomingMessage` 的时序一致，`readBody` 注册完监听器就能收到。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createGatewayRoute, ROUTE } from '../src/route.js'

/** 造一个请求。GET 不带 body。 */
function stubReq({ method = 'GET', url = ROUTE, body = null } = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  return req
}

/** 造一个响应，把发出去的东西记下来。 */
function stubRes() {
  return {
    destroyed: false,
    writableEnded: false,
    status: null,
    headers: null,
    payload: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    setHeader(name, value) {
      this.extraHeaders = { ...this.extraHeaders, [name]: value }
    },
    end(text) {
      this.writableEnded = true
      this.payload = text === undefined ? null : JSON.parse(text)
    },
  }
}

/**
 * 造一个 ctx 桩。
 *
 * @param {object} [options] 行为开关
 * @param {number|undefined} [options.rejected] requestRejection 的返回值
 * @param {boolean} [options.noConnection] connection 服务缺席
 * @param {Map} [options.agents] 活着的 agent 表（sessionId → session）
 */
function stubCtx({ rejected = undefined, noConnection = false, agents = new Map() } = {}) {
  const injected = []
  return {
    injected,
    get(name) {
      if (name === 'connection') return noConnection ? undefined : { requestRejection: () => rejected }
      if (name === 'agents') {
        return {
          get: (id) => (agents.has(id)
            ? { session: agents.get(id), inject: (message) => injected.push({ sessionId: id, message }) }
            : undefined),
        }
      }
      return undefined
    },
  }
}

/** 开关状态的桩：只记调用，行为由测试给死。 */
function stubState({ enabled = true } = {}) {
  const calls = []
  return {
    calls,
    isEnabled: (sessionId) => { calls.push(['get', sessionId]); return enabled },
    setEnabled: async (sessionId, next) => { calls.push(['set', sessionId, next]) },
  }
}

const sessionOf = (id, header = {}) => ({ id, header })

test('GET：读回会话的开关状态', async () => {
  const state = stubState({ enabled: false })
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()

  await createGatewayRoute(ctx, state)(stubReq({ url: `${ROUTE}?sessionId=session-a` }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(res.payload, { ok: true, enabled: false })
  assert.deepEqual(state.calls, [['get', 'session-a']])
  // 响应不该被缓存：它随会话状态变化。
  assert.equal(res.headers['Cache-Control'], 'no-store')
})

test('GET：没有 sessionId 是 400', async () => {
  const res = stubRes()
  await createGatewayRoute(stubCtx(), stubState())(stubReq({ url: ROUTE }), res)
  assert.equal(res.status, 400)
  assert.equal(res.payload.reason, 'bad-request')
})

test('GET：会话不在运行中是 404（不猜、不兜底）', async () => {
  const res = stubRes()
  await createGatewayRoute(stubCtx(), stubState())(stubReq({ url: `${ROUTE}?sessionId=gone` }), res)
  assert.equal(res.status, 404)
  assert.equal(res.payload.reason, 'not-found')
})

test('POST：写下一个开关状态', async () => {
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()

  await createGatewayRoute(ctx, state)(
    stubReq({ method: 'POST', body: JSON.stringify({ sessionId: 'session-a', enabled: false }) }),
    res,
  )

  assert.equal(res.status, 200)
  assert.deepEqual(res.payload, { ok: true, enabled: false })
  // 先读一次当前状态（决定要不要给模型发通知），再写。
  assert.deepEqual(state.calls, [['get', 'session-a'], ['set', 'session-a', false]])
})

test('POST：子代理会话的开关记在父会话名下', async () => {
  const parent = sessionOf('parent-1')
  const child = sessionOf('child-1', { origin: 'subagent', parentSession: 'parent-1' })
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['parent-1', parent], ['child-1', child]]) })
  const res = stubRes()

  await createGatewayRoute(ctx, state)(
    stubReq({ method: 'POST', body: JSON.stringify({ sessionId: 'child-1', enabled: false }) }),
    res,
  )

  assert.equal(res.status, 200)
  // 开关记在**父会话**名下（子代理跟随父会话），但通知发给**用户正在看的这个会话**。
  // 先读一次父会话的当前状态（决定要不要通知），再写。
  assert.deepEqual(state.calls, [['get', 'parent-1'], ['set', 'parent-1', false]])
  assert.equal(ctx.injected.length, 1)
  assert.equal(ctx.injected[0].sessionId, 'child-1')
})

test('POST：状态真的变了才给模型发通知', async () => {
  // 开关是会话中途能变的，而模型看不见"装配"这件事本身。
  // 没有这条通知，模型只能在"我明明刚用过 read、怎么现在调不了了"的困惑里自己猜。
  const state = stubState({ enabled: true })
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()

  await createGatewayRoute(ctx, state)(
    stubReq({ method: 'POST', body: JSON.stringify({ sessionId: 'session-a', enabled: false }) }),
    res,
  )

  assert.equal(res.status, 200)
  assert.deepEqual(res.payload, { ok: true, enabled: false })
  assert.deepEqual(state.calls, [['get', 'session-a'], ['set', 'session-a', false]])
  assert.equal(ctx.injected.length, 1)
  assert.equal(ctx.injected[0].sessionId, 'session-a')
  // 通知是一条**用户消息**：它要作为 user/message 进会话日志，模型可见的东西才能从日志重建。
  assert.equal(ctx.injected[0].message.role, 'user')
  assert.match(ctx.injected[0].message.content[0].text, /工具箱模式：已关闭/)
  assert.deepEqual(ctx.injected[0].message.source, { kind: 'plugin', plugin: 'dsh-tool-gateway' })
})

test('POST：状态没变时既不写库也不通知', async () => {
  // 用户连点两下（或者页面重复提交）不该在会话里堆两条"模式已关闭"。
  const state = stubState({ enabled: false })
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()

  await createGatewayRoute(ctx, state)(
    stubReq({ method: 'POST', body: JSON.stringify({ sessionId: 'session-a', enabled: false }) }),
    res,
  )

  assert.equal(res.status, 200)
  assert.equal(res.payload.unchanged, true)
  assert.deepEqual(state.calls, [['get', 'session-a']])
  assert.equal(ctx.injected.length, 0)
})

test('POST：enabled 不是布尔值是 400', async () => {
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()
  await createGatewayRoute(ctx, stubState())(
    stubReq({ method: 'POST', body: JSON.stringify({ sessionId: 'session-a', enabled: 'yes' }) }),
    res,
  )
  assert.equal(res.status, 400)
})

test('POST：body 不是 JSON 是 400', async () => {
  const res = stubRes()
  await createGatewayRoute(stubCtx(), stubState())(stubReq({ method: 'POST', body: 'not json' }), res)
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /JSON/)
})

test('POST：body 超过上限是 413', async () => {
  const res = stubRes()
  const huge = JSON.stringify({ sessionId: 'x'.repeat(8192), enabled: true })
  await createGatewayRoute(stubCtx(), stubState())(stubReq({ method: 'POST', body: huge }), res)
  assert.equal(res.status, 413)
})

test('鉴权：requestRejection 返回 401 时拒绝，且不碰状态', async () => {
  const state = stubState()
  const res = stubRes()
  await createGatewayRoute(stubCtx({ rejected: 401 }), state)(
    stubReq({ url: `${ROUTE}?sessionId=session-a` }),
    res,
  )
  assert.equal(res.status, 401)
  assert.equal(res.payload.reason, 'unauthorized')
  assert.deepEqual(state.calls, [])
})

test('鉴权：requestRejection 返回 403 时拒绝', async () => {
  const res = stubRes()
  await createGatewayRoute(stubCtx({ rejected: 403 }), stubState())(
    stubReq({ url: `${ROUTE}?sessionId=session-a` }),
    res,
  )
  assert.equal(res.status, 403)
  assert.equal(res.payload.reason, 'forbidden')
})

test('connection 服务不可用时回 503，而不是放行', async () => {
  const res = stubRes()
  await createGatewayRoute(stubCtx({ noConnection: true }), stubState())(stubReq(), res)
  assert.equal(res.status, 503)
  assert.equal(res.payload.reason, 'service-unavailable')
})

test('其它方法是 405，并带上 Allow', async () => {
  const res = stubRes()
  await createGatewayRoute(stubCtx(), stubState())(stubReq({ method: 'DELETE' }), res)
  assert.equal(res.status, 405)
  assert.equal(res.extraHeaders.Allow, 'GET, POST')
})
