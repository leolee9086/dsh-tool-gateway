/**
 * 工具目录的检索索引。
 *
 * 这里只做一件事：把"工具名 + 描述"建成一个可检索的倒排索引，供 find_tools 用。
 * 索引的输入是运行时注册表的投影（调用方传进来），本模块不认识 DSH 的任何类型。
 *
 * 两条设计约束，都是实测逼出来的（见 docs/检索栈实测.md）：
 *
 * 1. **索引侧与查询侧必须共用同一套分析器。** 两边分析方式不一致，召回就废了 ——
 *    这是搜索引擎的铁律。所以 tokenize / pinyinTokens 是导出的、唯一的分析入口，
 *    建索引和查询都走它们。
 * 2. **规模按无上限设计。** MCP server 可以在会话中途接入，工具数从几十到几万，
 *    所以用倒排索引而不是全量扫描；增量更新走 upsert / remove，不重建整个索引。
 */
import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict.js'
import { pinyin } from 'pinyin-pro'
import MiniSearch from 'minisearch'

/** 词典是 Uint8Array，装载一次即可复用；每次调用都 withDict 会白白重解析。 */
const jieba = Jieba.withDict(dict)

/**
 * 只留含字母或汉字的 token。
 *
 * jieba 会把下划线和标点单独切出来（`zhihu_search` → `["zhihu","_","search"]`），
 * 留着那个 `"_"` 的后果是：索引里每个带下划线的工具名都带着它，于是查任何
 * 带下划线的名字都会召回全部工具。实测过，必须丢。
 *
 * @param {string} token 待判定的词项
 * @returns {boolean} 含字母、数字或汉字时为 true
 */
const useful = (token) => /[a-z0-9\u4e00-\u9fff]/.test(token)

/** 判断一个词里有没有汉字 —— 只有含汉字的词才需要转拼音。 */
const hasHan = (text) => /[\u4e00-\u9fff]/.test(text)

/**
 * 把文本切成检索词项。建索引与查询都调它。
 *
 * 用 jieba 的搜索引擎模式（cutForSearch）而不是普通模式：普通模式会把
 * "站内搜索"当成一个整词，于是查"搜索"召不回它；搜索引擎模式同时给出
 * "站内"、"搜索"、"站内搜索"三档粒度。
 *
 * 带下划线的标识符另外整串留一份、拆开留一份，这样 `zhihu`、`search`、
 * `zhihu_search` 三种查法都能命中。
 *
 * @param {string} text 待切分的文本
 * @returns {string[]} 词项数组
 */
export function tokenize(text) {
  const tokens = []
  for (const raw of jieba.cutForSearch(String(text).toLowerCase())) {
    const token = raw.trim()
    if (!useful(token)) continue
    tokens.push(token)
    if (token.includes('_')) {
      for (const part of token.split('_')) if (useful(part)) tokens.push(part)
    }
  }
  return tokens
}

/**
 * 把文本里的中文词逐个转成拼音，词间用空格分隔。
 *
 * 不能整段连写：那样"知乎站内搜索"会变成 `zhihuzhanneisousuo`，查 `sousuo`
 * 召不回 —— 拼音中间隔着"站内"的音。按词分段之后 `sousuo`、`zhannei`、
 * `zhanneisousuo` 都能命中。
 *
 * 切词也走 cutForSearch，理由同 {@link tokenize}：只有切出"站内"和"搜索"
 * 两个词，它们才各自有拼音。
 *
 * `nonZh: 'consecutive'` 是关键 —— 不加的话 pinyin-pro 会把纯英文逐字母拆开
 * （`zhihu_search` → `"z h i h u _ s e a r c h"`）。
 *
 * @param {string} text 待转换的文本
 * @returns {string} 空格分隔的拼音串（无汉字时为空串）
 */
export function pinyinTokens(text) {
  const parts = []
  for (const raw of jieba.cutForSearch(String(text).toLowerCase())) {
    const word = raw.trim()
    if (!hasHan(word)) continue
    const spelled = pinyin(word, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('')
    if (spelled.length > 0) parts.push(spelled)
  }
  return parts.join(' ')
}

/**
 * 取一个工具名的拼音首字母串（只对含汉字的工具名有意义，英文名原样返回）。
 *
 * @param {string} name 工具名
 * @returns {string} 首字母串
 */
export function initialsOf(name) {
  return pinyin(String(name), { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('')
}

/** 字段权重：工具名压倒一切，拼音次之，描述只作兜底召回。 */
const BOOST = { name: 4, namePinyin: 3, nameInitials: 3, desc: 1 }

/**
 * 建一个工具目录索引。
 *
 * 索引里只存 name 与 description —— 完整的参数 schema 不存，因为它是易变的
 * 大对象，而且调用方随时能从注册表现取（注册表才是权威来源）。
 *
 * @returns {{ upsert: Function, remove: Function, search: Function, size: Function, rebuild: Function }}
 *   目录索引的四个操作
 */
export function createCatalog() {
  const index = new MiniSearch({
    idField: 'name',
    fields: ['name', 'namePinyin', 'nameInitials', 'desc', 'descPinyin'],
    storeFields: ['name', 'desc'],
    tokenize,
  })

  /** 把一条工具记录摊成索引文档。 */
  const toDocument = (tool) => ({
    name: tool.name,
    desc: tool.description ?? '',
    namePinyin: pinyinTokens(tool.name),
    nameInitials: initialsOf(tool.name),
    descPinyin: pinyinTokens(tool.description ?? ''),
  })

  return {
    /**
     * 全量重建。工具目录在进程启动时是批量来的，一次 addAll 比逐条快。
     *
     * @param {Array<{name: string, description?: string}>} tools 工具清单
     */
    rebuild(tools) {
      index.removeAll()
      if (tools.length > 0) index.addAll(tools.map(toDocument))
    },

    /**
     * 增量写入一条（MCP server 中途接入时走这里）。
     *
     * 必须先 has 再决定 add 还是 replace：MiniSearch 的 `replace` 要求文档已在索引里，
     * 对一条新工具直接 replace 会抛 "cannot discard document with ID …: it is not in the index"。
     *
     * @param {{name: string, description?: string}} tool 工具记录
     */
    upsert(tool) {
      const document = toDocument(tool)
      if (index.has(tool.name)) index.replace(document)
      else index.add(document)
    },

    /**
     * 删掉一条。discard 收 id 字符串 —— 传对象会抛
     * "cannot discard document with ID [object Object]"（实测）。
     *
     * @param {string} name 工具名
     */
    remove(name) {
      if (index.has(name)) index.discard(name)
    },

    /**
     * 检索。返回按分数降序的工具名，分数不对外暴露（调用方要的是"给我最像的几个"）。
     *
     * @param {string} query 查询词
     * @param {number} limit 最多返回几条
     * @returns {Array<{name: string, description: string, score: number}>} 命中结果
     */
    search(query, limit) {
      const text = String(query ?? '').trim()
      if (text.length === 0) return []
      const hits = index.search(text, { prefix: true, boost: BOOST })
      return hits.slice(0, limit).map((hit) => ({
        name: hit.name,
        description: hit.desc ?? '',
        score: hit.score,
      }))
    },

    /** @returns {number} 索引里的工具条数 */
    size() {
      return index.documentCount
    },
  }
}
