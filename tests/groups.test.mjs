/**
 * 工具组与可用性判定的测试。
 *
 * 这一层是纯逻辑：不认识 Cordis、不读状态、不写存储 —— 判定要的输入全部由调用方给。
 * 所以这里不需要任何桩，直接调就行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGroupRegistry, toolEnabled } from '../src/groups.js'

/**
 * 造一份「什么都没显式开关过」的会话偏好。
 *
 * @param {object} [over] 要覆盖的字段
 * @returns {object} 会话偏好
 */
const prefs = (over = {}) => ({
  disabledTools: new Set(), enabledTools: new Set(), groups: new Map(), ...over,
})

test('注册一个组：成员归属与列表顺序', () => {
  const registry = createGroupRegistry()
  const first = registry.register({ id: 'a', title: '甲组', origin: 'p', names: ['x', 'y'] })
  registry.register({ id: 'b', title: '乙组' })
  first.add('z')

  assert.equal(registry.size(), 2)
  assert.deepEqual(registry.list().map((group) => group.id), ['a', 'b'], '列表按注册顺序')
  assert.equal(registry.groupOf('x').id, 'a')
  assert.equal(registry.groupOf('z').id, 'a')
  assert.equal(registry.groupOf('nope'), undefined)
})

test('组的默认值是关：注册一个组通常就是为了「先别放出来」', () => {
  const registry = createGroupRegistry()
  registry.register({ id: 'a' })
  registry.register({ id: 'b', defaultEnabled: true })
  assert.deepEqual(registry.list().map((group) => group.defaultEnabled), [false, true])

  // 注册方后来可以改主意（例如一个组的工具数量从少变多），改的是名册里的那份。
  const handle = registry.register({ id: 'c', defaultEnabled: true })
  handle.setDefaultEnabled(false)
  assert.equal(registry.list()[2].defaultEnabled, false)
})

test('id 重复、非法、或工具已被别的组占着 —— 都直接抛错', () => {
  const registry = createGroupRegistry()
  registry.register({ id: 'a', names: ['x'] })

  assert.throws(() => registry.register({ id: 'a' }), /已经注册过了/)
  assert.throws(() => registry.register({ id: '有空格 的' }), /不允许的字符/)
  assert.throws(() => registry.register({ id: '' }), /不能为空/)
  assert.throws(() => registry.register({}), /字符串 id/)
  // 一个工具只属于一个组：让「谁先注册谁赢」变成一条看不见的隐规则，出问题查不到。
  assert.throws(() => registry.register({ id: 'b', names: ['x'] }), /已经属于工具组/)
})

test('初始成员撞上别的组时，这次注册整个撤掉，不留半截的组', () => {
  const registry = createGroupRegistry()
  registry.register({ id: 'a', names: ['x'] })

  assert.throws(() => registry.register({ id: 'b', names: ['ok', 'x'] }), /已经属于/)
  // 'ok' 是在撞上 'x' 之前就加进去的 —— 它不该留在名册里。
  assert.equal(registry.groupOf('ok'), undefined)
  assert.equal(registry.size(), 1)
})

test('remove 与 dispose：撤销之后工具回到「不属于任何组」', () => {
  const registry = createGroupRegistry()
  const group = registry.register({ id: 'a', names: ['x', 'y'] })

  group.remove('x')
  assert.equal(registry.groupOf('x'), undefined)
  assert.equal(registry.groupOf('y').id, 'a')

  group.dispose()
  assert.equal(registry.groupOf('y'), undefined)
  assert.equal(registry.size(), 0)
  // 撤销之后再加成员是接线错误，直接抛，不静默丢掉。
  assert.throws(() => group.add('z'), /已经撤销/)
})

test('判定：不属于任何组的工具默认可用', () => {
  assert.equal(toolEnabled('read', prefs(), undefined), true)
})

test('判定：显式关掉就是关，显式打开能盖过组默认关', () => {
  const group = { id: 'a', defaultEnabled: false }
  assert.equal(toolEnabled('t', prefs(), group), false, '组默认关')
  assert.equal(toolEnabled('t', prefs({ enabledTools: new Set(['t']) }), group), true,
    '显式打开盖过组默认')
  assert.equal(toolEnabled('t', prefs({ disabledTools: new Set(['t']) }), group), false)
  assert.equal(toolEnabled('t', prefs({ disabledTools: new Set(['t']) }), undefined), false,
    '不属于组的工具也能被显式关掉')
})

test('判定：组的显式覆盖盖过组默认，但盖不过单个工具的显式开关', () => {
  const group = { id: 'a', defaultEnabled: false }
  assert.equal(toolEnabled('t', prefs({ groups: new Map([['a', true]]) }), group), true)
  assert.equal(toolEnabled('t', prefs({ groups: new Map([['a', false]]) }), group), false)

  const closedGroupOpenTool = prefs({ groups: new Map([['a', false]]), enabledTools: new Set(['t']) })
  assert.equal(toolEnabled('t', closedGroupOpenTool, group), true, '单个工具的显式开优先于整组关')

  // 别的组的覆盖与它无关。
  assert.equal(toolEnabled('t', prefs({ groups: new Map([['other', true]]) }), group), false)
})

test('判定：两边都写着时算关 —— 被外部写坏的记录不该意外放出工具', () => {
  const both = prefs({ disabledTools: new Set(['t']), enabledTools: new Set(['t']) })
  assert.equal(toolEnabled('t', both, undefined), false)
})
