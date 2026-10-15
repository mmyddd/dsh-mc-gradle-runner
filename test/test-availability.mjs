// 复现「不支持 runxxx 的工作区仍然出现按钮」
//
// 用户报告：在不支持 run* 的工作区里按钮照常出现。
// 怀疑点：discovery 对所有「有 build.gradle 的项目」无条件补上
// :runClient / :runData / :runServer，从不验证该项目是否真的声明了 run 任务。
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverTargets, findGradleRoot, looksLikeGradleRoot } from '../lib/discovery.js'

const base = await mkdtemp(join(tmpdir(), 'bug1-'))

/** 造一个项目目录。 */
async function make(name, files) {
  const root = join(base, name)
  await mkdir(root, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, content)
  }
  return root
}

/** 打印一个目录的可用性裁决。 */
async function report(title, dir) {
  const root = findGradleRoot(dir)
  const isGradle = looksLikeGradleRoot(root)
  const { targets, sources } = await discoverTargets(root)
  const available = isGradle && targets.length > 0
  console.log(`--- ${title} ---`)
  console.log(`  cwd            : ${dir}`)
  console.log(`  gradleRoot     : ${root}`)
  console.log(`  isGradleProject: ${isGradle}`)
  console.log(`  targets        : ${targets.length} -> ${targets.map((t) => t.task).join(', ') || '(无)'}`)
  console.log(`  sources        : ${JSON.stringify(sources)}`)
  console.log(`  ==> available  : ${available}  ${available ? '❌ 按钮会出现（不该）' : '✅ 按钮不出现'}`)
  console.log('')
  return available
}

const results = []

// 场景 1：普通 Java Gradle 库项目（与 MC 完全无关，没有任何 run 任务）
const plainJava = await make('plain-java-lib', {
  'settings.gradle': "rootProject.name = 'PlainLib'\n",
  'build.gradle': "plugins { id 'java-library' }\n",
  'src/main/java/App.java': 'class App {}\n',
})
results.push(['普通 Java Gradle 库项目', await report('普通 Java Gradle 库项目', plainJava)])

// 场景 2：非 Gradle 目录
const notGradle = await make('not-gradle', { 'readme.md': 'hi\n' })
results.push(['非 Gradle 目录', await report('非 Gradle 目录', notGradle)])

// 场景 3：多模块 Java 库（根是聚合器，子项目都是库）
const multiLib = await make('multi-lib', {
  'settings.gradle': "rootProject.name = 'MultiLib'\ninclude 'core'\ninclude 'util'\n",
  'build.gradle': "subprojects { apply plugin: 'java-library' }\n",
  'core/build.gradle': "plugins { id 'java-library' }\n",
  'util/build.gradle': "plugins { id 'java-library' }\n",
})
results.push(['多模块 Java 库', await report('多模块 Java 库', multiLib)])

// 场景 4：真的 MC 项目（有 runs 块）——应当 available=true
const realMc = await make('real-mc', {
  'settings.gradle': "rootProject.name = 'RealMc'\n",
  'build.gradle': "runs {\n  client {}\n  data {}\n  server {}\n}\n",
  'gradlew.bat': '@echo off\n',
})
results.push(['真 MC 项目（runs 块）', await report('真 MC 项目（runs 块）', realMc)])

await rm(base, { recursive: true, force: true }).catch(() => {})

console.log('===== 结论 =====')
let bad = 0
for (const [name, available] of results) {
  const shouldShow = name.startsWith('真 MC')
  const ok = available === shouldShow
  if (!ok) bad += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name.padEnd(26)} available=${available} 期望=${shouldShow}`)
}
console.log('')
console.log(bad === 0
  ? 'ALL AVAILABILITY TESTS PASSED'
  : `${bad} AVAILABILITY TEST(S) FAILED —— 不支持 run* 的工作区会长出按钮`)
process.exit(bad === 0 ? 0 : 1)
