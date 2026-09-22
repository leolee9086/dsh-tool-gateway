/**
 * 网关层的行为测试：可见性过滤、执行守卫、提示段落，以及它们**按会话开关**的行为。
 *
 * 这里的 ctx 是手写的桩 —— 网关层只碰 `ctx.on` / `ctx.effect` / `ctx.tools.guard` /
 * `ctx.systemPrompt.section` 四个入口，桩足够表达契约，不需要真跑一个 DSH。
 *
 * `enabledFor` 在这个文件里是直接给死值的函数：开关状态怎么算（归属会话、持久化）
 * 是 host.js 那一层的事，各有自己的测试文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DENY_REASON, installAssembleFilter, installGuard, installNotice, noticeText } from '../src/gateway.js'

/** 够用的插件上下文桩。 */
function stubCtx() {
  const listeners = new Map()
  const guards = []
  const sections = []
  return {
    guards,
    sections,
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
    },
    effect(fn) {
      fn()
    },
    tools: {
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
    /** 取某个事件注册的第一个监听器。 */
    handlerOf(name) {
      return listeners.get(name)?.[0]
    },
  }
}

/** 造一份装配产物，tools 只填名字。 */
const assemblyOf = (...names) => ({
  sections: [],
  contexts: [],
  variables: {},
  tools: names.map((name) => ({ name })),
})

/** 一个假 agent：网关层只用它去问开关，别的什么都不看。 */
const agent = { session: { id: 'session-x', header: {} } }

const alwaysOn = () => true
const alwaysOff = () => false

test('可见性过滤：只留白名单里的工具', async () => {
  const ctx = stubCtx()
  installAssembleFilter(ctx, new Set(['find_tools', 'call_tool']), alwaysOn, () => {})
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, { agent }, async () => assemblyOf('find_tools', 'read', 'bash', 'call_tool'))
  assert.deepEqual(result.tools.map((tool) => tool.name), ['find_tools', 'call_tool'])
})

test('可见性过滤：保留装配产物的其它字段', async () => {
  const ctx = stubCtx()
  installAssembleFilter(ctx, new Set(['find_tools']), alwaysOn, () => {})
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, { agent }, async () => ({
    ...assemblyOf('find_tools', 'read'),
    sections: [{ name: 'persona', order: 0, text: 'hi' }],
    variables: { cwd: '/work' },
  }))
  assert.equal(result.sections.length, 1)
  assert.equal(result.variables.cwd, '/work')
})

test('可见性过滤：白名单一个都没匹配到时，放行完整目录并告警一次', async () => {
  const ctx = stubCtx()
  const warnings = []
  installAssembleFilter(ctx, new Set(['find_tools']), alwaysOn, (error) => warnings.push(error))
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, { agent }, async () => assemblyOf('read', 'bash'))
  // 工具多一点只是浪费；把会话搞成零工具是事故。
  assert.equal(result.tools.length, 2)
  assert.equal(warnings.length, 1)
})

test('可见性过滤：会话把网关关掉时，工具表原样返回', async () => {
  const ctx = stubCtx()
  installAssembleFilter(ctx, new Set(['find_tools', 'call_tool']), alwaysOff, () => {})
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, { agent }, async () => assemblyOf('find_tools', 'read', 'bash', 'call_tool'))
  assert.deepEqual(result.tools.map((tool) => tool.name), ['find_tools', 'read', 'bash', 'call_tool'])
})

test('可见性过滤：装配里没有 agent（诊断装配）时按默认处理，维持约束', async () => {
  const ctx = stubCtx()
  // enabledFor 收到 undefined 时返回 true —— 这正是 host.js 里的默认策略。
  const seen = []
  installAssembleFilter(ctx, new Set(['find_tools']), (target) => {
    seen.push(target)
    return true
  }, () => {})
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, {}, async () => assemblyOf('find_tools', 'read'))
  assert.deepEqual(seen, [undefined])
  assert.deepEqual(result.tools.map((tool) => tool.name), ['find_tools'])
})

test('执行守卫：放行两个元工具', () => {
  const ctx = stubCtx()
  installGuard(ctx, new Set(['find_tools', 'call_tool']), alwaysOn)
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'find_tools', agent }), undefined)
  assert.equal(guard({ name: 'call_tool', agent }), undefined)
})

test('执行守卫：放行带 parent 的子分发（call_tool 内部发起的调用）', () => {
  const ctx = stubCtx()
  installGuard(ctx, new Set(['find_tools', 'call_tool']), alwaysOn)
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'read', parent: { token: 'x' }, agent }), undefined)
})

test('执行守卫：拒绝模型对其它工具的直接调用，理由写给模型看', () => {
  const ctx = stubCtx()
  installGuard(ctx, new Set(['find_tools', 'call_tool']), alwaysOn)
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'read', agent }), DENY_REASON)
  assert.equal(guard({ name: 'zhihu_search', agent }), DENY_REASON)
  // 拒绝理由要能指导下一步，不是错误码。
  assert.match(DENY_REASON, /find_tools/)
  assert.match(DENY_REASON, /call_tool/)
})

test('执行守卫：会话把网关关掉时不拦，模型可以直接调', () => {
  const ctx = stubCtx()
  installGuard(ctx, new Set(['find_tools', 'call_tool']), alwaysOff)
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'read', agent }), undefined)
})

test('执行守卫：子分发的放行在开关之前判定 —— 关掉的会话里子分发照样走', () => {
  const ctx = stubCtx()
  // 开关故意写成"读到就抛"，用来证明带 parent 的调用根本没走到它。
  installGuard(ctx, new Set(['find_tools']), () => { throw new Error('不该被问到') })
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'read', parent: { token: 'x' }, agent }), undefined)
})

test('提示段落：开着的会话拿到完整文案', () => {
  const ctx = stubCtx()
  installNotice(ctx, alwaysOn)

  assert.equal(ctx.sections.length, 1)
  const section = ctx.sections[0]
  assert.equal(section.name, 'tool-gateway')
  // text 是 (context) => string：段落每次装配重新求值，于是同一个注册对不同会话
  // 给出不同内容。它只按**用户显式设置的开关**分支，不扫会话事件、不按历史分档。
  assert.equal(typeof section.text, 'function')
  const text = section.text({ agent })
  assert.match(text, /find_tools/)
  assert.match(text, /call_tool/)
  // 排在各工具说明（order 1000+）之前，让模型先读到规则。
  assert.ok(section.order < 1000)
})

test('提示段落：关掉的会话拿到空串，不在系统提示里留一个空标题', () => {
  const ctx = stubCtx()
  installNotice(ctx, alwaysOff)

  assert.equal(ctx.sections[0].text({ agent }), '')
})

test('提示段落：文案里说清了"历史里出现过的工具名不要直接输出"', () => {
  assert.match(noticeText(), /不要直接输出历史里出现过的工具名/)
})

test('提示段落：文案要求"每一次动手之前都先查"（这是网关的目的，不是省 token）', () => {
  assert.match(noticeText(), /每一次动手之前都先查清楚/)
})
