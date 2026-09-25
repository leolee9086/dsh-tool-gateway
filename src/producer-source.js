/**
 * 本插件在 V4 会话里的消息源归属。
 *
 * **V4 起消息源由生产者拥有。** 退役的 `{ kind: 'plugin', plugin }` 包装会被会话准入
 * 直接拒绝：
 *
 *     SessionFormatError: format v4 message requires a producer-owned source kind
 *
 * 这个坑的现场很隐蔽：那一轮在**毫秒级**失败、错误码是 UNKNOWN、**会话日志一个字节都
 * 不写**（被拒的那一行根本没落盘，文件 mtime 冻在失败那一刻），重试每次死在同一处。
 * 看到这个组合先查 source 的 kind，别先去怀疑模型、网络或者自己的业务逻辑 ——
 * 那几毫秒里请求根本没出网。
 *
 * **发出的 kind 与迁移结果逐字相同。** V3→V4 迁移表给未知生产者加 `plugin:` 前缀；
 * 这里照同一形式发，读取侧就只有一套判据：迁移前后的事件都认得出。
 *
 * 判据源码：`packages/session/session-format-v3-to-v4/src/message-sources.ts` 的
 * `source()` 与 `assertV4SourceRowAdmission()` —— 只拒 `kind === 'plugin'` 与空 kind，
 * 其它任何非空 kind 都原样保留（所以第三方插件有位置写自己的名字）。
 *
 * @module dsh-tool-gateway/producer-source
 */

/** 本插件在会话里的生产者名。 */
export const PRODUCER = 'dsh-tool-gateway'

/**
 * 本插件发出的 kind。
 *
 * 只在这里拼一次：两个发出点（开关通知、工具结果的补充上下文）必须给出**同一个** kind，
 * 否则读取侧要认两种写法。
 */
export const PRODUCER_KIND = `plugin:${PRODUCER}`

/**
 * 造一个「通知」形态的来源标记。
 *
 * `form` / `summary` 是给人看的形态说明，会随消息一起进会话日志 —— 判断"这条合成消息
 * 是谁、为什么写进来的"时只看这两个字段，不用去猜正文。
 *
 * @param {string} summary 一句话说明这条通知是什么
 * @returns {{kind: string, form: string, summary: string}} 可以直接放进消息 `source` 的对象
 */
export function noticeSource(summary) {
  return { kind: PRODUCER_KIND, form: 'notice', summary }
}
