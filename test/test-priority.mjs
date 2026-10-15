// 验证“权威数据优先于启发式”这条设计：
//   - Gradle 自己报的任务（priority 0）压过一切猜测
//   - IDEA 运行配置（1）压过 IDEA 模块列表推导（2/3）
//   - Gradle 说“不存在”的任务，不会被我的猜测复活
//
// 自包含：临时造一个两模块的 MC 风格项目，配一份真的 wrapper，
// 让插件真的去跑 `gradlew tasks`。不依赖任何本机仓库。
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunRegistry, runOnce } from '../lib/proc.js'
import { discoverTargets, findGradleRoot, queryGradleTasks, SOURCE_PRIORITY } from '../lib/discovery.js'
import { copyWrapper, makeChecker } from './helpers/fixtures.mjs'

const { check, finish } = makeChecker()

const root = await mkdtemp(join(tmpdir(), 'priority-'))
await copyWrapper(root)

await writeFile(join(root, 'settings.gradle'), `
rootProject.name = 'PriorityProbe'
include ':mod-a'
include ':mod-b'
`)

// 两个子模块各自声明 run* 任务，并带上 group/description ——
// 描述存在与否正是“这条来自 Gradle”的证据。
const modBuild = (name, tasks) => `
group = 'probe.${name}'
${tasks.map(([task, desc]) => `tasks.register('${task}') {
  group = 'mod development tasks'
  description = '${desc}'
}`).join('\n')}
`
await mkdir(join(root, 'mod-a'), { recursive: true })
await mkdir(join(root, 'mod-b'), { recursive: true })
await writeFile(join(root, 'mod-a', 'build.gradle'),
  modBuild('mod-a', [['runClient', 'Runs the client Minecraft run configuration.'],
    ['runData', 'Runs the data generation.'],
    ['runServer', 'Runs the server.']]))
await writeFile(join(root, 'mod-b', 'build.gradle'),
  modBuild('mod-b', [['runClient', 'Runs the client (b).'],
    ['runData', 'Runs the data generation (b).']]))

// IDEA 项目结构：两个子模块 + 根（根不是 mod 项目，不该产出根级任务）。
await mkdir(join(root, '.idea'), { recursive: true })
await writeFile(join(root, '.idea', 'gradle.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="GradleSettings">
    <option name="linkedExternalProjectsSettings">
      <GradleProjectSettings>
        <option name="externalProjectPath" value="$PROJECT_DIR$" />
        <option name="gradleJvm" value="#JAVA_HOME" />
        <option name="modules">
          <set>
            <option value="$PROJECT_DIR$" />
            <option value="$PROJECT_DIR$/mod-a" />
            <option value="$PROJECT_DIR$/mod-b" />
          </set>
        </option>
      </GradleProjectSettings>
    </option>
  </component>
</project>
`)
// IDEA 运行配置：手写一条并不存在的任务，用来验证 Gradle 能“否决”它。
await mkdir(join(root, '.run'), { recursive: true })
await writeFile(join(root, '.run', 'ClientA.run.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="ClientA" type="GradleRunConfiguration">
    <ExternalSystemSettings>
      <option name="taskNames">
        <list>
          <option value=":mod-a:runClient" />
        </list>
      </option>
    </ExternalSystemSettings>
  </configuration>
</component>
`)
await writeFile(join(root, '.run', 'Ghost.run.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Ghost" type="GradleRunConfiguration">
    <ExternalSystemSettings>
      <option name="taskNames">
        <list>
          <option value=":mod-a:runNonsense" />
        </list>
      </option>
    </ExternalSystemSettings>
  </configuration>
</component>
`)

console.log('gradleRoot =', findGradleRoot(root))
console.log('')

try {
  // ---- 1. 优先级表本身要单调 ----
  check('gradle 优先级最高', SOURCE_PRIORITY.gradle < SOURCE_PRIORITY.ideaRun)
  check('ideaRun 高于 idea', SOURCE_PRIORITY.ideaRun < SOURCE_PRIORITY.idea)
  check('idea 高于 settings', SOURCE_PRIORITY.idea < SOURCE_PRIORITY.settings)
  check('settings 高于 fallback', SOURCE_PRIORITY.settings < SOURCE_PRIORITY.fallback)

  // ---- 2. 静态发现（不查 Gradle）----
  const staticResult = await discoverTargets(root)
  check('静态发现能拿到目标', staticResult.targets.length > 0, String(staticResult.targets.length))
  check('静态发现的项目结构来自 IDEA', staticResult.structureSource === 'idea', staticResult.structureSource)
  check('静态发现没查过 Gradle', staticResult.gradleQuery.queried === false)
  check('静态发现里没有 gradle 来源', !staticResult.targets.some((t) => t.source === 'gradle'))
  check('静态发现读到了 IDEA 运行配置', (staticResult.sources.ideaRun ?? 0) > 0,
    JSON.stringify(staticResult.sources))
  // 根项目不是 mod 项目，不该产出 :runClient 这种根级假任务。
  check('静态发现没有根级假任务', !staticResult.targets.some((t) => /^:run/.test(t.task)),
    staticResult.targets.map((t) => t.task).join(', '))
  check('静态发现保留了猜测出来的幽灵任务',
    staticResult.targets.some((t) => t.task === ':mod-a:runNonsense'))

  // ---- 3. 权威发现：真的跑一次 gradlew tasks ----
  console.log('')
  console.log('正在向 Gradle 查询任务列表…')
  const t0 = Date.now()
  const queryResult = await discoverTargets(root, {
    queryTasks: true,
    spawn: (argv, cwd, timeoutMs) => runOnce(argv, cwd, timeoutMs),
    taskQueryTimeoutMs: 300000,
  })
  console.log(`查询耗时 ${Date.now() - t0}ms`)
  console.log('')

  check('Gradle 查询成功', queryResult.gradleQuery.ok === true, JSON.stringify(queryResult.gradleQuery))
  check('Gradle 查询覆盖了多个项目', (queryResult.gradleQuery.projects ?? 0) > 1,
    String(queryResult.gradleQuery.projects))
  check('Gradle 贡献了 run* 任务', (queryResult.sources.gradle ?? 0) > 0,
    JSON.stringify(queryResult.sources))
  check('gradle 来源的目标优先级为 0',
    queryResult.targets.filter((t) => t.source === 'gradle').every((t) => t.priority === 0))

  // 权威来源应当压过静态来源：mod-a 的 runClient 现在应标记为 gradle。
  const coreClient = queryResult.targets.find((t) => t.task === ':mod-a:runClient')
  check('mod-a:runClient 来自 Gradle（权威）', coreClient?.source === 'gradle',
    `${coreClient?.source} / prio=${coreClient?.priority}`)
  check('  且带着 Gradle 给的任务描述',
    typeof coreClient?.description === 'string' && coreClient.description.length > 0, coreClient?.description)
  check('  且带着 Gradle 给的分组',
    typeof coreClient?.group === 'string' && coreClient.group.length > 0, coreClient?.group)

  // 任务名不应重复（去重按优先级保留唯一一条）。
  const names = queryResult.targets.map((t) => t.task)
  check('任务名无重复', new Set(names).size === names.length,
    `${names.length} 条 / ${new Set(names).size} 唯一`)

  // 排序：gradle 来源的 client 任务应排在 settings 来源的前面。
  const clientOrder = queryResult.targets.filter((t) => t.kind === 'client')
  const firstStaticIdx = clientOrder.findIndex((t) => t.source !== 'gradle')
  const lastGradleIdx = clientOrder.map((t) => t.source === 'gradle').lastIndexOf(true)
  check('gradle 来源排在静态来源之前', lastGradleIdx < firstStaticIdx || firstStaticIdx === -1,
    `lastGradle=${lastGradleIdx} firstStatic=${firstStaticIdx}`)

  // ---- 4. 权威来源必须能“否决”猜测 ----
  // IDEA 运行配置里写了一条并不存在的任务，Gradle 查询应让它消失。
  check('Gradle 否决了猜出来的幽灵任务',
    !queryResult.targets.some((t) => t.task === ':mod-a:runNonsense'),
    queryResult.targets.map((t) => t.task).join(', '))

  const queried = await queryGradleTasks(root, ':mod-a', {
    spawn: (argv, cwd, timeoutMs) => runOnce(argv, cwd, timeoutMs),
    timeoutMs: 300000,
  })
  check('单项目查询成功', queried.ok === true, queried.error ?? '')
  const realNames = new Set(queried.tasks.map((t) => t.name))
  check('查询结果含 runClient', realNames.has('runClient'))
  check('查询结果含 runData', realNames.has('runData'))
  check('查询结果含 runServer', realNames.has('runServer'))
  check('查询结果不含不存在的任务', !realNames.has('runNonsense'))

  // ---- 5. 查询失败时要安全降级，而不是让整次发现失败 ----
  const badQuery = await discoverTargets(root, {
    queryTasks: true,
    spawn: async () => ({ stdout: '', stderr: 'boom', code: 1 }),
    taskQueryTimeoutMs: 5000,
  })
  check('Gradle 查询失败时 ok=false', badQuery.gradleQuery.ok === false, JSON.stringify(badQuery.gradleQuery))
  check('Gradle 查询失败时仍返回静态目标', badQuery.targets.length > 0, String(badQuery.targets.length))
  check('  且没有 gradle 来源的目标', !badQuery.targets.some((t) => t.source === 'gradle'))
} finally {
  const registry = new RunRegistry({ duplicatePolicy: 'allow' })
  registry.dispose()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { await rm(root, { recursive: true, force: true }); break }
    catch { await new Promise((r) => setTimeout(r, 500)) }
  }
}

process.exit(finish('PRIORITY TESTS'))
