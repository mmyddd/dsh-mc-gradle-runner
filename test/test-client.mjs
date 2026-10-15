// 客户端 bundle 契约验证：在模拟的 __ModuleLoader__ 环境里加载 lib/client.js，
// 确认它能注册到正确的槽位、order 最小、并渲染出 runClient / runData 按钮。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failures = 0
function check(label, condition, extra) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`[${mark}] ${label}${extra !== undefined ? ` — ${extra}` : ''}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

// ---- 用极简 React 桩模拟客户端运行时 ----
// 只要够驱动 createElement + hooks 就行，不需要真实渲染器。
const hookState = { values: [], cursor: 0 }
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
  },
  Fragment: Symbol('Fragment'),
  memo: (component) => component,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useState(initial) {
    const index = hookState.cursor++
    if (!(index in hookState.values)) {
      hookState.values[index] = typeof initial === 'function' ? initial() : initial
    }
    return [hookState.values[index], (next) => { hookState.values[index] = next }]
  },
  useEffect: () => {},
  createContext: () => ({ Provider: null, Consumer: null }),
}
reactStub.default = reactStub

let loaded = undefined
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
  },
}

// ---- 加载 bundle ----
// 客户端模块表的种子词里有 UI primitives，配置卡要从它取表单部件。
// 这里给一个最小桩：只要 SettingsForm/SettingsFormModel 与两个 field spec 工厂存在即可。
const primitivesStub = {
  SettingsForm: function SettingsForm() {},
  SettingsFormModel: class SettingsFormModel {
    constructor(scope, specs) {
      this.scope = scope
      this.specs = specs
      this.staged = new Map()
    }
    subscribe() { return () => {} }
    bind(project) {
      this.projected = project()
      return { getSnapshot: () => project(), subscribe: () => () => {}, set: () => {} }
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    field(name) { return { text: '', overridden: false, invalid: false, name } }
    actions() {
      return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} }
    }
    dispose() {}
  },
  SettingsValueField: function SettingsValueField() {},
  Switch: function Switch() {},
  settingsTextField: (field) => ({ field, format: (v) => (typeof v === 'string' ? v : ''), parse: (t) => ({ kind: 'set', value: t }) }),
  settingsNumberField: (field) => ({ field, format: (v) => (typeof v === 'number' ? String(v) : ''), parse: (t) => ({ kind: 'set', value: Number(t) }) }),
}

const modules = {
  react: reactStub,
  'react/jsx-runtime': { jsx: reactStub.createElement },
  '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
}
new Function('window', 'require', source)(globalThis.window, (id) => {
  if (!(id in modules)) throw new Error(`意外的外部依赖：${id}`)
  return modules[id]
})

check('bundle 调用了 __ModuleLoader__.load', loaded !== undefined)
check('bundle id 正确', loaded?.id === 'dsh-mc-gradle-runner', loaded?.id)
check('factory 是函数', typeof loaded?.factory === 'function')

const exports = loaded.factory((id) => {
  if (!(id in modules)) throw new Error(`意外的外部依赖：${id}`)
  return modules[id]
})
check('导出 name', exports.name === 'mc-gradle-runner', exports.name)
check('导出 apply 函数', typeof exports.apply === 'function')
check('导出 inject 只含 slots', Array.isArray(exports.inject) && exports.inject.length === 1 && exports.inject[0] === 'slots',
  JSON.stringify(exports.inject))

// ---- 模拟 slots / configForms / primitives，捕获注册 ----
const registrations = []
const injections = []
// 配置项的 id 换成别的就会让表单拿不到数据，这里故意用错值验证客户端确实用了正确 id。
const formScopes = []
const effects = []
const ctx = {
  inject(deps, callback) {
    injections.push(...deps)
    callback(ctx)
  },
  effect(callback, label) {
    effects.push(label)
    return () => {}
  },
  slots: {
    inject(slotName, callback) {
      injections.push(slotName)
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
    },
  },
  configForms: {
    get(entryId) {
      formScopes.push(entryId)
      return {
        subscribe: () => () => {},
        getSnapshot: () => ({ status: 'ready', writable: true, revision: 1 }),
        mutate: async () => true,
      }
    },
  },
}
exports.apply(ctx)

check('对 conversation.session.header.utilities 做了 inject',
  injections.includes('conversation.session.header.utilities'), JSON.stringify(injections))
// 现在会注册两个槽位：会话头部工具栏 + 插件配置页表单。
check('注册了两个槽位组件', registrations.length === 2, String(registrations.length))

const reg = registrations[0]
check('注册槽位是会话头部右上角控件组',
  reg?.options?.name === 'conversation.session.header.utilities', reg?.options?.name)
check('cell id 是 mc-gradle-runner', reg?.options?.id === 'mc-gradle-runner', reg?.options?.id)

// 关键验收点：必须排在所有既有控件的最左端。
// 实测该槽位现有占用者的 order 为 -10 / -5 / 0 / 10 / 100，最小是 -10。
const EXISTING_ORDERS = [-10, -5, 0, 0, 10, 10, 100]
const order = reg?.options?.order
check('order 是数字', typeof order === 'number', String(order))
check(`order (${order}) 小于所有既有控件的最小 order (${Math.min(...EXISTING_ORDERS)})`,
  typeof order === 'number' && order < Math.min(...EXISTING_ORDERS))

// ---- 插件配置页：这是“设置里找不到开关”那轮反馈的验收点 ----
// 两个 id 必须分别正确，混用会让整段配置区或表单数据其一失效。
const settingsReg = registrations.find((entry) => entry.options?.name === 'plugins.bundle.config')
check('注册了 plugins.bundle.config 槽位', settingsReg !== undefined)
check('槽位 key 是 npm 包名（否则整段配置区不渲染）',
  settingsReg?.options?.key === 'dsh-mc-gradle-runner', settingsReg?.options?.key)
check('configForms.get 用的是 loader 条目 id',
  formScopes.includes('mc-gradle-runner'), JSON.stringify(formScopes))
check('未把包名误当成表单 namespace', !formScopes.includes('dsh-mc-gradle-runner'), JSON.stringify(formScopes))
check('通过嵌套 inject 拿 configForms（缺服务时按钮不会跟着消失）',
  injections.includes('configForms'), JSON.stringify(injections))
check('配置表单注册了 dispose 清理',
  effects.some((label) => typeof label === 'string' && label.includes('config form')), JSON.stringify(effects))

// 槽位 inject 必须给出 hooks 供组件取状态；组件能渲染 page 视图。
const injectFace = settingsReg?.options?.inject()
check('槽位 inject 暴露 hooks.mcRunSettings', injectFace?.hooks?.mcRunSettings !== undefined)
check('表单模型绑定了字段快照', injectFace?.hooks?.mcRunSettings?.getSnapshot !== undefined)

const settingsCard = settingsReg?.component
check('配置卡是函数组件', typeof settingsCard === 'function')
if (typeof settingsCard === 'function') {
  hookState.cursor = 0
  hookState.values = []
  const pageNode = settingsCard({ view: 'page', useMcRunSettings: (selector) => selector(injectFace.hooks.mcRunSettings.getSnapshot()) })
  check('page 视图渲染出表单', pageNode !== null && pageNode !== undefined)
  hookState.cursor = 0
  hookState.values = []
  const summaryNode = settingsCard({ view: 'summary', useMcRunSettings: (selector) => selector(injectFace.hooks.mcRunSettings.getSnapshot()) })
  check('summary 视图返回一行摘要（不渲染表单）', summaryNode?.type === 'span', String(summaryNode?.type))
}

// 源码层面确认配置卡覆盖了各开关，且文案是中文。
for (const field of ['enabled', 'showButtons', 'exposeTools', 'allowGradleTaskQuery', 'daemonMode', 'duplicatePolicy', 'gradleRoot']) {
  check(`配置卡包含字段 ${field}`, source.includes(`"${field}"`))
}
check('配置卡用了官方表单部件', source.includes('SettingsFormModel') && source.includes('SettingsForm'))
check('取不到 primitives 时只警告不抛错', /catch \(error\) \{[\s\S]{0,200}配置页不可用/.test(source))

// ---- 渲染：验证按钮文案与可访问性 ----
// 组件内部会 fetch 目标列表，这里给一个可控的桩。
const apiCalls = []
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body)
  apiCalls.push(body)
  if (body.action === 'targets') {
    return {
      ok: true,
      json: async () => ({
        root: 'C:\\work\\ExamplePack',
        projects: [':modules:Example-Core'],
        targets: [
          { task: ':modules:Example-Core:runClient', kind: 'client', shortLabel: 'runClient', projectPath: ':modules:Example-Core' },
          { task: ':modules:Example-Core:runData', kind: 'data', shortLabel: 'runData', projectPath: ':modules:Example-Core' },
          { task: ':modules:Example-Core:runServer', kind: 'server', shortLabel: 'runServer', projectPath: ':modules:Example-Core' },
        ],
      }),
    }
  }
  return { ok: true, json: async () => ({ jobs: [] }) }
}
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }

// 首次渲染：probed=false，应返回 null（非 Gradle 会话不留痕迹）。
hookState.cursor = 0
hookState.values = []
const first = reg.component({ sessionId: 'session-test' })
check('探测完成前不渲染任何内容', first === null, String(first))

// 组件本身可调用，且不抛错即为契约成立。
check('组件可被 React 调用', typeof reg.component === 'function')

// ---- 可用性契约：available=false 时不得渲染任何东西 ----
// 这是需求“按钮只在发现有可用的 MC Gradle 时才显示”在客户端侧的落点。
// 组件的探测是异步的，所以直接检查源码里的门控条件与主机字段名，
// 再配合 test-config.mjs 里对主机 available 裁决的行为测试。
check('组件读取主机的 available 字段', source.includes('result.available'))
check('组件在 !available 时返回 null', /if \(!available\) return null/.test(source))
check('组件不再用 targets.length 自行判断可用性', !/if \(targets\.length === 0\)/.test(source))

// ---- 权威来源的 UI：必须能从菜单里触发 Gradle 任务查询 ----
check('组件调用 tasks 动作', source.includes('action: "tasks"'))
check('菜单提供“从 Gradle 刷新任务列表”入口', source.includes('从 Gradle 刷新任务列表'))
check('刷新期间显示加载态', source.includes('正在向 Gradle 查询'))
check('刷新失败时显示可读原因', source.includes('刷新失败，点击重试'))
check('菜单展示来源说明', source.includes('describeProvenance'))

// describeProvenance 必须只列有贡献的来源，且按可信度排序。
// 它依赖同作用域的 SOURCE_NAMES，所以两段一起取出来求值。
const provenanceFn = new Function(`
  ${source.slice(source.indexOf('const SOURCE_NAMES'), source.indexOf('function KindIcon'))}
  return describeProvenance;
`)()
check('describeProvenance 只列有贡献的来源',
  provenanceFn({ sources: { ideaRun: 11, settings: 16 } }) === 'IDEA 运行配置 11 · settings.gradle 解析 16',
  provenanceFn({ sources: { ideaRun: 11, settings: 16 } }))
check('describeProvenance 把 Gradle 排在最先',
  provenanceFn({ sources: { settings: 3, gradle: 31 } }).startsWith('Gradle 任务清单'),
  provenanceFn({ sources: { settings: 3, gradle: 31 } }))
check('describeProvenance 提醒 wrapper 缺失',
  provenanceFn({ sources: { idea: 2 }, hasWrapper: false }).includes('无 gradlew'),
  provenanceFn({ sources: { idea: 2 }, hasWrapper: false }))
check('describeProvenance 空来源安全', provenanceFn({ sources: {} }) === '无', provenanceFn({ sources: {} }))

console.log('')
console.log(failures === 0 ? 'ALL CLIENT TESTS PASSED' : `${failures} CLIENT TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
