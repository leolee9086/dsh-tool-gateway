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

/** 两个元工具的名字。网关层用它做白名单，call_tool 用它拒绝自我递归。 */
export const FIND_TOOLS = 'find_tools'
export const CALL_TOOL = 'call_tool'
export const META_TOOL_NAMES = [FIND_TOOLS, CALL_TOOL]

/** find_tools 一次最多返回几条。 */
const DEFAULT_MAX_RESULTS = 5

/** 非文本块作为独立上下文送出时，这条消息的来源标记。 */
const CONTEXT_SOURCE = { kind: 'plugin', plugin: 'dsh-tool-gateway' }

/**
 * 把一次工具执行的结果拆成「给模型看的文本」与「要单独送的块」。
 *
 * 文本块直接拼进 call_tool 的返回值；非文本块（图片等）塞不进文本里，由调用方
 * 用 `exec.deferContext` 作为一条独立上下文送出，agent loop 会在本次工具结果之后
 * 追加它。这与 PTC 模式对含图片的子结果的处理是同一个做法。
 *
 * `UserMessage` 在这里是手工构造的普通对象：它的形状就是 `Message`（llm/message.ts:131）
 * 加上 `role: 'user'`，`source` 取 `{kind: 'plugin', plugin}`（MessageSourceMap.plugin）。
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
 * 造两个元工具的注册定义。
 *
 * @param {object} options 依赖
 * @param {object} options.ctx 插件上下文（用来读注册表）
 * @param {Function} options.resolveCatalog 按 agent 取目录索引。每个 agent 看得见的
 *   工具不一样 —— preset 注册的工具进的是 agent 自己的作用域层，全局视图看不到它们，
 *   所以索引必须按 agent 取，不能建一份全局的
 * @param {number} [options.maxResults] find_tools 一次返回几条
 * @returns {object[]} 两个工具定义，按 [find_tools, call_tool] 顺序
 */
export function createMetaTools({ ctx, resolveCatalog, maxResults = DEFAULT_MAX_RESULTS }) {
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
      '本会话只暴露两个工具：find_tools 与 call_tool，其余工具都要先查再用。',
      '支持中文、英文、拼音全拼（zhihu）和拼音首字母查询。',
      '',
      '用法：传 query 拿到匹配工具的**完整参数 schema**，然后用 call_tool 调用。',
      '例：find_tools({"query":"搜索"}) → 拿到 zhihu_search 的参数，再 call_tool({"tool_name":"zhihu_search","arguments":{...}})。',
      '',
      '查询为空或结果不理想时换个说法再查；工具确实存在但没搜到时，可以直接按名字 call_tool。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询词：工具名、用途描述，或它的拼音' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query.length === 0) {
        return { text: '请提供 query。例如 find_tools({"query":"搜索"})。' }
      }
      const hits = resolveCatalog(exec?.agent).search(query, maxResults)
      if (hits.length === 0) {
        return {
          text: `没有匹配「${query}」的工具。换个说法再查（可以试工具名、用途，或拼音）；`
            + '如果你已经知道确切的工具名，直接用 call_tool 调用它。',
        }
      }
      const schemas = schemaMap(exec?.agent)
      const lines = [`匹配「${query}」的工具 ${hits.length} 个：`]
      for (const hit of hits) {
        const schema = schemas.get(hit.name)
        lines.push('', `### ${hit.name}`, hit.description || '（无描述）')
        if (schema?.parameters !== undefined) {
          lines.push('参数 schema：', '```json', JSON.stringify(schema.parameters, null, 2), '```')
        }
      }
      lines.push('', '调用方式：call_tool({"tool_name":"<工具名>","arguments":{...}})。')
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
      if (META_TOOL_NAMES.includes(name)) {
        return { text: `${name} 不能通过 call_tool 调用（会递归）。直接用它的参数调用它自己即可。` }
      }
      const definition = ctx.tools.get(name, exec?.agent)
      if (definition === undefined) {
        return {
          text: `没有名为「${name}」的工具。用 find_tools 查一下确切名字 —— `
            + '注意工具名区分下划线与大小写。',
        }
      }
      // 走注册表的公开执行入口：审批、守卫、沙箱策略、会话日志都在那条流水线上，
      // 与模型直接调用一个工具没有任何区别。
      //
      // parent 必须带上：它把这个调用标记成"子分发"而不是"模型直接调用"，
      // 网关的守卫据此放行；rootCallId 指回 call_tool 自己那次调用，
      // 日志里能看出这棵调用树的根在哪。
      const result = await ctx.tools.execute({
        callId: `${String(exec.callId)}:meta`,
        rootCallId: exec.rootCallId,
        name,
        arguments: args?.arguments ?? {},
        ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
        parent: exec.token,
        signal: exec.signal,
      })
      const { text, context } = splitOutcome(result)
      if (context !== undefined && typeof exec.deferContext === 'function') exec.deferContext(context)
      return { text }
    },
  }

  return [findTools, callTool]
}
