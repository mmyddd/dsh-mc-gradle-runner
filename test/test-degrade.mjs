/**
 * 回归测试：插件在「依赖不满足」的环境里也必须能加载。
 *
 * 背景（真 bug）：`.volatile()` 是 schemastery **3.18.3** 才加的 API。早先这里是
 * 顶层 `import z from '@deepseek-ai/schemastery'` + 顶层 `.volatile()` 调用，
 * peer 范围却写 `^3.18.0` —— 于是别人用插件管理器从 GitHub 装的时候，
 * pnpm 解析到 3.18.1，import 阶段就抛
 *   TypeError: z.boolean(...).default(...).volatile is not a function
 * **整个插件连带右上角按钮一起消失**。
 *
 * 修法：运行期解析 schemastery（`loadZ`，拿不到就返回 undefined），
 * 并探测 `volatile` 是否可用（`buildConfig`，不可用就退化成普通 schema）。
 * 本文件锁住这两条降级路径。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pkgRoot = join(here, '..')
const scratch = join(tmpdir(), `mcrun-degrade-${process.pid}`)

let failures = 0
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures += 1
}

/** 复制插件源码到临时目录。**不带 node_modules**，模拟全新机器上的安装。 */
function isolatedCopy(name) {
  const root = join(scratch, name)
  mkdirSync(root, { recursive: true })
  for (const rel of ['lib', 'package.json']) {
    cpSync(join(pkgRoot, rel), join(root, rel), { recursive: true })
  }
  return root
}

/**
 * 一个「旧版 schemastery」替身：形状够 `buildConfig` 用，但**故意没有 `.volatile()`**。
 *
 * 比「指望本机恰好躺着 3.18.1 副本」可靠得多 —— 它精确复现了当初崩掉的那个条件，
 * 在任何机器上都能跑。
 *
 * 两种模块格式都要给：插件用 `createRequire` 取包（走 require 条件），
 * 所以 `.cjs` 必须是真 CJS，不能把 ESM 源码复制过去。
 */
const LEGACY_BODY = `
const node = (meta) => {
  const schema = { type: meta.type ?? 'any', meta: { ...meta } }
  schema.default = (value) => { schema.meta.default = value; return schema }
  schema.description = (text) => { schema.meta.description = text; return schema }
  schema.min = (value) => { schema.meta.min = value; return schema }
  return schema
}
const z = () => node({})
z.boolean = () => node({ type: 'boolean' })
z.string = () => node({ type: 'string' })
z.number = () => node({ type: 'number' })
z.const = (value) => node({ type: 'const', value })
z.array = (inner) => { const schema = node({ type: 'array' }); schema.inner = inner; return schema }
z.union = (list) => { const schema = node({ type: 'union' }); schema.list = list; return schema }
z.object = (dict) => { const schema = node({ type: 'object' }); schema.dict = dict; return schema }
`

const LEGACY_ESM = `${LEGACY_BODY}export default z\n`
const LEGACY_CJS = `${LEGACY_BODY}module.exports = z\nmodule.exports.default = z\n`

/** 把替身装成 @deepseek-ai/schemastery。 */
function installStub(root) {
  const dir = join(root, 'node_modules', '@deepseek-ai', 'schemastery')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/schemastery',
    version: '3.18.1',
    main: './lib/index.cjs',
    exports: { '.': { import: './lib/index.mjs', require: './lib/index.cjs' } },
  }, null, 2))
  writeFileSync(join(dir, 'lib', 'index.mjs'), LEGACY_ESM)
  writeFileSync(join(dir, 'lib', 'index.cjs'), LEGACY_CJS)
}

/** 在指定目录里 import 插件，返回 { ok, named?, config?, volatile?, error? }。 */
function tryImport(root) {
  const script = `
    const mod = await import(${JSON.stringify(pathToFileURL(join(root, 'lib', 'index.js')).href)})
    const dict = mod.Config?.dict ?? null
    console.log('RESULT ' + JSON.stringify({
      named: Object.keys(mod).sort(),
      config: dict === null ? null : Object.keys(dict).length,
      volatile: dict === null ? null : Object.values(dict).filter((one) => one.meta?.volatile === true).length,
      fields: dict === null ? null : Object.keys(dict).sort(),
    }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: root })
  const line = (result.stdout ?? '').split('\n').find((one) => one.startsWith('RESULT '))
  if (line === undefined) {
    const err = (result.stderr ?? '').split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown'
    return { ok: false, error: err }
  }
  return { ok: true, ...JSON.parse(line.slice('RESULT '.length)) }
}

/** 本机若恰好有真实的 3.18.1 副本，返回它的路径。 */
function findRealLegacy() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const stores = [
    join(home, '.dsh', 'profiles', 'desktop', 'node_modules', '.pnpm'),
    join(home, 'node_modules', '.pnpm'),
  ]
  for (const store of stores) {
    if (!existsSync(store)) continue
    const hit = readdirSync(store).find((name) => name.startsWith('@deepseek-ai+schemastery@3.18.1'))
    if (hit === undefined) continue
    const dir = join(store, hit, 'node_modules', '@deepseek-ai', 'schemastery')
    if (existsSync(dir)) return dir
  }
  return undefined
}

try {
  rmSync(scratch, { recursive: true, force: true })

  // --- 用例 1：完全没有 schemastery ---
  const bare = isolatedCopy('bare')
  const noDep = tryImport(bare)
  check('完全没有 schemastery 时插件仍能加载', noDep.ok, noDep.error ?? '')
  check('  没有 Config（配置页不出表单，但按钮与工具照常）', noDep.ok && noDep.config === null)
  check('  name / inject / apply / default 都还在',
    noDep.ok && ['apply', 'default', 'inject', 'name'].every((one) => noDep.named.includes(one)),
    noDep.ok ? noDep.named.join(', ') : '')

  // --- 用例 2：只有旧版 schemastery（没有 .volatile）---
  const legacy = isolatedCopy('legacy')
  installStub(legacy)
  const oldDep = tryImport(legacy)
  check('旧版 schemastery（无 .volatile）时插件仍能加载', oldDep.ok, oldDep.error ?? '')
  // 不写死字段数：新增配置项时这里不该跟着改，改成“必须覆盖已知字段”。
  check('  且配置 schema 覆盖了全部已知字段',
    oldDep.ok && ['enabled', 'exposeTools', 'forwardStdin', 'gradleRoot', 'duplicatePolicy']
      .every((key) => (oldDep.fields ?? []).includes(key)),
    oldDep.ok ? `字段：${(oldDep.fields ?? []).join(',')}` : '')
  check('  只是字段不带 volatile（配置页不出表单，功能不受影响）',
    oldDep.ok && oldDep.volatile === 0, oldDep.ok ? `volatile 字段 ${oldDep.volatile}` : '')

  // --- 用例 3：本机若真有 3.18.1 副本，拿真货再跑一遍 ---
  const real = findRealLegacy()
  if (real === undefined) {
    console.log('[SKIP] 本机没有真实的 schemastery 3.18.1 副本，跳过该冗余用例')
  } else {
    const realRoot = isolatedCopy('real-legacy')
    const target = join(realRoot, 'node_modules', '@deepseek-ai')
    mkdirSync(target, { recursive: true })
    cpSync(real, join(target, 'schemastery'), { recursive: true })
    const cosmokit = join(real, '..', 'cosmokit')
    if (existsSync(cosmokit)) cpSync(cosmokit, join(target, 'cosmokit'), { recursive: true })
    const realRun = tryImport(realRoot)
    check('真实的 schemastery 3.18.1 下插件仍能加载', realRun.ok, realRun.error ?? '')
  }

  // --- 用例 4：本机装的正式版本（3.18.4+）必须仍然走 volatile 路径 ---
  const modern = tryImport(pkgRoot)
  check('当前环境（新版 schemastery）下所有字段都带 volatile',
    modern.ok && modern.config > 0 && modern.volatile === modern.config,
    modern.ok ? `字段数 ${modern.config} / volatile ${modern.volatile}` : modern.error ?? '')

  console.log('')
  console.log(failures === 0 ? 'ALL DEGRADE TESTS PASSED' : `${failures} DEGRADE ASSERTION(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
