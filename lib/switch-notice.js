/**
 * 开关变化时写给模型的那条通知。
 *
 * **为什么需要它**：开关是**会话中途**可以变的，而模型看不见装配这件事本身。
 * 用户在标题栏点一下，下一轮请求的工具表就换了一份 —— 没有这条通知，模型只能在
 * 「我明明刚用过 read、怎么现在调不了了」（或者反过来：「刚才还要先查，现在怎么都
 * 摆出来了」）的困惑里自己猜。
 *
 * 两者的分工：系统提示里那段说明回答的是「现在该怎么用」，这条通知回答的是「刚刚变了
 * 什么」。所以它们措辞不同 —— 通知是**事件**，说明是**状态**。
 *
 * **两种粒度都写在这里**：整个工具箱模式的开关（{@link createSwitchNotice}），与单个
 * 工具的开关（{@link createToolNotice}）。它们要说的是同一件事的两个层次 ——「接口换了
 * 形状」和「这一件工具没了」—— 而两者都是模型自己看不见的变化。
 *
 * **怎么送到模型眼前**：`agent.inject(message)`。它把消息排进下一次 pre-step，
 * 不唤醒 driver：用户点完开关、再发一条消息，模型就在同一次请求里看到它。
 * 这条路径是合规的 —— 注入的消息会作为 `user/message` 进会话日志，模型可见的东西
 * 因此仍然可以从日志重建。
 *
 * **消息的形状**与 meta-tools.js 里那条 deferContext 消息一样，是手工构造的普通对象：
 * `Message` 的形状加上 `role: 'user'`，`source` 由 producer-source.js 给出 —— **必须**是
 * 生产者拥有的 kind，理由写在那个模块的注释里（写错会让整轮在毫秒级失败且不留日志）。
 * 插件不能 import DSH 包，所以 DSH 自己的 `createUserMessage` 用不上 —— 它也就多做了
 * 两件事（补一个 uuid 当 id、深冻结），两件都不需要 import 才能做到。
 *
 * @module dsh-tool-gateway/switch-notice
 */
import { randomUUID } from 'node:crypto'
import { noticeSource } from './producer-source.js'

/**
 * 通知正文。
 *
 * @param {boolean} enabled 切换之后的状态
 * @returns {string} 给模型看的通知
 */
export function switchNoticeText(enabled) {
  if (enabled) {
    return [
      '## 工具箱模式：已开启',
      '',
      '本会话的工具入口刚刚变回两个元工具：`find_tools` 查、`call_tool` 调。',
      '',
      '你刚才还看得见的那些工具（read、write、bash 之类）现在不在工具表里了，',
      '**但它们仍然可用** —— 先 `find_tools` 查清楚名字与参数，再 `call_tool` 调用。',
      '直接输出其它工具名会被拒绝。',
    ].join('\n')
  }
  return [
    '## 工具箱模式：已关闭',
    '',
    '本会话现在暴露完整的工具表，你可以直接调用任何工具。',
    '',
    '`find_tools` 与 `call_tool` 仍然在，但它们不再是唯一入口。',
    '不确定某个工具的名字或参数时，用它们查一下仍然是最稳的做法。',
  ].join('\n')
}

/**
 * 面板开关一个工具时的通知正文。
 *
 * 与上面那条的分工一样：那条说的是「工具箱模式变了」，这条说的是「某一个工具变了」。
 * 关掉时要把替代做法写清楚 —— 否则模型会以为整个能力都没了，而不是「这次别用它」。
 *
 * @param {string} tool 工具名
 * @param {boolean} disabled true = 刚被关掉
 * @returns {string} 给模型看的通知
 */
export function toolNoticeText(tool, disabled) {
  if (disabled) {
    return [
      '## 工具已关闭：' + tool,
      '',
      '用户刚刚在右侧栏的工具箱面板里关掉了它。这一轮起，调用它会直接被拒绝，find_tools 里也不会再出现它。',
      '',
      '不要试图用别的途径绕过去（包括 call_tools 里的程序）。如果这件事非它不可，在正文里说清楚为什么，让用户去面板里打开它。',
    ].join('\n')
  }
  return [
    '## 工具已打开：' + tool,
    '',
    '用户刚刚在工具箱面板里把它打开了，现在可以正常调用，find_tools 也能查到它。',
  ].join('\n')
}

/**
 * 造「某个工具刚被开关」的通知消息。
 *
 * @param {string} tool 工具名
 * @param {boolean} disabled true = 刚被关掉
 * @returns {object} 可以直接交给 `agent.inject()` 的消息
 */
export function createToolNotice(tool, disabled) {
  return notice(toolNoticeText(tool, disabled), (disabled ? '工具已关闭：' : '工具已打开：') + tool)
}

/**
 * 造那条通知消息。
 *
 * @param {boolean} enabled 切换之后的状态
 * @returns {object} 可以直接交给 `agent.inject()` 的消息
 */
export function createSwitchNotice(enabled) {
  return notice(switchNoticeText(enabled), enabled ? '工具箱模式：已开启' : '工具箱模式：已关闭')
}

/**
 * 把一段正文包成一条通知消息。
 *
 * 每条通知用新的 uuid：会话日志里两条同 id 的消息会让下游的投影分不清是哪一条。
 * 重复堆积由调用方避免 —— 只有状态**真的变了**才通知（见 route.js）。
 *
 * @param {string} text 正文
 * @param {string} summary 一句话说明这条通知是什么（进来源标记，会随日志留下）
 * @returns {object} 消息
 */
function notice(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: noticeSource(summary),
  }
}
