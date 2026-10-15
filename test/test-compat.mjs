// 跨项目兼容性验证：插件不能只对 CTNH-Modules 生效。
// 用合成的几套典型 MC Gradle 布局验证发现逻辑。
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findGradleRoot, discoverTargets, gradleInvocation, resolveTarget, pickDefaultTarget, readIdeaGradleConfig } from '../lib/discovery.js'

let failures = 0
function check(label, condition, extra) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`[${mark}] ${label}${extra !== undefined ? ` — ${extra}` : ''}`)
}

const base = await mkdtemp(join(tmpdir(), 'mcrun-compat-'))

/** 造一个最小可用的 Gradle 项目。 */
async function makeProject(name, { settings, buildAt = ['build.gradle'], wrapper = true, runXml = {} }) {
  const root = join(base, name)
  await mkdir(root, { recursive: true })
  if (settings !== undefined) await writeFile(join(root, 'settings.gradle'), settings)
  for (const rel of buildAt) {
    const file = join(root, rel)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '// build\n')
  }
  if (wrapper) {
    await writeFile(join(root, 'gradlew'), '#!/bin/sh\n')
    await writeFile(join(root, 'gradlew.bat'), '@echo off\n')
  }
  if (Object.keys(runXml).length > 0) {
    await mkdir(join(root, '.run'), { recursive: true })
    for (const [file, task] of Object.entries(runXml)) {
      await writeFile(join(root, '.run', file),
        `<component name="ProjectRunConfigurationManager">\n`
        + `  <configuration default="false" name="${file.replace('.run.xml', '')}" type="GradleRunConfiguration">\n`
        + `    <option name="taskNames"><list><option value="${task}" /></list></option>\n`
        + `  </configuration>\n</component>\n`)
    }
  }
  return root
}

// ---- 场景 1：单模块 Forge 项目（settings 无 include，build 里声明 runs）----
{
  const root = await makeProject('single-forge', {
    settings: "rootProject.name = 'SingleForge'\n",
    buildAt: ['build.gradle'],
    runXml: { 'runClient.run.xml': ':runClient', 'runData.run.xml': ':runData' },
  })
  // 单模块项目的 build.gradle 里会有 runs 块。
  await writeFile(join(root, 'build.gradle'), 'runs {\n  client {}\n  data {}\n  server {}\n}\n')
  const found = findGradleRoot(join(root, 'src', 'main', 'java'))
  check('单模块：根定位正确', found === root, found)
  const { targets } = await discoverTargets(root)
  check('单模块：找到 3 个标准任务', targets.length === 3, targets.map((t) => t.task).join(','))
  check('单模块：默认是 runClient', pickDefaultTarget(targets)?.task === ':runClient', pickDefaultTarget(targets)?.task)
  const inv = gradleInvocation(root)
  check('单模块：wrapper 可用', inv.wrapperMissing === false)
}

// ---- 场景 1a：单模块项目的 IDEA 配置必须被采信 ----
//
// 单模块项目的 `.idea/gradle.xml` 里**只有** `<option value="$PROJECT_DIR$" />`。
// 早先解析时把这个空前缀条目跳过了，导致 projectPaths 为空、IDEA 来源完全失效，
// 菜单里显示成“settings.gradle 解析”。GTPonder 与 GregTech-Construct 正是这种形态。
{
  const root = await makeProject('single-idea', {
    settings: "rootProject.name = 'SingleIdea'\n",
    buildAt: ['build.gradle'],
  })
  await writeFile(join(root, 'build.gradle'), 'runs {\n  client {}\n  data {}\n  server {}\n}\n')
  await mkdir(join(root, '.idea'), { recursive: true })
  await writeFile(join(root, '.idea', 'gradle.xml'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<project version="4">',
    '  <component name="GradleSettings">',
    '    <option name="linkedExternalProjectsSettings">',
    '      <GradleProjectSettings>',
    '        <option name="externalProjectPath" value="$PROJECT_DIR$" />',
    '        <option name="gradleJvm" value="#JAVA_HOME" />',
    '        <option name="modules">',
    '          <set>',
    '            <option value="$PROJECT_DIR$" />',
    '          </set>',
    '        </option>',
    '      </GradleProjectSettings>',
    '    </option>',
    '  </component>',
    '</project>',
  ].join('\n'))

  const idea = await readIdeaGradleConfig(root)
  check('单模块 IDEA：读到根项目路径', idea.projectPaths.length === 1 && idea.projectPaths[0] === ':',
    JSON.stringify(idea.projectPaths))
  check('单模块 IDEA：gradleJvm 被读出', idea.gradleJvm === '#JAVA_HOME', idea.gradleJvm)

  const { targets, structureSource, sources } = await discoverTargets(root)
  check('单模块 IDEA：结构来源标为 idea', structureSource === 'idea', structureSource)
  check('单模块 IDEA：目标来源标为 idea（不是 settings）', sources.idea === 3, JSON.stringify(sources))
  check('单模块 IDEA：仍给出 3 个目标', targets.length === 3, targets.map((t) => t.task).join(','))
}

// ---- 场景 1b：多模块 monorepo 的聚合根不能被当成 mod 项目 ----
{
  const root = await makeProject('aggregator-root', {
    settings: "rootProject.name = 'Agg'\ninclude 'core'\n",
    buildAt: ['build.gradle', 'core/build.gradle'],
  })
  // 聚合器：插件 apply(false)，运行配置下发给子项目 —— 与 CTNH-Modules 的根同构。
  await writeFile(join(root, 'build.gradle'),
    "plugins {\n  id 'net.neoforged.moddev' version '2.0.0' apply(false)\n}\nsubprojects { }\n")
  // 子项目才是真正 apply mod 插件的地方。
  await writeFile(join(root, 'core', 'build.gradle'),
    "plugins { id 'net.neoforged.moddev' }\nruns { client {} data {} server {} }\n")
  const { targets } = await discoverTargets(root)
  const tasks = targets.map((t) => t.task)
  check('聚合根：不产出根级假任务', !tasks.includes(':runClient'), tasks.join(','))
  check('聚合根：仍然产出子项目任务', tasks.includes(':core:runClient'), tasks.join(','))
}

// ---- 场景 2：多模块 NeoForge（settings 有 include，子项目无 settings）----
{
  const root = await makeProject('multi-neoforge', {
    settings: "rootProject.name = 'Multi'\ninclude 'core'\ninclude 'addons:extra'\n",
    buildAt: ['build.gradle', 'core/build.gradle', 'addons/extra/build.gradle'],
    runXml: { 'runCore.run.xml': ':core:runClient' },
  })
  // 运行配置写在根目录的 gradle 脚本里、由根 apply 给子项目 —— CTNH 的真实形态。
  // 这验证了 buildDeclaresRuns 必须扫 gradle/scripts，只看子项目会误杀。
  await mkdir(join(root, 'gradle', 'scripts'), { recursive: true })
  await writeFile(join(root, 'gradle', 'scripts', 'moddevgradle.gradle'), 'runs {\n  client {}\n  data {}\n  server {}\n}\n')
  const found = findGradleRoot(join(root, 'addons', 'extra'))
  check('多模块：根定位正确', found === root, found)
  const { targets, projects } = await discoverTargets(root)
  check('多模块：解析出 2 个子项目', projects.length === 2, projects.join(','))
  const tasks = targets.map((t) => t.task)
  check('多模块：含嵌套子项目任务', tasks.includes(':addons:extra:runClient'), tasks.join(','))
  check('多模块：含根级 core 任务', tasks.includes(':core:runClient'))
  check('多模块：无重复任务', new Set(tasks).size === tasks.length)
  check('多模块：默认取 IDEA 指定的 core', pickDefaultTarget(targets)?.task === ':core:runClient', pickDefaultTarget(targets)?.task)
}

// ---- 场景 3：Fabric Loom（任务名 runClient，无 .run 目录）----
{
  const root = await makeProject('fabric-loom', {
    settings: "rootProject.name = 'FabricMod'\n",
  })
  // Loom 的 runClient/runServer 由 loom 插件注册，build.gradle 里通常能看到 runs 或 runClient。
  await writeFile(join(root, 'build.gradle'), 'loom {\n  runs {\n    client {}\n    server {}\n  }\n}\n')
  const { targets } = await discoverTargets(root)
  check('Fabric：仍能给出标准任务', targets.map((t) => t.task).sort().join(',') === ':runClient,:runData,:runServer',
    targets.map((t) => t.task).join(','))
  check('Fabric：client/data/server 分类正确',
    resolveTarget(targets, 'client')?.task === ':runClient'
    && resolveTarget(targets, 'data')?.task === ':runData'
    && resolveTarget(targets, 'server')?.task === ':runServer')
}

// ---- 场景 4：子项目自带 settings.gradle（CTNH 那种反模式）----
{
  const root = await makeProject('nested-settings', {
    settings: "rootProject.name = 'Outer'\ninclude 'inner'\n",
    buildAt: ['build.gradle', 'inner/build.gradle'],
  })
  // 子项目里的 settings 只有 pluginManagement，没有 include。
  await writeFile(join(root, 'inner', 'settings.gradle'), 'pluginManagement { repositories { gradlePluginPortal() } }\n')
  // 真 MC 项目：根声明 runs，否则新的证据闸门会正确地判它不可用。
  await writeFile(join(root, 'build.gradle'), 'runs {\n  client {}\n  data {}\n  server {}\n}\n')
  const found = findGradleRoot(join(root, 'inner', 'src'))
  check('嵌套 settings：不会被内层 settings 骗到', found === root, found)
  const { targets } = await discoverTargets(root)
  check('嵌套 settings：任务名带正确前缀', targets.some((t) => t.task === ':inner:runClient'),
    targets.map((t) => t.task).join(','))
}

// ---- 场景 5：只有 build.gradle，没有 settings 也没有 wrapper ----
{
  const root = await makeProject('bare', { settings: undefined, wrapper: false })
  await writeFile(join(root, 'build.gradle'), 'runs { client {} }\n')
  const found = findGradleRoot(root)
  check('裸项目：根定位到自身', found === root, found)
  const inv = gradleInvocation(root)
  check('裸项目：标记 wrapperMissing 并退回 gradle', inv.wrapperMissing === true && inv.argv[0] === 'gradle', JSON.stringify(inv))
}

// ---- 场景 6：完全不是 Gradle 项目的目录 ----
{
  const root = join(base, 'not-gradle')
  await mkdir(root, { recursive: true })
  const found = findGradleRoot(root)
  check('非 Gradle 目录：安全返回起始目录', found === root, found)
  const { targets } = await discoverTargets(root)
  // 关键行为：不编造任务名。否则快捷按钮会出现在一个没有 Gradle 的会话里，
  // 点下去必然失败。按钮的显示条件是“发现了可用的 MC Gradle 目标”。
  check('非 Gradle 目录：不返回任何目标（按钮不该出现）', targets.length === 0,
    targets.map((t) => t.task).join(',') || '(empty)')
}

// ---- 场景 7：自定义 run* 任务名要被识别 ----
{
  const root = await makeProject('custom-runs', {
    settings: "rootProject.name = 'Custom'\n",
    runXml: {
      'runGameTest.run.xml': ':runGameTest',
      'runServer.run.xml': 'runServer',
    },
  })
  // IDEA 运行配置本身就构成 MC 证据（用户亲手策展的运行入口），
  // 因此这里不需要额外的 build.gradle 证据 —— 顺便验证这条通路。
  const { targets } = await discoverTargets(root)
  const tasks = targets.map((t) => t.task)
  check('自定义 run* 任务被发现', tasks.includes(':runGameTest'), tasks.join(','))
  check('无前导冒号的任务名被归一化', tasks.includes(':runServer') && !tasks.includes('runServer'), tasks.join(','))
  check('未知 kind 归入 other', targets.find((t) => t.task === ':runGameTest')?.kind === 'other',
    targets.find((t) => t.task === ':runGameTest')?.kind)
}

// ---- 场景 8：从很深的子目录向上也能找到根 ----
{
  const root = await makeProject('deep', {
    settings: "rootProject.name = 'Deep'\n",
  })
  const deep = join(root, 'a', 'b', 'c', 'd', 'e', 'f')
  await mkdir(deep, { recursive: true })
  check('深层目录：向上找到根', findGradleRoot(deep) === root, findGradleRoot(deep))
}

// ---- 场景 9：Kotlin DSL ----
{
  const root = join(base, 'kotlin-dsl')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'settings.gradle.kts'), 'rootProject.name = "Kts"\ninclude("core")\n')
  await writeFile(join(root, 'build.gradle.kts'), '// kts\n')
  await writeFile(join(root, 'gradlew.bat'), '@echo off\n')
  await mkdir(join(root, 'core'), { recursive: true })
  await writeFile(join(root, 'core', 'build.gradle.kts'), '// core\n')
  // Kotlin DSL 下也要有 MC 证据：子项目声明 loom 插件与 runs 块。
  await writeFile(join(root, 'core', 'build.gradle.kts'),
    'plugins { id("fabric-loom") }\nloom {\n  runs {\n    client {}\n    server {}\n  }\n}\n')
  const { targets } = await discoverTargets(root)
  const tasks = targets.map((t) => t.task)
  check('Kotlin DSL：解析 include("core")', tasks.includes(':core:runClient'), tasks.join(','))
  check('Kotlin DSL：根定位正确', findGradleRoot(join(root, 'core')) === root)
}

await rm(base, { recursive: true, force: true }).catch(() => {})

console.log('')
console.log(failures === 0 ? 'ALL COMPAT TESTS PASSED' : `${failures} COMPAT TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
