// 验证两个新需求：
//   1. runData 反馈更详细（真实行级 +N/-M、按类目分组、给出实际改动内容）
//   2. runClient 崩溃时自动识别 crash-report 并把路径+摘要交给模型
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSnapshot, collectDiff, renderDiffSummary, categorizePath, lineDelta } from '../lib/diff.js'
import { detectCrash, locateCrashReport, summarizeCrashReport, renderCrashSummary } from '../lib/crash.js'

let failures = 0
function check(label, condition, extra) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${extra !== undefined ? ` — ${extra}` : ''}`)
  if (!condition) failures += 1
}

// ============ 一、runData 详细反馈 ============
console.log('--- runData 详细反馈 ---')

// 行级差异：必须是真实的 +N/-M，而不是笼统的行数变化
check('lineDelta 全新增', JSON.stringify(lineDelta([], ['a', 'b'])) === '{"added":2,"removed":0}',
  JSON.stringify(lineDelta([], ['a', 'b'])))
check('lineDelta 全删除', JSON.stringify(lineDelta(['a', 'b'], [])) === '{"added":0,"removed":2}',
  JSON.stringify(lineDelta(['a', 'b'], [])))
check('lineDelta 改一行算 1 增 1 删',
  JSON.stringify(lineDelta(['a', 'b', 'c'], ['a', 'X', 'c'])) === '{"added":1,"removed":1}',
  JSON.stringify(lineDelta(['a', 'b', 'c'], ['a', 'X', 'c'])))
check('lineDelta 重复行正确配对（不把同一行算两次新增）',
  JSON.stringify(lineDelta(['x', 'x'], ['x'])) === '{"added":0,"removed":1}',
  JSON.stringify(lineDelta(['x', 'x'], ['x'])))

// 类目分组
check('类目：lang', categorizePath('modules/A/src/generated/resources/assets/a/lang/en_us.json') === 'lang 语言文件')
check('类目：recipes', categorizePath('src/generated/resources/data/a/recipes/x.json') === 'recipes 配方')
check('类目：tags', categorizePath('src/generated/resources/data/a/tags/items/y.json') === 'tags 标签')
check('类目：models', categorizePath('src/generated/resources/assets/a/models/block/z.json') === 'models/blockstates 模型')
check('类目：其他 json', categorizePath('src/generated/resources/data/a/foo.json') === '其他 json')

// 端到端：造一次真实的 runData 产物变化并检查反馈内容
const root = await mkdtemp(join(tmpdir(), 'detail-'))
const gen = join(root, 'src', 'generated', 'resources')
await mkdir(join(gen, 'assets', 'demo', 'lang'), { recursive: true })
await mkdir(join(gen, 'data', 'demo', 'recipes'), { recursive: true })
await writeFile(join(gen, 'assets', 'demo', 'lang', 'en_us.json'), '{\n  "a": "one",\n  "b": "two"\n}\n')
await writeFile(join(gen, 'data', 'demo', 'recipes', 'old.json'), '{"type":"x"}\n')

const snapshot = await createSnapshot([root], root, { maxTextBytes: 512 * 1024, textBudgetBytes: 8 * 1024 * 1024 })
// 模拟一次 runData：改 lang（真实行变化）、新增配方、删除配方
await writeFile(join(gen, 'assets', 'demo', 'lang', 'en_us.json'), '{\n  "a": "ONE",\n  "b": "two",\n  "c": "three"\n}\n')
await writeFile(join(gen, 'data', 'demo', 'recipes', 'new.json'), '{"type":"y"}\n')
await rm(join(gen, 'data', 'demo', 'recipes', 'old.json'))

const result = await collectDiff(snapshot, { maxFiles: 40, maxBytes: 512 * 1024 })
const summary = renderDiffSummary(result, { available: false, changed: [] }, { maxHunkLines: 40 })

check('摘要含总量行', summary.includes('新增 1 · 修改 1 · 删除 1'), summary.split('\n')[1] ?? '')
check('摘要含按类目分布段', summary.includes('按类目分布：'))
check('类目段列出 lang', /lang 语言文件：1 个/.test(summary), summary.match(/lang[^\n]*/)?.[0] ?? '')
check('类目段列出 recipes', /recipes 配方：2 个/.test(summary), summary.match(/recipes[^\n]*/)?.[0] ?? '')
check('修改项给出真实 +N/-M（而非“2 → 3 行”）', /en_us\.json（\+\d+ 行 \/ -\d+ 行）/.test(summary),
  summary.match(/en_us\.json[^\n]*/)?.[0] ?? '')
check('摘要含实际改动内容（- 行）', /^\s+-.*"a": "one"/m.test(summary), '')
check('摘要含实际改动内容（+ 行）', /^\s+\+.*"a": "ONE"/m.test(summary), '')
check('摘要含新增的那行', /^\s+\+.*"c": "three"/m.test(summary))
check('新增文件标为 A', /^\s+A .*new\.json/m.test(summary))
check('删除文件标为 D', /^\s+D .*old\.json/m.test(summary))

// 笼统的旧格式必须消失
check('不再出现旧格式「N → M 行，+0」', !/\d+ → \d+ 行/.test(summary), '')
check('不再出现旧格式「+0」占位', !/，\+0）/.test(summary))

// ============ 二、runClient 崩溃识别 ============
console.log('')
console.log('--- runClient 崩溃识别 ---')

// 2a. 输出里出现报告标题
const byTitle = detectCrash('blah\n---- Minecraft Crash Report ----\n// Hi\nmore')
check('识别 ---- Minecraft Crash Report ----', byTitle.crashed === true)

// 2b. 输出里给出路径
const byPath = detectCrash('[Render thread/ERROR]: This crash report has been saved to: C:\\proj\\run\\crash-reports\\crash-2026-10-01_23.35.27-client.txt')
check('识别「crash report saved to」', byPath.crashed === true)
check('  并抽出路径', byPath.reportedPath?.endsWith('crash-2026-10-01_23.35.27-client.txt') === true,
  byPath.reportedPath)

// 2c. ReportedException
check('识别 ReportedException', detectCrash('net.minecraft.crash.ReportedException: Ticking screen').crashed === true)

// 2d. 正常输出不能误判
check('正常输出不误判为崩溃',
  detectCrash('BUILD SUCCESSFUL in 12s\nStopping!\nSaving chunks').crashed === false)
check('空输出不误判', detectCrash('').crashed === false)

// 2e. 磁盘定位：只认本次任务之后写的报告
const proj = join(root, 'client-proj')
const crashDir = join(proj, 'run', 'crash-reports')
await mkdir(crashDir, { recursive: true })
const oldReport = join(crashDir, 'crash-2020-01-01_00.00.00-client.txt')
await writeFile(oldReport, '---- Minecraft Crash Report ----\n// old\n')
// 把旧报告的 mtime 推回过去
const past = new Date(Date.now() - 86400_000)
await (await import('node:fs/promises')).utimes(oldReport, past, past)

check('旧报告（早于任务开始）不被选中',
  (await locateCrashReport(proj, { sinceMs: Date.now() - 60_000 })) === undefined)

const newReport = join(crashDir, 'crash-2026-10-01_23.35.27-client.txt')
await writeFile(newReport, [
  '---- Minecraft Crash Report ----',
  '// Hi. I\'m Minecraft, and I\'m a crashaholic',
  '',
  'Time: 2026-10-01 23:35:27',
  'Description: mouseClicked event handler',
  '',
  'java.lang.NullPointerException: Cannot invoke "X.getY()" because "z" is null',
  '\tat com.example.mod.Widget.mouseClicked(Widget.java:274) ~[mod.jar:?]',
  '\tat net.minecraft.client.MouseHandler.onPress(MouseHandler.java:94) ~[forge.jar:?]',
  '\tat net.minecraft.client.Minecraft.run(Minecraft.java:733) ~[forge.jar:?]',
  '',
  'Suspected Mods:',
  '\tBetterGregTechPonder (bettergregtechponder)',
  '',
  'Crash Report UUID: bcad1264-85e1-4d38-a3bc-edfe131d1b9d',
].join('\n'))

const located = await locateCrashReport(proj, { sinceMs: Date.now() - 60_000 })
check('定位到本次新写的报告', located?.path === newReport, located?.path)

// 2f. 摘要提炼
const crash = await summarizeCrashReport(newReport)
check('摘要含 Description', crash.description === 'mouseClicked event handler', crash.description)
check('摘要含异常类型与消息',
  crash.exception?.startsWith('java.lang.NullPointerException') === true, crash.exception)
check('摘要含栈顶帧', crash.frames.length === 3, String(crash.frames.length))
check('  首帧是业务代码', crash.frames[0]?.includes('Widget.mouseClicked') === true, crash.frames[0])
check('摘要含 Suspected Mods', crash.suspectedMods[0]?.includes('BetterGregTechPonder') === true,
  JSON.stringify(crash.suspectedMods))
check('摘要含报告 UUID', crash.uuid === 'bcad1264-85e1-4d38-a3bc-edfe131d1b9d', crash.uuid)

// 2g. 渲染给模型的文本必须带路径
const rendered = renderCrashSummary(crash)
check('渲染文本含报告路径', rendered.includes(newReport), '')
check('渲染文本提示可用 read 打开', rendered.includes('read 工具'))
check('渲染文本含描述与异常', rendered.includes('mouseClicked') && rendered.includes('NullPointerException'))

// 2h. 输出给了路径时优先采信该路径
const pointed = await locateCrashReport(proj, { reportedPath: newReport })
check('输出给出的绝对路径被优先采信', pointed?.path === newReport, pointed?.path)

// 2i. 路径不存在时安全回退到目录扫描
const fallback = await locateCrashReport(proj, {
  reportedPath: join(crashDir, 'does-not-exist.txt'),
  sinceMs: Date.now() - 60_000,
})
check('给出的路径不存在时回退到目录扫描', fallback?.path === newReport, fallback?.path)

// 2j. 读不到文件时给出 error 而不是崩
const broken = await summarizeCrashReport(join(crashDir, 'nope.txt'))
check('报告不可读时返回 error', typeof broken.error === 'string', broken.error)

await rm(root, { recursive: true, force: true }).catch(() => {})

console.log('')
console.log(failures === 0 ? 'ALL FEATURE TESTS PASSED' : `${failures} FEATURE TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
