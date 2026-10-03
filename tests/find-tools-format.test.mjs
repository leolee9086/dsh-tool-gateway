/**
 * find_tools 的两条新路子：按确切名字取、以及"给多少"的档位。
 *
 * 测的是渲染那一层 —— firstSentence / parameterLines / toolLines 都是纯函数，
 * 所以这里不需要 ctx，也没有桩：把输入摆好，断言输出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DETAIL_LEVELS, firstSentence, parameterLines, toolLines } from '../src/meta-tools.js'

const READ = {
  name: 'read',
  description: '读一个文件。会按行号回显。',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '要读的路径。必须是绝对路径。' },
      offset: { type: 'number', description: '从第几行开始' },
    },
    required: ['file_path'],
  },
}

test('firstSentence：只取第一句，换行也算断句', () => {
  assert.equal(firstSentence('第一句。第二句。'), '第一句')
  assert.equal(firstSentence('只有一行\n第二行'), '只有一行')
  assert.equal(firstSentence(undefined), '')
  assert.equal(firstSentence(42), '')
})

test('toolLines：name 档只有名字', () => {
  assert.deepEqual(toolLines(READ, 'name'), ['- read'])
})

test('toolLines：brief 档给名字加一句描述，不带参数', () => {
  const lines = toolLines(READ, 'brief')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^- read —— /)
  assert.equal(lines.join('\n').includes('json'), false)
})

test('toolLines：params 档摊出参数清单，标出必填与类型', () => {
  const text = toolLines(READ, 'params').join('\n')
  assert.match(text, /file_path（必填，string）：要读的路径/)
  assert.match(text, /offset（可选，number）：从第几行开始/)
  assert.equal(text.includes('```'), false, 'params 不该给完整 JSON')
})

test('toolLines：full 档给完整参数 schema', () => {
  const text = toolLines(READ, 'full').join('\n')
  assert.match(text, /```json/)
  assert.match(text, /"required"/)
  assert.match(text, /"file_path"/)
})

test('parameterLines：没有参数就什么都不给，不编一个空壳', () => {
  assert.deepEqual(parameterLines(undefined), [])
  assert.deepEqual(parameterLines({ type: 'object' }), [])
  assert.deepEqual(parameterLines({ type: 'object', properties: {} }), ['  参数：'])
})

test('parameterLines：参数没写 description 时不留一个悬空的冒号', () => {
  assert.deepEqual(
    parameterLines({ type: 'object', properties: { x: { type: 'number' } } }),
    ['  参数：', '    - x（可选，number）'],
  )
})

test('档位表就是这四档', () => {
  assert.deepEqual([...DETAIL_LEVELS], ['name', 'brief', 'params', 'full'])
})
