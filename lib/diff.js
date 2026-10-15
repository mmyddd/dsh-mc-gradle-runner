/**
 * runData 产物 diff：快照 + 比对。
 *
 * 数据生成（runData）的产出落在源码树里，且通常是被版本控制的目录，
 * 所以“有没有 diff”等价于“这些目录的内容相对任务启动前变了没有”。
 *
 * 采集分两条独立来源，互为补充：
 *   1. 目录快照比对 —— 不依赖 git，也不受 .gitignore 影响，覆盖新增/修改/删除，
 *      是主来源。runData 前拍快照，settle 后重扫并产出 FileDiff。
 *   2. `git status` / `git diff` —— 作为补充来源，能覆盖生成目录之外的改动
 *      （例如数据生成器顺手改到的注册表文件）。git 缺失或非仓库时静默跳过。
 *
 * @module dsh-mc-gradle-runner/diff
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * 数据生成产物的候选目录，相对**单个项目目录**。
 *
 * 覆盖 NeoForge / Forge 的 `src/generated/resources`、部分模板的 `src/generated`，
 * 以及 Architectury / Loom 常见的 `src/main/generated`。
 * `.cache` 子目录是数据生成器的内部缓存，逐行 diff 没有阅读价值，显式排除。
 */
export const DATAGEN_DIRS = [
  'src/generated/resources',
  'src/generated',
  'src/main/generated',
  'src/main/resources/generated',
]

/** 快照时跳过的目录名，避免把缓存与构建产物卷进来。 */
const SKIP_DIRS = new Set(['.cache', '.gradle', 'build', 'node_modules', '.git', '.idea'])

/** 单个文件参与 hash 的最大字节数；再大也不可能是数据生成产物。 */
const MAX_HASH_BYTES = 8 * 1024 * 1024

/**
 * 在给定目录集合里找出真实存在的数据生成产物目录。
 *
 * 关键点：产物目录是**每个子项目各自一份**的，不在 Gradle 根下面。
 * CTNH-Modules 这种 monorepo 的全部产物都在 `modules/<mod>/src/generated/resources`，
 * 只在根上找会一个都找不到，runData 的 diff 就永远是空的。
 *
 * @param roots 候选项目目录（Gradle 根 + 各子项目）。
 * @returns `{ abs, rel }` 数组，rel 是相对 Gradle 根的 POSIX 路径，用于展示。
 */
export function findDatagenDirs(roots, gradleRoot) {
  const found = []
  const seen = new Set()
  for (const dir of roots) {
    for (const rel of DATAGEN_DIRS) {
      const abs = join(dir, rel)
      if (!existsSync(abs)) continue
      // `src/generated` 与 `src/generated/resources` 同时存在时只保留更具体的那个，
      // 否则同一批文件会被扫两遍。
      if (seen.has(abs)) continue
      seen.add(abs)
      found.push({ abs, rel: toPosix(relative(gradleRoot, abs)) })
    }
  }
  // 去掉被其它候选完全包含的目录。
  return found.filter((candidate) => !found.some((other) => (
    other.abs !== candidate.abs && candidate.abs.startsWith(other.abs + sep)
  )))
}

/**
 * 递归列出一个目录下的全部文件，返回相对该目录的 POSIX 风格路径。
 *
 * @param base 基准目录（用于计算相对路径）。
 * @param dir 当前遍历目录。
 * @param out 累积结果。
 */
async function walk(base, dir, out) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(base, join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    out.push(join(dir, entry.name))
  }
}

/**
 * 为一个 Gradle 根建立数据生成产物的内容快照。
 *
 * 只记录文件路径与内容 hash；内容留到比对阶段按需读取，
 * 因此一次快照的成本是 O(文件数) 次 hash，而不是把全部产物读进内存。
 *
 * **同时保留旧内容**：这是 diff 正确性的关键。快照是在任务**启动前**拍的，
 * 只有此时读到的内容才是“旧内容”。如果等到任务跑完再去读，读到的已经是新内容，
 * 于是 oldText === newText，diff 卡片会显示“没有任何变化”——这正是本模块
 * 最初版本的 bug。
 *
 * 内存用两道闸门兜住：单文件超过 `maxTextBytes` 不保留文本（改判为“无法比对内容”），
 * 以及所有保留文本的累计字节不超过 `textBudgetBytes`。超预算的文件仍参与
 * 新增/删除/修改的判定（靠 hash），只是拿不到内容级 diff。
 *
 * @param roots 候选项目目录（Gradle 根 + 各子项目）。
 * @param gradleRoot Gradle 根，用于计算展示路径；省略时取 roots 的第一个。
 * @param options.maxTextBytes 单文件保留旧内容的字节上限。
 * @param options.textBudgetBytes 全部保留旧内容的累计字节上限。
 * @returns `{ root, files: Map<相对路径, {hash, text}>, dirs, dirPaths, textRetained }`。
 */
export async function createSnapshot(roots, gradleRoot, options = {}) {
  // 兼容旧签名：只给一个字符串时按“只有 Gradle 根”处理。
  const projectRoots = Array.isArray(roots) ? roots : [roots]
  const base = gradleRoot ?? (Array.isArray(roots) ? roots[0] : roots)
  const maxTextBytes = options.maxTextBytes ?? 512 * 1024
  const textBudgetBytes = options.textBudgetBytes ?? 64 * 1024 * 1024
  const candidates = findDatagenDirs(projectRoots, base)
  const files = new Map()
  const dirs = []
  let spent = 0
  let textRetained = 0
  for (const candidate of candidates) {
    dirs.push(candidate.rel)
    const found = []
    await walk(base, candidate.abs, found)
    for (const file of found) {
      const rel = toPosix(relative(base, file))
      const entry = await readForSnapshot(file, maxTextBytes)
      if (entry === undefined) continue
      // 预算用尽后仍记录 hash（保证增删改判定完整），只是不带文本。
      if (entry.text !== undefined && spent + entry.bytes <= textBudgetBytes) {
        spent += entry.bytes
        textRetained += 1
        files.set(rel, { hash: entry.hash, text: entry.text })
      } else {
        files.set(rel, { hash: entry.hash })
      }
    }
  }
  return {
    root: base,
    files,
    dirs,
    dirPaths: candidates.map((c) => c.abs),
    textRetained,
    textBytes: spent,
  }
}

/** 把平台路径分隔符统一成 `/`，让 diff 展示与 git 输出一致。 */
function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * 读取一个文件用于快照：返回 hash，并在可判定为文本且不超限时附带内容。
 *
 * @param file 绝对路径。
 * @param maxTextBytes 保留文本的字节上限。
 * @returns `{ hash, text?, bytes }`；不可读或过大时返回 undefined。
 */
async function readForSnapshot(file, maxTextBytes) {
  try {
    const stats = await stat(file)
    if (!stats.isFile() || stats.size > MAX_HASH_BYTES) return undefined
    const bytes = await readFile(file)
    const hash = createHash('sha1').update(bytes).digest('hex')
    // 二进制（含 NUL）与超限文件不保留文本，但仍返回 hash 参与增删改判定。
    if (bytes.length > maxTextBytes || bytes.includes(0)) return { hash, bytes: 0 }
    return { hash, text: bytes.toString('utf8'), bytes: bytes.length }
  } catch {
    return undefined
  }
}

/**
 * 计算文件内容 hash；不可读或超限时返回 undefined。
 * @param file 绝对路径。
 */
async function hashFile(file) {
  try {
    const stats = await stat(file)
    if (!stats.isFile() || stats.size > MAX_HASH_BYTES) return undefined
    const bytes = await readFile(file)
    return createHash('sha1').update(bytes).digest('hex')
  } catch {
    return undefined
  }
}

/**
 * 读取文件文本；二进制或不可读时返回 null（调用方据此降级成“二进制已变更”）。
 * @param file 绝对路径。
 * @param maxBytes 参与 diff 的字节上限。
 */
async function readText(file, maxBytes) {
  try {
    const stats = await stat(file)
    if (stats.size > maxBytes) return { tooLarge: true, text: null }
    const bytes = await readFile(file)
    // NUL 字节是二进制文件的可靠信号。
    if (bytes.includes(0)) return { binary: true, text: null }
    return { text: bytes.toString('utf8') }
  } catch {
    return { text: null }
  }
}

/**
 * 比对快照与当前磁盘状态，产出 FileDiff 列表。
 *
 * 输出按“新增 → 修改 → 删除”分组排序，并把超过 maxFiles 的部分折叠成统计，
 * 避免一次 runData 产生上千个文件时把工具结果撑爆。
 *
 * @param snapshot {@link createSnapshot} 的产物。
 * @param options.maxFiles 最多返回多少个文件的完整 diff。
 * @param options.maxBytes 单个文件参与 diff 的最大字节数。
 * @returns `{ diffs, stats }`；diffs 为 `{path, oldText, newText}` 数组。
 */
export async function collectDiff(snapshot, options = {}) {
  const maxFiles = options.maxFiles ?? 40
  const maxBytes = options.maxBytes ?? 512 * 1024
  const { root, files: before } = snapshot

  // 重新扫描同一批目录。
  const after = new Map()
  // 优先用快照记下的绝对路径；旧快照（只有 rel）时退回按 root 拼接。
  const scanDirs = snapshot.dirPaths ?? snapshot.dirs.map((rel) => join(root, rel))
  for (const abs of scanDirs) {
    const found = []
    await walk(root, abs, found)
    for (const file of found) {
      const hash = await hashFile(file)
      if (hash === undefined) continue
      after.set(toPosix(relative(root, file)), { hash })
    }
  }

  const added = []
  const modified = []
  const removed = []
  for (const [path, entry] of after) {
    const previous = before.get(path)
    if (previous === undefined) added.push(path)
    else if (previous.hash !== entry.hash) modified.push(path)
  }
  for (const path of before.keys()) {
    if (!after.has(path)) removed.push(path)
  }
  added.sort()
  modified.sort()
  removed.sort()

  const all = [
    ...added.map((path) => ({ path, kind: 'added' })),
    ...modified.map((path) => ({ path, kind: 'modified' })),
    ...removed.map((path) => ({ path, kind: 'removed' })),
  ]

  const diffs = []
  let skippedLarge = 0
  let skippedBinary = 0
  let contentUnavailable = 0
  for (const entry of all.slice(0, maxFiles)) {
    const file = join(root, entry.path)
    // 新内容从磁盘读；删除的文件没有新内容。
    const next = entry.kind === 'removed' ? { text: '' } : await readText(file, maxBytes)
    if (next.tooLarge === true) {
      skippedLarge += 1
      continue
    }
    if (next.binary === true) {
      skippedBinary += 1
      continue
    }
    // 旧内容必须取自**快照**（任务启动前读到的），而不是现在去磁盘读——
    // 现在读到的已经是新内容，oldText 会等于 newText，diff 就显示不出变化。
    let oldText = null
    if (entry.kind !== 'added') {
      const recorded = before.get(entry.path)
      oldText = recorded?.text ?? null
      // 快照没保留文本（二进制/超限/超预算）时，标记内容不可比对，
      // 但仍然给出这条记录，让调用方知道文件变了。
      if (oldText === null && entry.kind === 'modified') contentUnavailable += 1
    }
    diffs.push({
      path: entry.path,
      kind: entry.kind,
      oldText,
      newText: next.text ?? '',
    })
  }

  return {
    diffs,
    stats: {
      added: added.length,
      modified: modified.length,
      removed: removed.length,
      total: all.length,
      shown: diffs.length,
      skippedLarge,
      skippedBinary,
      contentUnavailable,
      truncated: all.length > maxFiles,
    },
  }
}

/**
 * 用 git 收集补充 diff。
 *
 * git 不可用、目录不是仓库、或仓库里没有任何改动时都返回空结果，
 * 绝不因为 git 的问题让整个 runData 结果失败。
 *
 * @param spawnFn 注入的 spawn 实现 `(argv, cwd) => Promise<{stdout, code}>`。
 * @param root Gradle 根目录。
 * @returns `{ changed: string[], diffText: string, available: boolean }`。
 */
export async function collectGitDiff(spawnFn, root) {
  const probe = await spawnFn(['git', 'rev-parse', '--is-inside-work-tree'], root)
  if (probe.code !== 0 || probe.stdout.trim() !== 'true') {
    return { changed: [], diffText: '', available: false }
  }
  const status = await spawnFn(['git', 'status', '--porcelain'], root)
  if (status.code !== 0) return { changed: [], diffText: '', available: false }
  const changed = status.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0)
  // --stat 比完整 diff 更适合模型阅读；完整内容仍可从工作区读取。
  const stat = await spawnFn(['git', 'diff', '--stat', '--no-color'], root)
  return {
    changed,
    diffText: stat.code === 0 ? stat.stdout.trim() : '',
    available: true,
  }
}

/**
 * 把 diffs 渲染成模型可读的文本块。
 *
 * runData 的产出是**结构化数据文件**（lang / 配方 / 标签 / 模型 json），
 * 光说“哪个文件变了”对排查帮助有限，因此这里给三层信息：
 *
 *   1. **总量**：新增/修改/删除各多少个文件；
 *   2. **按类目分组**：把路径归到 lang / 配方 / 标签 / 模型 / 战利品表 / 其他，
 *      一眼看出这次 datagen 动了哪个层面；
 *   3. **真实行级 diff**：对每个文件算出 +N/-M，并给出前若干行实际改动内容
 *      （受 maxHunkLines 限制），让模型不必再逐个 read。
 *
 * @param result {@link collectDiff} 的产物。
 * @param git {@link collectGitDiff} 的产物，可为空。
 * @param options.maxHunkLines 每个文件最多输出多少行改动内容。
 * @returns 多行文本。
 */
export function renderDiffSummary(result, git, options = {}) {
  const { diffs, stats } = result
  const maxHunkLines = options.maxHunkLines ?? 40
  const lines = []
  if (stats.total === 0) {
    lines.push('runData 未产生任何产物变更（数据生成结果与任务启动前一致）。')
  } else {
    lines.push(`产物变更：新增 ${stats.added} · 修改 ${stats.modified} · 删除 ${stats.removed}（共 ${stats.total} 个文件）`)

    // 按类目分组统计：datagen 的产出层次分明，分组比平铺列表有用得多。
    const groups = new Map()
    for (const diff of diffs) {
      const category = categorizePath(diff.path)
      if (!groups.has(category)) groups.set(category, [])
      groups.get(category).push(diff)
    }
    lines.push('')
    lines.push('按类目分布：')
    for (const [category, members] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const a = members.filter((d) => d.kind === 'added').length
      const m = members.filter((d) => d.kind === 'modified').length
      const r = members.filter((d) => d.kind === 'removed').length
      lines.push(`  ${category}：${members.length} 个（新增 ${a} · 修改 ${m} · 删除 ${r}）`)
    }

    lines.push('')
    lines.push('逐个文件：')
    for (const diff of diffs) {
      const marker = diff.kind === 'added' ? 'A' : diff.kind === 'modified' ? 'M' : 'D'
      lines.push(`  ${marker} ${diff.path}${describeChange(diff)}`)
      // 行级改动内容：只在能算出实际变化时输出，避免噪音。
      const hunk = renderHunk(diff, maxHunkLines)
      if (hunk.length > 0) {
        for (const line of hunk) lines.push(`      ${line}`)
      }
    }
    if (stats.truncated) {
      lines.push(`  … 其余 ${stats.total - stats.shown} 个文件未展开（受 maxDiffFiles 限制）`)
    }
    if (stats.skippedLarge > 0) lines.push(`  （${stats.skippedLarge} 个文件超过 diffMaxBytes，已跳过内容比对）`)
    if (stats.skippedBinary > 0) lines.push(`  （${stats.skippedBinary} 个二进制文件已跳过）`)
    if (stats.contentUnavailable > 0) {
      lines.push(`  （${stats.contentUnavailable} 个文件未能从快照取到旧内容，只给出增删改标记）`)
    }
  }
  if (git?.available === true && git.changed.length > 0) {
    lines.push('')
    lines.push(`git 工作区另有 ${git.changed.length} 处变更：`)
    for (const path of git.changed.slice(0, 20)) lines.push(`  ${path}`)
    if (git.changed.length > 20) lines.push(`  … 其余 ${git.changed.length - 20} 处`)
    if (git.diffText.length > 0) {
      lines.push('')
      lines.push(git.diffText)
    }
  }
  return lines.join('\n')
}

/**
 * 把产物路径归类到 datagen 的语义层次。
 *
 * 这些目录名是 MC 数据生成的稳定约定（assets/<ns>/lang、data/<ns>/recipes、
 * data/<ns>/tags、assets/<ns>/models、data/<ns>/loot_tables 等），
 * 分组后一眼看出这次改了哪一层，比按字母序平铺有用得多。
 *
 * @param path 相对 Gradle 根的 POSIX 路径。
 * @returns 类目名。
 */
export function categorizePath(path) {
  const p = path.toLowerCase()
  if (p.includes('/lang/') || p.endsWith('.lang')) return 'lang 语言文件'
  if (p.includes('/recipes/') || p.includes('/recipe/')) return 'recipes 配方'
  if (p.includes('/tags/') || p.includes('/tag/')) return 'tags 标签'
  if (p.includes('/models/') || p.includes('/blockstates/')) return 'models/blockstates 模型'
  if (p.includes('/loot_tables/') || p.includes('/loot_modifiers/')) return 'loot 战利品表'
  if (p.includes('/advancements/')) return 'advancements 进度'
  if (p.includes('/textures/') || p.endsWith('.png')) return 'textures 贴图'
  if (p.includes('/worldgen/') || p.includes('/dimension')) return 'worldgen 世界生成'
  if (p.endsWith('.json')) return '其他 json'
  return '其他'
}

/**
 * 用**真实行级差异**描述一次变更：+N/-M 而不是笼统的行数变化。
 *
 * 早期实现只给 `before → after 行`，对“改了一个配方里的一个值”这类常见情况，
 * 行数根本没变（显示 `2 → 2 行，+0`），看不出到底改了什么。因此这里算真正的
 * 行集差：以旧文件的行集合为基准，统计新增行与删除行。
 *
 * @param diff 一个文件的三态内容。
 * @returns 形如 `（+2 行 / -1 行）` 的描述。
 */
function describeChange(diff) {
  const before = toLines(diff.oldText)
  const after = toLines(diff.newText)
  if (diff.kind === 'added') return `（新增 ${after.length} 行）`
  if (diff.kind === 'removed') return `（删除 ${before.length} 行）`
  const { added, removed } = lineDelta(before, after)
  if (added === 0 && removed === 0) return '（内容有变，但行数与行内容看起来相同——可能是编码或空行差异）'
  return `（+${added} 行 / -${removed} 行）`
}

/**
 * 输出一小段真实改动内容，供模型直接阅读。
 *
 * 用最长公共前后缀裁掉未变部分，只展示中间变化区（附带少量上下文）。
 * 这是 rote 的“单块 diff”，对 datagen 的“整段替换”型改动足够准确，
 * 且不需要引入完整的 diff 算法依赖。
 *
 * @param diff 一个文件的三态内容。
 * @param maxLines 最多输出多少行。
 * @returns 若干行文本；无内容可比对时返回空数组。
 */
function renderHunk(diff, maxLines) {
  if (diff.oldText === null && diff.newText.length === 0) return []
  if (diff.kind === 'removed') return []
  const before = toLines(diff.oldText)
  const after = toLines(diff.newText)

  // 公共前缀 / 公共后缀，裁掉未变部分。
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < before.length - head
    && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail += 1

  const removedLines = before.slice(head, before.length - tail)
  const addedLines = after.slice(head, after.length - tail)
  const out = []
  const budget = Math.max(0, maxLines)
  for (const line of removedLines) {
    if (out.length >= budget) break
    out.push(`- ${truncateLine(line)}`)
  }
  for (const line of addedLines) {
    if (out.length >= budget) break
    out.push(`+ ${truncateLine(line)}`)
  }
  const omitted = (removedLines.length + addedLines.length) - out.length
  if (omitted > 0) out.push(`… 另有 ${omitted} 行改动未展开`)
  return out
}

/** 把文本切成行；null（新增文件的旧内容）按空处理。 */
function toLines(text) {
  if (text === null || text === undefined || text.length === 0) return []
  return text.split(/\r?\n/)
}

/**
 * 统计两组行之间的新增/删除行数。
 *
 * 用多重集（multiset）计数做近似：对 datagen 常见的“整段替换”与“增删若干行”
 * 都足够准确，且是 O(n) 的，不需要跑完整 LCS。重复行会被正确配对，
 * 不会把“同一行出现两次”误判成两次新增。
 *
 * @param before 旧行数组。
 * @param after 新行数组。
 * @returns `{ added, removed }`。
 */
export function lineDelta(before, after) {
  const counts = new Map()
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of after) {
    const remaining = counts.get(line) ?? 0
    if (remaining > 0) counts.set(line, remaining - 1)
    else added += 1
  }
  let removed = 0
  for (const remaining of counts.values()) removed += remaining
  return { added, removed }
}

/** 单行过长时截断，避免一行 json 把反馈撑爆。 */
function truncateLine(line) {
  const max = 400
  return line.length > max ? `${line.slice(0, max)}…` : line
}
