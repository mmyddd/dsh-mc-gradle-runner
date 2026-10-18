/**
 * 把「这个工作区能不能跑 MC」的裁决接进系统提示词。
 *
 * 两条硬约束决定了这里的形状：
 *
 *   1. **判据必须和按钮完全一样**。按钮显隐读的是 `/api` 的 targets 分支，
 *      而那条分支走的是 `resolveRoot` + `assessRoot`。这里也走同样两步，
 *      于是「界面上没有按钮、提示词里却说工具可用」这种自相矛盾不可能出现。
 *      用户明确要求过这一点（同一套要求），所以任何一处另起炉灶都算 bug。
 *
 *   2. **必须能 await**。`ctx.systemPrompt.section()` 的 text 是同步求值
 *      （见 packages/core/system-prompt/src/index.ts 的 assemble：
 *      `typeof section.text === 'function' ? section.text(context) : section.text`），
 *      而 assessRoot 要读文件系统。同步分节只能读缓存，会漏掉会话第一轮；
 *      所以这里改成在 `system-prompt/assemble` 这个**异步** waterfall 之后补分节。
 *
 * assessRoot 每个模型步骤都会被问一次，而它要读 IDEA 配置、settings.gradle、
 * 逐个项目的 build.gradle，不能每次都真扫。因此按 cwd 缓存结论（含 in-flight
 * 去重），TTL 内直接复用。
 *
 * @module dsh-mc-gradle-runner/prompt
 */

import { GUIDANCE_SECTION_NAME, guidanceFor } from './guidance.js'

/** 默认缓存时长：足够覆盖一次任务的多步对话，又不至于让新建的构建脚本长期不被发现。 */
export const DEFAULT_TTL_MS = 30_000

/** 缓存条目上限。cwd 通常只有个位数，这里只是防止异常调用把内存撑爆。 */
const MAX_ENTRIES = 32

/**
 * 造一个「按会话 cwd 生成提示词正文」的 provider。
 *
 * @param options.config 已解析的插件配置（提供 gradleRoot 等覆盖项）。
 * @param options.resolveRoot 与 HTTP 路由共用的根解析函数。
 * @param options.assessRoot 与 HTTP 路由共用的可用性裁决函数。
 * @param options.tools 本次真正暴露给模型的工具名。
 * @param options.ttlMs 缓存时长。
 * @returns `{ textFor(cwd), clear() }`；`textFor` 永远 resolve 成字符串（失败时是空串）。
 */
export function createGuidanceProvider(options) {
  const { config, resolveRoot, assessRoot, tools } = options
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS
  /** cwd → `{ at, promise }`。promise 而非结果：并发的多个 assembly 共用一次扫描。 */
  const cache = new Map()

  const compute = async (cwd) => {
    try {
      // 与 handleApi 的 targets 分支同样的两步：先定根，再裁决。
      const root = resolveRoot(config, cwd, undefined)
      const assessed = await assessRoot(root)
      return guidanceFor(assessed, tools)
    } catch {
      // 提示词拼装失败绝不能连累整个 assembly：宿主那边会因为它抛错而
      // 拿不到任何系统提示词，模型连基本指令都没有。宁可这次不注入。
      return ''
    }
  }

  return {
    /**
     * @param cwd 会话工作目录；未知时传 undefined（与 HTTP 侧一致地退回进程 cwd）。
     * @returns 提示词正文，可能为空串。
     */
    textFor(cwd) {
      const key = typeof cwd === 'string' && cwd.length > 0 ? cwd : ''
      const now = Date.now()
      const hit = cache.get(key)
      if (hit !== undefined && now - hit.at < ttlMs) return hit.promise
      if (cache.size >= MAX_ENTRIES) cache.clear()
      const entry = { at: now, promise: compute(key.length > 0 ? key : undefined) }
      cache.set(key, entry)
      return entry.promise
    },
    /** 丢掉全部缓存。改了配置或刚跑完一次任务后想立刻重判时用。 */
    clear() {
      cache.clear()
    },
  }
}

/**
 * 在 `system-prompt/assemble` 之后补一段 MC 运行说明。
 *
 * 放在 waterfall 的「之后」而不是「之前」，是因为要先把别的分节原样拿到手，
 * 再决定加不加自己这段——`next()` 的返回值才是权威结果。
 *
 * @param ctx cordis 上下文（用来挂监听，随插件一起卸载）。
 * @param provider `createGuidanceProvider` 的返回值。
 * @returns 是否挂上了监听。
 */
export function installGuidance(ctx, provider) {
  if (typeof ctx?.on !== 'function') return false
  // 同名分节只补一次：万一宿主把监听回调跑了两遍（或插件被重复 apply），
  // 重复分节会让 renderPrompt 里出现两段一样的说明。
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const inherited = await next()
    try {
      const cwd = context?.agent?.session?.header?.cwd
      const text = await provider.textFor(cwd)
      if (text.length === 0) return inherited
      if (inherited.sections.some((one) => one.name === GUIDANCE_SECTION_NAME)) return inherited
      // 顺序在 canonical 排序之后已定稿，这里只能追加到末尾；
      // 工具指引的 order 约定是 100–199，末尾同样落在正文靠后的位置。
      return {
        ...inherited,
        sections: [...inherited.sections, { name: GUIDANCE_SECTION_NAME, text }],
      }
    } catch {
      return inherited
    }
  })
  return true
}
