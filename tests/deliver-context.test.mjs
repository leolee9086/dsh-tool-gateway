/**
 * `deliverContext` 的测试。
 *
 * 这个模块存在的唯一理由是：`exec.deferContext` 那条路实测不落地
 * （会话里从来没出现过 `agent/inbox/spliced`），所以要改走 `agent.inject`。
 * 测试盯的就是"优先 inject、失败退回 defer、两条都不通也不抛"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { deliverContext } from '../src/deliver-context.js'

/** 造一个 exec：能记下两条投递通道各自被调了什么。 */
function execStub({ withInject = true, withDefer = true, injectThrows = false, deferThrows = false } = {}) {
  const injected = []
  const deferred = []
  const exec = {}
  if (withInject) {
    exec.agent = {
      inject(message) {
        if (injectThrows) throw new Error('inject 不通')
        injected.push(message)
      },
    }
  }
  if (withDefer) {
    exec.deferContext = (message) => {
      if (deferThrows) throw new Error('defer 不通')
      deferred.push(message)
    }
  }
  return { exec, injected, deferred }
}

const message = () => ({ id: 'm1', role: 'user', content: [{ type: 'image' }], source: { kind: 'plugin:dsh-tool-gateway' } })

test('优先走 inject —— 那是实测能落地的通道', () => {
  const { exec, injected, deferred } = execStub()
  const context = message()

  assert.equal(deliverContext(exec, context), true)
  assert.deepEqual(injected, [context])
  assert.deepEqual(deferred, [], 'inject 通了就不该再 defer，否则图会来两次')
})

test('inject 抛错时退回 deferContext', () => {
  const { exec, injected, deferred } = execStub({ injectThrows: true })
  const context = message()

  assert.equal(deliverContext(exec, context), true)
  assert.deepEqual(injected, [])
  assert.deepEqual(deferred, [context])
})

test('没有 agent 时直接走 deferContext（诊断装配、插件自己发起的调用都是这种）', () => {
  const { exec, deferred } = execStub({ withInject: false })
  const context = message()

  assert.equal(deliverContext(exec, context), true)
  assert.deepEqual(deferred, [context])
})

test('两条通道都没有时返回 false，而且不抛', () => {
  const { exec } = execStub({ withInject: false, withDefer: false })
  assert.equal(deliverContext(exec, message()), false)
})

test('两条通道都抛错时返回 false —— 丢一张图不该让工具调用失败', () => {
  const { exec } = execStub({ injectThrows: true, deferThrows: true })
  assert.equal(deliverContext(exec, message()), false)
})

test('没有内容可送时返回 false，连通道都不碰', () => {
  const { exec, injected, deferred } = execStub()
  assert.equal(deliverContext(exec, undefined), false)
  assert.equal(deliverContext(exec, null), false)
  assert.deepEqual(injected, [])
  assert.deepEqual(deferred, [])
})

test('exec 本身是 undefined 也不炸（调用方可能是诊断路径）', () => {
  assert.equal(deliverContext(undefined, message()), false)
})
