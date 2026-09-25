/**
 * 客户端半边的测试：自注册契约、插槽注册参数、以及组件初始渲染。
 *
 * **为什么不用 jsdom**：`src/client.js` 顶层只碰 `window.__ModuleLoader__`，
 * `document` 只在 `apply` 里（注入样式）才用到。用 `vm` 造一个只有 `window` 的
 * 上下文就能把注册契约测干净，不必为此引入一个 devDependency。
 *
 * React 也是桩：`apply` 阶段不调用任何 hook（hook 只在渲染时跑），所以桩只需要
 * 有那几个键。组件的初始渲染单独测一次，桩的 hook 返回固定初值即可。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(here, 'src', 'client.js'), 'utf8')

/** 加载客户端脚本，返回它交给 `__ModuleLoader__` 的那个 spec。 */
function loadRegistration() {
  let spec = null
  const window = { __ModuleLoader__: { load(value) { spec = value } } }
  vm.runInNewContext(source, { window })
  assert.ok(spec !== null, 'client.js 必须通过 window.__ModuleLoader__.load 自注册')
  return spec
}

/** 最小的 React 桩。 */
function stubReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  }
}

/**
 * 插件上下文的桩：把三类注册都记下来，并支持延迟注入（`ctx.inject`）。
 *
 * @param {object} [services] 延迟注入的回调里 `scope.get(name)` 能拿到什么
 * @returns {object} 桩上下文
 */
function stubCtx(services = {}) {
  const effects = []
  const locales = []
  const injectedSlots = []
  const registrations = []
  const injected = []
  const ctx = {
    effects,
    locales,
    injectedSlots,
    registrations,
    injected,
    inject(names, callback) {
      injected.push(names)
      // 子作用域沿用同一份记录，只是多一个 get —— 真 Cordis 也是这个形状。
      callback({ ...ctx, get: (name) => services[name] })
      return () => {}
    },
    effect(fn, label) {
      effects.push(label)
      fn()
      return () => {}
    },
    locale: {
      register(namespace, dictionaries) {
        locales.push({ namespace, dictionaries })
        return () => {}
      },
    },
    slots: {
      inject(name, register) {
        injectedSlots.push(name)
        register()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return ctx
}

/** 走一遍"加载 → factory → apply"，返回拿到的一切。 */
function mount(services = {}) {
  const spec = loadRegistration()
  const React = stubReact()
  const plugin = spec.factory((name) => {
    assert.equal(name, 'react', '客户端只允许向模块表要 react')
    return React
  })
  const ctx = stubCtx(services)
  plugin.apply(ctx)
  return { spec, plugin, ctx, React }
}

test('用固定的 id 自注册', () => {
  assert.equal(loadRegistration().id, 'dsh-tool-gateway')
})

test('只依赖 slots 与 locale 两个服务', () => {
  const { plugin } = mount()
  assert.deepEqual([...plugin.inject].sort(), ['locale', 'slots'])
})

test('apply 注册了中英文案', () => {
  const { ctx } = mount()
  assert.equal(ctx.locales.length, 1)
  assert.equal(ctx.locales[0].namespace, 'dsh-tool-gateway')
  assert.equal(typeof ctx.locales[0].dictionaries.zh.on, 'string')
  assert.equal(typeof ctx.locales[0].dictionaries.en.on, 'string')
})

test('面板走延迟注入：那两个服务缺席时 chip 不能跟着消失', () => {
  const { ctx } = mount()
  // 展开一次：数组是 vm 那个 realm 里造的，跨 realm 的 deepEqual 会因为原型不同而失败。
  assert.deepEqual(ctx.injected.map((names) => [...names]), [['sidebarRightTabs', 'sidebarRight', 'layout']])
  // 服务没到 → 一个面板注册都不该发生（chip 那一条照旧）。
  assert.deepEqual(ctx.registrations.map((r) => r.options.name), ['conversation.session.header.actions'])
})

test('面板挂到右侧栏的三个座位上：类型、正文、标题、底部入口', () => {
  const tabs = []
  const { ctx } = mount({
    sidebarRightTabs: { register: (definition) => { tabs.push(definition); return () => {} } },
    sidebarRight: { openTab: () => {}, isExpanded: () => true },
    layout: { openRightbar: () => {} },
  })
  assert.deepEqual(tabs.map((definition) => definition.id), ['dsh-tool-gateway:tools'])
  // 正文与标题用同一个 key —— 那正是页签类型定义里的 id。
  const seats = ctx.registrations.map((entry) => entry.options.name)
  assert.ok(seats.includes('sidebar.right.pane.tab'))
  assert.ok(seats.includes('sidebar.right.pane.tab.title'))
  assert.ok(seats.includes('sidebar.footer.action'))
  for (const name of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
    const entry = ctx.registrations.find((item) => item.options.name === name)
    assert.equal(entry.options.key, 'dsh-tool-gateway:tools')
  }
})
test('apply 把开关挂到会话标题栏那个插槽上', () => {
  const { ctx } = mount()
  assert.deepEqual(ctx.injectedSlots, ['conversation.session.header.actions'])
  assert.equal(ctx.registrations.length, 1)

  const { options } = ctx.registrations[0]
  assert.equal(options.name, 'conversation.session.header.actions')
  // 自己的 id：复用同槽位上别人已占的 id 会顶掉那一格。
  assert.equal(options.id, 'tool-gateway')
  assert.equal(options.locale, 'dsh-tool-gateway')
  assert.equal(typeof options.order, 'number')
})

test('apply 里每一项注册都有清理标签（卸载时要能撤干净）', () => {
  const { ctx } = mount()
  // 样式与文案各是一个 effect；插槽那一项走 slots.inject，由 Cordis 自己管生命周期。
  assert.equal(ctx.effects.length, 2)
  for (const label of ctx.effects) {
    assert.match(label, /^dsh-tool-gateway: /)
  }
})

test('还没读到状态时渲染成"未知"，并且可点击重试', () => {
  const { ctx } = mount()
  const { component } = ctx.registrations[0]
  const element = component({ sessionId: 'session-a', t: (key) => key })

  assert.equal(element.type, 'button')
  assert.equal(element.props['data-tool-gateway'], 'unknown')
  assert.equal(element.props['data-enabled'], 'false')
  assert.equal(element.props['aria-busy'], 'false')
  assert.equal(element.props.disabled, false)
  assert.equal(typeof element.props.onClick, 'function')
  // 文案走 locale，不写死在组件里。
  assert.equal(element.children[1].children[0], 'unknown')
  // 圆点是纯装饰，不该被读屏念出来。
  assert.equal(element.children[0].props['aria-hidden'], 'true')
})

test('组件在拿到 sessionId 之前不发请求', () => {
  const { ctx } = mount()
  const { component } = ctx.registrations[0]
  // 只渲染，不调 onClick：这一步不该触碰 fetch。
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('没有 sessionId 时不该发请求') }
  try {
    component({ sessionId: '', t: (key) => key })
  } finally {
    globalThis.fetch = originalFetch
  }
})
