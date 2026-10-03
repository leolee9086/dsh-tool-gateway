/**
 * 两个元工具：find_tools（查）与 call_tool（调）。
 *
 * 它们本身是普通工具，注册进注册表的全局层；网关层（gateway.js）负责把**别的**
 * 工具从模型可见目录里滤掉，并把模型对别的工具的直接调用挡回去。分工是刻意的：
 * 这两个文件各自只做一件事，谁也不认识对方的内部结构。
 *
 * 参数 schema 用原始 JSON Schema 写（DSH 的 schema DSL 与协议级 JSON Schema 是
 * 同一套词汇，插件侧不需要 import 任何类型）。
 */
import { randomUUID } from 'node:crypto'
import { deliverContext } from './deliver-context.js'
import { noticeSource } from './producer-source.js'

/** 两个元工具的名字。网关层用它做白名单，call_tool 用它拒绝自我递归。 */
export const FIND_TOOLS = 'find_tools'
export const CALL_TOOL = 'call_tool'

/** find_tools 一次最多返回几条。 */
const DEFAULT_MAX_RESULTS = 5

/**
 * 非文本块作为独立上下文送出时，这条消息的来源标记。
 *
 * 它同样受 V4 会话的准入约束：`kind` 必须由生产者拥有（见 producer-source.js）。
 */
const CONTEXT_SOURCE = noticeSource('工具结果的非文本内容')

/**
 * 把一次工具执行的结果拆成「给模型看的文本」与「要单独送的块」。
 *
 * 文本块直接拼进 call_tool 的返回值；非文本块（图片等）塞不进文本里，由调用方
 * 用 `exec.deferContext` 作为一条独立上下文送出，agent loop 会在本次工具结果之后
 * 追加它。这与 PTC 模式对含图片的子结果的处理是同一个做法。
 *
 * `UserMessage` 在这里是手工构造的普通对象：它的形状就是 `Message`（llm/message.ts:131）
 * 加上 `role: 'user'`，`source` 由 producer-source.js 给出（V4 会话要求 kind 归生产者所有，
 * 写错会让这一轮在毫秒级失败且不留日志）。
 * DSH 自己的 `createUserMessage` 只多做两件事——补一个 randomUUID 当 id、深冻结——
 * 都不需要 import 才能做到。
 *
 * @param {object} result 注册表返回的执行结果
 * @returns {{ text: string, context: object|undefined }} 文本与待送出的上下文消息
 */
function splitOutcome(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const texts = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string')
  const rest = blocks.filter((block) => block?.type !== 'text')
  const body = texts.map((block) => block.text).join('\n')

  const context = rest.length === 0 ? undefined : {
    id: randomUUID(),
    role: 'user',
    content: rest,
    source: CONTEXT_SOURCE,
  }

  if (result?.isError) {
    const message = result.error?.message ?? '工具执行失败'
    return {
      text: rest.length > 0 ? `${message}\n（另有 ${rest.length} 个非文本块已附在本次结果之后）` : message,
      context,
    }
  }
  if (body.length > 0) {
    return {
      text: rest.length > 0 ? `${body}\n（另有 ${rest.length} 个非文本块已附在本次结果之后）` : body,
      context,
    }
  }
  if (rest.length > 0) return { text: `（${rest.length} 个非文本块已附在本次结果之后）`, context }
  return { text: '（工具没有返回内容）', context: undefined }
}

/**
 * 把参数规范成一份可以安全写进会话日志的副本。
 *
 * JSON 往返一次：既保证它真的可序列化（写日志不能因为参数里有循环引用就炸），
 * 也让日志和真正派发出去的那个对象解耦 —— 工具改了它收到的参数，不该让这条记录
 * 跟着变。与内置 PTC 的做法一致（core/tools/src/ptc.ts 的 normalized.logged）。
 *
 * @param {unknown} args 派发出去的参数
 * @returns {unknown} 可序列化的副本
 */
function loggableArgs(args) {
  try {
    return JSON.parse(JSON.stringify(args ?? {}))
  } catch {
    // 序列化不了（循环引用之类）就返回 undefined：这一条不记，而不是编一个假参数
    // 塞进日志。日志的全部价值就在于它忠实 —— 参数对不上的日志比没有更糟。
    return undefined
  }
}

/**
 * 调一个工具，把结果拆成「文本 + 待送出的上下文」。
 *
 * **三个元工具共用这一条路径**：call_tool 直接把文本交出去；call_tools 里的程序
 * 拿到的也是同一份结果。所以子调用的审批、守卫、沙箱策略、会话日志与模型直接
 * 调用一个工具没有任何区别 —— 差别只在结果送到哪里（对话里，还是程序里）。
 *
 * **子调用要在会话日志里留两条事件**（tool/ptc-dispatch-start / tool/ptc-dispatch），
 * 否则界面上只剩 call_tool 自己那张通用卡片 —— 被调工具自己的卡片全被盖住了。
 * 机制照搬内置 PTC（core/tools/src/ptc.ts）：
 *
 *   - 事件用的是 tool/result 自己的词汇（content + isError），所以界面**走渲染原生
 *     调用的同一条路径**画子调用，不需要认识网关。
 *   - 客户端按 parentCallId/subCallId 把它挂到父调用下面（ui-chat 的 ToolCallTree）。
 *   - **deriveMessages() 会忽略它们** —— 子调用因此永远不会回到模型上下文里，
 *     这正是 call_tools 要的：中间结果只进日志，不进对话。
 *
 * 两条事件必须在打开的 turn 内 append（tools 包的不变量会查），而工具执行本来就
 * 发生在 turn 里，所以这里不用额外判断。
 *
 * **派发出去的那一跳要带上目标工具自己的 schema。** 这是 `ToolExecutionInput.schema`
 * 的契约：内置 PTC 派发 inner call 时带着它（core/tools/src/ptc.ts:550），逐调用审查
 * （Auto review）靠它回答"这一步要执行什么"，缺了就只能在 body 之前拒绝 ——
 * 它要求 `exec.schema.name === exec.name`（auto-review/src/index.ts:342）。
 * 冻结由生产者负责，所以这里给一份冻结的浅拷贝，不去冻注册表里那份共享对象。
 *
 * 接线层没接上 `resolveSchema` 时就不带：那是这条能力没到位，行为退回未带 schema，
 * 而不是拿一个假 schema 顶上。

 * @param {object} options 依赖
 * @param {object} options.ctx 插件上下文（用来读注册表）
 * @param {string} options.name 工具名。存在性由调用方先查（那样能给出更好的提示）
 * @param {unknown} options.args 传给该工具的参数
 * @param {object} options.exec 注册表给的工具执行上下文
 * @param {string} options.callIdSuffix 子调用 id 的后缀。一次程序里可能调很多次，
 *   所以后缀要能区分开（带上序号），否则会话日志里会挤出一串同 id 的调用
 * @param {AbortSignal} [options.signal] 子调用的取消信号，缺省用 `exec.signal`。
 *   call_tools 传的是它自己那次运行的开关：程序结束时好把还在飞的子调用一块停掉
 * @param {(agent: object|undefined, name: string) => object|undefined} [options.resolveSchema]
 *   按名字取这个 agent 看得见的工具 schema，接线层注入（通常复用它的视图缓存）
 * @returns {Promise<{ text: string, context: object|undefined, isError: boolean }>} 结果
 */
export async function invokeTool({ ctx, name, args, exec, callIdSuffix, resolveSchema, signal = exec.signal }) {
  const subCallId = `${String(exec.callId)}:${callIdSuffix}`
  const rootCallId = exec.rootCallId ?? exec.callId
  const logged = loggableArgs(args)

  // 审查者要的是"这一步要执行什么"：带上目标工具自己的 schema，且与 name 一致。
  // 注册表那份 schema 是共享的，冻一个浅拷贝，不动它。
  const resolved = resolveSchema === undefined ? undefined : resolveSchema(exec?.agent, name)
  const schema = resolved === undefined ? undefined : Object.freeze({ ...resolved })

  /**
   * 往会话日志里记一条子调用事件。
   *
   * 失败一律吞掉：日志是观测面，不是执行面 —— 记不上只是界面少画一张卡，
   * 不能因此让工具调用本身失败。
   */
  const logDispatch = (event, data) => {
    // 参数没能序列化就整条不记：宁可界面上少一张卡，也不留一条参数是假的记录。
    if (data.arguments === undefined) return
    try {
      exec?.agent?.session?.append(event, data)
    } catch {
      // 见上：观测面的事不该影响执行面。
    }
  }

  logDispatch('tool/ptc-dispatch-start', {
    rootCallId, parentCallId: exec.callId, subCallId, name, arguments: logged,
  })

  // 走注册表的公开执行入口：审批、守卫、沙箱策略、会话日志都在那条流水线上，
  // 与模型直接调用一个工具没有任何区别。
  //
  // parent 必须带上：它把这个调用标记成"子分发"而不是"模型直接调用"，
  // 网关的守卫据此放行；rootCallId 指回最外层那次调用，日志里能看出调用树的根。
  const result = await ctx.tools.execute({
    callId: subCallId,
    rootCallId: exec.rootCallId,
    name,
    ...(schema === undefined ? {} : { schema }),
    arguments: args,
    ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
    parent: exec.token,
    signal,
  })

  logDispatch('tool/ptc-dispatch', {
    rootCallId,
    parentCallId: exec.callId,
    subCallId,
    name,
    arguments: logged,
    isError: result?.isError === true,
    content: Array.isArray(result?.content) ? result.content : [],
  })

  const { text, context } = splitOutcome(result)
  return { text, context, isError: result?.isError === true }
}

/**
 * 造两个元工具的注册定义。
 *
 * @param {object} options 依赖
 * @param {object} options.ctx 插件上下文（用来读注册表）
 * @param {Function} options.resolveCatalog 按 agent 取目录索引。每个 agent 看得见的
 *   工具不一样 —— preset 注册的工具进的是 agent 自己的作用域层，全局视图看不到它们，
 *   所以索引必须按 agent 取，不能建一份全局的
 * @param {number} [options.maxResults] find_tools 一次返回几条
 * @param {string[]} [options.siblings] 别的元工具名。call_tool 也要拒绝它们 ——
 *   通过 call_tool 去调另一个元工具同样是递归，而且白绕一层。这些名字由接线层
 *   传进来，本模块不需要认识实现它们的模块
 * @returns {object[]} 两个工具定义，按 [find_tools, call_tool] 顺序
 */
/** find_tools 的输出详略，从最省到最全。 */
export const DETAIL_LEVELS = ['name', 'brief', 'params', 'full']

/** 没指定 detail 时给到最全 —— 与这个参数出现之前的行为一致。 */
const DEFAULT_DETAIL = 'full'

/**
 * 取一句摘要：描述里的第一句。
 *
 * 参数清单那一档要的是"够挑就行"的密度，整段描述会把清单冲散。
 *
 * @param {unknown} text 原始描述
 * @returns {string} 第一句（给不出就是空串）
 */
export function firstSentence(text) {
  if (typeof text !== 'string') return ''
  return (text.split(/[。\n]/)[0] ?? '').trim()
}

/**
 * 把一个 JSON Schema 的顶层参数摊成清单行。
 *
 * 只走一层：网关面向的动作是"挑参数"，嵌套结构留给 full 那一档看原文。
 *
 * @param {unknown} parameters 工具的 parameters schema
 * @returns {string[]} 清单行（没有可用参数就是空数组）
 */
export function parameterLines(parameters) {
  const properties = parameters?.properties
  if (typeof properties !== 'object' || properties === null) return []
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : [])
  const lines = ['  参数：']
  for (const [name, spec] of Object.entries(properties)) {
    const type = typeof spec?.type === 'string' ? spec.type : 'any'
    const note = firstSentence(spec?.description)
    lines.push(`    - ${name}（${required.has(name) ? '必填' : '可选'}，${type}）${note === '' ? '' : '：' + note}`)
  }
  return lines
}

/**
 * 按详略档位渲染一个工具。
 *
 * @param {{name: string, description?: string, parameters?: unknown}} entry 工具条目
 * @param {string} detail 档位（{@link DETAIL_LEVELS} 之一）
 * @returns {string[]} 若干行
 */
export function toolLines(entry, detail) {
  if (detail === 'name') return [`- ${entry.name}`]
  const description = typeof entry.description === 'string' ? entry.description : ''
  const head = description === '' ? `- ${entry.name}` : `- ${entry.name} —— ${description}`
  if (detail === 'params') return [head, ...parameterLines(entry.parameters)]
  if (detail === 'full' && entry.parameters !== undefined) {
    return [head, '  参数 schema：', '  ```json',
      ...JSON.stringify(entry.parameters, null, 2).split('\n').map((line) => '  ' + line),
      '  ```']
  }
  return [head]
}

export function createMetaTools({ ctx, resolveCatalog, resolveSchema, maxResults = DEFAULT_MAX_RESULTS, siblings = [] }) {
  /** 不能通过 call_tool 调用的名字：两个元工具自己，加上接线层告知的兄弟元工具。 */
  const blocked = new Set([FIND_TOOLS, CALL_TOOL, ...siblings])

  /**
   * 取某个 agent 看得见的全部工具 schema，按名字索引。
   *
   * 必须传 agent：不传 scope 只看到全局层，preset 注册的工具会全部漏掉
   * （社区插件在这里踩过，见 dev-tool-search 的注释）。
   */
  const schemaMap = (agent) => {
    const map = new Map()
    for (const schema of ctx.tools.schemas(agent)) map.set(schema.name, schema)
    return map
  }

  const findTools = {
    name: FIND_TOOLS,
    description: [
      '查询可用的工具。',
      '',
      '本会话的工具入口是元工具：先用这里查清楚，再用 call_tool 调用。',
      '其余工具不直接出现在工具表里 —— 它们仍然可用，只是要先查。',
      '',
      '两种查法，一次只给一个：',
      '- query：模糊检索。工具名、用途、拼音全拼或首字母都行，返回最像的几个；',
      '- names：按**确切名字**取，一个或多个。不检索、不猜 —— 对不上就直说没有。',
      '',
      'detail 决定给多少（默认 full）：',
      '- name：只有名字；',
      '- brief：名字 + 一句描述；',
      '- params：再加参数清单（名字、类型、必填、一句说明）；',
      '- full：完整参数 schema。',
      '',
      '省 token 的用法：先 find_tools({"detail":"name"}) 空手要一份名字清单，再挑真正要用的那几个',
      '按 names 取 params 或 full —— 不必把所有工具的完整 schema 都读一遍。',
      '',
      '例：find_tools({"query":"搜索"})；find_tools({"names":["read","write"],"detail":"params"})。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '模糊检索词：工具名、用途描述，或它的拼音。与 names 二选一',
        },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: '按确切名字取，一个或多个。确定性查找：不检索、不猜，对不上就直说没有。与 query 二选一',
        },
        detail: {
          type: 'string',
          enum: [...DETAIL_LEVELS],
          description: '给多少：name 只给名字（空手给它就是列一份名字清单）；brief 再加一句描述；'
            + 'params 再加参数清单；full 给完整参数 schema（默认）',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      const wanted = Array.isArray(args?.names)
        ? args.names
          .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
          .map((entry) => entry.trim())
        : []
      const detail = DETAIL_LEVELS.includes(args?.detail) ? args.detail : DEFAULT_DETAIL

      if (query !== '' && wanted.length > 0) {
        return { text: 'query 与 names 只能给一个：前者是检索，后者是按名字确定地取。' }
      }

      const schemas = schemaMap(exec?.agent)
      const catalog = resolveCatalog(exec?.agent)

      // 按确切名字取。不检索、不打分 —— 对不上就如实说没有，不去推荐"最像的"。
      if (wanted.length > 0) {
        const found = []
        const missing = []
        for (const name of wanted) {
          if (!catalog.has(name)) {
            missing.push(name)
            continue
          }
          const schema = schemas.get(name)
          found.push({ name, description: schema?.description ?? '', parameters: schema?.parameters })
        }
        const lines = found.flatMap((entry) => toolLines(entry, detail))
        if (found.length > 0) {
          lines.push('', '调用方式：call_tool({"tool_name":"<工具名>","arguments":{...}})。')
        }
        if (missing.length > 0) {
          lines.push('', `没有这些工具：${missing.join('、')}。`
            + '名字要精确（也可以拿 query 模糊找一个）；被本会话关掉的工具同样不在目录里。')
        }
        return { text: lines.join('\n') }
      }

      // 空手 + 只要名字 = 列一份清单。先看有哪些、再挑要看的，比一次全要省。
      if (query === '') {
        if (detail !== 'name') {
          return {
            text: '请给 query（模糊检索）或 names（按确切名字取）。'
              + '只想看有哪些工具，就用 detail="name" 空手要一份名字清单。',
          }
        }
        const all = catalog.names()
        if (all.length === 0) return { text: '这个会话的目录里没有工具。' }
        return { text: [`目录里有 ${all.length} 个工具：`, '', ...all.map((name) => `- ${name}`)].join('\n') }
      }

      const hits = catalog.search(query, maxResults)
      if (hits.length === 0) {
        return {
          text: `没有匹配「${query}」的工具。换个说法再查（可以试工具名、用途，或拼音）；`
            + '已经知道确切名字的话用 names 直接取，或者直接 call_tool 调它。',
        }
      }
      const entries = hits.map((hit) => {
        const schema = schemas.get(hit.name)
        return {
          name: hit.name,
          description: hit.description || schema?.description || '',
          parameters: schema?.parameters,
        }
      })
      const lines = [
        `匹配「${query}」的工具 ${entries.length} 个：`,
        '',
        ...entries.flatMap((entry) => toolLines(entry, detail)),
        '',
        '调用方式：call_tool({"tool_name":"<工具名>","arguments":{...}})。',
      ]
      return { text: lines.join('\n') }
    },
  }

  const callTool = {
    name: CALL_TOOL,
    description: [
      '调用一个工具。',
      '',
      '用法：tool_name 传确切工具名，arguments 传该工具的参数对象。',
      '不知道工具名或参数结构时，先用 find_tools 查 —— 它返回完整的参数 schema。',
      '',
      '例：call_tool({"tool_name":"zhihu_search","arguments":{"keyword":"DeepSeek"}})',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: '要调用的工具名（先用 find_tools 查确切名字）' },
        arguments: { type: 'object', description: '传给该工具的参数对象，结构与 find_tools 返回的 schema 一致' },
      },
      required: ['tool_name', 'arguments'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const name = typeof args?.tool_name === 'string' ? args.tool_name.trim() : ''
      if (name.length === 0) {
        return { text: '请提供 tool_name。不知道名字就先用 find_tools 查。' }
      }
      if (blocked.has(name)) {
        return { text: `${name} 不能通过 call_tool 调用（会递归）。直接用它的参数调用它自己即可。` }
      }
      if (ctx.tools.get(name, exec?.agent) === undefined) {
        return {
          text: `没有名为「${name}」的工具。用 find_tools 查一下确切名字 —— `
            + '注意工具名区分下划线与大小写。',
        }
      }
      const { text, context } = await invokeTool({
        ctx, name, args: args?.arguments ?? {}, exec, callIdSuffix: 'meta', resolveSchema,
      })
      deliverContext(exec, context)
      return { text }
    },
  }

  return [findTools, callTool]
}
