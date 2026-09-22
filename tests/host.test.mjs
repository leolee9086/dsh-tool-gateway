/**
 * 宿主入口的接线测试。
 *
 * 这一层自己不实现任何逻辑，它的价值全在"有没有接对"。所以测试的重点是
 * **端到端**：挂好之后，把一个会话的开关关掉，看那个会话的可见性与守卫是不是
 * 真的放开了，而**别的会话不受影响**。
 *
 * storageDomain 用桩，但按真实 domain 的规则行事（校验 spec、过 schema）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../src/host.js'
import { DENY_REASON } from '../src/gateway.js'

/** 与 `@deepseek-ai/dsh-storage` 的 `UNIT_NAME_RE` 同一个正则。 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/** storageDomain 桩：记录落在这个 Map 里，行为与真身一致。 */
function stubStorageDomain(records = new Map()) {
  const calls = { opened: [], closed: 0 }
  return {
    calls,
    records,
    async open(spec) {
      calls.opened.push(spec)
      assert.match(spec.name, UNIT_NAME_RE)
      const [tableName, tableSpec] = Object.entries(spec.tables)[0]
      assert.match(tableName, UNIT_NAME_RE)
      const schema = tableSpec.valueSchema
      for (const [key, value] of [...records]) records.set(key, schema.parse(value))
      return {
        table(name) {
          assert.equal(name, tableName)
          return {
            get: (key) => records.get(key),
            put: async (key, value) => { records.set(key, schema.parse(value)) },
          }
        },
        async close() { calls.closed += 1 },
      }
    },
  }
}

/** 造一个够用的插件上下文桩。 */
function stubCtx({ storage = undefined, agents = new Map(), withWeb = true } = {}) {
  const listeners = new Map()
  const registeredTools = []
  const guards = []
  const sections = []
  const routes = []
  const disposers = []
  const warnings = []

  const ctx = {
    registeredTools,
    guards,
    sections,
    routes,
    disposers,
    warnings,
    logger: { warn: (message) => warnings.push(message), error: () => {} },
    get(service) {
      if (service === 'storageDomain') return storage
      if (service === 'agents') return { get: (id) => (agents.has(id) ? { session: agents.get(id) } : undefined) }
      if (service === 'webServer') {
        if (!withWeb) return undefined
        return {
          register(route) {
            routes.push(route)
            return () => { routes.pop() }
          },
        }
      }
      if (service === 'connection') return withWeb ? { requestRejection: () => undefined } : undefined
      return undefined
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    tools: {
      register(definition) {
        registeredTools.push(definition)
        return () => {}
      },
      schemas: () => [],
      get: () => undefined,
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    handlerOf(event) {
      return listeners.get(event)?.[0]
    },
  }
  return ctx
}

/** 一个假 agent。 */
const agentOf = (sessionId, header = {}) => ({ session: { id: sessionId, header } })

/** 造一份装配产物。 */
const assemblyOf = (...names) => ({ sections: [], contexts: [], variables: {}, tools: names.map((n) => ({ name: n })) })

test('插件名与硬依赖服务', () => {
  assert.equal(name, 'dsh-tool-gateway')
  // webServer / connection / storageDomain / agents 故意不写进 inject：
  // 缺了它们只是没有界面与持久化，网关本身照常工作。
  assert.deepEqual([...inject].sort(), ['systemPrompt', 'tools'])
})

test('挂好之后：两个元工具、一个 assemble 监听器、一个守卫、一个提示段落、一条路由', async () => {
  const ctx = stubCtx({ storage: stubStorageDomain() })
  await apply(ctx)

  assert.deepEqual(ctx.registeredTools.map((tool) => tool.name).sort(), ['call_tool', 'find_tools'])
  assert.equal(typeof ctx.handlerOf('system-prompt/assemble'), 'function')
  assert.equal(ctx.guards.length, 1)
  assert.equal(ctx.sections.length, 1)
  assert.equal(ctx.sections[0].name, 'tool-gateway')
  assert.equal(ctx.routes.length, 1)
  assert.equal(ctx.routes[0].path, '/api/tool-gateway')
  assert.equal(ctx.routes[0].kind, 'exact')
})

test('默认开：没有覆盖记录的会话照样被约束', async () => {
  const ctx = stubCtx({ storage: stubStorageDomain() })
  await apply(ctx)

  const assembly = await ctx.handlerOf('system-prompt/assemble')(
    {}, { agent: agentOf('session-a') }, async () => assemblyOf('find_tools', 'read', 'call_tool'),
  )
  assert.deepEqual(assembly.tools.map((tool) => tool.name), ['find_tools', 'call_tool'])
  assert.equal(ctx.guards[0]({ name: 'read', agent: agentOf('session-a') }), DENY_REASON)
})

test('端到端：把一个会话关掉，只有它放开，别的会话不受影响', async () => {
  // session-b 在介质里已经存着"关"。
  const ctx = stubCtx({ storage: stubStorageDomain(new Map([['session-b', { enabled: false }]])) })
  await apply(ctx)

  const assemble = ctx.handlerOf('system-prompt/assemble')
  const guard = ctx.guards[0]
  const section = ctx.sections[0]

  const agentA = agentOf('session-a')
  const agentB = agentOf('session-b')

  // 可见性
  const forA = await assemble({}, { agent: agentA }, async () => assemblyOf('find_tools', 'read', 'call_tool'))
  const forB = await assemble({}, { agent: agentB }, async () => assemblyOf('find_tools', 'read', 'call_tool'))
  assert.deepEqual(forA.tools.map((tool) => tool.name), ['find_tools', 'call_tool'])
  assert.deepEqual(forB.tools.map((tool) => tool.name), ['find_tools', 'read', 'call_tool'])

  // 执行守卫
  assert.equal(guard({ name: 'read', agent: agentA }), DENY_REASON)
  assert.equal(guard({ name: 'read', agent: agentB }), undefined)

  // 提示段落
  assert.match(section.text({ agent: agentA }), /find_tools/)
  assert.equal(section.text({ agent: agentB }), '')
})

test('端到端：子代理会话跟随父会话的开关', async () => {
  const parent = { id: 'parent-1', header: {} }
  const child = { id: 'child-1', header: { origin: 'subagent', parentSession: 'parent-1' } }
  const agents = new Map([['parent-1', parent], ['child-1', child]])
  const ctx = stubCtx({ storage: stubStorageDomain(new Map([['parent-1', { enabled: false }]])), agents })
  await apply(ctx)

  // 子代理自己没有任何记录，但它跟着父走 —— 父关了，它也放开。
  const assembly = await ctx.handlerOf('system-prompt/assemble')(
    {}, { agent: { session: child } }, async () => assemblyOf('find_tools', 'read'),
  )
  assert.deepEqual(assembly.tools.map((tool) => tool.name), ['find_tools', 'read'])
  assert.equal(ctx.guards[0]({ name: 'read', agent: { session: child } }), undefined)
})

test('没有 webServer / connection 时不注册路由，但网关照常工作并告警一次', async () => {
  const ctx = stubCtx({ storage: stubStorageDomain(), withWeb: false })
  await apply(ctx)

  assert.equal(ctx.routes.length, 0)
  assert.equal(ctx.registeredTools.length, 2)
  assert.equal(ctx.guards.length, 1)
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /webServer/)
})

test('storage 用不了时仍然挂得起来，只是开关不持久', async () => {
  const ctx = stubCtx({ storage: undefined })
  await apply(ctx)

  assert.equal(ctx.registeredTools.length, 2)
  // storageDomain 缺席 → switch-state 自己降级并告警。
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /storageDomain/)
})

test('卸载时把开关状态关掉', async () => {
  const storage = stubStorageDomain()
  const ctx = stubCtx({ storage })
  await apply(ctx)

  assert.equal(storage.calls.closed, 0)
  // 第一个 disposer 是开关状态的（host.js 里注册得最早）。
  const closeState = ctx.disposers[0]
  assert.equal(typeof closeState, 'function')
  await closeState()
  assert.equal(storage.calls.closed, 1)
})

test('maxResults 配置会被 find_tools 用上（非法值回落到默认）', async () => {
  const ctx = stubCtx({ storage: stubStorageDomain() })
  await apply(ctx, { maxResults: 0 })
  const findTools = ctx.registeredTools.find((tool) => tool.name === 'find_tools')
  // 空查询会直接返回提示，不碰 catalog —— 这里只证明配置没有把插件搞崩。
  const result = await findTools.execute({ query: '' }, { agent: agentOf('session-a') })
  assert.match(result.text, /query/)
})
