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
		function FallbackIcon({ path, size }) {
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
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

			/** 起任务。 */
			const run = useCallback(async (kind) => {
				const target = targetFor(kind);
				if (target === undefined) {
					setError(`没有可用的 ${kind} 目标`);
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
			}, [targetFor, sessionId, refreshJobs]);

			/** 取消任务。 */
			const stop = useCallback(async (jobId) => {
				setBusy(true);
				const result = await callApi({ action: "kill", job_id: jobId, sessionId });
				setBusy(false);
				if (result.error !== undefined) setError(result.error);
				await refreshJobs();
			}, [sessionId, refreshJobs]);

			/** 选中某个目标：同时记住它的模块，让两个按钮跟随同一个模块。 */
			const choose = useCallback((target) => {
				const next = { projectPath: target.projectPath, task: target.task };
				setSelection(next);
				saveSelection(sessionId, next);
				setMenuOpen(false);
			}, [sessionId]);

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

			// 探测完成前不渲染，避免非 Gradle 会话闪一下空壳。
			if (!probed) return null;
			// 主机说不可用就彻底不渲染。
			//
			// 这是本组件的显示契约：**只有发现到可用的 MC Gradle 目标时按钮才存在**。
			// 因此非 Gradle 项目的会话里不会留下任何痕迹，也不会出现
			// “按钮在、点下去报错”的情况。探测失败同理不渲染。
			if (!available) return null;

			const clientTarget = targetFor("client");
			const dataTarget = targetFor("data");
			const running = live[0];
			const finished = jobs.filter((job) => job.status !== "running" && job.status !== "stopping").slice(-1)[0];
			const current = running ?? finished;

			/** 一个 run 按钮：图标 + 任务名，禁用态不写 action。 */
			const runButton = (kind, label, target) => h("button", {
				type: "button",
				disabled: target === undefined || busy,
				title: target === undefined ? `未发现 ${label} 目标` : `${label}：${target.task}`,
				"aria-label": target === undefined ? `无 ${label} 目标` : `运行 ${target.task}`,
				onClick: () => void run(kind),
				style: buttonStyle({
					opacity: target === undefined ? 0.45 : 1,
					cursor: target === undefined ? "not-allowed" : "pointer",
				}),
				onMouseEnter: (event) => {
					if (target !== undefined && !busy) event.currentTarget.style.background = C.hover;
				},
				onMouseLeave: (event) => {
					event.currentTarget.style.background = "transparent";
				},
			}, h(KindIcon, { kind, size: 13 }), label);

			return h("div", { style: ROOT_STYLE, "data-dsh-mc-runner": "toolbar" },
				// 主操作：runClient。图标用品牌色，和 IDEA 的绿色播放键同一个视觉位。
				h("span", { style: { display: "inline-flex", color: C.brand } }, runButton("client", "Client", clientTarget)),
				runButton("data", "Data", dataTarget),
				// 目标选择器：CTNH 这类多模块仓库靠它切换模块。
				h("button", {
					ref: menuAnchorRef,
					type: "button",
					"aria-haspopup": "menu",
					"aria-expanded": menuOpen,
					"aria-label": "选择 Gradle 目标",
					title: root === undefined ? "选择目标" : `项目根：${root}`,
					onClick: () => setMenuOpen((open) => !open),
					style: buttonStyle({ padding: "0 4px", color: menuOpen ? C.label : C.labelDim }),
					onMouseEnter: (event) => {
						event.currentTarget.style.background = C.hover;
					},
					onMouseLeave: (event) => {
						event.currentTarget.style.background = "transparent";
					},
				}, h(FallbackIcon, { path: PATH_CHEVRON, size: 13 })),

				// 运行状态 + 停止。
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
							? `${running.task.split(":").pop()} ${formatElapsed(now - running.startedAt)}`
							: current.status === "completed" ? "完成" : current.status === "failed" ? "失败" : "已取消",
					),
					running !== undefined && h("button", {
						type: "button",
						disabled: busy,
						"aria-label": `停止 ${running.task}`,
						title: `停止 ${running.task}`,
						onClick: () => void stop(running.id),
						style: buttonStyle({ color: C.error }),
						onMouseEnter: (event) => {
							event.currentTarget.style.background = C.hover;
						},
						onMouseLeave: (event) => {
							event.currentTarget.style.background = "transparent";
						},
					}, h(FallbackIcon, { path: PATH_STOP, size: 12 })),
				),

				// 目标菜单。
				menuOpen && menuPosition !== undefined && h("div", {
					ref: menuRef,
					role: "menu",
					"aria-label": "Gradle run 目标",
					style: { ...MENU_STYLE, ...menuPosition },
				},
					root !== undefined && h("div", { style: MENU_GROUP_STYLE }, `项目根：${root}`),
					["client", "data", "server"].map((kind) => {
						const ofKind = targets.filter((target) => target.kind === kind);
						if (ofKind.length === 0) return null;
						const title = kind === "client" ? "运行客户端" : kind === "data" ? "数据生成" : "运行服务端";
						return h("div", { key: kind },
							h("div", { style: MENU_GROUP_STYLE }, title),
							ofKind.map((target) => {
								const active = target.task === (kind === "client" ? clientTarget?.task
									: kind === "data" ? dataTarget?.task : undefined);
								return h("button", {
									key: target.task,
									type: "button",
									role: "menuitemradio",
									"aria-checked": active === true,
									onClick: () => choose(target),
									style: menuItemStyle(active === true),
								},
									h(KindIcon, { kind, size: 12 }),
									h("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } }, target.task),
								);
							}),
						);
					}),
					// 非 client/data 的目标（自定义 run* 任务）单列一组。
					targets.some((target) => target.kind === "other") && h("div", null,
						h("div", { style: MENU_GROUP_STYLE }, "其他 run 任务"),
						targets.filter((target) => target.kind === "other").map((target) => h("button", {
							key: target.task,
							type: "button",
							role: "menuitem",
							onClick: () => choose(target),
							style: menuItemStyle(false),
						}, h(KindIcon, { kind: "other", size: 12 }), target.task)),
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

			/** 一行开关：Switch + 说明。 */
			const switchRow = (state, name, label, hint) => h(
				"div",
				{ key: name, style: { display: "flex", alignItems: "flex-start", gap: 8 } },
				h(P.Switch, {
					checked: state[name].text === "true",
					label,
					disabled: !state.writable || state.saving,
					onChange: (next) => edit(name, String(next)),
				}),
				hint ? h("span", {
					style: { color: C.labelDim, fontSize: 12, lineHeight: "20px" },
				}, hint) : null,
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
					switchRow(state, "enabled", "启用插件", "关闭后不注册工具，也不显示快捷按钮。"),
					switchRow(state, "showButtons", "显示快捷按钮", "会话头部右上角的 run* 按钮组。"),
					switchRow(state, "exposeTools", "向模型暴露工具", "关闭后 mc_run_* 不出现在工具列表里。"),
					switchRow(state, "allowGradleTaskQuery", "允许查询 Gradle 任务清单", "首次查询约需数秒，结果会缓存。"),
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
