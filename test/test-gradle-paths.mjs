// 关键验证：把插件“发现”出来的项目路径交给真实 Gradle，确认它们真的存在。
// 发现逻辑自己说对了不算数，Gradle 认了才算数。
//
// 需要一个真实存在的 MC Gradle 项目（参数或 MC_TEST_PROJECT），缺省则跳过。
import { existsSync } from 'node:fs'
import { runOnce } from '../lib/proc.js'
import { findGradleRoot, gradleInvocation, discoverTargets } from '../lib/discovery.js'

const start = process.argv[2] ?? process.env.MC_TEST_PROJECT
if (start === undefined || !existsSync(start)) {
  console.log('SKIP — 未提供真实 MC 项目路径（参数或 MC_TEST_PROJECT），跳过')
  process.exit(0)
}
const root = findGradleRoot(start)
const inv = gradleInvocation(root)

// 让 Gradle 自己报出全部项目路径，解析 "Project ':<path>'" 形式。
const projects = await runOnce([...inv.argv, 'projects', '--console=plain', '--quiet'], inv.cwd, 420000)
const rawText = projects.stdout + projects.stderr
const declared = new Set(
  [...rawText.matchAll(/Project '([^']+)'/g)].map((m) => m[1]),
)

console.log('Gradle 报告的顶层项目数:', declared.size)
console.log('')

const { targets } = await discoverTargets(root)
// 只校验插件从 settings.gradle 推导出来的那些（source=settings），
// IDEA 配置里的任务名是用户手写的，不在本次校验范围。
const derived = targets.filter((t) => t.source === 'settings')
const paths = [...new Set(derived.map((t) => t.projectPath))].sort()

let missing = []
for (const path of paths) {
  const found = declared.has(path)
  console.log(`${found ? 'OK  ' : 'MISS'} 插件推导的项目路径 ${path}`)
  if (!found) missing.push(path)
}

console.log('')
console.log(`校验 ${paths.length} 个路径，Gradle 确认 ${paths.length - missing.length} 个`)
if (missing.length > 0) {
  console.log('未被 Gradle 确认的路径:', missing.join(', '))
  console.log('（Gradle 报告的全部项目）:', [...declared].join(', '))
}
console.log('')
console.log(missing.length === 0 ? 'ALL DISCOVERED PATHS VERIFIED BY GRADLE' : 'SOME PATHS UNVERIFIED')
process.exit(missing.length === 0 ? 0 : 1)
