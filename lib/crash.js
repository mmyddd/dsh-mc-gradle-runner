/**
 * runClient 崩溃识别：从任务输出里找出 crash-report，并把可读摘要交给模型。
 *
 * 背景：`runClient` 拉起的是一个**长命的游戏进程**，它可能：
 *   - 正常关服/关客户端（退出码 0）；
 *   - 被用户从按钮强制结束；
 *   - **崩了**——游戏打印一份 crash-report，退出码通常非 0。
 *
 * 第三种情况是模型最需要知道的：光看“退出码 1”没有任何诊断价值，
 * 真正的信息在那份 crash-report 里。因此这个模块负责：
 *   1. 从 stdout/stderr 里认出崩溃特征行；
 *   2. 在磁盘上定位那份报告文件（`<runDir>/crash-reports/crash-*.txt`）；
 *   3. 抽出摘要（描述、异常、栈顶几帧、可疑 mod、报告 UUID）与路径。
 *
 * 输出的路径与摘要会回给模型，模型据此可以再决定要不要 read 完整报告。
 *
 * @module dsh-mc-gradle-runner/crash
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 输出里出现即代表“游戏崩了”的特征。
 *
 * 覆盖 Forge / NeoForge / Fabric 的常见打印：
 *   - `---- Minecraft Crash Report ----` 是报告正文的标题，会被回显到控制台；
 *   - `Crash report saved to:` / `This crash report has been saved to:` 是各加载器
 *     在保存后打印的路径提示；
 *   - `net.minecraft.crash.ReportedException` 与 `java.lang.*Exception` 在
 *     "Description:" 上下文里出现时基本就是崩溃；
 *   - `A fatal error has been detected by the Java Runtime Environment` 是 JVM 崩溃。
 */
const CRASH_MARKERS = [
  /----\s*Minecraft Crash Report\s*----/i,
  /crash report (?:has been )?saved to[:\s]+(.+)/i,
  /This crash report has been saved to[:\s]+(.+)/i,
  /net\.minecraft\.crash\.ReportedException/,
  /A fatal error has been detected by the Java Runtime Environment/,
]

/** 从输出里直接抓路径的两种句式。 */
const PATH_PATTERNS = [
  /crash report (?:has been )?saved to[:\s]+(.+?)(?:\r?\n|$)/i,
  /This crash report has been saved to[:\s]+(.+?)(?:\r?\n|$)/i,
]

/** 崩溃报告所在的子目录名（MC 的稳定约定）。 */
const CRASH_DIRS = [
  'run/crash-reports',
  'crash-reports',
  'runs/client/crash-reports',
  'runs/server/crash-reports',
]

/** 摘要里最多保留几帧调用栈。 */
const MAX_FRAMES = 12

/**
 * 从任务输出里判断是否发生了崩溃。
 *
 * @param output 任务的完整输出（stdout+stderr 合并后的文本）。
 * @returns `{ crashed, reportedPath }`；`reportedPath` 是输出里直接给出的路径（可能为空）。
 */
export function detectCrash(output) {
  if (typeof output !== 'string' || output.length === 0) {
    return { crashed: false, reportedPath: undefined }
  }
  let crashed = false
  for (const marker of CRASH_MARKERS) {
    if (marker.test(output)) {
      crashed = true
      break
    }
  }
  let reportedPath
  for (const pattern of PATH_PATTERNS) {
    const match = output.match(pattern)
    if (match !== null) {
      reportedPath = match[1].trim().replace(/^["']|["']$/g, '')
      crashed = true
      break
    }
  }
  return { crashed, reportedPath }
}

/**
 * 在项目里定位最近的一份 crash-report。
 *
 * 优先级：输出里明确给出的路径 → `<projectRoot>/run/crash-reports` 下最新的
 * `crash-*.txt` → 其余候选目录。找不到时返回 undefined，不在磁盘上乱翻。
 *
 * @param projectRoot Gradle 项目根。
 * @param options.reportedPath 输出里给出的路径（相对或绝对）。
 * @param options.sinceMs 只认这个时刻之后修改的报告，避免把上次崩溃的旧报告当成本次。
 * @returns `{ path, mtimeMs, size }` 或 undefined。
 */
export async function locateCrashReport(projectRoot, options = {}) {
  // 1) 输出直接给了路径：优先采信，但必须真的存在。
  if (typeof options.reportedPath === 'string' && options.reportedPath.length > 0) {
    const direct = options.reportedPath
    const candidates = direct.match(/^[A-Za-z]:[\\/]|^\//) ? [direct] : [join(projectRoot, direct)]
    for (const candidate of candidates) {
      const info = await statQuiet(candidate)
      if (info !== undefined) return { path: candidate, ...info }
    }
  }
  // 2) 约定目录里找最新的一份。
  const since = options.sinceMs ?? 0
  let best
  for (const rel of CRASH_DIRS) {
    const dir = join(projectRoot, rel)
    if (!existsSync(dir)) continue
    let entries
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!/^crash-.*\.txt$/i.test(entry)) continue
      const full = join(dir, entry)
      const info = await statQuiet(full)
      if (info === undefined) continue
      // 只认本次任务开始之后写的报告：目录里通常躺着好几份历史崩溃。
      if (info.mtimeMs < since) continue
      if (best === undefined || info.mtimeMs > best.mtimeMs) {
        best = { path: full, ...info }
      }
    }
  }
  return best
}

/** 读文件元信息，失败返回 undefined。 */
async function statQuiet(file) {
  try {
    const info = await stat(file)
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : undefined
  } catch {
    return undefined
  }
}

/**
 * 把一份 crash-report 提炼成给模型看的摘要。
 *
 * 完整报告动辄几十 KB（含全部 mod 列表与系统信息），直接塞给模型既浪费
 * 上下文也没必要——真正有诊断价值的是头部的 Description、异常类型与消息、
 * 栈顶若干帧，以及 Forge 给出的 Suspected Mods。
 *
 * @param reportPath 报告文件路径。
 * @param options.maxFrames 最多保留几帧调用栈。
 * @returns `{ path, description, exception, frames, suspectedMods, uuid, truncated }`；
 *          读取失败时返回 `{ path, error }`。
 */
export async function summarizeCrashReport(reportPath, options = {}) {
  const maxFrames = options.maxFrames ?? MAX_FRAMES
  let text
  try {
    text = await readFile(reportPath, 'utf8')
  } catch (error) {
    return { path: reportPath, error: `无法读取崩溃报告：${error?.message ?? String(error)}` }
  }

  const lines = text.split(/\r?\n/)
  const description = matchLine(lines, /^Description:\s*(.*)$/i)
  const uuid = matchLine(lines, /^Crash Report UUID:\s*(.*)$/i)

  // 异常：报告中第一条形如 `java.lang.XxxException: message` 的行。
  let exception
  let exceptionIndex = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^[a-z][\w.]*(\.[A-Z]\w+)*(Exception|Error|Throwable)\b/.test(line.trim())) {
      exception = line.trim()
      exceptionIndex = i
      break
    }
  }

  // 栈帧：异常行之后连续的 `	at ...` 行。
  const frames = []
  if (exceptionIndex >= 0) {
    for (let i = exceptionIndex + 1; i < lines.length && frames.length < maxFrames; i += 1) {
      const line = lines[i]
      if (!/^\s+at\s/.test(line)) {
        if (line.trim().length === 0) continue
        break
      }
      frames.push(line.trim())
    }
  }

  // Suspected Mods 段：Forge 在报告末尾给出，是定位责任 mod 的关键线索。
  const suspectedMods = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*Suspected Mods:\s*$/i.test(lines[i])) {
      for (let j = i + 1; j < lines.length && suspectedMods.length < 10; j += 1) {
        const line = lines[j].trim()
        if (line.length === 0) break
        suspectedMods.push(line)
      }
      break
    }
  }

  return {
    path: reportPath,
    description,
    exception,
    frames,
    suspectedMods,
    uuid,
    // 报告里的 mod 列表很长，标记一下让调用方知道这是提炼过的。
    truncated: true,
    totalLines: lines.length,
  }
}

/** 取第一条匹配的捕获组内容。 */
function matchLine(lines, pattern) {
  for (const line of lines) {
    const match = line.match(pattern)
    if (match !== null) return match[1].trim()
  }
  return undefined
}

/**
 * 把崩溃摘要渲染成模型可读的文本块。
 *
 * @param crash {@link summarizeCrashReport} 的产物。
 * @returns 多行文本。
 */
export function renderCrashSummary(crash) {
  const lines = []
  lines.push('检测到 runClient 崩溃，已生成崩溃报告：')
  lines.push(`  报告路径：${crash.path}`)
  if (crash.error !== undefined) {
    lines.push(`  ${crash.error}`)
    return lines.join('\n')
  }
  if (crash.description !== undefined) lines.push(`  描述：${crash.description}`)
  if (crash.exception !== undefined) lines.push(`  异常：${crash.exception}`)
  if (crash.uuid !== undefined) lines.push(`  报告 UUID：${crash.uuid}`)
  if (Array.isArray(crash.suspectedMods) && crash.suspectedMods.length > 0) {
    lines.push(`  可疑 mod：${crash.suspectedMods.join('、')}`)
  }
  if (Array.isArray(crash.frames) && crash.frames.length > 0) {
    lines.push('  栈顶：')
    for (const frame of crash.frames) lines.push(`    ${frame}`)
  }
  lines.push('')
  lines.push('（以上为摘要；需要完整内容时用 read 工具打开上面的路径。）')
  return lines.join('\n')
}
