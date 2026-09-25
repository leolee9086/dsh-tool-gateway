/**
 * 第三个元工具：call_tools —— 写一段程序，批量调用工具。
 *
 * **它和 call_tool 的分工。** call_tool 一次调一个，结果整份回到对话里；
 * call_tools 把「调什么、怎么处理中间结果」交给一段程序，只有程序 `return` 的
 * 那个值回到对话里。读十个文件、跑十次搜索这类活，中间那些内容不必挤进上下文。
 *
 * **参数、输出与呈现都对齐 DSH 官方 PTC 模式的 `run_code`。** 只少一样：官方的
 * SDK 段落是**遍历注册表生成**的（把每个工具的签名写出来喂给模型），我们这里是
 * 手写的两条声明 —— 因为绑定就这两个。差别很实在：官方那段会把一百多个工具的名字
 * 和参数全喂给模型，我们这段只占十几行。
 *
 * **但它不能叫 `run_code`。** 那是 PTC mode 的呈现通道，注册表对它直接抛错
 * （"reserved for the PTC mode presentation transport and cannot be registered
 * or shadowed"）—— 自己造一个同名的工具，插件加载就会失败。
 *
 * **什么时候不挂它。** PTC 已经开着的时候（判断在 host.js 的 keepFor 里）：
 * 那时 DSH 自己的 `run_code` 就在工具表里，再加一个功能重叠的只会让模型困惑
 * 该用哪个；而在 `mode: 'ptc'` 下它本来也调不到 —— 那个模式的执行守卫只放行
 * `run_code`。
 *
 * **不抄官方消费方的调度。** 官方自己管有序车道、parallel/exclusive、commit 顺序、
 * 会话日志 append，是因为它要控制子调用的并发与顺序。我们的子调用走
 * `ctx.tools.execute()`（见 meta-tools.js 的 invokeTool），公开执行入口把审批、
 * 守卫、沙箱、日志全包了 —— 绑定只是薄薄一层包装。
 */
import { deliverContext } from './deliver-context.js'
import { CALL_TOOL, FIND_TOOLS, invokeTool } from './meta-tools.js'

/** 第三个元工具的名字。host.js 用它拼白名单，也用它判断要不要挂。 */
export const CALL_TOOLS = 'call_tools'

/** 程序里看到的绑定全局名。不在运行时的 `RESERVED_BINDING_GLOBALS` 里。 */
const BINDING_GLOBAL = 'tools'

/**
 * 沙箱模式词汇，与 `@deepseek-ai/dsh-sandbox` 的 `SandboxMode` 一致。
 * 插件不能 import DSH 包，所以这里重述一遭；它同时写进了 output schema 的 enum，
 * 写错的话注册时就会抛（`assertSupportedJsonSchema` 不校验 enum 的取值，
 * 但校验返回值时会对不上）。
 */
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * 严格更宽的模式阶梯：键是当前生效模式，值是可以提权到的模式。
 * 提权只能往宽里走 —— 审批过一次“降权”毫无意义。
 */
const WIDER_MODES = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/**
 * 能作为提权目标的模式。`read-only` 是地板，没有谁提权到它。
 * 这是 schema 的 enum（注册表全局），而“当前生效模式”是每次调用的事实，
 * 所以那个更严的检查在 execute 里做。
 */
const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access']

/**
 * 给模型看的工具说明。
 *
 * 写法与官方 `run_code` 对齐：说清“程序是什么形状”“怎么调工具”“只有打印和返回
 * 的才算输出”。最后一句不能省 —— 不写的话模型会把整段中间结果拼进 `return`，
 * 那这个工具就白做了。
 */
const DESCRIPTION = [
  '写一段程序批量调用工具。',
  '',
  '程序是 TypeScript 的**异步函数体**（可擦除语法）：可以用顶层 `await`，用 `return` 给出结果。',
  '程序里只有两个函数可调：',
  '',
  '```ts',
  'await tools.find_tools({ query: string }): Promise<{ text: string }>',
  'await tools.call_tool({ tool_name: string, arguments: object }): Promise<{ text: string }>',
  '```',
  '',
  '**只有你打印或返回的东西才是输出，请自己把结果收拾好** —— 这就是它存在的理由。',
  '读十个文件、跑十次搜索，中间那些内容不必挤进对话。',
  '',
  '例：',
  '',
  '```ts',
  "const a = await tools.call_tool({ tool_name: 'read', arguments: { file_path: 'a.md' } })",
  "const b = await tools.call_tool({ tool_name: 'read', arguments: { file_path: 'b.md' } })",
  "return [a.text, b.text].join('\\n---\\n')",
  '```',
  '',
  '子调用失败会抛出 `ToolCallError`（它的 `toolName` 是被调的工具名），用 try/catch 接住。',
  '`console.log` 的输出会随结果一起返回；子调用带回来的图片等非文本块会附在这次结果之后。',
].join('\n')

/** `code` 参数的说明。 */
const CODE_DESCRIPTION = '要执行的程序：一个异步函数体（TypeScript）。'

/**
 * `description` 参数的说明，口径照官方：它是这次调用在界面上永远可见的那行标签，
 * 也是审批弹窗里给人看的第一行字。空着的话，自动审批或人工审批都不知道在批什么。
 */
const SUMMARY_DESCRIPTION = '用一句话说清这段程序做什么：5-10 个词，主动语态。'
  + '它会成为这次调用在界面上的标题，审批时也是给人看的第一行字。'
  + '例：“统计各包里的 TODO”；“读取失败的测试和它的 fixture”；“批量重命名配置键”。'

/**
 * 提权指引，接在工具说明后面。只在运行时真的做文件沙箱时才出现。
 * 与官方同一条口径：一次提权只批一次执行，子调用各有各的策略。
 *
 * **「挂在这一层」那句是踩出来的**（2026-09-25）：提权参数写在**程序里的子调用**上
 * 是无效的 —— 它只对「这一次程序执行」生效，而被审批、被放行的是父级那一次。
 * 写错的现象很干脆：命令照旧被沙箱拒绝，而**审批弹窗根本不会出现**，
 * 看上去像是"提权不管用"。
 */
const ESCALATION_GUIDANCE = '沙箱提权只对这一次程序执行有效，子调用各自保留自己的策略与审批。'
  + '要提权就把 sandbox_permissions 与 justification 挂在**这一次 call_tools 调用身上**；'
  + '写进程序里的子调用（tools.call_tool(...)）是无效的，审批弹窗不会出现。'
  + '只在真的被拒绝之后才申请更宽的模式 —— 之前的副作用可能已经发生，重试前先看清楚。程序不会被自动重放。'

/**
 * 把一次成功的运行渲染成给模型看的文本。
 *
 * 三样东西按顺序拼：程序打印的（logs）、程序 return 的（result）、沙箱事实。
 * 一样都没有时也得给一句交代 —— 空白的结果会让模型以为工具坏了。
 *
 * @param {object} value execute 返回的那个对象
 * @returns {string} 给模型看的文本
 */
function renderOutcome(value) {
  const parts = []
  if (value.logs.length > 0) parts.push(value.logs.join('\n'))
  if (value.result !== undefined) {
    parts.push(typeof value.result === 'string' ? value.result : JSON.stringify(value.result, null, 2))
  }
  if (value.sandbox?.enforcement === 'partial') parts.push('（这个宿主上的文件沙箱强制是部分的。）')
  if (value.sandbox?.denied === true) parts.push(`（${value.sandbox.mode} 沙箱拒绝了一次操作。）`)
  return parts.length > 0 ? parts.join('\n') : '（程序跑完了，没有输出。）'
}

/**
 * 把一次失败的运行渲染成给模型看的文本。
 *
 * `kind` 要留着：超时、程序抛异常、被取消、执行基底死了是不同的事，模型得知道
 * 是哪一种才能决定重试还是换个写法。捕获到的 logs 也要带上 —— 程序往往是在打印了
 * 若干进展之后才炸的，那几行正是定位问题的线索。
 *
 * @param {object} result 运行时返回的结果（`result.error` 一定存在）
 * @returns {string} 给模型看的文本
 */
function failureText(result) {
  const lines = [`程序执行失败（${result.error.kind}）：${result.error.message}`]
  if (result.logs.length > 0) lines.push('', '失败前捕获到的输出：', result.logs.join('\n'))
  const sandbox = result.sandbox
  if (sandbox !== undefined) {
    lines.push('', `（文件沙箱：${sandbox.mode}${sandbox.denied === true ? '；有一次操作被拒绝' : ''}）`)
  }
  return lines.join('\n')
}

/**
 * 校验提权参数对。schema 表达不了“这两个要么都给要么都不给”这件事，所以在这里查。
 *
 * 口径照官方：只有理由没有请求、只有请求没有理由、理由是一串空白，都是不合法的提问 ——
 * 审批弹窗上不能只有一行空白让人猜。
 *
 * @param {unknown} sandboxPermissions `sandbox_permissions` 参数
 * @param {unknown} justification `justification` 参数
 * @returns {void}
 */
function validateEscalationArgs(sandboxPermissions, justification) {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error('提权参数不成对：给了 sandbox_permissions 就必须给 justification。')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error('提权参数不成对：justification 只能和 sandbox_permissions 一起给。')
  }
  if (typeof justification === 'string' && justification.trim().length === 0) {
    throw new Error('justification 不能是空的：审批的人要靠它知道为什么要更宽的权限。')
  }
}

/**
 * 解析这次执行当前生效的文件沙箱策略。
 *
 * 策略属于会话（而不是工具），所以向 `sandboxPolicy` 服务要 —— 官方 PTC mode
 * 也是这么做的（`ctx.get('sandboxPolicy').resolve({ session })`）。
 *
 * @param {object} ctx 插件上下文
 * @param {object} exec 工具执行上下文
 * @returns {object} 已解析的策略
 */
function resolveSandboxPolicy(ctx, exec) {
  const service = ctx.get('sandboxPolicy')
  if (service === undefined) {
    throw new Error('这个部署没有挂载 sandboxPolicy 服务，无法为程序解析文件沙箱策略。')
  }
  return service.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
}

/**
 * 走审批通道申请一次更宽的沙箱模式。
 *
 * 逻辑照 `@deepseek-ai/dsh-sandbox` 的 `approveEscalation`：重述生效模式不需要审批，
 * 更宽的模式要先证明“真的更宽”，再问人，拿到 `allowed-once` 才算数。
 * 任何拿不到批准的情形都**在执行之前**抛错，绝不先跑了再说。
 *
 * @param {object} request 申请内容
 * @param {string} request.requestedMode 模型要的模式
 * @param {string} request.justification 模型给的理由
 * @param {string} request.effectiveMode 当前生效的模式
 * @param {object} approval 审批要素
 * @param {object|undefined} approval.approver 审批服务（`ctx.get('approval')`）
 * @param {object|undefined} approval.agent 发起调用的 agent
 * @param {string} approval.callId 这次调用的 id
 * @param {AbortSignal} approval.signal 取消信号
 * @returns {Promise<string>} 批准下来的模式
 */
async function approveEscalation(request, approval) {
  const { requestedMode, justification, effectiveMode } = request
  if (requestedMode === effectiveMode) return effectiveMode
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(requestedMode)) {
    throw new Error(`提权到 "${requestedMode}" 并不比当前的 "${effectiveMode}" 更宽。`)
  }
  if (approval.approver === undefined) {
    throw new Error(`提权到 "${requestedMode}" 需要审批，但这个部署没有审批服务。`)
  }
  if (approval.agent === undefined) {
    throw new Error(`提权到 "${requestedMode}" 需要审批，但这次调用没有 agent 可以路由。`)
  }
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: CALL_TOOLS,
    callId: approval.callId,
    reason: `把文件沙箱提到 ${requestedMode}：${justification}`,
    signal: approval.signal,
  })
  if (outcome === 'allowed-once') return requestedMode
  if (outcome === 'rejected') throw new Error(`用户拒绝把这次程序执行提到 "${requestedMode}"。`)
  if (outcome === 'cancelled') throw new Error(`把这次程序执行提到 "${requestedMode}" 的审批被取消了。`)
  if (outcome === 'unavailable') throw new Error(`提权到 "${requestedMode}" 需要审批，但审批通道不可用。`)
  // 关闭的结果词汇：多一个值说明审批服务的契约变了，这里要响。
  throw new Error(`审批服务返回了未知的结果 "${String(outcome)}"。`)
}

/**
 * 造第三个元工具的注册定义。
 *
 * @param {object} options 依赖
 * @param {object} options.ctx 插件上下文（用来读 `ctx.ptcRuntime` 与注册表）
 * @returns {object[]} 一个工具定义
 */
export function createCodeTools({ ctx }) {
  /** 读运行时，读不到就返回 undefined。schema 投影时只能这么读 —— 不能抛。 */
  const peekRuntime = () => ctx.get('ptcRuntime')

  /**
   * 运行时能力决定的控制参数。没有的就不出现 —— 摆一个用不了的参数比不摆更糟。
   *
   * @param {object|undefined} runtime PTC 运行时
   * @returns {object} 参数属性片段
   */
  const controlProperties = (runtime) => {
    if (runtime === undefined) return {}
    return {
      ...runtime.timeout === undefined ? {} : {
        timeoutMs: {
          type: 'number',
          description: '这次执行的超时预算（毫秒），包含子调用与审批等待。'
            + `默认 ${runtime.timeout.defaultMs}，上限 ${runtime.timeout.maxMs}。`
            + '给 0 不会关掉截止。',
        },
      },
      ...runtime.sandboxMode === undefined ? {} : {
        sandbox_permissions: {
          type: 'string',
          enum: ESCALATION_TARGETS,
          description: '为这一整次程序执行申请更宽的文件权限；需要同时给 justification，并弹给用户审批。'
            + '**挂在这一次 call_tools 调用上** —— 写进程序里的子调用是无效的，审批弹窗不会出现。',
        },
        justification: {
          type: 'string',
          description: '申请更宽权限的理由，会原样显示给用户。',
        },
      },
    }
  }

  const definition = {
    name: CALL_TOOLS,
    // description / parameters 在下面装成 getter —— 这两个值取决于运行时能力，
    // 而注册发生在 apply 那一刻，那时 ptcRuntime（另一个插件提供的服务）可能还没来。
    // 注册表在**投影 schema 的那一刻**才读它们，那时读才对。
    description: DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logs: { type: 'array', items: { type: 'string' } },
          // 任意 JSON 值：DSH 的 schema DSL 里写作 { type: 'json' }，转成 JSON Schema
          // 就是空 schema（“无约束”的标准写法）。插件交的是 JSON Schema，所以写这个。
          result: {},
          sandbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', enum: SANDBOX_MODES },
              denied: { type: 'boolean' },
              enforcement: { type: 'string', enum: ['full', 'partial'] },
            },
            required: ['mode', 'denied'],
          },
        },
        required: ['logs'],
      },
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value) }],
    },
    /**
     * 待执行时的界面表现，形状照官方 `run_code`：一张通用卡片，标题就是模型写的
     * `description`，展开时看程序本体。纯函数、只看 args —— UI 在流式与回放时都会调它。
     *
     * 官方直接写 `title: args.description`，因为它先校验了非空；但 UI 可能在**校验之前**
     * 就调它（pending 卡片是流式画的），所以这里得给个能看的标题。
     *
     * @param {unknown} args 解析后的参数
     * @returns {object} 通用卡片的呈现意图
     */
    presentCall(args) {
      const summary = typeof args?.description === 'string' ? args.description.trim() : ''
      return {
        card: 'generic',
        title: summary.length > 0 ? summary : CALL_TOOLS,
        kind: 'execute',
        rawInput: args?.code,
      }
    },
    async execute(args, exec) {
      // 这一行是审批界面的全部信息量：空着的话，不管是自动审批还是人工审批，
      // 看到的都是一次“不知道在干什么”的代码执行。所以它必填。
      const summary = typeof args?.description === 'string' ? args.description.trim() : ''
      if (summary.length === 0) {
        throw new Error('description 不能为空：它是这次调用的界面标签，审批时要靠它说明这段程序做什么。')
      }

      const code = typeof args?.code === 'string' ? args.code : ''
      if (code.trim().length === 0) {
        return {
          logs: ['请提供 code —— 一段要执行的程序。例如：'],
          result: "return (await tools.call_tool({ tool_name: 'read', arguments: { file_path: 'a.md' } })).text",
        }
      }

      // 运行时是**另一个插件**提供的，可能在本插件挂载之后才来，也可能根本没来，
      // 所以每次执行现取，不在 apply 时缓存。取不到就说清楚 —— 给个兜底值只会
      // 让模型以为程序跑了。
      const runtime = peekRuntime()
      if (runtime === undefined) {
        throw new Error('这个部署没有挂载 PTC 运行时（ctx.ptcRuntime），call_tools 跑不了程序。')
      }

      validateEscalationArgs(args?.sandbox_permissions, args?.justification)

      const timeoutMs = args?.timeoutMs
      if (timeoutMs !== undefined && runtime.timeout === undefined) {
        throw new Error(`这个 PTC 运行时（${runtime.language}）不支持 timeoutMs。`)
      }
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new Error('timeoutMs 必须是有限正数。')
      }

      // 沙箱：先拿会话当前生效的策略；模型要提权就在这个策略之上问一次人。
      // 提权只改这一次执行的策略，不写回会话。
      const standing = runtime.sandboxMode === undefined ? undefined : resolveSandboxPolicy(ctx, exec)
      let policy = standing
      if (args?.sandbox_permissions !== undefined && args?.justification !== undefined) {
        if (standing === undefined) {
          throw new Error('这个 PTC 运行时不做文件沙箱，sandbox_permissions 没有意义。')
        }
        const approved = await approveEscalation({
          requestedMode: args.sandbox_permissions,
          justification: args.justification,
          effectiveMode: standing.mode,
        }, {
          approver: ctx.get('approval'),
          agent: exec.agent,
          callId: exec.callId,
          signal: exec.signal,
        })
        policy = { ...standing, mode: approved }
      }

      exec.signal.throwIfAborted()

      // 这次运行自己的取消开关。它的两个用途：
      // 1. 外层取消（用户中断、回合结束）传进来；
      // 2. 程序结束时**主动中止还在飞的子调用** —— 程序写了 `tools.call_tool(...)`
      //    却没 await，那个调用不该在结果返回之后继续跑下去。
      const runController = new AbortController()
      const onOuterAbort = () => runController.abort(exec.signal.reason)
      exec.signal.addEventListener('abort', onOuterAbort, { once: true })

      // 飞行中的子调用。程序结束时要等它们收完尾：不等的话，它们 append 的会话
      // 日志会落在这次调用之后，看上去像是下一轮发生的事。
      const flights = new Set()

      /** 一次程序里可能调很多次，序号让会话日志里的子调用 id 各不相同。 */
      let dispatches = 0
      const bind = (name) => async (rawArgs) => {
        const flight = invokeTool({
          ctx,
          name,
          args: rawArgs ?? {},
          exec,
          callIdSuffix: `code:${++dispatches}`,
          signal: runController.signal,
        })
        flights.add(flight)
        try {
          const outcome = await flight
          deliverContext(exec, outcome.context)
          // 程序里失败是**异常**：调用方可以 try/catch，也可以让它冒出来。
          // 抛普通 Error 就够 —— 运行时按绑定声明的 errorClass 把它转成
          // ToolCallError，并补上被调的工具名。
          if (outcome.isError) throw new Error(outcome.text)
          return { text: outcome.text }
        } finally {
          flights.delete(flight)
        }
      }

      // 空原型 + defineProperty，理由同官方消费方：绑定名按 own property 解析，
      // 普通对象赋值遇到 `__proto__` 这类名字会被原型 setter 静默吃掉。
      const functions = Object.create(null)
      for (const name of [FIND_TOOLS, CALL_TOOL]) {
        Object.defineProperty(functions, name, { enumerable: true, value: bind(name) })
      }

      // 工作目录给程序用（相对路径、后端设置执行世界）。会话没有 cwd 时不传，
      // 让运行时用它的默认值 —— 编一个出来只会让相对路径指向错误的地方。
      const cwd = exec?.agent?.session?.header?.cwd

      try {
        const result = await runtime.run(runtime.resolve({
          program: code,
          bindings: [{
            global: BINDING_GLOBAL,
            functions,
            errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
          }],
          signal: runController.signal,
          ...(typeof cwd === 'string' ? { cwd } : {}),
          ...(policy === undefined ? {} : { sandboxPolicy: policy }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }))
        // 程序失败是 resolve 出来的**字段**，不是 run 的 reject。呈现它是调用方的事。
        // 形状与官方一致：带 kind 的文本 + 捕获到的 logs + 沙箱事实。
        if (result.error !== undefined) {
          const error = new Error(failureText(result))
          error.name = 'CodeRunFailedError'
          error.code = 'CODE_RUN_FAILED'
          throw error
        }
        return {
          logs: result.logs,
          ...result.sandbox === undefined ? {} : { sandbox: result.sandbox },
          ...result.value === undefined ? {} : { result: result.value },
        }
      } finally {
        runController.abort('call_tools 结束')
        await Promise.allSettled([...flights])
        exec.signal.removeEventListener('abort', onOuterAbort)
      }
    },
  }

  // 运行时能力随部署变（可能压根没挂），所以这两个值每次投影现算。
  Object.defineProperty(definition, 'description', {
    enumerable: true,
    get: () => {
      const runtime = peekRuntime()
      if (runtime === undefined) return DESCRIPTION
      const instructions = runtime.executionInstructions
      return DESCRIPTION
        + (instructions.length > 0 ? `\n\n${instructions}` : '')
        + '\n\n工作目录就是会话当前的工作目录。'
        + (runtime.sandboxMode === undefined ? '' : `\n\n${ESCALATION_GUIDANCE}`)
    },
  })
  Object.defineProperty(definition, 'parameters', {
    enumerable: true,
    get: () => ({
      type: 'object',
      properties: {
        code: { type: 'string', description: CODE_DESCRIPTION },
        description: { type: 'string', description: SUMMARY_DESCRIPTION },
        ...controlProperties(peekRuntime()),
      },
      required: ['code', 'description'],
      additionalProperties: false,
    }),
  })

  return [definition]
}
