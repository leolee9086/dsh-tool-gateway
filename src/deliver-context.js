/**
 * 把一次子调用带回来的**非文本内容**（图片等）送到模型眼前。
 *
 * ## 为什么不能只靠 `exec.deferContext`
 *
 * 那条路的设计是：defer 进去的上下文并进本次结果的 `additionalContexts`，
 * 由 agent loop 暂存进"下一步的 inbox"，再以 `agent/inbox/spliced` 事件 splice 进会话
 * （`packages/core/agent-loop/src/inbox.ts:235`）。
 *
 * **实测（2026-09-25）：它一次都没落地。** 会话里从来没有出现过 `agent/inbox/spliced`；
 * 工具返回的图全部只留在 `tool/ptc-dispatch` 那条 `log-only` 的审计记录里，
 * 模型永远看不到。诊断过程记在 `D:\dev\.notes\2026-09-25-工具返回的图看不到-诊断.md`。
 *
 * ## 所以改用 inject
 *
 * `agent.inject(message)` 是**已经被证明能落地**的那条路：工具箱开关的通知走的就是它，
 * 那些消息确实作为 `user/message` 进了会话、也确实到了模型眼前。
 *
 * 策略：**先 inject，不成就退回 deferContext**。两条都不通时什么也不做 ——
 * 丢一张图不该让工具调用本身失败。
 *
 * @module dsh-tool-gateway/deliver-context
 */

/**
 * 送出一条非文本上下文。
 *
 * @param {object} exec 工具执行上下文（`ToolRunContext`），`call_tool` / `call_tools` 的那一次
 * @param {object|undefined} context 要送出的 user 消息（`splitOutcome` 拼好的那条）
 * @returns {boolean} 是否送出去了（用于自检与测试断言，调用方不需要分支）
 */
export function deliverContext(exec, context) {
  if (context === undefined || context === null) return false

  const agent = exec?.agent
  if (agent !== undefined && agent !== null && typeof agent.inject === 'function') {
    try {
      agent.inject(context)
      return true
    } catch {
      // 落回 deferContext：某些装配下它可能反而是通的，不值得在这里断言它一定坏。
    }
  }

  if (typeof exec?.deferContext === 'function') {
    try {
      exec.deferContext(context)
      return true
    } catch {
      // 见上：两条都不通就丢掉这张图，不让工具调用失败。
    }
  }

  return false
}
