// 真实 Gradle 调用验证：用插件的进程层实际驱动一个真实 MC 项目的 gradlew。
// 这是对“按钮/工具真的能触发 Gradle”最直接的证据。
//
// 需要一个真实存在的 MC Gradle 项目（参数或 MC_TEST_PROJECT），缺省则跳过。
import { existsSync } from 'node:fs'
import { RunRegistry, runOnce } from '../lib/proc.js'
import { findGradleRoot, gradleInvocation } from '../lib/discovery.js'

const start = process.argv[2] ?? process.env.MC_TEST_PROJECT
if (start === undefined || !existsSync(start)) {
  console.log('SKIP — 未提供真实 MC 项目路径（参数或 MC_TEST_PROJECT），跳过')
  process.exit(0)
}
const root = findGradleRoot(start)
const inv = gradleInvocation(root)

console.log('gradleRoot =', root)
console.log('invocation =', inv.argv.join(' '))
console.log('')

// ---- 1. 同步探测：wrapper 真的可执行 ----
// --version 不触发依赖解析，是最快能证明“wrapper 可用”的调用。
const version = await runOnce([...inv.argv, '--version', '--console=plain'], inv.cwd, 180000)
console.log('exit code:', version.code)
const out = version.stdout + version.stderr
const gradleLine = out.split(/\r?\n/).find((l) => /Gradle\s+\d/.test(l))
console.log('版本行:', gradleLine ?? '(未找到)')
console.log('')
console.log(version.code === 0 && /Gradle\s+\d/.test(out)
  ? 'PASS — wrapper 可执行，插件能驱动真实 Gradle'
  : `FAIL — wrapper 调用失败\n${out.slice(0, 2000)}`)

// ---- 2. 异步路径：用 RunRegistry 起一个真实 Gradle 调用 ----
const registry = new RunRegistry({ duplicatePolicy: 'reject' })
const job = registry.start({
  task: ':help',
  label: `${root} · help`,
  cwd: inv.cwd,
  argv: [...inv.argv, 'help', '--console=plain'],
  owner: 'session-e2e',
})

console.log('')
console.log('已启动后台任务:', job.job.id)
const settled = await registry.wait(job.job.id, 300000, 'session-e2e')
console.log('结算状态:', settled.status, settled.detail ?? '')

const read = registry.read(job.job.id, 'session-e2e')
const text = read.text
// help 任务会列出可用任务，其中应当包含 runClient / runData。
const hasRunClient = /runClient/.test(text)
const hasRunData = /runData/.test(text)
console.log('输出含 runClient:', hasRunClient)
console.log('输出含 runData  :', hasRunData)
console.log('输出字节数      :', text.length)

// ---- 3. 并发策略在真实场景下的表现 ----
const again = registry.start({
  task: ':help',
  label: 'dup',
  cwd: inv.cwd,
  argv: [...inv.argv, 'help', '--console=plain'],
})
console.log('')
console.log(again.reused === true ? 'PASS — 同名任务被复用（reject 策略下首个已结算，故允许新建）' : '新建了任务:', again.job.id)

registry.dispose()

const allPassed = version.code === 0 && /Gradle\s+\d/.test(out)
  && settled.status === 'completed'
console.log('')
console.log(allPassed ? 'ALL GRADLE E2E TESTS PASSED' : 'GRADLE E2E TEST(S) FAILED')
process.exit(allPassed ? 0 : 1)
