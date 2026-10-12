/** 工具目录输出预算。计量由宿主注入，算法不依赖会话或 DSH 上下文。 */
export const DEFAULT_RESULT_TOKEN_BUDGET = 10_000

export function resultTokenBudget(value = DEFAULT_RESULT_TOKEN_BUDGET) {
  if (!Number.isSafeInteger(value) || value < 256 || value > 1_000_000) {
    throw new Error('search.resultTokenBudget 必须是 256 到 1000000 的整数')
  }
  return value
}

/**
 * entries 是稳定排序的 { name, text }，text 是请求的完整档位。
 * 先压缩尾部详情，所有条目均只剩名字后才删尾部条目；不切割 Schema。
 * offset 是候选集位置，返回 nextOffset 可继续同一查询。
 */
export function fitSearchResults({ entries, header, footer = '', offset = 0, budget, measure }) {
  budget = resultTokenBudget(budget)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须是非负整数')
  const remaining = entries.slice(offset)
  const names = remaining.map(entry => '- ' + entry.name)
  const texts = remaining.map(entry => entry.text)
  const render = (shown, detailed) => {
    const folded = remaining.slice(0, shown).reduce((sum, entry, i) => sum + (i >= detailed && entry.text !== names[i] ? 1 : 0), 0)
    const omitted = remaining.length - shown
    const status = `计量：宿主 token 估算；预算 ${budget}。折叠 ${folded} 项，截断 ${omitted} 项。`
    const next = omitted > 0 ? `继续同一查询：offset=${offset + shown}；目录变化后从 offset=0 重查。` : ''
    const hint = folded > 0 ? '仅名字项未包含参数 Schema；按 names 精确查询详情，必要时调低 detail 或由人调整预算。' : ''
    return [header, ...texts.slice(0, detailed), ...names.slice(detailed, shown), footer, status, hint, next].filter(Boolean).join('\n')
  }
  const fits = text => {
    const count = measure(text)
    if (!Number.isFinite(count) || count < 0) throw new Error('tokenMeter 返回无效的估算值')
    return count <= budget
  }
  let shown = remaining.length
  let detailed = shown
  if (!fits(render(shown, detailed))) {
    detailed = 0
    if (fits(render(shown, 0))) {
      // 完整输出逐次复核；二分只选择可保留的前部详情，不按字符切割。
      let low = 0, high = shown
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (fits(render(shown, middle))) low = middle
        else high = middle - 1
      }
      detailed = low
    } else {
      let low = 0, high = shown
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (fits(render(middle, 0))) low = middle
        else high = middle - 1
      }
      shown = low
    }
  }
  const text = render(shown, detailed)
  if (!fits(text) || (remaining.length > 0 && shown === 0)) {
    // 不能提供同 offset 的无进展分页；把过长标题/名字也纳入这一边界。
    const minimal = '结果或单个工具名超过预算，请缩小查询或由人提高 search.resultTokenBudget。'
    if (!fits(minimal)) throw new Error('搜索预算不足以容纳最小结果说明')
    return { text: minimal, shown: 0, nextOffset: undefined }
  }
  return { text, shown, nextOffset: shown < remaining.length ? offset + shown : undefined }
}
