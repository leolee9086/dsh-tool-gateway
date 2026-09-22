/**
 * 归属会话换算的测试。
 *
 * 这一层决定了"开关记在哪个会话名下"，判据必须与 DSH 自己的
 * `subagent/src/list-children.ts` 一致：`origin === 'subagent'` **且**
 * `parentSession` 存在才算子代理 —— 只看 `parentSession` 会把 fork 出来的
 * 独立会话也算成子代理。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownerSessionId, parentLookup } from '../src/session-key.js'

/** 造一个会话：只填这一层真正会读的两个字段。 */
const sessionOf = (id, header = {}) => ({ id, header })

test('顶层会话的归属就是它自己', () => {
  assert.equal(ownerSessionId(sessionOf('s1', {}), () => undefined), 's1')
})

test('子代理会话跟随父会话', () => {
  const parent = sessionOf('p1', {})
  const child = sessionOf('c1', { origin: 'subagent', parentSession: 'p1' })
  assert.equal(ownerSessionId(child, (id) => (id === 'p1' ? parent : undefined)), 'p1')
})

test('多级子代理一路跟到顶层', () => {
  const root = sessionOf('r', {})
  const mid = sessionOf('m', { origin: 'subagent', parentSession: 'r' })
  const leaf = sessionOf('l', { origin: 'subagent', parentSession: 'm' })
  const byId = new Map([['r', root], ['m', mid]])
  assert.equal(ownerSessionId(leaf, (id) => byId.get(id)), 'r')
})

test('父会话不在内存里时停在已知的父 id 上，不继续往上猜', () => {
  const child = sessionOf('c1', { origin: 'subagent', parentSession: 'p1' })
  // 返回的 p1 是从子会话 header 里读出来的已知值，不是兜底默认值。
  assert.equal(ownerSessionId(child, () => undefined), 'p1')
})

test('只有 parentSession 没有 origin=subagent（fork 谱系）时不跟随', () => {
  const forked = sessionOf('f1', { parentSession: 'origin-session' })
  assert.equal(ownerSessionId(forked, () => { throw new Error('fork 的会话不该去查父') }), 'f1')
})

test('parentLookup 从 agents 服务取会话', () => {
  const parent = sessionOf('p1', {})
  const ctx = {
    get: (name) => (name === 'agents'
      ? { get: (id) => (id === 'p1' ? { session: parent } : undefined) }
      : undefined),
  }
  const lookup = parentLookup(ctx)
  assert.equal(lookup('p1'), parent)
  assert.equal(lookup('nope'), undefined)
})

test('agents 服务不可用时 parentLookup 返回 undefined（子代理换算会停在已知 id 上）', () => {
  assert.equal(parentLookup({ get: () => undefined })('p1'), undefined)
})
