// 端到端验收：走完整条链路
//   工具 mc_run_task { kind:'data' }
//     → 发现 Gradle 根与 runData 目标
//     → 启动前拍产物快照
//     → 真实执行 gradlew runData（一个真的会写文件的 Gradle 任务）
//     → 结算后比对产物
//     → 返回 diff 卡片（presentResult 渲染用的结构）
//
// 用一个自包含的最小 MC 风格项目，避免依赖网络与 ModDevGradle。
// 关键点：runData 是**真实的 Gradle 任务**，产物是**真实的文件变化**。
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { copyWrapper, makeChecker } from './helpers/fixtures.mjs'

const { check, finish } = makeChecker()

const plugin = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)

// 造一个最小但真实的 MC 风格 Gradle 项目。
//
// 刻意**不写** `runs { }` 块：那是 NeoForge ModDevGradle 的 DSL，离线环境拉不到
// 那个插件，构建会直接失败。改为注册真实的 runClient/runData/runServer 任务，
// 它们既是合法的 Gradle 任务（Gradle 真的会执行），又让 discovery 的
// `rootDeclaresRuns`（匹配 runClient/runData/runServer 字面量）认出这是可运行项目。
const root = await mkdtemp(join(tmpdir(), 'mcrun-e2e-'))
await writeFile(join(root, 'settings.gradle'), "rootProject.name = 'E2EMod'\n")
await writeFile(join(root, 'gradle.properties'), 'org.gradle.jvmargs=-Xmx512m\n')
await writeFile(join(root, 'build.gradle'), `
tasks.register('runData') {
  doLast {
    def out = file('src/generated/resources')
    out.mkdirs()
    // 新增一个文件
    new File(out, 'added.json').text = '{"added": true}\\n'
    // 修改一个既有文件
    new File(out, 'modified.json').text = '{"version": 2}\\n'
    // 删除一个既有文件
    new File(out, 'removed.json').delete()
    println 'runData wrote generated resources'
  }
}

tasks.register('runClient') { doLast { println 'client (stub)' } }
tasks.register('runServer') { doLast { println 'server (stub)' } }
`)
// 复制一份 wrapper，让插件走真实的 gradlew 路径。
await copyWrapper(root)

// 预置产物：一个会被改、一个会被删。
await mkdir(join(root, 'src', 'generated', 'resources'), { recursive: true })
await writeFile(join(root, 'src', 'generated', 'resources', 'modified.json'), '{"version": 1}\n')
await writeFile(join(root, 'src', 'generated', 'resources', 'removed.json'), '{"obsolete": true}\n')
// .cache 必须被排除，不应出现在 diff 里。
await mkdir(join(root, 'src', 'generated', 'resources', '.cache'), { recursive: true })
await writeFile(join(root, 'src', 'generated', 'resources', '.cache', 'internal.bin'), 'noise\n')

// ---- 模拟 cordis 上下文 ----
const tools = new Map()
const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  get(name) {
    if (name === 'tools') return this.tools
    return undefined
  },
  effect(fn) {
    const disposer = fn()
    return () => disposer?.()
  },
  inject(_names, cb) {
    cb({ connection: { fetch: { register: () => () => {} } }, effect: (fn) => { fn(); return () => {} } })
  },
  logger: { warn() {} },
  on() {},
}

plugin.apply(ctx, { gradleRoot: root, duplicatePolicy: 'reject' })

const task = tools.get('mc_run_task')
check('mc_run_task 已注册', task !== undefined)

const exec = { agent: { id: 'session-e2e', session: { header: { cwd: root } } }, signal: undefined }

// ---- 走完整条链路：kind=data，等到结束 ----
console.log('')
console.log('正在通过 mc_run_task { kind: "data", wait_ms: 300000 } 跑真实 Gradle…')
const t0 = Date.now()
const value = await task.execute({ kind: 'data', wait_ms: 300000 }, exec)
const elapsed = Date.now() - t0
console.log(`耗时 ${elapsed}ms`)
console.log('')

// ---- 断言 ----
check('工具返回了文本结果', typeof value.text === 'string' && value.text.length > 0)
check('任务成功结束', value.job?.status === 'completed', `${value.job?.status} / ${value.job?.detail ?? ''}`)
check('任务名是 runData', value.job?.task === ':runData', value.job?.task)
check('输出里能看到 Gradle 的执行痕迹', value.text.includes('runData wrote generated resources')
  || value.text.includes('BUILD SUCCESSFUL'), value.text.slice(-300))

// diff 卡片：这是"模型能看到 diff 展示"的落点。
check('返回了 diff 卡片', value.diff?.card === 'diff', JSON.stringify(value.diff?.card))
check('diff 卡片有标题', typeof value.diff?.title === 'string' && value.diff.title.length > 0, value.diff?.title)
check('diff 卡片带 diffs 数组', Array.isArray(value.diff?.diffs) && value.diff.diffs.length > 0,
  String(value.diff?.diffs?.length))

const paths = (value.diff?.diffs ?? []).map((d) => d.path)
check('识别出新增文件 added.json', paths.some((p) => p.endsWith('added.json')), paths.join(', '))
check('识别出修改文件 modified.json', paths.some((p) => p.endsWith('modified.json')), paths.join(', '))
check('.cache 被排除在 diff 之外', !paths.some((p) => p.includes('.cache')), paths.join(', '))

// 内容级校验：修改后的文件内容必须真的出现在 diff 里。
const modified = (value.diff?.diffs ?? []).find((d) => d.path.endsWith('modified.json'))
check('修改文件的旧内容正确', modified?.oldText?.includes('"version": 1'), JSON.stringify(modified?.oldText))
check('修改文件的新内容正确', modified?.newText?.includes('"version": 2'), JSON.stringify(modified?.newText))

const added = (value.diff?.diffs ?? []).find((d) => d.path.endsWith('added.json'))
check('新增文件的 oldText 为 null（表示新建）', added?.oldText === null, JSON.stringify(added?.oldText))
check('新增文件的新内容正确', added?.newText?.includes('"added": true'), JSON.stringify(added?.newText))

// 文本摘要也要有（模型读的是文本，卡片是给人看的）。
check('文本里含产物 diff 摘要', value.text.includes('产物变更'), value.text.slice(-400))
check('摘要说明新增/修改/删除的数量', /新增 \d+ · 修改 \d+ · 删除 \d+/.test(value.text),
  (value.text.match(/产物变更[^\n]*/) ?? ['(未找到)'])[0])

// presentResult 必须能把这个 diff 渲染成卡片。
const rendered = task.presentResult({ kind: 'data' }, { value })
check('presentResult 渲染出 diff 卡片', rendered?.card === 'diff', JSON.stringify(rendered?.card))
check('presentResult 保留了 diffs', Array.isArray(rendered?.diffs) && rendered.diffs.length > 0)

// ---- mc_run_output 也应能读到同一个任务的 diff ----
const output = await tools.get('mc_run_output').execute({ job_id: value.job.id }, exec)
check('mc_run_output 能读到任务', typeof output.text === 'string')
check('mc_run_output 也带上 diff 卡片', output.diff?.card === 'diff', JSON.stringify(output.diff?.card))

// ---- mc_run_list 应列出这个任务 ----
const list = await tools.get('mc_run_list').execute({}, exec)
check('mc_run_list 列出该任务', Array.isArray(list) && list.some((j) => j.id === value.job.id),
  JSON.stringify(list.map((j) => j.id)))

// ---- 清理 ----
for (let attempt = 0; attempt < 10; attempt += 1) {
  try {
    await rm(root, { recursive: true, force: true })
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

process.exit(finish('E2E CHAIN TESTS'))
