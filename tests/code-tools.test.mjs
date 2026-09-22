/**
 * 第三个元工具（call_tools）的行为测试。
 *
 * 重点盯四件事：
 *
 * 1. **参数与呈现对齐官方 `run_code`** —— `description` 必填、控制参数只在运行时
 *    真的支持时才出现、pending 卡片是一张带标题的通用卡。
 * 2. **绑定只有两个函数** —— 这是这个工具存在的理由。绑多了就等于把工具目录
 *    又喂回给模型了。
 * 3. **子调用走注册表的公开执行入口** —— parent 标记、审批、守卫一步不少。
 * 4. **失败是异常，且带 kind** —— 模型要能从错误里看出是超时还是程序抛了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { CALL_TOOLS, createCodeTools } from '../src/code-tools.js'

const TOOLS = [
  {
    name: 'zhihu_search',
    description: '知乎站内搜索',
    parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
  },
]

/**
 * 造一个 PTC 运行时桩。
 *
 * `resolve` 照真身的行为补上 `cwd` 与 `timeoutMs`（它是“解析默认值”的那一步），
 * `run` 换成测试给的回调 —— 程序本身就是通过它“执行”的。
 *
 * @param {object} [options] 覆盖项
 * @param {object} [options.timeout] `runtime.timeout`
 * @param {string} [options.sandboxMode] `runtime.sandboxMode`
 * @param {Function} [options.run] 替代 run
 * @returns {object} 运行时桩
 */
function stubRuntime({ timeout, sandboxMode, run } = {}) {
  return {
    language: 'typescript',
    isolation: 'process',
    executionInstructions: '',
    sandboxMode,
    timeout,
    resolve: (request) => ({ ...request, cwd: request.cwd ?? 'D:\\work', timeoutMs: request.timeoutMs ?? null }),
    run: run ?? (async () => ({ logs: [], value: 'ok' })),
  }
}

/**
 * 造一套够用的依赖。
 *
 * @param {object} [options] 覆盖项
 * @param {object|null} [options.runtime] PTC 运行时。传 null 表示这个部署压根没挂它
 *   （不能用 undefined —— 那会撞上默认值，缺服务那条路就测不到了）
 * @param {object} [options.outcome] 注册表执行入口的返回值
 * @param {object} [options.approvalOutcome] 审批服务的返回
 * @returns {object} 工具定义与观察点
 */
function setup({ runtime = stubRuntime(), outcome, approvalOutcome = 'allowed-once' } = {}) {
  const ptcRuntime = runtime === null ? undefined : runtime
  const executed = []
  const deferred = []
  const asked = []
  const ctx = {
    get(service) {
      if (service === 'ptcRuntime') return ptcRuntime
      if (service === 'sandboxPolicy') {
        return { resolve: () => ({ mode: 'workspace-write', enforcement: 'full' }) }
      }
      if (service === 'approval') {
        return {
          async request(request) {
            asked.push(request)
            return approvalOutcome
          },
        }
      }
      return undefined
    },
    tools: {
      schemas: () => TOOLS,
      get: (name) => TOOLS.find((tool) => tool.name === name),
      execute: async (input) => {
        executed.push(input)
        return outcome ?? { isError: false, content: [{ type: 'text', text: '结果文本' }] }
      },
    },
  }

  const [definition] = createCodeTools({ ctx })
  const exec = {
    callId: 'call-1',
    rootCallId: 'call-1',
    token: { token: 'tok' },
    agent: { session: { header: { cwd: 'D:\\work' } } },
    signal: new AbortController().signal,
    deferContext: (message) => { deferred.push(message) },
  }
  return { definition, exec, executed, deferred, asked, ptcRuntime }
}

/** 跑一次程序，把 `run` 拿到的 spec 交给回调。 */
function runtimeThatRuns(program) {
  return stubRuntime({
    run: async (spec) => ({ logs: [], value: await program(spec) }),
  })
}

test('名字是 call_tools，不是被注册表保留的 run_code', () => {
  const { definition } = setup()
  assert.equal(definition.name, CALL_TOOLS)
  assert.equal(definition.name, 'call_tools')
})

test('参数：code 与 description 都必填，后者是审批界面上的那行字', () => {
  const { definition } = setup()
  const parameters = definition.parameters
  assert.deepEqual(parameters.required, ['code', 'description'])
  assert.equal(parameters.properties.code.type, 'string')
  assert.equal(parameters.properties.description.type, 'string')
  // 说明里要讲清楚它是给界面/审批看的，不只是一句客套话。
  assert.match(parameters.properties.description.description, /标题/)
})

test('参数：运行时不支持的能力就不摆出来', () => {
  const bare = setup({ runtime: stubRuntime() }).definition.parameters
  assert.equal(bare.properties.timeoutMs, undefined)
  assert.equal(bare.properties.sandbox_permissions, undefined)
  assert.equal(bare.properties.justification, undefined)

  const full = setup({
    runtime: stubRuntime({ timeout: { defaultMs: 30000, maxMs: 600000 }, sandboxMode: 'workspace-write' }),
  }).definition.parameters
  assert.equal(full.properties.timeoutMs.type, 'number')
  // 描述里要带上部署的真实数字，模型才能选一个合理的值。
  assert.match(full.properties.timeoutMs.description, /30000/)
  assert.deepEqual(full.properties.sandbox_permissions.enum, ['workspace-write', 'danger-full-access'])
  assert.equal(full.properties.justification.type, 'string')
})

test('参数是懒的：注册时没有运行时，后来挂上了也能投影出控制参数', () => {
  let runtime
  const ctx = {
    get: (service) => (service === 'ptcRuntime' ? runtime : undefined),
    tools: { schemas: () => [], get: () => undefined, execute: async () => ({}) },
  }
  const [definition] = createCodeTools({ ctx })
  // 注册那一刻还没有运行时 —— 此时不能抛，也不能把能力写死。
  assert.equal(definition.parameters.properties.timeoutMs, undefined)
  runtime = stubRuntime({ timeout: { defaultMs: 1000, maxMs: 2000 } })
  assert.equal(definition.parameters.properties.timeoutMs.type, 'number')
})

test('输出是结构化的：logs 必有，result 与 sandbox 可选', () => {
  const { definition } = setup()
  const schema = definition.output.schema
  assert.deepEqual(schema.required, ['logs'])
  assert.equal(schema.properties.logs.type, 'array')
  // 任意 JSON 值的标准写法是空 schema（DSH DSL 里写作 { type: 'json' }）。
  assert.deepEqual(schema.properties.result, {})
  assert.equal(schema.properties.sandbox.properties.mode.enum.length, 3)
  assert.deepEqual(schema.properties.sandbox.required, ['mode', 'denied'])
  assert.equal(typeof definition.output.render, 'function')
})

test('呈现：pending 卡片拿 description 当标题，展开看程序本体', () => {
  const { definition } = setup()
  const view = definition.presentCall({ description: '统计 TODO', code: 'return 1' })
  assert.deepEqual(view, { card: 'generic', title: '统计 TODO', kind: 'execute', rawInput: 'return 1' })
  // UI 可能在参数校验之前就画 pending 卡片，那时 title 不能是 undefined。
  assert.equal(definition.presentCall({}).title, CALL_TOOLS)
  assert.equal(definition.presentCall({ description: '   ' }).title, CALL_TOOLS)
})

test('description 是空的就抛错 —— 不然审批的人不知道在批什么', async () => {
  const { definition, exec } = setup()
  await assert.rejects(
    () => definition.execute({ description: '  ', code: 'return 1' }, exec),
    /description 不能为空/,
  )
})

test('没有 PTC 运行时就说清楚，不假装程序跑了', async () => {
  const { definition, exec } = setup({ runtime: null })
  await assert.rejects(
    () => definition.execute({ description: 'x', code: 'return 1' }, exec),
    /ptcRuntime/,
  )
})

test('正常跑完：logs 与 return 的值都交出去', async () => {
  const { definition, exec } = setup({
    runtime: stubRuntime({ run: async () => ({ logs: ['一行日志'], value: { n: 2 } }) }),
  })
  const value = await definition.execute({ description: 'x', code: 'return { n: 2 }' }, exec)
  assert.deepEqual(value, { logs: ['一行日志'], result: { n: 2 } })
  // 没有沙箱事实时不编一个出来。
  assert.equal(value.sandbox, undefined)
})

test('渲染：logs、result、沙箱事实依次拼起来', () => {
  const { definition } = setup()
  const render = (value) => definition.output.render({}, value)[0].text
  assert.equal(render({ logs: [], result: '直接是字符串' }), '直接是字符串')
  assert.match(render({ logs: ['a'], result: { b: 1 } }), /a\n\{[\s\S]*"b": 1/)
  assert.match(render({ logs: [], sandbox: { mode: 'workspace-write', denied: true } }), /拒绝了一次操作/)
  // 什么都没有时也得给一句交代。
  assert.match(render({ logs: [] }), /没有输出/)
})

test('程序失败：抛 CodeRunFailedError，文本带 kind 与捕获到的输出', async () => {
  const { definition, exec } = setup({
    runtime: stubRuntime({
      run: async () => ({ logs: ['前面打印的'], error: { kind: 'timeout', message: '超过预算' } }),
    }),
  })
  await assert.rejects(
    () => definition.execute({ description: 'x', code: 'while(true){}' }, exec),
    (error) => {
      assert.equal(error.name, 'CodeRunFailedError')
      assert.equal(error.code, 'CODE_RUN_FAILED')
      assert.match(error.message, /timeout/)
      assert.match(error.message, /前面打印的/)
      return true
    },
  )
})

test('绑定：程序里只有 find_tools 与 call_tool 两个函数', async () => {
  let seen
  const { definition, exec } = setup({
    runtime: stubRuntime({ run: async (spec) => { seen = spec.bindings[0]; return { logs: [], value: null } } }),
  })
  await definition.execute({ description: 'x', code: 'return null' }, exec)

  assert.equal(seen.global, 'tools')
  assert.deepEqual(Object.keys(seen.functions).sort(), ['call_tool', 'find_tools'])
  // 绑定名与错误类名都是运行时契约的一部分，写错会在 run 时被拒。
  assert.deepEqual(seen.errorClass, { name: 'ToolCallError', memberNameProperty: 'toolName' })
})

test('绑定：子调用走注册表的执行入口，并带上 parent 标记', async () => {
  const { definition, exec, executed } = setup({
    runtime: runtimeThatRuns(async (spec) => {
      const a = await spec.bindings[0].functions.call_tool({ tool_name: 'zhihu_search', arguments: { keyword: 'x' } })
      return a.text
    }),
  })
  const value = await definition.execute({ description: 'x', code: '...' }, exec)

  assert.equal(value.result, '结果文本')
  assert.equal(executed.length, 1)
  // 程序里的 tools.call_tool 就是去调 call_tool 这个工具本身；它会再走一次执行入口
  // 去够真正要调的那个（那段在 meta-tools.test.mjs 里测）。绑定这一层只负责
  // “把调用交给注册表，并标成子分发”。
  assert.equal(executed[0].name, 'call_tool')
  assert.deepEqual(executed[0].arguments, { tool_name: 'zhihu_search', arguments: { keyword: 'x' } })
  // parent 必须带上：网关的守卫靠它区分“子分发”与“模型直接调用”。
  assert.equal(executed[0].parent, exec.token)
  assert.equal(executed[0].rootCallId, exec.rootCallId)
  // 子调用 id 带序号 —— 一次程序里可能调很多次，日志里要能分开。
  assert.equal(executed[0].callId, 'call-1:code:1')
})

test('绑定：find_tools 也走同一条路，不是另开一扇门', async () => {
  const { definition, exec, executed } = setup({
    runtime: runtimeThatRuns(async (spec) => {
      const found = await spec.bindings[0].functions.find_tools({ query: '搜索' })
      return found.text
    }),
  })
  const value = await definition.execute({ description: 'x', code: '...' }, exec)

  assert.equal(value.result, '结果文本')
  assert.equal(executed[0].name, 'find_tools')
  assert.deepEqual(executed[0].arguments, { query: '搜索' })
  assert.equal(executed[0].parent, exec.token)
})

test('绑定：同一个程序里的多次子调用，id 各不相同', async () => {
  const { definition, exec, executed } = setup({
    runtime: runtimeThatRuns(async (spec) => {
      const fn = spec.bindings[0].functions.call_tool
      await fn({ tool_name: 'zhihu_search', arguments: {} })
      await fn({ tool_name: 'zhihu_search', arguments: {} })
      return null
    }),
  })
  await definition.execute({ description: 'x', code: '...' }, exec)
  assert.deepEqual(executed.map((input) => input.callId), ['call-1:code:1', 'call-1:code:2'])
})

test('绑定：子调用失败时程序里拿到的是异常，可以 try/catch', async () => {
  const { definition, exec } = setup({
    outcome: { isError: true, error: { message: '权限不足' }, content: [] },
    runtime: runtimeThatRuns(async (spec) => {
      try {
        await spec.bindings[0].functions.call_tool({ tool_name: 'zhihu_search', arguments: {} })
        return '没抛'
      } catch (error) {
        return `接住了：${error.message}`
      }
    }),
  })
  const value = await definition.execute({ description: 'x', code: '...' }, exec)
  assert.match(value.result, /接住了/)
  assert.match(value.result, /权限不足/)
})

test('绑定：非文本块经 deferContext 作为独立上下文送出', async () => {
  const { definition, exec, deferred } = setup({
    outcome: {
      isError: false,
      content: [{ type: 'text', text: '截图' }, { type: 'image', data: 'base64…' }],
    },
    runtime: runtimeThatRuns(async (spec) => {
      const a = await spec.bindings[0].functions.call_tool({ tool_name: 'zhihu_search', arguments: {} })
      return a.text
    }),
  })
  await definition.execute({ description: 'x', code: '...' }, exec)

  assert.equal(deferred.length, 1)
  assert.equal(deferred[0].role, 'user')
  assert.equal(deferred[0].content[0].type, 'image')
})

test('cwd 与 timeoutMs 原样交给运行时；不传时就不编一个', async () => {
  let spec
  const { definition, exec } = setup({
    runtime: stubRuntime({ timeout: { defaultMs: 1000, maxMs: 2000 }, run: async (s) => { spec = s; return { logs: [], value: null } } }),
  })
  await definition.execute({ description: 'x', code: '...' }, exec)
  assert.equal(spec.cwd, 'D:\\work')
  // 没传 timeoutMs：resolve 自己填的 null 不算“模型要的预算”。
  assert.equal(spec.timeoutMs, null)

  await definition.execute({ description: 'x', code: '...', timeoutMs: 5000 }, exec)
  assert.equal(spec.timeoutMs, 5000)
})

test('timeoutMs：运行时不支持就抛错，不是静默丢掉', async () => {
  const { definition, exec } = setup()
  await assert.rejects(
    () => definition.execute({ description: 'x', code: '...', timeoutMs: 1000 }, exec),
    /不支持 timeoutMs/,
  )
})

test('timeoutMs：必须是有限正数', async () => {
  const { definition, exec } = setup({ runtime: stubRuntime({ timeout: { defaultMs: 1000, maxMs: 2000 } }) })
  await assert.rejects(
    () => definition.execute({ description: 'x', code: '...', timeoutMs: -1 }, exec),
    /有限正数/,
  )
})

test('提权参数必须成对出现', async () => {
  const { definition, exec } = setup({ runtime: stubRuntime({ sandboxMode: 'workspace-write' }) })
  await assert.rejects(
    () => definition.execute({ description: 'x', code: '...', sandbox_permissions: 'danger-full-access' }, exec),
    /不成对/,
  )
  await assert.rejects(
    () => definition.execute({ description: 'x', code: '...', justification: '因为' }, exec),
    /不成对/,
  )
})

test('提权：审批通过之后才拿更宽的策略去跑', async () => {
  let spec
  const { definition, exec, asked } = setup({
    runtime: stubRuntime({
      sandboxMode: 'workspace-write',
      run: async (s) => { spec = s; return { logs: [], value: null } },
    }),
  })
  await definition.execute({
    description: 'x',
    code: '...',
    sandbox_permissions: 'danger-full-access',
    justification: '要写工作区外的文件',
  }, exec)

  assert.equal(asked.length, 1)
  assert.match(asked[0].reason, /danger-full-access/)
  assert.match(asked[0].reason, /要写工作区外的文件/)
  assert.equal(asked[0].toolName, CALL_TOOLS)
  assert.equal(spec.sandboxPolicy.mode, 'danger-full-access')
})

test('提权：用户拒绝就不跑', async () => {
  const { definition, exec } = setup({
    runtime: stubRuntime({ sandboxMode: 'workspace-write' }),
    approvalOutcome: 'rejected',
  })
  await assert.rejects(
    () => definition.execute({
      description: 'x', code: '...', sandbox_permissions: 'danger-full-access', justification: '因为',
    }, exec),
    /用户拒绝/,
  )
})

test('提权：不能“提”到并不更宽的模式', async () => {
  const { definition, exec } = setup({ runtime: stubRuntime({ sandboxMode: 'workspace-write' }) })
  await assert.rejects(
    () => definition.execute({
      description: 'x', code: '...', sandbox_permissions: 'read-only', justification: '因为',
    }, exec),
    /并不比当前的/,
  )
})

test('code 是空的就给用法提示，不抛错', async () => {
  const { definition, exec } = setup()
  const value = await definition.execute({ description: 'x', code: '   ' }, exec)
  assert.match(value.logs.join('\n'), /请提供 code/)
})
