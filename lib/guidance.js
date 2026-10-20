/**
 * 系统提示词里的 MC 运行说明。
 *
 * 单独一层纯逻辑（不碰 cordis、不碰文件系统），因为这份文案有两个约束：
 *
 *   1. **只在真有可运行 MC 项目时才出现**。工作区里没有 MC 项目时往提示词
 *      塞这段说明，模型会去调用一堆注定失败的 mc_* 工具——这比不给说明更糟。
 *      可用性由调用方（lib/index.js）按「和显示按钮完全同一套判据」裁决，
 *      这里只拿到结论后拼文案。
 *
 *   2. **只描述这次真的注册了的工具**。enabledTools 可能只放开了其中几个，
 *      提到没注册的工具等于教模型去调不存在的入口。
 *
 * @module dsh-mc-gradle-runner/guidance
 */

/** 分节名。只在 `system-prompt/assemble` 的 waterfall 里用一次，不会重复注册。 */
export const GUIDANCE_SECTION_NAME = 'mc-gradle-runner:console'

/**
 * 把 `discovery.assessRoot` 的裁决变成提示词正文。
 *
 * 这一层存在的唯一理由是**判据只有一份**：按钮显隐读 `assessed.available`，
 * 提示词注入也读同一个字段。任何一处另写判据（比如自己 `existsSync('gradlew')`）
 * 都会造出「界面上没有按钮、提示词里却说能用」的错位，而模型没有办法发现这个矛盾。
 *
 * @param assessed `assessRoot` 的返回值。
 * @param tools 本次真正暴露给模型的工具名列表。
 * @returns 提示词正文；工作区不可用或没有可说的工具时返回空串。
 */
export function guidanceFor(assessed, tools) {
  if (assessed?.available !== true) return ''
  return buildGuidance({ root: assessed.root, tools })
}

/**
 * 拼一段「这个工作区能跑 MC，工具怎么用」的提示词。
 *
 * @param options.root 已确认可运行的 Gradle 根目录（绝对路径）。
 * @param options.tools 本次真正暴露给模型的工具名列表。
 * @returns 提示词正文；没有任何可说的工具时返回空串（调用方据此跳过注入）。
 */
export function buildGuidance(options) {
  const root = typeof options?.root === 'string' ? options.root : ''
  const enabled = new Set(Array.isArray(options?.tools) ? options.tools : [])
  const bullets = []

  if (enabled.has('mc_run_task')) {
    bullets.push(
      '- `mc_run_task` 起一次 run* 任务，立刻返回 job id；`mc_run_output` 读它的增量输出，'
      + '`mc_run_kill` 取消它（连同游戏进程整棵树）。',
    )
    bullets.push(
      '- 任务同时出现在会话右上角的 MC Gradle 工具栏，模型起的会带 `AI` 标记；'
      + '点那一行就能在右侧栏打开它的实时日志。需要用户自己盯着长输出时让他点那里，'
      + '不要把整段日志复述进对话。',
    )
  }
  if (enabled.has('mc_run_list')) {
    bullets.push('- `mc_run_list` 列出本会话起的任务。')
  }
  if (enabled.has('mc_send_command')) {
    bullets.push(
      '- `mc_send_command` 把一行内容送进正在运行的游戏：`/` 开头的按命令执行'
      + '（如 `/time set day`），其余按聊天发送。',
    )
    bullets.push(
      '- 发送是单向的：工具返回只说明内容已写进游戏进程。真正的回执是任务输出里的'
      + ' `[mc-console] ...` 行；没看到回执就不要断言命令生效了。',
    )
    bullets.push(
      '- 只有 runClient / runServer 的任务收得到命令，runData 是一次性批处理。'
      + '客户端还没进世界时命令无处执行，工具会明确报错，不会静默丢弃。',
    )
  }

  if (bullets.length === 0) return ''
  const title = root.length > 0
    ? `## Minecraft Gradle 运行（${root}）`
    : '## Minecraft Gradle 运行'
  return [
    title,
    '',
    '本工作区是可运行的 Minecraft 项目，相关工具已启用：',
    ...bullets,
  ].join('\n')
}
