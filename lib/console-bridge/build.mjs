#!/usr/bin/env node
/**
 * 编译 Minecraft 客户端控制台桥（lib/console-bridge/ConsoleBridge.java → mc-console-bridge.jar）。
 *
 * 为什么要预编译好再提交
 * --------------------
 * 这条桥必须作为 -javaagent 挂进游戏 JVM，而 -javaagent 只认 jar，不认 .java。
 * 用户的机器上通常**没有 javac**（跑游戏只需要 JRE），所以不能指望运行时编译；
 * 这个脚本只在开发/发版时跑一次，产物 mc-console-bridge.jar 随仓库一起提交。
 *
 * 用法：node lib/console-bridge/build.mjs
 * 需要 PATH 或 JAVA_HOME 里能找到 javac 与 jar（JDK 17+，与 MC 1.20.1 对齐）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, 'ConsoleBridge.java')
const output = join(here, 'mc-console-bridge.jar')
const manifest = join(here, 'MANIFEST.MF')

/** 找到某个 JDK 工具的绝对路径：先 PATH，再 JAVA_HOME。 */
function tool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const javaHome = process.env.JAVA_HOME
  const candidates = []
  if (javaHome !== undefined) candidates.push(join(javaHome, 'bin', exe))
  candidates.push(exe)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8' })
    if (probe.error === undefined) return candidate
  }
  throw new Error(`找不到 ${name}：装一个 JDK 17+，或设置 JAVA_HOME`)
}

const javac = tool('javac')
const jar = tool('jar')
const work = mkdtempSync(join(tmpdir(), 'mc-bridge-'))
try {
  const classes = join(work, 'classes')
  const compile = spawnSync(
    javac,
    // -encoding UTF-8 不能省：Windows 中文环境默认 GBK，源码里的中文注释会直接编译失败。
    ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-Xlint:-options', '-d', classes, source],
    { encoding: 'utf8' },
  )
  if (compile.status !== 0) {
    // javac 17 已不再支持 -source 8 之外的老版本；实在不行就用当前默认版本重试一次。
    const retry = spawnSync(javac, ['-encoding', 'UTF-8', '-d', classes, source], { encoding: 'utf8' })
    if (retry.status !== 0) {
      console.error(compile.stderr || retry.stderr)
      throw new Error('编译 ConsoleBridge.java 失败')
    }
  }
  const pack = spawnSync(jar, ['cfm', output, manifest, '-C', classes, '.'], { encoding: 'utf8' })
  if (pack.status !== 0) {
    console.error(pack.stderr)
    throw new Error('打包 mc-console-bridge.jar 失败')
  }
  if (!existsSync(output)) throw new Error('打包后没有找到 jar')
  console.log(`已生成 ${output}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
