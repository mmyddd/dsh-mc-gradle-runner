// 测试共用的小工具。
import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** 本仓库自带的 Gradle wrapper（test/fixtures/wrapper/）。 */
export const WRAPPER_FIXTURE = join(here, '..', 'fixtures', 'wrapper')

/**
 * 找一个可用的 Gradle wrapper 源目录。
 *
 * 优先用本仓库自带的 fixture（自包含，CI 上也能跑）；
 * 也允许用 MC_TEST_PROJECT 指向的真实项目覆盖。
 */
export function wrapperSource() {
  const override = process.env.MC_TEST_PROJECT
  if (override !== undefined && existsSync(join(override, 'gradlew'))) return override
  return WRAPPER_FIXTURE
}

/**
 * 把 wrapper（gradlew / gradlew.bat / gradle/wrapper/*）复制进一个临时项目。
 *
 * wrapper 的 distributionUrl 指向 gradle-9.1.0-bin.zip；首次运行会下载到
 * GRADLE_USER_HOME。想换版本就改 fixtures/wrapper/gradle-wrapper.properties。
 */
export async function copyWrapper(root) {
  const src = wrapperSource()
  await mkdir(join(root, 'gradle', 'wrapper'), { recursive: true })
  for (const name of ['gradlew', 'gradlew.bat']) {
    await copyFile(join(src, name), join(root, name))
  }
  for (const name of ['gradle-wrapper.jar', 'gradle-wrapper.properties']) {
    await copyFile(join(src, 'gradle', 'wrapper', name), join(root, 'gradle', 'wrapper', name))
  }
  return root
}

/** 极简断言器：打印 [PASS]/[FAIL]，最后用 finish() 结算退出码。 */
export function makeChecker() {
  let failures = 0
  return {
    check(label, condition, extra) {
      console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${extra !== undefined ? ` — ${extra}` : ''}`)
      if (!condition) failures += 1
    },
    finish(title) {
      console.log('')
      console.log(failures === 0 ? `ALL ${title} PASSED` : `${failures} ${title} ASSERTION(S) FAILED`)
      return failures === 0 ? 0 : 1
    },
  }
}
