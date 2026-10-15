// 端到端验收新需求 2：走真实插件工具路径，
// 让一个 runClient 任务**真的崩**（写出 crash-report 并打印特征行），
// 断言模型拿到的是「报告路径 + 摘要」，而不是干巴巴的退出码。
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { copyWrapper, makeChecker } from './helpers/fixtures.mjs'

const { check, finish } = makeChecker()

const plugin = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)

const root = await mkdtemp(join(tmpdir(), 'crash-e2e-'))
const crashDir = join(root, 'run', 'crash-reports')
await mkdir(crashDir, { recursive: true })

// runClient：写一份真实的 crash-report，然后按 Forge 的格式打印路径并非零退出。
await writeFile(join(root, 'settings.gradle'), "rootProject.name='CrashE2E'\n")
await writeFile(join(root, 'build.gradle'), `
tasks.register('runClient') {
  doLast {
    def dir = file('run/crash-reports')
    dir.mkdirs()
    def report = new File(dir, 'crash-2026-10-16_00.10.00-client.txt')
    report.text = '''---- Minecraft Crash Report ----
// Hi. I'm Minecraft, and I'm a crashaholic

Time: 2026-10-16 00:10:00
Description: Rendering screen

java.lang.NullPointerException: Cannot invoke "com.example.Thing.getX()" because "thing" is null
\\tat com.ctnh.gtponder.client.PonderScreen.render(PonderScreen.java:88) ~[main/:?]
\\tat net.minecraft.client.gui.screens.Screen.render(Screen.java:120) ~[forge.jar:?]

Suspected Mods:
\\tBetterGregTechPonder (bettergregtechponder)

Crash Report UUID: 11111111-2222-3333-4444-555555555555
'''
    println "---- Minecraft Crash Report ----"
    println "Description: Rendering screen"
    println "java.lang.NullPointerException: Cannot invoke \\"com.example.Thing.getX()\\" because \\"thing\\" is null"
    println "This crash report has been saved to: " + report.absolutePath
    throw new GradleException('simulated client crash')
  }
}
tasks.register('runData') { doLast { println 'data' } }
tasks.register('runServer') { doLast { println 'server' } }
`)
await copyWrapper(root)

const tools = new Map()
const ctx = {
  tools: { register: (d) => { tools.set(d.name, d); return () => tools.delete(d.name) } },
  get(name) { return name === 'tools' ? this.tools : undefined },
  effect(fn) { const d = fn(); return () => d?.() },
  inject(_n, cb) { cb({ connection: { fetch: { register: () => () => {} } }, effect: (fn) => { fn(); return () => {} } }) },
  logger: { warn() {} },
  on() {},
}
plugin.apply(ctx, { gradleRoot: root })

const exec = { agent: { id: 'crash-session', session: { header: { cwd: root } } }, signal: undefined }

console.log('通过 mc_run_task { kind: "client", wait_ms } 跑一个会崩的 runClient…')
const value = await tools.get('mc_run_task').execute({ kind: 'client', wait_ms: 180000 }, exec)
console.log('')
console.log('--- 工具返回文本（模型看到的）---')
console.log(value.text)
console.log('--- 文本结束 ---')
console.log('')

check('任务被标为失败（崩溃本来就是失败）', value.job?.status === 'failed', `${value.job?.status} / ${value.job?.detail}`)
check('返回文本里出现崩溃报告路径', /crash-2026-10-16_00\.10\.00-client\.txt/.test(value.text),
  (value.text.match(/报告路径：[^\n]*/) ?? ['(未找到)'])[0])
check('路径是本次生成的报告', value.text.includes(crashDir), '')
check('摘要含 Description', value.text.includes('Rendering screen'))
check('摘要含异常', value.text.includes('NullPointerException'))
check('摘要含业务栈帧', value.text.includes('PonderScreen.render'))
check('摘要含可疑 mod', value.text.includes('BetterGregTechPonder'))
check('结构化字段 value.crash 存在', value.crash !== undefined)
check('  value.crash.path 指向报告', value.crash?.path === join(crashDir, 'crash-2026-10-16_00.10.00-client.txt'),
  value.crash?.path)
check('  value.crash.exception 已提炼', typeof value.crash?.exception === 'string', value.crash?.exception)

// 崩溃时不应再输出泛泛的“请检查 Gradle 错误”
check('不再出现泛泛的「请检查上方输出里的 Gradle 错误」', !value.text.includes('请检查上方输出里的 Gradle 错误'))

// mc_run_output 也应能取到同一份崩溃信息
const output = await tools.get('mc_run_output').execute({ job_id: value.job.id }, exec)
check('mc_run_output 也带上崩溃路径', /crash-2026-10-16_00\.10\.00-client\.txt/.test(output.text))
check('mc_run_output 也带上结构化 crash', output.crash?.path !== undefined)

// 正常结束的 runData 不应被误判为崩溃
const dataValue = await tools.get('mc_run_task').execute({ kind: 'data', wait_ms: 180000 }, exec)
check('正常结束的任务不误判为崩溃', dataValue.crash === undefined, JSON.stringify(dataValue.crash))

for (let attempt = 0; attempt < 10; attempt += 1) {
  try { await rm(root, { recursive: true, force: true }); break }
  catch { await new Promise((r) => setTimeout(r, 400)) }
}

process.exit(finish('CRASH-E2E TESTS'))
