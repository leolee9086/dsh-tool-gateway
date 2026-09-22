/**
 * 归属会话：一个 agent 的开关状态记在哪个会话名下。
 *
 * **为什么需要这一层**：网关的开关是"会话级"的，但一个会话可以派生出子代理会话
 * （subagent），子代理自己也是一个 agent、也有自己的 sessionId。用户看得见的只有父会话，
 * 他不会（也没法）去点子代理的开关；而子代理的工具组合本来就是从父那里继承的
 * （`applyChildComposition` → `agentPresets.composeFrom(childCtx, parent.ctx)`）。
 * 开关既然管的是"这套工具怎么用"，就必须跟着一起继承。
 *
 * **判据**（与 DSH 自己的 `subagent/src/list-children.ts` 一致）：
 * `header.origin === 'subagent'` **且** `header.parentSession !== undefined` 才算子代理。
 * 只看 `parentSession` 不够 —— 它也用于 fork 谱系（`core/session/src/types.ts:106`），
 * fork 出来的会话是独立会话，不该跟随父。
 *
 * **为什么要循环**：子代理可以有子代理（`header.delegationDepth` 记录了深度）。
 * DSH 自己在 `subagent/src/continuation-activation.ts` 里也是这么逐级往上走的。
 *
 * @param {object} session 一个 Session（有 `id` 和 `header`）
 * @param {(sessionId: string) => object|undefined} lookupParent 按 id 找父 Session；找不到返回 undefined
 * @returns {string} 归属会话 id（顶层会话就是它自己）
 */
export function ownerSessionId(session, lookupParent) {
  let header = session.header
  let id = session.id

  while (header.origin === 'subagent' && header.parentSession !== undefined) {
    id = header.parentSession
    const parent = lookupParent(id)
    // 父会话不在内存里（进程重启后没被 resume、或者已经被回收）：停在这里。
    // 这不是"兜底默认值" —— 返回的 id 是从子会话 header 里读出来的**已知**的父 id，
    // 是权威的，只是我们没法再往上确认它自己是不是子代理了。
    if (parent === undefined) break
    header = parent.header
  }

  return id
}

/**
 * 造一个宿主侧用的 `lookupParent`。
 *
 * `agents` 服务（`ctx.get('agents')`）只在内存里持有**活着**的 agent，冷会话查不到 ——
 * 这正是 `ownerSessionId` 里那个 break 存在的原因。
 *
 * @param {object} ctx 插件上下文
 * @returns {(sessionId: string) => object|undefined} 查父 Session 的函数
 */
export function parentLookup(ctx) {
  return (sessionId) => ctx.get('agents')?.get(sessionId)?.session
}
