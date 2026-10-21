// 端到端验证：diff 采集、后台任务注册表、并发策略。
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSnapshot, collectDiff, renderDiffSummary, collectGitDiff } from '../lib/diff.js'
import { RunRegistry, runOnce, tailLines } from '../lib/proc.js'

let failures = 0
function check(label, condition, extra) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`[${mark}] ${label}${extra !== undefined ? ` — ${extra}` : ''}`)
}

// ---- 1. diff：新增 / 修改 / 删除 三种情况都要认出来 ----
const root = await mkdtemp(join(tmpdir(), 'mcrun-'))
const gen = join(root, 'src', 'generated', 'resources')
await mkdir(gen, { recursive: true })
await writeFile(join(gen, 'keep.json'), '{"a":1}\n')
await writeFile(join(gen, 'modify.json'), '{"b":1}\n')
await writeFile(join(gen, 'delete.json'), '{"c":1}\n')
// .cache 必须被排除。
await mkdir(join(gen, '.cache'), { recursive: true })
await writeFile(join(gen, '.cache', 'ignored.json'), '{"x":1}\n')

const snapshot = await createSnapshot(root)
check('快照包含 3 个产物文件（.cache 被排除）', snapshot.files.size === 3, `size=${snapshot.files.size}`)

await writeFile(join(gen, 'added.json'), '{"d":1}\n')
await writeFile(join(gen, 'modify.json'), '{"b":2,"extra":true}\n')
await rm(join(gen, 'delete.json'))

const result = await collectDiff(snapshot, { maxFiles: 40, maxBytes: 1024 * 1024 })
check('识别新增 1 个', result.stats.added === 1, JSON.stringify(result.stats))
check('识别修改 1 个', result.stats.modified === 1)
check('识别删除 1 个', result.stats.removed === 1)
check('总变更数为 3', result.stats.total === 3)

// 内容级正确性：oldText 必须取自**任务启动前**的快照，而不是事后重读磁盘。
// 事后重读会拿到新内容，oldText === newText，diff 卡片就显示不出变化。
const modifyDiff = result.diffs.find((d) => d.path.endsWith('modify.json'))
check('修改项的 oldText 是旧内容', modifyDiff?.oldText?.includes('"b":1'),
  JSON.stringify(modifyDiff?.oldText))
check('修改项的 newText 是新内容', modifyDiff?.newText?.includes('"b":2'),
  JSON.stringify(modifyDiff?.newText))
check('修改项 oldText !== newText（真的显示出变化）',
  modifyDiff?.oldText !== modifyDiff?.newText)
const addedDiff = result.diffs.find((d) => d.path.endsWith('added.json'))
check('新增项的 oldText 为 null', addedDiff?.oldText === null, JSON.stringify(addedDiff?.oldText))
const removedDiff = result.diffs.find((d) => d.path.endsWith('delete.json'))
check('删除项保留旧内容（来自快照）', removedDiff?.oldText?.includes('"c":1'),
  JSON.stringify(removedDiff?.oldText))
check('删除项 newText 为空', removedDiff?.newText === '', JSON.stringify(removedDiff?.newText))

const summary = renderDiffSummary(result, { available: false, changed: [] })
check('摘要含新增文件', summary.includes('added.json'))
check('摘要含修改文件', summary.includes('modify.json'))
check('摘要不含 .cache', !summary.includes('.cache'))

// ---- 2. diff：无变更时必须明确说“没有变更”，而不是空字符串 ----
const snapshot2 = await createSnapshot(root)
const clean = await collectDiff(snapshot2, {})
check('无变更时 total=0', clean.stats.total === 0)
const cleanSummary = renderDiffSummary(clean, { available: false, changed: [] })
check('无变更时有明确文案', cleanSummary.includes('未产生任何产物变更'), cleanSummary)

// ---- 3. diff：目录不存在时不炸 ----
const emptyRoot = await mkdtemp(join(tmpdir(), 'mcrun-empty-'))
const emptySnap = await createSnapshot(emptyRoot)
const emptyDiff = await collectDiff(emptySnap, {})
check('无产物目录时安全返回', emptyDiff.stats.total === 0 && emptySnap.dirs.length === 0)

// ---- 4. git：非仓库时必须安全降级 ----
const gitProbe = await collectGitDiff((argv, cwd) => runOnce(argv, cwd), emptyRoot)
check('非 git 仓库时 available=false', gitProbe.available === false)

// ---- 5. runOnce：能跑命令并拿到退出码 ----
const ok = await runOnce(process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'echo hello'] : ['echo', 'hello'], root)
check('runOnce 成功执行', ok.code === 0 && ok.stdout.includes('hello'), `code=${ok.code} out=${JSON.stringify(ok.stdout)}`)
const bad = await runOnce(process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'exit 3'] : ['sh', '-c', 'exit 3'], root)
check('runOnce 传回非零退出码', bad.code === 3, `code=${bad.code}`)

// ---- 6. 任务注册表：并发策略 ----
const registry = new RunRegistry({ duplicatePolicy: 'reject' })
const sleepCmd = process.platform === 'win32'
  ? ['cmd.exe', '/d', '/s', '/c', 'ping -n 6 127.0.0.1 > nul']
  : ['sleep', '5']

const first = registry.start({ task: ':a:runData', label: 'a', cwd: root, argv: sleepCmd })
check('首个任务启动成功', first.job.status === 'running', first.job.id)

let rejected = false
let conflictMessage = ''
try {
  registry.start({ task: ':a:runData', label: 'a', cwd: root, argv: sleepCmd })
} catch (error) {
  rejected = true
  conflictMessage = error.message
}
check('reject 策略下同名任务被拒', rejected)
check('拒绝信息含已有任务 id', conflictMessage.includes(first.job.id), conflictMessage)
check('拒绝信息给出处置建议', /job_output|job_kill|reuse/.test(conflictMessage))

// 不同任务名可以并存。
const second = registry.start({ task: ':a:runClient', label: 'b', cwd: root, argv: sleepCmd })
check('不同任务名可并存', second.job.status === 'running')

// reuse 策略。
const reuseReg = new RunRegistry({ duplicatePolicy: 'reuse' })
const r1 = reuseReg.start({ task: ':x:runData', label: 'x', cwd: root, argv: sleepCmd })
const r2 = reuseReg.start({ task: ':x:runData', label: 'x', cwd: root, argv: sleepCmd })
check('reuse 策略复用同一任务', r2.reused === true && r2.job.id === r1.job.id)

// allow 策略。
const allowReg = new RunRegistry({ duplicatePolicy: 'allow' })
const a1 = allowReg.start({ task: ':y:runData', label: 'y', cwd: root, argv: sleepCmd })
const a2 = allowReg.start({ task: ':y:runData', label: 'y', cwd: root, argv: sleepCmd })
check('allow 策略允许并存', a2.job.id !== a1.job.id)

// ---- 7. 输出捕获与消费式读取 ----
const echoReg = new RunRegistry({})
const echoJob = echoReg.start({
  task: ':z:runData', label: 'z', cwd: root,
  argv: process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'echo line-one'] : ['echo', 'line-one'],
})
const settled = await echoReg.wait(echoJob.job.id, 15000)
check('任务正常结束', settled.status === 'completed', `${settled.status} ${settled.detail ?? ''}`)
const read1 = echoReg.read(echoJob.job.id)
check('读到输出内容', read1.text.includes('line-one'), JSON.stringify(read1.text))
check('结算后带结果摘要', typeof read1.result === 'string' && read1.result.length > 0)
const read2 = echoReg.read(echoJob.job.id)
check('二次读取不再重复输出', read2.text.length === 0, JSON.stringify(read2.text))
const all = echoReg.readAll(echoJob.job.id)
check('readAll 仍可取回全部输出', all.text.includes('line-one'))

// ---- 8. 失败任务 ----
const failReg = new RunRegistry({})
const failJob = failReg.start({
  task: ':f:runData', label: 'f', cwd: root,
  argv: process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'exit 7'] : ['sh', '-c', 'exit 7'],
})
const failSettled = await failReg.wait(failJob.job.id, 15000)
check('失败任务被标为 failed', failSettled.status === 'failed', failSettled.status)
check('失败信息含退出码', String(failSettled.detail ?? '').includes('7'), String(failSettled.detail))

// ---- 9. spawn 失败（命令不存在）也要正常结算，而不是挂死 ----
const spawnFailReg = new RunRegistry({})
const spawnFail = spawnFailReg.start({
  task: ':s:runData', label: 's', cwd: root,
  argv: ['definitely-not-a-real-binary-xyz', 'run'],
})
const spawnSettled = await spawnFailReg.wait(spawnFail.job.id, 15000)
check('spawn 失败也结算为 failed', spawnSettled.status === 'failed', spawnSettled.status)

// ---- 10. 取消 ----
const killReg = new RunRegistry({})
const killJob = killReg.start({ task: ':k:runClient', label: 'k', cwd: root, argv: sleepCmd })
const killResult = killReg.kill(killJob.job.id, undefined, '测试取消')
check('取消请求被接受', killResult === 'requested')
const killedSettled = await killReg.wait(killJob.job.id, 15000)
check('取消后状态为 killed', killedSettled.status === 'killed', killedSettled.status)
const again = killReg.kill(killJob.job.id, undefined, 'x')
check('重复取消返回 already-finished', again === 'already-finished')

// ---- 11. 结算后处理（runData 的 diff 钩子） ----
const artifactReg = new RunRegistry({})
const artifactJob = artifactReg.start({
  task: ':d:runData', label: 'd', cwd: root,
  argv: process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'echo done'] : ['echo', 'done'],
  onSettle: async () => ({ summary: 'fake-diff' }),
})
await artifactReg.wait(artifactJob.job.id, 15000)
const artifacts = await artifactReg.awaitArtifacts(artifactJob.job.id)
check('结算后处理结果可被取回', artifacts?.summary === 'fake-diff', JSON.stringify(artifacts))

// 后处理抛错不能把成功任务改判为失败。
const throwReg = new RunRegistry({})
const throwJob = throwReg.start({
  task: ':e:runData', label: 'e', cwd: root,
  argv: process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'echo done'] : ['echo', 'done'],
  onSettle: async () => { throw new Error('boom') },
})
const throwSettled = await throwReg.wait(throwJob.job.id, 15000)
check('后处理抛错不影响任务状态', throwSettled.status === 'completed', throwSettled.status)
const throwArtifacts = await throwReg.awaitArtifacts(throwJob.job.id)
check('后处理抛错被记成 error 而不是抛出', typeof throwArtifacts?.error === 'string', JSON.stringify(throwArtifacts))

// ---- 12. 跨会话隔离 ----
const isoReg = new RunRegistry({})
const isoJob = isoReg.start({ task: ':i:runData', label: 'i', cwd: root, argv: sleepCmd, owner: 'session-A' })
check('owner 会话能取到自己的任务', isoReg.get(isoJob.job.id, 'session-A').id === isoJob.job.id)
let foreignBlocked = false
try {
  isoReg.get(isoJob.job.id, 'session-B')
} catch {
  foreignBlocked = true
}
check('其他会话取不到该任务', foreignBlocked)

// ---- 13. 尾部按行截断（日志面板的显示上限） ----
// 面板每秒轮询，不能拿完整缓冲；tailLines 是这道闸门。
const many = Array.from({ length: 900 }, (_, i) => `line-${i}`).join('\n')
const tail = tailLines(many, 500)
const tailTexts = tail.text.split('\n')
check('tailLines 只保留最后 N 行', tailTexts.length === 500, String(tailTexts.length))
check('tailLines 保留的是尾部（末行是最新的）', tailTexts[tailTexts.length - 1] === 'line-899',
  tailTexts[tailTexts.length - 1])
check('tailLines 从最早保留行开始', tailTexts[0] === 'line-400', tailTexts[0])
check('tailLines 报告丢掉的行数', tail.dropped === 400, String(tail.dropped))
// 不足上限时一个字都不该动，dropped 必须是 0（否则面板会误报「有行没显示」）。
const small = tailLines('a\nb\nc', 500)
check('行数不足时不截断', small.text === 'a\nb\nc' && small.dropped === 0, JSON.stringify(small))
// 非正数表示不截断——配置被写成 0 或负数时不能把日志变成空。
check('maxLines<=0 时不截断', tailLines(many, 0).text === many && tailLines(many, -1).dropped === 0)

// readTail 与 readAll 走同一个缓冲，只是前者按行截断且两者都不移动游标。
const tailReg = new RunRegistry({})
const tailJob = tailReg.start({
  task: ':t:runData', label: 't', cwd: root,
  argv: process.platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', 'for /l %i in (1,1,600) do @echo row-%i']
    : ['sh', '-c', 'i=1; while [ $i -le 600 ]; do echo row-$i; i=$((i+1)); done'],
})
await tailReg.wait(tailJob.job.id, 20000)
const tailAll = tailReg.readAll(tailJob.job.id)
const tailView = tailReg.readTail(tailJob.job.id, undefined, 100)
check('readTail 保留 100 行', tailView.text.split('\n').length === 100,
  String(tailView.text.split('\n').length))
check('readTail 丢掉的行数与总量吻合', tailView.dropped === tailAll.text.split('\n').length - 100,
  `${tailView.dropped} vs ${tailAll.text.split('\n').length}`)
check('readTail 末行是最新输出', tailView.text.trimEnd().endsWith('row-600'),
  JSON.stringify(tailView.text.trimEnd().slice(-30)))
check('readTail 不移动游标（readAll 长度不变）',
  tailReg.readAll(tailJob.job.id).text.length === tailAll.text.length)
tailReg.dispose()

// 清理
registry.dispose(); reuseReg.dispose(); allowReg.dispose(); echoReg.dispose()
failReg.dispose(); spawnFailReg.dispose(); killReg.dispose(); artifactReg.dispose()
throwReg.dispose(); isoReg.dispose()

// 被取消的子进程在 Windows 上可能还短暂占着 cwd，rm 会 EBUSY。
// 这是测试清理的时序问题，不是插件行为，重试几次即可。
async function cleanup(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  console.log(`(提示：临时目录未能删除，可忽略：${dir})`)
}
await cleanup(root)
await cleanup(emptyRoot)

console.log('')
console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
