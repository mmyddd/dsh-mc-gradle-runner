/**
 * lib/command.js 的测试。
 *
 * 这一层存在的理由是「错了看不出来」：工具照样返回成功、面板照样提示已发送，
 * 只有游戏里什么都没发生。所以每条规则都单独钉死，而不是靠端到端碰运气。
 *
 * 两个重点：
 *   1. 写入目标的选择——挑错任务会把字节写进一个没人读的管道。
 *   2. 回执的归属——只看写入之后新出现的行，否则上一条命令的回执会被当成这次的结果。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunRegistry } from '../lib/proc.js'
import {
  awaitBridgeReceipt,
  clampNumber,
  findReceipt,
  resolveInputTarget,
} from '../lib/command.js'

const failures = []
let checks = 0

function check(label, ok, detail) {
  checks += 1
  if (ok) {
    console.log(`[PASS] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  } else {
    failures.push(label)
    console.log(`[FAIL] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- clampNumber ----
check('clampNumber 缺失时用默认值', clampNumber(undefined, 2000, 0, 10_000) === 2000)
check('clampNumber 非数字时用默认值', clampNumber('abc', 2000, 0, 10_000) === 2000)
check('clampNumber 夹上界', clampNumber(999_999, 2000, 0, 10_000) === 10_000)
check('clampNumber 夹下界', clampNumber(-5, 2000, 0, 10_000) === 0)
check('clampNumber 保留合法值', clampNumber(500, 2000, 0, 10_000) === 500)
check('clampNumber 0 是合法值而非缺失', clampNumber(0, 2000, 0, 10_000) === 0)

// ---- findReceipt ----
const NOISE = 'Starting a Gradle Daemon\n> Task :runClient\n'
check('findReceipt 没有回执时返回 undefined',
  findReceipt(NOISE, 0) === undefined)
check('findReceipt 能认出回执行',
  findReceipt(`${NOISE}[mc-console] 已交给客户端：list\n`, 0)
    === '[mc-console] 已交给客户端：list')

// 核心规则：写入之前就存在的回执不属于这一次。
const withOld = `${NOISE}[mc-console] 已交给客户端：help\n`
check('findReceipt 忽略写入之前就有的回执',
  findReceipt(withOld, withOld.length) === undefined,
  String(findReceipt(withOld, withOld.length)))
check('findReceipt 只认 from 之后的第一条',
  findReceipt(`${withOld}[mc-console] 已交给客户端：list\n`, withOld.length)
    === '[mc-console] 已交给客户端：list')
check('findReceipt 对 from 越界（输出被截断）不抛错',
  findReceipt('[mc-console] 已交给客户端：list\n', 9_999) === undefined)
check('findReceipt 对非字符串输入返回 undefined', findReceipt(undefined, 0) === undefined)
check('findReceipt 不把乱码行当成回执',
  findReceipt(`${NOISE}mc-console 没方括号\n`, 0) === undefined)

// ---- resolveInputTarget：假注册表 ----
const job = (over) => ({ id: 'run-1', task: 'runClient', startedAt: 1, canInput: true, ...over })

const fakeRegistry = (jobs) => ({
  get: (id, owner) => jobs.find((one) => one.id === id && (owner === undefined || true)),
  list: () => jobs,
})

check('给了 job_id 时用它', resolveInputTarget(fakeRegistry([job({})]), 'o', 'run-1').id === 'run-1')
check('未知 job_id 直接抛错（不静默降级成别的任务）', (() => {
  try {
    resolveInputTarget(fakeRegistry([job({})]), 'o', 'run-nope')
    return false
  } catch (error) {
    return error.message.includes('run-nope')
  }
})())

// 不可交互的任务必须拒绝，且理由原样来自任务本身（谁拒绝谁解释）。
const notReadable = { blocked: undefined }
notReadable.blocked = resolveInputTarget(
  fakeRegistry([job({ canInput: false, inputReason: '客户端不读标准输入' })]), 'o', 'run-1')
check('不可交互的任务返回 blocked', typeof notReadable.blocked.blocked === 'string')
check('  blocked 沿用任务给的 inputReason',
  notReadable.blocked.blocked === '客户端不读标准输入', notReadable.blocked.blocked)

check('没有可交互任务时提示先起任务', (() => {
  const result = resolveInputTarget(fakeRegistry([job({ canInput: false })]), 'o', undefined)
  return typeof result.blocked === 'string' && result.blocked.includes('mc_run_task')
})())

check('省略 job_id 时选最近启动的可交互任务', (() => {
  const jobs = [
    job({ id: 'old', startedAt: 100 }),
    job({ id: 'new', startedAt: 300 }),
    job({ id: 'done', startedAt: 500, canInput: false }),
  ]
  return resolveInputTarget(fakeRegistry(jobs), 'o', undefined).id === 'new'
})())

check('省略 job_id 时跳过不可交互的那些', (() => {
  const jobs = [job({ id: 'only-interactive', startedAt: 100 }), job({ id: 'data', startedAt: 900, canInput: false })]
  return resolveInputTarget(fakeRegistry(jobs), 'o', undefined).id === 'only-interactive'
})())

// ---- 成功路径：真子进程读 stdin，回执也真的走到 readAll ----
//
// 子进程把收到的行回显成 `[mc-console] 已交给客户端：<行>`，模拟桥的行为。
const CHILD = `
process.stdout.write('[child] ready\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line.length === 0) continue
    if (line === 'quit') { process.exit(0) }
    process.stdout.write('[mc-console] 已交给客户端：' + line + '\\n')
  }
})
`

const root = mkdtempSync(join(tmpdir(), 'mc-command-test-'))
const registry = new RunRegistry({ outputLimitBytes: 1 << 20, duplicatePolicy: 'allow' })

async function waitForOutput(id, needle, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const read = registry.readAll(id, 'owner')
    if (read?.text.includes(needle)) return read.text
    await sleep(100)
  }
  return undefined
}

try {
  const started = registry.start({
    task: 'runClient',
    label: 'command-test',
    owner: 'owner',
    cwd: root,
    argv: [process.execPath, '--input-type=module', '-e', CHILD],
    inputConsumer: 'stdio',
  })
  const id = started.job.id

  const ready = await waitForOutput(id, '[child] ready')
  check('子进程起来了（后面几条才有意义）', ready !== undefined)

  // 第一次写入：写入前长度是 ready 时的长度，回执应当是本次的。
  const before = registry.readAll(id, 'owner').text.length
  registry.write(id, 'owner', 'list')
  const first = await awaitBridgeReceipt(registry, id, 'owner', before, 10_000)
  check('写入后能等到游戏侧回执', typeof first === 'string', String(first))
  check('回执内容对得上这次写的命令',
    typeof first === 'string' && first.includes('list'), String(first))

  // 第二次写入：用第一次回执之后的长度作起点，必须拿到新的那条，
  // 而不是又把第一条回执返回一遍。这是「回执归属」规则的真实回归。
  const afterFirst = registry.readAll(id, 'owner').text.length
  registry.write(id, 'owner', '/time set day')
  const second = await awaitBridgeReceipt(registry, id, 'owner', afterFirst, 10_000)
  check('第二条命令拿到的是自己的回执',
    typeof second === 'string' && second.includes('time set day'), String(second))
  check('第二条回执不是第一条的重复',
    second !== first, `${first} vs ${second}`)

  // 超时必须老实返回 undefined，不能编一个回执出来。
  const lengthNow = registry.readAll(id, 'owner').text.length
  const timedOut = await awaitBridgeReceipt(registry, id, 'owner', lengthNow, 300)
  check('没有新回执时超时返回 undefined', timedOut === undefined, String(timedOut))

  // 已取消的 signal 不该继续等。
  const aborted = await awaitBridgeReceipt(registry, id, 'owner', lengthNow, 10_000, { aborted: true })
  check('取消信号立刻结束等待', aborted === undefined)

  registry.kill(id, 'owner', '测试收尾')
  await sleep(1500)
} finally {
  registry.dispose()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true })
      break
    } catch {
      await sleep(200)
    }
  }
}

console.log('')
console.log(failures.length === 0
  ? `ALL COMMAND TESTS PASSED (${checks})`
  : `${failures.length} COMMAND TEST(S) FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
