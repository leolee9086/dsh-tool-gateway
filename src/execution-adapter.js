/** 兼容旧版单调用入口与新版分阶段执行；不改变宿主的准入或作用域。 */

/** 从提供 tools 的加载树解析公开模块，并拒绝另一份注册表身份。 */
export async function importHostToolsModule(ctx, specifier) {
  const tools = ctx.tools
  const original = tools[Symbol.for('cordis.original')] ?? tools
  const tree = original.ctx?.fiber?.entry?.parent?.tree
  if (typeof tree?.import !== 'function') {
    throw new Error('工具网关需要从 tools 服务所属的 Loader 导入宿主执行流水线。')
  }
  const hostTools = await tree.import('@deepseek-ai/dsh-tools')
  if (!(original instanceof hostTools.ToolsService)) {
    throw new Error('工具网关解析到了另一份 tools 模块；拒绝混用宿主执行流水线。')
  }
  return tree.import(specifier)
}

/**
 * 从 tools 服务的加载树取得同一份宿主模块。插件自身不安装另一份 Harness。
 * 只在新版调用公开 pipeline 子入口；旧宿主不需要也不会解析这个入口。
 * @param {object} ctx 插件上下文
 * @returns {Promise<(input: object) => Promise<object>>} 接受真实父 token、toolSet 和取消信号的子调用入口
 */
export async function createNestedExecutor(ctx) {
  const tools = ctx.tools
  if (typeof tools.executable !== 'function') return input => tools.execute(input)

  // Cordis 公开的 original 符号解开 use-site proxy，保留服务定义方的 Loader 来源。
  const { ToolExecutionPipeline } = await importHostToolsModule(ctx, '@deepseek-ai/dsh-tools/pipeline')
  const pipeline = new ToolExecutionPipeline(ctx)
  return async input => {
    // batch.execute 不接受 parent；直接使用与官方 PTC 相同的公开阶段，
    // 才能保留父调用身份、原始 step admission、审批、守卫及沙箱包装。
    const prepared = await pipeline.prepare(input)
    const outcome = prepared.kind === 'dispatch'
      ? await pipeline.dispatch(prepared.exec)
      : prepared
    return pipeline.complete(prepared.exec, outcome)
  }
}
