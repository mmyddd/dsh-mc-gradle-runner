/**
 * 控制台桥（javaagent）的定位、环境变量与「这个任务能不能发命令」的判定。
 *
 * 单独成一个模块，是为了让这些纯逻辑能被 test/ 直接测到——
 * 它们决定了面板上输入框到底可不可用，是最容易悄悄错的地方。
 *
 * 背景（实证，见 README 与 lib/console-bridge/ConsoleBridge.java）
 * -----------------------------------------------------------------
 * Minecraft 1.20.1 源码全库 grep `System.in` 只有一处真命中：
 * net/minecraft/server/dedicated/DedicatedServer.java 的 "Server console handler"
 * 线程。net/minecraft/client/** 下**没有任何消费者**，所以 runClient 下写进
 * 管道的字节会原地消失。
 *
 * 插件的对策是给客户端任务挂一个 javaagent：它在游戏 JVM 里起一条读 stdin
 * 的线程，用反射把每行交给客户端主线程（/开头当命令，其余当聊天）。
 * 挂载方式：环境变量 `DSH_MC_CONSOLE_BRIDGE` 传 jar 绝对路径，
 * lib/stdin-init.gradle 读它并加进 JavaExec 的 jvmArgs。
 *
 * @module dsh-mc-gradle-runner/bridge
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 宿主 → init 脚本 → JavaExec 的环境变量名。
 *
 * 为什么用环境变量而不是 `-P` 构建属性：Windows 上构建命令整体经过 cmd.exe，
 * 带空格的绝对路径在那一层很容易被拆成两个参数；环境变量不经过 shell 解析。
 */
export const BRIDGE_ENV = 'DSH_MC_CONSOLE_BRIDGE'

/** jar 相对本模块的位置：lib/console-bridge/mc-console-bridge.jar。 */
const JAR_RELATIVE = join('console-bridge', 'mc-console-bridge.jar')

/**
 * 本插件自带控制台桥 jar 的绝对路径；不存在时返回 undefined。
 *
 * 文件缺失时必须返回 undefined 而不是一个假路径：静默挂一个不存在的
 * javaagent 会让整个 runClient 启动失败，比"控制台不能用"严重得多。
 *
 * @param base 可选，lib 目录（测试用）。
 * @returns jar 绝对路径或 undefined。
 */
export function consoleBridgeJar(base) {
  const here = base ?? dirname(fileURLToPath(import.meta.url))
  const jar = join(here, JAR_RELATIVE)
  return existsSync(jar) ? jar : undefined
}

/**
 * 客户端不能用桥时给用户看的原因。
 *
 * 这条文案会直接进输入框的 placeholder，所以要能指导下一步动作，
 * 而不是只说"不可用"。
 */
export const BRIDGE_MISSING_REASON = (
  'Minecraft 客户端不读取标准输入，命令需要插件自带控制台桥才能送达；'
  + '当前安装里缺少 lib/console-bridge/mc-console-bridge.jar。'
  + '请重新安装插件，或在插件目录运行 node lib/console-bridge/build.mjs 生成它（需要 JDK 17+）。'
)

/** 用户把 forwardStdin 关掉时的原因：此时 -I 没有注入，连转发都不存在。 */
export const FORWARDING_OFF_REASON = (
  '插件的 stdin 转发被关掉了（配置项 forwardStdin=false），'
  + '命令无法送到游戏 JVM。要使用控制台输入请把它打开。'
)

/**
 * 一个任务的输入可用性，以及要不要给它挂桥。
 *
 * 返回 `{ consumer, reason, env }`：
 *   - consumer：`'stdio'` 表示进程里真的有人读 stdin，`'none'` 表示写了也没人收；
 *   - reason：consumer 为 none 时的原因文案；
 *   - env：要追加给子进程的环境变量（只有客户端挂桥时非空）。
 *
 * @param kind discovery 判定的任务类型：client / server / data / other。
 * @param jar consoleBridgeJar() 的结果。
 * @param forwarding 宿主是否真的注入了 stdin 转发（forwardStdin 且脚本存在）。
 */
export function bridgePlan(kind, jar, forwarding = true) {
  if (!forwarding) {
    // 没有 -I 就没有 standardInput = System.in，JavaExec 的子进程看到的是空流。
    // 这种情况下无论任务类型都不能承诺送达。
    return { consumer: 'none', reason: FORWARDING_OFF_REASON }
  }
  if (kind === 'server') {
    // Forge 的 TerminalHandler（JLine）已经在读同一个 stdin。
    // 再挂一个读者只会两边抢行，命令随机丢一半，所以服务端永远不挂。
    return { consumer: 'stdio' }
  }
  if (kind === 'client') {
    if (jar === undefined) {
      return { consumer: 'none', reason: BRIDGE_MISSING_REASON }
    }
    return { consumer: 'stdio', env: { [BRIDGE_ENV]: jar } }
  }
  if (kind === 'data') {
    return {
      consumer: 'none',
      reason: '数据生成（runData）是一次性批处理任务，不会读取标准输入。',
    }
  }
  // 其它自定义 run* 任务无法静态判断，按"可能读"处理：
  // 宁可让用户试一次失败，也不要把它误标成不可用。
  return { consumer: 'stdio' }
}
