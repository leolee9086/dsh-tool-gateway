/**
 * 硬禁用名单（原 dsh-tool-ban）的测试。
 *
 * 合并之后这个模块只剩两件事：把配置折成一份确定的选项、按 agent 抹掉模型可见工具表。
 * **执行那一半不在这里** —— 它由 gateway.js 的守卫承载，相关断言在 gateway.test.mjs 与
 * host-ban.test.mjs 里。这里有一条专门的回归：这个模块不再自己注册守卫。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_DENY,
  DEFAULT_REASON,
  createBanGuard,
  installBanVisibility,
  normalizeNames,
  resolveBanOptions,
} from '../src/ban.js'

const ASK = 'ask_user_question'

/** 假 ctx：只实现插件真正用到的那几个接缝，并把每次调用记下来供断言。 */
function harness(options = {}) {
  const state = {
    guards: [],
    events: new Map(),
    labels: [],
    disposers: [],
    lookups: 0,
    restrictFilters: [],
  }
  const visible = options.visible === undefined
    ? () => true
    : typeof options.visible === 'function'
      ? options.visible
      : name => options.visible.includes(name)
  const tools = {
    get(name) {
      state.lookups += 1
      return visible(name) ? { name } : undefined
    },
    guard(fn) {
      state.guards.push(fn)
      return () => {}
    },
  }
  const services = options.services ?? { agents: { list: () => options.agents ?? [] } }
  const ctx = {
    tools,
    get: name => services[name],
    effect(fn, label) {
      state.labels.push(label)
      state.disposers.push(fn())
    },
    on(event, handler) {
      state.events.set(event, handler)
      return () => {}
    },
  }
  return { ctx, state }
}

/** 假 agent：作用域上只有 tools.restrict 一个接缝。 */
function agentStub(options = {}) {
  const calls = []
  const releases = []
  const restrict = options.restrict ?? (filter => {
    calls.push(filter)
    return () => { releases.push(filter) }
  })
  return { agent: { id: options.id ?? 'agent', ctx: { tools: { restrict } } }, calls, releases }
}

function fire(state, event, payload, next = () => Promise.resolve({ kind: 'enter' })) {
  const handler = state.events.get(event)
  assert.ok(handler, `没有注册 ${event} 监听器`)
  return handler(payload, next)
}

/** 装一次屏蔽，返回装了之后的世界。 */
function install(ctx, config) {
  return installBanVisibility(ctx, resolveBanOptions(config))
}

test('默认配置就是禁用提问工具', () => {
  assert.deepEqual(resolveBanOptions().deny, DEFAULT_DENY)
  assert.deepEqual(DEFAULT_DENY, [ASK])
  assert.equal(resolveBanOptions().hide, true)
})

test('默认理由禁的是这个工具，不是提问本身', () => {
  // 这条文案会被模型读到，措辞错一步语义就反了：说成不许提问是错的。
  assert.match(DEFAULT_REASON, /选择题卡片/)
  assert.match(DEFAULT_REASON, /正文/)
  assert.match(DEFAULT_REASON, /提问/)
  assert.doesNotMatch(DEFAULT_REASON, /不要再尝试向用户提问/)
})

test('显式写空名单表示一个都不禁；完全不写才用默认名单', () => {
  // 合并之后这一条与 dsh-tool-ban 时期是反的：那时空数组也回落到默认名单，
  // 理由是「配置写空了就等于没装」。网关本来就装着，禁用只是它的一项附加能力，
  // 把空数组当成显式关闭更符合读配置的人的预期。
  assert.deepEqual(resolveBanOptions({ deny: [] }).deny, [])
  assert.deepEqual(resolveBanOptions({ deny: ['  ', ''] }).deny, [])
  assert.deepEqual(resolveBanOptions({}).deny, DEFAULT_DENY)
  assert.equal(resolveBanOptions({ reason: '自定义理由' }).reason, '自定义理由')
  // 理由留空（或只有空白）时回落到默认理由，避免模型读到一条空解释。
  assert.equal(resolveBanOptions({ reason: '   ' }).reason, DEFAULT_REASON)
})

test('normalizeNames 丢掉空白、重复与非字符串，并保持顺序', () => {
  assert.deepEqual(normalizeNames(['  ', 'a', 'a', 3, null, 'b ']), ['a', 'b'])
  assert.deepEqual(normalizeNames('  x '), ['x'])
  assert.deepEqual(normalizeNames(undefined), [])
})

test('createBanGuard 是纯函数，可单独使用', () => {
  const guard = createBanGuard(['a'], 'no')
  assert.equal(guard({ name: 'a' }), 'no')
  assert.equal(guard({ name: 'b' }), undefined)
  assert.equal(guard({}), undefined)
})

test('合并之后这个模块不再自己注册守卫（执行那一半归 gateway.js）', () => {
  const { ctx, state } = harness()
  install(ctx, { deny: [ASK] })
  assert.deepEqual(state.guards, [], '守卫只能有一条，且它注册在 gateway.js 里')
  assert.deepEqual(state.labels, [], '连 effect 都不该开')
})

test('新 agent 创建时，工具从它的模型可见表里消失', () => {
  const { ctx, state } = harness()
  const { agent, calls } = agentStub()
  install(ctx)
  fire(state, 'agent/created', { agent })
  assert.deepEqual(calls, [{ deny: [ASK] }])
})

test('该 agent 看不见这个工具时不下发限制（未知名字会让 restrict 抛错）', () => {
  const { ctx, state } = harness({ visible: () => false })
  const { agent, calls } = agentStub()
  install(ctx)
  fire(state, 'agent/created', { agent })
  assert.deepEqual(calls, [])
})

test('限制注册失败不会打断 agent 创建，也不冒泡异常', () => {
  const { ctx, state } = harness()
  const failure = () => { throw new Error('names unknown tool') }
  const { agent } = agentStub({ restrict: failure })
  install(ctx)
  assert.doesNotThrow(() => fire(state, 'agent/created', { agent }))
})

test('hide:false 时一个事件都不注册：可见性那一半整个不要', () => {
  const { ctx, state } = harness()
  const { calls } = agentStub()
  install(ctx, { hide: false })
  assert.equal(state.events.has('agent/created'), false)
  assert.equal(state.events.has('agent/pre-step'), false)
  assert.deepEqual(calls, [])
})

test('装载时补扫已有 agent：正在跑的会话立刻生效', () => {
  const { agent, calls } = agentStub({ id: 'live' })
  const { ctx } = harness({ agents: [agent] })
  install(ctx)
  assert.deepEqual(calls, [{ deny: [ASK] }])
})

test('自定义名单同样归一化后再下发', () => {
  const { ctx, state } = harness()
  const { agent, calls } = agentStub()
  install(ctx, { deny: [' exit_plan_mode ', 'exit_plan_mode', 7], reason: '  ' })
  fire(state, 'agent/created', { agent })
  assert.deepEqual(calls, [{ deny: ['exit_plan_mode'] }])
})

test('pre-step 兜底：创建时还看不见，下一次请求组装前补上，并把 next 交下去', async () => {
  let visible = false
  const { ctx, state } = harness({ visible: () => visible })
  const { agent, calls } = agentStub()
  install(ctx)

  fire(state, 'agent/created', { agent })
  assert.deepEqual(calls, [], '创建时 preset 还没挂载完')

  visible = true
  let nexted = 0
  await fire(state, 'agent/pre-step', { agent }, () => { nexted += 1; return Promise.resolve({ kind: 'enter' }) })
  assert.deepEqual(calls, [{ deny: [ASK] }])
  assert.equal(nexted, 1, 'pre-step 是瀑布，必须把 next() 交下去')
})

test('兜底重试有上限：始终看不见的 agent 不会被反复查询工具视图', async () => {
  const { ctx, state } = harness({ visible: () => false })
  const { agent } = agentStub()
  install(ctx, { maxHideAttempts: 2 })

  await fire(state, 'agent/pre-step', { agent })
  await fire(state, 'agent/pre-step', { agent })
  const settled = state.lookups
  await fire(state, 'agent/pre-step', { agent })
  assert.equal(state.lookups, settled, '超过上限后不应再查视图')
})

test('agent 销毁时撤销它那份限制', () => {
  const { ctx, state } = harness()
  const { agent, releases } = agentStub()
  install(ctx)
  fire(state, 'agent/created', { agent })
  assert.equal(releases.length, 0)
  fire(state, 'agent/disposed', { agent })
  assert.deepEqual(releases, [{ deny: [ASK] }])
})

test('没有 agents 服务时优雅降级', () => {
  const { ctx } = harness({ services: {} })
  assert.doesNotThrow(() => install(ctx))
})

test('agents 服务读取抛错时不影响装载', () => {
  const { ctx } = harness({ services: { get agents() { throw new Error('boom') } } })
  assert.doesNotThrow(() => install(ctx, { deny: [ASK] }))
})
