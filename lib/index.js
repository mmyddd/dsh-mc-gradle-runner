/**
 * dsh-mc-gradle-runner —— 主机半身。
 *
 * 两件事：
 *   1. 向模型注册 5 个工具：mc_run_task / mc_run_output / mc_run_list /
 *      mc_run_kill / mc_send_command。
 *      `mc_run_task` 在后台起 Gradle run* 任务，不阻塞前台；runData 完成后自动采集并展示 diff。
 *      `mc_send_command` 把一行内容送进正在跑的游戏进程（面板输入框的模型侧等价物）。
 *   2. 为浏览器半身的会话头部按钮暴露一条 HTTP 路由：列目标、起任务、读状态。
 *      工作区确实是可运行的 MC 项目时，还会向系统提示词注入一段工具用法说明。
 *
 * 依赖处理：本插件**不** import 任何 `@deepseek-ai/*` 包。
 * 外部插件无法假定 profile 里能解析官方运行时包（实测 `@deepseek-ai/dsh-tools`、
 * `@deepseek-ai/dsh-jobs` 在 profile 的 node_modules 里都不可解析），
 * 因此这里直接给出 `ToolDefinition` 的字面量形状——注册表只要求这个形状，
 * `defineTool` 只是官方的类型辅助。同理，配置不导出 schemastery schema，
 * 而是自己做默认值与校验，这样插件在任意 profile 里都能加载。
 *
 * @module dsh-mc-gradle-runner
 */

import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import {
  assessRoot,
  discoverTargets,
  findGradleRoot,
  gradleInvocation,
  looksLikeGradleRoot,
  projectDir,
  projectName,
  queryGradleTasks,
  resolveTarget,
} from './discovery.js'
import { collectDiff, collectGitDiff, createSnapshot, renderDiffSummary } from './diff.js'
import { detectCrash, locateCrashReport, renderCrashSummary, summarizeCrashReport } from './crash.js'
import { RunRegistry, publicView, runOnce } from './proc.js'
import { consoleBridgeJar, bridgePlan, BRIDGE_ENV } from './bridge.js'
import { createGuidanceProvider, installGuidance } from './prompt.js'
import { awaitBridgeReceipt, clampNumber, resolveInputTarget } from './command.js'

/** 插件名，同时是 cordis 配置项的 id。 */
export const name = 'mc-gradle-runner'

/**
 * 需要的服务。
 *
 * `tools` **不是**硬依赖：`exposeTools: false` 时插件不该要求工具注册表存在。
 * 因此这里只声明空注入，工具注册改由 `apply` 内部检查 `ctx.get('tools')` 决定，
 * 这样“只想要按钮、不要工具”的部署也能正常加载。
 * `webServer` 与 `connection` 只用于给浏览器半身开路由，同样按需注入。
 */
export const inject = []

/**
 * 插件配置的运行时 schema。
 *
 * **必须导出**：DSH 的插件配置页只渲染这里声明的字段。早先版本刻意不导出
 * （为了在没有任何依赖的 profile 里也能加载），代价是配置页里**看不到任何开关**——
 * 用户反馈过这个问题，所以现在补上。
 *
 * 依赖 `@deepseek-ai/schemastery`，但**不在 import 阶段解析**：解析失败或版本过旧时
 * 退化成 `undefined`，插件其余部分（按钮、工具）照常工作。见 `buildConfig`。
 */
/**
 * 每个配置项的中文说明。字段名 → 说明文字。
 *
 * 单独列出来，是因为下面的 Config 要用两种方式构建（见 `buildConfig`）：
 * 支持 `.volatile()` 的 schemastery 走一遍，不支持的走另一遍，说明文字只有这一份。
 */
const CONFIG_FIELDS = [
  ['enabled', 'bool', true, '是否启用本插件。关闭后按钮与工具都不再出现。'],
  ['gradleRoot', 'string', '', '强制指定的 Gradle 项目根（绝对路径）。留空则从每个会话的工作目录向上自动发现。'],
  ['duplicatePolicy', 'enum', 'reject', '同名任务的并发策略：reject=拒绝并提示；reuse=复用已在跑的；replace=先停旧的；allow=允许多实例。', ['reject', 'reuse', 'replace', 'allow']],
  ['exposeTools', 'bool', true, '是否把 mc_run_* 工具暴露给模型。关闭后按钮照常可用，但模型看不到这些工具。'],
  ['enabledTools', 'strings', [], '只暴露其中几个工具（留空=全部五个）：mc_run_task / mc_run_output / mc_run_list / mc_run_kill / mc_send_command。'],
  ['dataDirs', 'strings', [], '覆盖数据生成产物目录（绝对路径，留空=用内置的四个相对路径）。'],
  ['showButtons', 'bool', true, '是否显示会话头部右上角的 run* 快捷按钮。'],
  ['allowGradleTaskQuery', 'bool', true, '是否允许从菜单里触发 `gradlew tasks` 查询权威任务清单（一次约 7 秒，结果会缓存）。'],
  ['daemonMode', 'enum', 'no-daemon', 'Gradle 守护进程策略。no-daemon 保证关闭按钮能杀掉整个进程树；daemon 启动更快但会留下游戏进程。', ['no-daemon', 'daemon']],
  ['buttonOrder', 'number', -100, '按钮在右上角控件组里的排序，越小越靠左（该槽位现有控件最小为 -10）。'],
  ['maxDiffFiles', 'number', 40, 'runData 的 diff 最多展开多少个文件。', undefined, 1],
  ['diffMaxBytes', 'number', 512 * 1024, '单个文件参与 diff 的字节上限。', undefined, 1],
  ['snapshotTextBudgetBytes', 'number', 64 * 1024 * 1024, '快照保留旧内容的累计字节上限；超出预算的文件仍参与增删改判定，只是没有内容级 diff。', undefined, 0],
  ['diffHunkLines', 'number', 40, '每个变更文件最多展示多少行实际改动内容（runData 反馈的详细程度）。', undefined, 0],
  ['outputLimitBytes', 'number', 4 * 1024 * 1024, '单个任务在内存里保留的输出上限，超出丢弃最旧的部分。', undefined, 1],
  ['logTailLines', 'number', 500, '右侧栏日志面板最多显示多少行（只取最后 N 行，其余丢弃）。调大更完整但更吃内存。', undefined, 1],
  ['dataTimeoutMs', 'number', 120_000, 'runData 结束后收集 diff 的等待上限（毫秒）。', undefined, 1],
  ['taskQueryCacheMs', 'number', 300_000, '权威任务清单的缓存时长（毫秒）。', undefined, 0],
  ['taskQueryTimeoutMs', 'number', 180_000, '向 Gradle 查询任务清单的超时上限（毫秒）。', undefined, 0],
  ['gitBin', 'string', 'git', 'git 可执行文件；用于给 runData 的 diff 补充工作区改动。'],
  ['forwardStdin', 'bool', true, '是否用 -I 注入初始化脚本，把标准输入转发给被拉起的游戏 JVM（关闭后面板里的控制台命令将无法到达游戏）。'],
]

/**
 * 按需拿到 schemastery。
 *
 * 不写成顶层 `import z from '@deepseek-ai/schemastery'`：那样一旦解析不到，
 * **整个插件**在 import 阶段就抛错、连按钮一起消失。这里改成运行期解析，
 * 拿不到只是没有配置 schema，插件其余部分照常工作。
 */
function loadZ() {
  try {
    return createRequire(import.meta.url)('@deepseek-ai/schemastery')
  } catch {
    return undefined
  }
}

/**
 * 构建配置 schema。
 *
 * 关键：`.volatile()` **是 3.18.3 才加的**。peer 范围若写成 `^3.18.0`，
 * pnpm 会解析到 3.18.1，于是 `z.boolean().default(true).volatile` 不是函数，
 * import 阶段直接抛 TypeError —— 插件整个装不上。
 *
 * 所以这里探测 `volatile` 是否存在：有就逐个字段标上（配置页才出表单），
 * 没有就退化成普通 schema（配置页不出表单，但插件能用）。
 */
function buildConfig() {
  const z = loadZ()
  if (z === undefined) return undefined
  const canVolatile = typeof z.boolean().default(true).volatile === 'function'
  const out = {}
  for (const [key, kind, fallback, description, choices, min] of CONFIG_FIELDS) {
    let field
    if (kind === 'bool') field = z.boolean().default(fallback)
    else if (kind === 'string') field = z.string().default(fallback)
    else if (kind === 'strings') field = z.array(z.string()).default(fallback)
    else if (kind === 'number') field = z.number().default(fallback)
    else if (kind === 'enum') field = z.union(choices.map((one) => z.const(one))).default(fallback)
    else throw new Error(`未知的配置字段类型：${kind}`)
    if (min !== undefined) field = field.min(min)
    if (canVolatile) field = field.volatile()
    out[key] = field.description(description)
  }
  return z.object(out)
}

/** 对外的配置 schema。schemastery 缺失时为 undefined（见 `buildConfig`）。 */
export const Config = buildConfig()

/** 默认配置。所有项都可以在 cordis.patch.yml 里覆盖。 */
const DEFAULTS = {
  /** 总开关：关闭后按钮与工具都不装载。 */
  enabled: true,
  /** 强制指定的 Gradle 根；留空则从会话工作目录向上自动发现。 */
  gradleRoot: undefined,
  /** 同名任务并发策略：reject | reuse | replace | allow。 */
  duplicatePolicy: 'reject',
  /** 单个任务在内存里保留的输出上限。 */
  outputLimitBytes: 4 * 1024 * 1024,
  /**
   * 右侧栏日志面板最多显示多少行。
   *
   * 面板每秒轮询一次，若每次都把完整缓冲（最多 outputLimitBytes，4 MB）
   * 传给浏览器并逐行建 DOM，长跑的 runClient 会直接把页面撑到 OOM。
   * 这里按行截断到末尾 N 行——结论与崩溃栈都在尾部。
   */
  logTailLines: 500,
  /** runData 结束后收集 diff 的等待上限。 */
  dataTimeoutMs: 120_000,
  /** diff 里最多展开多少个文件。 */
  maxDiffFiles: 40,
  /** 单个文件参与 diff 的最大字节数。 */
  diffMaxBytes: 512 * 1024,
  /**
   * 快照保留旧内容的累计字节上限。
   *
   * 旧内容必须在任务启动前抓取（否则 oldText 会等于 newText，diff 显示不出变化），
   * 因此要为它设一道总量闸门，避免大型仓库的产物把内存吃掉。
   * 超出预算的文件仍参与新增/删除/修改判定，只是内容级 diff 标为不可用。
   */
  snapshotTextBudgetBytes: 64 * 1024 * 1024,
  /** 每个变更文件最多展示多少行实际改动内容。 */
  diffHunkLines: 40,
  /** git 可执行文件。 */
  gitBin: 'git',
  /**
   * 是否用 `-I` 注入初始化脚本，把 stdin 转发给被拉起的游戏 JVM。
   *
   * 开着才可能有「在面板里敲 MC 命令」这个功能（Gradle 的 JavaExec 默认
   * 不转发 stdin）。关掉就是纯日志面板，输入框会明确说明命令到不了游戏。
   */
  forwardStdin: true,
  /** 会话头部按钮的排序值：越小越靠左。 */
  buttonOrder: -100,
  /** 数据生成产物目录覆盖（绝对路径）；留空则用内置的四个相对路径。 */
  dataDirs: undefined,
  /**
   * 是否把 run* 工具暴露给模型。
   *
   * 这是给部署方的开关：快捷按钮是**人**的入口，工具是**模型**的入口，
   * 两者应当能独立启停。关掉后按钮照常可用，模型看不到任何 mc_run_* 工具，
   * 也就不会自作主张地跑构建。
   */
  exposeTools: true,
  /**
   * 暴露哪些工具（仅在 exposeTools 为 true 时生效）。
   *
   * 省略 = 全部 5 个；给数组则只注册列出的那些。名字用工具名
   * （`mc_run_task` / `mc_run_output` / `mc_run_list` / `mc_run_kill` / `mc_send_command`）。
   * 未知名字会被忽略，避免配置里一个笔误让整个插件加载失败。
   */
  enabledTools: undefined,
  /**
   * 是否暴露会话头部按钮。
   *
   * 与 exposeTools 对称：只想让模型用工具、不想在界面上加控件时关掉它。
   */
  showButtons: true,
  /**
   * 是否允许向 Gradle 查询权威任务列表。
   *
   * 默认开启。这是一次真实 Gradle 调用（本仓库实测约 7 秒），
   * 因此只在你从下拉菜单里点“从 Gradle 刷新任务列表”时才发生，
   * 且结果带缓存。关掉后菜单里不出现该入口，插件永远只做静态发现。
   */
  allowGradleTaskQuery: true,
  /** 权威任务列表的缓存时长（毫秒）。 */
  taskQueryCacheMs: 300_000,
  /** 向 Gradle 查询任务的超时上限（毫秒）。 */
  taskQueryTimeoutMs: 180_000,
  /**
   * Gradle 守护进程策略，直接决定“关闭按钮能否真正关掉游戏进程”。
   *
   *   - `no-daemon`（默认）：构建跑在插件启动的进程树里，取消时 `taskkill /T /F`
   *     能把 java 与游戏一起带走。代价是每次冷启动一个 JVM。
   *   - `daemon`：走 Gradle 默认行为，构建复用长命 daemon、启动更快，
   *     但 daemon 会被 reparent，游戏进程逃出我们的进程树，
   *     此时取消只能杀掉 wrapper，**游戏窗口会留下来**。
   *
   * 默认选 `no-daemon`：这个插件的按钮就叫“关闭”，用户按下它时期望的是进程真的没了。
   */
  daemonMode: 'no-daemon',
}

/** 全部可注册的工具名，按注册顺序。 */
const ALL_TOOLS = ['mc_run_task', 'mc_run_output', 'mc_run_list', 'mc_run_kill', 'mc_send_command']

/** 认得出的 run* 任务名形状：run + 大写开头。与 discovery 保持同一判据。 */
const RUN_TASK_SHAPE = /^run[A-Z]/

/**
 * 权威任务列表的进程内缓存：`<root>::<projectPath>` → `{ at, value }`。
 *
 * 一次 `gradlew tasks` 约 7 秒，而用户在菜单里反复展开是常态，
 * 因此必须有缓存。键里带 projectPath，因为不同项目的任务集合不同。
 */
const taskQueryCache = new Map()

/** cosmokit 用来写 Volatile 的符号；`Symbol.for` 保证跨包副本一致。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 读一个可能被 volatile 包装的配置值。
 *
 * schemastery 的 `.volatile()` 不只是标记：`Schema.resolve()` 会把该字段的**值**
 * 换成 cosmokit 的 `Volatile` 对象（`{get()}`），以便宿主原地热改。于是
 * `apply(ctx, config)` 收到的 `config.enabled` 是对象而不是布尔值，
 * 直接校验会抛「enabled 必须是布尔值，收到 [object Object]」。
 *
 * 这里按 `Symbol.for('cosmokit.volatile.write')` 判定，而不是 import cosmokit——
 * 全局注册的符号跨包副本可识别，插件因此不必新增运行时依赖。
 *
 * @param value 配置里读出来的原始值。
 * @returns 解包后的普通值。
 */
function unwrap(value) {
  let current = value
  // 理论上只有一层；用循环防御性地兼容多层包装。
  while (current !== null && typeof current === 'object' && VOLATILE_WRITE in current) {
    current = current.get()
  }
  return current
}

/** 把用户配置合并到默认值上，并做最小校验。 */
function resolveConfig(raw) {
  // 先逐字段解包 volatile，再做合并与校验——否则校验看到的是包装对象。
  const plain = {}
  for (const [key, value] of Object.entries(raw ?? {})) plain[key] = unwrap(value)
  const config = { ...DEFAULTS, ...plain }
  // schema 会把 gradleRoot 的默认值填成空串、enabledTools/dataDirs 填成空数组。
  // 这些"空"在语义上都等于"没设置"，归一成 undefined，避免下游把它们当成真值。
  if (typeof config.gradleRoot === 'string' && config.gradleRoot.trim().length === 0) {
    config.gradleRoot = undefined
  }
  for (const key of ['enabledTools', 'dataDirs']) {
    if (Array.isArray(config[key]) && config[key].length === 0) config[key] = undefined
  }
  const allowed = ['reject', 'reuse', 'replace', 'allow']
  if (!allowed.includes(config.duplicatePolicy)) {
    throw new Error(
      `mc-gradle-runner: duplicatePolicy 必须是 ${allowed.join(' | ')}，收到 ${JSON.stringify(config.duplicatePolicy)}`,
    )
  }
  for (const key of ['outputLimitBytes', 'dataTimeoutMs', 'maxDiffFiles', 'diffMaxBytes', 'logTailLines']) {
    const value = config[key]
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`mc-gradle-runner: ${key} 必须是正数，收到 ${JSON.stringify(value)}`)
    }
  }
  for (const key of ['taskQueryCacheMs', 'taskQueryTimeoutMs', 'snapshotTextBudgetBytes']) {
    const value = config[key]
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`mc-gradle-runner: ${key} 必须是非负数，收到 ${JSON.stringify(value)}`)
    }
  }
  if (config.gradleRoot !== undefined) {
    if (typeof config.gradleRoot !== 'string' || config.gradleRoot.trim().length === 0) {
      throw new Error('mc-gradle-runner: gradleRoot 必须是非空字符串或省略')
    }
    config.gradleRoot = resolve(expandHome(config.gradleRoot))
  }
  // 工具暴露开关：只接受布尔，避免 "false" 这种字符串被当成真值。
  for (const key of ['enabled', 'exposeTools', 'showButtons', 'allowGradleTaskQuery', 'forwardStdin']) {
    if (typeof config[key] !== 'boolean') {
      throw new Error(`mc-gradle-runner: ${key} 必须是布尔值，收到 ${JSON.stringify(config[key])}`)
    }
  }
  if (!['no-daemon', 'daemon'].includes(config.daemonMode)) {
    throw new Error(
      `mc-gradle-runner: daemonMode 必须是 'no-daemon' 或 'daemon'，收到 ${JSON.stringify(config.daemonMode)}`,
    )
  }
  if (config.enabledTools !== undefined) {
    if (!Array.isArray(config.enabledTools) || config.enabledTools.some((name) => typeof name !== 'string')) {
      throw new Error('mc-gradle-runner: enabledTools 必须是字符串数组或省略')
    }
    // 未知名字忽略而不是报错：配置里一个笔误不该让整个插件加载失败。
    // 但若**全部**名字都无法识别，那是明确的配置错误，必须说出来——
    // 否则用户会以为“关掉了工具”，实际却是名字全写错了。
    const known = config.enabledTools.filter((name) => ALL_TOOLS.includes(name))
    if (known.length === 0) {
      throw new Error(
        `mc-gradle-runner: enabledTools 里没有一个是已知工具。`
        + `可用：${ALL_TOOLS.join(' / ')}；收到：${JSON.stringify(config.enabledTools)}`,
      )
    }
    config.enabledTools = [...new Set(known)]
  }
  return config
}

/** 展开 `~` 前缀。 */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 本插件自带的 Gradle 初始化脚本的绝对路径。
 *
 * 脚本与 index.js 同目录（lib/stdin-init.gradle）。用绝对路径是因为
 * `-I` 由 Gradle 自己按**项目目录**解析相对路径，而我们把 cwd 放在项目根，
 * 相对路径会指向用户仓库里一个不存在的文件。
 *
 * 文件缺失时返回 undefined，调用方据此跳过 `-I`：宁可失去控制台交互，
 * 也不能让整个 run* 任务因为一个丢了的资源文件而跑不起来。
 */
function stdinInitScript() {
  const here = dirname(fileURLToPath(import.meta.url))
  const script = join(here, 'stdin-init.gradle')
  return existsSync(script) ? script : undefined
}

/**
 * 解析一次调用要作用在哪个 Gradle 根上。
 *
 * 优先顺序：调用方显式给的 project 目录 → 配置里的 gradleRoot → 会话 cwd 向上发现。
 * 显式目录允许模型在一个仓库里操作另一棵源码树，但必须是绝对路径，避免相对路径
 * 在不同 cwd 下解析出不同结果。
 *
 * @param config 已解析配置。
 * @param cwd 会话工作目录（来自 session header）。
 * @param project 调用方给的显式目录，可为空。
 */
function resolveRoot(config, cwd, project) {
  if (typeof project === 'string' && project.trim().length > 0) {
    if (!isAbsolute(project)) {
      throw new Error(`project 必须是绝对路径，收到 ${JSON.stringify(project)}`)
    }
    const dir = resolve(expandHome(project))
    if (!looksLikeGradleRoot(dir)) {
      throw new Error(`project 目录里找不到 Gradle 构建脚本：${dir}`)
    }
    return dir
  }
  if (config.gradleRoot !== undefined) return config.gradleRoot
  if (typeof cwd === 'string' && cwd.trim().length > 0) return findGradleRoot(cwd)
  return process.cwd()
}

/**
 * 创建一次 runData 的产物快照。
 *
 * 快照必须在**任务启动前**拍，否则 diff 会漏掉被覆盖的文件。
 * 因此这里在 start 之前调用，并把结果挂在任务记录上。
 *
 * 产物目录是每个子项目各一份的，所以要把 Gradle 根与全部子项目目录一起交给扫描器。
 * CTNH-Modules 的 8000+ 个产物文件全在 `modules/<mod>/src/generated/resources`，
 * 只看根目录会一个都扫不到。
 *
 * @param config 已解析的插件配置（提供 diff 预算）。
 * @param root Gradle 根。
 * @param projectPaths 子项目路径（`:modules:CTNH-Core` 形式）。
 * @param dataDirs 覆盖用的产物目录列表（绝对路径），可为空。
 */
async function snapshotFor(config, root, projectPaths, dataDirs) {
  try {
    const roots = [root, ...projectPaths.map((path) => projectDir(root, path))]
    // 保留旧内容的预算：单文件按 diffMaxBytes，总量按 textBudgetBytes。
    // 预算之外的文件仍参与增删改判定（靠 hash），只是拿不到内容级 diff。
    const snapshot = await createSnapshot(roots, root, {
      maxTextBytes: config.diffMaxBytes,
      textBudgetBytes: config.snapshotTextBudgetBytes,
    })
    if (Array.isArray(dataDirs) && dataDirs.length > 0) {
      // 显式覆盖：用户指定的目录优先，直接按绝对路径重扫。
      snapshot.dirPaths = dataDirs
      snapshot.dirs = dataDirs
      snapshot.files = new Map()
    }
    return snapshot
  } catch (error) {
    return { error: `产物快照失败：${error?.message ?? String(error)}`, files: new Map(), dirs: [], dirPaths: [] }
  }
}

/**
 * 任务结算后的后处理。
 *
 * 两类产物：
 *   - runData → 采集产物 diff（走快照比对 + git 补充）；
 *   - runClient / runServer → 识别崩溃，定位并把 crash-report 摘要给模型。
 *     游戏崩了的时候退出码只是废话，真正的信息在报告里。
 *
 * @param deps 依赖集合。
 * @param job 已结算的任务记录。
 */
async function collectArtifacts(deps, job) {
  const { config } = deps
  const kind = job.target?.kind
  // 崩溃识别对所有 run* 任务都做：runClient 崩了要报告，runServer 同样。
  if (kind === 'client' || kind === 'server' || job.crashCheck !== false) {
    const crash = await detectJobCrash(job)
    if (crash !== undefined) {
      return { kind: 'crash', crash, summary: renderCrashSummary(crash) }
    }
  }
  if (job.snapshot === undefined) return undefined
  const snapshot = job.snapshot
  if (snapshot.error !== undefined) return { error: snapshot.error }
  const result = await collectDiff(snapshot, {
    maxFiles: config.maxDiffFiles,
    maxBytes: config.diffMaxBytes,
  })
  const git = await collectGitDiff(
    (argv, cwd) => runOnce([config.gitBin, ...argv.slice(1)], cwd),
    job.cwd,
  )
  return {
    kind: 'diff',
    ...result,
    git,
    summary: renderDiffSummary(result, git, { maxHunkLines: config.diffHunkLines }),
  }
}

/**
 * 识别一次任务是否崩溃，并给出报告摘要。
 *
 * 两条判据，满足其一即认为崩了：
 *   1. 输出里出现崩溃特征（`---- Minecraft Crash Report ----`、`Crash report saved to:` 等）；
 *   2. 输出没写但磁盘上出现了**本次任务期间**新写的 crash-*.txt——
 *      覆盖“游戏把报告写进文件、但控制台那行被缓冲吞掉”的情况。
 *
 * @param job 已结算的任务记录。
 * @returns 崩溃摘要，或 undefined（没崩）。
 */
async function detectJobCrash(job) {
  const output = job.output ?? ''
  const { crashed, reportedPath } = detectCrash(output)
  const located = await locateCrashReport(job.cwd, {
    reportedPath,
    // 只认任务开始之后写的报告，避免把历史崩溃当成本次结果。
    sinceMs: job.startedAt,
  })
  if (!crashed && located === undefined) return undefined
  if (located === undefined) {
    return {
      path: reportedPath ?? '(未找到报告文件)',
      error: '输出显示发生了崩溃，但没有在 run/crash-reports 下找到本次生成的报告文件。',
    }
  }
  return summarizeCrashReport(located.path)
}

/**
 * 工具输出里附带的产物 diff 结构，供 `presentResult` 渲染 diff 卡片。
 *
 * 只对 `kind === 'diff'` 的产物生效：崩溃产物（kind === 'crash'）没有 diffs，
 * 硬取会抛 TypeError——修过的一个 bug。
 *
 * @param artifacts {@link collectArtifacts} 的产物。
 */
function diffViewFrom(artifacts) {
  if (artifacts === undefined || artifacts.error !== undefined) return undefined
  if (artifacts.kind !== 'diff' || !Array.isArray(artifacts.diffs)) return undefined
  const diffs = artifacts.diffs
    .filter((diff) => diff.kind !== 'removed')
    .map((diff) => ({
      path: diff.path,
      oldText: diff.oldText,
      newText: diff.newText,
    }))
  if (diffs.length === 0) return undefined
  return {
    card: 'diff',
    title: `runData 产物变更（${artifacts.stats.total} 个文件）`,
    diffs,
  }
}

/**
 * 插件的 apply 入口。
 *
 * @param ctx cordis 上下文。
 * @param rawConfig cordis 传入的原始配置。
 */
function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  // 总开关：配置页上的 enabled 关闭后整块功能都不装载（按钮与工具都不出现）。
  if (config.enabled === false) return
  const registry = new RunRegistry({
    outputLimitBytes: config.outputLimitBytes,
    duplicatePolicy: config.duplicatePolicy,
  })
  ctx.effect(() => () => registry.dispose(), 'mc-gradle-runner: 任务注册表清理')

  /** 从工具执行上下文里取会话 cwd。 */
  const cwdOf = (exec) => exec?.agent?.session?.header?.cwd

  /**
   * 起一个 run* 任务（工具与 HTTP 路由共用同一条路径，保证行为一致）。
   *
   * @param options.kind client | data | server，或完整任务名。
   * @param options.project 显式 Gradle 根，可为空。
   * @param options.extraArgs 追加给 Gradle 的参数。
   * @param options.owner 会话 id，用于可见性隔离。
   * @param options.cwd 会话工作目录。
   */
  async function startTask(options) {
    const root = resolveRoot(config, options.cwd, options.project)
    const { targets, projects } = await discoverTargets(root)
    const target = resolveTarget(targets, options.kind, config.preferredProject)
    if (target === undefined) {
      throw new Error(
        `在 ${root} 里找不到 ${JSON.stringify(options.kind)} 对应的 run* 任务。`
        + `已发现：${targets.map((t) => t.task).join(', ') || '(无)'}`,
      )
    }

    const invocation = gradleInvocation(root)
    // runData 的产物快照必须在启动前拍好。
    const snapshot = target.kind === 'data'
      ? await snapshotFor(config, root, projects, config.dataDirs)
      : undefined

    const argv = [...invocation.argv, target.task, '--console=plain']
    // 把标准输入转发给被拉起的游戏 JVM。
    //
    // 这条 `-I` 是本插件「交互式控制台」能成立的前提：Gradle 的 JavaExec
    // **默认不转发 stdin**，光把 spawn 的 stdio 改成 pipe 只能写到 Gradle 自己的
    // System.in，游戏那一侧永远收不到。实测（合成项目，只差这一个参数）：
    //     不加 -I → 写入 ping，子进程 0 行输出，GOT 从未出现
    //     加   -I → GOT:ping / GOT:exit 立刻回显
    // 初始化脚本放在插件自己的 lib/stdin-init.gradle，用绝对路径注入，
    // 不改用户的构建脚本，任何 MC Gradle 项目都能用。
    // 初始化脚本必须在 -I 后面紧跟一个真实存在的路径；
    // 文件缺失时（打包漏了资源）就整条不加，别把 undefined 拼进 argv。
    if (config.forwardStdin !== false) {
      const script = stdinInitScript()
      if (script !== undefined) argv.push('-I', script)
    }
    // 让构建跑在**我们自己的进程树**里。
    //
    // 这是“关闭按钮能强制关掉进程”的关键。默认情况下 `gradlew runClient` 会把
    // 构建交给一个**长命 Gradle daemon**，而 daemon 会被操作系统重新挂到别的父进程下，
    // 于是 runClient 拉起的游戏进程根本不在我们启动的那个 wrapper 的进程树里——
    // 对它做 `taskkill /T /F` 够不到，游戏窗口会留下来。
    // 实测对比（同一套合成项目，只差这个参数）：
    //     默认        → 游戏在树内=false，取消后存活=**true**
    //     --no-daemon → 游戏在树内=true， 取消后存活=**false**
    //
    // 代价是每次都要冷启动一个 JVM（MC 项目本来就要跑几十秒到几分钟，可以忽略），
    // 换来的是“点了关闭就真的关干净”。可用 `daemonMode` 配置改回默认行为。
    if (config.daemonMode === 'no-daemon') argv.push('--no-daemon')
    else if (config.daemonMode === 'daemon') argv.push('--daemon')
    argv.push(...(options.extraArgs ?? []))
    // 标准输入到底有没有人读，取决于**任务类型 + 有没有挂上桥**，
    // 不是取决于我们有没有接管道（spawn 接了 pipe 只保证我们写得进去）。
    //
    // 实证（Minecraft 1.20.1 源码全库 grep `System.in` 仅一处真命中）：
    //   - DedicatedServer.java 的 "Server console handler" 线程循环 readLine
    //     → handleConsoleInput，Forge 还先走 TerminalHandler（JLine 控制台）。
    //     => runServer 天生就有消费者，不需要桥。
    //   - net/minecraft/client/** 下没有任何读 stdin 的代码，runClient 进 GUI 主循环后
    //     写进管道的字节永远没有消费者 => 必须靠 -javaagent 补上那一端。
    //   - runData 是一次性批处理，同样不读 stdin。
    // 桥的 jar 缺失时不能假装可用：那种情况下退回"明确禁用并说明原因"。
    const forwarding = config.forwardStdin !== false && stdinInitScript() !== undefined
    const plan = bridgePlan(target.kind, consoleBridgeJar(), forwarding)
    const started = registry.start({
      task: target.task,
      label: `${projectName(root)} · ${target.shortLabel}`,
      target: { task: target.task, kind: target.kind, projectPath: target.projectPath },
      inputConsumer: plan.consumer,
      inputReason: plan.reason,
      owner: options.owner,
      // 谁起的这个任务。工具栏据此给模型起的任务打一个「AI」标记——
      // 否则用户会看到一条自己没点过的 runClient，不知道它从哪来。
      // 不能用 owner 是否为空来推断：owner 是归属隔离用的，和来源是两件事。
      origin: options.origin ?? 'user',
      cwd: invocation.cwd,
      argv,
      // 只有客户端挂桥，环境变量随进程走。undefined 时 proc 用默认 env。
      env: plan.env === undefined ? undefined : { ...process.env, ...plan.env },
      // 结算后处理对**所有** run* 任务都挂：
      //   - data         → 产物 diff
      //   - client/server → 崩溃识别（runClient 崩了要报告路径，不能只给退出码）
      // 早先只给 data 挂，导致 runClient 崩溃后模型只看到“退出码 1”，毫无诊断价值。
      onSettle: (job) => collectArtifacts({ config }, job),
    })
    if (snapshot !== undefined) {
      registry.require(started.job.id, options.owner).snapshot = snapshot
    }
    return {
      ...started,
      root,
      target,
      argv,
      wrapperMissing: invocation.wrapperMissing,
    }
  }

  // ---- 模型工具 ----
  //
  // 是否把工具暴露给模型由配置决定（exposeTools / enabledTools）。
  // 工具是模型的入口、按钮是人的入口，两者独立启停：关掉工具后按钮照常可用。
  //
  // exposeTools 为 false 时插件不该因为缺 `tools` 服务而加载失败，
  // 所以 inject 只在这张表非空时才做；注册本身见下方「工具注册的时机」。
  const exposedTools = config.exposeTools
    ? (config.enabledTools ?? ALL_TOOLS)
    : []
  const toolEnabled = (toolName) => exposedTools.includes(toolName)

  // 这里只收集定义，真正的注册推迟到下方 —— 见「工具注册的时机」那段注释。
  const toolDefinitions = []
  const registerTool = (definition) => {
    toolDefinitions.push(definition)
  }

  if (toolEnabled('mc_run_task')) registerTool({
    name: 'mc_run_task',
    description:
      '在后台启动一个 Minecraft Gradle run* 任务（runClient / runData / runServer），'
      + '立即返回任务 id，不阻塞前台。kind 用 client / data / server 表达意图，'
      + '也可以直接给完整任务名（如 :modules:CTNH-Core:runClient）。'
      + 'kind=data 时会在任务成功后自动采集产物 diff 并随结果展示。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: '任务类型：client（runClient）| data（runData）| server（runServer），或完整 Gradle 任务名。',
        },
        project: {
          type: 'string',
          description: '可选：Gradle 项目根的绝对路径。省略时用会话工作目录向上发现的根。',
        },
        extra_args: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：追加给 Gradle 的参数，例如 ["--stacktrace"]。',
        },
        wait_ms: {
          type: 'number',
          description: '可选：等待任务结束的毫秒上限。省略则立即返回（真正的后台执行）。超时不取消任务。',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '(无结果)' }],
    },
    async execute(args, exec) {
      const kind = typeof args?.kind === 'string' ? args.kind : ''
      if (kind.length === 0) throw new Error('kind 必须是非空字符串')
      const started = await startTask({
        kind,
        project: args.project,
        extraArgs: Array.isArray(args.extra_args) ? args.extra_args.map(String) : undefined,
        owner: exec.agent?.id,
        origin: 'model',
        cwd: cwdOf(exec),
      })

      if (started.reused) {
        return {
          text: `已有同名任务在运行，复用 ${started.job.id}（${started.job.task}，状态 ${started.job.status}）。`,
          job: started.job,
        }
      }

      const lines = [
        `已在后台启动 ${started.job.id}：${started.target.task}`,
        `项目根：${started.root}`,
        `命令：${started.argv.join(' ')}`,
        // 让模型知道 UI 里已经有实时日志入口：用户要看长输出时指过去，
        // 比把几百行 Gradle 输出贴回对话省得多。
        '面板：会话右上角的 MC Gradle 工具栏会显示这个任务（带 AI 标记），点开就是实时日志。',
      ]
      if (started.wrapperMissing) {
        lines.push('提示：该目录没有 gradlew wrapper，已退回 PATH 上的 gradle。')
      }
      if (started.replaced !== undefined) {
        lines.push(`已取消同名旧任务 ${started.replaced}（duplicatePolicy=replace）。`)
      }

      const waitMs = Number.isFinite(args?.wait_ms) ? Math.max(0, Number(args.wait_ms)) : 0
      if (waitMs <= 0) {
        lines.push('', '任务在后台继续运行；用 mc_run_output 读取增量输出，mc_run_kill 取消。')
        return { text: lines.join('\n'), job: started.job }
      }

      const settled = await registry.wait(started.job.id, waitMs, exec.agent?.id, exec.signal)
      lines.push('', `等待 ${waitMs}ms 后状态：${settled.status}${settled.detail !== undefined ? `（${settled.detail}）` : ''}`)
      const read = registry.read(started.job.id, exec.agent?.id)
      if (read.text.length > 0) lines.push('', '输出：', read.text.trimEnd())

      const artifacts = await registry.awaitArtifacts(started.job.id, exec.agent?.id)
      const diffView = diffViewFrom(artifacts)
      if (artifacts !== undefined) {
        lines.push('')
        if (artifacts.error !== undefined) lines.push(artifacts.error)
        else if (artifacts.kind === 'crash') lines.push(artifacts.summary)
        else lines.push('产物 diff：', artifacts.summary)
      } else if (settled.status === 'completed' && started.target.kind === 'data') {
        lines.push('', '任务成功结束，但没有采集到产物 diff（未找到数据生成产物目录）。')
      }
      // 崩溃时不再用“请检查 Gradle 错误”这种泛泛提示——报告已经给了具体原因。
      const crashed = artifacts?.kind === 'crash'
      if (!crashed && settled.status !== 'completed' && settled.status !== 'running') {
        lines.push('', `任务未成功结束（${settled.status}）。请检查上方输出里的 Gradle 错误。`)
      }
      const value = { text: lines.join('\n'), job: settled }
      if (diffView !== undefined) value.diff = diffView
      // 把崩溃摘要单独回传，UI 与后续工具调用都能直接取到。
      if (crashed) value.crash = artifacts.crash
      return value
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `MC Gradle 任务 ${args?.kind ?? ''}`.trim(),
      kind: 'execute',
      rawInput: args?.kind,
    }),
    presentResult: (_args, result) => {
      const value = result?.value
      if (value?.diff !== undefined) return value.diff
      return undefined
    },
  })

  if (toolEnabled('mc_run_output')) registerTool({
    name: 'mc_run_output',
    description:
      '读取一个后台 MC Gradle 任务的增量输出（自上次读取以来的新内容），'
      + '或等待它结束。settle 后的首次读取还会带上任务结果摘要与产物 diff。',
    parameters: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'mc_run_task 返回的任务 id。',
        },
        wait: {
          type: 'boolean',
          description: '为 true 时阻塞到任务结束或超时；超时不会取消任务。默认 false。',
        },
        timeout_ms: {
          type: 'number',
          description: 'wait=true 时的等待上限，默认 30000，上限 600000。',
        },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '(无结果)' }],
    },
    async execute(args, exec) {
      const id = String(args?.job_id ?? '')
      if (id.length === 0) throw new Error('job_id 必须是非空字符串')
      const wait = args?.wait === true
      if (wait) {
        const timeout = Math.min(Math.max(Number(args?.timeout_ms ?? 30_000), 1), 600_000)
        await registry.wait(id, timeout, exec.agent?.id, exec.signal)
      }
      const read = registry.read(id, exec.agent?.id)
      const lines = []
      if (read.lossy) lines.push('（部分早期输出已因缓冲上限被丢弃；任务仍在继续。）')
      lines.push(read.text.length > 0 ? read.text.trimEnd() : '(没有新的输出)')
      lines.push(`[status: ${read.job.status}${read.job.detail !== undefined ? `, ${read.job.detail}` : ''}]`)
      if (read.result !== undefined) lines.push('', '结果摘要：', read.result)
      const artifacts = await registry.awaitArtifacts(id, exec.agent?.id)
      const diffView = diffViewFrom(artifacts)
      const value = { text: lines.join('\n'), job: read.job }
      if (artifacts !== undefined) {
        if (artifacts.error !== undefined) value.text += `\n\n${artifacts.error}`
        else if (artifacts.kind === 'crash') {
          // runClient 崩了：把报告路径与摘要直接给模型，而不是让它去翻几十 KB 的日志。
          value.text += `\n\n${artifacts.summary}`
          value.crash = artifacts.crash
        } else value.text += `\n\n产物 diff：\n${artifacts.summary}`
        if (diffView !== undefined) value.diff = diffView
      }
      return value
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `读取任务输出 ${args?.job_id ?? ''}`.trim(),
      kind: 'read',
      rawInput: args?.job_id,
    }),
    presentResult: (_args, result) => result?.value?.diff,
  })

  if (toolEnabled('mc_run_list')) registerTool({
    name: 'mc_run_list',
    description: '列出当前会话的后台 MC Gradle 任务（运行中与已结束），含任务 id、任务名与状态。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'array', items: { type: 'object' } },
      render: (_args, jobs) => [{
        type: 'text',
        text: Array.isArray(jobs) && jobs.length > 0
          ? jobs.map((job) => `${job.id} [${job.task}] ${job.status}${job.detail !== undefined ? ` — ${job.detail}` : ''}`).join('\n')
          : '(没有后台任务)',
      }],
    },
    execute(_args, exec) {
      return Promise.resolve(registry.list(exec.agent?.id))
    },
    presentCall: () => ({ card: 'generic', title: '列出 MC Gradle 任务', kind: 'read' }),
  })

  if (toolEnabled('mc_run_kill')) registerTool({
    name: 'mc_run_kill',
    description: '取消一个正在运行的 MC Gradle 后台任务（先温和终止整棵进程树，宽限期后强制结束）。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'mc_run_task 返回的任务 id。' },
        reason: { type: 'string', description: '可选：取消原因，记入任务结算信息。' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '(无结果)' }],
    },
    execute(args, exec) {
      const id = String(args?.job_id ?? '')
      if (id.length === 0) throw new Error('job_id 必须是非空字符串')
      const outcome = registry.kill(id, exec.agent?.id, args?.reason)
      const job = registry.get(id, exec.agent?.id)
      return Promise.resolve({
        text: outcome === 'already-finished'
          ? `任务 ${id} 已经结束（${job.status}），无需取消。`
          : `已请求取消任务 ${id}（${job.task}）。`,
        job,
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `取消任务 ${args?.job_id ?? ''}`.trim(),
      kind: 'execute',
      rawInput: args?.job_id,
    }),
  })

  if (toolEnabled('mc_send_command')) registerTool({
    name: 'mc_send_command',
    description:
      '把一行内容送进正在运行的游戏进程：`/` 开头的按命令执行（如 `/time set day`），'
      + '其余按聊天发送。写入后短暂等待游戏侧回执并随结果返回；'
      + '没拿到回执只说明还没确认，不代表已生效。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要发送的一行内容。以 `/` 开头当作命令执行，否则当作聊天消息。',
        },
        job_id: {
          type: 'string',
          description: '可选：目标任务 id（mc_run_task 返回）。省略时用本会话最近启动、仍在运行的的那个可交互任务。',
        },
        wait_ms: {
          type: 'number',
          description: '可选：等待游戏侧回执的毫秒数，默认 2000，夹取到 0–10000。0 表示写完立即返回。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '(无结果)' }],
    },
    async execute(args, exec) {
      const text = String(args?.text ?? '')
      if (text.trim().length === 0) throw new Error('text 不能为空')
      const owner = exec.agent?.id
      const target = resolveInputTarget(registry, owner, args?.job_id)
      if (typeof target.blocked === 'string') throw new Error(target.blocked)
      const waitMs = clampNumber(args?.wait_ms, 2000, 0, 10_000)
      // 写之前的输出长度：只有写完之后新出现的 [mc-console] 行才算这次的回执，
      // 否则会把上一行命令的回执误报成这一次的。
      const before = registry.readAll(target.id, owner).text.length
      registry.write(target.id, owner, text)
      const receipt = waitMs > 0
        ? await awaitBridgeReceipt(registry, target.id, owner, before, waitMs, exec.signal)
        : undefined
      const lines = [`已写入任务 ${target.id}（${target.task}）：${text}`]
      if (receipt !== undefined) lines.push(`游戏侧回执：${receipt}`)
      else if (waitMs > 0) {
        lines.push(`尚未看到 [mc-console] 回执（等了 ${waitMs} ms）。可再读一次该任务的输出确认。`)
      }
      return {
        text: lines.join('\n'),
        job_id: target.id,
        delivered: true,
        receipt,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `发送命令 ${args?.text ?? ''}`.trim(),
      kind: 'execute',
      rawInput: args?.text,
    }),
  })

  // ---- 工具注册的时机 ----
  //
  // 不能写成 `ctx.get('tools')` 一次性探测：插件的 apply 早于 tools 服务就绪时，
  // 那次探测拿到 undefined，工具就永久缺席（模型看不到任何 mc_run_*，而按钮照常工作）。
  // 用 ctx.inject(['tools']) 把注册挂在服务出现的时刻，服务消失时 cordis 自动回收；
  // exposeTools=false 时直接不 inject，插件也就不再要求这个服务存在。
  if (toolDefinitions.length > 0) {
    ctx.inject(['tools'], (host) => {
      // 真实 cordis 只在 tools 就绪时回调，但宿主版本差异、以及测试里的
      // 简化上下文都可能给出没有 tools 的 host；此时明确警告并跳过，
      // 而不是让一个 TypeError 把 apply 后面挂路由的步骤一起炸掉。
      if (typeof host?.tools?.register !== 'function') {
        ctx.logger?.warn?.(
          'mc-gradle-runner: 配置要求暴露 run* 工具，但注入的 host 没有 tools.register，已跳过注册。',
        )
        return
      }
      for (const definition of toolDefinitions) {
        host.effect(
          () => host.tools.register(definition),
          `mc-gradle-runner: ${definition.name} tool`,
        )
      }
    })
  }

  // ---- 系统提示词里的使用说明 ----
  //
  // 两个触发条件，缺一不可：
  //   1. 配置里启用了工具（exposeTools + enabledTools 至少留下一条）；
  //   2. 当前会话 cwd 确实是可运行的 MC 项目。
  //
  // 第 2 条**必须**和按钮显隐是同一套判据（用户明确要求）：两边都走
  // resolveRoot + assessRoot，所以不可能出现「界面没按钮、提示词说能用」。
  //
  // 提示词分节是全局的，而 cwd 是每会话的，所以不能注册时就把路径写死：
  // provider 在每次 assembly 时按 context.agent.session.header.cwd 现算。
  if (exposedTools.length > 0) {
    const provider = createGuidanceProvider({
      config,
      resolveRoot,
      assessRoot,
      tools: exposedTools,
    })
    const installed = installGuidance(ctx, provider)
    if (installed) {
      ctx.effect(() => () => provider.clear(), 'mc-gradle-runner: 提示词缓存清理')
    } else {
      // 宿主没给 systemPrompt 事件时只少一段说明，工具本身照常可用。
      ctx.logger?.warn?.('mc-gradle-runner: 没有 system-prompt/assemble 事件，已跳过提示词注入。')
    }
  }

  // ---- 浏览器半身用的 HTTP 路由 ----
  //
  // 走 Connection 的 /api 围栏：与其它 Host API 一样受 Host/Origin 与浏览器鉴权保护。
  // connection 或 webServer 缺席时整条路由不挂载，工具仍然可用。
  //
  // showButtons 为 false 时路由也不挂载：按钮面板没有数据来源，
  // 浏览器半身会因探测失败而不渲染任何东西，正好是期望的行为。
  if (config.showButtons) {
    ctx.inject(['connection', 'webServer'], (host) => {
      host.effect(() => host.connection.fetch.register({
        path: '/api/mc-gradle-runner',
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: (request) => handleApi(request, { config, registry, startTask, ctx }),
      }), 'mc-gradle-runner: /api route')
    })
  }
}

/**
 * 由浏览器给的 sessionId 反查该会话的工作目录。
 *
 * 浏览器半身拿不到 cwd，只能把 sessionId 交给主机来解析；
 * `sessions` 服务缺席或会话已销毁时返回 undefined，由调用方退回进程 cwd。
 *
 * @param ctx 插件上下文。
 * @param sessionId 会话 id，可为空。
 */
function cwdOfSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  try {
    const sessions = ctx.get('sessions')
    return sessions?.get(sessionId)?.header?.cwd
  } catch {
    return undefined
  }
}

/** JSON 响应，带 no-store 让按钮状态每次都取最新值。 */
function json(status, payload) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * 处理按钮面板的一次请求。
 *
 * 端点（POST，body 为 JSON）：
 *   - `{ action: 'targets', cwd?, project? }` → 发现到的 run* 目标与项目根
 *   - `{ action: 'start', kind, cwd?, project?, extra_args? }` → 起任务
 *   - `{ action: 'tasks', cwd?, project?, projectPath? }` → 向 Gradle 查询权威任务清单
 *   - `{ action: 'status' }` → 当前无主/全部任务视图
 *   - `{ action: 'log', job_id }` → 右侧栏日志页签用的全量输出与结算产物
 *   - `{ action: 'kill', job_id }` → 取消任务
 *   - `{ action: 'input', job_id, text }` → 往标准输入写一行 MC 命令
 *     （只对真的有人读 stdin 的任务成立；`runClient` 会被明确拒绝，理由随 error 回传）
 *
 * 按钮是“人类点击”的入口，不带会话作用域（浏览器没有 agent id），
 * 因此这里起的任务 owner 为 undefined，对任何会话都可见，也能被工具读到。
 *
 * @param request fenced Fetch 请求。
 * @param deps 插件依赖。
 */
async function handleApi(request, deps) {
  const { config, registry, startTask, ctx } = deps
  let body = {}
  if (request.method === 'POST') {
    try {
      const text = await request.text()
      body = text.length > 0 ? JSON.parse(text) : {}
    } catch {
      return json(400, { error: '请求体必须是 JSON' })
    }
  } else {
    const url = new URL(request.url)
    body = { action: url.searchParams.get('action') ?? 'targets' }
  }
  const action = typeof body.action === 'string' ? body.action : 'targets'
  // 浏览器只知道 sessionId，cwd 必须由主机解析。
  const cwd = typeof body.cwd === 'string' && body.cwd.length > 0
    ? body.cwd
    : cwdOfSession(ctx, body.sessionId)

  try {
    if (action === 'targets') {
      const root = resolveRoot(config, cwd, body.project)
      // 可用性由 discovery.assessRoot 统一裁决——系统提示词的注入走同一个函数，
      // 这样「按钮出没出现」和「提示词里说没说这工作区能跑 MC」永远一致。
      const assessed = await assessRoot(root)
      return json(200, {
        root,
        projects: assessed.projects,
        targets: assessed.targets,
        info: assessed.info,
        // 来源信息必须回传，否则菜单里的「来源」永远显示“无”（修过的一个 bug：
        // 早先这里只解构了 targets/projects，sources 被丢掉，客户端拿不到）。
        sources: assessed.sources,
        structureSource: assessed.structureSource,
        gradleQuery: assessed.gradleQuery,
        // 显式可用性：客户端只认这一个字段。
        available: assessed.available,
        // 不可用时的原因，供诊断展示（按钮不渲染，但便于排查）。
        unavailableReason: assessed.unavailableReason,
        duplicatePolicy: config.duplicatePolicy,
        // 该目录有没有自带 wrapper；没有时会退回 PATH 上的 gradle。
        hasWrapper: assessed.info.gradleWrapper,
      })
    }
    if (action === 'start') {
      const kind = typeof body.kind === 'string' ? body.kind : ''
      if (kind.length === 0) return json(400, { error: 'kind 必须是非空字符串' })
      const started = await startTask({
        kind,
        project: body.project,
        extraArgs: Array.isArray(body.extra_args) ? body.extra_args.map(String) : undefined,
        owner: undefined,
        cwd,
      })
      return json(200, {
        job: started.job,
        reused: started.reused,
        replaced: started.replaced,
        root: started.root,
        task: started.target.task,
        argv: started.argv,
      })
    }
    if (action === 'tasks') {
      // 权威任务列表：跑一次 Gradle 让它自己报出任务，而不是靠命名约定猜。
      // 只在用户从菜单里显式点击时触发，且带缓存——一次调用约 7 秒。
      if (!config.allowGradleTaskQuery) {
        return json(200, { error: '当前配置不允许向 Gradle 查询任务列表（allowGradleTaskQuery=false）' })
      }
      const root = resolveRoot(config, cwd, body.project)
      const projectPath = typeof body.projectPath === 'string' && body.projectPath.length > 0
        ? body.projectPath
        : ':'
      const cacheKey = `${root}::${projectPath}`
      const cached = taskQueryCache.get(cacheKey)
      if (cached !== undefined && Date.now() - cached.at < config.taskQueryCacheMs) {
        return json(200, { ...cached.value, cached: true })
      }
      const result = await queryGradleTasks(root, projectPath, {
        spawn: (argv, spawnCwd, timeoutMs) => runOnce(argv, spawnCwd, timeoutMs),
        timeoutMs: config.taskQueryTimeoutMs,
      })
      if (!result.ok) return json(200, { error: result.error, raw: result.raw, cached: false })
      // 只保留 run* 任务，避免把上百个无关任务塞进菜单。
      const runTasks = result.tasks.filter((task) => RUN_TASK_SHAPE.test(task.name))
      const value = {
        root,
        projectPath,
        tasks: runTasks,
        totalTasks: result.tasks.length,
        groups: result.groups,
        wrapperMissing: result.wrapperMissing === true,
        cached: false,
      }
      taskQueryCache.set(cacheKey, { at: Date.now(), value })
      return json(200, value)
    }
    if (action === 'status') {
      // 用 listAll 而不是 list：模型用 mc_run_task 起的任务带 owner（agent id），
      // 而浏览器只有 sessionId，按 owner 过滤的话这些任务在工具栏和日志面板里
      // 完全没有踪影 —— 用户会看到游戏在跑，却找不到任何状态与日志。
      return json(200, { jobs: registry.listAll() })
    }
    if (action === 'kill') {
      const id = typeof body.job_id === 'string' ? body.job_id : ''
      if (id.length === 0) return json(400, { error: 'job_id 必须是非空字符串' })
      const outcome = registry.kill(id, undefined, body.reason)
      return json(200, { outcome, job: registry.get(id, undefined) })
    }
    if (action === 'log') {
      // 侧边栏日志面板专用：不移动游标，面板每次都能拿到尾部日志。
      //
      // **必须按行截断**：面板每秒轮询，若返回完整缓冲（上限 outputLimitBytes
      // 即 4 MB），长跑任务会把浏览器撑到 OOM。只给最后 logTailLines 行，
      // 同时把丢掉的行数告诉面板，让它明说「前面还有多少行没显示」。
      const id = typeof body.job_id === 'string' ? body.job_id : ''
      if (id.length === 0) return json(400, { error: 'job_id 必须是非空字符串' })
      const maxLines = Number.isFinite(config.logTailLines) ? config.logTailLines : 500
      const read = registry.readTail(id, undefined, maxLines)
      // 结算后处理（runData 的 diff / runClient 的崩溃报告）不在 publicView 里，
      // 面板要单独取；没跑完时这里是 undefined，面板显示"等待产物"。
      const artifacts = registry.require(id, undefined).artifacts
      return json(200, {
        text: read.text,
        lossy: read.lossy,
        droppedLines: read.dropped,
        maxLines,
        job: read.job,
        artifacts,
      })
    }
    if (action === 'input') {
      // 送达与否由 registry.write 裁决（它会看这个任务有没有 stdin 消费者）。
      // runClient 到这里会抛 INPUT_UNSUPPORTED，下面统一的 catch 按 200 + error + code
      // 回传，面板原样显示——这是「为什么发不了」的唯一通道。
      const id = typeof body.job_id === 'string' ? body.job_id : ''
      if (id.length === 0) return json(400, { error: 'job_id 必须是非空字符串' })
      const text = typeof body.text === 'string' ? body.text : ''
      if (text.trim().length === 0) return json(400, { error: 'text 不能为空' })
      const result = registry.write(id, undefined, text)
      return json(200, { ...result, job: registry.get(id, undefined) })
    }
    return json(400, { error: `未知 action：${action}` })
  } catch (error) {
    // 业务失败（找不到任务、并发冲突等）用 200 + error 字段回传，
    // 让按钮面板能直接显示原因而不是把它当成网络故障。
    return json(200, { error: error?.message ?? String(error), code: error?.code })
  }
}

/**
 * 默认导出。
 *
 * cordis 的插件加载器先对模块命名空间做 `unwrapExports`（`exports.default ?? exports`），
 * 再从中读 `Config` 挂到 runtime 上。只有命名导出、没有 default 时，
 * unwrap 会停在命名空间对象上；新版加载器在这里读到的 Config 可能是 undefined，
 * 于是「插件配置」页拿不到 schema，整块表单不渲染（describe() 直接返回 []）。
 *
 * 官方插件（如 dsh-web-search-pro）为此显式同时给出 default 与命名导出：
 *   export default { name, inject, Config, apply }
 */
export default { name, inject, Config, apply }
export { apply }
