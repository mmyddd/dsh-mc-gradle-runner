/**
 * 项目发现：定位 Gradle 根与 run* 任务目标。
 *
 * 设计目标是与具体仓库解耦：任何 MC Gradle 项目（Forge / NeoForge / Fabric Loom /
 * Architectury / 多模块 monorepo）都应能被发现，而不是只认 CTNH-Modules。
 *
 * 发现是分层、可降级的，任何一层失败都不影响其余层：
 *   1. `.run/*.run.xml` —— IntelliJ 的运行配置。这是 IDEA 自己用的那份数据，
 *      精确到 `:modules:CTNH-Core:runClient` 这种带项目路径的任务名，因此优先采信。
 *   2. `settings.gradle(.kts)` 的 include 语句 —— 拿到全部子项目路径，
 *      再按每个子项目是否真有 build 脚本生成候选任务。
 *   3. 兜底：仓库根自身作为一个项目。
 *
 * 本模块只做只读文件系统访问，不执行 Gradle，因此调用是廉价的。
 *
 * @module dsh-mc-gradle-runner/discovery
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Gradle 根标志文件，按优先级排列。 */
const ROOT_MARKERS = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts']

/** 向上搜索 Gradle 根时最多回溯的层数，避免在深目录里走到盘符根。 */
const MAX_WALK_UP = 12

/**
 * run* 任务的分类表。
 *
 * 键是任务名里出现即命中的特征串（小写比较），值给出 kind 与展示信息。
 * 顺序有意义：先匹配更具体的 datagen，再匹配 client / server。
 */
const TASK_CLASSES = [
  { match: /datagen|rundata|data$/, kind: 'data', label: 'runData', icon: 'data' },
  { match: /runclient|client/, kind: 'client', label: 'runClient', icon: 'client' },
  { match: /runserver|server/, kind: 'server', label: 'runServer', icon: 'server' },
]

/** 认得出的 run* 任务名形状：run + 大写开头。 */
const RUN_TASK_SHAPE = /^run[A-Z]/

/**
 * 主流 mod 加载器插件 id 片段。
 *
 * 用于两处判断：根项目的 plugins 块里是否真的 apply 了 mod 插件，
 * 以及构建脚本集合里是否存在 MC 运行能力的证据。
 */
const MOD_PLUGIN_ID = /net\.neoforged\.(moddev|gradle)|net\.minecraftforge\.(gradle|accesstransformers)|fabric-loom|fabricmc\.loom|architectury|\bforge\b|\bminecraft\b/

/**
 * 构建脚本里的“MC 运行能力”证据。
 *
 * 一个项目只要能在 IDE 里 run，它必然在某处写了下面三者之一；普通 Java /
 * Kotlin / Android 项目一个都不会有。这是把「真 MC 项目」与「恰好也是 Gradle
 * 的普通项目」区分开的唯一依据，也是修掉“不支持 run* 的工作区仍出现按钮”的关键。
 *
 *   1. `runs { ... }` 块 —— NeoForge ModDevGradle / Fabric Loom 的运行配置 DSL；
 *   2. 任一主流 mod 加载器插件 id —— 老版 ForgeGradle 只声明插件、不写 runs；
 *   3. runClient / runData / runServer 这类任务名或运行配置名字面量。
 */
const RUN_EVIDENCE = new RegExp([
  /\bruns\s*\{/,                                     // runs { } DSL
  /\brun(Client|Data|Server|GameTest)\b/,            // 任务/配置名字面量
  /net\.neoforged\.(moddev|gradle)/,                 // NeoForge ModDevGradle
  /net\.minecraftforge\.(gradle|accesstransformers)/, // ForgeGradle / AT
  /fabric-loom|fabricmc\.loom/,                      // Fabric Loom
  /architectury/,                                    // Architectury
  /\bforge\s*\{/,                                    // 老 ForgeGradle 的 forge { } 块
  /minecraft\s*\{/,                                  // 老 ForgeGradle 的 minecraft { } 块
].map((re) => re.source).join('|'))

/** 判定一个文件/目录是否存在。 */
function exists(path) {
  return existsSync(path)
}

/**
 * 从起始目录向上寻找真正的 Gradle 根。
 *
 * 不能简单地把“最近的有 settings.gradle 的目录”当根：多模块 MC 仓库里
 * 子项目常常自带一份 settings.gradle（CTNH-Modules 的 modules/CTNH-Core 就是），
 * 那份文件通常只声明 pluginManagement，没有任何 include，也不是构建入口。
 * 直接采信它会让任务名丢掉 `:modules:CTNH-Core:` 前缀，Gradle 根本找不到任务。
 *
 * 因此这里收集向上路径上的全部候选并打分，取最高分的那个：
 *   - 有 gradlew / gradlew.bat  —— 这才是真正被调用的构建入口，权重最高；
 *   - settings 文件里真的有 include —— 说明它是多项目的聚合根；
 *   - 只有 settings / 只有 build.gradle —— 兜底。
 * 同分时取**最靠上**的目录，因为聚合根总是在子项目之上。
 *
 * @param startDir 会话工作目录（绝对路径）。
 * @returns 绝对路径形式的 Gradle 根目录。
 */
export function findGradleRoot(startDir) {
  const candidates = []
  let dir = resolve(startDir)
  for (let depth = 0; depth <= MAX_WALK_UP; depth += 1) {
    const hasSettings = ROOT_MARKERS.slice(0, 2).some((marker) => exists(join(dir, marker)))
    const hasBuild = ROOT_MARKERS.slice(2).some((marker) => exists(join(dir, marker)))
    if (hasSettings || hasBuild) {
      const hasWrapper = exists(join(dir, wrapperName()))
      candidates.push({
        dir,
        depth,
        hasWrapper,
        hasSettings,
        hasBuild,
        // include 检测只读 settings 文本；读失败按“没有 include”处理。
        hasIncludes: hasSettings ? settingsHasIncludesSync(dir) : false,
      })
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  if (candidates.length === 0) return resolve(startDir)

  // 打分：wrapper > include > settings > build。同分取最靠上的（depth 最小）。
  const score = (candidate) => {
    let value = 0
    if (candidate.hasWrapper) value += 8
    if (candidate.hasIncludes) value += 4
    if (candidate.hasSettings) value += 2
    if (candidate.hasBuild) value += 1
    return value
  }
  let best = candidates[0]
  let bestScore = score(best)
  for (const candidate of candidates.slice(1)) {
    const value = score(candidate)
    if (value > bestScore || (value === bestScore && candidate.depth < best.depth)) {
      best = candidate
      bestScore = value
    }
  }
  return best.dir
}

/**
 * 同步判断一个 Gradle 根下有没有 wrapper。
 * 供 {@link findGradleRoot} 在纯计算路径上使用。
 *
 * @param root Gradle 根目录。
 */
export function hasWrapper(root) {
  return exists(join(root, wrapperName()))
}

/**
 * 同步读取 settings 文件，判断是否声明了 include。
 *
 * 用同步读是为了让 {@link findGradleRoot} 保持同步——它被配置解析路径调用，
 * 那里不方便 await。文件很小，成本可以忽略。
 *
 * @param dir 候选目录。
 */
function settingsHasIncludesSync(dir) {
  for (const marker of ROOT_MARKERS.slice(0, 2)) {
    const file = join(dir, marker)
    if (!exists(file)) continue
    try {
      const text = readFileSync(file, 'utf8')
      if (/\binclude\s*\(?\s*['"]/.test(text)) return true
    } catch {
      // 读不了就当没有 include。
    }
  }
  return false
}

/**
 * 判断**根项目自己**是否能运行 MC。
 *
 * 这里必须严格，因为多模块 monorepo 的根通常是**聚合器**：它只声明插件
 * （而且是 `apply(false)`，表示"只登记版本、下发给子项目，不要在我身上生效"）
 * 并把配置交给子项目。CTNH-Modules 的根正是如此：
 *
 *     plugins {
 *         id 'net.neoforged.moddev.legacyforge' version '2.0.142' apply(false)
 *     }
 *     configure(ctnhSubprojects) { apply plugin: 'net.neoforged.moddev.legacyforge' }
 *
 * 如果把这种声明也算作"根能运行"，菜单里就会出现点不动的 `:runClient`。
 * 因此**只认三种证据**：
 *   1. `runs { ... }` 块 —— 定义运行配置的项目才写；
 *   2. runClient / runData / runServer 字面量；
 *   3. `plugins { ... }` 块里声明了 mod 加载器插件，且**没有** `apply(false)`。
 * 第 3 条刻意只在 plugins 块内查找：CTNH 那种 `configure(subprojects) { apply plugin: ... }`
 * 里的 apply 是对子项目生效的，不能算在根头上。
 *
 * @param root Gradle 根目录。
 */
function rootDeclaresRuns(root) {
  return ['build.gradle', 'build.gradle.kts'].some((marker) => {
    const file = join(root, marker)
    if (!exists(file)) return false
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return false
    }
    // 1) runs 块 / run* 字面量：无条件算数。
    if (/\bruns\s*\{/.test(text)) return true
    if (/\brun(Client|Data|Server|GameTest)\b/.test(text)) return true
    // 2) plugins 块里未被 apply(false) 关掉的 mod 加载器插件。
    const pluginsBlock = text.match(/\bplugins\s*\{([\s\S]*?)\n\}/)
    if (pluginsBlock !== null) {
      for (const line of pluginsBlock[1].split(/\r?\n/)) {
        if (!MOD_PLUGIN_ID.test(line)) continue
        // 同一行里带 apply(false) / apply false 表示只登记不生效。
        if (/\bapply\s*\(?\s*false\s*\)?/.test(line)) continue
        return true
      }
    }
    return false
  })
}

/** 单个构建脚本里有没有 runs 块或 run* 任务字面量。 */
function fileDeclaresRuns(file) {
  if (!exists(file)) return false
  try {
    return RUN_EVIDENCE.test(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

/**
 * 一个构建集合（根 + 全部子项目 + 根目录 gradle 脚本目录）里有没有 MC 运行痕迹。
 *
 * 这是修掉“不支持 run* 的工作区仍出现按钮”这个 bug 的核心判据。
 * 早先只检查“子项目有没有 build.gradle”，于是普通 Java 库也被加上三个假任务。
 *
 * 必须扫到根目录的 `gradle/scripts/*.gradle`，因为 MC 生态里运行配置常常写在那里
 * 由根脚本 apply 给各子项目（CTNH-Modules 正是如此）。只看子项目自己的
 * build.gradle 会把所有真实子项目误杀。
 *
 * 反过来，普通 Java / Kotlin / Android 项目的所有构建脚本里都不会出现
 * runs 块、mod 加载器插件或 run* 任务字面量，因此判为“不声明运行能力”，
 * 按钮就不会出现。
 *
 * @param root Gradle 根目录。
 * @param structurePaths 子项目路径列表。
 * @returns 是否发现了运行能力证据。
 */
function buildDeclaresRuns(root, structurePaths) {
  // 1) 根构建脚本
  if (rootDeclaresRuns(root)) return true
  // 2) 根目录下的 gradle 脚本目录（settings/buildSrc 之外的约定位置）
  const scriptDirs = ['gradle/scripts', 'gradle', 'buildSrc/src/main/groovy', 'buildSrc/src/main/kotlin']
  for (const rel of scriptDirs) {
    const dir = join(root, rel)
    if (!exists(dir)) continue
    try {
      for (const entry of readdirSync(dir)) {
        if (!/\.(gradle|gradle\.kts|groovy|kt)$/.test(entry)) continue
        if (fileDeclaresRuns(join(dir, entry))) return true
      }
    } catch {
      // 目录读不了就跳过。
    }
  }
  // 3) 各子项目的构建脚本
  for (const projectPath of structurePaths) {
    const dir = projectDir(root, projectPath)
    if (fileDeclaresRuns(join(dir, 'build.gradle'))) return true
    if (fileDeclaresRuns(join(dir, 'build.gradle.kts'))) return true
  }
  return false
}

/** 当前平台的 Gradle wrapper 文件名。 */
export function wrapperName() {
  return process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'
}

/**
 * 解析 `.run/*.run.xml`，抽取 IntelliJ 的 Gradle 运行配置。
 *
 * 只做正则解析而非完整 XML 解析：这些文件是 IDEA 生成的固定形状，
 * 引一个 XML 依赖不划算，而任务名一定落在 `<option value="…" />` 里。
 *
 * @param root Gradle 根目录。
 * @returns 运行配置数组，按任务名去重后按名称排序。
 */
export async function readIntellijRunConfigs(root) {
  const dir = join(root, '.run')
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const configs = []
  for (const entry of entries) {
    if (!entry.endsWith('.run.xml')) continue
    let text
    try {
      text = await readFile(join(dir, entry), 'utf8')
    } catch {
      continue
    }
    // 运行配置的名字，用于展示。
    const nameMatch = text.match(/<configuration[^>]*\sname="([^"]*)"/)
    // taskNames 列表里的每一个 <option value="…" />。
    const tasks = [...text.matchAll(/<option\s+value="([^"]+)"\s*\/>/g)].map((m) => m[1])
    for (const task of tasks) {
      const leaf = task.split(':').filter(Boolean).pop() ?? task
      if (!RUN_TASK_SHAPE.test(leaf)) continue
      configs.push({
        source: 'intellij',
        task: normalizeTask(task),
        leaf,
        projectPath: projectPathOf(normalizeTask(task)),
        label: nameMatch?.[1]?.trim() || leaf,
      })
    }
  }
  return dedupe(configs)
}

/** 从 `:a:b:runClient` 或 `a:b:runClient` 取出项目路径 `:a:b`。 */
function projectPathOf(task) {
  const segments = task.split(':').filter(Boolean)
  segments.pop()
  return segments.length === 0 ? ':' : `:${segments.join(':')}`
}

/**
 * 规范化任务名：统一成带前导冒号的绝对任务路径。
 *
 * IDEA 的 run 配置里两种写法都出现过（`runServerCore` 写的是
 * `modules:CTNH-Core:runServer`，`runCore` 写的是 `:modules:CTNH-Core:runClient`），
 * 它们指向同一个 Gradle 任务。不归一化就会在菜单里出现两条一模一样的项。
 *
 * @param task 原始任务名。
 * @returns 带前导冒号的规范形式。
 */
export function normalizeTask(task) {
  const trimmed = String(task).trim()
  return trimmed.startsWith(':') ? trimmed : `:${trimmed}`
}

/**
 * 解析 `settings.gradle(.kts)` 里的 include 语句，得到子项目路径。
 *
 * 支持 `include "a:b"`、`include 'a:b', 'c:d'` 与 `include("a:b")` 三种写法。
 *
 * @param root Gradle 根目录。
 * @returns 形如 `:modules:CTNH-Core` 的项目路径数组。
 */
export async function readSettingsProjects(root) {
  const file = ['settings.gradle', 'settings.gradle.kts']
    .map((name) => join(root, name))
    .find((path) => exists(path))
  if (file === undefined) return []
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const projects = new Set()
  // 去掉行注释，避免把注释里的 include 当真。
  const cleaned = text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of cleaned.matchAll(/\binclude\s*\(?\s*([^\n)]*)/g)) {
    for (const literal of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
      const path = literal[1].replace(/^:/, '').replace(/:/g, '/')
      if (path.length > 0) projects.add(`:${path.replace(/\//g, ':')}`)
    }
  }
  return [...projects]
}

/** 把 `:modules:CTNH-Core` 转成相对根目录的路径片段。 */
export function projectDir(root, projectPath) {
  const rel = projectPath.replace(/^:/, '').replace(/:/g, sep)
  return rel.length === 0 ? root : join(root, rel)
}

/**
 * 发现来源的优先级。**数字越小越可信**，同一条任务名冲突时保留更可信的来源。
 *
 * 排序原则：权威数据 > 用户策展 > 我的启发式。
 *
 *   0 gradle   —— Gradle 自己报的任务（`gradlew tasks`）。它说存在就一定存在，
 *                 不存在就一定不存在，是唯一的权威来源。
 *   1 ideaRun  —— IDEA 的运行配置（`.run/*.run.xml`）。用户亲手挑出来并命名的入口，
 *                 带着用户意图（哪个模块是主模块），比任何自动推断都可靠。
 *   2 idea     —— IDEA 的 `.idea/gradle.xml` 模块列表。IDEA 同步下来的真实项目结构。
 *   3 settings —— 我自己正则解析 `settings.gradle` 的 include。会被变量拼接、
 *                 条件包含、字符串拼接骗到，因此只用来**填补**上面的空缺。
 *   4 fallback —— 什么都没有时的最后手段，仅用于确认是 Gradle 项目但没有结构信息。
 */
export const SOURCE_PRIORITY = {
  gradle: 0,
  ideaRun: 1,
  idea: 2,
  settings: 3,
  fallback: 4,
}

/** 展示用的来源中文名。 */
export const SOURCE_LABEL = {
  gradle: 'Gradle 任务清单',
  ideaRun: 'IDEA 运行配置',
  idea: 'IDEA 项目结构',
  settings: 'settings.gradle 解析',
  fallback: '默认任务名',
}

/** 项目结构来源的优先级：IDEA 的模块列表高于自己解析 settings.gradle。 */
function pickStructureSource(ideaPaths, settingsPaths) {
  if (ideaPaths.length > 0) return { paths: ideaPaths, source: 'idea' }
  if (settingsPaths.length > 0) return { paths: settingsPaths, source: 'settings' }
  return { paths: [], source: 'none' }
}

/** 把 run* 任务名分类成 client / data / server / other。 */
export function classifyTask(leaf) {
  const lower = leaf.toLowerCase()
  for (const entry of TASK_CLASSES) {
    if (entry.match.test(lower)) return entry
  }
  return { kind: 'other', label: leaf, icon: 'other' }
}

/**
 * 把一条任务名补全成完整的目标记录。
 *
 * @param task 规范化的任务名（带前导冒号）。
 * @param source 来源标识，决定优先级。
 * @param projectPath 所属项目路径。
 * @param extra 额外字段（label / description 等）。
 */
function makeTarget(task, source, projectPath, extra = {}) {
  const normalized = normalizeTask(task)
  const leaf = normalized.split(':').filter(Boolean).pop() ?? normalized
  const meta = classifyTask(leaf)
  return {
    task: normalized,
    leaf,
    projectPath: projectPath ?? projectPathOf(normalized),
    source,
    priority: SOURCE_PRIORITY[source] ?? 9,
    sourceLabel: SOURCE_LABEL[source] ?? source,
    kind: meta.kind,
    shortLabel: meta.label,
    label: extra.label ?? `${projectPath === ':' ? 'root' : (projectPath ?? '').replace(/^:/, '')}:${leaf}`,
    ...(extra.description !== undefined ? { description: extra.description } : {}),
    ...(extra.group !== undefined ? { group: extra.group } : {}),
  }
}

/** 按 `task` 去重，保留优先级最高（数字最小）的那条。 */
function dedupeByPriority(targets) {
  const best = new Map()
  for (const target of targets) {
    const existing = best.get(target.task)
    if (existing === undefined || target.priority < existing.priority) {
      best.set(target.task, target)
    }
  }
  return [...best.values()]
}

/** 按 `task` 去重，保留先出现的（即优先级更高的来源）。 */
function dedupe(configs) {
  const seen = new Set()
  const out = []
  for (const config of configs) {
    if (seen.has(config.task)) continue
    seen.add(config.task)
    out.push(config)
  }
  return out
}

/**
 * 汇总一个 Gradle 根下全部可运行的 run* 目标。
 *
 * 返回的目标同时带有 `task`（可直接交给 Gradle 的完整任务名）与 `kind`
 * （client / data / server），供按钮分组与工具校验使用。
 *
 * @param root Gradle 根目录。
 * @returns `{ targets, projects }`，targets 按 kind 与任务名排序。
 */
/**
 * 汇总一个 Gradle 根下全部可运行的 run* 目标。
 *
 * **来源优先级是这一层的核心设计**：权威数据永远压过我的启发式。
 *
 *   0. `gradle`   —— Gradle 自己报的任务（`gradlew <proj>:tasks --all`）。
 *                    唯一的权威来源；需要一次真实 Gradle 调用，因此只在
 *                    `queryTasks: true` 时启用（由“从 Gradle 刷新任务列表”触发）。
 *   1. `ideaRun`  —— IDEA 的运行配置（`.run/*.run.xml`）。用户亲手挑出并命名的入口，
 *                    带着“哪个模块是主模块”的意图，比任何自动推断都可靠。
 *   2. `idea`     —— IDEA 的 `.idea/gradle.xml` 模块列表。IDEA 同步下来的真实结构。
 *   3. `settings` —— 我自己正则解析 `settings.gradle` 的 include。会被变量拼接、
 *                    条件包含骗到，因此只用来**填补**上面的空缺。
 *   4. `fallback` —— 什么都没有时的最后手段。
 *
 * 同一条任务名可能被多个来源给出；{@link dedupeByPriority} 保留优先级最高的那条，
 * 于是 Gradle 说“存在”就一定存在，Gradle 说“不存在”也不会被我的猜测复活。
 *
 * @param root Gradle 根目录。
 * @param options.queryTasks 是否向 Gradle 查询权威任务列表（默认 false）。
 * @param options.spawn 查询任务时用的执行器 `(argv, cwd, timeoutMs) => Promise<{stdout,code}>`。
 * @param options.taskQueryTimeoutMs 查询超时。
 * @returns `{ targets, projects, structureSource, sources, gradleQuery }`。
 */
export async function discoverTargets(root, options = {}) {
  // ---- 来源 2/3：项目结构 ----
  const idea = await readIdeaGradleConfig(root)
  const fromSettings = await readSettingsProjects(root)
  const { paths: structurePaths, source: structureSource } =
    pickStructureSource(idea.projectPaths, fromSettings)

  const collected = []

  // ---- 来源 1：IDEA 运行配置（最高优先级的静态来源）----
  const fromIntellij = await readIntellijRunConfigs(root)
  for (const config of fromIntellij) {
    collected.push(makeTarget(config.task, 'ideaRun', config.projectPath, { label: config.label }))
  }

  // ---- 来源 0：Gradle 权威任务列表 ----
  //
  // 逐个已知项目查询。这是唯一能证明“这个任务真的存在”的来源，
  // 因此一旦启用，它的结论就是最终结论。
  let gradleQuery = { ok: false, queried: false, projects: 0, tasks: 0 }
  /** 真被问过 Gradle 的项目 → Gradle 为它报出的任务名集合。 */
  const confirmedTasks = new Map()
  if (options.queryTasks === true && typeof options.spawn === 'function') {
    const queryProjects = structurePaths.length > 0 ? structurePaths : [':']
    const queried = []
    for (const projectPath of queryProjects) {
      const result = await queryGradleTasks(root, projectPath, {
        spawn: options.spawn,
        timeoutMs: options.taskQueryTimeoutMs,
      })
      if (!result.ok) {
        gradleQuery = { ok: false, queried: true, error: result.error, projects: queried.length, tasks: 0 }
        break
      }
      queried.push(projectPath)
      const names = new Set()
      for (const task of result.tasks) {
        names.add(task.name)
        if (!RUN_TASK_SHAPE.test(task.name)) continue
        collected.push(makeTarget(`${projectPath === ':' ? '' : projectPath}:${task.name}`, 'gradle', projectPath, {
          description: task.description,
          group: task.group,
        }))
      }
      confirmedTasks.set(projectPath, names)
    }
    if (queried.length === queryProjects.length) {
      gradleQuery = {
        ok: true,
        queried: true,
        projects: queried.length,
        tasks: collected.filter((t) => t.source === 'gradle').length,
      }
    }
  }

  // ---- 来源 3：settings.gradle 推导 ----
  //
  // 这是修掉的一个真实 bug：早先的实现只检查“子项目有没有 build.gradle”，
  // 于是普通 Java 库项目（`plugins { id 'java-library' }`）也被加上
  // :runClient/:runData/:runServer 三个根本不存在、点下去必然失败的任务，
  // 按钮就出现在了不支持 run* 的工作区里。
  //
  // 判据是「构建脚本集合里有没有 MC 生态的运行痕迹」：一个真正能 run 的项目
  // 必然在某处写了 mod 加载器插件、runs 块或 run* 任务字面量，
  // 而普通 Java / Kotlin / Android 项目一个都不会有。
  const declaresRuns = buildDeclaresRuns(root, structurePaths)

  // 根项目是否值得纳入。多模块 monorepo 的根通常是**聚合器**：
  // 它只声明插件（还常常是 `apply false`）并把配置下发给子项目，自己没有 run* 任务。
  // CTNH-Modules 就是这样。因此只有根自己声明了 runs 才把 ':' 加进来。
  // 根项目是否值得纳入。
  //
  // IDEA 与 settings 都可能列出根（`:`），但**列出来不等于它自己可运行**：
  // 多模块 monorepo 的根通常是聚合器，只声明插件（还常常是 `apply(false)`）
  // 并把配置下发给子项目——CTNH-Modules 就是这样。
  // 因此无论路径来自哪个来源，根都必须**单独过一遍 rootDeclaresRuns**：
  // 只有它自己确实声明了 runs 块 / run* 字面量 / 未被 apply(false) 关掉的
  // mod 插件，才把 ':' 纳入。否则会在菜单里塞进点不动的 `:runClient`。
  const projectPaths = new Set(structurePaths)
  const rootHasBuild = exists(join(root, 'build.gradle')) || exists(join(root, 'build.gradle.kts'))
  const rootIsMod = rootHasBuild && rootDeclaresRuns(root)
  if (!rootIsMod) projectPaths.delete(':')
  else projectPaths.add(':')

  // 来源标注跟随**实际**的项目结构来源：结构是从 IDEA 的 gradle.xml 读来的，
  // 就标 idea；只有退回解析 settings.gradle 时才标 settings。
  // 否则菜单会显示“settings.gradle 解析 16”，而实际上那 16 条来自 IDEA，
  // 用户据此判断可信度就会被误导。
  const derivedSource = structureSource === 'idea' ? 'idea' : 'settings'

  // 权威查询成功时，**以 Gradle 的答复为准**：只给真的问过、且报了 run* 任务的项目
  // 推导候选名，绝不凭空补。这样“Gradle 说没有”就不会被我的猜测复活。
  for (const projectPath of projectPaths) {
    if (declaresRuns !== true) break
    if (gradleQuery.ok === true && !confirmedTasks.has(projectPath)) continue
    const dir = projectDir(root, projectPath)
    if (!exists(join(dir, 'build.gradle')) && !exists(join(dir, 'build.gradle.kts'))) continue
    const prefix = projectPath === ':' ? '' : projectPath
    for (const leaf of ['runClient', 'runData', 'runServer']) {
      collected.push(makeTarget(`${prefix}:${leaf}`, derivedSource, projectPath))
    }
  }

  // ---- 来源 4：兜底 ----
  //
  // 只有在**确认这是一个具备 MC 运行能力的 Gradle 项目**、却没能从结构里
  // 推出任何目标时才用。
  //
  // 两道门都必须过：
  //   - `looksLikeGradleRoot`：目录里真有构建脚本，不是随便一个文件夹；
  //   - `declaresRuns`：构建脚本里有 runs 块 / mod 加载器插件 / run* 字面量。
  //
  // 第二道门是修掉“不支持 run* 的工作区仍出现按钮”的关键。早先只查第一道，
  // 于是普通 `java-library` 项目也会被补上三个点不动的假任务。
  // 现在普通 Java / Kotlin / Android 项目在这里得到空结果，按钮就不出现。
  if (collected.length === 0 && declaresRuns && looksLikeGradleRoot(root)) {
    for (const leaf of ['runClient', 'runData', 'runServer']) {
      collected.push(makeTarget(leaf, 'fallback', ':'))
    }
  }

  // ---- Gradle 的否决权 ----
  //
  // 上面的 dedupeByPriority 只能做到“Gradle 说有就一定算数”，做不到
  // “Gradle 说没有就不算数”——静态来源可能给出 Gradle 根本没报的名字。
  //
  // 这对 IDEA 运行配置是真实风险：`.run/*.run.xml` 是用户手写的，任务改名或
  // 删掉之后那条配置会留在硬盘上，于是菜单里多出一个点下去必然失败的死按钮。
  // 用户报过两次“不支持 runxxx 的地方也有按钮”，属于同一类问题。
  //
  // 因此：**只对真的问过 Gradle 的项目**执行否决，且只否决静态来源。
  // 限定“问过的项目”很关键——IDEA 可能列出一个我查不到的项目（复合构建、
  // 我的 settings 解析漏掉的 include）。那种情况下 Gradle 从没就它发过话，
  // 把“没问过”当成“不存在”会误删真实目标。
  if (gradleQuery.ok === true) {
    for (let i = collected.length - 1; i >= 0; i -= 1) {
      const target = collected[i]
      if (target.source === 'gradle') continue
      const names = confirmedTasks.get(target.projectPath)
      if (names === undefined) continue
      if (!names.has(target.leaf)) collected.splice(i, 1)
    }
  }

  // ---- 按优先级去重 ----
  const deduped = dedupeByPriority(collected)

  // IDEA 运行配置是用户自己挑出来的入口，某个项目被引用得越多越可能是主模块。
  // 用这个计数给默认目标排序，比按任务名字母序可靠得多。
  const intellijWeight = new Map()
  for (const target of fromIntellij) {
    intellijWeight.set(target.projectPath, (intellijWeight.get(target.projectPath) ?? 0) + 1)
  }

  const enriched = deduped.map((target) => ({
    ...target,
    weight: intellijWeight.get(target.projectPath) ?? 0,
  }))
  const order = { client: 0, data: 1, server: 2, other: 3 }
  // 同 kind 内先按来源优先级，再按任务名——让 Gradle 确认过的任务排在前面。
  enriched.sort((a, b) => (order[a.kind] - order[b.kind])
    || (a.priority - b.priority)
    || a.task.localeCompare(b.task))

  // 各来源贡献了多少条，供诊断路由展示“这个结论是怎么来的”。
  const sources = {}
  for (const target of enriched) {
    sources[target.source] = (sources[target.source] ?? 0) + 1
  }

  return {
    targets: enriched,
    projects: [...projectPaths],
    structureSource,
    ideaGradleJvm: idea.gradleJvm,
    sources,
    gradleQuery,
  }
}

/**
 * 判定一个 Gradle 根「这个工作区能不能跑 MC」。
 *
 * **这是全插件唯一的裁决点**：会话头部按钮显不显示、系统提示词要不要注入
 * MC 运行说明，都必须走这里。两处各写一遍判据就会出现「有提示词但没按钮」
 * （或反过来）的分裂状态，而用户看到的只有一个自相矛盾的界面。
 *
 * 判据本身沿用修过的两次 bug 的结论：目录确实是个 Gradle 根，**且**发现到了
 * run* 目标。`discoverTargets` 内部已经用 `buildDeclaresRuns` 挡掉了普通
 * Java / Kotlin / Android 项目（那里一条 run* 目标都不会产出），所以第二项
 * 成立就意味着构建脚本里真有 MC 运行能力，不需要在这里再判一次。
 *
 * @param root Gradle 根目录。
 * @returns `{ available, unavailableReason, targets, projects, info, sources,
 *   structureSource, gradleQuery }`。
 */
export async function assessRoot(root) {
  const { targets, projects, sources, structureSource, gradleQuery } = await discoverTargets(root)
  const info = await describeRoot(root)
  const isGradleProject = looksLikeGradleRoot(root)
  const available = isGradleProject && targets.length > 0
  return {
    root,
    targets,
    projects,
    info,
    sources,
    structureSource,
    gradleQuery,
    available,
    unavailableReason: !isGradleProject
      ? `未在 ${root} 找到 Gradle 构建脚本（settings.gradle / build.gradle）`
      : targets.length === 0
        ? `${root} 是 Gradle 项目，但没有发现任何 run* 任务`
        : undefined,
  }
}

export function pickDefaultTarget(targets, preferred) {
  const scoped = preferred === undefined
    ? targets
    : targets.filter((target) => target.projectPath === preferred)
  const pool = scoped.length > 0 ? scoped : targets
  return bestOf(pool.filter((target) => target.kind === 'client'))
    ?? bestOf(pool.filter((target) => target.kind === 'data'))
    ?? pool[0]
}

/** 同 kind 候选中按 IDEA 权重降序取第一，权重相同时保持原有字母序。 */
function bestOf(candidates) {
  if (candidates.length === 0) return undefined
  return candidates.reduce((best, candidate) => (
    (candidate.weight ?? 0) > (best.weight ?? 0) ? candidate : best
  ))
}

/**
 * 把一个 kind 或任务名解析成具体目标。
 *
 * 模型与按钮都按 kind（client / data / server）表达意图，但仓库里可能有多套，
 * 因此这里把 kind 收敛到唯一目标：优先 preferred 项目，其次默认目标。
 *
 * @param targets 全部目标。
 * @param selector kind（client/data/server）或完整任务名或项目路径。
 * @param preferred 期望的项目路径，可为空。
 * @returns 命中的目标，或 undefined。
 */
export function resolveTarget(targets, selector, preferred) {
  if (typeof selector === 'string' && selector.includes(':')) {
    return targets.find((target) => target.task === selector)
      ?? targets.find((target) => target.task === `:${selector}`)
  }
  const wanted = typeof selector === 'string' && selector.length > 0 ? selector.toLowerCase() : undefined
  const byKind = wanted === undefined
    ? targets
    : targets.filter((target) => target.kind === wanted || target.leaf.toLowerCase() === wanted)
  const scoped = preferred === undefined
    ? byKind
    : byKind.filter((target) => target.projectPath === preferred)
  const pool = scoped.length > 0 ? scoped : byKind
  return pool[0]
}

/**
 * 为一个 Gradle 根整理出 `gradlew` 调用所需的 argv 前缀。
 *
 * Windows 上 .bat 不能直接 spawn，必须经 cmd.exe 转发；POSIX 上直接执行 wrapper。
 * wrapper 缺失时退回 PATH 上的 `gradle`，并把这一点告诉调用方以便提示用户。
 *
 * @param root Gradle 根目录。
 * @returns `{ argv, cwd, wrapperMissing }`，argv 已包含可执行文件与转发参数。
 */
export function gradleInvocation(root) {
  const wrapper = join(root, wrapperName())
  if (exists(wrapper)) {
    return process.platform === 'win32'
      ? { argv: ['cmd.exe', '/d', '/s', '/c', wrapper], cwd: root, wrapperMissing: false }
      : { argv: [wrapper], cwd: root, wrapperMissing: false }
  }
  return { argv: ['gradle'], cwd: root, wrapperMissing: true }
}

/** 项目名，用于展示。 */
export function projectName(root) {
  return basename(root) || root
}

/**
 * 读取 IDEA 的 `.idea/gradle.xml`，取出 IDEA 认定的 Gradle 模块列表。
 *
 * 这是 IDEA 自己同步下来的、**权威**的项目结构：它列出了
 * `$PROJECT_DIR$/modules/CTNH-Core` 这种真实的模块目录，
 * 比我们从 `settings.gradle` 正则解析 include 更可靠（后者会被
 * 各种 `include` 写法、变量拼接、条件包含骗到）。
 *
 * 只用 `.idea/gradle.xml`：它是纯 XML、稳定、且就在仓库里。
 * IDEA 的二进制模型缓存（`external_build_system/project.dat`）**不**在这里读——
 * 那是 IDEA 的内部序列化格式，随版本变化，而且实测它并不保存任务名
 * （IDEA 是通过 Gradle Tooling API 实时查询任务的），解析它既脆弱又没收益。
 *
 * @param root Gradle 根目录。
 * @returns `{ projectPaths, externalProjectPath, gradleJvm }`；没有该文件时返回空。
 */
export async function readIdeaGradleConfig(root) {
  const file = join(root, '.idea', 'gradle.xml')
  if (!exists(file)) return { projectPaths: [], source: 'none' }
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { projectPaths: [], source: 'none' }
  }

  // modules/set 里的每个 <option value="$PROJECT_DIR$" /> 或 `$PROJECT_DIR$/子路径`。
  //
  // **必须保留根项目本身**（suffix 为空 → `:`）。单模块项目的 IDEA 配置里
  // 就只有这一条：
  //     <option value="$PROJECT_DIR$" />
  // 早先这里 `if (suffix.length === 0) continue` 把根跳过了，于是 GTPonder /
  // GregTech-Construct 这类单模块项目读出来的 projectPaths 是**空数组**，
  // IDEA 这个来源等于完全没用上，菜单里就显示成“settings.gradle 解析”。
  // 多模块仓库（CTNH-Modules）因为还有子项目条目，才掩盖了这个 bug。
  const projectPaths = []
  const seen = new Set()
  for (const match of text.matchAll(/<option\s+value="\$PROJECT_DIR\$([^"]*)"\s*\/>/g)) {
    const suffix = match[1].replace(/^\/+/, '').replace(/\/+$/, '')
    // `$PROJECT_DIR$` → `:`；`$PROJECT_DIR$/modules/CTNH-Core` → `:modules:CTNH-Core`
    const path = suffix.length === 0 ? ':' : `:${suffix.split('/').join(':')}`
    if (seen.has(path)) continue
    seen.add(path)
    projectPaths.push(path)
  }

  const external = text.match(/<option\s+name="externalProjectPath"\s+value="([^"]*)"/)
  const jvm = text.match(/<option\s+name="gradleJvm"\s+value="([^"]*)"/)
  return {
    projectPaths,
    externalProjectPath: external?.[1]?.replace('$PROJECT_DIR$', root),
    gradleJvm: jvm?.[1],
    source: projectPaths.length > 0 ? 'idea' : 'none',
  }
}

/**
 * 从 `gradlew <project>:tasks --all` 的输出里解析出任务名。
 *
 * 这是**权威**的任务清单：Gradle 自己报的，不存在“猜错了”的可能。
 * 代价是要跑一次 Gradle（本仓库实测约 7 秒），所以只在需要时才调用，
 * 并配合缓存与超时使用。
 *
 * 解析规则：Gradle 的 tasks 输出按分组排列，任务行形如
 *   `runClient - Runs the client Minecraft run configuration.`
 * 分组标题形如 `Mod development tasks`，下划线一行 `-------------`。
 * 只取任务行（含 ` - ` 且不以 `Pattern:` 开头），分组名一并记下供展示。
 *
 * @param text Gradle 的标准输出。
 * @returns `{ tasks, groups }`，tasks 为 `{ name, group, description }`。
 */
export function parseGradleTasksOutput(text) {
  const tasks = []
  const groups = new Map()
  let group = 'Other'
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    // 下划线分隔行：下一行若是分组名，会在下一轮被识别。
    if (/^-{3,}$/.test(line)) continue
    // 分组标题：非任务行、非空、不是分隔线，且下一行是分隔线。
    const taskMatch = line.match(/^([A-Za-z][A-Za-z0-9_:]*)\s+-\s+(.*)$/)
    if (taskMatch !== null && !line.startsWith('Pattern:')) {
      const name = taskMatch[1]
      const description = taskMatch[2].trim()
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(name)
      tasks.push({ name, group, description })
      continue
    }
    // 其它非任务行当作可能的分组标题。
    if (!line.includes(' ') || /^[A-Z][A-Za-z0-9 /()'-]*$/.test(line)) {
      group = line
    }
  }
  return { tasks, groups: [...groups.entries()].map(([name, members]) => ({ name, members })) }
}

/**
 * 跑一次 Gradle 任务枚举，拿到权威任务清单。
 *
 * @param root Gradle 根目录。
 * @param projectPath 目标项目路径（`:modules:CTNH-Core`）。
 * @param options.spawn 注入的同步执行器 `(argv, cwd, timeoutMs) => Promise<{stdout, code}>`。
 * @param options.timeoutMs 超时上限。
 * @returns `{ tasks, groups, ok, error }`；失败时 ok=false 并给出原因。
 */
export async function queryGradleTasks(root, projectPath, options = {}) {
  const spawnFn = options.spawn
  if (typeof spawnFn !== 'function') {
    return { tasks: [], groups: [], ok: false, error: '没有可用的命令执行器' }
  }
  const invocation = gradleInvocation(root)
  const target = projectPath === ':' || projectPath === undefined ? 'tasks' : `${projectPath}:tasks`
  const result = await spawnFn(
    [...invocation.argv, target, '--all', '--console=plain', '--quiet'],
    invocation.cwd,
    options.timeoutMs ?? 180_000,
  )
  if (result.code !== 0) {
    return {
      tasks: [],
      groups: [],
      ok: false,
      error: `Gradle 任务枚举失败（退出码 ${result.code}）`,
      raw: (result.stdout + result.stderr).slice(-2000),
    }
  }
  const parsed = parseGradleTasksOutput(result.stdout + result.stderr)
  return { ...parsed, ok: true, wrapperMissing: invocation.wrapperMissing }
}

/**
 * 判断一个目录是否像 Gradle 项目根。
 * @param dir 待判定目录。
 */
export function looksLikeGradleRoot(dir) {
  return ROOT_MARKERS.some((marker) => exists(join(dir, marker)))
}

/** 目录信息：用于诊断路由展示解析过程。 */
export async function describeRoot(root) {
  const info = { root, gradleWrapper: exists(join(root, wrapperName())) }
  try {
    const stats = await stat(root)
    info.exists = stats.isDirectory()
  } catch {
    info.exists = false
  }
  return info
}
