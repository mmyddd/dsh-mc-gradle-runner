/**
 * 「把一行内容送进正在跑的游戏」这条链路上，除了真正的写入之外的全部判断。
 *
 * 单独一层的原因：这里的两个决定都很容易写错，而写错之后表面上一切正常——
 * 工具返回成功、面板提示已发送，只有游戏里什么都没发生。所以两件事都留在
 * 可被单测直接调用的地方：
 *
 *   1. **往哪个任务写**。给了 job_id 就用它，但必须复核它现在真的有人读 stdin；
 *      没给就挑本会话最近启动的那个可交互任务。挑错了会写进一个批处理任务的
 *      管道，字节消失得无声无息。
 *
 *   2. **回执归谁**。「写进管道」不等于「游戏收到了」，唯一的送达证据是桥打印的
 *      `[mc-console] ...` 行。而输出是累积的，所以必须只看**写入之后新出现**的行，
 *      否则上一条命令的回执会被当成本次的结果——这比拿不到回执更糟，因为它会
 *      让模型确信一件没发生的事。
 *
 * @module dsh-mc-gradle-runner/command
 */

/** 桥往 stdout 打的回执前缀，与 lib/console-bridge 里的 TAG 一致。 */
const RECEIPT_TAG = '[mc-console]'

/** 轮询输出的间隔。桥处理一行的延迟是毫秒级，100ms 足够且不会空转。 */
const POLL_INTERVAL_MS = 100

/**
 * 把 `mc_send_command` 的 `job_id` 收敛成一个可写的任务。
 *
 * 省略 id 时用「本会话最近启动、仍在运行」的那个任务。选最近而不是选唯一：
 * 交互式游戏任务往往同时只有一个，但 runData 之类的批处理会并存；
 * 按启动时间取最新最接近用户此刻在看的那个。
 *
 * 拒绝原因要具体到「该怎么办」，因为模型会把这句话原样转述给用户。
 *
 * @param registry 任务注册表。
 * @param ownerId 会话 id。
 * @param jobId 调用方给的 id，可为空。
 * @returns `{ id, task }` 或 `{ blocked: 原因 }`。
 */
export function resolveInputTarget(registry, ownerId, jobId) {
  const wanted = typeof jobId === 'string' ? jobId.trim() : ''
  if (wanted.length > 0) {
    const job = registry.get(wanted, ownerId)
    if (job === undefined) throw new Error(`没有找到任务 ${wanted}`)
    if (job.canInput !== true) {
      return { blocked: job.inputReason ?? `任务 ${wanted} 的标准输入没有程序读取` }
    }
    return { id: job.id, task: job.task }
  }
  const live = registry.list(ownerId).filter((job) => job.canInput === true)
  if (live.length === 0) {
    return {
      blocked: '本会话没有可写入的 run* 任务。先用 mc_run_task 起 runClient 或 runServer，再发命令。',
    }
  }
  const latest = live.reduce((best, job) => (job.startedAt > best.startedAt ? job : best))
  return { id: latest.id, task: latest.task }
}

/** 把可能缺失、可能越界的数字参数夹进区间。 */
export function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

/**
 * 在一段累积输出里找出属于本次写入的回执。
 *
 * 拆出来是为了能直接单测「只认新行」这条规则。
 *
 * @param full 任务当前的完整输出。
 * @param from 写入时的输出长度。
 * @returns 第一条新出现的回执行（trim 后），没有则 undefined。
 */
export function findReceipt(full, from) {
  if (typeof full !== 'string') return undefined
  // from 可能大于当前长度（输出被 outputLimitBytes 截断过），取小值避免越界。
  const start = Math.min(typeof from === 'number' && from > 0 ? from : 0, full.length)
  const hit = full.slice(start).split(/\r?\n/).find((one) => one.includes(RECEIPT_TAG))
  return hit === undefined ? undefined : hit.trim()
}

/**
 * 等游戏侧打印这次写入的回执。
 *
 * 桥（lib/console-bridge）每处理一行都会往 stdout 打一行 `[mc-console] ...`，
 * 那才是「命令真的被客户端接住了」的证据；`write()` 返回只说明字节进了管道。
 *
 * @param registry 任务注册表。
 * @param id 任务 id。
 * @param ownerId 会话 id。
 * @param from 写入前的输出长度。
 * @param timeoutMs 最长等待。
 * @param signal 工具执行的取消信号。
 * @returns 回执文本，或 undefined（超时/被取消/没有回执）。
 */
export function awaitBridgeReceipt(registry, id, ownerId, from, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = () => {
      const read = registry.readAll(id, ownerId)
      const hit = findReceipt(read?.text, from)
      if (hit !== undefined) {
        resolve(hit)
        return
      }
      if (Date.now() >= deadline || signal?.aborted === true) {
        resolve(undefined)
        return
      }
      setTimeout(tick, POLL_INTERVAL_MS)
    }
    tick()
  })
}
