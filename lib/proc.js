/**
 * 后台任务执行：Gradle run* 进程的启动、输出汇聚、取消与结算。
 *
 * 刻意**不**依赖 `@deepseek-ai/dsh-jobs`。理由是这个插件要能在任何 profile 里
 * 直接加载（含 profile 未安装 jobs 服务的情形），而 jobs 服务的 `start()` 会
 * 拒绝没有控制器服务的 owner。这里自己持有一份任务注册表，语义对齐 jobs：
 * 结算一次为终态、输出环形缓冲有上限、取消走 SIGTERM → SIGKILL 阶梯。
 *
 * 同时刻意不依赖 `@deepseek-ai/dsh-subprocess`：直接用 node:child_process，
 * 避免为一个简单需求引入运行时包解析风险。
 *
 * @module dsh-mc-gradle-runner/proc
 */

import { spawn } from 'node:child_process'

/** 结算后的任务记录在内存里保留多久（毫秒），到期自动清理。 */
const RETENTION_MS = 30 * 60 * 1000

/** 取消时先温和终止，等这么久仍未退出则强制终止。 */
const KILL_GRACE_MS = 5000

/**
 * 发出强制终止后，兜底结算的等待上限。
 *
 * 需要它是因为 `close` 事件要求**所有** stdio 管道都关闭：被强杀的父进程
 * 若留下仍持有管道写端的孙进程，`close` 可能永远不触发，任务就会卡在
 * `stopping` 上永不结算。强杀已经发出、进程事实上已经结束，
 * 因此超时后按 `killed` 结算，并把“已强制终止”记进 detail。
 */
const FORCE_SETTLE_MS = 6000

/** 单次捕获输出的上限，超过则从头部丢弃（保留尾部更有诊断价值）。 */
const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024

/**
 * 按 pid 结束一整棵进程树。
 *
 * 与 {@link killTree} 的区别是这里只拿到 pid、没有 child 句柄——
 * 取消流程需要它，因为父进程（wrapper）往往在温和终止时就退出了，
 * 句柄随即失效，但它的后代仍可能活着，必须按记下的 pid 清干净。
 *
 * @param pid 根进程 pid。
 * @param force 是否强制。
 * @returns 是否成功发出终止请求。
 */
export function killTreeByPid(pid, force = true) {
  if (typeof pid !== 'number' || pid <= 0) return false
  if (process.platform === 'win32') {
    try {
      const args = force ? ['/pid', String(pid), '/T', '/F'] : ['/pid', String(pid), '/T']
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {})
      killer.unref?.()
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
    return true
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
      return true
    } catch {
      return false
    }
  }
}

/**
 * 结束一整棵进程树。
 *
 * 这是“强制关闭”的核心：Gradle 不是叶子进程，它会拉起 Gradle daemon，
 * daemon 再拉起 `java`（runClient 还会再拉起游戏进程）。只对直接子进程发信号
 * 会留下一串孤儿进程——用户看到的是“按钮显示已停止，但游戏窗口还在”。
 *
 * Windows 用 `taskkill /T /F`（`/T` 结束整棵树，`/F` 强制），
 * POSIX 用**进程组**：spawn 时设 `detached: true` 让子进程成为组长，
 * 于是 `kill(-pid)` 能把整组一起带走。
 *
 * 任何一步失败都不抛出：终止是尽力而为，失败时调用方仍有兜底结算。
 *
 * @param child 直接子进程句柄。
 * @param force 是否使用强制模式（false 为温和终止）。
 * @returns 是否成功发出了终止请求。
 */
export function killTree(child, force = true) {
  if (child === undefined || child.pid === undefined) return false
  return killTreeByPid(child.pid, force)
}

/**
 * 任务注册表：进程内单例，跨会话共享，但按 owner 做可见性隔离。
 */
export class RunRegistry {
  /**
   * @param options.outputLimitBytes 每个任务保留的输出字节上限。
   * @param options.duplicatePolicy 同名任务并发策略。
   */
  constructor(options = {}) {
    this.outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT
    this.duplicatePolicy = options.duplicatePolicy ?? 'reject'
    /** @type {Map<string, object>} */
    this.jobs = new Map()
    this.counter = 0
    this.timer = setInterval(() => this.sweep(), 60_000)
    // 定时器不应阻止进程退出。
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 清理已结算且超过保留期的任务。 */
  sweep() {
    const now = Date.now()
    for (const [id, job] of this.jobs) {
      if (job.settledAt !== undefined && now - job.settledAt > RETENTION_MS) {
        this.jobs.delete(id)
      }
    }
  }

  /** 停止注册表：强制结束全部在跑的任务及其进程树。 */
  dispose() {
    clearInterval(this.timer)
    for (const job of this.jobs.values()) {
      if (job.child !== undefined && job.settledAt === undefined) {
        // 插件卸载也必须带走整棵树，否则 Gradle 拉起的 java 会继续占着端口与目录。
        killTree(job.child, true)
      }
    }
    this.jobs.clear()
  }

  /**
   * 列出某会话可见的任务。
   * @param ownerId 会话 id；省略时只返回无主任务。
   */
  list(ownerId) {
    const out = []
    for (const job of this.jobs.values()) {
      if (ownerId === undefined ? job.owner !== undefined : job.owner !== ownerId) continue
      out.push(publicView(job))
    }
    return out.sort((a, b) => a.startedAt - b.startedAt)
  }

  /** 取单个任务的公开视图；未知或非本会话时抛错。 */
  get(id, ownerId) {
    return publicView(this.require(id, ownerId))
  }

  /**
   * 列出**所有**任务，不按归属过滤。
   *
   * 「按会话隔离」对模型侧是必要的：不同会话的 agent 不该互相读写对方的任务。
   * 但浏览器的工具栏与日志面板没有会话身份可言——它拿到的是 sessionId，
   * 而任务记的是 agent id，两者对不上。所以 UI 侧要的是全量列表：
   * 模型用 mc_run_task 起的任务同样出现在右上角、同样能打开日志。
   *
   * 这不是越权：这个 HTTP 端点只在本机进程内可达，而且 kill / input 早就
   * 是按 `ownerId === undefined` 放行的。
   *
   * @returns 全部任务的公开视图，按启动时间升序。
   */
  listAll() {
    const out = []
    for (const job of this.jobs.values()) out.push(publicView(job))
    return out.sort((a, b) => a.startedAt - b.startedAt)
  }

  /** 取任务的内部记录；未知或非本会话时抛错。 */
  require(id, ownerId) {
    const job = this.jobs.get(id)
    if (job === undefined) throw new Error(`未知任务 id：${id}`)
    if (ownerId !== undefined && job.owner !== undefined && job.owner !== ownerId) {
      throw new Error(`任务 ${id} 不属于当前会话`)
    }
    return job
  }

  /**
   * 读取自上次游标以来的增量输出。
   *
   * 与 jobs 服务一样，读取是“消费式”的：模型看到的增量不会重复。
   * 但 `readAt` 仍可任意回看，供 UI 或诊断使用。
   *
   * @param id 任务 id。
   * @param ownerId 会话 id。
   * @returns `{ text, lossy, result, job }`。
   */
  read(id, ownerId) {
    const job = this.require(id, ownerId)
    const from = job.cursor
    job.cursor = job.output.length
    const chunk = job.output.slice(from)
    return {
      text: chunk,
      lossy: from < job.earliest,
      result: job.settledAt === undefined ? undefined : job.result,
      job: publicView(job),
    }
  }

  /**
   * 读取保留缓冲里的全部输出（不移动游标）。
   * @param id 任务 id。
   * @param ownerId 会话 id。
   */
  readAll(id, ownerId) {
    const job = this.require(id, ownerId)
    return { text: job.output, lossy: job.earliest > 0, job: publicView(job) }
  }

  /**
   * 启动一个 Gradle run* 任务。
   *
   * 并发策略由 `duplicatePolicy` 决定：
   *   - reject（默认）：同名任务在跑时拒绝，返回冲突信息而不是静默排队；
   *   - reuse：复用正在跑的那个任务，不新起进程；
   *   - replace：先取消旧任务，再启动新的；
   *   - allow：不做检查，允许多实例并存。
   *
   * @param spec 任务规格。
   * @returns `{ job, reused, replaced }`。
   */
  start(spec) {
    const existing = this.findLive(spec.task, spec.owner)
    let replaced
    if (existing !== undefined) {
      if (this.duplicatePolicy === 'reject') {
        const error = new Error(
          `同名任务已在运行：${existing.id}（${existing.task}，状态 ${existing.status}）。`
          + `请先用 job_output 读取，或先 job_kill 再重试；如需自动复用请把 duplicatePolicy 设为 reuse。`,
        )
        error.code = 'DUPLICATE_JOB'
        error.jobId = existing.id
        throw error
      }
      if (this.duplicatePolicy === 'reuse') {
        return { job: publicView(existing), reused: true, replaced: undefined }
      }
      if (this.duplicatePolicy === 'replace') {
        replaced = existing.id
        this.kill(existing.id, spec.owner, '被同名新任务替换')
      }
    }

    const id = `run-${++this.counter}`
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      // stdin 必须是管道而不是 ignore：runClient 这类交互式任务要从控制台读指令。
      //
      // 注意这条管道的语义边界：Gradle 的 JavaExec 只有在构建脚本里写了
      // `standardInput = System.in` 时才会把管道转给被拉起的 JVM，
      // 否则游戏进程看到的是空流。插件这一侧只能保证「写得进去」，
      // 送不到就静默失败——面板上会给出对应的提示文案，而不是假装成功。
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows 上把 wrapper 经 cmd.exe 转发时，必须让 shell 语义生效。
      windowsVerbatimArguments: false,
      // POSIX 上让子进程自成进程组，取消时才能用 kill(-pid) 带走整棵树。
      // Windows 不用这个开关（taskkill /T 走的是父子关系）。
      detached: process.platform !== 'win32',
    })

    const job = {
      id,
      kind: 'run',
      task: spec.task,
      label: spec.label,
      owner: spec.owner,
      target: spec.target,
      cwd: spec.cwd,
      status: 'running',
      startedAt: Date.now(),
      settledAt: undefined,
      result: undefined,
      detail: undefined,
      child,
      output: '',
      earliest: 0,
      cursor: 0,
      onSettle: [],
      // 这个任务的标准输入有没有人读。由调用方判断后传进来（见 lib/bridge.js）：
      //   'stdio' → 有：runServer 的 Forge 控制台线程，
      //             或 runClient 挂上控制台桥后由 agent 补的读线程
      //   'none'  → 没有：runData、缺桥的 runClient、关掉 forwardStdin 的情形
      // 缺省按 'stdio' 处理，避免任何既有调用方被默默改成「不能写」。
      inputConsumer: spec.inputConsumer ?? 'stdio',
      // 来源：'user'（面板/工具以外的按钮）或 'model'（mc_run_task 工具）。
      // 只影响展示（工具栏打「AI」标记），不参与任何权限判断。
      origin: spec.origin === 'model' ? 'model' : 'user',
      inputReason: spec.inputReason,
      // 结算后要跑的异步后处理（例如 runData 的产物 diff）。
      // 调用方通过 job.artifactsPromise 等待它，避免读到半成品。
      artifacts: undefined,
      artifactsPromise: undefined,
    }
    this.jobs.set(id, job)
    if (typeof spec.onSettle === 'function') job.postSettle = spec.onSettle

    const append = (channel, text) => {
      if (text.length === 0) return
      const prefix = channel === 'stderr' ? '[stderr] ' : ''
      // 按行加前缀，让 stderr 与 stdout 混排时仍可分辨。
      const lines = text.split(/(?<=\n)/).map((line) => `${prefix}${line}`)
      job.output += lines.join('')
      if (job.output.length > this.outputLimitBytes) {
        const drop = job.output.length - this.outputLimitBytes
        job.output = job.output.slice(drop)
        job.earliest += drop
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (data) => append('stdout', String(data)))
    child.stderr?.on('data', (data) => append('stderr', String(data)))

    child.on('error', (error) => {
      // spawn 失败（例如 gradlew 不存在）也走正常结算路径，让模型读到原因。
      append('stderr', `进程启动失败：${error.message}`)
      this.settle(job, 'failed', `spawn 失败：${error.message}`)
    })
    child.on('close', (code, signal) => {
      if (job.settledAt !== undefined) return
      if (job.killRequested === true) {
        this.settle(job, 'killed', job.killReason ?? '已取消')
        return
      }
      if (code === 0) {
        this.settle(job, 'completed', undefined)
      } else {
        const detail = signal !== null && signal !== undefined
          ? `被信号 ${signal} 终止`
          : `退出码 ${code}`
        this.settle(job, 'failed', detail)
      }
    })

    return { job: publicView(job), reused: false, replaced }
  }

  /** 找出同 owner 下正在跑的同名任务。 */
  findLive(task, owner) {
    for (const job of this.jobs.values()) {
      if (job.task !== task) continue
      if (owner !== undefined && job.owner !== undefined && job.owner !== owner) continue
      if (job.settledAt === undefined) return job
    }
    return undefined
  }

  /** 结算一个任务：幂等，释放等待者。 */
  settle(job, status, detail) {
    if (job.settledAt !== undefined) return
    job.status = status
    job.detail = detail
    job.settledAt = Date.now()
    job.result = summarizeOutput(job)
    // 结算后处理：**只要不是被取消就都跑**。
    //
    // 早先这里限定 `status === 'completed'`，理由是"失败任务的输出本身就是诊断信息"。
    // 那个判断是错的：`runClient` 崩溃时结算为 `failed`，而崩溃报告恰恰是失败时
    // 最需要的东西——限定 completed 会让崩溃识别永远不触发，模型只能看到
    // “退出码 1”。取消（killed）仍然跳过：那是用户主动结束，没有诊断价值。
    if (status !== 'killed' && typeof job.postSettle === 'function') {
      job.artifactsPromise = Promise.resolve()
        .then(() => job.postSettle(job))
        .then((value) => {
          job.artifacts = value
          return value
        })
        .catch((error) => {
          // 后处理失败不能把任务本身的状态改判；
          // 记进 artifacts.error，让模型看到“采集失败”而不是又一个任务失败。
          job.artifacts = { error: `结算后处理失败：${error?.message ?? String(error)}` }
          return job.artifacts
        })
    }
    const waiters = job.onSettle.splice(0)
    for (const resolve of waiters) resolve(publicView(job))
  }

  /**
   * 等待任务的结算后处理完成。
   *
   * 任务一 close 就算结算，但 runData 的产物 diff 是异步采集的。
   * 工具层必须先 await 这个 promise，才能把 diff 一起返回给模型。
   *
   * @param id 任务 id。
   * @param ownerId 会话 id。
   * @returns 后处理结果，没有后处理时为 undefined。
   */
  async awaitArtifacts(id, ownerId) {
    const job = this.require(id, ownerId)
    if (job.artifactsPromise === undefined) return undefined
    return job.artifactsPromise
  }

  /**
   * 请求取消一个任务。
   * @param id 任务 id。
   * @param ownerId 会话 id。
   * @param reason 取消原因，记入结算 detail。
   * @returns `'requested'` 或 `'already-finished'`。
   */
  kill(id, ownerId, reason) {
    const job = this.require(id, ownerId)
    if (job.settledAt !== undefined) return 'already-finished'
    job.killRequested = true
    job.killReason = reason
    job.status = 'stopping'
    // 记住开始取消时的进程树根 pid：父进程可能很快退出，之后就拿不到 pid 了，
    // 而强制升级仍需按这个 pid 去清掉后代。
    const rootPid = job.child?.pid
    job.treeRootPid = rootPid
    // 先温和终止整棵树，给 Gradle 机会自己收尾（关 daemon、删临时目录）。
    killTree(job.child, false)
    // 宽限期后**无条件**强制执行一次整树清理。
    //
    // 这里刻意不检查 job.settledAt：温和终止通常立刻杀掉父进程（wrapper），
    // 任务随即结算为 killed；但被 Gradle 拉起的后代（java worker / 游戏 JVM）
    // 可能把 SIGTERM 当耳旁风继续存活。如果因为“已结算”就跳过升级，
    // 就会留下孤儿进程——用户看到「按钮已停止，但游戏窗口还在」。
    const forceTimer = setTimeout(() => {
      job.forced = true
      // 优先按记下的 pid 清树；child 已退出时 taskkill 会报 not found，属正常。
      killTree(job.child, true)
      if (job.treeRootPid !== undefined && process.platform === 'win32') {
        killTreeByPid(job.treeRootPid, true)
      }
      // 强杀后仍可能因为孙进程持有 stdio 管道而收不到 close 事件，
      // 此时按 killed 兜底结算，避免任务永远卡在 stopping。
      const settleTimer = setTimeout(() => {
        if (job.settledAt !== undefined) return
        this.settle(job, 'killed', `${job.killReason ?? '已取消'}（已强制终止进程树）`)
      }, FORCE_SETTLE_MS)
      if (typeof settleTimer.unref === 'function') settleTimer.unref()
    }, KILL_GRACE_MS)
    if (typeof forceTimer.unref === 'function') forceTimer.unref()
    return 'requested'
  }

  /**
   * 等待任务结算或超时；超时不取消任务。
   * @param id 任务 id。
   * @param timeoutMs 等待上限。
   * @param ownerId 会话 id。
   * @param signal 可选取消信号。
   */
  wait(id, timeoutMs, ownerId, signal) {
    const job = this.require(id, ownerId)
    if (job.settledAt !== undefined) return Promise.resolve(publicView(job))
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const timer = setTimeout(() => finish(publicView(job)), timeoutMs)
      const onAbort = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(new Error('等待被取消'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      job.onSettle.push(finish)
    })
  }

  /**
   * 往任务的标准输入写一行。
   *
   * **只对真的有人在读 stdin 的任务开放。** 这一层校验是本插件最容易搞错的地方：
   * 管道写得进去，不等于有人读。实测证据（Minecraft 1.20.1 源码全库 grep
   * `System.in` 只有一处命中）——
   *
   *   - 服务端 net/minecraft/server/dedicated/DedicatedServer.java 的
   *     "Server console handler" 线程会循环 readLine → handleConsoleInput，
   *     Forge 还先走 TerminalHandler.handleCommands（JLine 控制台）；
   *   - **客户端 net/minecraft/client/** 下没有任何一处读 stdin**，
   *     runClient 拉起 JVM 后直接进 GUI 主循环。所以客户端必须靠 -javaagent
   *     在游戏 JVM 里补一个读线程（lib/console-bridge/）；桥没挂上时这里拒绝。
   *
   * 拒绝要发生在写入之前并给出原因，而不是先把命令丢进管道、
   * 再让面板显示「已发送」——那是对用户的谎报。
   *
   * @param id 任务 id。
   * @param ownerId 会话 id。
   * @param text 要写入的内容，末尾换行由本方法补。
   * @returns `{ delivered: true }`。
   */
  write(id, ownerId, text) {
    const job = this.require(id, ownerId)
    if (job.settledAt !== undefined) {
      throw new Error(`任务 ${id} 已结束（${job.status}），无法再写入`)
    }
    if (job.inputConsumer === 'none') {
      const error = new Error(
        job.inputReason ?? `任务 ${id} 的标准输入没有任何程序读取，写入的命令无处可去`,
      )
      error.code = 'INPUT_UNSUPPORTED'
      throw error
    }
    if (job.child?.stdin === undefined || job.child.stdin.destroyed === true) {
      throw new Error(`任务 ${id} 的标准输入不可用`)
    }
    const line = String(text ?? '')
    // 统一按 \n 结尾：Gradle 侧读到换行才认为一条命令结束。
    job.child.stdin.write(line.endsWith('\n') ? line : `${line}\n`)
    return { delivered: true }
  }

  /** 把一个已结算任务从可见集合里移除。 */
  remove(id, ownerId) {
    const job = this.require(id, ownerId)
    if (job.settledAt === undefined) throw new Error(`任务 ${id} 仍在运行，无法移除`)
    this.jobs.delete(id)
  }
}

/**
 * 从任务输出里提炼一份结算摘要。
 *
 * Gradle 的输出末尾通常是 BUILD SUCCESSFUL/FAILED 与错误行，
 * 取尾部若干行作为 `result` 最有用；完整输出仍可通过 readAll 取回。
 *
 * @param job 内部任务记录。
 * @returns 摘要文本。
 */
function summarizeOutput(job) {
  const lines = job.output.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const tail = lines.slice(-25).join('\n')
  return tail.length > 0 ? tail : '(无输出)'
}

/** 生成对外可见的任务视图，隐藏 child、缓冲等内部字段。 */
export function publicView(job) {
  return {
    id: job.id,
    kind: job.kind,
    task: job.task,
    label: job.label,
    // 谁起的。工具栏与日志面板据此标记「由 AI 启动」的任务，
    // 让模型在后台起的 run* 也能在右上角看到、也能点开日志。
    origin: job.origin,
    target: job.target,
    status: job.status,
    startedAt: job.startedAt,
    ...(job.settledAt !== undefined ? { finishedAt: job.settledAt } : {}),
    ...(job.detail !== undefined ? { detail: job.detail } : {}),
    outputBytes: job.output.length,
    // 面板据此决定控制台输入框是否可用。
    //
    // 判据是**两个**条件同时成立：任务还在跑，且这个任务的进程里真的有人读 stdin。
    // 早先只看「还在跑」，于是 runClient 下输入框可编辑、发送后显示「已发送」，
    // 而客户端根本没有 stdin 消费者，命令凭空消失（见 write 的说明）。
    // 现在 runClient 在桥挂上之后也是 'stdio'，所以这个字段的语义是
    // 「有人读」而不是「是不是服务端」。
    canInput: job.settledAt === undefined && job.inputConsumer !== 'none',
    // canInput 为 false 时必须给出原因，面板直接把它当 placeholder / 提示文案用，
    // 这样用户看到的是「为什么不能发」，而不是一个莫名灰掉的输入框。
    ...(job.settledAt !== undefined
      ? { inputReason: `任务已结束（${job.status}），无法再写入标准输入` }
      : job.inputConsumer === 'none'
        ? { inputReason: job.inputReason ?? '该任务不会读取标准输入' }
        : {}),
  }
}

/**
 * 一次性执行一个短命令并收集输出，供 git 探测这类同步调用使用。
 *
 * 与 {@link RunRegistry} 不同，这里不需要后台语义，直接把输出读完即可。
 *
 * @param argv 命令与参数。
 * @param cwd 工作目录。
 * @param timeoutMs 超时上限，到期强杀并返回已收集的输出。
 * @returns `{ stdout, stderr, code }`。
 */
export function runOnce(argv, cwd, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ stdout: '', stderr: String(error), code: -1 })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出。
      }
      finish(-1)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (data) => {
      stdout += String(data)
    })
    child.stderr?.on('data', (data) => {
      stderr += String(data)
    })
    child.on('error', (error) => {
      stderr += String(error)
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}
