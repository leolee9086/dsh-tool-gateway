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
  assert.deepEqual(records.get('session-a'),
    { enabled: false, disabledTools: [], enabledTools: [], groups: {} })

  await state.setEnabled('session-a', true)
  assert.equal(state.isEnabled('session-a'), true)
  // 总是写显式记录，不靠删除记录回到默认 —— 将来默认值若变化，这个会话不该跟着变。
  assert.deepEqual(records.get('session-a'),
    { enabled: true, disabledTools: [], enabledTools: [], groups: {} })
})

test('工具开关：写下的关掉名单能读回来，并且与总开关互不干扰', async () => {
  const { facility, records } = stubStorage()
  const state = await createSwitchState(ctxWith(facility), () => {})

  assert.deepEqual([...state.prefs('session-a').disabledTools], [])

  await state.setToolDisabled('session-a', 'web_search_meta', true)
  assert.deepEqual([...state.prefs('session-a').disabledTools], ['web_search_meta'])
  assert.deepEqual(records.get('session-a'),
    { enabled: true, disabledTools: ['web_search_meta'], enabledTools: [], groups: {} })

  // 关掉工具之后再切总开关：工具名单要原样留着。两个偏好同一条记录，
  // 所以写任意一个都必须把另一个带上 —— 这正是它换来的一致性。
  await state.setEnabled('session-a', false)
  assert.equal(state.isEnabled('session-a'), false)
  assert.deepEqual([...state.prefs('session-a').disabledTools], ['web_search_meta'])

  await state.setToolDisabled('session-a', 'web_search_meta', false)
  assert.deepEqual([...state.prefs('session-a').disabledTools], [])
  assert.equal(state.isEnabled('session-a'), false, '打开一个工具不该顺手动到总开关')
})

test('工具开关是三态：关掉它是显式关，打开它是显式开，两边互斥', async () => {
  const { facility } = stubStorage()
  const state = await createSwitchState(ctxWith(facility), () => {})

  await state.setToolDisabled('session-a', 'read', true)
  assert.deepEqual([...state.prefs('session-a').disabledTools], ['read'])
  assert.deepEqual([...state.prefs('session-a').enabledTools], [])

  await state.setToolDisabled('session-a', 'read', false)
  const prefs = state.prefs('session-a')
  // 打开它不是「把关闭记录删掉」：那个工具可能属于一个默认关着的组，删掉记录等于
  // 把它交还给组的默认值，而用户要的是「打开它」。
  assert.deepEqual([...prefs.disabledTools], [])
  assert.deepEqual([...prefs.enabledTools], ['read'])
})

test('组覆盖只写一个键，且不动逐个开关过的名单', async () => {
  const { facility, records } = stubStorage()
  const state = await createSwitchState(ctxWith(facility), () => {})

  await state.setToolDisabled('session-a', 'siyuan_query', true)
  await state.setGroupEnabled('session-a', 'siyuan-http', true)

  const prefs = state.prefs('session-a')
  assert.equal(prefs.groups.get('siyuan-http'), true)
  assert.deepEqual([...prefs.disabledTools], ['siyuan_query'], '组开关不该动单工具的名单')
  assert.deepEqual(records.get('session-a').groups, { 'siyuan-http': true })
})

test('批量开关和单个开关写的是同一份记录', async () => {
  const { facility, records } = stubStorage()
  const state = await createSwitchState(ctxWith(facility), () => {})

  await state.setToolsDisabled('session-a', ['a', 'b', 'c'], true)
  assert.deepEqual([...state.prefs('session-a').disabledTools], ['a', 'b', 'c'])

  await state.setToolsDisabled('session-a', ['b'], false)
  const prefs = state.prefs('session-a')
  assert.deepEqual([...prefs.disabledTools], ['a', 'c'])
  assert.deepEqual([...prefs.enabledTools], ['b'])
  assert.equal(records.get('session-a').enabled, true, '批量开关不该动总开关')
})

test('加三态字段之前的旧记录仍然读得出来（向后兼容，不动 domain 版本）', async () => {
  const { facility } = stubStorage({ initial: { 'session-a': { enabled: false } } })
  const state = await createSwitchState(ctxWith(facility), () => {})
  assert.equal(state.isEnabled('session-a'), false)
  const prefs = state.prefs('session-a')
  assert.deepEqual([...prefs.disabledTools], [])
  assert.deepEqual([...prefs.enabledTools], [])
  assert.deepEqual([...prefs.groups], [])
})

test('domain 不可用时，工具开关同样降级到内存', async () => {
  const state = await createSwitchState(ctxWith(undefined), () => {})
  await state.setToolDisabled('session-a', 'read', true)
  assert.equal(state.prefs('session-a').disabledTools.has('read'), true)
  await state.setToolDisabled('session-a', 'read', false)
  const prefs = state.prefs('session-a')
  assert.equal(prefs.disabledTools.has('read'), false)
  assert.equal(prefs.enabledTools.has('read'), true)
  await state.setGroupEnabled('session-a', 'g', false)
  assert.equal(state.prefs('session-a').groups.get('g'), false)
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
  assert.deepEqual(records.get('session-a'),
    { enabled: false, disabledTools: [], enabledTools: [], groups: {} })
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

test('落盘有异步间隙时，并发写仍然不丢更新', async () => {
  // 面板上连着点两下就是两次「读当前记录 → 改一个字段 → 写回」。如果两次读到同一份
  // 旧记录，后写的那次会把先写的那次抹掉 —— 用户会看到自己刚打开的工具又关上了。
  // 这里把落盘的间隙放大，验证同一个会话的读-改-写确实是串行的。
  const records = new Map()
  const facility = {
    async open(spec) {
      const [, tableSpec] = Object.entries(spec.tables)[0]
      const schema = tableSpec.valueSchema
      return {
        table: () => ({
          get: (key) => records.get(key),
          put: async (key, value) => {
            await new Promise((resolve) => setTimeout(resolve, 1))
            records.set(key, schema.parse(value))
          },
        }),
        async close() {},
      }
    },
  }
  const state = await createSwitchState(ctxWith(facility), () => {})

  await Promise.all([
    state.setToolDisabled('session-a', 'read', true),
    state.setToolDisabled('session-a', 'write', true),
    state.setGroupEnabled('session-a', 'siyuan', false),
    state.setEnabled('session-a', false),
  ])

  const prefs = state.prefs('session-a')
  assert.deepEqual([...prefs.disabledTools].sort(), ['read', 'write'])
  assert.equal(prefs.groups.get('siyuan'), false)
  assert.equal(prefs.enabled, false, '总开关那一次也不该被别的写覆盖')
})

test('close 转交给 domain', async () => {
  const { facility, calls } = stubStorage()
  const state = await createSwitchState(ctxWith(facility), () => {})
  await state.close()
  assert.equal(calls.closed, 1)
})
