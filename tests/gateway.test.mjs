/**
 * 网关层的行为测试：可见性过滤、执行守卫、提示段落，以及它们**按会话开关**的行为。
 *
 * 这里的 ctx 是手写的桩 —— 网关层只碰 `ctx.on` / `ctx.effect` / `ctx.tools.guard` /
 * `ctx.systemPrompt.section` 四个入口，桩足够表达契约，不需要真跑一个 DSH。
 *
 * 名单在这个文件里是写死的函数：**名单里为什么是三个或两个元工具**（PTC 开不开）
 * 是 host.js 那一层的事，各有自己的测试文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { denyReason, installAssembleFilter, installGuard, installNotice, noticeText } from '../src/gateway.js'

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

/** 一个假 agent：网关层只用它去问开关与名单，别的什么都不看。 */
const agent = { session: { id: 'session-x', header: {} } }

const alwaysOn = () => true
const alwaysOff = () => false

/** PTC 没开时的名单：两个元工具。 */
const keepTwo = () => new Set(['find_tools', 'call_tool'])
/** PTC 开着时的名单：多一个批量调用的（而它其实在 PTC 下也调不到）。 */
const keepThree = () => new Set(['find_tools', 'call_tool', 'call_tools'])

test('可见性过滤：只留名单里的工具', async () => {
  const ctx = stubCtx()
  installAssembleFilter(ctx, keepTwo, alwaysOn, () => {})
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, { agent }, async () => assemblyOf('find_tools', 'read', 'bash', 'call_tool'))
  assert.deepEqual(result.tools.map((tool) => tool.name), ['find_tools', 'call_tool'])
})

test('可见性过滤：名单里有第三个时它也在', async () => {
  const ctx = stubCtx()
  installAssembleFilter(ctx, keepThree, alwaysOn, () => {})
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, { agent }, async () => assemblyOf('find_tools', 'read', 'call_tool', 'call_tools'))
  assert.deepEqual(result.tools.map((tool) => tool.name), ['find_tools', 'call_tool', 'call_tools'])
})

test('可见性过滤：名单是按 agent 现算的，不同会话可以不一样', async () => {
  const ctx = stubCtx()
  // 一个会话在 PTC 模式（两个），另一个不在（三个）。
  installAssembleFilter(ctx, (target) => (target === agent ? keepTwo() : keepThree()), alwaysOn, () => {})
  const handler = ctx.handlerOf('system-prompt/assemble')
  const other = { session: { id: 'session-y', header: {} } }

  const forAgent = await handler({}, { agent }, async () => assemblyOf('find_tools', 'call_tool', 'call_tools'))
  const forOther = await handler({}, { agent: other }, async () => assemblyOf('find_tools', 'call_tool', 'call_tools'))
  assert.deepEqual(forAgent.tools.map((tool) => tool.name), ['find_tools', 'call_tool'])
  assert.deepEqual(forOther.tools.map((tool) => tool.name), ['find_tools', 'call_tool', 'call_tools'])
})

test('可见性过滤：保留装配产物的其它字段', async () => {
  const ctx = stubCtx()
  installAssembleFilter(ctx, () => new Set(['find_tools']), alwaysOn, () => {})
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, { agent }, async () => ({
    ...assemblyOf('find_tools', 'read'),
    sections: [{ name: 'persona', order: 0, text: 'hi' }],
    variables: { cwd: '/work' },
  }))
  assert.equal(result.sections.length, 1)
  assert.equal(result.variables.cwd, '/work')
})

test('可见性过滤：名单一个都没匹配到时，放行完整目录并告警一次', async () => {
  const ctx = stubCtx()
  const warnings = []
  installAssembleFilter(ctx, () => new Set(['find_tools']), alwaysOn, (error) => warnings.push(error))
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, { agent }, async () => assemblyOf('read', 'bash'))
  // 工具多一点只是浪费；把会话搞成零工具是事故。
  assert.equal(result.tools.length, 2)
  assert.equal(warnings.length, 1)
})

test('可见性过滤：会话把网关关掉时，工具表原样返回', async () => {
  const ctx = stubCtx()
  installAssembleFilter(ctx, keepTwo, alwaysOff, () => {})
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, { agent }, async () => assemblyOf('find_tools', 'read', 'bash', 'call_tool'))
  assert.deepEqual(result.tools.map((tool) => tool.name), ['find_tools', 'read', 'bash', 'call_tool'])
})

test('可见性过滤：装配里没有 agent（诊断装配）时按默认处理，维持约束', async () => {
  const ctx = stubCtx()
  // enabledFor 收到 undefined 时返回 true —— 这正是 host.js 里的默认策略。
  const seen = []
  installAssembleFilter(ctx, () => new Set(['find_tools']), (target) => {
    seen.push(target)
    return true
  }, () => {})
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, {}, async () => assemblyOf('find_tools', 'read'))
  assert.deepEqual(seen, [undefined])
  assert.deepEqual(result.tools.map((tool) => tool.name), ['find_tools'])
})

test('可见性过滤：名单算不出来时降级放行，不让会话起不来', async () => {
  const ctx = stubCtx()
  const warnings = []
  installAssembleFilter(ctx, () => { throw new Error('注册表炸了') }, alwaysOn, (error) => warnings.push(error))
  const handler = ctx.handlerOf('system-prompt/assemble')

  const result = await handler({}, { agent }, async () => assemblyOf('find_tools', 'read'))
  assert.equal(result.tools.length, 2)
  assert.equal(warnings.length, 1)
})

test('执行守卫：放行名单里的元工具', () => {
  const ctx = stubCtx()
  installGuard(ctx, keepThree, alwaysOn)
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'find_tools', agent }), undefined)
  assert.equal(guard({ name: 'call_tool', agent }), undefined)
  assert.equal(guard({ name: 'call_tools', agent }), undefined)
})

test('执行守卫：放行带 parent 的子分发（call_tool 内部发起的调用）', () => {
  const ctx = stubCtx()
  installGuard(ctx, keepTwo, alwaysOn)
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'read', parent: { token: 'x' }, agent }), undefined)
})

test('执行守卫：拒绝模型对其它工具的直接调用，理由写给模型看', () => {
  const ctx = stubCtx()
  installGuard(ctx, keepTwo, alwaysOn)
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'read', agent }), denyReason(keepTwo()))
  assert.equal(guard({ name: 'zhihu_search', agent }), denyReason(keepTwo()))
  // 拒绝理由要能指导下一步，不是错误码。
  const reason = denyReason(keepTwo())
  assert.match(reason, /find_tools/)
  assert.match(reason, /call_tool/)
})

test('执行守卫：拒绝理由按这个会话实际可用的元工具生成', () => {
  const ctx = stubCtx()
  installGuard(ctx, keepThree, alwaysOn)
  const guard = ctx.guards[0]

  const reason = guard({ name: 'read', agent })
  assert.match(reason, /call_tools/)
  assert.equal(reason, denyReason(keepThree()))
  // PTC 开着时不能提 call_tools —— 那会把模型引向一个不存在的工具。
  assert.doesNotMatch(denyReason(keepTwo()), /call_tools/)
})

test('执行守卫：会话把网关关掉时不拦，模型可以直接调', () => {
  const ctx = stubCtx()
  installGuard(ctx, keepTwo, alwaysOff)
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'read', agent }), undefined)
})

test('执行守卫：子分发的放行在开关之前判定 —— 关掉的会话里子分发照样走', () => {
  const ctx = stubCtx()
  // 开关与名单故意写成“读到就抛”，用来证明带 parent 的调用根本没走到它们。
  installGuard(ctx, () => { throw new Error('不该被问到') }, () => { throw new Error('不该被问到') })
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'read', parent: { token: 'x' }, agent }), undefined)
})

test('提示段落：开着的会话拿到完整文案', () => {
  const ctx = stubCtx()
  installNotice(ctx, keepTwo, alwaysOn)

  assert.equal(ctx.sections.length, 1)
  const section = ctx.sections[0]
  assert.equal(section.name, 'tool-gateway')
  // text 是 (context) => string：段落每次装配重新求值，于是同一个注册对不同会话
  // 给出不同内容。它只按**用户显式设置的开关**分支，不扫会话事件、不按历史分档。
  assert.equal(typeof section.text, 'function')
  const text = section.text({ agent })
  assert.match(text, /find_tools/)
  assert.match(text, /call_tool/)
  assert.match(text, /只暴露 2 个工具/)
  // 排在各工具说明（order 1000+）之前，让模型先读到规则。
  assert.ok(section.order < 1000)
})

test('提示段落：PTC 开着时不提 call_tools，提了反而是误导', () => {
  const ctx = stubCtx()
  installNotice(ctx, keepTwo, alwaysOn)
  assert.doesNotMatch(ctx.sections[0].text({ agent }), /call_tools/)

  const withCode = stubCtx()
  installNotice(withCode, keepThree, alwaysOn)
  const text = withCode.sections[0].text({ agent })
  assert.match(text, /call_tools/)
  assert.match(text, /只暴露 3 个工具/)
})

test('提示段落：关掉的会话拿到空串，不在系统提示里留一个空标题', () => {
  const ctx = stubCtx()
  installNotice(ctx, keepTwo, alwaysOff)

  assert.equal(ctx.sections[0].text({ agent }), '')
})

test('提示段落：文案里说清了“历史里出现过的工具名不要直接输出”', () => {
  assert.match(noticeText(keepTwo()), /不要直接输出历史里出现过的工具名/)
})

test('提示段落：文案要求“每一次动手之前都先查”（这是网关的目的，不是省 token）', () => {
  assert.match(noticeText(keepTwo()), /每一次动手之前都先查清楚/)
})

test('守卫：硬禁用先于子分发那条判 —— call_tool 也绕不过去', () => {
  const ctx = stubCtx()
  const banFor = (execution) => (execution?.name === 'ask_user_question' ? 'no' : undefined)
  installGuard(ctx, keepTwo, alwaysOn, banFor)
  const guard = ctx.guards[0]

  // 模型直接调用：拒。
  assert.equal(guard({ name: 'ask_user_question', agent }), 'no')
  // 子分发（call_tool / call_tools 内部发起的调用）：**一样拒**。
  // 这正是「禁用」与「没让它露面」的区别，也是这次合并真正要保证的行为 ——
  // 禁用的名字连元工具路由也别想搬动它。
  assert.equal(guard({ name: 'ask_user_question', agent, parent: 'parent-token' }), 'no')
})

test('守卫：名单外的子分发照常放行（合并没有收紧网关的语义）', () => {
  const ctx = stubCtx()
  installGuard(ctx, keepTwo, alwaysOn, () => undefined)
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'read', agent, parent: 'parent-token' }), undefined)
  assert.match(guard({ name: 'read', agent }), /工具调用方式已改变/)
})

test('守卫：不传 banFor 时行为与合并前完全一致', () => {
  const ctx = stubCtx()
  installGuard(ctx, keepTwo, alwaysOn)
  const guard = ctx.guards[0]

  assert.equal(guard({ name: 'read', agent, parent: 'parent-token' }), undefined)
  assert.match(guard({ name: 'read', agent }), /工具调用方式已改变/)
  // 关掉的会话里网关规则整个不生效（硬禁用如果传了，它仍然先判 —— 见上一条用例）。
  const off = stubCtx()
  installGuard(off, keepTwo, alwaysOff, () => undefined)
  assert.equal(off.guards[0]({ name: 'read', agent }), undefined)
})
