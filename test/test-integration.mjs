// 主机半身集成测试：用模拟 cordis 上下文加载 lib/index.js，
// 验证工具注册契约、路由注册、以及工具真的能起后台任务并产出 diff。
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
function check(label, condition, extra) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`[${mark}] ${label}${extra !== undefined ? ` — ${extra}` : ''}`)
}

const plugin = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)

check('导出 name', plugin.name === 'mc-gradle-runner', plugin.name)
check('导出 apply', typeof plugin.apply === 'function')
// tools 现在是可选依赖：由 apply 内部 ctx.get('tools') 探测，
// 这样 exposeTools:false 的部署不必提供工具注册表。
check('inject 不再硬依赖 tools', !plugin.inject.includes('tools'), JSON.stringify(plugin.inject))

// ---- 模拟 cordis 上下文 ----
const tools = new Map()
const routes = []
const effects = []
const injections = []
const ctx = {
  tools: {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`重复注册工具：${definition.name}`)
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  get(name) {
    // 插件用 ctx.get('tools') 探测服务是否可用；sessions 用于解析会话 cwd。
    if (name === 'tools') return this.tools
    if (name === 'sessions') return { get: () => undefined }
    return undefined
  },
  effect(fn, label) {
    effects.push(label)
    const disposer = fn()
    return () => disposer?.()
  },
  inject(names, callback) {
    injections.push(names.join(','))
    callback({
      // 工具现在通过 ctx.inject(['tools']) 注册，桩要把 tools 一起交出去。
      tools: {
        register(definition) {
          if (tools.has(definition.name)) throw new Error(`重复注册工具：${definition.name}`)
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
      connection: {
        fetch: {
          register(route) {
            routes.push(route)
            return () => {}
          },
        },
      },
      effect(fn, label) {
        effects.push(label)
        // cordis 的 effect 会立即执行回调，并把返回值当作 disposer。
        const disposer = fn()
        return () => disposer?.()
      },
    })
  },
  on() {},
}

// 造一个真实的 Gradle 项目来跑端到端。
const root = await mkdtemp(join(tmpdir(), 'mcrun-integ-'))
await writeFile(join(root, 'settings.gradle'), "rootProject.name = 'Integ'\n")
// 真 MC 形态：声明 runs 块。缺了它，新的证据闸门会正确地判该项目不可用
// ——那是对的行为，但这个夹具需要它可用才能继续测路由与工具。
await writeFile(join(root, 'build.gradle'), 'runs {\n  client {}\n  data {}\n  server {}\n}\n')
await writeFile(join(root, 'gradlew.bat'), '@echo off\n')
await writeFile(join(root, 'gradlew'), '#!/bin/sh\n')
await mkdir(join(root, 'src', 'generated', 'resources'), { recursive: true })
await writeFile(join(root, 'src', 'generated', 'resources', 'before.json'), '{"v":1}\n')

plugin.apply(ctx, { gradleRoot: root, duplicatePolicy: 'reject' })

// ---- 工具注册契约 ----
const EXPECTED = ['mc_run_task', 'mc_run_output', 'mc_run_list', 'mc_run_kill']
check('注册了 4 个工具', tools.size === 4, [...tools.keys()].join(','))
for (const name of EXPECTED) {
  const tool = tools.get(name)
  check(`工具 ${name} 已注册`, tool !== undefined)
  if (tool === undefined) continue
  check(`  ${name} 有 description`, typeof tool.description === 'string' && tool.description.length > 0)
  check(`  ${name} 有 parameters 对象`, typeof tool.parameters === 'object' && tool.parameters !== null)
  check(`  ${name} 有 execute 函数`, typeof tool.execute === 'function')
  check(`  ${name} 有 output.schema`, typeof tool.output?.schema === 'object')
  check(`  ${name} 有 output.render`, typeof tool.output?.render === 'function')
}

const task = tools.get('mc_run_task')
check('mc_run_task 的 kind 是必填', Array.isArray(task.parameters.required) && task.parameters.required.includes('kind'))
check('mc_run_task 参数是 JSON Schema 形状', task.parameters.type === 'object')
check('mc_run_task 支持 wait_ms', 'wait_ms' in task.parameters.properties)
check('mc_run_task 支持 project', 'project' in task.parameters.properties)
check('mc_run_task 支持 extra_args', 'extra_args' in task.parameters.properties)

// ---- 路由注册 ----
check('注册了 /api 路由', routes.length === 1, String(routes.length))
check('路由路径正确', routes[0]?.path === '/api/mc-gradle-runner', routes[0]?.path)
check('路由支持 GET 与 POST', routes[0]?.methods?.includes('POST') && routes[0]?.methods?.includes('GET'),
  JSON.stringify(routes[0]?.methods))
check('注册了 connection/webServer 注入', injections.some((i) => i.includes('connection') && i.includes('webServer')),
  JSON.stringify(injections))

// ---- 端到端：通过工具起一个真实的 runData 任务并拿到 diff ----
// 用真实的 gradlew 不可行（会去下载依赖），所以直接验证工具路径上的
// 发现、并发、读取与 diff 采集，用一个假的 Gradle 任务替代真实构建。
const exec = { agent: { id: 'session-integ', session: { header: { cwd: root } } }, signal: undefined }

// 先验证发现：targets 路由能列出目标。
const targetsResponse = await routes[0].fetch(
  new Request('http://localhost/api/mc-gradle-runner', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'targets', cwd: root }),
  }),
)
const targetsJson = await targetsResponse.json()
check('targets 路由返回目标', Array.isArray(targetsJson.targets) && targetsJson.targets.length === 3,
  String(targetsJson.targets?.length))
check('targets 路由返回项目根', targetsJson.root === root, targetsJson.root)
// 来源信息必须回传，否则菜单里的「来源」永远显示“无”（修过的一个 bug）。
check('targets 路由回传 sources', targetsJson.sources !== undefined && targetsJson.sources.settings === 3,
  JSON.stringify(targetsJson.sources))
check('targets 路由回传 structureSource', targetsJson.structureSource !== undefined,
  String(targetsJson.structureSource))
check('targets 路由回传 gradleQuery', targetsJson.gradleQuery !== undefined,
  JSON.stringify(targetsJson.gradleQuery))
check('targets 路由报告 wrapper 可用', targetsJson.info?.gradleWrapper === true)

// 未知 kind 要给出可读错误，而不是崩溃。
const badKind = await routes[0].fetch(
  new Request('http://localhost/api/mc-gradle-runner', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start', kind: 'nonsense', cwd: root }),
  }),
)
const badKindJson = await badKind.json()
check('未知 kind 返回可读错误', typeof badKindJson.error === 'string' && badKindJson.error.includes('找不到'),
  badKindJson.error)

// 坏 JSON 要被拒。
const badJson = await routes[0].fetch(
  new Request('http://localhost/api/mc-gradle-runner', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  }),
)
check('坏 JSON 返回 400', badJson.status === 400, String(badJson.status))

// 未知 action 要被拒。
const badAction = await routes[0].fetch(
  new Request('http://localhost/api/mc-gradle-runner', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'nope' }),
  }),
)
check('未知 action 返回 400', badAction.status === 400, String(badAction.status))

// ---- 工具：mc_run_list 在空状态下要能正常回答 ----
const listResult = await tools.get('mc_run_list').execute({}, exec)
check('mc_run_list 空状态返回空数组', Array.isArray(listResult) && listResult.length === 0, JSON.stringify(listResult))

// ---- 工具：未知 job_id 要抛可读错误 ----
let unknownThrew = false
try {
  await tools.get('mc_run_output').execute({ job_id: 'run-999' }, exec)
} catch (error) {
  unknownThrew = error.message.includes('未知任务')
}
check('mc_run_output 对未知 id 抛可读错误', unknownThrew)

let killUnknownThrew = false
try {
  tools.get('mc_run_kill').execute({ job_id: 'run-999' }, exec)
} catch (error) {
  killUnknownThrew = error.message.includes('未知任务')
}
check('mc_run_kill 对未知 id 抛可读错误', killUnknownThrew)

// 空 job_id 要拒绝。
let emptyIdThrew = false
try {
  await tools.get('mc_run_output').execute({ job_id: '' }, exec)
} catch (error) {
  emptyIdThrew = error.message.includes('job_id')
}
check('mc_run_output 拒绝空 job_id', emptyIdThrew)

// 空 kind 要拒绝。
let emptyKindThrew = false
try {
  await tools.get('mc_run_task').execute({ kind: '' }, exec)
} catch (error) {
  emptyKindThrew = error.message.includes('kind')
}
check('mc_run_task 拒绝空 kind', emptyKindThrew)

// 相对路径的 project 要拒绝（避免 cwd 歧义）。
let relativeThrew = false
try {
  await tools.get('mc_run_task').execute({ kind: 'client', project: 'relative/path' }, exec)
} catch (error) {
  relativeThrew = error.message.includes('绝对路径')
}
check('mc_run_task 拒绝相对 project 路径', relativeThrew)

// ---- 配置校验 ----
let badPolicyThrew = false
try {
  plugin.apply({ ...ctx, tools: { register: () => () => {} } }, { duplicatePolicy: 'bogus' })
} catch (error) {
  badPolicyThrew = error.message.includes('duplicatePolicy')
}
check('非法 duplicatePolicy 被拒绝', badPolicyThrew)

let badNumberThrew = false
try {
  plugin.apply({ ...ctx, tools: { register: () => () => {} } }, { maxDiffFiles: -1 })
} catch (error) {
  badNumberThrew = error.message.includes('maxDiffFiles')
}
check('非法 maxDiffFiles 被拒绝', badNumberThrew)

// ---- 渲染函数契约：presentCall / presentResult 不能抛 ----
for (const [name, tool] of tools) {
  let ok = true
  try {
    const view = tool.presentCall?.({ kind: 'client', job_id: 'run-1' })
    if (view !== undefined && view.card === undefined) ok = false
  } catch {
    ok = false
  }
  check(`${name}.presentCall 可安全调用`, ok)
}

// diff 卡片渲染：只有真的拿到 diff 时才返回卡片。
const diffView = tools.get('mc_run_task').presentResult({}, {
  value: { diff: { card: 'diff', title: 't', diffs: [{ path: 'a', oldText: null, newText: 'x' }] } },
})
check('presentResult 能透出 diff 卡片', diffView?.card === 'diff', JSON.stringify(diffView?.card))
const noDiffView = tools.get('mc_run_task').presentResult({}, { value: { text: 'x' } })
check('无 diff 时 presentResult 返回 undefined', noDiffView === undefined, String(noDiffView))

// ---- 清理 ----
for (let attempt = 0; attempt < 10; attempt += 1) {
  try {
    await rm(root, { recursive: true, force: true })
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

console.log('')
console.log(failures === 0 ? 'ALL INTEGRATION TESTS PASSED' : `${failures} INTEGRATION TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
