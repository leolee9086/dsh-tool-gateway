import test from 'node:test'
import assert from 'node:assert/strict'
import { disabledQueryRoute } from '../src/disabled-query.js'

test('普通文件模式仅在有会话和逐次审批时进入请求', () => {
  for (const mode of ['read-only', 'workspace-write']) {
    assert.equal(disabledQueryRoute({ hasSession: true, mode, policy: 'ask', hasApproval: true }), undefined)
  }
})

test('完全权限、无人审批、没有会话及未知模式均拒绝关闭目录查询', () => {
  const allowed = { hasSession: true, mode: 'workspace-write', policy: 'ask', hasApproval: true }
  for (const patch of [{ mode: 'danger-full-access' }, { policy: 'never' }, { hasSession: false }, { hasApproval: false }, { mode: undefined }]) {
    assert.equal(typeof disabledQueryRoute({ ...allowed, ...patch }), 'string')
  }
})
