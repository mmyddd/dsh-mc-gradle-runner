// 验证「工具用法说明注入系统提示词」这一层。
//
// 用户要求两条触发条件同时成立才注入：
//   1. 配置里启用了工具；
//   2. 当前工作区确实是可运行的 MC 项目。
//
// 而第 2 条**必须**和按钮显隐是同一套判据（用户明确要求「同一套要求」）。
// 因此这里刻意不测「某个自定义判据」，而是测「注入走的是 assessRoot / resolveRoot」——
// 一旦有人另写一份判据（比如自己 existsSync('gradlew')），这些断言就会红。
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildGuidance, guidanceFor, GUIDANCE_SECTION_NAME } from '../lib/guidance.js'
import { createGuidanceProvider, installGuidance } from '../lib/prompt.js'

let failures = 0
function check(label, condition, extra) {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${extra !== undefined ? ` — ${extra}` : ''}`)
  if (!condition) failures += 1
}

const here = process.cwd()
const plugin = await import(pathToFileURL(join(here, 'lib', 'index.js')).href)
const ALL = ['mc_run_task', 'mc_run_output', 'mc_run_list', 'mc_run_kill', 'mc_send_command']

// ---- 1. 文案层 ----

check('guidance 有分节名', typeof GUIDANCE_SECTION_NAME === 'string' && GUIDANCE_SECTION_NAME.length > 0)

{
  const text = buildGuidance({ root: 'C:/proj', tools: ALL })
  check('可用时生成正文', text.length > 0)
  check('  正文带标题与根目录', text.includes('## Minecraft Gradle 运行') && text.includes('C:/proj'))
  for (const name of ALL) check(`  提到 ${name}`, text.includes(name))
  check('  说明发送是单向的', text.includes('[mc-console]') || text.includes('回执'))
  check('  说明 runData 收不到命令', text.includes('runData'))
}

{
  // 只放开其中几个工具时，不能提到没注册的入口——否则模型会去调不存在的工具。
  const text = buildGuidance({ root: 'C:/proj', tools: ['mc_run_task'] })
  check('只提已启用的工具', text.includes('mc_run_task') && !text.includes('mc_send_command'))
}

{
  const text = buildGuidance({ root: 'C:/proj', tools: [] })
  check('没有可用工具时正文为空', text === '', JSON.stringify(text))
}

{
  // 判据单一入口：不可用就必须是空串，哪怕文案层本身能拼出内容。
  check('assessed.available=false → 空串', guidanceFor({ available: false, root: 'C:/proj' }, ALL) === '')
  check('assessed 缺失 → 空串', guidanceFor(undefined, ALL) === '')
  const ok = guidanceFor({ available: true, root: 'C:/proj' }, ALL)
  check('assessed.available=true → 有正文', ok.length > 0 && ok.includes('C:/proj'))
}

// ---- 2. provider：判据与按钮同一套 ----

{
  // 造一个真正能被 assessRoot 判为可用的最小 MC 项目（与按钮用的是同一判据）。
  const root = await mkdtemp(join(tmpdir(), 'mc-guidance-'))
  try {
    await writeFile(join(root, 'settings.gradle'), "rootProject.name = 'g'\n")
    await writeFile(
      join(root, 'build.gradle'),
      "plugins { id 'java' }\n"
      + "tasks.register('runClient', JavaExec) { mainClass = 'x' }\n",
    )
    let resolveCalls = 0
    let assessCalls = 0
    const provider = createGuidanceProvider({
      config: { gradleRoot: root },
      resolveRoot: (config, cwd) => {
        resolveCalls += 1
        return config.gradleRoot ?? cwd
      },
      assessRoot: async (target) => {
        assessCalls += 1
        // 真实现由 discovery.assessRoot 提供；这里只关心「注入确实问了它」。
        return { available: true, root: target }
      },
      tools: ALL,
      ttlMs: 60_000,
    })
    const first = await provider.textFor(root)
    check('可用工作区 → 注入正文', first.length > 0 && first.includes(root), first.split('\n')[0])
    check('  注入走 resolveRoot', resolveCalls === 1, String(resolveCalls))
    check('  注入走 assessRoot（与按钮同一判据）', assessCalls === 1, String(assessCalls))
    const second = await provider.textFor(root)
    check('  TTL 内复用缓存', assessCalls === 1, String(assessCalls))
    provider.clear()
    await provider.textFor(root)
    check('  clear() 后重新裁决', assessCalls === 2, String(assessCalls))
    // 不该因为缓存返回同一个字符串实例以外的东西——内容必须等价。
    check('  缓存命中内容一致', second === first)
    void assessCalls
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

{
  // 不可用工作区：assessRoot 说不行就一个字都不注入。
  const provider = createGuidanceProvider({
    config: {},
    resolveRoot: (_config, cwd) => cwd ?? here,
    assessRoot: async (target) => ({ available: false, root: target, unavailableReason: '没有 run* 任务' }),
    tools: ALL,
  })
  check('不可用工作区 → 不注入', (await provider.textFor(here)) === '')
}

{
  // assessRoot 抛错时不能把整个提示词拼装炸掉。
  const provider = createGuidanceProvider({
    config: {},
    resolveRoot: () => { throw new Error('boom') },
    assessRoot: async () => ({ available: true, root: 'x' }),
    tools: ALL,
  })
  check('判据抛错 → 安静地不注入', (await provider.textFor(here)) === '')
}

// ---- 3. 真拿 discovery.assessRoot 判一遍（回归：真实判据也可用） ----

{
  const { assessRoot } = await import(pathToFileURL(join(here, 'lib', 'discovery.js')).href)
  const root = await mkdtemp(join(tmpdir(), 'mc-guidance2-'))
  try {
    await writeFile(join(root, 'settings.gradle'), "rootProject.name = 'g2'\n")
    await writeFile(
      join(root, 'build.gradle'),
      "plugins { id 'java' }\n"
      + "tasks.register('runClient', JavaExec) { mainClass = 'x' }\n",
    )
    const provider = createGuidanceProvider({
      config: { gradleRoot: root },
      resolveRoot: (config) => config.gradleRoot,
      assessRoot,
      tools: ALL,
    })
    const text = await provider.textFor(root)
    check('真 discovery.assessRoot 也判为可用', text.length > 0, text.split('\n')[0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ---- 4. waterfall 挂载 ----

{
  // 有 ctx.on 时挂上监听；分节只补一次，且不吞掉已有分节。
  const listeners = new Map()
  const ctx = { on: (event, handler) => { listeners.set(event, handler) } }
  const provider = createGuidanceProvider({
    config: {},
    resolveRoot: () => 'C:/proj',
    assessRoot: async (target) => ({ available: true, root: target }),
    tools: ALL,
  })
  check('installGuidance 成功挂载', installGuidance(ctx, provider) === true)
  check('  监听的是 system-prompt/assemble', listeners.has('system-prompt/assemble'))
  const handler = listeners.get('system-prompt/assemble')
  const inherited = { sections: [{ name: 'persona', text: 'P' }], contexts: [], tools: [], variables: {} }
  const next = async () => inherited
  const merged = await handler(inherited, { agent: { session: { header: { cwd: 'C:/proj' } } } }, next)
  check('  补上了 MC 分节', merged.sections.some((one) => one.name === GUIDANCE_SECTION_NAME))
  check('  原有分节保留', merged.sections.some((one) => one.name === 'persona'))
  check('  不动 contexts/tools', merged.contexts === inherited.contexts && merged.tools === inherited.tools)

  // 同一份 assembly 走两遍不该出现两段一样的说明。
  const twice = await handler(merged, { agent: { session: { header: { cwd: 'C:/proj' } } } }, async () => merged)
  check('  重复跑不会加第二段',
    twice.sections.filter((one) => one.name === GUIDANCE_SECTION_NAME).length === 1,
    String(twice.sections.length))
}

{
  // 不可用时什么都不加，且必须把别的分节原样交回去。
  const listeners = new Map()
  const ctx = { on: (event, handler) => { listeners.set(event, handler) } }
  const provider = createGuidanceProvider({
    config: {},
    resolveRoot: () => 'C:/proj',
    assessRoot: async () => ({ available: false, root: 'C:/proj' }),
    tools: ALL,
  })
  installGuidance(ctx, provider)
  const inherited = { sections: [{ name: 'persona', text: 'P' }], contexts: [], tools: [], variables: {} }
  const merged = await listeners.get('system-prompt/assemble')(
    inherited, { agent: { session: { header: { cwd: 'C:/proj' } } } }, async () => inherited)
  check('不可用时不补分节', merged.sections.length === 1 && merged.sections[0].name === 'persona',
    JSON.stringify(merged.sections.map((s) => s.name)))
}

{
  // 宿主没有 ctx.on（精简测试桩）时不能抛错，只返回 false。
  check('没有 ctx.on 时返回 false 而不抛', installGuidance({}, createGuidanceProvider({
    config: {}, resolveRoot: () => 'x', assessRoot: async () => ({ available: true }), tools: ALL,
  })) === false)
}

// ---- 5. 源码级契约：apply 只在这两个条件都成立时注入 ----

{
  const source = await import('node:fs/promises').then((fs) => fs.readFile(join(here, 'lib', 'index.js'), 'utf8'))
  check('apply 里按 exposedTools 判条件', source.includes('if (exposedTools.length > 0) {'))
  check('  注入用 createGuidanceProvider', source.includes('createGuidanceProvider({'))
  check('  注入走 assessRoot（与按钮同一判据）', /createGuidanceProvider\(\{[\s\S]{0,200}assessRoot,/.test(source))
  check('  注入走 resolveRoot（与按钮同一根解析）', /createGuidanceProvider\(\{[\s\S]{0,200}resolveRoot,/.test(source))
  check('  用 installGuidance 挂到 waterfall', source.includes('installGuidance(ctx, provider)'))
  // 按钮那条路必须也走 assessRoot，否则两边判据会漂移。
  check('按钮 targets 分支也走 assessRoot', source.includes('const assessed = await assessRoot(root)'))
}

console.log(failures === 0 ? '\ntest-guidance: 全部通过' : `\ntest-guidance: ${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)
