/**
 * 零依赖构建：先校验 src/ 下每个模块，全部通过之后再重建 lib/。
 *
 * 顺序是刻意的 —— 校验失败时旧 lib/ 原样保留，不留半成品产物。
 *
 * 两种模块，两种校验方式：
 *
 * - **宿主侧（其余 .js）**：动态 import。它会真的解析依赖链，拼错的相对路径、
 *   指向不存在的导出都会在这里就暴露。
 * - **客户端（client.js）**：它在**加载的那一刻就访问 `window`**，import 会直接抛，
 *   所以只能做语法校验（`new vm.Script` 只编译不执行）。同时断言它确实通过
 *   `__ModuleLoader__.load` 自注册 —— 那正是浏览器侧的加载契约，写成一个裸 ESM
 *   export 的话文件会被原样下发、然后什么都不发生。
 *
 * lib/ 是逐字节拷贝：客户端文件由 web server 原样下发，构建绝不能转换它。
 */
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')

/** 浏览器侧入口的固定文件名。 */
const CLIENT_FILE = 'client.js'

const modules = (await readdir(srcDir)).filter((file) => file.endsWith('.js')).sort()
if (modules.length === 0) throw new Error('src/ 下没有 .js 模块')

for (const file of modules) {
  if (file === CLIENT_FILE) {
    const source = await readFile(join(srcDir, file), 'utf8')
    new vm.Script(source, { filename: file })
    if (!source.includes('__ModuleLoader__')) {
      throw new Error(`${file} 必须通过 window.__ModuleLoader__.load 自注册（浏览器侧加载契约）`)
    }
    console.log(`ok  src/${file}（语法 + 自注册契约）`)
    continue
  }
  await import(pathToFileURL(join(srcDir, file)).href)
  console.log(`ok  src/${file}`)
}

await rm(libDir, { recursive: true, force: true })
await mkdir(libDir, { recursive: true })
for (const file of modules) {
  await cp(join(srcDir, file), join(libDir, file))
  console.log(`cp  src/${file} -> lib/${file}`)
}
