/**
 * PTC 子调用日志副本的行为测试。
 *
 * 核心约束来自官方 PTC：`tool/ptc-dispatch` 这一份是**只给日志看的**——
 * 监听者可以在写进会话之前把它换成预览，程序拿到的值不受影响；监听器失败
 * 必须回退原文，不能让一次记录失败毁掉工具调用。网关曾经绕过这条通道，
 * 把一个会话写到了 892MB 的日志。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { closeRunLogWork, invokeTool, openRunLogWork } from '../src/meta-tools.js'

/** 造一份最小的执行上下文：只需要 append 和身份字段。 */
function makeExec(appended, callId = 'call-1') {
  return {
    callId,
    agent: { session: { header: { id: 'session-x' }, append: (event, data) => appended.push({ event, data }) } },
    signal: new AbortController().signal,
    token: { id: 'token-1' },
    toolSet: undefined,
  }
}

/** 一个成功的文本结果。 */
const textResult = (text) => ({ isError: false, content: [{ type: 'text', text }] })

/** 记录告警的插件上下文桩；waterfall 交给用例决定怎么回应。 */
function stubCtx(inspect) {
  const warnings = []
  return {
    warnings,
    tools: {},
    logger: { warn: (message) => warnings.push(message) },
    async waterfall(_target, event, dispatch, next) {
      assert.equal(event, 'tools/ptc-dispatch-log')
      return inspect === undefined ? next() : inspect(dispatch, next)
    },
  }
}

const base = {
  callIdSuffix: 'code:1',
  scopeTarget: (target) => target,
  executeNested: async () => textResult('x'.repeat(5000)),
}

test('日志副本走瀑布：监听器换成预览，程序拿到的值不变', async () => {
  const appended = []
  const ctx = stubCtx((dispatch) => [{ type: 'text', text: `preview of ${dispatch.content.length}` }])
  const outcome = await invokeTool({ ...base, ctx, name: 'big_tool', args: { a: 1 }, exec: makeExec(appended) })

  // 程序拿到的是原文：5000 个字符一个字都没少。
  assert.equal(outcome.text.length, 5000)
  const dispatch = appended.find((entry) => entry.event === 'tool/ptc-dispatch')
  assert.deepEqual(dispatch.data.content, [{ type: 'text', text: 'preview of 1' }])
})

test('监听器抛错：回退原文并告警一次，工具调用照常成功', async () => {
  const appended = []
  const ctx = stubCtx(() => { throw new Error('spill backend down') })
  const outcome = await invokeTool({ ...base, ctx, name: 'big_tool', args: {}, exec: makeExec(appended) })

  assert.equal(outcome.isError, false)
  const dispatch = appended.find((entry) => entry.event === 'tool/ptc-dispatch')
  assert.equal(dispatch.data.content[0].text.length, 5000)
  assert.equal(ctx.warnings.length, 1)
  assert.match(ctx.warnings[0], /spill backend down/)
})

test('没有 scopeTarget 的旧宿主：退回原文，不调瀑布', async () => {
  const appended = []
  const ctx = stubCtx(() => { throw new Error('不该走到这里') })
  const outcome = await invokeTool({ ...base, ctx, name: 't', args: {}, scopeTarget: undefined, exec: makeExec(appended) })

  assert.equal(outcome.isError, false)
  const dispatch = appended.find((entry) => entry.event === 'tool/ptc-dispatch')
  assert.equal(dispatch.data.content[0].text.length, 5000)
})

test('log=false：外层 call_tool 绑定不记事件（内层会记真正被调的工具）', async () => {
  const appended = []
  const ctx = stubCtx()
  await invokeTool({ ...base, ctx, name: 'call_tool', args: {}, log: false, exec: makeExec(appended) })

  assert.deepEqual(appended, [])
})

test('有运行账本时日志异步登记：drain 之后才写进会话，期间程序已经拿到值', async () => {
  const appended = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = stubCtx(async (dispatch, next) => { await gate; return next() })
  const exec = makeExec(appended)

  const runLogWork = new Map()
  const work = openRunLogWork(JSON.stringify(['session-x', 'call-1']), runLogWork)
  const outcome = await invokeTool({ ...base, ctx, name: 't', args: {}, exec, runLogWork })

  // 程序已经拿到值，而日志副本还卡在瀑布里 —— 落盘不拖住绑定。
  assert.equal(outcome.text.length, 5000)
  assert.equal(work.size, 1)
  assert.equal(appended.filter((entry) => entry.event === 'tool/ptc-dispatch').length, 0)

  release()
  await closeRunLogWork(JSON.stringify(['session-x', 'call-1']), runLogWork)
  assert.equal(appended.filter((entry) => entry.event === 'tool/ptc-dispatch').length, 1)
})

test('没有运行账本的调用：等日志写完再返回（模型直接调 call_tool）', async () => {
  const appended = []
  const ctx = stubCtx()
  await invokeTool({ ...base, ctx, name: 't', args: {}, exec: makeExec(appended, 'call-solo') })

  assert.equal(appended.filter((entry) => entry.event === 'tool/ptc-dispatch').length, 1)
})
