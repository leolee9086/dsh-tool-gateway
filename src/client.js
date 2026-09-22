/**
 * dsh-tool-gateway 的浏览器半边：会话标题栏里的那个开关。
 *
 * **为什么是这个形式**：客户端文件被 web server **原样下发**，浏览器拿到就执行，
 * 所以它必须是自注册的 `window.__ModuleLoader__.load({id, factory})`，不能写 ESM export。
 * 也因此这里手写 React.createElement，不用 JSX、不经过任何打包器 —— 构建脚本对
 * 这个文件只做语法校验（`new vm.Script`），逐字节拷进 lib/。
 *
 * **它只做两件事**：显示当前会话的开关状态、把点击变成一次 POST。权威状态在宿主侧
 * （见 src/route.js 与 src/switch-state.js），这里不缓存、不推断、不乐观更新。
 *
 * **插槽**：`conversation.session.header.actions`（list / session 作用域），
 * 标准 props 里带 `sessionId`。同一个槽位上已经有 agent-preset、job-list、
 * context-limit、agent-team 等入口，各自用自己的 id，互不覆盖。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tool-gateway',
  factory: (require) => {
    const React = require('react')

    /** 需要的两个服务：插槽用来挂载，locale 用来出文案。 */
    const inject = ['slots', 'locale']

    /** 与宿主侧 src/route.js 里的 ROUTE 必须一致。 */
    const ROUTE = '/api/tool-gateway'

    /** 注入的样式表用固定 id，重复挂载不会注入第二份。 */
    const STYLE_ID = 'dsh-tool-gateway-style'

    /** 文案命名空间。 */
    const NS = 'dsh-tool-gateway'

    const dictionaries = {
      zh: {
        on: '工具箱 开',
        off: '工具箱 关',
        busy: '切换中…',
        unknown: '工具箱 ?',
        retry: '工具箱 · 重试',
        hintOn: '本会话的工具收在两个元工具里：先 find_tools 查，再 call_tool 调。点击关闭，让模型直接用完整工具表。',
        hintOff: '本会话暴露完整工具表。点击开启约束：模型每次动手前先 find_tools 查、再 call_tool 调。',
        hintUnknown: '还没读到这个会话的开关状态。点击重试。',
      },
      en: {
        on: 'Toolbox on',
        off: 'Toolbox off',
        busy: 'Switching…',
        unknown: 'Toolbox ?',
        retry: 'Toolbox · retry',
        hintOn: 'This session routes tools through find_tools + call_tool. Click to expose the full tool list instead.',
        hintOff: 'This session exposes the full tool list. Click to require find_tools before every call.',
        hintUnknown: 'The switch state for this session has not loaded yet. Click to retry.',
      },
    }

    /**
     * 注入样式表。
     *
     * 颜色一律走 `--dsw-alias-*` 主题变量（`packages/client/ui-theme/src/styles/design-platform.css`
     * 里定义的那一套），并带上浅色主题的兜底值，深色主题下由变量自己接管。
     * 不写死颜色，也不碰 body / 全局选择器。
     */
    function installStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dsh-tool-gateway-chip{appearance:none;display:inline-flex;align-items:center;gap:6px;
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  background:transparent;color:var(--dsw-alias-label-secondary, #666);
  border-radius:999px;padding:3px 10px;font-size:12px;line-height:16px;
  font-family:inherit;cursor:pointer;white-space:nowrap;transition:border-color .15s,color .15s}
.dsh-tool-gateway-chip:hover:not(:disabled){border-color:var(--dsw-alias-border-l4, rgba(0,0,0,.16));
  color:var(--dsw-alias-label-primary, #111)}
.dsh-tool-gateway-chip:disabled{cursor:default;opacity:.6}
.dsh-tool-gateway-dot{width:7px;height:7px;border-radius:50%;flex:none;
  background:var(--dsw-alias-state-success-primary, #22c55e)}
.dsh-tool-gateway-chip[data-enabled="false"] .dsh-tool-gateway-dot{
  background:var(--dsw-alias-label-secondary, #999)}
.dsh-tool-gateway-chip[data-error="true"]{color:var(--dsw-alias-state-error-primary, #ef4444)}
`
      document.head.appendChild(style)
    }

    /**
     * 把一次失败翻译成一句人话。宿主的错误体里有 `error`（具体原因），
     * 状态码用来兜住没有 body 的情况（比如 401/403）。
     *
     * @param {object} body 宿主返回的 JSON（可能为空对象）
     * @param {number} status HTTP 状态码
     * @returns {string} 给用户看的失败原因
     */
    function failureText(body, status) {
      if (status === 401 || status === 403) return '登录已失效，请刷新页面'
      if (typeof body?.error === 'string' && body.error.length > 0) return body.error
      return `请求失败（HTTP ${status}）`
    }

    /**
     * 会话标题栏里的开关。
     *
     * 三种状态，各自有明确的呈现：未知（还没读到）、已知（开/关）、失败（可重试）。
     * 切换中按钮禁用并标 `aria-busy`，避免连点产生竞态。
     *
     * @param {object} props 插槽 props（含标准 props 里的 `sessionId`，以及 locale 的 `t`）
     * @returns {object} React 元素
     */
    function GatewayChip({ sessionId, t }) {
      const [enabled, setEnabled] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      // 会话切换时作废旧请求的回调：一个 chip 组件实例可能先后显示多个会话。
      const generation = React.useRef(0)

      const load = React.useCallback(async () => {
        if (!sessionId) return
        const mine = ++generation.current
        const controller = new AbortController()
        try {
          const response = await fetch(`${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
            credentials: 'same-origin',
            signal: controller.signal,
          })
          const body = await response.json().catch(() => ({}))
          if (generation.current !== mine) return
          if (!response.ok || body?.ok !== true) throw new Error(failureText(body, response.status))
          setEnabled(body.enabled === true)
          setError(null)
        } catch (reason) {
          if (generation.current !== mine) return
          if (reason?.name === 'AbortError') return
          setError(String(reason?.message ?? reason))
        }
        return () => { controller.abort() }
      }, [sessionId])

      // 挂载和换会话时读一次。返回值是清理函数，组件卸载时取消在途请求。
      React.useEffect(() => {
        let dispose
        void load().then((cleanup) => { dispose = cleanup })
        return () => {
          generation.current += 1
          if (typeof dispose === 'function') dispose()
        }
      }, [load])

      const toggle = async () => {
        if (!sessionId || busy) return
        // 失败状态下点击是"重试读取"，不是"切换"—— 状态未知时切换没有意义。
        if (error !== null) { void load(); return }
        const mine = generation.current
        const next = !(enabled === true)
        setBusy(true)
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, enabled: next }),
          })
          const body = await response.json().catch(() => ({}))
          if (generation.current !== mine) return
          if (!response.ok || body?.ok !== true) throw new Error(failureText(body, response.status))
          setEnabled(body.enabled === true)
          setError(null)
        } catch (reason) {
          if (generation.current !== mine) return
          setError(String(reason?.message ?? reason))
        } finally {
          if (generation.current === mine) setBusy(false)
        }
      }

      const state = error !== null ? 'error' : enabled === null ? 'unknown' : enabled ? 'on' : 'off'
      const label = busy ? t('busy') : error !== null ? t('retry') : enabled === null ? t('unknown') : enabled ? t('on') : t('off')
      const hint = error !== null ? error : enabled === null ? t('hintUnknown') : enabled ? t('hintOn') : t('hintOff')

      return React.createElement('button', {
        type: 'button',
        className: 'dsh-tool-gateway-chip',
        'data-tool-gateway': state,
        'data-enabled': String(enabled === true),
        'data-error': String(error !== null),
        'aria-busy': busy ? 'true' : 'false',
        'aria-pressed': enabled === true ? 'true' : 'false',
        disabled: busy,
        title: hint,
        onClick: () => { void toggle() },
      },
      React.createElement('span', { className: 'dsh-tool-gateway-dot', 'aria-hidden': 'true' }),
      React.createElement('span', null, label))
    }

    function apply(ctx) {
      // 样式和文案都随插件卸载一起撤销。
      ctx.effect(() => {
        installStyle()
        return () => {
          if (typeof document === 'undefined') return
          document.getElementById(STYLE_ID)?.remove()
        }
      }, 'dsh-tool-gateway: 样式')
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-tool-gateway: 文案')
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'tool-gateway',
        order: 6,
        locale: NS,
      }, GatewayChip))
    }

    return { inject, apply }
  },
})
