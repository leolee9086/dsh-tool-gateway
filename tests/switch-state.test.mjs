/**
 * 开关状态的测试。
 *
 * storageDomain 是桩，但桩**按真实 domain 的规则行事**：open 时校验 domain 名与表名
 * 匹配 `UNIT_NAME_RE`，并用 spec 里的 schema 过一遍每一条已存记录。这样"我提供的
 * 那个鸭子类型 schema 到底能不能满足 DSH 的运行时契约"是被真的测到的，
 * 而不是只测了"我调了 open"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwitchState, DOMAIN_NAME } from '../src/switch-state.js'

/** 与 `@deepseek-ai/dsh-storage` 的 `UNIT_NAME_RE` 同一个正则。 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * 造一个 storageDomain 桩。
 *
 * @param {object} [options] 行为开关
 * @param {Error|null} [options.openError] open 时抛这个错
 * @param {object} [options.initial] 打开前介质里已有的记录
 * @returns {{facility: object, records: Map, calls: object}} 桩与它的可观测状态
 */
function stubStorage({ openError = null, initial = {} } = {}) {
  const records = new Map(Object.entries(initial))
  const calls = { opened: [], closed: 0 }
  const facility = {
    async open(spec) {
      calls.opened.push(spec)
      if (openError !== null) throw openError
      assert.match(spec.name, UNIT_NAME_RE, 'domain 名必须匹配 UNIT_NAME_RE')
      const [tableName, tableSpec] = Object.entries(spec.tables)[0]
      assert.match(tableName, UNIT_NAME_RE, '表名必须匹配 UNIT_NAME_RE')
      const schema = tableSpec.valueSchema
      // 真实 domain 在 open 时会拿 schema 校验每一条已存记录，不合格就抛 invalid-record。
      for (const [key, value] of [...records]) records.set(key, schema.parse(value))
      return {
        table(name) {
          assert.equal(name, tableName, '只能取 spec 里声明过的表')
          return {
            get: (key) => records.get(key),
            put: async (key, value) => { records.set(key, schema.parse(value)) },
          }
        },
        async close() { calls.closed += 1 },
      }
    },
  }
  return { facility, records, calls }
}

/** 造一个只提供 storageDomain 的 ctx 桩。 */
const ctxWith = (facility) => ({ get: (name) => (name === 'storageDomain' ? facility : undefined) })

test('domain 名与表名符合 storage 的命名约束，且不声明 global', async () => {
  const { facility, calls } = stubStorage()
  await createSwitchState(ctxWith(facility), () => {})

  assert.equal(calls.opened.length, 1)
  const spec = calls.opened[0]
  assert.equal(spec.name, DOMAIN_NAME)
  assert.match(spec.name, UNIT_NAME_RE)
  assert.equal(spec.version, 1)
  // 不声明 global：null 是介质的"从未写过"哨兵，多一个槽位只是多一个出错的地方。
  assert.equal(spec.global, undefined)
})

test('没有记录的会话默认是开', async () => {
  const { facility } = stubStorage()
  const state = await createSwitchState(ctxWith(facility), () => {})
  assert.equal(state.isEnabled('session-a'), true)
})

test('写下的开关能读回来，并且真的落进了介质', async () => {
  const { facility, records } = stubStorage()
  const state = await createSwitchState(ctxWith(facility), () => {})

  await state.setEnabled('session-a', false)
  assert.equal(state.isEnabled('session-a'), false)
  assert.deepEqual(records.get('session-a'), { enabled: false })

  await state.setEnabled('session-a', true)
  assert.equal(state.isEnabled('session-a'), true)
  // 总是写显式记录，不靠删除记录回到默认 —— 将来默认值若变化，这个会话不该跟着变。
  assert.deepEqual(records.get('session-a'), { enabled: true })
})

test('重启后已存的覆盖仍然生效（open 时从介质读出来）', async () => {
  const { facility } = stubStorage({ initial: { 'session-a': { enabled: false } } })
  const state = await createSwitchState(ctxWith(facility), () => {})
  assert.equal(state.isEnabled('session-a'), false)
  assert.equal(state.isEnabled('session-b'), true)
})

test('多个会话各自独立', async () => {
  const { facility } = stubStorage()
  const state = await createSwitchState(ctxWith(facility), () => {})
  await state.setEnabled('session-a', false)
  assert.equal(state.isEnabled('session-a'), false)
  assert.equal(state.isEnabled('session-b'), true)
})

test('schema 拒绝非对象、拒绝 enabled 不是布尔值', async () => {
  for (const bad of [{ enabled: 'yes' }, { enabled: 1 }, {}, [], null, 'false']) {
    const { facility } = stubStorage({ initial: { 'session-a': bad } })
    const warnings = []
    // 介质里存着一条不合法的记录 → 真实 domain 的 open 会抛 → 降级到内存并告警。
    const state = await createSwitchState(ctxWith(facility), (error) => warnings.push(error))
    assert.equal(warnings.length, 1, `记录 ${JSON.stringify(bad)} 应当让 open 失败`)
    assert.equal(state.isEnabled('session-a'), true)
  }
})

test('schema 规范化记录：多余的键不会跟着进内存', async () => {
  const { facility, records } = stubStorage({ initial: { 'session-a': { enabled: false, legacy: 'x' } } })
  await createSwitchState(ctxWith(facility), () => {})
  assert.deepEqual(records.get('session-a'), { enabled: false })
})

test('storageDomain 不可用时降级到内存并告警一次', async () => {
  const warnings = []
  const state = await createSwitchState(ctxWith(undefined), (error) => warnings.push(error))

  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0].message), /storageDomain/)
  // 降级之后行为一致，只是不持久。
  assert.equal(state.isEnabled('session-a'), true)
  await state.setEnabled('session-a', false)
  assert.equal(state.isEnabled('session-a'), false)
  await state.close()
})

test('domain 打不开时降级到内存并告警一次（不让插件加载失败）', async () => {
  const warnings = []
  const { facility } = stubStorage({ openError: new Error('backend-not-found') })
  const state = await createSwitchState(ctxWith(facility), (error) => warnings.push(error))

  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0].message), /backend-not-found/)
  await state.setEnabled('session-a', false)
  assert.equal(state.isEnabled('session-a'), false)
})

test('close 转交给 domain', async () => {
  const { facility, calls } = stubStorage()
  const state = await createSwitchState(ctxWith(facility), () => {})
  await state.close()
  assert.equal(calls.closed, 1)
})
