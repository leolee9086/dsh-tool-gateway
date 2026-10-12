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

/**
 * 状态桩：只记调用，行为由测试给死。
 *
 * 写操作会就地更新桩里的三份集合，所以「写完再读一次」的路径能真的看到变化 ——
 * 那正是面板的行为（写完重读，不乐观更新）。
 *
 * @param {object} [options] 初值
 * @param {boolean} [options.enabled] 总开关
 * @param {string[]} [options.disabled] 已经显式关掉的工具
 * @param {string[]} [options.enabledTools] 已经显式打开的工具
 * @param {Record<string, boolean>} [options.groups] 组覆盖
 * @returns {object} 与 createSwitchState 同形的句柄，外加一个 calls 记录
 */
function stubState({ enabled = true, disabled = [], enabledTools = [], groups = {} } = {}) {
  const calls = []
  const off = new Set(disabled)
  const on = new Set(enabledTools)
  const overrides = new Map(Object.entries(groups))
  const setOne = (name, value) => {
    if (value) { off.add(name); on.delete(name) } else { off.delete(name); on.add(name) }
  }
  return {
    calls,
    isEnabled: (sessionId) => { calls.push(['get', sessionId]); return enabled },
    prefs: (sessionId) => {
      calls.push(['prefs', sessionId])
      return { enabled, disabledTools: new Set(off), enabledTools: new Set(on), groups: new Map(overrides) }
    },
    setEnabled: async (sessionId, next) => { calls.push(['set', sessionId, next]); enabled = next },
    async setToolDisabled(sessionId, name, value) {
      calls.push(['setTool', sessionId, name, value])
      setOne(name, value)
    },
    async setToolsDisabled(sessionId, names, value) {
      calls.push(['setTools', sessionId, names, value])
      for (const name of names) setOne(name, value)
    },
    async setGroupEnabled(sessionId, groupId, value) {
      calls.push(['setGroup', sessionId, groupId, value])
      overrides.set(groupId, value)
    },
  }
}

/**
 * 造一份工具清单桩（宿主给面板的那种形状）。
 *
 * 名字后面跟的是「这个会话现在能不能用它」，因为路由判定「状态变没变」看的就是它。
 *
 * @param {Array<[string, boolean?]>} entries 名字与可用性
 * @returns {Array<object>} 工具清单
 */
const toolsOf = (...entries) => entries.map(([name, enabled = true]) => ({
  name, description: '', enabled, banned: false, core: false,
  explicit: null, group: null, groupTitle: null,
}))

const sessionOf = (id, header = {}) => ({ id, header })

test('GET：读回会话的开关状态', async () => {
  const state = stubState({ enabled: false })
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()

  await createGatewayRoute(ctx, state)(stubReq({ url: `${ROUTE}?sessionId=session-a` }), res)

  assert.equal(res.status, 200)
  // 一条路由服务两个界面：chip 只取 enabled，右侧栏的面板还要 tools。没给 listTools
  // 回调时清单是空的（宿主那边一定会给）。
  assert.deepEqual(res.payload, {
    ok: true, enabled: false, total: 0, offset: 0, limit: 200, tools: [], groups: [],
  })
  assert.deepEqual(state.calls, [['prefs', 'session-a'], ['get', 'session-a']])
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
  // 来源的 kind 必须归生产者所有（V4 会话准入），不能用退役的 { kind: 'plugin', plugin }。
  assert.equal(ctx.injected[0].message.source.kind, 'plugin:dsh-tool-gateway')
  assert.equal(ctx.injected[0].message.source.form, 'notice')
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
  // 上限是 256 KiB：批量开关要带一批工具名，几百个名字是正常请求。
  const res = stubRes()
  const huge = JSON.stringify({ sessionId: 'x'.repeat(300 * 1024), enabled: true })
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

test('面板：GET 按会话读回工具清单', async () => {
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()
  const tools = toolsOf(['read', false])
  let sawAgent = null

  await createGatewayRoute(ctx, state, {
    listTools: (agent) => { sawAgent = agent; return tools },
  })(stubReq({ url: `${ROUTE}?sessionId=session-a` }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(res.payload.tools, tools)
  assert.equal(res.payload.total, 1)
  assert.ok(sawAgent, '清单按 agent 出：preset 注册的工具只有它的视图看得全')
  assert.deepEqual(state.calls, [['prefs', 'session-a'], ['get', 'session-a']])
})

test('面板：关掉一个工具会写这个会话的名单、作废目录视图、并告诉模型', async () => {
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()
  let invalidated = 0

  await createGatewayRoute(ctx, state, {
    invalidate: () => { invalidated += 1 },
    coreNames: new Set(['find_tools', 'call_tool', 'call_tools']),
    listTools: () => toolsOf(['web_search_meta', true]),
  })(stubReq({
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-a', tool: 'web_search_meta', disabled: true }),
  }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(res.payload, { ok: true, tool: 'web_search_meta', disabled: true })
  assert.deepEqual(state.calls, [['setTool', 'session-a', 'web_search_meta', true]])
  assert.equal(invalidated, 1, '目录缓存必须作废，否则 find_tools 还会把刚关掉的工具列出来')
  // 关掉是在会话中途发生的，模型看不见「装配」本身 —— 得告诉它刚刚变了什么。
  assert.equal(ctx.injected.length, 1)
  assert.match(ctx.injected[0].message.content[0].text, /工具已关闭/)
})

test('面板：子代理会话里关掉的工具记在父会话名下，但通知发给当前会话', async () => {
  const parent = sessionOf('parent-1')
  const child = sessionOf('child-1', { origin: 'subagent', parentSession: 'parent-1' })
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['parent-1', parent], ['child-1', child]]) })
  const res = stubRes()

  await createGatewayRoute(ctx, state, {
    invalidate: () => {},
    listTools: () => toolsOf(['read', true]),
  })(stubReq({
    method: 'POST',
    body: JSON.stringify({ sessionId: 'child-1', tool: 'read', disabled: true }),
  }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(state.calls, [['setTool', 'parent-1', 'read', true]])
  assert.equal(ctx.injected.length, 1, '通知要落在用户正在看的那个会话里')
  assert.equal(ctx.injected[0].sessionId, 'child-1')
})

test('面板：三个元工具不给关（关了就没有工具入口了）', async () => {
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()

  await createGatewayRoute(ctx, state, { coreNames: new Set(['call_tool']) })(stubReq({
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-a', tool: 'call_tool', disabled: true }),
  }), res)

  assert.equal(res.status, 400)
  assert.deepEqual(state.calls, [])
})

test('面板：状态没变时不写、也不作废缓存', async () => {
  // 用户连点两下（或者页面重复提交）不该写库，也不该在会话里堆两条通知。
  const state = stubState({ disabled: ['web_search_meta'] })
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()
  let invalidated = 0

  await createGatewayRoute(ctx, state, {
    invalidate: () => { invalidated += 1 },
    listTools: () => toolsOf(['web_search_meta', false]),
  })(stubReq({
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-a', tool: 'web_search_meta', disabled: true }),
  }), res)

  assert.equal(res.status, 200)
  assert.equal(res.payload.unchanged, true)
  assert.deepEqual(state.calls, [])
  assert.equal(invalidated, 0)
  assert.equal(ctx.injected.length, 0)
})

test('面板：打开一个工具', async () => {
  const state = stubState({ disabled: ['web_search_meta'] })
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()

  await createGatewayRoute(ctx, state, {
    invalidate: () => {},
    listTools: () => toolsOf(['web_search_meta', false]),
  })(stubReq({
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-a', tool: 'web_search_meta', disabled: false }),
  }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(res.payload, { ok: true, tool: 'web_search_meta', disabled: false })
  assert.deepEqual(state.calls, [['setTool', 'session-a', 'web_search_meta', false]])
  assert.match(ctx.injected[0].message.content[0].text, /工具已打开/)
})

test('面板：tool 给了但 disabled 不是布尔值 → 400', async () => {
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()
  await createGatewayRoute(ctx, state, { invalidate: () => {} })(stubReq({
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-a', tool: 'read' }),
  }), res)
  assert.equal(res.status, 400)
  assert.equal(res.payload.reason, 'bad-request')
  assert.deepEqual(state.calls, [])
})

test('面板：没有 sessionId 就是 400（工具开关也按会话）', async () => {
  const state = stubState()
  const res = stubRes()
  await createGatewayRoute(stubCtx(), state, { invalidate: () => {} })(stubReq({
    method: 'POST',
    body: JSON.stringify({ tool: 'read', disabled: true }),
  }), res)
  assert.equal(res.status, 400)
  assert.deepEqual(state.calls, [])
})

test('面板：开关一个不存在的工具是 404', async () => {
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()
  await createGatewayRoute(ctx, state, { listTools: () => toolsOf(['read']) })(stubReq({
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-a', tool: 'nope', disabled: true }),
  }), res)
  assert.equal(res.status, 404)
  assert.deepEqual(state.calls, [])
})

test('面板：分页与过滤都在宿主侧做', async () => {
  // 过滤必须在宿主侧：面板里过滤的话，用户搜到的只是当前这一页里的匹配项，
  // 而「共 N 条」是全量数字 —— 两个数字对不上，用户会以为工具丢了。
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const all = toolsOf(['alpha', true], ['beta', false], ['gamma', true])
  const route = createGatewayRoute(ctx, stubState(), { listTools: () => all })

  const page = stubRes()
  await route(stubReq({ url: `${ROUTE}?sessionId=session-a&offset=1&limit=1` }), page)
  assert.equal(page.status, 200)
  assert.equal(page.payload.total, 3)
  assert.equal(page.payload.offset, 1)
  assert.equal(page.payload.limit, 1)
  assert.deepEqual(page.payload.tools.map((tool) => tool.name), ['beta'])

  const filtered = stubRes()
  await route(stubReq({ url: `${ROUTE}?sessionId=session-a&query=am` }), filtered)
  assert.equal(filtered.payload.total, 1, '过滤后的 total 才是面板算页数要的那个数')
  assert.deepEqual(filtered.payload.tools.map((tool) => tool.name), ['gamma'])
})

test('面板：分页参数写错就报错，不静默回落', async () => {
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const route = createGatewayRoute(ctx, stubState(), { listTools: () => toolsOf(['read']) })
  for (const query of ['offset=-1', 'offset=abc', 'limit=0', 'limit=99999']) {
    const res = stubRes()
    await route(stubReq({ url: `${ROUTE}?sessionId=session-a&${query}` }), res)
    assert.equal(res.status, 400, query)
  }
})

test('面板：按组过滤时，分页跟着过滤后的结果走', async () => {
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const all = [
    { ...toolsOf(['a1'])[0], group: 'g1', groupTitle: '甲' },
    { ...toolsOf(['a2'])[0], group: 'g1', groupTitle: '甲' },
    { ...toolsOf(['b1'])[0], group: 'g2', groupTitle: '乙' },
  ]
  const route = createGatewayRoute(ctx, stubState(), { listTools: () => all })

  const first = stubRes()
  await route(stubReq({ url: `${ROUTE}?sessionId=session-a&group=g1&limit=1` }), first)
  assert.equal(first.payload.total, 2, 'total 是组内的条数')
  assert.deepEqual(first.payload.tools.map((tool) => tool.name), ['a1'])

  const second = stubRes()
  await route(stubReq({ url: `${ROUTE}?sessionId=session-a&group=g1&limit=1&offset=1` }), second)
  assert.deepEqual(second.payload.tools.map((tool) => tool.name), ['a2'])
})

test('面板：GET 带出工具组和这个会话的组覆盖', async () => {
  const state = stubState({ groups: { 'siyuan-http': true } })
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()
  const group = {
    id: 'siyuan-http', title: '思源 HTTP 端点', origin: 'dsh-plugin-siyuan',
    defaultEnabled: false, size: 697,
  }

  await createGatewayRoute(ctx, state, {
    listTools: () => toolsOf(['read']),
    listGroups: () => [group],
  })(stubReq({ url: `${ROUTE}?sessionId=session-a` }), res)

  // override 是**这个会话**对整组的显式开关；null 表示跟随组自己声明的默认值。
  assert.deepEqual(res.payload.groups, [{ ...group, override: true }])
})

test('面板：整组开关写一个键，并告诉模型这一组变了', async () => {
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()
  let invalidated = 0
  const group = {
    id: 'siyuan-http', title: '思源 HTTP 端点', origin: 'dsh-plugin-siyuan',
    defaultEnabled: false, size: 697,
  }

  await createGatewayRoute(ctx, state, {
    invalidate: () => { invalidated += 1 },
    listGroups: () => [group],
  })(stubReq({
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-a', group: 'siyuan-http', enabled: true }),
  }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(res.payload, { ok: true, group: 'siyuan-http', enabled: true })
  assert.deepEqual(state.calls, [['setGroup', 'session-a', 'siyuan-http', true]])
  assert.equal(invalidated, 1)
  assert.match(ctx.injected[0].message.content[0].text, /工具组已打开：思源 HTTP 端点/)
  // 组开关是**一个键**：它不动逐个开关过的名单，那才是单个工具的显式覆盖。
  assert.deepEqual([...state.prefs('session-a').disabledTools], [])
})

test('面板：未知的工具组是 404，不猜也不建一个', async () => {
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()
  await createGatewayRoute(ctx, state, { listGroups: () => [] })(stubReq({
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-a', group: 'nope', enabled: true }),
  }), res)
  assert.equal(res.status, 404)
  assert.deepEqual(state.calls, [])
})

test('面板：批量开关一次写完，并告诉模型涉及多少条', async () => {
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()
  let invalidated = 0

  await createGatewayRoute(ctx, state, { invalidate: () => { invalidated += 1 } })(stubReq({
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-a', tools: ['read', 'write', 'read'], disabled: true }),
  }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(res.payload, { ok: true, count: 2, disabled: true }, '重复的名字只算一次')
  assert.deepEqual(state.calls, [['setTools', 'session-a', ['read', 'write'], true]])
  assert.equal(invalidated, 1)
  assert.match(ctx.injected[0].message.content[0].text, /工具已关闭：2 个/)
})

test('面板：批量开关也不许关掉元工具，而且整批都不写', async () => {
  const state = stubState()
  const ctx = stubCtx({ agents: new Map([['session-a', sessionOf('session-a')]]) })
  const res = stubRes()
  await createGatewayRoute(ctx, state, { coreNames: new Set(['call_tool']) })(stubReq({
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-a', tools: ['read', 'call_tool'], disabled: true }),
  }), res)
  assert.equal(res.status, 400)
  // 写一半会让面板显示一个用户没下过的状态。
  assert.deepEqual(state.calls, [])
})

