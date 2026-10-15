// 验证取消是否真的带走整棵进程树，且不会卡在 stopping。
//
// 这是需求“点击关闭按钮应当强制关闭进程”的核心：Gradle 会拉起 java 子进程
// （runClient 还会再拉起游戏进程），只对直接子进程发信号会留下孤儿进程，
// 表现为“按钮显示已停止，但游戏/服务端还在跑”。
//
// 用 node 自身作为负载，并把孙进程 pid 写到文件，从而能精确断言它的生死，
// 不依赖 tasklist / wmic 等外部工具。
import { RunRegistry, killTree } from '../lib/proc.js'
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(label, condition, extra) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${extra !== undefined ? ` — ${extra}` : ''}`)
  if (!condition) failures += 1
}

/** 进程是否还活着（用 signal 0 探测）。 */
function isAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 等到某个 pid 消失，或超时。 */
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return !isAlive(pid)
}

const dir = mkdtempSync(join(tmpdir(), 'mcrun-tree-'))

// 孙进程：持续打印心跳；把自身 pid 写进文件供测试精确断言。
const grandchildScript = join(dir, 'grandchild.mjs')
writeFileSync(grandchildScript, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(dir, 'grandchild.pid'))}, String(process.pid))
setInterval(() => console.log('grandchild-alive'), 200)
`)

// 父进程：起孙进程并**继承 stdio**（模拟 Gradle 与 java 共享管道），自己也打印。
const parentScript = join(dir, 'parent.mjs')
writeFileSync(parentScript, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(dir, 'parent.pid'))}, String(process.pid))
const c = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'inherit' })
setInterval(() => console.log('parent-alive'), 200)
`)

/** 读出负载写下的 pid。 */
function readPid(name) {
  const file = join(dir, name)
  if (!existsSync(file)) return undefined
  const value = Number(readFileSync(file, 'utf8').trim())
  return Number.isFinite(value) ? value : undefined
}

// ---- 1. 温和终止：父进程必须退出，孙进程也必须被带走 ----
{
  const registry = new RunRegistry({})
  const job = registry.start({
    task: ':t:runClient',
    label: 'tree',
    cwd: dir,
    argv: [process.execPath, parentScript],
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const parentPid = readPid('parent.pid')
  const grandchildPid = readPid('grandchild.pid')
  check('父进程 pid 已记录', typeof parentPid === 'number', String(parentPid))
  check('孙进程 pid 已记录', typeof grandchildPid === 'number', String(grandchildPid))
  check('父进程在跑', isAlive(parentPid))
  check('孙进程在跑', isAlive(grandchildPid))

  registry.kill(job.job.id, undefined, '测试强制关闭')
  const settled = await registry.wait(job.job.id, 25000)
  check('取消后任务结算为 killed', settled.status === 'killed', `${settled.status} / ${settled.detail ?? ''}`)

  const parentGone = await waitGone(parentPid, 8000)
  const grandchildGone = await waitGone(grandchildPid, 8000)
  check('父进程已退出', parentGone, `pid=${parentPid}`)
  check('孙进程也被带走（无孤儿）', grandchildGone, `pid=${grandchildPid}`)

  const out = registry.readAll(job.job.id).text
  check('输出捕获到了心跳', out.includes('parent-alive'), JSON.stringify(out.slice(0, 120)))
  registry.dispose()
}

// ---- 2. 父进程先退出、孙进程占住管道时，仍必须结算（不能卡在 stopping） ----
{
  const hogScript = join(dir, 'hog.mjs')
  writeFileSync(hogScript, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const c = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'inherit' })
writeFileSync(${JSON.stringify(join(dir, 'hog.pid'))}, String(c.pid))
setTimeout(() => process.exit(0), 300)
`)
  const registry = new RunRegistry({})
  const job = registry.start({
    task: ':t:runData',
    label: 'hog',
    cwd: dir,
    argv: [process.execPath, hogScript],
  })
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const hogPid = readPid('hog.pid')

  registry.kill(job.job.id, undefined, '兜底测试')
  const settled = await registry.wait(job.job.id, 25000)
  check(
    '父进程已退出但孙进程占管道时仍结算',
    settled.status !== 'running' && settled.status !== 'stopping',
    `${settled.status} / ${settled.detail ?? ''}`,
  )
  if (typeof hogPid === 'number') {
    const gone = await waitGone(hogPid, 8000)
    check('占管道的孙进程也被清理', gone, `pid=${hogPid}`)
  }
  registry.dispose()
}

// ---- 3. killTree 边界 ----
check('killTree(undefined) 返回 false', killTree(undefined, true) === false)
check('killTree 对不存在的 pid 不抛错', typeof killTree({ pid: 999999 }, true) === 'boolean')

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // 忽略清理失败。
}

console.log('')
console.log(failures === 0 ? 'ALL KILL-TREE TESTS PASSED' : `${failures} KILL-TREE TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
