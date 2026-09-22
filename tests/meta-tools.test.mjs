/**
 * 两个元工具的行为测试。
 *
 * 用真的 catalog（已单独测过）+ 手写的注册表桩。重点盯三件事：
 * 参数 schema 有没有给到模型、call_tool 是不是走了注册表的执行入口、
 * 非文本块有没有经 deferContext 送出去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalog } from '../src/catalog.js'
import { CALL_TOOL, FIND_TOOLS, createMetaTools } from '../src/meta-tools.js'

const TOOLS = [
  {
    name: 'zhihu_search',
    description: '知乎站内搜索，按关键词找问题与回答',
    parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
  },
  {
    name: 'read_image',
    description: '读取图片文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

/**
 * 造一套够用的依赖。
 *
 * @param {object} [options] 覆盖项
 * @param {object} [options.outcome] 注册表执行入口的返回值
 * @param {number} [options.maxResults] find_tools 一次返回几条
 * @returns {object} 两个工具定义与观察点
 */
function setup({ outcome, maxResults } = {}) {
  const catalog = createCatalog()
  catalog.rebuild(TOOLS)

  const executed = []
  const deferred = []
  const ctx = {
    tools: {
      schemas: () => TOOLS,
      get: (name) => TOOLS.find((tool) => tool.name === name),
      execute: async (input) => {
        executed.push(input)
        return outcome ?? { isError: false, content: [{ type: 'text', text: '结果文本' }] }
      },
    },
  }

  const [findTools, callTool] = createMetaTools({ ctx, resolveCatalog: () => catalog, maxResults })
  const exec = {
    callId: 'call-1',
    rootCallId: 'call-1',
    token: { token: 'tok' },
    signal: new AbortController().signal,
    deferContext: (message) => { deferred.push(message) },
  }
  return { findTools, callTool, exec, executed, deferred }
}

test('两个元工具的名字是 find_tools 与 call_tool', () => {
  const { findTools, callTool } = setup()
  assert.equal(findTools.name, FIND_TOOLS)
  assert.equal(callTool.name, CALL_TOOL)
})

test('find_tools：查到工具，并把完整参数 schema 给出去', async () => {
  const { findTools, exec } = setup()
  const { text } = await findTools.execute({ query: '知乎' }, exec)

  assert.match(text, /zhihu_search/)
  // 参数名必须出现 —— 模型要靠它构造 call_tool 的 arguments。
  assert.match(text, /keyword/)
  assert.match(text, /call_tool/)
})

test('find_tools：拼音也能查到', async () => {
  const { findTools, exec } = setup()
  const { text } = await findTools.execute({ query: 'tupian' }, exec)
  assert.match(text, /read_image/)
})

test('find_tools：空查询给用法提示，不抛错', async () => {
  const { findTools, exec } = setup()
  const { text } = await findTools.execute({ query: '   ' }, exec)
  assert.match(text, /query/)
})

test('find_tools：查不到时提示换说法或直接 call_tool', async () => {
  const { findTools, exec } = setup()
  const { text } = await findTools.execute({ query: 'quuxzzy' }, exec)
  assert.match(text, /没有匹配/)
  assert.match(text, /call_tool/)
})

test('find_tools：maxResults 生效', async () => {
  const catalog = createCatalog()
  catalog.rebuild(Array.from({ length: 8 }, (_, i) => ({ name: `search_${i}`, description: '搜索' })))
  const ctx = { tools: { schemas: () => [], get: () => undefined, execute: async () => ({}) } }
  const [findTools] = createMetaTools({ ctx, resolveCatalog: () => catalog, maxResults: 3 })
  const { text } = await findTools.execute({ query: '搜索' }, { callId: 'c', token: {}, signal: new AbortController().signal })
  assert.equal((text.match(/^### /gm) ?? []).length, 3)
})

test('call_tool：走注册表的执行入口，并把自己标成子分发', async () => {
  const { callTool, exec, executed } = setup()
  const { text } = await callTool.execute({ tool_name: 'zhihu_search', arguments: { keyword: 'x' } }, exec)

  assert.equal(text, '结果文本')
  assert.equal(executed.length, 1)
  assert.equal(executed[0].name, 'zhihu_search')
  assert.deepEqual(executed[0].arguments, { keyword: 'x' })
  // parent 必须带上：网关的守卫靠它区分"子分发"与"模型直接调用"。
  assert.equal(executed[0].parent, exec.token)
  // rootCallId 指回 call_tool 自己那次调用，日志里能看出调用树的根。
  assert.equal(executed[0].rootCallId, exec.rootCallId)
})

test('call_tool：拒绝调用两个元工具自己（会递归）', async () => {
  const { callTool, exec, executed } = setup()
  for (const name of [FIND_TOOLS, CALL_TOOL]) {
    const { text } = await callTool.execute({ tool_name: name, arguments: {} }, exec)
    assert.match(text, /递归/)
  }
  assert.equal(executed.length, 0, '递归调用不该真的走到执行入口')
})

test('call_tool：未知工具给可操作的错误', async () => {
  const { callTool, exec, executed } = setup()
  const { text } = await callTool.execute({ tool_name: 'no_such_tool', arguments: {} }, exec)
  assert.match(text, /no_such_tool/)
  assert.match(text, /find_tools/)
  assert.equal(executed.length, 0)
})

test('call_tool：缺 tool_name 时给用法提示', async () => {
  const { callTool, exec } = setup()
  const { text } = await callTool.execute({ arguments: {} }, exec)
  assert.match(text, /tool_name/)
})

test('call_tool：非文本块经 deferContext 作为独立上下文送出', async () => {
  const { callTool, exec, deferred } = setup({
    outcome: {
      isError: false,
      content: [{ type: 'text', text: '这是截图' }, { type: 'image', data: 'base64…' }],
    },
  })
  const { text } = await callTool.execute({ tool_name: 'read_image', arguments: { path: 'a.png' } }, exec)

  assert.match(text, /这是截图/)
  assert.match(text, /1 个非文本块/)
  assert.equal(deferred.length, 1)
  // 手工构造的 UserMessage：形状 = Message + role:'user'。
  assert.equal(deferred[0].role, 'user')
  assert.equal(deferred[0].source.kind, 'plugin')
  assert.equal(typeof deferred[0].id, 'string')
  assert.equal(deferred[0].content.length, 1)
  assert.equal(deferred[0].content[0].type, 'image')
})

test('call_tool：只有文本块时不送额外上下文', async () => {
  const { callTool, exec, deferred } = setup()
  await callTool.execute({ tool_name: 'zhihu_search', arguments: {} }, exec)
  assert.equal(deferred.length, 0)
})

test('call_tool：把工具的错误如实转达给模型', async () => {
  const { callTool, exec } = setup({
    outcome: { isError: true, error: { message: '权限不足，需要审批' }, content: [] },
  })
  const { text } = await callTool.execute({ tool_name: 'zhihu_search', arguments: {} }, exec)
  assert.match(text, /权限不足/)
})

test('call_tool：工具没有返回内容时也给出可读的交代', async () => {
  const { callTool, exec } = setup({ outcome: { isError: false, content: [] } })
  const { text } = await callTool.execute({ tool_name: 'zhihu_search', arguments: {} }, exec)
  assert.match(text, /没有返回内容/)
})
