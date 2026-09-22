/**
 * 开关通知的测试。
 *
 * 这个模块只有两件事可错：**文案说错了话**、**消息形状不对**。
 *
 * 文案为什么要测：它是模型唯一能看到的"刚刚变了什么"。开启时如果不告诉模型
 * "那些工具仍然可用、只是要先查再调"，模型就会以为工具被删了而放弃；关闭时
 * 如果不提"元工具还在"，模型会白丢一条稳当的查询路径。所以断言不写成整段相等
 * （那样改一个标点就红），而是只钉住**必须出现的那几个信息点**。
 *
 * 形状为什么要测：`agent.inject()` 收的是消息对象，字段错了不会当场报错，
 * 而是等到写进会话日志、或者下游投影时才出问题。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwitchNotice, switchNoticeText } from '../src/switch-notice.js'

/** uuid v4 的粗匹配：只看形状，不校验版本位。 */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

test('开启文案：说明两个元工具还在，且直接输出别的工具名会被拒', () => {
  const text = switchNoticeText(true)
  assert.match(text, /工具箱模式：已开启/)
  // 模型必须知道**入口是什么**，否则它只能瞎猜工具名。
  assert.match(text, /find_tools/)
  assert.match(text, /call_tool/)
  // 这一句是关键：不说清楚的话，模型会以为那些工具被删了。
  assert.match(text, /仍然可用/)
  assert.match(text, /会被拒绝/)
})

test('关闭文案：说明完整工具表回来了，但元工具仍然在', () => {
  const text = switchNoticeText(false)
  assert.match(text, /工具箱模式：已关闭/)
  assert.match(text, /完整的工具表/)
  assert.match(text, /仍然在/)
})

test('两段文案不同：通知说的是"刚变了什么"，不是笼统的一句话', () => {
  assert.notEqual(switchNoticeText(true), switchNoticeText(false))
  // 开启文案不该出现"已关闭"，反之亦然 —— 不然模型会读反。
  assert.doesNotMatch(switchNoticeText(true), /已关闭/)
  assert.doesNotMatch(switchNoticeText(false), /已开启/)
})

test('消息形状：user 角色 + text 块 + plugin 来源', () => {
  const message = createSwitchNotice(true)
  assert.match(message.id, UUID_LIKE)
  // 必须是 user：这条消息要作为 user/message 进会话日志，
  // 模型可见的东西因此仍然可以从日志重建。
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: switchNoticeText(true) }])
  assert.deepEqual(message.source, { kind: 'plugin', plugin: 'dsh-tool-gateway' })
})

test('每条通知一个新的 id：同 id 的两条消息会让下游投影分不清', () => {
  assert.notEqual(createSwitchNotice(true).id, createSwitchNotice(true).id)
})

test('开关两种状态各自映射到对应的文案', () => {
  assert.equal(createSwitchNotice(true).content[0].text, switchNoticeText(true))
  assert.equal(createSwitchNotice(false).content[0].text, switchNoticeText(false))
})
