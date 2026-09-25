/**
 * 网关层：把模型可见的工具目录收成两个元工具，并把模型对其余工具的直接调用挡回去。
 *
 * **两层，缺一不可：**
 *
 * 1. **可见性** —— `system-prompt/assemble` 瀑布里过滤 `assembled.tools`。
 *    模型看到的工具清单就是这个瀑布的产物，过滤它一个字节都不碰注册表。
 * 2. **执行** —— `ctx.tools.guard` 单调守卫，拒绝模型对非元工具的直接调用。
 *
 * 为什么两层都要：注册表**没有**被改动，而 `resolveExecution` 走的是 `visible` ——
 * 模型只要从历史里记得某个工具名、或者猜中一个，直接调用就会**成功**。
 * 只过滤目录管不住这件事，那才是安全边界。
 *
 * 守卫的放行条件是"子分发"（`execution.parent !== undefined`）而不是"名字在
 * 白名单里"：call_tool 内部发起的调用带着 parent，模型直接发起的没有。
 * 这与 DSH 自己 PTC 模式的塌缩是同一种机制 —— 限制调用**路径**，不限制可见性。
 * （证据：`core/tools/src/index.ts:1387` 的 `collapses(name, agent, parent !== undefined)`，
 * 而且它发生在 pre-execute 之前。）
 *
 * **这是行为约束，不是省 token。** 目的不是让工具表变短，而是让 agent 养成
 * "每一次都先去工具箱里挑合适的工具"的习惯 —— 工具一多，真正的挑战从来不是
 * 上下文长度，而是模型会不会只盯着被截断的那一小段列表将就。
 *
 * **按会话生效。** 每个安装函数都收一个 `enabledFor(agent)` 回调：它回答"这个会话
 * 要不要施加约束"。开关状态、归属会话换算都在 host.js 里接起来，这一层不认识它们。
 * 三个函数用的 agent 来源不同，但都是 DSH 自己就在用的那一个：
 * - 可见性：`AssembleContext.agent`（`core/agent/src/runtime-types.ts:19`）
 * - 执行：`ToolExecution.agent`（`core/tools/src/index.ts:322`，DSH 自己拿它做作用域分发）
 * - 提示段落：`AssembleContext.agent`
 *
 * **守卫上现在有两段判断，顺序是有意义的：**先判硬禁用名单（`banFor`，来自 ban.js ——
 * 静态名单加会话级关掉的工具），再判网关规则。硬禁用不看 `parent`，所以它连 `call_tool`
 * 的子分发也拦得住；网关规则对子分发放行。这两段曾经分属两个插件，合并的理由见 ban.js。
 */
import { CALL_TOOLS } from './code-tools.js'

/** 提示段落的位置：排在 persona(0) 与各工具说明(1000+) 之间，让模型先读到规则。 */
const NOTICE_ORDER = 700

/**
 * 守卫拒绝时写给模型的理由。它会被模型读到，所以写"接下来该怎么办"，不是错误码。
 *
 * 按这个会话**实际可用**的元工具生成：PTC 开着时没有 `call_tools`，理由里提它
 * 只会把模型引向一个不存在的工具。
 *
 * @param {Set<string>} keep 这个会话可直接调用的元工具名
 * @returns {string} 拒绝理由
 */
export function denyReason(keep) {
  const list = [...keep].map((name) => `\`${name}\``).join(' 与 ')
  return `工具调用方式已改变：本会话只暴露 ${list}。`
    + '先用 find_tools 查清楚有哪些工具、参数是什么，再用 call_tool 调用。'
    + '不要直接输出其它工具名 —— 它们不在当前的工具表里。'
}

/**
 * 提示段落正文。对所有开启网关的会话一视同仁 —— 不分新老、不扫会话事件、不判断阶段。
 *
 * 它对全新会话同样有用（本来就是使用说明），对跑过一段的会话则额外回答了
 * "我用过的 read 去哪了"。分档看着更贴心，但要扫全部会话事件、按 session
 * 缓存阶段、在会话中途换提示，每一步都在碰历史，换来的只是老会话多看一段话。
 *
 * 唯一随会话变的是**元工具清单**：PTC 开着时没有 `call_tools`，那段就不能提它。
 *
 * @param {Set<string>} keep 这个会话可直接调用的元工具名
 * @returns {string} 段落正文
 */
export function noticeText(keep) {
  const lines = [
    '## 工具调用方式',
    '',
    `本会话只暴露 ${keep.size} 个工具：`,
    '',
    '- `find_tools` —— 按名字、描述、中文或拼音检索工具，返回完整参数 schema',
    '- `call_tool`  —— 调用工具，参数 `{tool_name, arguments}`',
  ]
  if (keep.has(CALL_TOOLS)) {
    lines.push('- `call_tools` —— 写一段程序批量调用工具；中间结果不进对话，只有程序返回的值回来')
  }
  lines.push(
    '',
    '这个部署里还有文件读写、命令执行、网页搜索、子代理、后台任务、图像、浏览器与桌面操作等能力。',
    '它们都在，只是入口变了：**先 find_tools 查，再 call_tool 调**。',
    '',
    '**每一次动手之前都先查清楚。** 不要凭印象挑一个名字最像的工具就用：工具很多，名字相近的',
    '不止一个，参数也各不相同。先查清楚有什么、再决定用哪个，比记住几个常用名字可靠得多。',
    '',
    '历史记录里你可能直接调用过 `read`、`write`、`bash` 之类的工具。那些工具仍然可用，',
    '但不要直接输出历史里出现过的工具名 —— 它们不在当前的工具表里，直接调用会被拒绝。',
  )
  return lines.join('\n')
}

/**
 * 注册可见性过滤。
 *
 * @param {object} ctx 插件上下文
 * @param {(agent: object|undefined) => Set<string>} keepFor 这个 agent 现在能直接调用的
 *   元工具名。它是**回调而不是集合**：集合里的内容随会话变（PTC 开着时少一个），
 *   而“为什么少一个”是接线层的知识，这一层不该知道
 * @param {(agent: object|undefined) => boolean} enabledFor 这个 agent 的会话要不要施加约束
 * @param {(error: unknown) => void} warnOnce 降级时的告警回调
 * @returns {void}
 */
export function installAssembleFilter(ctx, keepFor, enabledFor, warnOnce) {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // 瀑布语义：必须先 await next() 拿到下游产物，再改它。
    // 不调 next() 会截断整条链，别处的提示词贡献就全丢了。
    const assembled = await next()
    try {
      // 这个会话把网关关了：原样返回，一个字节都不动。
      if (!enabledFor(context?.agent)) return assembled

      const keep = keepFor(context?.agent)
      const tools = Array.isArray(assembled?.tools) ? assembled.tools : []
      const kept = tools.filter((tool) => keep.has(tool?.name))
      // 一个都没留下说明元工具还没注册上（挂载时序），这时暴露完整目录：
      // 工具多一点只是浪费，会话起不来是事故。
      if (kept.length === 0) {
        warnOnce(new Error(`没有匹配到任何白名单工具（期望 ${[...keep].join(', ')}），本轮暴露完整目录`))
        return assembled
      }
      return { ...assembled, tools: kept }
    } catch (error) {
      // 过滤逻辑自身出错（包括开关状态读不出来）也走降级，理由同上。
      warnOnce(error)
      return assembled
    }
  })
}

/**
 * 注册执行守卫。
 *
 * 守卫注册在根作用域，对所有 agent 生效；而且是**单调**的 ——
 * 返回拒绝理由之后，别的监听器改不回允许。
 *
 * @param {object} ctx 插件上下文
 * @param {(agent: object|undefined) => Set<string>} keepFor 这个 agent 现在能直接调用的
 *   元工具名（理由同 {@link installAssembleFilter}）
 * @param {(agent: object|undefined) => boolean} enabledFor 这个 agent 的会话要不要施加约束
 * @param {(execution: object) => string|undefined} banFor 硬禁用判定：静态名单，加上用户在
 *   面板里按会话关掉的工具。它**先于**其它判据执行，返回值就是拒绝理由
 * @returns {void}
 */
export function installGuard(ctx, keepFor, enabledFor, banFor) {
  ctx.effect(
    () => ctx.tools.guard((execution) => {
      // 硬禁用排在最前，而且**先于**子分发那一条。禁用的语义是「任何路径都不许」，
      // 所以它连 call_tool 的子分发也拦 —— 这正是「禁用」与「没让它露面」的区别：
      // 没露面只挡住模型直接调用，禁用挡住一切路径。
      const banned = typeof banFor === 'function' ? banFor(execution) : undefined
      if (banned !== undefined) return banned
      // 子分发（call_tool / call_tools 内部发起的调用）永远放行，而且先于其它两条判。
      // 两个理由：它不是模型直接调用；它也是这条路上最频繁的一类，而它既不需要读开关、
      // 也不需要算元工具清单。
      if (execution?.parent !== undefined) return undefined
      // 这个会话把网关关了：不拦，模型可以直接调。
      if (!enabledFor(execution?.agent)) return undefined

      const name = execution?.name
      const keep = keepFor(execution?.agent)
      // 元工具在任何情况下都放行 —— 包括开关关掉的会话（它们只是不再是唯一入口）。
      if (typeof name === 'string' && keep.has(name)) return undefined
      return denyReason(keep)
    }),
    'dsh-tool-gateway: 执行守卫',
  )
}

/**
 * 注册提示段落。段落注册同样是 effect，随插件卸载一起撤销。
 *
 * `text` 传函数而不是字符串：段落每次装配都会重新求值，于是同一个注册
 * 对不同会话给出不同内容。关掉的会话返回空串 —— 空文本不贡献任何东西，
 * 不会在系统提示里留下一个空标题。
 *
 * 这里**不能**用 `systemPrompt.change()` 通知开关变化：那是"注册集变了"的信号，
 * 会让所有会话重装配，而开关只影响一个会话。
 *
 * @param {object} ctx 插件上下文
 * @param {(agent: object|undefined) => Set<string>} keepFor 这个 agent 现在能直接调用的
 *   元工具名（段落正文要按它列清单）
 * @param {(agent: object|undefined) => boolean} enabledFor 这个 agent 的会话要不要施加约束
 * @returns {void}
 */
export function installNotice(ctx, keepFor, enabledFor) {
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'tool-gateway',
      order: NOTICE_ORDER,
      text: (context) => (enabledFor(context?.agent) ? noticeText(keepFor(context?.agent)) : ''),
    }),
    'dsh-tool-gateway: 工具调用方式说明',
  )
}
