// 跑完 test/ 下的全部用例文件，汇总通过/失败。
//
// 用法：
//   node test/run-all.mjs            # 全部
//   node test/run-all.mjs core diff  # 只跑名字里含这些片段（或不含 argv，等价于全部）
//
// 每个用例文件都是独立进程：崩溃、超时、挂死都不会拖垮整轮。
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const filters = process.argv.slice(2)

const files = readdirSync(here)
  .filter((name) => /^test-.*\.mjs$/.test(name))
  .filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)))
  .sort()

let passed = 0
let failed = 0
const failures = []

for (const name of files) {
  process.stdout.write(`\n=== ${name} ===\n`)
  const result = spawnSync(process.execPath, [join(here, name)], {
    stdio: 'inherit',
    cwd: join(here, '..'),
  })
  if (result.status === 0) {
    passed += 1
  } else {
    failed += 1
    failures.push(`${name} (exit ${result.status})`)
  }
}

console.log('')
console.log(`\n=== 汇总：${passed} 个文件通过，${failed} 个失败，共 ${files.length} 个 ===`)
if (failed > 0) console.log(`失败：${failures.join(', ')}`)
process.exit(failed === 0 ? 0 : 1)
