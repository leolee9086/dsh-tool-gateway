/**
 * 检索栈的行为测试。
 *
 * 断言的依据全部来自 docs/检索栈实测.md —— 那几个"实测推翻假设"的点各有一条用例守着，
 * 以后谁把 cutForSearch 改回 cut、或者把标点 token 放回来，这里会红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalog, initialsOf, pinyinTokens, tokenize } from '../src/catalog.js'

test('tokenize 丢掉标点与下划线，下划线标识符拆成两部分', () => {
  // jieba 把下划线切成独立词项，所以整串 `zhihu_search` 从不作为单个词项存在。
  // 这没问题：查询侧走同一个分析器，两边都拆成 ['zhihu','search']，照样命中。
  assert.deepEqual(tokenize('zhihu_search'), ['zhihu', 'search'])
  // 那个单独成词的下划线绝不能出现在词项里：索引侧留着它，查任何带下划线的
  // 工具名都会把全部工具召回（实测过）。
  assert.ok(!tokenize('zhihu_search').includes('_'))
  assert.ok(!tokenize('读文件、写文件。').includes('、'))
  assert.ok(!tokenize('读文件、写文件。').includes('。'))
})

test('tokenize 用搜索引擎模式，长词要能切出子词', () => {
  const tokens = tokenize('知乎站内搜索')
  // 普通 cut 只会给出整词「站内搜索」，于是查「搜索」召不回它。
  assert.ok(tokens.includes('搜索'), `期望切出「搜索」，实际：${JSON.stringify(tokens)}`)
  assert.ok(tokens.includes('站内搜索'))
})

test('pinyinTokens 按词分段，不整段连写', () => {
  const spelled = pinyinTokens('知乎站内搜索')
  // 整段连写会得到 "zhihuzhanneisousuo"，查 sousuo 召不回。
  assert.ok(spelled.includes('sousuo'), `期望含「sousuo」，实际：${JSON.stringify(spelled)}`)
  assert.ok(spelled.includes('zhannei'))
  assert.ok(spelled.includes('zhanneisousuo'))
})

test('pinyinTokens 不把纯英文逐字母拆开', () => {
  // 不加 nonZh:'consecutive' 的话这里会变成 "z h i h u _ s e a r c h"。
  assert.equal(pinyinTokens('zhihu_search'), '')
})

test('initialsOf 取首字母；纯英文名原样保留', () => {
  assert.equal(initialsOf('知乎搜索'), 'zhss')
  // nonZh:'consecutive' 让非中文段整体保留，于是英文工具名的"首字母"就是它自己。
  assert.equal(initialsOf('zhihu_search'), 'zhihu_search')
})

test('search：中文、英文、拼音全拼、拼音首字母都能召回', () => {
  const catalog = createCatalog()
  catalog.rebuild([
    { name: 'zhihu_search', description: '知乎站内搜索，按关键词找问题与回答' },
    { name: 'web_search', description: '搜索网页并返回结果' },
    { name: 'sketchup_status', description: '查看 SketchUp 模型状态' },
  ])

  const names = (query) => catalog.search(query, 5).map((hit) => hit.name)

  assert.deepEqual(names('zhihu'), ['zhihu_search'])
  assert.ok(names('搜索').includes('zhihu_search'), '中文查询要能召回描述里含该词的英文名工具')
  assert.ok(names('搜索').includes('web_search'))
  assert.ok(names('sousuo').includes('zhihu_search'), '拼音全拼要能召回')
  assert.ok(names('zhanneisousuo').includes('zhihu_search'))
  assert.deepEqual(names('sketchup'), ['sketchup_status'])
  assert.deepEqual(names('模型'), ['sketchup_status'])
  assert.deepEqual(names('moxing'), ['sketchup_status'], '拼音要能召回中文描述')
})

test('search：精确工具名不会把全部工具都召回', () => {
  const catalog = createCatalog()
  catalog.rebuild([
    { name: 'zhihu_search', description: '知乎站内搜索' },
    { name: 'sketchup_status', description: '查看模型状态' },
    { name: 'read_image', description: '读取图片' },
  ])
  const names = catalog.search('zhihu_search', 5).map((hit) => hit.name)
  assert.ok(names.includes('zhihu_search'))
  assert.ok(!names.includes('read_image'), `不该召回无关工具：${JSON.stringify(names)}`)
})

test('search：查不存在的词返回空，空查询也返回空', () => {
  const catalog = createCatalog()
  catalog.rebuild([{ name: 'zhihu_search', description: '知乎搜索' }])
  assert.deepEqual(catalog.search('quuxzzy', 5), [])
  assert.deepEqual(catalog.search('', 5), [])
  assert.deepEqual(catalog.search('   ', 5), [])
})

test('search：limit 生效', () => {
  const catalog = createCatalog()
  catalog.rebuild(Array.from({ length: 10 }, (_, i) => ({ name: `search_${i}`, description: '搜索' })))
  assert.equal(catalog.search('搜索', 3).length, 3)
})

test('增量：upsert 顶替同名、remove 按 id 字符串删、size 跟着变', () => {
  const catalog = createCatalog()
  catalog.rebuild([{ name: 'alpha', description: '第一个' }])
  assert.equal(catalog.size(), 1)

  catalog.upsert({ name: 'beta', description: '第二个' })
  assert.equal(catalog.size(), 2)

  // 同名顶替：内容要换成新的，条数不变。
  catalog.upsert({ name: 'alpha', description: '换过的描述' })
  assert.equal(catalog.size(), 2)
  assert.match(catalog.search('换过的描述', 5)[0]?.description ?? '', /换过的描述/)

  catalog.remove('beta')
  assert.equal(catalog.size(), 1)
  assert.deepEqual(catalog.search('第二个', 5), [])

  // 删不存在的名字不该抛（注册表可能在别处已经摘掉了它）。
  catalog.remove('never_existed')
})
