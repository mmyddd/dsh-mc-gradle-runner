// 端到端验收 bug 2：走**真实插件工具路径**验证“关闭按钮强制关闭进程”。
//
// 关键：不直接调 registry，而是像按钮/工具那样走 startTask，
// 用插件自己拼出来的 argv（包含 daemonMode 决定的 --no-daemon），
// 然后取消，断言被 Gradle 拉起的游戏进程是否真的死了。
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { copyWrapper, makeChecker } from './helpers/fixtures.mjs'

const { check, finish } = makeChecker()

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

function descendants(rootPid) {
  const script = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
$set = New-Object System.Collections.Generic.HashSet[int]
[void]$set.Add(${rootPid})
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if ($set.Contains([int]$p.ParentProcessId) -and -not $set.Contains([int]$p.ProcessId)) {
      [void]$set.Add([int]$p.ProcessId); $changed = $true
    }
  }
}
$set -join ','
`
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
      .trim().split(',').map(Number).filter(Number.isFinite)
  } catch { return [rootPid] }
}

const plugin = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)

/** 造一个会被 Gradle 拉起长命游戏进程的项目。 */
async function makeProject(root) {
  const gameScript = join(root, 'game.mjs')
  await writeFile(gameScript, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(root, 'game.pid'))}, String(process.pid))
setInterval(() => {}, 1000)
`)
  await writeFile(join(root, 'settings.gradle'), "rootProject.name='Kill'\n")
  await writeFile(join(root, 'build.gradle'), `
tasks.register('runClient') {
  doLast {
    def pb = new ProcessBuilder('${process.execPath.replace(/\\/g, '\\\\')}', '${gameScript.replace(/\\/g, '\\\\')}')
    pb.directory(file('.'))
    def p = pb.start()
    println "game pid=" + p.pid()
    Thread.sleep(60000)
  }
}
`)
  await copyWrapper(root)
}

/** 用插件的 apply 建一个可用上下文，返回它的工具表。 */
function makeCtx() {
  const tools = new Map()
  const ctx = {
    tools: { register: (d) => { tools.set(d.name, d); return () => tools.delete(d.name) } },
    get(name) { return name === 'tools' ? this.tools : undefined },
    effect(fn) { const d = fn(); return () => d?.() },
    // 工具注册走 ctx.inject(['tools'])，桩要把这个服务一起交出去。
    inject(_n, cb) {
      cb({
        tools: { register: (d) => { tools.set(d.name, d); return () => tools.delete(d.name) } },
        connection: { fetch: { register: () => () => {} } },
        effect: (fn) => { fn(); return () => {} },
      })
    },
    logger: { warn() {} },
    on() {},
  }
  return { ctx, tools }
}

const root = await mkdtemp(join(tmpdir(), 'kill-e2e-'))
await makeProject(root)

const { ctx, tools } = makeCtx()
// 用默认配置（daemonMode 应为 no-daemon），这正是按钮与工具共用的路径。
plugin.apply(ctx, { gradleRoot: root })

const exec = { agent: { id: 'kill-session', session: { header: { cwd: root } } }, signal: undefined }

console.log('通过 mc_run_task { kind: "client" } 启动真实 Gradle runClient…')
const started = await tools.get('mc_run_task').execute({ kind: 'client' }, exec)
console.log(`  ${started.text.split('\n')[0]}`)
console.log(`  命令: ${(started.text.match(/命令：(.*)/) ?? [])[1] ?? '(未解析)'}`)
console.log('')

check('启动命令含 --no-daemon（保证进程留在我方进程树）',
  started.text.includes('--no-daemon'), (started.text.match(/命令：(.*)/) ?? [])[1])

// 等游戏进程被拉起。
let gamePid
const deadline = Date.now() + 180000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 800))
  if (existsSync(join(root, 'game.pid'))) {
    const v = Number((await readFile(join(root, 'game.pid'), 'utf8')).trim())
    if (Number.isFinite(v)) { gamePid = v; break }
  }
}
check('游戏进程已被 Gradle 拉起', Number.isFinite(gamePid) && alive(gamePid), `pid=${gamePid}`)

const jobId = started.job.id

// 走按钮/工具的取消路径。
console.log('')
console.log(`调用 mc_run_kill { job_id: "${jobId}" }（按钮走同一条路径）…`)
const killRequestedAt = Date.now()
const killed = await tools.get('mc_run_kill').execute({ job_id: jobId, reason: '用户点了关闭' }, exec)
console.log(`  ${killed.text}`)
console.log('')

/**
 * 轮询到游戏进程真正消失，并记下从「请求取消」到消失的耗时。
 *
 * 这里量的是「用户点完停止要干等多久」，所以必须量到真实时刻：用一个宽裕的
 * 固定 sleep 会把「慢了 5 秒」也判成 PASS，正是本次要修的那个体验。
 * Windows 上停止是直接强杀整棵树（`taskkill` 不带 /F 对 java.exe 不构成温和终止，
 * 那段宽限期纯属空转），所以预算收紧到 2.5 秒；POSIX 仍走 SIGTERM → 5s 宽限 → SIGKILL。
 */
const budgetMs = process.platform === 'win32' ? 2500 : 12000
let gameAlive = alive(gamePid)
while (gameAlive && Date.now() - killRequestedAt < budgetMs) {
  await new Promise((r) => setTimeout(r, 100))
  gameAlive = alive(gamePid)
}
const killedInMs = Date.now() - killRequestedAt

check(
  '点停止后游戏进程立刻被关闭（不再等宽限期）',
  gameAlive === false,
  `pid=${gamePid} alive=${gameAlive} 耗时=${killedInMs}ms 预算=${budgetMs}ms`,
)

const list = await tools.get('mc_run_list').execute({}, exec)
const job = list.find((j) => j.id === jobId)
check('任务已结算为 killed', job?.status === 'killed', `${job?.status} / ${job?.detail ?? ''}`)

if (gameAlive) { try { process.kill(gamePid, 'SIGKILL') } catch {} }
await rm(root, { recursive: true, force: true }).catch(() => {})

process.exit(finish('KILL-E2E TESTS'))
