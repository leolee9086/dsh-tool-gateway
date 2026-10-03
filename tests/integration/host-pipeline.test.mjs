/**
 * 集成测试：网关派发出去的子调用，走真实的注册表执行流水线。
 *
 * 这个文件显式地扮演"外部 Host"。网关自身从不定位、也不 import 任何 Harness
 * checkout，默认测试套件（`tests/*.test.mjs`）也不包含这个子目录。
 *
 * **为什么非要有它。** 网关派发的每一跳都经过注册表的完整流水线，而流水线上的
 * 逐调用审查要读 `ToolExecutionInput.schema`：auto-review 要求它非空、且名字与这次
 * 调用一致（auto-review/src/index.ts:342），内置 PTC 也是带着它派发 inner call 的
 * （core/tools/src/ptc.ts:550）。"参数到底有没有传对"只有把真实流水线接上才测得出来 ——
 * 在测试里手搓一个 `ctx.tools`，只会让被测的东西变成一个跟我一样无知的替身。
 *
 * 跑法（需要一个已构建的 checkout）：
 *
 *   DSH_TEST_CHECKOUT=D:\dev\deepseek-harness pnpm run test:integration
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { invokeTool } from '../../src/meta-tools.js'

if (!process.env.DSH_TEST_CHECKOUT) {
  throw new Error(
    'test:integration 需要 DSH_TEST_CHECKOUT 指向一个已构建的 Harness checkout；'
    + '默认测试套件不包含这个文件。',
  )
}
const checkout = resolve(process.env.DSH_TEST_CHECKOUT)
const load = async (path) => import(pathToFileURL(resolve(checkout, path)).href)

const { Context } = await load('vendor/cordis/lib/index.js')
const llm = await load('packages/llm/llm/lib/index.js')
const sessionPkg = await load('packages/core/session/lib/index.js')
const toolsPkg = await load('packages/core/tools/lib/index.js')
const projectionPkg = await load('packages/session/session-projection/lib/index.js')
const promptPkg = await load('packages/core/system-prompt/lib/index.js')
const approvalPkg = await load('packages/interaction/user-approval/lib/index.js')
const permissionPkg = await load('packages/interaction/permission-presets/lib/index.js')
const autoReview = await load('packages/experimental/auto-review/lib/index.js')

/** 三个权限预设，照 permission-presets 的 Config 形状。 */
const PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask', name: 'Read only' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'Workspace write' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'Full access' },
}

/** 审查用的模型端点。脚本用完就抛 —— 用例没写脚本说明它本来就不该被问到。 */
class ReviewAdapter extends llm.LlmAdapter {
  #script
  requests = []

  constructor(script) { super(); this.#script = [...script] }

  async *stream(options) {
    this.requests.push(options)
    const response = this.#script.shift()
    if (response === undefined) throw new Error('review adapter script exhausted')
    for (const chunk of response) yield chunk
  }
}

/** 一段"允许"的审查响应。 */
function allowChunks() {
  const text = '{"risk":"low","decision":"allow"}'
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 把整套服务装起来，跟产品里一样都在同一个 Context 上。 */
async function harness(script = []) {
  const ctx = new Context()
  await ctx.plugin(llm.LlmRuntime)
  await ctx.plugin(sessionPkg.default)
  await ctx.plugin(projectionPkg.default)
  await ctx.plugin(promptPkg.default, {})
  await ctx.plugin(toolsPkg.default)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('这个用例不执行 shell 请求') },
    run() { throw new Error('这个用例不执行 shell 请求') },
    start() { throw new Error('这个用例不执行 shell 请求') },
  })
  await ctx.plugin(approvalPkg.default, { policy: 'ask' })
  await ctx.plugin(permissionPkg.default, { presets: PRESETS, defaultPreset: 'workspace-write' })
  const adapter = new ReviewAdapter(script)
  ctx.llm.registerAdapter(['review'], adapter)
  await ctx.plugin(autoReview)
  return { ctx, adapter }
}

/** 一个开了 Auto 的会话，外加它对应的 agent。 */
function autoSession(ctx, id) {
  const session = ctx.sessions.create(sessionPkg.SessionId(id), { meta: { cwd: '/workspace' } })
  ctx.permissionPresets.set(session, permissionPkg.AUTO_PRESET)
  const agent = { id: session.id, session, options: { provider: 'review', model: 'same-model' } }
  approvalPkg.setApprovalPolicy(session, 'never')
  return { session, agent }
}

function registerProbe(ctx, name) {
  let runs = 0
  ctx.tools.register(toolsPkg.defineContentToolFixture({
    name,
    description: '探针工具',
    parameters: { path: { type: 'string' } },
    async execute() { runs += 1; return [{ type: 'text', text: 'ran' }] },
  }))
  return () => runs
}

/**
 * 造出"模型直接调了一次 call_tool，网关正要派发子调用"那一刻的会话日志。
 *
 * 外层那一跳（step/start、assistant 的 tool-call、tool/call）本来是 agent-loop 写的；
 * 这里手工补上，因为被测的是**网关自己**记的那条 tool/ptc-dispatch-start 与它派发时
 * 带上什么。
 */
function seedOuterCall(ctx, session, outerCallId) {
  const OUTER_ARGS = JSON.stringify({ tool_name: 'probe', arguments: { path: 'x' } })
  session.append('request/header', {
    header: { config: { provider: 'review', model: 'same-model' } },
    reason: session.requestHeader() === undefined ? 'initial' : 'change',
  })
  session.append('user/message', llm.createUserMessage({
    content: [{ type: 'text', text: '读一个文件' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: llm.createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: outerCallId, name: 'call_tool', arguments: OUTER_ARGS }],
      source: { kind: 'model', provider: 'review', model: 'same-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: outerCallId, name: 'call_tool', arguments: OUTER_ARGS })
  return ctx
}

/** 派发一次子调用，参数照网关自己的形状（这里就是被测的那条路径）。 */
function dispatch(ctx, { session, agent }, outerCallId, { resolveSchema }) {
  return invokeTool({
    ctx,
    name: 'probe',
    args: { path: 'x' },
    exec: {
      callId: outerCallId,
      rootCallId: outerCallId,
      token: Symbol('outer execution'),
      signal: new AbortController().signal,
      agent,
    },
    callIdSuffix: 'meta',
    resolveSchema,
  })
}

/** 从注册表里按名字取 schema —— host.js 的 viewOf 就是这么喂给 invokeTool 的。 */
const fromRegistry = (ctx) => (agent, name) => ctx.tools.schemas(agent).find((schema) => schema.name === name)

test('带上 schema 之后，子调用能过逐调用审查并真的执行', async () => {
  const { ctx, adapter } = await harness([allowChunks()])
  const runs = registerProbe(ctx, 'probe')
  const pair = autoSession(ctx, 'gateway-integration-ok')
  const outerCallId = llm.ToolCallId('outer-call')
  seedOuterCall(ctx, pair.session, outerCallId)

  const outcome = await dispatch(ctx, pair, outerCallId, { resolveSchema: fromRegistry(ctx) })

  assert.equal(runs(), 1, '子调用应该真的被执行')
  assert.equal(outcome.isError, false)
  assert.equal(adapter.requests.length, 1, '审查者应该被问了一次')
})

test('派发出去的那一跳，在流水线上带着自己的 schema', async () => {
  const { ctx } = await harness([allowChunks()])
  const runs = registerProbe(ctx, 'probe')
  const pair = autoSession(ctx, 'gateway-integration-schema')
  const outerCallId = llm.ToolCallId('outer-call')
  seedOuterCall(ctx, pair.session, outerCallId)

  // 站在流水线上看这一次子调用：审查者能看到的，就是这里能看到的。
  let seen
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'probe') seen = exec
    return next()
  })

  const outcome = await dispatch(ctx, pair, outerCallId, { resolveSchema: fromRegistry(ctx) })

  assert.equal(outcome.isError, false)
  assert.equal(runs(), 1)
  assert.notEqual(seen, undefined, 'pre-execute 应该看到这次子调用')
  assert.notEqual(seen.parent, undefined, '它应该被标记成子派发，而不是模型直接调用')
  assert.equal(seen.schema?.name, 'probe', '它应该带着自己的 schema，且与 name 一致')
})
