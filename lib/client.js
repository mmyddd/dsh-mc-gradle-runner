// dsh-mc-gradle-runner 的浏览器半身：会话头部右上角的 IntelliJ 风格 run* 工具栏。
//
// 手写的 __ModuleLoader__ 工厂（无构建步骤）：外部 require 只用 react，
// 由加载器模块表提供；官方 UI primitives 存在时用来取图标，缺失时退回内联 SVG，
// 因此这个 bundle 不硬依赖任何包，换 profile 也能渲染。
//
// 挂载点：conversation.session.header.utilities —— 会话头部右上角的控件组。
// order 取 -100，小于当前占用者里最小的 -10（open-in-app），
// 因此本工具栏固定落在其余控件的最左端。
window.__ModuleLoader__.load({
	id: "dsh-mc-gradle-runner",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;
		const { useCallback, useEffect, useMemo, useRef, useState } = react;

		/** 插件名，同时是槽位里的 cell id。 */
		const name = "mc-gradle-runner";
		/**
		 * 只硬依赖槽位服务。
		 *
		 * 配置页用的 `configForms` 走嵌套的 `ctx.inject`，不放进这里：
		 * 这个数组里缺任何一个服务，整个客户端半身都不会 apply，
		 * 快捷按钮会跟着一起消失。
		 */
		const inject = ["slots"];
		/** 主机端路由，位于 Connection 的 /api 围栏内（Host/Origin + 浏览器鉴权）。 */
		const API_PATH = "/api/mc-gradle-runner";
		/** 未运行时轮询状态较慢，避免空转；有任务在跑时加快。 */
		const IDLE_POLL_MS = 15000;
		const BUSY_POLL_MS = 2000;
		/** 选择结果按会话记忆，刷新后仍在。 */
		const STORE_KEY = "dsh-mc-gradle-runner.selection";

		// ---- 主题令牌 ----
		// 颜色一律取令牌，不写死十六进制，让明暗主题自动跟随。
		const C = {
			label: "var(--dsw-alias-label-primary)",
			labelDim: "var(--dsw-alias-label-secondary)",
			idle: "var(--dsw-alias-state-idle-primary)",
			success: "var(--dsw-alias-state-success-primary)",
			error: "var(--dsw-alias-state-error-primary)",
			warn: "var(--dsw-alias-state-warn-primary)",
			brand: "var(--dsw-alias-brand-primary)",
			border: "var(--dsw-alias-border-l1)",
			borderStrong: "var(--dsw-alias-border-l2)",
			hover: "var(--dsw-alias-interactive-bg-hover)",
			menu: "var(--dsw-specific-menu, var(--dsw-alias-bg-overlay))",
			// 实心绿/红按钮上的白色图标。取令牌而不是写死 #fff，换主题时跟着变。
			solidForeground: "var(--dsw-alias-label-primary-foreground, #ffffff)",
		};

		/** 工具栏外壳：紧凑、右对齐、可换行，与相邻控件同一视觉高度。 */
		const ROOT_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			gap: 2,
			minWidth: 0,
		};

		/** 单个按钮：IDEA 那种紧凑的 24px 高、圆角 6px、无边框。 */
		function buttonStyle(extra) {
			return {
				boxSizing: "border-box",
				display: "inline-flex",
				alignItems: "center",
				gap: 4,
				height: 24,
				padding: "0 6px",
				border: "none",
				borderRadius: 6,
				background: "transparent",
				color: C.labelDim,
				font: "inherit",
				fontSize: 12,
				lineHeight: "24px",
				cursor: "pointer",
				whiteSpace: "nowrap",
				...(extra ?? {}),
			};
		}

		/** 分组之间的细分隔线，视觉上把 run 组和 stop 分开。 */
		const SEP_STYLE = {
			width: 1,
			height: 14,
			margin: "0 2px",
			background: C.border,
			flex: "0 0 auto",
		};

		/** 下拉面板：与原生菜单同一套观感。 */
		const MENU_STYLE = {
			position: "fixed",
			zIndex: 1100,
			minWidth: 220,
			maxHeight: "min(420px, 60vh)",
			overflowY: "auto",
			padding: 4,
			borderRadius: "var(--dsw-radius-lg, 12px)",
			background: C.menu,
			border: `0.5px solid ${C.border}`,
			boxShadow: "var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.18))",
			color: C.label,
			fontSize: 12,
			cursor: "default",
		};

		/** 菜单里的分组标题。 */
		const MENU_GROUP_STYLE = {
			padding: "6px 8px 2px",
			color: C.labelDim,
			fontSize: 11,
			fontWeight: 500,
		};

		/** 菜单项。 */
		function menuItemStyle(active) {
			return {
				display: "flex",
				alignItems: "center",
				gap: 6,
				width: "100%",
				boxSizing: "border-box",
				padding: "5px 8px",
				border: "none",
				borderRadius: 6,
				background: active ? C.hover : "transparent",
				color: C.label,
				font: "inherit",
				fontSize: 12,
				textAlign: "left",
				cursor: "pointer",
			};
		}

		/** 内联 SVG 图标：primitives 缺席时的兜底，与官方描边风格一致（16 网格、currentColor）。 */
		function FallbackIcon({ path, size, strokeWidth }) {
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: strokeWidth ?? 1.4,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false",
			}, h("path", { d: path }));
		}

		/** 播放三角：runClient / runServer 的主图标。 */
		const PATH_PLAY = "M5 3.5v9l8-4.5-8-4.5Z";
		/** 数据表：runData 的主图标。 */
		const PATH_DATA = "M2.5 4.5c0-1 2.5-1.8 5.5-1.8s5.5.8 5.5 1.8v7c0 1-2.5 1.8-5.5 1.8s-5.5-.8-5.5-1.8v-7Zm0 3.5c0 1 2.5 1.8 5.5 1.8s5.5-.8 5.5-1.8";
		/** 停止方块。 */
		const PATH_STOP = "M4.5 4.5h7v7h-7z";
		/** 下拉箭头。 */
		const PATH_CHEVRON = "M4 6.5 8 10.5l4-4";
		/** 服务器。 */
		const PATH_SERVER = "M2.5 3.5h11v3.5h-11zM2.5 9h11v3.5h-11zM5 5.2h.01M5 10.7h.01";
		/** 刷新（循环箭头）。 */
		const PATH_REFRESH = "M13.5 8a5.5 5.5 0 1 1-1.9-4.2M13.5 2.5V5h-2.5";
		/** 运行工具窗：带 `>_` 的方框。 */
		const PATH_CONSOLE = "M2.2 3.6h11.6v8.8H2.2zM4.6 6.6 6.4 8.4l-1.8 1.8M7.6 10.4h3.4";
		/** 重新运行：IDEA 绿色按钮上的循环箭头（箭头为实心三角）。 */
		const PATH_RERUN = "M13.2 8a5.2 5.2 0 1 1-1.6-3.8";
		/** IDEA 配置选择器左侧的方框图标。 */
		const PATH_CONFIG = "M2.5 3.5h11v9h-11zM2.5 6.5h11";
		/** 竖三点（更多操作）。 */
		const PATH_DOTS = "M8 3.5v.01M8 8v.01M8 12.5v.01";

		/** 项目结构来源的中文名，与主机端 SOURCE_LABEL 对应。 */
		const SOURCE_NAMES = {
			gradle: "Gradle 任务清单",
			ideaRun: "IDEA 运行配置",
			idea: "IDEA 项目结构",
			settings: "settings.gradle 解析",
			fallback: "默认任务名",
		};

		/**
		 * 把来源信息拼成一句人话，让用户知道列表可信到什么程度。
		 *
		 * 排序按可信度：Gradle 权威 > IDEA 运行配置 > IDEA 结构 > 自己解析。
		 *
		 * @param provenance 主机 targets 路由给的来源信息。
		 * @returns 一行说明。
		 */
		function describeProvenance(provenance) {
			const parts = [];
			const sources = provenance.sources ?? {};
			// 按可信度顺序展示，只列真正有贡献的来源。
			for (const key of ["gradle", "ideaRun", "idea", "settings", "fallback"]) {
				if (typeof sources[key] === "number" && sources[key] > 0) {
					parts.push(`${SOURCE_NAMES[key]} ${sources[key]}`);
				}
			}
			if (parts.length === 0) return "无";
			// wrapper 缺失是要提醒的事实：会用 PATH 上的 gradle。
			const suffix = provenance.hasWrapper === false ? "（无 gradlew，将用 PATH 上的 gradle）" : "";
			return parts.join(" · ") + suffix;
		}

		/** 按 kind 选图标。 */
		function KindIcon({ kind, size }) {
			const path = kind === "data" ? PATH_DATA : kind === "server" ? PATH_SERVER : PATH_PLAY;
			return h(FallbackIcon, { path, size });
		}

		/**
		 * 从任务全名推 IDEA 风格的显示名：`:modules:CTNH-Core:runClient` → `CTNH-Core - Client`。
		 *
		 * 任务全名在标题栏里太长，而 IDEA 用户认的就是「模块 + 配置类型」这两个词，
		 * 和 `.run/*.run.xml` 里那份配置名也一致。
		 */
		function titleFromTask(task) {
			const segments = String(task ?? "").split(":").filter(Boolean);
			if (segments.length === 0) return "运行任务";
			const leaf = segments[segments.length - 1];
			const kindName = /runclient|client/i.test(leaf) ? "Client"
				: /datagen|rundata|data/i.test(leaf) ? "Data"
					: /runserver|server/i.test(leaf) ? "Server" : leaf;
			// 单段（根项目任务）没有模块名，直接显示类型。
			return segments.length >= 2 ? `${segments[segments.length - 2]} - ${kindName}` : kindName;
		}

		/** 配置显示名；目标是 undefined 时给一句人话而不是空白。 */
		function configTitle(target) {
			return target === undefined ? "未发现运行配置" : titleFromTask(target.task);
		}

		/** 读取按会话保存的选择。 */
		function loadSelection(sessionId) {
			try {
				const raw = window.localStorage.getItem(`${STORE_KEY}.${sessionId}`);
				return raw === null ? {} : JSON.parse(raw);
			} catch {
				return {};
			}
		}

		/** 保存选择，失败（隐私模式）时静默忽略。 */
		function saveSelection(sessionId, value) {
			try {
				window.localStorage.setItem(`${STORE_KEY}.${sessionId}`, JSON.stringify(value));
			} catch {
				// 存不了就算了，只影响下次打开时的默认值。
			}
		}

		/** 调一次主机路由；网络或解析失败都归一成 { error }。 */
		async function callApi(payload) {
			try {
				const response = await fetch(API_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				});
				if (!response.ok) {
					return { error: response.status === 401 || response.status === 403
						? "会话未通过鉴权，请刷新页面后重试"
						: `HTTP ${response.status}` };
				}
				return await response.json();
			} catch (error) {
				return { error: `请求失败：${error && error.message ? error.message : String(error)}` };
			}
		}

		/** 秒数格式化成 IDEA 风格的紧凑时长。 */
		function formatElapsed(ms) {
			const total = Math.max(0, Math.floor(ms / 1000));
			const m = Math.floor(total / 60);
			const s = total % 60;
			return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
		}

		/** 运行中任务的圆点：IDEA 用状态色表达，这里复用同一套状态令牌。 */
		function StateDot({ status }) {
			const color = status === "running" || status === "stopping"
				? C.brand
				: status === "completed" ? C.success
					: status === "failed" ? C.error : C.idle;
			return h("span", {
				"aria-hidden": "true",
				style: {
					width: 6,
					height: 6,
					borderRadius: "50%",
					background: color,
					flex: "0 0 auto",
				},
			});
		}

		// ---- 右侧栏实时日志面板 ----
		//
		// 用官方的 sidebarRight 机制挂载（sidebarRightTabs 注册页签类型 +
		// sidebar.right.pane.tab 注册正文），不做任何 DOM 猴补。
		//
		// 页签类型 id 取完整包名，与官方内置插件（terminal / browser / files）一致；
		// kind 用私有值避开内置 kind，防止 `sidebarRight: tab kind "…" already registered`。
		const TAB_ID = "dsh-mc-gradle-runner";
		const TAB_KIND = "mc-gradle-run";
		const TITLE_TEXT = "MC Gradle";

		/**
		 * 在会话里打开日志页签的入口，由 `apply` 在 sidebarRight 服务就绪时填上。
		 *
		 * 用模块级变量而不是槽位 props 传递：工具栏的 `run()` 是在 useCallback 里
		 * 调用的，走闭包比多穿一层属性更直接，服务缺席时这里保持 undefined。
		 */
		let openRunLogTab;

		/** 日志面板里的一行等宽文本。 */
		const LOG_STYLE = {
			margin: 0,
			padding: "8px 10px",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
			color: C.label,
			tabSize: 4,
		};

		/**
		 * 把日志文本切成可以着色的行。
		 *
		 * 不引第三方高亮：Gradle 输出里真正有用的分类很少——
		 * 错误行、`[stderr]` 前缀、BUILD 结论，按前缀判断即可。
		 *
		 * @param line 单行文本。
		 * @returns 颜色，或 undefined 表示跟随正文色。
		 */
		function logLineColor(line) {
			if (line.startsWith("[stderr]") || /\bFAILED\b|\bFAILURE\b|error:|Exception\b/.test(line)) return C.error;
			if (/\bBUILD SUCCESSFUL\b|\bUP-TO-DATE\b/.test(line)) return C.success;
			if (/^> Task |^\s*$/.test(line)) return undefined;
			return C.labelDim;
		}

		/**
		 * 页签正文：某个 run* 任务的实时日志。
		 *
		 * 数据来源是主机 `/api/mc-gradle-runner` 的 `log` action（readAll 语义，
		 * 不移动游标），因此在任务结束后仍可回看全量输出。
		 *
		 * @param props.useTabInfo - 槽位 owner 提供的页签信息钩子。
		 * @param props.jobId - 打开时锁定的任务 id（可选）。
		 */
		function McRunLogPanel(props) {
			const { useTabInfo } = props;
			// useTabInfo 由 sidebarRight 提供；拿不到时说明槽位被别的宿主复用，
			// 此时降级成"选择任务"的列表，而不是直接崩掉整个右栏。
			const tabInfo = typeof useTabInfo === "function" ? useTabInfo() : undefined;
			const tab = tabInfo?.tab;
			// 打开页签时可以带 params（openTabIn 的 options.params），
			// 页签被复用时会带 revision 变化，需要重新读取。
			const params = tab?.navigation?.params;
			const lockedJobId = typeof params?.jobId === "string" ? params.jobId : undefined;

			const [jobs, setJobs] = useState([]);
			const [jobId, setJobId] = useState(lockedJobId);
			const [log, setLog] = useState({ text: "", lossy: false, job: undefined, artifacts: undefined });
			const [error, setError] = useState(undefined);
			const [input, setInput] = useState("");
			const [notice, setNotice] = useState(undefined);
			const bodyRef = useRef(null);

			// 页签是复用的（multiple: false），每次「运行」都只是换 navigation.params。
			// 不跟着 params 走的话，第二次运行会继续显示第一次的日志。
			useEffect(() => {
				if (lockedJobId !== undefined) setJobId(lockedJobId);
			}, [lockedJobId]);

			/** 自动滚到底：用户往上翻看历史时不要把他拽回来。 */
			const stickRef = useRef(true);

			// 页签被复用到另一个任务时跟随（revision 变化）。
			useEffect(() => {
				if (lockedJobId !== undefined) setJobId(lockedJobId);
			}, [lockedJobId, params?.revision]);

			const refreshJobs = useCallback(async () => {
				const result = await callApi({ action: "status" });
				if (result.error !== undefined) {
					setError(result.error);
					return;
				}
				setError(undefined);
				const list = Array.isArray(result.jobs) ? result.jobs : [];
				setJobs(list);
				// 没有指定任务时，默认盯住最近一个还在跑的，否则盯最后一个。
				setJobId((current) => {
					if (current !== undefined && list.some((job) => job.id === current)) return current;
					const live = list.filter((job) => job.status === "running" || job.status === "stopping");
					return (live.length > 0 ? live[live.length - 1] : list[list.length - 1])?.id;
				});
			}, []);

			const selected = jobs.find((job) => job.id === jobId);
			const isLive = selected === undefined
				? false
				: selected.status === "running" || selected.status === "stopping";

			const refreshLog = useCallback(async () => {
				if (jobId === undefined) {
					setLog({ text: "", lossy: false, job: undefined, artifacts: undefined });
					return;
				}
				const result = await callApi({ action: "log", job_id: jobId });
				if (result.error !== undefined) {
					setError(result.error);
					return;
				}
				setError(undefined);
				setLog({
					text: typeof result.text === "string" ? result.text : "",
					lossy: result.lossy === true,
					job: result.job,
					artifacts: result.artifacts,
				});
			}, [jobId]);

			// 任务列表：运行中快轮询，空闲时慢。
			useEffect(() => {
				let disposed = false;
				let timer;
				const tick = async () => {
					if (document.visibilityState === "visible") await refreshJobs();
					if (disposed) return;
					timer = setTimeout(() => void tick(), isLive ? BUSY_POLL_MS : IDLE_POLL_MS);
				};
				void tick();
				return () => {
					disposed = true;
					if (timer !== undefined) clearTimeout(timer);
				};
			}, [refreshJobs, isLive]);

			// 日志：运行中高频拉，结束后停住（避免无意义空转）。
			useEffect(() => {
				let disposed = false;
				let timer;
				const tick = async () => {
					if (document.visibilityState === "visible") await refreshLog();
					if (disposed) return;
					// 运行中 1s，刚结束再看一次结算后的 diff，然后彻底停掉。
					timer = setTimeout(() => void tick(), isLive ? 1000 : Math.max(IDLE_POLL_MS, 15000));
				};
				void tick();
				return () => {
					disposed = true;
					if (timer !== undefined) clearTimeout(timer);
				};
			}, [refreshLog, isLive]);

			// 贴底滚动。只在用户本来就贴着底部时才跟随新输出。
			useEffect(() => {
				const node = bodyRef.current;
				if (node === null) return;
				if (stickRef.current) node.scrollTop = node.scrollHeight;
			}, [log.text]);

			/** 往标准输入发一行（MC 控制台命令）。 */
			const send = useCallback(async () => {
				if (jobId === undefined) return;
				const text = input.trim();
				if (text.length === 0) return;
				const result = await callApi({ action: "input", job_id: jobId, text });
				if (result.error !== undefined) {
					setNotice({ tone: "error", text: result.error });
					return;
				}
				setInput("");
				// 这里只能保证写进了 Gradle 的 stdin；是否转发给游戏 JVM
				// 取决于构建脚本里有没有 standardInput = System.in。
				setNotice({ tone: "info", text: "已写入 Gradle 标准输入；若游戏无反应，需在运行配置里开启标准输入转发" });
			}, [input, jobId]);

			const stop = useCallback(async () => {
				if (jobId === undefined) return;
				const result = await callApi({ action: "kill", job_id: jobId });
				if (result.error !== undefined) setNotice({ tone: "error", text: result.error });
				await refreshJobs();
				await refreshLog();
			}, [jobId, refreshJobs, refreshLog]);

			// 空态：没有任何任务时给出可操作的一句话，而不是空白面板。
			if (jobs.length === 0) {
				return h("div", {
					style: {
						display: "flex", flexDirection: "column", gap: 6,
						padding: 16, color: C.labelDim, fontSize: 12, lineHeight: "18px",
					},
				},
					h("span", { style: { color: C.label, fontSize: 13 } }, "还没有 Gradle 任务"),
					h("span", null, "在会话头部选好运行配置，点绿色运行键即可；日志会实时出现在这里。"),
					error !== undefined ? h("span", { style: { color: C.error } }, error) : null,
				);
			}

			const lines = log.text.length === 0 ? [] : log.text.split(/\r?\n/);
			const artifacts = log.artifacts;
			const statusText = selected === undefined
				? ""
				: selected.status === "running" ? "运行中"
					: selected.status === "stopping" ? "正在停止"
						: selected.status === "completed" ? "完成"
							: selected.status === "killed" ? "已取消" : "失败";

			return h("div", {
				style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
			},
				// 顶部条：任务选择 + 状态 + 停止。
				h("div", {
					style: {
						display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
						padding: "6px 8px", borderBottom: `0.5px solid ${C.border}`, flex: "0 0 auto",
					},
				},
					h("select", {
						"aria-label": "选择任务",
						value: jobId ?? "",
						onChange: (event) => setJobId(event.target.value),
						style: {
							height: 24, padding: "0 6px", borderRadius: 6, fontSize: 12,
							background: "transparent", color: C.label,
							border: `0.5px solid ${C.border}`, font: "inherit",
						},
					}, jobs.map((job) => h("option", { key: job.id, value: job.id },
						`${job.task.split(":").pop()} · ${job.status}`))),
					selected !== undefined && h("span", {
						style: {
							display: "inline-flex", alignItems: "center", gap: 5,
							color: C.labelDim, fontSize: 12, fontVariantNumeric: "tabular-nums",
						},
					}, h(StateDot, { status: selected.status }), statusText),
					isLive && h("button", {
						type: "button",
						onClick: () => void stop(),
						title: `停止 ${selected.task}`,
						style: buttonStyle({ color: C.error }),
					}, h(FallbackIcon, { path: PATH_STOP, size: 12 }), "停止"),
					h("span", { style: { flex: 1 } }),
					h("button", {
						type: "button",
						onClick: () => { void refreshJobs(); void refreshLog(); },
						title: "重新读取日志",
						style: buttonStyle({ padding: "0 4px" }),
					}, h(FallbackIcon, { path: PATH_REFRESH, size: 12 })),
				),

				// 日志正文。
				h("div", {
					ref: bodyRef,
					role: "log",
					"aria-live": isLive ? "polite" : "off",
					onScroll: (event) => {
						const node = event.currentTarget;
						stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
					},
					style: { flex: "1 1 auto", minHeight: 0, overflow: "auto", background: "transparent" },
				},
					log.lossy && h("div", {
						style: { padding: "4px 10px", color: C.warn, fontSize: 11 },
					}, "输出超过缓冲上限，已丢弃最早的片段。"),
					lines.length === 0
						? h("div", { style: { padding: "10px", color: C.labelDim, fontSize: 12 } },
							isLive ? "等待输出…" : "（无输出）")
						: h("pre", { style: LOG_STYLE }, lines.map((line, index) => h("div", {
							key: index,
							style: { color: logLineColor(line) },
						}, line.length === 0 ? "\u00a0" : line))),
					// runData 的产物 diff：直接显示统计与文件列表。
					artifacts !== undefined && artifacts.kind === "diff" && h("div", {
						style: {
							margin: "8px 10px", padding: "8px 10px", borderRadius: 8,
							border: `0.5px solid ${C.border}`, fontSize: 12, lineHeight: "18px",
						},
					},
						h("div", { style: { color: C.label, marginBottom: 4 } },
							`产物变更：新增 ${artifacts.stats?.added ?? 0} · 修改 ${artifacts.stats?.modified ?? 0}`
							+ ` · 删除 ${artifacts.stats?.removed ?? 0}`),
						(artifacts.diffs ?? []).slice(0, 50).map((entry) => h("div", {
							key: entry.path,
							style: { color: C.labelDim, fontFamily: "ui-monospace, monospace" },
						}, `${entry.kind === "added" ? "A" : entry.kind === "removed" ? "D" : "M"} ${entry.path}`)),
						(artifacts.diffs?.length ?? 0) > 50 && h("div", { style: { color: C.labelDim } },
							`… 其余 ${artifacts.diffs.length - 50} 个文件未展开`),
					),
					// runClient 的崩溃报告。
					artifacts !== undefined && artifacts.kind === "crash" && h("div", {
						style: {
							margin: "8px 10px", padding: "8px 10px", borderRadius: 8,
							border: `0.5px solid ${C.border}`, color: C.error, fontSize: 12, whiteSpace: "pre-wrap",
						},
					}, artifacts.summary ?? "检测到崩溃报告"),
					artifacts !== undefined && artifacts.error !== undefined && h("div", {
						style: { margin: "8px 10px", color: C.error, fontSize: 12 },
					}, `产物采集失败：${artifacts.error}`),
				),

				// 底部：控制台输入（仅运行中可用）。
				h("div", {
					style: {
						display: "flex", alignItems: "center", gap: 6,
						padding: "6px 8px", borderTop: `0.5px solid ${C.border}`, flex: "0 0 auto",
					},
				},
					h("input", {
						type: "text",
						"aria-label": "向游戏控制台发送命令",
						value: input,
						disabled: !isLive,
						placeholder: isLive ? "输入命令后回车（如 list / help）" : "任务已结束，无法发送命令",
						onChange: (event) => setInput(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void send();
							}
						},
						style: {
							flex: "1 1 auto", minWidth: 0, height: 26, padding: "0 8px",
							borderRadius: 6, border: `0.5px solid ${C.border}`,
							background: "transparent", color: C.label, font: "inherit", fontSize: 12,
						},
					}),
					h("button", {
						type: "button",
						disabled: !isLive || input.trim().length === 0,
						onClick: () => void send(),
						style: buttonStyle({ opacity: !isLive || input.trim().length === 0 ? 0.45 : 1 }),
					}, "发送"),
				),

				(notice !== undefined || error !== undefined) && h("div", {
					style: {
						padding: "4px 8px", fontSize: 11, lineHeight: "16px",
						borderTop: `0.5px solid ${C.border}`,
						color: error !== undefined || notice?.tone === "error" ? C.error : C.labelDim,
					},
				}, error ?? notice?.text),
			);
		}

		/** 页签标题：任务名 + 状态，与 IDEA 的 run 工具窗标题一致。 */
		function McRunLogTitle(props) {
			const { useTabInfo } = props;
			const tabInfo = typeof useTabInfo === "function" ? useTabInfo() : undefined;
			const tab = tabInfo?.tab;
			const params = tab?.navigation?.params;
			const task = typeof params?.task === "string" ? params.task : undefined;
			return h("span", {
				style: { display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0 },
			},
				h(FallbackIcon, { path: PATH_PLAY, size: 12 }),
				h("span", {
					style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
				}, task === undefined ? TITLE_TEXT : `${TITLE_TEXT} · ${titleFromTask(task)}`),
			);
		}

		/**
		 * 会话头部的 run* 工具栏。
		 *
		 * 只在发现到 run* 目标时渲染：非 Gradle 项目的会话里不留任何痕迹。
		 * 主操作是 runClient，次操作是 runData；模块与任务通过下拉切换，
		 * 有任务在跑时额外出现停止按钮与耗时。
		 *
		 * @param props.sessionId - 当前会话 id，由槽位所属方提供。
		 */
		function McRunToolbar({ sessionId }) {
			const [targets, setTargets] = useState([]);
			const [projects, setProjects] = useState([]);
			const [root, setRoot] = useState(undefined);
			const [error, setError] = useState(undefined);
			const [jobs, setJobs] = useState([]);
			const [selection, setSelection] = useState(() => loadSelection(sessionId));
			const [menuOpen, setMenuOpen] = useState(false);
			const [busy, setBusy] = useState(false);
			const [now, setNow] = useState(() => Date.now());
			const [probed, setProbed] = useState(false);
			/**
			 * 主机裁决的可用性。
			 *
			 * 按钮的显示条件必须由主机统一给出，而不是浏览器端自己看 targets 是否非空：
			 * 主机才知道这个目录到底是不是 Gradle 项目、有没有真的 run* 任务。
			 * 只有 available === true 才渲染任何东西。
			 */
			const [available, setAvailable] = useState(false);
			/** 项目结构来源与各来源贡献，用于在菜单里说明“这个列表怎么来的”。 */
			const [provenance, setProvenance] = useState(undefined);
			/** 权威任务列表的刷新状态：idle | loading | ok | error。 */
			const [refresh, setRefresh] = useState({ state: "idle" });
			const menuAnchorRef = useRef(null);
			const menuRef = useRef(null);

			/**
			 * 发现目标。
			 *
			 * 返回本次是否可用，供调用方决定要不要重试。
			 * 注意：**不能只探测一次**。会话刚打开时主机的 session.header.cwd 可能
			 * 还没就绪，插件也可能正在重载，一次失败就让按钮永久消失——用户反馈过
			 * “旧会话没有按钮、新开一个会话才有”，根因就是这里只跑一次。
			 */
			const refreshTargets = useCallback(async (options) => {
				const result = await callApi({ action: "targets", sessionId });
				if (result.error !== undefined) {
					// 探测本身失败：不渲染按钮。宁可不显示，也不给一个点不动的按钮。
					setError(result.error);
					setAvailable(false);
					setTargets([]);
					return { available: false, error: result.error };
				}
				setError(undefined);
				// available 缺省时退回“有目标即可用”，兼容旧版主机。
				const ok = result.available === undefined
					? Array.isArray(result.targets) && result.targets.length > 0
					: result.available === true;
				setAvailable(ok);
				setTargets(Array.isArray(result.targets) ? result.targets : []);
				setProjects(Array.isArray(result.projects) ? result.projects : []);
				setRoot(result.root);
				setProvenance({
					structureSource: result.structureSource,
					sources: result.sources,
					gradleQuery: result.gradleQuery,
					hasWrapper: result.hasWrapper,
				});
				if (options !== undefined && options.clearRefresh === true) setRefresh({ state: "idle" });
				return { available: ok, reason: result.unavailableReason };
			}, [sessionId]);

			/**
			 * 向 Gradle 查询权威任务列表。
			 *
			 * 这是唯一能证明“任务真的存在”的来源，但要跑一次真实 Gradle（约 7 秒），
			 * 因此只在用户显式点击时触发，并显示加载态。结果由主机缓存。
			 */
			const refreshFromGradle = useCallback(async () => {
				setRefresh({ state: "loading" });
				const result = await callApi({ action: "tasks", sessionId });
				if (result.error !== undefined) {
					setRefresh({ state: "error", message: result.error });
					return;
				}
				setRefresh({ state: "ok", count: Array.isArray(result.tasks) ? result.tasks.length : 0 });
				// 让主机重新裁决一次（它已把权威结果并进发现逻辑）。
				await refreshTargets();
			}, [sessionId, refreshTargets]);

			/** 拉一次任务状态。 */
			const refreshJobs = useCallback(async () => {
				const result = await callApi({ action: "status", sessionId });
				if (result.error !== undefined) return;
				setJobs(Array.isArray(result.jobs) ? result.jobs : []);
			}, [sessionId]);

			// 初始探测 + 不可用时自愈重试。
			//
			// 会话刚打开时主机的 session.header.cwd 可能还没就绪，插件也可能正在重载；
			// 只探测一次会让按钮永久消失（用户报过“旧会话没按钮、新开会话才有”）。
			// 因此不可用就按退避重试：1s → 2s → 4s → … → 最长 60s。
			// 一旦可用就停止重试；页面重新可见时也会立刻再探一次。
			useEffect(() => {
				let disposed = false;
				let timer;
				let attempt = 0;
				const run = async () => {
					setSelection(loadSelection(sessionId));
					const outcome = await refreshTargets();
					if (disposed) return;
					setProbed(true);
					if (outcome.available) return;
					attempt += 1;
					const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 6), 60000);
					timer = setTimeout(() => void run(), delay);
				};
				void run();
				// 切回本页时立刻补探一次：用户回到窗口往往正是希望看到按钮的时刻。
				const onVisible = () => {
					if (document.visibilityState !== "visible") return;
					if (timer !== undefined) clearTimeout(timer);
					attempt = 0;
					void run();
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					disposed = true;
					if (timer !== undefined) clearTimeout(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [sessionId, refreshTargets]);

			const live = useMemo(
				() => jobs.filter((job) => job.status === "running" || job.status === "stopping"),
				[jobs],
			);

			// 轮询：有任务在跑时快，空闲时慢；页面隐藏时完全停掉。
			useEffect(() => {
				let disposed = false;
				let timer;
				const tick = async () => {
					if (document.visibilityState === "visible") await refreshJobs();
					if (disposed) return;
					timer = setTimeout(() => void tick(), live.length > 0 ? BUSY_POLL_MS : IDLE_POLL_MS);
				};
				timer = setTimeout(() => void tick(), 500);
				return () => {
					disposed = true;
					if (timer !== undefined) clearTimeout(timer);
				};
			}, [refreshJobs, live.length]);

			// 运行中每秒重算耗时。
			useEffect(() => {
				if (live.length === 0) return undefined;
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, [live.length]);

			/** 按 kind 找当前选中的目标：先按记忆的模块过滤，再退回第一个。 */
			const targetFor = useCallback((kind) => {
				const preferred = selection.projectPath;
				const ofKind = targets.filter((target) => target.kind === kind);
				if (ofKind.length === 0) return undefined;
				if (preferred !== undefined) {
					const scoped = ofKind.find((target) => target.projectPath === preferred);
					if (scoped !== undefined) return scoped;
				}
				return ofKind[0];
			}, [targets, selection.projectPath]);

			/** 起任务。target 直接给，避免"kind → 目标"的二次猜测跑错模块。 */
			const run = useCallback(async (target) => {
				if (target === undefined) {
					setError("没有可用的运行配置");
					return;
				}
				setBusy(true);
				const result = await callApi({ action: "start", kind: target.task, sessionId });
				setBusy(false);
				if (result.error !== undefined) {
					// 同名任务冲突等业务失败直接显示原因，不静默重试。
					setError(result.error);
					return;
				}
				setError(undefined);
				await refreshJobs();
				// 起任务即打开右侧栏实时日志（IDEA 的 Run 工具窗行为）。
				// openRunLogTab 由 apply 注入；没有 sidebarRight 服务时它是 undefined，
				// 此时按钮照样能起任务，只是不自动开面板。
				const started = result.job ?? {};
				if (typeof openRunLogTab === "function") {
					openRunLogTab(sessionId, {
						jobId: typeof started.id === "string" ? started.id : undefined,
						task: target.task,
					});
				}
			}, [targetFor, sessionId, refreshJobs]);

			/** 取消任务。 */
			const stop = useCallback(async (jobId) => {
				setBusy(true);
				const result = await callApi({ action: "kill", job_id: jobId, sessionId });
				setBusy(false);
				if (result.error !== undefined) setError(result.error);
				await refreshJobs();
			}, [sessionId, refreshJobs]);

			/**
			 * 运行/重新运行。
			 *
			 * 对应 IDEA 标题栏那个绿色按钮：没跑过是「运行」，跑过就是循环箭头
			 * 的「重新运行」。后者必须先等旧任务结算完再起新的，否则会撞上
			 * 宿主的同名任务并发策略（默认 reject）。
			 */
			const runOrRestart = useCallback(async (target) => {
				if (target === undefined) {
					setError("没有可用的运行配置");
					return;
				}
				const liveJob = jobs.find((job) => job.task === target.task
					&& (job.status === "running" || job.status === "stopping"));
				if (liveJob !== undefined) {
					setBusy(true);
					await callApi({ action: "kill", job_id: liveJob.id, sessionId });
					// 宿主强杀有 5s 宽限 + 6s 兜底结算，这里给足 15s 再放弃。
					const deadline = Date.now() + 15000;
					for (;;) {
						const listing = await callApi({ action: "status", sessionId });
						const list = Array.isArray(listing.jobs) ? listing.jobs : [];
						const still = list.find((job) => job.id === liveJob.id
							&& (job.status === "running" || job.status === "stopping"));
						if (still === undefined) break;
						if (Date.now() > deadline) {
							setBusy(false);
							setError("上一个任务还没停下来，请稍后再试");
							return;
						}
						await new Promise((resolve) => {
							setTimeout(resolve, 300);
						});
					}
					setBusy(false);
					await refreshJobs();
				}
				await run(target);
			}, [jobs, run, sessionId, refreshJobs]);

			/** 选中某个目标：记住它 + 记入「最近的配置」，两个按钮跟随同一模块。 */
			const choose = useCallback((target) => {
				const recentTasks = [target.task, ...(Array.isArray(selection.recent) ? selection.recent : [])]
					.filter((task, index, all) => all.indexOf(task) === index)
					.slice(0, 5);
				const next = { projectPath: target.projectPath, task: target.task, recent: recentTasks };
				setSelection(next);
				saveSelection(sessionId, next);
				setMenuOpen(false);
			}, [sessionId, selection.recent]);

			// 点外部 / Esc 关闭菜单。
			useEffect(() => {
				if (!menuOpen) return undefined;
				const onPointerDown = (event) => {
					if (menuRef.current?.contains(event.target)) return;
					if (menuAnchorRef.current?.contains(event.target)) return;
					setMenuOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setMenuOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [menuOpen]);

			/** 菜单坐标：贴着按钮右下角展开，并在视口边缘收回来。 */
			const menuPosition = useMemo(() => {
				if (!menuOpen) return undefined;
				const rect = menuAnchorRef.current?.getBoundingClientRect();
				if (rect === undefined) return undefined;
				const width = 240;
				const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
				const top = Math.min(rect.bottom + 4, window.innerHeight - 120);
				return { left, top, width };
			}, [menuOpen]);

			const running = live[0];
			const finished = jobs.filter((job) => job.status !== "running" && job.status !== "stopping").slice(-1)[0];
			const current = running ?? finished;

			/**
			 * 当前选中的运行配置。
			 *
			 * IDEA 的标题栏是「一个配置 + 一个绿色运行键」，所以这里必须收敛成
			 * **单一**选中项，而不是 client / data 各一个按钮。回落顺序：
			 * 记忆的选择 → runClient → 任意目标。
			 */
			const selected = useMemo(() => {
				const remembered = selection.task === undefined
					? undefined
					: targets.find((target) => target.task === selection.task);
				return remembered ?? targetFor("client") ?? targets[0];
			}, [selection.task, targets, targetFor]);

			/** 最近用过的配置（IDEA 菜单里的「最近的配置」）。存的是 task，展示时再解析。 */
			const recent = useMemo(() => (Array.isArray(selection.recent) ? selection.recent : []), [selection.recent]);

			/** 把记忆里的 task 解析回当前目标；任务已被删掉的就跳过。 */
			const recentTargets = useMemo(() => recent
				.map((task) => targets.find((target) => target.task === task))
				.filter((target) => target !== undefined), [recent, targets]);

			// 早退必须放在**所有 hooks 之后**。
			//
			// 之前这两行写在 selected/recent/recentTargets 三个 useMemo 上面，
			// 首次渲染 probed=false 时只跑了前 13 个 hook 就返回 null，
			// 探测完成后本次渲染又跑 16 个 hook —— React 直接抛
			// “Rendered more hooks than during the previous render”，
			// 组件每次渲染都崩，槽位把条目判为 abdicated（active: false），
			// 于是按钮在任何工作区都不出现。这是那次“按钮不见了”的真正原因。
			//
			// 探测完成前不渲染，避免非 Gradle 会话闪一下空壳。
			if (!probed) return null;
			// 主机说不可用就彻底不渲染。
			//
			// 这是本组件的显示契约：**只有发现到可用的 MC Gradle 目标时按钮才存在**。
			// 因此非 Gradle 项目的会话里不会留下任何痕迹，也不会出现
			// “按钮在、点下去报错”的情况。探测失败同理不渲染。
			if (!available) return null;

			/**
			 * 跑过就不再是「运行」，而是 IDEA 那个循环箭头的「重新运行」。
			 *
			 * 唯一的例外是「取消」：被取消的配置等于没真正跑成，按 IDEA 的直觉
			 * 绿色按钮应当退回三角（▶）。早先这里只看"有没有跑过这条任务"，
			 * 于是点了停止以后按钮一直卡在循环箭头上，用户没法一眼看出
			 * 现在再点是"从头跑"还是"接着跑"。
			 *
			 * 只看**最后一次**那条任务：先跑成功、再被取消，也应该回到 ▶。
			 */
			const lastRunOfSelected = selected === undefined
				? undefined
				: jobs.filter((job) => job.task === selected.task).slice(-1)[0];
			const rerunnable = selected !== undefined
				&& lastRunOfSelected !== undefined
				&& lastRunOfSelected.status !== "killed";

			/** IDEA 标题栏里的实心方块按钮：绿=运行/重新运行，红=停止。图标一律白色。 */
			const actionButton = (options) => h("button", {
				type: "button",
				disabled: options.disabled === true,
				title: options.title,
				"aria-label": options.title,
				onClick: options.onClick,
				style: {
					boxSizing: "border-box",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: 24,
					height: 24,
					padding: 0,
					border: "none",
					borderRadius: 6,
					flex: "0 0 auto",
					background: options.disabled === true ? "transparent" : options.background,
					color: options.disabled === true ? C.labelDim : C.solidForeground,
					opacity: options.disabled === true ? 0.45 : 1,
					cursor: options.disabled === true ? "not-allowed" : "pointer",
				},
				onMouseEnter: (event) => {
					if (options.disabled !== true) event.currentTarget.style.filter = "brightness(1.15)";
				},
				onMouseLeave: (event) => {
					event.currentTarget.style.filter = "none";
				},
			}, h(FallbackIcon, { path: options.path, size: 14, strokeWidth: 1.6 }));

			/**
			 * 菜单里的一行配置。
			 *
			 * 左边点击＝选中（IDEA 的菜单项语义），右边那个绿色 ▶ 直接开跑——
			 * 对应 IDEA 悬停行时浮出的运行键。做成两个并列的真按钮而不是按钮套按钮，
			 * 是为了不产生嵌套 button 这种非法 HTML。
			 */
			const configRow = (target, active) => h("div", {
				key: target.task,
				style: { display: "flex", alignItems: "center", gap: 2, width: "100%" },
			},
				h("button", {
					type: "button",
					role: "menuitemradio",
					"aria-checked": active === true,
					title: target.task,
					onClick: () => choose(target),
					style: { ...menuItemStyle(active === true), flex: "1 1 auto", minWidth: 0 },
				},
					h(KindIcon, { kind: target.kind, size: 12 }),
					h("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } },
						configTitle(target)),
					target.kind === "other" && h("span", {
						style: { marginLeft: "auto", color: C.labelDim, fontSize: 11, flex: "0 0 auto" },
					}, target.leaf),
				),
				h("button", {
					type: "button",
					title: `运行 ${target.task}`,
					"aria-label": `运行 ${target.task}`,
					onClick: () => {
						choose(target);
						void runOrRestart(target);
					},
					style: {
						boxSizing: "border-box",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						width: 20,
						height: 20,
						padding: 0,
						border: "none",
						borderRadius: 5,
						background: "transparent",
						color: C.success,
						cursor: "pointer",
						flex: "0 0 auto",
					},
				}, h(FallbackIcon, { path: PATH_PLAY, size: 12, strokeWidth: 1.6 })),
			);

			return h("div", { style: ROOT_STYLE, "data-dsh-mc-runner": "toolbar" },
				// ① 配置选择器：IDEA 那个「CTNH-Core - Client ▾」。
				h("button", {
					ref: menuAnchorRef,
					type: "button",
					"aria-haspopup": "menu",
					"aria-expanded": menuOpen,
					"aria-label": "选择运行配置",
					title: selected === undefined
						? "未发现运行配置"
						: `${configTitle(selected)}（${selected.task}）`,
					onClick: () => setMenuOpen((open) => !open),
					style: {
						boxSizing: "border-box",
						display: "inline-flex",
						alignItems: "center",
						gap: 5,
						height: 24,
						maxWidth: 200,
						minWidth: 0,
						padding: "0 6px",
						border: `0.5px solid ${menuOpen ? C.borderStrong : C.border}`,
						borderRadius: 6,
						background: menuOpen ? C.hover : "transparent",
						color: C.label,
						font: "inherit",
						fontSize: 12,
						whiteSpace: "nowrap",
						cursor: "pointer",
						flex: "0 1 auto",
					},
					onMouseEnter: (event) => {
						event.currentTarget.style.background = C.hover;
					},
					onMouseLeave: (event) => {
						if (!menuOpen) event.currentTarget.style.background = "transparent";
					},
				},
					h("span", { style: { display: "inline-flex", color: C.labelDim, flex: "0 0 auto" } },
						h(FallbackIcon, { path: PATH_CONFIG, size: 13 })),
					h("span", {
						style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
					}, configTitle(selected)),
					h("span", { style: { display: "inline-flex", color: C.labelDim, flex: "0 0 auto" } },
						h(FallbackIcon, { path: PATH_CHEVRON, size: 12, strokeWidth: 1.6 })),
				),

				// ② 绿色运行 / 重新运行（跑过就变循环箭头，和 IDEA 一致）。
				actionButton({
					path: rerunnable ? PATH_RERUN : PATH_PLAY,
					background: C.success,
					disabled: busy || selected === undefined,
					title: selected === undefined
						? "未发现运行配置"
						: `${rerunnable ? "重新运行" : "运行"} '${configTitle(selected)}'`,
					onClick: () => void runOrRestart(selected),
				}),

				// ③ 红色停止：有任务在跑才点亮。
				actionButton({
					path: PATH_STOP,
					background: C.error,
					disabled: busy || running === undefined,
					title: running === undefined ? "当前没有正在运行的任务" : `停止 '${running.task}'`,
					onClick: () => {
						if (running !== undefined) void stop(running.id);
					},
				}),

				// ④ 竖三点：更多操作，和配置选择器共用同一个菜单。
				h("button", {
					type: "button",
					"aria-haspopup": "menu",
					"aria-expanded": menuOpen,
					"aria-label": "更多运行操作",
					title: "更多操作",
					onClick: () => setMenuOpen((open) => !open),
					style: {
						boxSizing: "border-box",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						width: 20,
						height: 24,
						padding: 0,
						border: "none",
						borderRadius: 6,
						background: "transparent",
						color: menuOpen ? C.label : C.labelDim,
						cursor: "pointer",
						flex: "0 0 auto",
					},
					onMouseEnter: (event) => {
						event.currentTarget.style.background = C.hover;
					},
					onMouseLeave: (event) => {
						event.currentTarget.style.background = "transparent";
					},
				}, h(FallbackIcon, { path: PATH_DOTS, size: 14, strokeWidth: 2 })),

				// ⑤ 运行状态：有任务（在跑或刚结束）时贴一行紧凑文本。
				current !== undefined && h(react.Fragment, null,
					h("span", { style: SEP_STYLE, "aria-hidden": "true" }),
					h("span", {
						style: {
							display: "inline-flex",
							alignItems: "center",
							gap: 5,
							padding: "0 2px",
							color: C.labelDim,
							fontSize: 12,
							whiteSpace: "nowrap",
							fontVariantNumeric: "tabular-nums",
						},
						title: current.detail ?? current.task,
					},
						h(StateDot, { status: current.status }),
						running !== undefined
							? `${titleFromTask(running.task)} ${formatElapsed(now - running.startedAt)}`
							: current.status === "completed" ? "完成" : current.status === "failed" ? "失败" : "已取消",
					),
				),

				// 目标菜单。
				menuOpen && menuPosition !== undefined && h("div", {
					ref: menuRef,
					role: "menu",
					"aria-label": "Gradle run 目标",
					style: { ...MENU_STYLE, ...menuPosition },
				},
					root !== undefined && h("div", { style: MENU_GROUP_STYLE }, `项目根：${root}`),
					// 「最近的配置」在 IDEA 里排在最上面一段。
					recentTargets.length > 0 && h("div", null,
						h("div", { style: MENU_GROUP_STYLE }, "最近的配置"),
						recentTargets.map((target) => configRow(target, target.task === selected?.task)),
					),
					h("div", { style: MENU_GROUP_STYLE }, `所有配置 ${targets.length}`),
					["client", "data", "server", "other"].map((kind) => {
						const ofKind = targets.filter((target) => target.kind === kind);
						if (ofKind.length === 0) return null;
						const title = kind === "client" ? "运行客户端" : kind === "data" ? "数据生成"
							: kind === "server" ? "运行服务端" : "其他 run 任务";
						return h("div", { key: kind },
							h("div", { style: MENU_GROUP_STYLE }, title),
							ofKind.map((target) => configRow(target, target.task === selected?.task)),
						);
					}),

					// ---- 日志面板 ----
					//
					// IDEA 的 Run 工具窗入口。自动打开只在"点运行"时发生；
					// 用户手动关掉面板之后，得有个地方能再打开。
					h("div", { style: { borderTop: `0.5px solid ${C.border}`, marginTop: 4, paddingTop: 4 } },
						h("button", {
							type: "button",
							role: "menuitem",
							disabled: typeof openRunLogTab !== "function",
							title: current === undefined
								? "还没有 run* 任务，运行一次再看日志"
								: "在右侧栏打开该任务的实时日志",
							onClick: () => {
								setMenuOpen(false);
								if (typeof openRunLogTab === "function") {
									openRunLogTab(sessionId, { jobId: current?.id, task: current?.task });
								}
							},
							style: menuItemStyle(false),
						},
							h(FallbackIcon, { path: PATH_CONSOLE, size: 12 }),
							"打开日志面板",
						),
					),

					// ---- 权威任务列表：向 Gradle 查询 ----
					//
					// 静态发现靠命名约定与 IDEA 配置推断，可能漏掉自定义 run* 任务；
					// 这里让 Gradle 自己报出任务清单，是唯一权威的来源。
					// 代价是一次真实 Gradle 调用（约 7 秒），所以做成显式按钮 + 加载态。
					h("div", { style: { borderTop: `0.5px solid ${C.border}`, marginTop: 4, paddingTop: 4 } },
						h("button", {
							type: "button",
							role: "menuitem",
							disabled: refresh.state === "loading",
							title: "运行 gradlew tasks 让 Gradle 报出真实任务清单（约 7 秒，结果会缓存）",
							onClick: () => void refreshFromGradle(),
							style: menuItemStyle(false),
						},
							h(FallbackIcon, { path: PATH_REFRESH, size: 12 }),
							refresh.state === "loading"
								? "正在向 Gradle 查询…"
								: refresh.state === "ok"
									? `已从 Gradle 刷新（${refresh.count} 个 run* 任务）`
									: refresh.state === "error"
										? "刷新失败，点击重试"
										: "从 Gradle 刷新任务列表",
						),
						// 刷新失败的原因：直接显示，不弹窗。
						refresh.state === "error" && h("div", {
							style: { padding: "2px 8px 4px", color: C.error, fontSize: 11, lineHeight: "15px" },
						}, refresh.message),
						// 来源说明：让用户知道当前列表是怎么来的。
						provenance !== undefined && h("div", {
							style: { padding: "2px 8px 4px", color: C.labelDim, fontSize: 11, lineHeight: "15px" },
						},
							"来源：" + describeProvenance(provenance),
						),
					),
				),

				// 错误提示：贴在最右，不遮挡按钮。
				error !== undefined && h("span", {
					role: "status",
					title: error,
					style: {
						maxWidth: 180,
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
						color: C.error,
						fontSize: 12,
						paddingLeft: 4,
					},
				}, error),
			);
		}

		// ---- 插件配置页 ----
		//
		// 设置 →「插件配置」→ dsh-mc-gradle-runner 里显示的表单。
		//
		// 这里有两个 id，功能完全不同，不能互换：
		//   · 槽位 key 必须是 **npm 包名**：plugin-manager 用
		//     `ledger.bundles.has(pkg.name)` 判断要不要渲染整段配置区，
		//     key 对不上就一个字段都不出现。
		//   · configForms.get(id) 要的是 **loader 条目 id**（cordis.patch.yml 里的 `id`），
		//     宿主 describe() 返回的 ns 就是它；用包名去取会拿到不可用的空表单。
		/** 槽位 key = npm 包名。 */
		const BUNDLE_KEY = "dsh-mc-gradle-runner";
		/** 表单 namespace = 条目标签页里的插件 id。 */
		const ENTRY_ID = "mc-gradle-runner";

		/** 表单文案。表格里没有 locale 注册，所以直接写中文而不是 t()。 */
		const FORM_LABELS = {
			unavailable: "宿主未提供该插件的配置条目，表单不可用。",
			readOnly: "当前 profile 不可写，只能查看。",
			saveFailed: "保存失败：检查数值范围与枚举取值后重试。",
			save: "保存",
			saving: "保存中…",
			discard: "放弃修改",
		};

		/**
		 * 取官方 UI primitives（表单部件）。
		 *
		 * 它在客户端模块表的种子词里，正常都能拿到。拿不到时只放弃配置卡，
		 * 不抛错——否则换前端版本会把快捷按钮一起拖死。
		 */
		function loadPrimitives() {
			try {
				const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
				if (primitives && primitives.SettingsForm && primitives.SettingsFormModel) return primitives;
			} catch (error) {
				console.warn("[mc-gradle-runner] 未能加载 UI primitives，配置页不可用", error);
			}
			return undefined;
		}

		/** 布尔字段：值在表单里以 "true"/"false" 文本流转。 */
		function boolSpec(field) {
			return {
				field,
				format: (value) => String(value === true),
				parse: (text) => ({ kind: "set", value: text === "true" }),
			};
		}

		/**
		 * 枚举字段：只接受白名单取值。
		 *
		 * parse 返回 undefined 表示「输入无法解析」，表单会把它标成 invalid 并
		 * 拦住保存——比静默写回一个非法值安全。
		 */
		function enumSpec(field, allowed) {
			return {
				field,
				format: (value) => (typeof value === "string" ? value : ""),
				parse: (text) => {
					const value = text.trim();
					if (value === "") return { kind: "clear" };
					return allowed.includes(value) ? { kind: "set", value } : undefined;
				},
			};
		}

		/**
		 * 注册配置页表单。
		 *
		 * 只依赖 configForms；取不到就静默跳过（未装 settings 半身的 profile 也照常跑）。
		 *
		 * @param ctx - 已注入 configForms 的上下文。
		 */
		function mountSettingsCard(ctx) {
			const P = loadPrimitives();
			if (!P) return;
			let scope;
			try {
				scope = ctx.configForms.get(ENTRY_ID);
			} catch (error) {
				console.warn("[mc-gradle-runner] 配置条目不可用，跳过配置卡", error);
				return;
			}

			const specs = [
				boolSpec("enabled"),
				boolSpec("showButtons"),
				boolSpec("exposeTools"),
				boolSpec("allowGradleTaskQuery"),
				enumSpec("daemonMode", ["no-daemon", "daemon"]),
				enumSpec("duplicatePolicy", ["reject", "reuse", "replace", "allow"]),
				P.settingsTextField("gradleRoot"),
				P.settingsNumberField("dataTimeoutMs"),
				P.settingsNumberField("taskQueryTimeoutMs"),
				P.settingsNumberField("outputLimitBytes"),
				P.settingsNumberField("maxDiffFiles"),
				P.settingsNumberField("diffHunkLines"),
			];
			const form = new P.SettingsFormModel(scope, specs);
			ctx.effect(() => () => form.dispose(), "mc-gradle-runner: config form");

			// 把 shell()（dirty/invalid/saving…）和每个字段的 {text, overridden, invalid}
			// 合成一个快照；组件通过 hooks 拿到的就是这个对象。
			const store = form.bind(() => {
				const fields = {};
				for (const spec of specs) fields[spec.field] = form.field(spec.field);
				return { ...form.shell(), ...fields };
			});

			// 编辑/重置/保存/放弃四个写操作。actions() 返回绑定在模型实例上的闭包，
			// 取一次即可；同样的对象也会注入给槽位组件（见下方 inject）。
			const { edit, resetField, save, discard } = form.actions();

			/**
			 * 一行开关：Switch + 可见标签 + 说明。
			 *
			 * 注意：`Switch` 的 `label` prop 只写进 `aria-label`，**不渲染任何可见文字**
			 * （见 primitives 的实现）。早先这里把标签传给 Switch、把说明当唯一可见文字，
			 * 结果四行开关在界面上只剩说明、认不出哪个是哪个。所以标签在这里自己画，
			 * Switch 只拿它当无障碍名。
			 */
			const switchRow = (state, name, label, hint) => h(
				"div",
				{
					key: name,
					style: { display: "flex", alignItems: "flex-start", gap: 10 },
				},
				h(P.Switch, {
					checked: state[name].text === "true",
					label,
					disabled: !state.writable || state.saving,
					onChange: (next) => edit(name, String(next)),
				}),
				h("div", {
					style: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
				},
					h("span", {
						style: { color: C.label, fontSize: 13, lineHeight: "20px" },
					}, label),
					hint ? h("span", {
						style: { color: C.labelDim, fontSize: 12, lineHeight: "18px" },
					}, hint) : null,
				),
			);

			/** 一个文本/数值字段。state[name] 展开就是 text/overridden/invalid 三件套。 */
			const valueField = (state, name, label, extra) => h(P.SettingsValueField, {
				id: `mcrun-${name}`,
				label,
				disabled: !state.writable || state.saving,
				overriddenLabel: "已覆盖",
				resetLabel: "重置",
				invalidLabel: "取值不合法",
				onEdit: (text) => edit(name, text),
				onReset: () => resetField(name),
				...state[name],
				...(extra || {}),
			});

			/**
			 * 配置卡本体。
			 *
			 * view === 'summary' 时宿主只想要一行摘要；'page' 才渲染表单。
			 * 写操作直接用上面的闭包，不依赖宿主传进来的 props。
			 */
			function McRunSettingsCard(props) {
				const state = props.useMcRunSettings((snapshot) => snapshot);
				if (props.view === "summary") {
					const enabled = state.enabled?.text === "true";
					const buttons = state.showButtons?.text === "true";
					return h("span", { style: { color: C.labelDim } },
						`${enabled ? "已启用" : "已停用"} · ${buttons ? "显示按钮" : "隐藏按钮"}`);
				}
				return h(P.SettingsForm, {
					state,
					labels: FORM_LABELS,
					onSave: save,
					onDiscard: discard,
				}, h("div", {
					key: "fields",
					style: { display: "flex", flexDirection: "column", gap: 12 },
				},
					switchRow(state, "enabled", "启用插件", "总开关。关闭后不注册工具，也不显示快捷按钮。"),
					switchRow(state, "showButtons", "显示快捷按钮", "在会话头部右上角显示 run* 按钮组。"),
					switchRow(state, "exposeTools", "向模型暴露工具", "关闭后 mc_run_* 不出现在工具列表里（按钮仍可用）。"),
					switchRow(state, "allowGradleTaskQuery", "允许查询 Gradle 任务清单", "用 gradlew tasks 取权威清单，首次约需数秒，结果会缓存。"),
					valueField(state, "daemonMode", "Gradle daemon", {
						hint: "no-daemon：进程树可控，关闭按钮能真正杀掉游戏进程（推荐）。",
						placeholder: "no-daemon",
					}),
					valueField(state, "duplicatePolicy", "同名任务策略", {
						hint: "reject / reuse / replace / allow，默认 reject。",
						placeholder: "reject",
					}),
					valueField(state, "gradleRoot", "Gradle 根目录", {
						hint: "留空则自动探测；相对路径按会话工作目录解析。",
						placeholder: "自动探测",
					}),
					valueField(state, "dataTimeoutMs", "runData 超时（毫秒）", { numeric: true }),
					valueField(state, "taskQueryTimeoutMs", "任务清单查询超时（毫秒）", { numeric: true }),
					valueField(state, "outputLimitBytes", "输出上限（字节）", { numeric: true }),
					valueField(state, "maxDiffFiles", "diff 文件上限", { numeric: true }),
					valueField(state, "diffHunkLines", "每个 diff 展示的行数", { numeric: true }),
				));
			}

			ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: BUNDLE_KEY,
				inject: () => ({ hooks: { mcRunSettings: store } }),
			}, McRunSettingsCard));
		}

		/**
		 * 客户端半身入口。
		 *
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			// 会话头部右上角的 run* 工具栏。
			//
			// order 取 -100：该槽位升序排列，既有占用者里最小的是 -10（open-in-app），
			// 因此 -100 保证本工具栏落在所有其他控件的最左端。
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "mc-gradle-runner",
				order: -100,
				label: "MC Gradle",
			}, McRunToolbar));

			// ---- 右侧栏实时日志页签 ----
			//
			// 三层都要注册才成一个能打开的页签：页签类型（sidebarRightTabs）、
			// 正文槽位、标题槽位。全部走官方服务，不做 DOM 猴补。
			//
			// 用嵌套 ctx.inject 而不是顶层 inject 数组：这两个服务缺席时，
			// 插件其余部分（工具栏、设置页）应当照常工作，只少一个日志面板。
			ctx.inject(["sidebarRightTabs", "slots"], (sidebarCtx) => {
				sidebarCtx.effect(() => sidebarCtx.sidebarRightTabs.register({
					id: TAB_ID,
					kind: TAB_KIND,
					// 一个会话只需要一个日志页签：反复点运行只是切换页签内容，
					// 而不是把右栏堆满 N 个终将过期的页签。
					multiple: false,
					// extension 段位高于 builtin，且本 kind 是私有值，不会与内置冲突。
					priority: "extension",
					title: () => TITLE_TEXT,
				}), "mc-gradle-runner: sidebar tab type");

				sidebarCtx.effect(() => sidebarCtx.slots.inject("sidebar.right.pane.tab", () => sidebarCtx.slots.register({
					name: "sidebar.right.pane.tab",
					key: TAB_ID,
				}, McRunLogPanel)), "mc-gradle-runner: sidebar tab body");

				// 标题槽位的 key 同样必须是页签类型 id；seats 已把 tabInfo 钩子
				// 声明给子槽位，注册者无需自己接。
				sidebarCtx.effect(() => sidebarCtx.slots.inject("sidebar.right.pane.tab.title", () => sidebarCtx.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: TAB_ID,
				}, McRunLogTitle)), "mc-gradle-runner: sidebar tab title");
			});

			ctx.inject(["sidebarRight"], (sidebarCtx) => {
				/**
				 * 在指定会话打开（或聚焦）本插件的日志页签。
				 *
				 * openTabIn 对「会话尚未 adopted」是静默 no-op，因此这里不需要
				 * 处理"右栏还没挂载"的情况——顶多是这次没打开。
				 *
				 * @param sessionId - 目标会话。
				 * @param options.jobId - 要锁定的任务 id，缺省时面板列出全部任务。
				 * @param options.task - 用于标题的 Gradle 任务名。
				 */
				openRunLogTab = (sessionId, options) => {
					try {
						sidebarCtx.sidebarRight.openTabIn(sessionId, TAB_KIND, {
							params: { jobId: options?.jobId, task: options?.task },
						});
					} catch (error) {
						// 页签类型没注册成功（例如别的插件占了同名 kind）时不要让
						// 整个运行流程炸掉：任务已经在后台跑了，日志面板少了而已。
						console.warn("[mc-gradle-runner] 打开日志页签失败：", error);
					}
				};
				return () => {
					openRunLogTab = undefined;
				};
			});

			// 插件配置页表单。不放进顶层 inject：缺 configForms 时只跳过设置页，
			// 不能让工具栏跟着一起消失。
			ctx.inject(["configForms"], (settingsCtx) => mountSettingsCard(settingsCtx));
		}

		exports.McRunToolbar = McRunToolbar;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
