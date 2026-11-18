/** Real Loader + AgentLoop + HTTP regression. Only model responses are scripted. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'

const checkout = process.env.DSH_TEST_CHECKOUT
assert.ok(checkout, 'DSH_TEST_CHECKOUT must identify the real source checkout')
const require = createRequire(resolve(checkout, 'vendor/include/package.json'))
const { load: parse } = require('js-yaml')

class ScriptedModel extends LlmAdapter {
  requests = []
  script = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(request) {
    this.requests.push(request)
    const step = this.script.shift()
    assert.ok(step, 'unexpected model request')
    const block = typeof step === 'function' ? await step(request) : step
    const type = block.type === 'tool-call' ? 'tool-call' : 'text'
    yield { type: 'block-start', index: 0, blockType: type }
    if (type === 'tool-call') yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
    else yield { type: 'text-delta', index: 0, text: block.text }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: type === 'tool-call' ? 'tool-calls' : 'stop' } }
  }
}
const done = { type: 'text', text: 'done' }
let sequence = 0
const call = (name, args = {}) => ({ type: 'tool-call', id: `call-${++sequence}`, name, arguments: JSON.stringify(args) })

async function boot(t, { runtime = false, gatewayConfig = {}, ptc = false } = {}) {
  const scratch = await mkdtemp(resolve(tmpdir(), 'gateway-host-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(scratch, { recursive: true, force: true }) })
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(resolve(checkout, 'package.json')).href })
  const entries = parse(await readFile(new URL('../fixtures/real-host.cordis.yml', import.meta.url), 'utf8'))
  const names = {
    llm: '@deepseek-ai/dsh-llm', sessions: '@deepseek-ai/dsh-session',
    projections: '@deepseek-ai/dsh-session-projection', prompt: '@deepseek-ai/dsh-system-prompt',
    tools: '@deepseek-ai/dsh-tools', native: '@deepseek-ai/dsh-tool-executor-native',
    agents: '@deepseek-ai/dsh-agent', loop: '@deepseek-ai/dsh-agent-loop', meter: '@deepseek-ai/dsh-token-meter',
    credentials: '@deepseek-ai/dsh-credentials-local', web: '@deepseek-ai/dsh-host-webserver',
    connection: '@deepseek-ai/dsh-client-connection',
    gateway: process.env.GATEWAY_TEST_ENTRY ?? new URL('../../src/host.js', import.meta.url).href,
  }
  const modern = (await readFile(resolve(checkout, 'packages/core/tools/src/index.ts'), 'utf8')).includes('async resolve(context:')
  for (const entry of entries) {
    if (entry.id === 'native' && !modern) continue
    if (entry.id === 'gateway') {
      if (runtime) {
        for (const part of ['fs-local', 'working-directory', 'subprocess-local', 'sandbox-local', 'sandbox-policy', 'ptc-runtime-node']) {
          await ctx.loader.root.create({ id: part, name: '@deepseek-ai/dsh-' + part,
            config: part === 'sandbox-policy' ? { mode: 'danger-full-access' }
              : part === 'ptc-runtime-node' && typeof runtime === 'object' ? runtime : {} })
          await ctx.loader.await()
        }
      }
      entry.config = gatewayConfig
    }
    entry.name = ptc && entry.id === 'native' ? '@deepseek-ai/dsh-tool-executor-ptc' : names[entry.id]
    if (entry.id === 'credentials') entry.config = { path: resolve(scratch, 'credentials.json'), watch: false }
    // Fail on a loading error rather than letting a missing plugin make assertions meaningless.
    await ctx.loader.root.create(entry)
    await ctx.loader.await()
  }
  for (const entry of ctx.loader.entries()) assert.equal(entry.fiber?.state, 2, `inactive ${entry.options.name}: ${entry.fiber?.error}`)
  const adapter = new ScriptedModel()
  ctx.llm.registerAdapter(['scripted'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('gateway-a'), { provider: 'scripted', model: 'fixture' })
  const other = await ctx.agentLoop.create(SessionId('gateway-b'), { provider: 'scripted', model: 'fixture' })
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  // 使用独立认证插件的真实HTTP交换；不读取任何安装环境凭据。
  await ctx.loader.root.create({ id: 'token-auth', name: '@deepseek-ai/dsh-host-authentication-token' })
  await ctx.loader.await()
  const { BrowserAuth } = await import(pathToFileURL(resolve(checkout, 'packages/host/authentication-token/src/browser-auth.ts')).href)
  const auth = await BrowserAuth.create(ctx[Context.root], ctx.credentials, 30)
  const login = await fetch(auth.authenticatedUrl(base + '/'), { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'actual connection service must issue cookie')
  const request = async (owner, changes) => {
    const response = await fetch(`${base}/api/tool-gateway${changes ? '' : `?sessionId=${owner.session.id}`}`, {
      method: changes ? 'POST' : 'GET', headers: { cookie, origin: base, 'content-type': 'application/json' },
      ...(changes ? { body: JSON.stringify({ sessionId: owner.session.id, ...changes }) } : {}),
    })
    const data = await response.json()
    assert.equal(response.status, 200, JSON.stringify(data))
    return data
  }
  const turn = async (owner, ...script) => {
    adapter.script.push(...script)
    const idle = new Promise<void>(resolve => {
      const off = ctx.on('agent/status', event => { if (event.agent === owner && event.status === 'idle') { off(); resolve() } })
    })
    owner.followup(createUserMessage({ content: [{ type: 'text', text: 'execute fixture' }], source: { kind: 'user' } }))
    await idle
    assert.equal(adapter.script.length, 0, 'loop stopped before consuming script; inspect session errors')
  }
  return { ctx, adapter, agent, other, request, turn, modern }
}

function probe(name, executed, value = name) {
  return {
    name, description: `Fixture ${name}`, parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    async execute(_args, exec) { executed.push({ name, value, agent: exec.agent, parent: exec.parent, toolSet: exec.toolSet, schema: exec.schema }); return value },
  }
}
const visible = request => request.tools.map(tool => tool.name).sort()
const results = agent => agent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data.message)
const resultText = agent => results(agent).at(-1).content.filter(block => block.type === 'text').map(block => block.text).join('\n')

test('real host: gateway ON/OFF/ON and call_tool execute on first next request', { timeout: 30000 }, async t => {
  const { ctx, adapter, agent, other, request, turn } = await boot(t)
  const executed = []
  ctx.tools.register(probe('probe', executed))
  await turn(agent, call('call_tool', { tool_name: 'probe', arguments: {} }), done)
  assert.deepEqual(visible(adapter.requests[0]), ['call_tool', 'find_tools'])
  assert.equal(executed.length, 1)
  assert.equal(executed[0].agent, agent)
  assert.ok(executed[0].parent)
  assert.equal(executed[0].schema.name, 'probe')
  await request(agent, { enabled: false })
  await turn(agent, call('probe'), done)
  assert.ok(visible(adapter.requests[2]).includes('probe'))
  assert.equal(executed.length, 2)
  await turn(other, call('probe'), done)
  assert.equal(executed.length, 2, 'other session must still reject direct hidden calls')
  await request(agent, { enabled: true })
  await turn(agent, call('probe'), done)
  assert.deepEqual(visible(adapter.requests[6]), ['call_tool', 'find_tools'])
  assert.equal(executed.length, 2)
  assert.equal(results(agent).at(-1).isError, true)
})

test('disabled tools and groups reject direct, call_tool and real call_tools execution', { timeout: 60000 }, async t => {
  const { ctx, adapter, agent, other, request, turn } = await boot(t, { runtime: true })
  const executed = []
  ctx.tools.register(probe('probe', executed))
  ctx.tools.register(probe('grouped', executed))
  ctx.toolGateway.registerGroup({ id: 'fixture-group', title: 'Fixture', defaultEnabled: false, names: ['grouped'] })
  const batch = name => call('call_tools', { description: 'Exercise actual child process bindings', code: `return (await tools.call_tool({tool_name:${JSON.stringify(name)},arguments:{}})).text` })
  await turn(agent, batch('probe'), done)
  assert.equal(results(agent).at(-1).isError, false, resultText(agent))
  assert.equal(executed.length, 1)
  assert.deepEqual(visible(adapter.requests[0]), ['call_tool', 'call_tools', 'find_tools'])
  await request(agent, { tool: 'probe', disabled: true })
  await turn(agent, call('find_tools', { detail: 'name' }), done)
  assert.doesNotMatch(resultText(agent), /- probe\b/)
  for (const entry of [call('probe'), call('call_tool', { tool_name: 'probe', arguments: {} }), batch('probe'), batch('grouped')]) {
    await turn(agent, entry, done)
    assert.equal(results(agent).at(-1).isError, true, resultText(agent))
    assert.equal(executed.length, 1)
  }
  await request(agent, { enabled: false })
  await turn(agent, call('probe'), done)
  assert.equal(results(agent).at(-1).isError, true)
  assert.ok(!visible(adapter.requests.at(-1)).includes('probe'))
  await turn(other, batch('probe'), done)
  assert.equal(executed.length, 2, 'another session retains its own enabled state')
  await request(agent, { group: 'fixture-group', enabled: true })
  await turn(agent, batch('grouped'), done)
  assert.equal(results(agent).at(-1).isError, false, resultText(agent))
  await request(agent, { tool: 'probe', disabled: false })
  await turn(agent, batch('probe'), done)
  assert.deepEqual(executed.map(item => item.name), ['probe', 'probe', 'grouped', 'probe'])
})

test('scoped ancestors, nearest shadow, conditional admission and unload remain host-owned', { timeout: 30000 }, async t => {
  const { ctx, adapter, agent, other, request, turn, modern } = await boot(t)
  const executed = []
  ctx.tools.register(probe('shared', executed, 'global'))
  const key = { preset: 'fixture' }
  let preset
  await ctx.plugin(Object.assign(inner => { preset = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
  preset.ctx.tools.register(probe('ancestor', executed))
  preset.ctx.tools.register(probe('shared', executed, 'preset'))
  bindScopeParent(agent, key)
  agent.ctx.tools.register(probe('local', executed))
  agent.ctx.tools.register(probe('shared', executed, 'local'))
  for (const name of ['ancestor', 'local', 'shared']) await turn(agent, call('call_tool', { tool_name: name, arguments: {} }), done)
  assert.deepEqual(executed.map(item => item.value), ['ancestor', 'local', 'local'])
  await turn(other, call('call_tool', { tool_name: 'shared', arguments: {} }), done)
  assert.equal(executed.at(-1).value, 'global')
  if (modern) {
    ctx.tools.register(probe('conditional', executed), { when: () => false })
    await turn(agent, call('find_tools', { detail: 'name' }), done)
    assert.doesNotMatch(resultText(agent), /- conditional\b/)
    await turn(agent, call('call_tool', { tool_name: 'conditional', arguments: {} }), done)
    assert.equal(executed.length, 4)
  }
  agent.ctx.tools.restrict({ deny: ['ancestor'] })
  await turn(agent, call('call_tool', { tool_name: 'ancestor', arguments: {} }), done)
  assert.equal(executed.length, 4, 'gateway must not recover a restricted ancestor from global lookup')
  await request(agent, { enabled: false })
  await turn(agent, done)
  assert.ok(visible(adapter.requests.at(-1)).includes('local'))
  const service = ctx.systemPrompt[Symbol.for('cordis.original')] ?? ctx.systemPrompt
  await ctx.loader.resolve('gateway').fiber.dispose()
  assert.equal(Object.hasOwn(service, 'assemble'), false, 'restore original service descriptor on unload')
  await turn(agent, call('local'), done)
  assert.equal(executed.length, 5)
  assert.ok(!visible(adapter.requests.at(-1)).includes('call_tool'))
})

for (const executionMode of ['persistent-in-memory', 'vm-script']) {
  test(`new PTC ${executionMode}: program syntax, retained state and agent isolation`, { timeout: 60000 }, async t => {
    const { ctx, adapter, agent, other, turn } = await boot(t, { runtime: { executionMode, scriptPersistence: executionMode === 'vm-script' } })
    const executed = []
    ctx.tools.register(probe('probe', executed))
    const program = code => call('call_tools', { description: 'Run SDK syntax and retention checks', code })
    await turn(agent, program('var gatewayCounter = 1; await tools.call_tool({tool_name:"probe",arguments:{}}); gatewayCounter'), done)
    assert.equal(results(agent).at(-1).isError, false, resultText(agent))
    assert.match(resultText(agent), /1/)
    const schema = adapter.requests[0].tools.find(tool => tool.name === 'call_tools')
    assert.doesNotMatch(schema.parameters.properties.code.description, /异步函数体/)
    await turn(agent, program('gatewayCounter += 1; gatewayCounter'), done)
    assert.match(resultText(agent), /2/)
    await turn(other, program('typeof gatewayCounter'), done)
    assert.match(resultText(other), /undefined/)
    await ctx.loader.resolve('gateway').fiber.dispose()
    const runtime = ctx.ptcRuntime
    const fresh = await runtime.run(runtime.resolve({ program: 'typeof gatewayCounter', stateOwner: agent, bindings: [],
      sandboxPolicy: ctx.sandboxPolicy.resolve({ session: agent.session }) }))
    assert.equal(fresh.value, 'undefined', 'gateway unload must release retained state')
    await runtime.release(agent)
  })
}

test('nested contexts, concludeTurn, live disable and cancellation settle through the real pipeline', { timeout: 60000 }, async t => {
  const { ctx, adapter, agent, request, turn } = await boot(t, { runtime: true, gatewayConfig: { ban: { deny: ['hard_ban'] } } })
  const executed = []
  agent.ctx.tools.register(probe('hard_ban', executed))
  await request(agent, { enabled: false })
  await turn(agent, call('hard_ban'), done)
  assert.equal(executed.length, 0)
  assert.ok(!visible(adapter.requests[0]).includes('hard_ban'))
  await request(agent, { enabled: true })
  const effect = probe('effect', executed)
  effect.execute = async (_args, exec) => {
    exec.deferContext(createUserMessage({ content: [{ type: 'text', text: 'DEFERRED_CONTEXT_SENTINEL' }], source: { kind: 'gateway-fixture' } }))
    return 'effect done'
  }
  ctx.tools.register(effect)
  await turn(agent, call('call_tools', { description: 'Forward nested context', code: 'return await tools.call_tool({tool_name:"effect",arguments:{}})' }), done)
  assert.equal(results(agent).at(-1).isError, false, resultText(agent))
  assert.match(JSON.stringify(adapter.requests.at(-1).messages), /DEFERRED_CONTEXT_SENTINEL/)
  const terminal = probe('terminal', executed)
  terminal.execute = async (_args, exec) => { exec.concludeTurn(); return 'turn completed' }
  ctx.tools.register(terminal)
  await turn(agent, call('call_tool', { tool_name: 'terminal', arguments: {} }))
  assert.equal(results(agent).at(-1).isError, false, resultText(agent))
  ctx.tools.register(probe('late', executed))
  await turn(agent, async () => {
    await request(agent, { tool: 'late', disabled: true })
    return call('call_tool', { tool_name: 'late', arguments: {} })
  }, done)
  assert.equal(executed.length, 0, 'disable after request assembly still denies dispatch')
  assert.equal(results(agent).at(-1).isError, true)
  const entered = Promise.withResolvers()
  const drained = Promise.withResolvers()
  const slow = probe('slow', executed)
  slow.execute = async (_args, exec) => {
    entered.resolve()
    await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
    drained.resolve()
    return 'drained'
  }
  ctx.tools.register(slow)
  const running = turn(agent, call('call_tools', { description: 'Cancel actual SDK dispatch', code: 'return await tools.call_tool({tool_name:"slow",arguments:{}})' }))
  await entered.promise
  agent.cancel({ kind: 'user' })
  await running
  await drained.promise
  assert.equal(results(agent).at(-1).isError, true)
  assert.equal(agent.status, 'idle')
})

test('official PTC executor keeps run_code and exposes only enabled gateway SDK functions', { timeout: 60000 }, async t => {
  const { ctx, adapter, agent, request, turn } = await boot(t, { runtime: true, ptc: true })
  const executed = []
  ctx.tools.register(probe('probe', executed))
  const run = code => call('run_code', { description: 'Exercise official PTC SDK', code })
  await turn(agent, run('return await tools.call_tool({tool_name:"probe",arguments:{}})'), done)
  assert.equal(results(agent).at(-1).isError, false, resultText(agent))
  assert.equal(executed.length, 1)
  assert.deepEqual(visible(adapter.requests[0]), ['run_code'])
  let assembly = await ctx.systemPrompt.assemble({ scope: agent, agent })
  let sdk = assembly.sections.find(section => section.name === 'tools:sdk').text
  assert.match(sdk, /call_tool/)
  assert.doesNotMatch(sdk, /\bprobe\s*\(/)
  assert.doesNotMatch(sdk, /\bcall_tools\s*\(/)
  await request(agent, { enabled: false })
  await turn(agent, run('return await tools.probe({})'), done)
  assert.equal(executed.length, 2)
  await request(agent, { tool: 'probe', disabled: true })
  await turn(agent, run('return await tools.call_tool({tool_name:"probe",arguments:{}})'), done)
  assert.equal(results(agent).at(-1).isError, true)
  assert.equal(executed.length, 2)
  assembly = await ctx.systemPrompt.assemble({ scope: agent, agent })
  sdk = assembly.sections.find(section => section.name === 'tools:sdk').text
  assert.doesNotMatch(sdk, /\bprobe\s*\(/)
})

test('real SDK: current directory, bindings, validation, errors, timeout and nested log identity', { timeout: 60000 }, async t => {
  const { ctx, adapter, agent, turn } = await boot(t, { runtime: true })
  const schema = ctx.tools.schemas(agent).find(tool => tool.name === 'call_tools')
  assert.deepEqual(schema.parameters.required, ['code', 'description'])
  assert.ok(schema.parameters.properties.timeoutMs)
  assert.ok(schema.parameters.properties.sandbox_permissions)
  const program = (code, extra = {}) => call('call_tools', { description: 'Verify actual PTC SDK', code, ...extra })
  await turn(agent, program('console.log("SDK_LOG"); return Object.keys(tools).sort()'), done)
  assert.match(resultText(agent), /SDK_LOG/)
  assert.match(resultText(agent), /find_tools/)
  assert.match(resultText(agent), /call_tool/)
  const directory = await mkdtemp(resolve(tmpdir(), 'gateway-cwd-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await ctx.workingDirectory.set(agent, directory)
  await turn(agent, program('return process.cwd()'), done)
  assert.ok(resultText(agent).includes(directory))
  for (const args of [
    { description: ' ', code: 'return 1' },
    { description: 'Invalid timeout', code: 'return 1', timeoutMs: -1 },
    { description: 'Unpaired escalation', code: 'return 1', sandbox_permissions: 'danger-full-access' },
    { description: 'Throw program', code: 'throw new Error("SDK_PROGRAM_ERROR")' },
  ]) {
    await turn(agent, call('call_tools', args), done)
    assert.equal(results(agent).at(-1).isError, true, resultText(agent))
  }
  await turn(agent, program('while(true){}', { timeoutMs: 1000 }), done)
  assert.equal(results(agent).at(-1).isError, true)
  assert.match(resultText(agent), /timeout/)
  const executed = []
  const failure = probe('failure', executed)
  failure.execute = async () => { throw new Error('SDK_CHILD_ERROR') }
  ctx.tools.register(failure)
  ctx.tools.register(probe('probe', executed))
  await turn(agent, program('try { await tools.call_tool({tool_name:"failure",arguments:{}}) } catch(e) { return { typed: e instanceof ToolCallError, name: e.name, message: e.message } }'), done)
  assert.equal(results(agent).at(-1).isError, false)
  assert.match(resultText(agent), /"typed": true/)
  assert.match(resultText(agent), /SDK_CHILD_ERROR/)
  for (const tool_name of ['missing_tool', 'call_tool', 'call_tools', '']) {
    await turn(agent, call('call_tool', { tool_name, arguments: {} }), done)
    assert.equal(results(agent).at(-1).isError, true)
  }
  await turn(agent, program('return await Promise.all([tools.call_tool({tool_name:"probe",arguments:{}}),tools.call_tool({tool_name:"probe",arguments:{}})])'), done)
  assert.equal(executed.length, 2)
  const logs = agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'probe')
  assert.equal(logs.length, 2)
  assert.notEqual(logs[0].data.subCallId, logs[1].data.subCallId)
  assert.equal(logs[0].data.rootCallId, logs[1].data.rootCallId)
  assert.equal(logs[0].data.isError, false)
  const dispatches = agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')
  for (const child of logs) {
    const parent = dispatches.find(event => event.data.subCallId === child.data.parentCallId)
    assert.ok(parent, 'nested dispatch must retain its parent node')
    assert.equal(parent.data.name, 'call_tool')
    assert.deepEqual(parent.data.content, [{ type: 'text', text: '工具转发成功；完整结果见子调用。' }])
  }
  await turn(agent, program('try { await tools.call_tool({tool_name:"missing_tool",arguments:{}}) } catch(e) { return e.message }'), done)
  const rejected = agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'call_tool').at(-1)
  assert.equal(rejected.data.isError, true, 'outer failure must remain observable')
  assert.ok(rejected.data.content.some(block => block.type === 'text' && block.text.length > 0))
  await turn(agent, call('find_tools', { names: ['probe'], detail: 'full' }), done)
  assert.match(resultText(agent), /parameters|schema/)
  assert.match(resultText(agent), /probe/)
  assert.ok(adapter.requests.length > 0)
})

test('gateway plugin unload aborts and drains an active call_tools process', { timeout: 30000 }, async t => {
  const { ctx, agent, turn } = await boot(t, { runtime: true })
  const entered = Promise.withResolvers()
  const drained = Promise.withResolvers()
  const slow = probe('slow', [])
  slow.execute = async (_args, exec) => {
    entered.resolve()
    await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
    drained.resolve()
    return 'drained'
  }
  ctx.tools.register(slow)
  const running = turn(agent, call('call_tools', { description: 'Unload active SDK', code: 'return await tools.call_tool({tool_name:"slow",arguments:{}})' }), done)
  await entered.promise
  await ctx.loader.resolve('gateway').fiber.dispose()
  await running
  await drained.promise
  assert.equal(results(agent).at(-1).isError, true)
  assert.equal(agent.status, 'idle')
})

test('child inheritance and real approval/pre/post policy apply to both nested paths', { timeout: 30000 }, async t => {
  const { ctx, agent, other, request, turn } = await boot(t, { runtime: true })
  const handle = await ctx.agents.create({ sessionId: SessionId('gateway-child'),
    meta: { origin: 'subagent', parentSession: agent.session.id, delegationDepth: 1 },
    agentOptions: { provider: 'scripted', model: 'fixture' } })
  const child = handle.agent
  const executed = []
  ctx.tools.register(probe('probe', executed))
  await request(agent, { tool: 'probe', disabled: true })
  await turn(child, call('call_tool', { tool_name: 'probe', arguments: {} }), done)
  assert.equal(executed.length, 0)
  await turn(other, call('call_tool', { tool_name: 'probe', arguments: {} }), done)
  assert.equal(executed.length, 1)
  await request(child, { tool: 'probe', disabled: false })
  assert.equal((await request(agent)).tools.find(tool => tool.name === 'probe').enabled, true)
  await ctx.loader.root.create({ id: 'approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: 'ask' } })
  await ctx.loader.await()
  const traces = []
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (exec.name !== 'probe') return decision
    assert.ok(exec.parent)
    assert.equal(exec.schema.name, 'probe')
    traces.push('pre')
    return { kind: 'ask', reason: 'Fixture approval' }
  })
  ctx.on('tools/post-execute', async (exec, result, next) => { if (exec.name === 'probe') traces.push('post'); return next() })
  let answer = 'rejected'
  ctx.on('approval/request', async (_req, next) => { await next(); return answer })
  await turn(child, call('call_tool', { tool_name: 'probe', arguments: {} }), done)
  assert.equal(results(child).at(-1).isError, true)
  assert.equal(executed.length, 1)
  answer = 'allowed-once'
  await turn(child, call('call_tools', { description: 'Approve nested call', code: 'return await tools.call_tool({tool_name:"probe",arguments:{}})' }), done)
  assert.equal(results(child).at(-1).isError, false, resultText(child))
  assert.equal(executed.length, 2)
  assert.deepEqual(traces, ['pre', 'post', 'pre', 'post'])
  assert.equal(child.session.snapshotEvents().filter(event => event.type === 'approval/decided').length, 2)
  await handle.dispose()
  assert.equal(ctx.agents.get(child.session.id), undefined)
})





