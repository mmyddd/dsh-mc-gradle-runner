// 针对一个真实 MC 项目的发现测试：验证插件不绑定仓库也能找到全部 run* 目标。
//
// 需要一个真实存在的 MC Gradle 项目，从参数或 MC_TEST_PROJECT 环境变量给：
//   node test/test-discovery.mjs D:\path\to\your\mod
// 没给、或路径不存在时跳过（不算失败）——这是可选的人工验证，不是回归测试。
import { existsSync } from 'node:fs'
import { findGradleRoot, discoverTargets, gradleInvocation, resolveTarget, pickDefaultTarget } from '../lib/discovery.js'

const start = process.argv[2] ?? process.env.MC_TEST_PROJECT
if (start === undefined || !existsSync(start)) {
  console.log('SKIP — 未提供真实 MC 项目路径（参数或 MC_TEST_PROJECT），跳过')
  process.exit(0)
}
const root = findGradleRoot(start)
console.log('startDir      =', start)
console.log('gradleRoot    =', root)
console.log('')

const { targets, projects } = await discoverTargets(root)
console.log('projects found:', projects.length)
console.log('targets found :', targets.length)
console.log('')
const byKind = { client: [], data: [], server: [], other: [] }
for (const t of targets) byKind[t.kind].push(t.task)
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`[${kind}] (${list.length})`)
  for (const task of list) console.log('   ', task)
}
console.log('')

const inv = gradleInvocation(root)
console.log('invocation    =', JSON.stringify(inv))
console.log('')
console.log('default       =', pickDefaultTarget(targets)?.task)

// 取一个真实存在的项目路径来试解析，而不是硬编码某个仓库的子模块名。
const sample = targets.find((t) => t.projectPath !== ':')?.projectPath ?? ':'
for (const kind of ['client', 'data', 'server']) {
  const t = resolveTarget(targets, kind, sample)
  console.log(`resolve(${kind}, ${sample}) =`, t?.task)
}
const exact = targets[0]?.task
console.log(`resolve(${exact}) =`, resolveTarget(targets, exact)?.task)
console.log('resolve(unknown) =', resolveTarget(targets, 'nope')?.task)
