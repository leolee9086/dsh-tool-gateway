/** 关闭目录查询只在有会话、普通文件模式及逐次审批策略下受理。 */
export function disabledQueryRoute({ hasSession, mode, policy, hasApproval }) {
  if (!hasSession) return '关闭工具查询需要当前会话。'
  if (mode === 'danger-full-access') return '完全文件权限下关闭工具查询不可用；请人在普通模式中逐次审批。'
  if (!['read-only', 'workspace-write'].includes(mode)) return '无法确认文件权限模式，关闭工具查询不可用。'
  if (!hasApproval || policy !== 'ask') return '关闭工具查询需要可用的逐次审批；当前审批策略不允许。'
  return undefined
}

/** 每次执行重新判定策略；审批只授权本次查看，不缓存也不改变工具开关。 */
export async function authorizeDisabledQuery(ctx, exec) {
  const agent = exec?.agent
  const approval = ctx.get('approval')
  const readRoute = () => disabledQueryRoute({
    hasSession: agent?.session !== undefined,
    mode: agent?.session === undefined ? undefined : ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode,
    policy: agent?.session === undefined ? undefined : approval?.overrideOf(agent.session) ?? approval?.config.policy ?? 'ask',
    hasApproval: typeof approval?.request === 'function',
  })
  const denial = readRoute()
  if (denial !== undefined) return denial
  if (exec.signal?.aborted) return '关闭工具查询已取消。'
  const outcome = await approval.request({ agent, toolName: 'find_tools', callId: exec.callId,
    reason: '查看当前会话关闭的工具名称与参数；不会开启工具，也不会改变业务授权。', signal: exec.signal })
  if (outcome !== 'allowed-once' || exec.signal?.aborted) return '关闭工具查询未获本次批准。'
  // 等待回答期间切换到完全权限或 never，也不能继续返回目录。
  return readRoute()
}
