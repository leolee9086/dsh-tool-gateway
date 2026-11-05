/** Run the real host from its source checkout; never silently substitute stale lib artifacts. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const checkout = process.env.DSH_TEST_CHECKOUT
if (!checkout) throw new Error('Set DSH_TEST_CHECKOUT to the Harness source checkout before running integration tests.')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(resolve(checkout, 'package.json'))
const tsx = pathToFileURL(require.resolve('tsx/esm')).href
const child = spawn(process.execPath, ['--import', tsx, '--test', ...process.argv.slice(2), resolve(root, 'tests/integration/source-host.test.mts')], {
  cwd: checkout,
  env: { ...process.env, DSH_TEST_CHECKOUT: resolve(checkout), TSX_TSCONFIG_PATH: resolve(checkout, 'tsconfig.json') },
  stdio: 'inherit',
})
child.once('error', error => { console.error(error); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
