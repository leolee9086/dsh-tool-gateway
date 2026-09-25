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
 * **两副面孔，两个插槽：**
 *
 * - 会话标题栏上的 chip —— `conversation.session.header.actions`（list / session 作用域），
 *   标准 props 里带 `sessionId`。同一个槽位上已经有 agent-preset、job-list、
 *   context-limit、agent-team 等入口，各自用自己的 id，互不覆盖。
 * - 右侧栏的工具箱面板 —— 三步注册：`sidebarRightTabs` 定义类型，键控 seat
 *   `sidebar.right.pane.tab`（正文）与 `sidebar.right.pane.tab.title`（标题），
 *   再加侧栏底部的入口按钮。页签是 **session 作用域**的，框架把 `sessionId` 交给正文，
 *   所以面板开关的是**这个会话**的工具名单 —— 与标题栏那个 chip 同一份偏好、同一张表。
 *
 * **面板的文案直接写中文**：会话标题栏那个 seat 会把 locale 的 `t` 交过来，页签那两个
 * seat 不会 —— 为了几行面板文案去搭一套注入不值得。chip 仍然走字典（它有 `t`）。
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
.dsh-tool-gateway-panel{display:flex;flex-direction:column;height:100%;min-height:0;
  background:var(--dsw-alias-fill-primary, #fff);font-size:13px}
.dsh-tool-gateway-panel-bar{display:flex;align-items:center;gap:8px;padding:10px 12px;flex:none;
  border-bottom:1px solid var(--dsw-alias-line-default, rgba(0,0,0,.06))}
.dsh-tool-gateway-panel-search{flex:1;min-width:0;height:28px;padding:0 8px;border-radius:6px;font:inherit;
  font-size:12px;background:transparent;color:var(--dsw-alias-label-primary, #111);
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))}
.dsh-tool-gateway-panel-count{flex:none;font-size:12px;white-space:nowrap;
  color:var(--dsw-alias-label-secondary, #666)}
.dsh-tool-gateway-panel-list{flex:1;min-height:0;overflow:auto;padding:6px 0}
.dsh-tool-gateway-panel-row{display:flex;align-items:flex-start;gap:10px;padding:7px 12px}
.dsh-tool-gateway-panel-row:hover{background:var(--dsw-alias-fill-hover, rgba(132,133,141,.08))}
.dsh-tool-gateway-switch{flex:none;position:relative;width:38px;height:20px;padding:0;border:none;
  border-radius:999px;cursor:pointer;transition:background .15s;
  background:var(--dsw-alias-fill-tertiary, rgba(0,0,0,.15))}
.dsh-tool-gateway-switch[data-on="true"]{background:var(--dsw-alias-state-success-primary, #22c55e)}
.dsh-tool-gateway-switch:disabled{cursor:default;opacity:.5}
.dsh-tool-gateway-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;
  border-radius:50%;background:#fff;transition:transform .15s}
.dsh-tool-gateway-switch[data-on="true"]::after{transform:translateX(18px)}
.dsh-tool-gateway-panel-text{min-width:0;flex:1}
.dsh-tool-gateway-panel-name{font-size:12px;word-break:break-all;
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  color:var(--dsw-alias-label-primary, #111)}
.dsh-tool-gateway-panel-desc{margin-top:2px;font-size:12px;display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden;color:var(--dsw-alias-label-secondary, #666)}
.dsh-tool-gateway-panel-tag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;
  font-size:11px;line-height:16px;font-family:inherit;
  background:var(--dsw-alias-fill-tertiary, rgba(0,0,0,.06));
  color:var(--dsw-alias-label-secondary, #666)}
.dsh-tool-gateway-panel-note{padding:16px 12px;font-size:12px;line-height:1.7;
  color:var(--dsw-alias-label-secondary, #666)}
.dsh-tool-gateway-panel-note[data-error="true"]{color:var(--dsw-alias-state-error-primary, #ef4444)}
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


    /* ── 右侧栏「工具箱」面板 ─────────────────────────────────────── */

    /** 面板页签的身份。`kind` 是打开时用的地址，`id` 是 seat 的键 —— 两者同值，各写一次。 */
    const PANEL_TAB_ID = 'dsh-tool-gateway:tools'
    const PANEL_TAB_KIND = 'dsh-tool-gateway:tools'

    /** 侧栏底部入口按钮的位置：排在「搜索」后面。 */
    const PANEL_ACTION_ORDER = 62

    /**
     * 面板正文。
     *
     * 读 `GET /api/tool-gateway?scope=global` 拿工具清单与关闭名单；每次切换都重读一遍。
     * **权威状态在宿主侧**：这里不乐观更新、不推断、不缓存 —— 界面上的一点延迟换来的是
     * 「屏幕上显示的一定是真的」。
     *
     * @returns {object} React 元素
     */
    function ToolsPanel(props) {
      // 页签是 session 作用域的，框架把 sessionId 直接交给正文（与 conversation 那几个
      // seat 一样）。拿不到就不发请求 —— 没有会话就没有「这个会话关掉了哪些工具」。
      const sessionId = props !== undefined && props !== null && props.sessionId ? props.sessionId : null
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [query, setQuery] = React.useState('')
      // 面板可能被重复打开/关闭，用代际号作废在途请求的回调。
      const generation = React.useRef(0)

      const load = React.useCallback(async () => {
        if (sessionId === null) return
        const mine = ++generation.current
        try {
          const response = await fetch(
            `${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`,
            { credentials: 'same-origin' },
          )
          const body = await response.json().catch(() => ({}))
          if (generation.current !== mine) return
          if (!response.ok || body?.ok !== true) throw new Error(failureText(body, response.status))
          // 每个工具自己带 disabled（宿主按这个会话算好的），前端不再自己对照名单。
          setData({ tools: Array.isArray(body.tools) ? body.tools : [] })
          setError(null)
        } catch (reason) {
          if (generation.current !== mine) return
          setError(String(reason?.message ?? reason))
        }
      }, [sessionId])

      React.useEffect(() => {
        void load()
        return () => { generation.current += 1 }
      }, [load])

      /**
       * 开关一个工具。写完重读一次，而不是就地改本地状态。
       *
       * @param {string} tool 工具名
       * @param {boolean} next true = 关掉它
       * @returns {Promise<void>} 界面已更新（或已记下失败原因）
       */
      const toggle = async (tool, next) => {
        if (busy || sessionId === null) return
        setBusy(true)
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, tool, disabled: next }),
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok || body?.ok !== true) throw new Error(failureText(body, response.status))
          await load()
        } catch (reason) {
          setError(String(reason?.message ?? reason))
        } finally {
          setBusy(false)
        }
      }

      const needle = query.trim().toLowerCase()
      const rows = data === null ? [] : data.tools.filter((tool) => needle === ''
        || String(tool.name).toLowerCase().includes(needle)
        || String(tool.description ?? '').toLowerCase().includes(needle))
      const offCount = data === null ? 0 : data.tools.filter((tool) => tool.disabled === true).length

      /**
       * 一行：开关 + 名字 + 描述。
       *
       * @param {object} tool 工具记录（宿主给的 {name, description, disabled, banned, core}）
       * @returns {object} React 元素
       */
      const renderRow = (tool) => {
        const off = tool.disabled === true
        // 核心工具与部署级禁用的工具都不给点：前者关了就没有工具入口，后者是配置说了算。
        const locked = tool.core === true || tool.banned === true
        let hint = off ? '打开它' : '关掉它'
        if (tool.core === true) hint = '核心工具：关了就没有工具入口了'
        else if (tool.banned === true) hint = '部署配置里禁用了它，改配置才能打开'
        const tags = []
        if (tool.core === true) {
          tags.push(React.createElement('span', { className: 'dsh-tool-gateway-panel-tag', key: 'core' }, '核心'))
        }
        if (tool.banned === true) {
          tags.push(React.createElement('span', { className: 'dsh-tool-gateway-panel-tag', key: 'banned' }, '部署禁用'))
        }
        const knob = React.createElement('button', {
          type: 'button',
          className: 'dsh-tool-gateway-switch',
          'data-on': String(!off),
          'aria-pressed': String(!off),
          'aria-label': (off ? '打开 ' : '关掉 ') + tool.name,
          disabled: busy || locked,
          title: hint,
          onClick: () => { void toggle(tool.name, !off) },
        })
        const text = React.createElement('div', { className: 'dsh-tool-gateway-panel-text' },
          React.createElement('div', { className: 'dsh-tool-gateway-panel-name' }, tool.name, tags),
          tool.description
            ? React.createElement('div', { className: 'dsh-tool-gateway-panel-desc' }, tool.description)
            : null)
        return React.createElement('div', { className: 'dsh-tool-gateway-panel-row', key: tool.name }, knob, text)
      }

      // 正文用显式的数组拼，不写嵌套三元：哪一段在什么条件下出现，一眼能读出来。
      const children = []
      children.push(React.createElement('div', { className: 'dsh-tool-gateway-panel-bar', key: 'bar' },
        React.createElement('input', {
          className: 'dsh-tool-gateway-panel-search',
          type: 'search',
          placeholder: '按名字或描述过滤',
          'aria-label': '过滤工具',
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        React.createElement('span', { className: 'dsh-tool-gateway-panel-count' },
          data === null ? (sessionId === null ? '' : '读取中…') : '关掉 ' + offCount + ' / 共 ' + data.tools.length),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-tool-gateway-chip',
          title: '重新读取',
          disabled: busy,
          onClick: () => { void load() },
        }, '刷新')))
      if (error !== null) {
        children.push(React.createElement('div', {
          className: 'dsh-tool-gateway-panel-note', 'data-error': 'true', key: 'error',
        }, error))
      }
      if (sessionId === null) {
        children.push(React.createElement('div', { className: 'dsh-tool-gateway-panel-note', key: 'no-session' },
          '这个面板要挂在某个会话的右侧栏上才读得到工具名单。'))
      } else if (data === null) {
        children.push(React.createElement('div', { className: 'dsh-tool-gateway-panel-note', key: 'loading' },
          '正在读取工具清单…'))
      } else if (rows.length === 0) {
        children.push(React.createElement('div', { className: 'dsh-tool-gateway-panel-note', key: 'empty' },
          data.tools.length === 0 ? '这个部署里没有可显示的工具。' : '没有匹配的工具。'))
      } else {
        children.push(React.createElement('div', { className: 'dsh-tool-gateway-panel-list', key: 'list' },
          rows.map(renderRow)))
      }
      return React.createElement('div', { className: 'dsh-tool-gateway-panel' }, children)
    }

    /** 页签标题。 */
    function ToolsPanelTitle() {
      return React.createElement('span', null, '工具箱')
    }

    /**
     * 侧栏底部那个入口按钮。
     *
     * 注册成「页面类型」的页签**不会自己展开右栏**，所以点击时必须显式开一次 ——
     * 这一步在 websearch 那边踩过，照它的做法写。
     *
     * @param {object} scope 注入了 sidebarRight / layout 的子上下文
     * @returns {Function} 按钮组件
     */
    function makeToolsPanelOpener(scope) {
      return function ToolsPanelOpener(props) {
        const wide = !!(props && props.wide)
        const [hover, setHover] = React.useState(false)
        const open = React.useCallback(() => {
          try {
            const sidebarRight = scope.get('sidebarRight')
            const layout = scope.get('layout')
            if (sidebarRight === undefined) return
            sidebarRight.openTab(PANEL_TAB_KIND)
            if (layout !== undefined && sidebarRight.isExpanded() !== true) layout.openRightbar(false, false)
          } catch {
            // 没有已挂载的会话界面时 openTab 会抛；别让异常冒到 UI 上。
          }
        }, [])
        return React.createElement('button', {
          type: 'button',
          title: '工具箱：随时开关工具',
          'aria-label': '工具箱',
          onClick: open,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center',
            gap: 8, width: wide ? '100%' : 36, height: wide ? 42 : 36, padding: wide ? '0 10px' : 0,
            border: 'none', borderRadius: 6, cursor: 'pointer', boxSizing: 'border-box',
            background: hover ? 'var(--dsw-alias-fill-hover, rgba(132,133,141,0.08))' : 'transparent',
            color: 'var(--dsw-alias-label-primary, #111)', fontSize: 13,
          },
        },
        React.createElement('span', { style: { fontSize: 14, lineHeight: '1' } }, '\uD83E\uDDF0'),
        wide ? React.createElement('span', null, '工具') : null)
      }
    }

    /**
     * 装上面板。
     *
     * **用 `ctx.inject` 而不是把它写进 `inject`**：这三个服务缺席时（headless、或者侧栏
     * 没装），写进 inject 会让整个客户端插件停在 PENDING —— 标题栏那个 chip 会跟着一起
     * 消失。延迟注入的话，缺的只是面板，chip 照常工作。
     *
     * @param {object} ctx 客户端插件上下文
     * @returns {void}
     */
    function installPanel(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['sidebarRightTabs', 'sidebarRight', 'layout'], (scope) => {
        const tabs = scope.get('sidebarRightTabs')
        const layout = scope.get('layout')
        if (tabs === undefined || typeof tabs.register !== 'function') return

        scope.effect(() => tabs.register({
          id: PANEL_TAB_ID,
          kind: PANEL_TAB_KIND,
          title: () => '工具箱',
        }), 'dsh-tool-gateway: 工具箱页签类型')
        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PANEL_TAB_ID,
        }, ToolsPanel)), 'dsh-tool-gateway: 工具箱面板正文')
        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: PANEL_TAB_ID,
        }, ToolsPanelTitle)), 'dsh-tool-gateway: 工具箱面板标题')

        // 没有布局服务时页签仍然在（还能用别的方式打开它），只是少一个底部入口。
        if (layout === undefined) return
        const Opener = makeToolsPanelOpener(scope)
        scope.effect(() => scope.slots.inject('sidebar.footer.action', () => scope.slots.register({
          name: 'sidebar.footer.action',
          id: 'tool-gateway-tools',
          order: PANEL_ACTION_ORDER,
          label: () => '工具',
        }, Opener)), 'dsh-tool-gateway: 工具箱入口')
      })
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
      installPanel(ctx)
    }

    return { inject, apply }
  },
})
