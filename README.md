# dsh-mc-gradle-runner

**在 DeepSeek Harness 里一键跑 Minecraft 的 `runClient` / `runData`，并且让模型自己会用。**

写 Minecraft 模组最烦的两件事：改完代码要切回 IDEA 点运行，数据生成完了要自己 `git diff` 看产物变了什么。这个插件把这两件事都搬进 DSH：

- 聊天窗口**右上角多出一组 run\* 按钮**，长得和 IDEA 的运行按钮一个习惯——不用切窗口，点一下就跑；
- 模型**自己也能起任务**，跑完 `runData` 会**自动把产物 diff 摆到你面前**，跑了 `runClient` 如果崩了会**把崩溃报告摘要递过来**。

对任意 Gradle 的 MC 项目都能用：Forge、NeoForge、Fabric Loom、Architectury，单模块、多模块 monorepo 都行。不绑定某个仓库。

---

## 它长什么样

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◀ 会话     ▣ CTNH-Core - Client ▾  ▶  ■  ⋮   ▶ 1:24  │  ← 右上角，排在所有控件最左边
└──────────────────────────────────────────────────────────────────────┘
```

版式照着 IDEA 的运行工具条来：

| 控件 | 做什么 |
| --- | --- |
| **▣ Client ▾** | 运行配置选择器。列出这个项目里所有 run\* 任务（多模块项目会带 `模块 - 类型` 名字），也可以在这里从 Gradle 刷新任务清单 |
| **▶ 绿键** | 跑当前选中的配置。**跑过一次就变成循环箭头 ⟳**，表示再点是"重新运行"；取消过一次则退回三角 |
| **■ 红键** | 停止。**真的停干净**——连 Gradle daemon 拉起的游戏进程一起带走 |
| **⋮** | 更多操作：重开日志面板、从 Gradle 刷新任务列表、看项目根与来源 |
| **▶ 1:24** | 有任务时贴一行状态：运行中（带耗时）/ 完成 / 失败 / 已取消 |

按钮**只在认出这是个 MC 项目时才出现**。打开一个普通的 Java 库、或压根不是 Gradle 的目录，界面上什么都不会多——不会有一排点不动的假按钮。

点绿键之后，右侧栏会**自动开一个日志页签**，输出实时滚进来；同一个会话始终复用一个页签，不会越跑越多。

### 为什么停止按钮值得单说

默认的 `gradlew runClient` 会把构建交给一个**长命 Gradle daemon**，而 daemon 随后会被系统重新挂到别的父进程下。结果是：游戏进程**根本不在你启动的那个进程树里**，`taskkill /T` 够不到它，你点了关闭，游戏窗口还留在那儿。

这个插件默认加 `--no-daemon`，让整条链（wrapper → java → 游戏）都在自己的进程树内，关闭就是真关闭。实测对比（同一套项目，只差这一个参数）：

| | 游戏在进程树内 | 点关闭后游戏还活着 |
| --- | --- | --- |
| 默认 | ❌ | **是** |
| `--no-daemon` | ✅ | 否 |

代价是每次冷启动一个 JVM——对本来就要跑几十秒的 MC 项目来说可以忽略。想换回去就改 `daemonMode`。

按下停止之后，Windows 上是**直接强杀整棵树**，没有温和终止的过渡期：那个系统调用在这里本来就不起作用（`taskkill` 不带 `/F` 对 `java.exe` 发不出可信的关闭请求），留着 5 秒宽限只会让人盯着「正在停止」干等。实测从点下到游戏进程消失约 **0.2 秒**。macOS / Linux 仍走 `SIGTERM` → 5 秒宽限 → `SIGKILL`，因为那边信号是可信的，留时间让游戏正常收尾。

---

## 装

需要 DeepSeek Harness（desktop profile）与一个能跑的 Gradle MC 项目。

打开 **设置 → 插件 → 添加插件**，在「包名或地址」输入框里粘贴仓库地址：

```
https://github.com/mmyddd/dsh-mc-gradle-runner
```

点安装即可。装好之后：

- 会话头部右上角出现 run* 按钮（只在真正的 MC 项目里出现）；
- 设置 →「插件配置」→ `dsh-mc-gradle-runner` 里出现本插件的开关。

升级同样在插件管理里操作，重新拉一次这个地址就行。

> 开发时想让改源码立刻生效，就把插件目录换成 junction 指到本地仓库，
> 别用 pnpm 的 `file:` 依赖——它会**拷贝**一份，之后你改的代码不会同步，
> 会被"明明改了却没生效"坑很久（这个坑我踩过）。

---

## 用

### 手动：点按钮

打开任意会话，右上角就有。第一次点 `Client` 之前的探测要几百毫秒。

### 右侧栏的实时日志

点绿键就会自动把右侧栏的日志页签打开，`gradlew` 的输出边跑边进。它不只是"看"：

- **运行中自动跟随**（你手动往上滚就不抢你的滚动条）；
- **彩色分档**：普通构建输出、失败行、Gradle 的进度噪声视觉上能分开；
- 跑完把 `runData` 的产物 diff、`runClient` 的崩溃摘要直接贴在日志下面；
- 底部有**命令输入框**，`runClient` 和 `runServer` 都能用。

**命令怎么进游戏——分两段。** 第一段是把面板的管道接到游戏进程：Gradle 的 `JavaExec` 默认**不转发标准输入**，插件启动时用 `-I` 注入自带的初始化脚本（`lib/stdin-init.gradle`），给所有 `JavaExec` 接上 `standardInput = System.in`。不改你的构建脚本，任何 MC 项目都能用，关掉 `forwardStdin` 就退化成纯日志。

第二段才是关键：**光转发没用，客户端根本不读 stdin**。Minecraft 1.20.1 源码里全库只有 `DedicatedServer` 一处读 `System.in`（服务端控制台线程，Forge 再套一层 JLine 的 `TerminalHandler`）；`net/minecraft/client/**` 下**没有任何一处**读 stdin——字节到了游戏 JVM 也会原地消失。所以插件在 `runClient` 上再挂一个 `-javaagent`（`lib/console-bridge/`），由它在游戏 JVM 里补上缺失的读线程：

- 以 `/` 开头 → `ClientPacketListener.sendCommand`（如 `/time set day`）
- 其余 → `sendChat`（发一条聊天消息）
- 全程只用反射、不 import 任何 Minecraft 类，因此不绑定 MC 版本与映射（Mojmap / SRG 名字都认）；类从 `Instrumentation.getAllLoadedClasses()` 里找，能跨 NeoForge 的转换类加载器
- 游戏还没启动完就敲了命令不会丢——桥会等客户端实例，先排队的命令随后执行

执行回执打在日志里，形如 `[mc-console] 已交给客户端：time set day` / `[mc-console] 尚未进入世界，命令无处执行`。看到回执才代表真的进了游戏。

> 这条链路依赖 `--no-daemon`：长命 daemon 的 `System.in` 不是我们这条管道。
> 所以把 `daemonMode` 改成 `daemon` 之后，命令输入框基本就没用了。

**服务端不挂桥**：`runServer` 本来就有 JLine 在读同一个 stdin，再挂一个读者只会两边抢行、命令随机丢一半。

**桥的 jar 是随插件发布的**（`lib/console-bridge/mc-console-bridge.jar`，约 6 KB）。万一你的安装里缺了它，输入框会被明确禁用并提示怎么补，而不是敲完回车弹一句"已发送"、实际什么都没发生。自己编译：`node lib/console-bridge/build.mjs`（需要 JDK 17+，会自动找 `JAVA_HOME` 或 PATH 里的 `javac`）。

### 让模型来：`mc_run_*` 工具

```
你：帮我把数据重新生成一下，看看产物变了什么
```

模型会调 `mc_run_task { kind: "data" }`，后台跑，跑完自动拿到 diff——**而且它看到的就是你能看到的那张 diff 卡片**。

模型起的任务也进同一个工具栏和同一个日志页签：右上角那行状态会带一个 `AI` 标记并显示已跑多久，**点它就打开这个任务的实时日志**；日志页签顶部的下拉框里同样能看到 `[AI]` 前缀的任务。所以模型在后台起了一个 `runClient`、游戏窗口弹出来的时候，你不会只看到"游戏莫名其妙起来了"——状态和日志都在你能点到的位置。来源标记只影响展示，不改变任务的归属隔离。

五个工具：

| 工具 | 用途 |
| --- | --- |
| `mc_run_task` | 起任务。`kind` 可以是 `client` / `data` / `server`，也可以直接给完整任务名如 `:modules:CTPP:runClient` |
| `mc_run_output` | 读输出。`wait: true` 就阻塞等它跑完 |
| `mc_run_list` | 现在有哪些任务在跑 |
| `mc_run_kill` | 停掉 |
| `mc_send_command` | 往正在跑的游戏里发一行：`/` 开头按命令执行（如 `/time set day`），其余按聊天发送 |

`mc_send_command` 是日志面板底部那个输入框的模型侧等价物，所以它同样只对 `runClient` / `runServer` 成立。它写完会短暂等一等游戏侧的回执并一起返回；没等到回执时它只会说"还没确认"，不会替你断言命令生效了——原因见上面那段"命令怎么进游戏"。

**工作区确实是可运行的 MC 项目时**（判定与"是否显示按钮"完全同一套：有 Gradle 构建脚本且发现了 `run*` 任务），插件还会往系统提示词里加一小段，告诉模型这几个工具怎么配合、以及"发送成功 ≠ 执行成功"。工作区不对时那段话不会出现，模型也就不会去调注定失败的工具。

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
<summary>全部 20 个配置项</summary>

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
| `outputLimitBytes` | `4194304` | 单任务内存输出上限（字节，主机侧） |
| `logTailLines` | `500` | 右侧栏日志只显示最后 N 行，多余丢弃；调大更完整但更吃内存 |
| `dataTimeoutMs` | `120000` | runData 后收集 diff 的等待上限 |
| `taskQueryCacheMs` | `300000` | 任务清单缓存时长 |
| `taskQueryTimeoutMs` | `180000` | 任务清单查询超时 |
| `gitBin` | `git` | git 可执行文件 |
| `forwardStdin` | `true` | 用 `-I` 注入脚本把 stdin 转发给游戏 JVM；关掉则控制台命令到不了游戏（输入框会明确禁用并说明是这个开关） |
| `buttonOrder` | `-100` | 按钮排序，越小越靠左 |

</details>

---

## 出问题的时候

| 现象 | 大概是什么 |
| --- | --- |
| 右上角没有按钮 | 当前会话的工作目录不在 MC 项目里。或插件被总闸关了 |
| 按钮在、点了没反应 | 多半是 wrapper 找不到——结果里会说明，并提示 PATH 上的 `gradle` |
| 右侧栏没有日志页签 | 页签在**点绿键之后**才创建；也可以从 `⋮` 菜单里手动「打开日志面板」 |
| 命令输进去了游戏没反应 | `forwardStdin` 被关了，或 `daemonMode` 改成了 `daemon`；也可能是项目自己覆盖了 `standardInput` |
| 关了任务游戏还在 | 检查 `daemonMode` 是不是被改成了 `daemon` |
| `runData` 说"没有产物变更" | 数据生成结果真的和启动前一致。也可能产物目录不在默认四个路径里，用 `dataDirs` 指定 |
| 崩了但没给报告 | 插件只认"新写出来的"报告——目录里堆着的历史崩溃不会被翻出来当成本次的 |
| 任务在跑，又点了一次 | 默认拒绝并告诉你已有的任务 id，改 `duplicatePolicy` 可换行为 |
| 改了插件源码没生效 | 装的是拷贝而不是 junction。见上面安装说明 |

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

源码在 `lib/`：`index.js`（主机半身：工具 + API 路由）、`client.js`（浏览器半身：工具栏 + 日志页签 + 设置页）、`discovery.js`（项目与目标发现）、`proc.js`（进程与任务注册表）、`diff.js`（产物快照与 diff）、`crash.js`（崩溃报告识别）、`bridge.js`（控制台桥的定位与"这个任务能不能发命令"的判定）、`command.js`（发送命令：选哪个任务写、回执归谁）、`guidance.js`（提示词里那段 MC 工具说明的文案）、`prompt.js`（把那段说明挂进系统提示词，带按 cwd 的短缓存）、`stdin-init.gradle`（注入给 JavaExec 的 stdin 转发 + javaagent 挂载脚本）、`console-bridge/`（游戏 JVM 里的读 stdin 代理：`ConsoleBridge.java` 源码、`build.mjs` 编译脚本、随包发布的 `mc-console-bridge.jar`）。

## License

MIT
