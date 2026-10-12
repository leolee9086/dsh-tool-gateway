import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RESULT_TOKEN_BUDGET, resultTokenBudget, fitSearchResults } from '../src/search-results.js'

// 字符计量仅用来构造确定性算法边界；生产代码接宿主 token 估算器。
const measure = text => [...text].length
const entry = (name, size = 0) => ({ name, text: `- ${name}\n  schema: ${'x'.repeat(size)}` })
const fit = options => fitSearchResults({ header: '工具目录', budget: 512, measure, ...options })

test('默认预算与配置整数边界', () => {
  assert.equal(DEFAULT_RESULT_TOKEN_BUDGET, 10000)
  assert.equal(resultTokenBudget(), 10000)
  for (const value of [256, 1000000]) assert.equal(resultTokenBudget(value), value)
  for (const value of [255, 1000001, 256.5, NaN, Infinity, '10000', null]) {
    assert.throws(() => resultTokenBudget(value), /resultTokenBudget/)
  }
})

test('完整详情在预算内时保持原文及候选顺序', () => {
  const entries = [entry('first', 10), entry('second', 10)]
  const result = fit({ entries, footer: '调用说明' })
  assert.equal(result.shown, 2)
  assert.equal(result.nextOffset, undefined)
  assert.ok(result.text.includes(entries.map(e => e.text).join('\n')))
  assert.match(result.text, /折叠 0 项，截断 0 项/)
  assert.ok(measure(result.text) <= 512)
})

test('先折叠尾部详情，保留所有名字及可容纳的前部详情', () => {
  const entries = ['first', 'middle', 'last'].map(name => entry(name, 200))
  const result = fit({ entries })
  assert.equal(result.shown, 3)
  assert.ok(result.text.includes(entries[0].text))
  assert.ok(!result.text.includes(entries[2].text))
  assert.match(result.text, /^- last$/m)
  assert.match(result.text, /截断 0 项/)
  assert.ok(measure(result.text) <= 512)
})

test('单个巨大 Schema 折叠为完整名字，不输出半截详情', () => {
  const result = fit({ entries: [entry('huge_schema', 100000)] })
  assert.equal(result.shown, 1)
  assert.match(result.text, /^- huge_schema$/m)
  assert.doesNotMatch(result.text, /schema: x/)
  assert.equal(result.nextOffset, undefined)
})

test('仅名字仍超预算才截尾；分页连续且不会遗漏或重复', () => {
  const entries = Array.from({ length: 40 }, (_, i) => entry(`tool_${String(i).padStart(2, '0')}_${'n'.repeat(25)}`, 500))
  const seen = []
  let offset = 0
  do {
    const result = fit({ entries, offset, budget: 256 })
    assert.ok(result.shown > 0)
    assert.ok(measure(result.text) <= 256)
    assert.doesNotMatch(result.text, /schema: x/)
    seen.push(...result.text.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)))
    if (result.nextOffset === undefined) break
    assert.equal(result.nextOffset, offset + result.shown)
    offset = result.nextOffset
  } while (offset < entries.length)
  assert.deepEqual(seen, entries.map(e => e.name))
})

test('名称档不误报详情折叠', () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ name: `name_${i}`, text: `- name_${i}` }))
  const result = fit({ entries, budget: 256 })
  assert.match(result.text, /折叠 0 项/)
  assert.ok(result.shown < entries.length)
  assert.ok(measure(result.text) <= 256)
})

test('预算包括标题、尾注、计数和翻页提示', () => {
  const result = fit({ entries: [entry('first', 200), entry('second', 200)], header: '标题'.repeat(40), footer: '注释'.repeat(40), budget: 256 })
  assert.ok(measure(result.text) <= 256)
  assert.doesNotMatch(result.text, /schema: x/)
})

test('无法容纳一个完整名字时不返回原地循环分页', () => {
  const result = fit({ entries: [entry('n'.repeat(3000))], budget: 256 })
  assert.equal(result.shown, 0)
  assert.equal(result.nextOffset, undefined)
  assert.match(result.text, /超过预算/)
  assert.ok(measure(result.text) <= 256)
})

test('空目录、末尾 offset 和超出目录 offset 都能收口', () => {
  for (const options of [{ entries: [] }, { entries: [entry('one')], offset: 1 }, { entries: [entry('one')], offset: 10 }]) {
    const result = fit(options)
    assert.equal(result.shown, 0)
    assert.equal(result.nextOffset, undefined)
    assert.ok(measure(result.text) <= 512)
  }
})

test('精确达到预算的完整输出仍保留详情', () => {
  const entries = [entry('exact')]
  const result = fit({ entries, budget: 256, measure: () => 256 })
  assert.ok(result.text.includes(entries[0].text))
  assert.equal(result.shown, 1)
})

test('无效 offset 和计量异常直接报错', () => {
  for (const offset of [-1, 0.5, NaN]) assert.throws(() => fit({ entries: [], offset }), /offset/)
  for (const value of [-1, NaN, Infinity, undefined]) {
    assert.throws(() => fit({ entries: [], measure: () => value }), /无效的估算值/)
  }
  assert.throws(() => fit({ entries: [entry('x')], measure: () => 100000 }), /最小结果说明/)
})

test('调用方省略 budget 时也应用默认预算', () => {
  const result = fitSearchResults({ entries: [entry('default')], header: '目录', measure })
  assert.equal(result.shown, 1)
  assert.match(result.text, /预算 10000/)
})
