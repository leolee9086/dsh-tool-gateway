/**
 * 工具组，以及「这个工具此刻能不能用」的判定。
 *
 * 有些插件会一口气注册几百个工具 —— 思源那套 HTTP 端点就是这个量级。它们全都默认
 * 开着的话，工具箱一打开就是几百行，而用户真正要用的往往只有几个。组让注册方能声明
 * 「这一批是后加的、默认先关着」，用户再按组、或者按单个工具去打开。
 *
 * 本模块只有两件事：一张组名册（{@link createGroupRegistry}）和一条判定
 * （{@link toolEnabled}）。它不认识 Cordis、不读状态也不写存储 —— 判定要的输入全部由
 * 调用方给进来，所以它可以单独测。
 *
 * 判定是**三态**的，优先级从高到低：
 *
 * 1. 这个工具被显式关掉 → 关；
 * 2. 这个工具被显式打开 → 开；
 * 3. 它所属的组被显式开或关 → 按那个值；
 * 4. 组自己声明的默认值 → 按组声明；
 * 5. 不属于任何组 → 开。
 *
 * 第 1、2 条同时出现在一条记录里是不可能的：写入口（switch-state.js）会让两者互斥。
 * 判定里仍然把关排在前面，方向是保守的 —— 一条被外部改坏的记录不该意外放出工具。
 *
 * @module dsh-tool-gateway/groups
 */

/**
 * 归一化一个组名。
 *
 * 组的 id 会被写进会话记录（作为 `groups` 那个对象的键），所以只认一种紧凑的形态；
 * 带空格或点号的 id 早晚会在某条路径上被当成别的东西。
 *
 * @param {unknown} value 待校验的 id
 * @returns {string} 合法的组 id
 * @throws {Error} 不是字符串、为空、或含不允许的字符时抛错
 */
function requireGroupId(value) {
  if (typeof value !== 'string') throw new Error('工具组需要一个字符串 id')
  const id = value.trim()
  if (id === '') throw new Error('工具组 id 不能为空')
  if (!/^[a-z0-9][a-z0-9:_-]*$/i.test(id)) {
    throw new Error(`工具组 id「${id}」含不允许的字符（只允许字母、数字、冒号、下划线、连字符）`)
  }
  return id
}

/**
 * 造一张组名册。
 *
 * **一个工具只属于一个组。** 同一个名字被第二个组认领时直接抛错，而不是让"谁先注册谁赢"
 * 变成一条只在特定加载顺序下才成立的隐规则 —— 那种规则读代码看不出来，出问题也查不到。
 *
 * @returns {object} 名册句柄：`register` / `groupOf` / `list` / `size`
 */
export function createGroupRegistry() {
  /** id → 组记录，顺序即注册顺序（界面按它排列）。 */
  const groups = new Map()
  /** 工具名 → 组 id 的反向索引。它和 each group 的 `names` 同生共死，不是第二份事实。 */
  const owner = new Map()

  /**
   * 认领一个工具名。已被别的组占着就抛错（见模块顶部）。
   *
   * @param {object} group 组记录
   * @param {string} name 工具名
   * @returns {void}
   */
  const claim = (group, name) => {
    const held = owner.get(name)
    if (held !== undefined && held !== group.id) {
      throw new Error(`工具「${name}」已经属于工具组「${held}」，不能再归到「${group.id}」`)
    }
    owner.set(name, group.id)
    group.names.add(name)
  }

  /**
   * 注册一个组。
   *
   * @param {object} spec 组声明
   * @param {string} spec.id 唯一 id
   * @param {string} [spec.title] 给人看的名字，缺省用 id
   * @param {boolean} [spec.defaultEnabled] 组内工具的默认可用性。**缺省是关**——
   *   注册一个组的典型理由就是「这一批默认先别放出来」，要默认开就得明写 true
   * @param {string} [spec.origin] 谁注册的（插件名），界面上用来分组显示
   * @param {string[]} [spec.names] 初始成员
   * @returns {{add: Function, remove: Function, setDefaultEnabled: Function, dispose: Function}}
   *   组句柄。`dispose()` 撤销整个组定义（连同成员归属）
   */
  function register(spec) {
    const id = requireGroupId(spec?.id)
    if (groups.has(id)) throw new Error(`工具组「${id}」已经注册过了`)
    const group = {
      id,
      title: typeof spec?.title === 'string' && spec.title.trim() !== '' ? spec.title.trim() : id,
      origin: typeof spec?.origin === 'string' ? spec.origin : '',
      defaultEnabled: spec?.defaultEnabled === true,
      names: new Set(),
    }
    groups.set(id, group)
    try {
      for (const name of Array.isArray(spec?.names) ? spec.names : []) {
        if (typeof name === 'string' && name.trim() !== '') claim(group, name.trim())
      }
    } catch (error) {
      // 初始成员认领失败（撞上别的组）就把这次注册整个撤掉：留一个半截的组
      // 比直接失败更难查 —— 界面会显示一个成员莫名其妙的组。
      for (const name of group.names) owner.delete(name)
      groups.delete(id)
      throw error
    }

    const mine = () => groups.get(id) === group
    return {
      /**
       * 加一个成员。
       *
       * 注册方通常先注册工具、再把它加进来；顺序反过来也无所谓 —— 名册只管名字，
       * 一个还没注册的工具名加进来不算错，等它真注册了判定自然生效。
       *
       * @param {string} name 工具名
       * @returns {void}
       */
      add(name) {
        if (!mine()) throw new Error(`工具组「${id}」已经撤销了，不能再加成员`)
        if (typeof name !== 'string' || name.trim() === '') return
        claim(group, name.trim())
      },

      /**
       * 去掉一个成员。
       * @param {string} name 工具名
       * @returns {void}
       */
      remove(name) {
        if (!mine()) return
        if (!group.names.delete(name)) return
        if (owner.get(name) === id) owner.delete(name)
      },

      /**
       * 改这个组的默认可用性。只影响没有显式覆盖的会话。
       * @param {boolean} value 新的默认值
       * @returns {void}
       */
      setDefaultEnabled(value) {
        if (!mine()) return
        group.defaultEnabled = value === true
      },

      /**
       * 撤销这个组：组定义与全部成员归属一起消失。
       *
       * 撤销之后组内的工具回到「不属于任何组」的判定 —— 也就是**开着**。
       * 这是对的：插件卸载了，它当初要求的那份默认关闭也就没有主张的人了。
       *
       * @returns {void}
       */
      dispose() {
        if (!mine()) return
        for (const name of group.names) {
          if (owner.get(name) === id) owner.delete(name)
        }
        groups.delete(id)
      },
    }
  }

  return {
    register,

    /**
     * 这个名字属于哪个组。
     * @param {string} name 工具名
     * @returns {object|undefined} 组记录；不属于任何组时是 undefined
     */
    groupOf(name) {
      const id = owner.get(name)
      return id === undefined ? undefined : groups.get(id)
    },

    /**
     * 全部组，按注册顺序。
     * @returns {object[]} 组记录数组
     */
    list() {
      return [...groups.values()]
    },

    /** @returns {number} 组数 */
    size() {
      return groups.size
    },
  }
}

/**
 * 一个工具此刻能不能用。
 *
 * 判定的三段见模块顶部。`prefs` 是**一个会话**的偏好（{@link createSwitchState} 的
 * `prefs()` 产物），`group` 是这个工具所属的组（不认识就传 undefined）。
 *
 * @param {string} name 工具名
 * @param {{disabledTools: Set<string>, enabledTools: Set<string>, groups: Map<string, boolean>}} prefs
 *   会话偏好
 * @param {object|undefined} group 所属工具组
 * @returns {boolean} true = 模型可以用它
 */
export function toolEnabled(name, prefs, group) {
  if (prefs.disabledTools.has(name)) return false
  if (prefs.enabledTools.has(name)) return true
  if (group === undefined) return true
  const override = prefs.groups.get(group.id)
  if (override !== undefined) return override
  return group.defaultEnabled === true
}
