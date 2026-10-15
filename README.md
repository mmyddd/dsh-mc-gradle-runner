# dsh-mc-gradle-runner

**在 DeepSeek Harness 里一键跑 Minecraft 的 `runClient` / `runData`，并且让模型自己会用。**

写 Minecraft 模组最烦的两件事：改完代码要切回 IDEA 点运行，数据生成完了要自己 `git diff` 看产物变了什么。这个插件把这两件事都搬进 DSH：

- 聊天窗口**右上角多出一组 run\* 按钮**，长得和 IDEA 的运行按钮一个习惯——不用切窗口，点一下就跑；
- 模型**自己也能起任务**，跑完 `runData` 会**自动把产物 diff 摆到你面前**，跑了 `runClient` 如果崩了会**把崩溃报告摘要递过来**。

对任意 Gradle 的 MC 项目都能用：Forge、NeoForge、Fabric Loom、Architectury，单模块、多模块 monorepo 都行。不绑定某个仓库。

---

## 它长什么样

```
┌────────────────────────────────────────────────────────────┐
│  ◀ 会话                              ▶ Client  ▶ Data  ▾  │  ← 右上角，排在所有控件最左边
└────────────────────────────────────────────────────────────┘
```

| 按钮 | 做什么 |
| --- | --- |
| **▶ Client** | 跑 `runClient`，直接把游戏窗口拉起来 |
| **▶ Data** | 跑 `runData`，产物有变化就弹 diff |
| **■** | 停止。**真的停干净**——连 Gradle daemon 拉起的游戏进程一起带走 |
| **▾** | 切目标（多模块项目里换子模块）、看运行状态、从 Gradle 刷新任务列表 |

按钮**只在认出这是个 MC 项目时才出现**。打开一个普通的 Java 库、或压根不是 Gradle 的目录，界面上什么都不会多——不会有一排点不动的假按钮。

### 为什么停止按钮值得单说

默认的 `gradlew runClient` 会把构建交给一个**长命 Gradle daemon**，而 daemon 随后会被系统重新挂到别的父进程下。结果是：游戏进程**根本不在你启动的那个进程树里**，`taskkill /T` 够不到它，你点了关闭，游戏窗口还留在那儿。

这个插件默认加 `--no-daemon`，让整条链（wrapper → java → 游戏）都在自己的进程树内，关闭就是真关闭。实测对比（同一套项目，只差这一个参数）：

| | 游戏在进程树内 | 点关闭后游戏还活着 |
| --- | --- | --- |
| 默认 | ❌ | **是** |
| `--no-daemon` | ✅ | 否 |

代价是每次冷启动一个 JVM——对本来就要跑几十秒的 MC 项目来说可以忽略。想换回去就改 `daemonMode`。

---

## 装

需要 DeepSeek Harness（desktop profile）与一个能跑的 Gradle MC 项目。

```powershell
# 1) 链接进 profile 的 node_modules
#    别用 pnpm 的 file: 依赖——它会**拷贝**一份，之后你改插件源码不会同步，
#    开发时会被"明明改了却没生效"坑很久（这个坑我踩过）。
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$link = "$profile\node_modules\dsh-mc-gradle-runner"
Remove-Item $link -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Junction -Path $link -Target 'C:\Git\dsh-mc-gradle-runner'

# 2) 告诉 profile 用这个 bundle（$profile\package.json）
#      dependencies:        "dsh-mc-gradle-runner": "file:C:/Git/dsh-mc-gradle-runner"
#      dsh.profile.bundles: 追加 "dsh-mc-gradle-runner"

# 3) 挂载（$profile\cordis.patch.yml）
#      - id: mc-gradle-runner
#        name: dsh-mc-gradle-runner
```

改完重开 DSH，或在插件管理里把 `mc-gradle-runner` 关掉再打开即可热重载。

> 上面第 1 步的 `-Target` 换成你的实际插件目录；第 2、3 步里的路径同理。

---

## 用

### 手动：点按钮

打开任意会话，右上角就有。第一次点 `Client` 之前的探测要几百毫秒。

### 让模型来：`mc_run_*` 工具

```
你：帮我把数据重新生成一下，看看产物变了什么
```

模型会调 `mc_run_task { kind: "data" }`，后台跑，跑完自动拿到 diff——**而且它看到的就是你能看到的那张 diff 卡片**。

四个工具：

| 工具 | 用途 |
| --- | --- |
| `mc_run_task` | 起任务。`kind` 可以是 `client` / `data` / `server`，也可以直接给完整任务名如 `:modules:CTPP:runClient` |
| `mc_run_output` | 读输出。`wait: true` 就阻塞等它跑完 |
| `mc_run_list` | 现在有哪些任务在跑 |
| `mc_run_kill` | 停掉 |

任务全程在后台，**不阻塞前台**——你在它跑的时候还能继续聊。

**不想让模型碰这些？** 在设置里把「向模型暴露工具」关掉，按钮照常能用。

### `runData` 之后你会看到什么

不是干巴巴一句"文件变了"，而是三层：

1. **总量** —— 新增 3、修改 7、删除 1
2. **按类目分组** —— `lang` / `recipes` / `tags` / `models` / `loot` …… 一眼看出这次动的是哪块
3. **逐个文件** —— 带**真实增删行数**（`+4/-2`）和实际改动内容，不是笼统的行数对比

底下还垫了一条 `git status` 补充来源，产物目录之外的手改文件也不会漏。

### `runClient` 崩了

不用去翻日志。插件会认出崩溃报告，把**路径 + 描述 + 异常 + 栈顶 + 可疑 mod** 一起交出来。模型直接就能开始分析，而不是对着"退出码 1"发呆。

---

## 认路径这件事

多模块 MC 项目里"哪个才是可运行的目标"经常没那么显然。插件的发现来源**按可信度分级**：

```
Gradle 自己报的任务清单  >  IDEA 运行配置(.run/)  >  IDEA 项目结构(.idea/)  >  自己解析 settings.gradle
```

不硬编码任何路径。它读你项目里已有的 `gradlew` / `settings.gradle` / `.idea` / `.run`，所以不管你是上百个子模块的大整合包，还是自己写的小模组，都能自己找对地方。

顺带一个实际遇到过的问题：有些项目里子模块**自带一份只声明 `pluginManagement` 的 `settings.gradle`**，朴素的"往上找最近的 settings.gradle"会停在那儿、把任务名的 `:modules:XXX:` 前缀丢掉。这里改用**打分**（有 wrapper、settings 里有 `include`、有 build 脚本）再取分最高且最靠上的那个目录，就不会被带偏。

---

## 设置

在 **设置 → 插件配置 → dsh-mc-gradle-runner** 里改，改完即时生效，不用重启。

最常用的几个：

| 开关 | 默认 | 说明 |
| --- | --- | --- |
| 启用插件 | 开 | 总闸。关掉后按钮和工具都不出现 |
| 显示快捷按钮 | 开 | 右上角那组 run\* 按钮 |
| 向模型暴露工具 | 开 | 关掉后模型看不到 `mc_run_*`，按钮照常 |
| Gradle daemon | `no-daemon` | 改成 `daemon` 启动更快，但关闭按钮会留下游戏进程 |
| 同名任务策略 | `reject` | 已在跑同名任务时：拒绝 / 复用 / 替换 / 允许并存 |
| Gradle 根目录 | 自动 | 需要时手动指定 |
| 每个 diff 展示的行数 | 40 | 嫌 diff 太长就调小 |

<details>
<summary>全部 19 个配置项</summary>

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `showButtons` | `true` | 是否显示快捷按钮 |
| `exposeTools` | `true` | 是否把工具暴露给模型 |
| `enabledTools` | 全部 | 只暴露列出的工具 |
| `gradleRoot` | 自动发现 | 强制指定 Gradle 根 |
| `daemonMode` | `no-daemon` | `no-daemon` / `daemon` |
| `duplicatePolicy` | `reject` | 同名任务并发策略 |
| `allowGradleTaskQuery` | `true` | 允许从菜单触发 `gradlew tasks`（一次约 7–9 秒，会缓存） |
| `dataDirs` | 内置四路径 | 产物目录覆盖 |
| `maxDiffFiles` | `40` | diff 最多展开的文件数 |
| `diffHunkLines` | `40` | 每个文件展示多少行改动 |
| `diffMaxBytes` | `524288` | 单文件参与 diff 的字节上限 |
| `snapshotTextBudgetBytes` | `67108864` | 快照保留旧内容的累计上限（64 MB） |
| `outputLimitBytes` | `4194304` | 单任务内存输出上限 |
| `dataTimeoutMs` | `120000` | runData 后收集 diff 的等待上限 |
| `taskQueryCacheMs` | `300000` | 任务清单缓存时长 |
| `taskQueryTimeoutMs` | `180000` | 任务清单查询超时 |
| `gitBin` | `git` | git 可执行文件 |
| `buttonOrder` | `-100` | 按钮排序，越小越靠左 |

</details>

---

## 出问题的时候

| 现象 | 大概是什么 |
| --- | --- |
| 右上角没有按钮 | 当前会话的工作目录不在 MC 项目里。或插件被总闸关了 |
| 按钮在、点了没反应 | 多半是 wrapper 找不到——结果里会说明，并提示 PATH 上的 `gradle` |
| 关了任务游戏还在 | 检查 `daemonMode` 是不是被改成了 `daemon` |
| `runData` 说"没有产物变更" | 数据生成结果真的和启动前一致。也可能产物目录不在默认四个路径里，用 `dataDirs` 指定 |
| 崩了但没给报告 | 插件只认"新写出来的"报告——目录里堆着的历史崩溃不会被翻出来当成本次的 |
| 任务在跑，又点了一次 | 默认拒绝并告诉你已有的任务 id，改 `duplicatePolicy` 可换行为 |
| 改了插件源码没生效 | 用了 pnpm 的 `file:` 依赖而不是 junction。见上面安装说明 |

---

## 开发

```powershell
cd C:\Git\dsh-mc-gradle-runner
node test/run-all.mjs          # 全部用例
node test/run-all.mjs client   # 只跑名字含 "client" 的
```

用例在 `test/`，每个文件独立进程跑，互不影响。包含几条真跑 Gradle 的端到端链路：造一个真会崩的 `runClient` 验证崩溃摘要、造一个真改文件的 `runData` 验证 diff 内容正确性、造一条父子进程链验证关闭按钮能把孙子进程也带走。

`test/test-discovery.mjs`、`test-gradle-e2e.mjs`、`test-gradle-paths.mjs` 需要一个**真实的** MC 项目才跑得起来，没给路径时打印 `SKIP` 跳过（这是设计如此，不是失败）：

```powershell
node test/test-discovery.mjs C:\path\to\your\mc\project
# 或设环境变量，三个脚本都会用
$env:MC_TEST_PROJECT = 'C:\path\to\your\mc\project'
node test/run-all.mjs
```

源码在 `lib/`：`index.js`（主机半身：工具 + API 路由）、`client.js`（浏览器半身：按钮 + 设置页）、`discovery.js`（项目与目标发现）、`proc.js`（进程与任务注册表）、`diff.js`（产物快照与 diff）、`crash.js`（崩溃报告识别）。

## License

MIT
