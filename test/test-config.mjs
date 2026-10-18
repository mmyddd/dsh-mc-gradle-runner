// 验证三项新需求：
//   1. 只有在发现可用的 MC Gradle 目标时才暴露按钮（available 裁决）
//   2. 关闭按钮时强制结束进程树（已由 test-kill-tree 覆盖，这里验证工具侧文案与状态）
//   3. 是否暴露 run* 工具给 agent 可配置
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
function check(label, condition, extra) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${extra !== undefined ? ` — ${extra}` : ''}`)
  if (!condition) failures += 1
}

const plugin = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)

/** 造一个模拟 cordis 上下文，记录工具与路由注册。 */
function makeCtx() {
  const tools = new Map()
  const routes = []
  return {
    tools,
    routes,
    ctx: {
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
      inject(names, callback) {
        callback({
          // 插件现在用 ctx.inject(['tools'], …) 在服务就绪后注册工具，
          // 桩必须把 tools 一起交出去，否则注册那一步会拿到 undefined。
          tools: {
            register(definition) {
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
          effect(fn) {
            fn()
            return () => {}
          },
        })
      },
      logger: { warn() {} },
      on() {},
    },
  }
}

// ---- 1. 工具暴露可配置 ----

// 1a. 默认：5 个工具全部暴露
{
  const { ctx, tools } = makeCtx()
  plugin.apply(ctx, {})
  check('默认暴露全部 5 个工具', tools.size === 5, [...tools.keys()].join(','))
  for (const name of ['mc_run_task', 'mc_run_output', 'mc_run_list', 'mc_run_kill', 'mc_send_command']) {
    check(`  默认含 ${name}`, tools.has(name))
  }
}

// 1b. exposeTools: false → 一个都不注册，但按钮路由仍在
{
  const { ctx, tools, routes } = makeCtx()
  plugin.apply(ctx, { exposeTools: false })
  check('exposeTools=false 时不注册任何工具', tools.size === 0, [...tools.keys()].join(','))
  check('exposeTools=false 时按钮路由仍挂载', routes.length === 1, String(routes.length))
}

// 1c. enabledTools 白名单
{
  const { ctx, tools } = makeCtx()
  plugin.apply(ctx, { enabledTools: ['mc_run_task', 'mc_run_list'] })
  check('enabledTools 只注册列出的工具', tools.size === 2, [...tools.keys()].join(','))
  check('  含 mc_run_task', tools.has('mc_run_task'))
  check('  含 mc_run_list', tools.has('mc_run_list'))
  check('  不含 mc_run_kill', !tools.has('mc_run_kill'))
  check('  不含 mc_run_output', !tools.has('mc_run_output'))
}

// 1d. enabledTools 里的未知名字被忽略，已知的仍生效
{
  const { ctx, tools } = makeCtx()
  plugin.apply(ctx, { enabledTools: ['mc_run_task', 'not_a_tool'] })
  check('enabledTools 忽略未知名字', tools.size === 1 && tools.has('mc_run_task'), [...tools.keys()].join(','))
}

// 1e. enabledTools 全是未知名字 → 明确报错，而不是静默全关
{
  const { ctx } = makeCtx()
  let threw = false
  let message = ''
  try {
    plugin.apply(ctx, { enabledTools: ['nope', 'also_nope'] })
  } catch (error) {
    threw = true
    message = error.message
  }
  check('enabledTools 全未知时报错', threw)
  check('  错误信息列出可用工具名', message.includes('mc_run_task') && message.includes('mc_run_kill'), message)
}

// 1f. showButtons: false → 不挂路由，但工具照常注册
{
  const { ctx, tools, routes } = makeCtx()
  plugin.apply(ctx, { showButtons: false })
  check('showButtons=false 时不挂按钮路由', routes.length === 0, String(routes.length))
  check('showButtons=false 时工具仍注册', tools.size === 5, String(tools.size))
}

// 1g. 两者都关 → 都不注册，且不抛错
{
  const { ctx, tools, routes } = makeCtx()
  plugin.apply(ctx, { showButtons: false, exposeTools: false })
  check('两个开关都关时不注册任何东西', tools.size === 0 && routes.length === 0,
    `tools=${tools.size} routes=${routes.length}`)
}

// 1h. 非布尔值必须被拒绝（"false" 字符串不能被当成真值）
for (const [key, value] of [['exposeTools', 'false'], ['showButtons', 0]]) {
  const { ctx } = makeCtx()
  let threw = false
  try {
    plugin.apply(ctx, { [key]: value })
  } catch {
    threw = true
  }
  check(`${key} 拒绝非布尔值 ${JSON.stringify(value)}`, threw)
}

// 1i. 没有 tools 服务时不抛错（工具是可选依赖）
{
  const tools = new Map()
  const routes = []
  const ctx = {
    get: () => undefined,
    effect: (fn) => { fn(); return () => {} },
    inject: (_names, cb) => cb({
      connection: { fetch: { register: (r) => { routes.push(r); return () => {} } } },
      effect: (fn) => { fn(); return () => {} },
    }),
    logger: { warn() {} },
    on() {},
  }
  let threw = false
  try {
    plugin.apply(ctx, {})
  } catch {
    threw = true
  }
  check('缺少 tools 服务时不抛错', !threw)
  check('  按钮路由仍然挂载', routes.length === 1, String(routes.length))
  check('  inject 不再硬依赖 tools', !plugin.inject.includes('tools'), JSON.stringify(plugin.inject))
}

// ---- 2. available 裁决：只有真的发现 MC Gradle 目标才可用 ----
{
  const { ctx, routes } = makeCtx()
  plugin.apply(ctx, {})
  const route = routes[0]

  /** 调一次 targets 路由。 */
  const targetsFor = async (cwd) => {
    const response = await route.fetch(new Request('http://localhost/api/mc-gradle-runner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'targets', cwd }),
    }))
    return response.json()
  }

  const base = await mkdtemp(join(tmpdir(), 'mcrun-avail-'))

  // 2a. 完全不是 Gradle 项目 → available:false，且 targets 必须为空
  const plain = join(base, 'plain-dir')
  await mkdir(plain, { recursive: true })
  await writeFile(join(plain, 'readme.txt'), 'just a folder\n')
  const plainResult = await targetsFor(plain)
  check('非 Gradle 目录 available=false', plainResult.available === false, JSON.stringify(plainResult.available))
  check('非 Gradle 目录 targets 为空（不再编造任务名）', plainResult.targets.length === 0,
    JSON.stringify(plainResult.targets.map((t) => t.task)))
  check('非 Gradle 目录给出不可用原因', typeof plainResult.unavailableReason === 'string'
    && plainResult.unavailableReason.includes('Gradle'), plainResult.unavailableReason)

  // 2b. 是 Gradle 项目但没有任何 run 能力证据 → **仍然不可用**。
  //     这正是用户报的 bug：早先只要"是 Gradle 项目"就补上三个标准任务名，
  //     于是普通 Java 库项目也长出按钮，点下去必然失败。
  const noRuns = join(base, 'no-runs')
  await mkdir(join(noRuns, 'sub'), { recursive: true })
  await writeFile(join(noRuns, 'settings.gradle'), "rootProject.name = 'NoRuns'\ninclude 'sub'\n")
  await writeFile(join(noRuns, 'build.gradle'), '// 普通聚合器，与 MC 无关\n')
  await writeFile(join(noRuns, 'sub', 'build.gradle'), "plugins { id 'java-library' }\n")
  const noRunsResult = await targetsFor(noRuns)
  check('纯 Java 多模块项目 available=false（不产出假 run 任务）',
    noRunsResult.available === false, JSON.stringify(noRunsResult.available))
  check('  且 targets 为空', noRunsResult.targets.length === 0,
    noRunsResult.targets.map((t) => t.task).join(',') || '(empty)')

  // 2b-2. 加上 MC 证据后必须立刻可用：证明闸门认的是证据，不是项目名字。
  await writeFile(join(noRuns, 'sub', 'build.gradle'),
    "plugins { id 'net.neoforged.moddev' }\nruns { client {} data {} server {} }\n")
  const withRunsResult = await targetsFor(noRuns)
  check('同一项目加上 runs 证据后 available=true',
    withRunsResult.available === true, JSON.stringify(withRunsResult.available))

  // 2c. 真正的单模块 MC 项目 → available:true，且带 wrapper 信息
  const mc = join(base, 'mc-project')
  await mkdir(join(mc, 'src', 'generated', 'resources'), { recursive: true })
  await writeFile(join(mc, 'settings.gradle'), "rootProject.name = 'McMod'\n")
  await writeFile(join(mc, 'build.gradle'), 'runs {\n  client {}\n  data {}\n  server {}\n}\n')
  await writeFile(join(mc, 'gradlew.bat'), '@echo off\n')
  await writeFile(join(mc, 'gradlew'), '#!/bin/sh\n')
  const mcResult = await targetsFor(mc)
  check('MC 项目 available=true', mcResult.available === true, JSON.stringify(mcResult.available))
  check('MC 项目报告有 wrapper', mcResult.hasWrapper === true, String(mcResult.hasWrapper))
  check('MC 项目列出 3 个 run 目标', mcResult.targets.length === 3,
    mcResult.targets.map((t) => t.task).join(','))

  await rm(base, { recursive: true, force: true }).catch(() => {})
}

console.log('')
console.log(failures === 0 ? 'ALL CONFIG TESTS PASSED' : `${failures} CONFIG TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
