window.__ModuleLoader__.load({
	id: "dsh-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react_dom = require("react-dom");
		var react = require("react");
		//#region dsh-usage/client.css
		/**
		 * 样式全部走一套自己的 class 前缀（dshu-），但颜色一律引用 dsh 主题的
		 * `--dsw-*` 变量并带浅色兜底值 —— 这样跟着主题走，也不会因为变量缺失变透明。
		 */
		const css =
			".dshu-root{display:flex;width:100%;min-width:0}" +
			".dshu-trigger{display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6478);font:inherit;font-size:13px;line-height:1;cursor:pointer;text-align:left;transition:background .15s ease,color .15s ease}" +
			".dshu-trigger:hover,.dshu-trigger:focus-visible{background:var(--dsw-alias-fill-l2,rgba(22,32,58,.06));color:var(--dsw-alias-label-primary,#1b2130);outline:none}" +
			".dshu-trigger.dshu-open{background:var(--dsw-alias-fill-l2,rgba(22,32,58,.06));color:var(--dsw-alias-label-primary,#1b2130)}" +
			".dshu-trigger.dshu-rail{justify-content:center;padding:0}" +
			".dshu-icon{display:flex;align-items:flex-end;gap:1.5px;height:14px;flex:none}" +
			".dshu-icon i{display:block;width:3px;border-radius:1px;background:currentColor}" +
			".dshu-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}" +
			".dshu-badge{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a93a8);font-variant-numeric:tabular-nums}" +
			".dshu-backdrop{position:fixed;inset:0;z-index:9000;background:transparent}" +
			".dshu-panel{position:fixed;z-index:9001;box-sizing:border-box;width:min(460px,calc(100vw - 28px));max-height:min(80vh,660px);overflow:auto;overscroll-behavior:contain;padding:16px 18px 14px;border-radius:16px;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-primary,#1b2130);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(16,24,40,.20));font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;font-size:13px;line-height:1.6;-webkit-user-select:none;user-select:none}" +
			".dshu-head{display:flex;align-items:center;gap:10px}" +
			".dshu-title{flex:1;font-size:14px;font-weight:600}" +
			".dshu-btn{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.14));border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6478);font:inherit;font-size:12px;line-height:1;cursor:pointer}" +
			".dshu-btn:hover{color:var(--dsw-alias-label-primary,#1b2130);border-color:rgba(22,32,58,.30)}" +
			".dshu-sum{display:flex;align-items:baseline;gap:8px;margin-top:10px}" +
			".dshu-sumNum{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}" +
			".dshu-sumUnit{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a93a8)}" +
			".dshu-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px}" +
			".dshu-legendItem{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6478);max-width:100%}" +
			".dshu-legendName{max-width:150px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}" +
			".dshu-swatch{flex:none;width:10px;height:10px;border-radius:3px}" +
			".dshu-legendNum{color:var(--dsw-alias-label-tertiary,#8a93a8);font-variant-numeric:tabular-nums}" +
			".dshu-chart{display:flex;align-items:stretch;justify-content:center;gap:5px;height:168px;margin-top:14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.10))}" +
			".dshu-col{flex:1 1 0;min-width:0;max-width:20px;display:flex;flex-direction:column;height:100%}" +
			".dshu-bar{flex:1;display:flex;flex-direction:column-reverse;min-height:0;border-radius:3px 3px 0 0;overflow:hidden}" +
			".dshu-seg{flex:none;width:100%;transition:filter .12s ease}" +
			".dshu-seg:hover{filter:brightness(.94)}" +
			".dshu-segEmpty{flex:none;width:100%;height:3px;border-radius:2px;background:rgba(22,32,58,.12)}" +
			".dshu-dayEmpty{opacity:.5}" +
			".dshu-dayLabel{margin-top:6px;height:14px;font-size:10px;line-height:14px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a93a8);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}" +
			".dshu-tip{position:fixed;z-index:9002;transform:translate(-50%,-100%);margin-top:-10px;padding:8px 11px;border-radius:10px;background:rgba(23,29,44,.95);color:#fff;font-size:12px;line-height:1.75;white-space:nowrap;box-shadow:0 10px 26px rgba(16,24,40,.30);pointer-events:none}" +
			".dshu-tipHead{display:flex;align-items:center;gap:8px;font-weight:600}" +
			".dshu-tipHeadTotal{margin-left:auto;font-weight:400;color:rgba(255,255,255,.62);font-variant-numeric:tabular-nums}" +
			".dshu-tipList{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:3px 10px;margin-top:6px}" +
			".dshu-tipName{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}" +
			".dshu-tipNum{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}" +
			".dshu-tipPct{color:rgba(255,255,255,.62);font-variant-numeric:tabular-nums;text-align:right}" +
			".dshu-tipSwatch{flex:none;width:9px;height:9px;border-radius:2px}" +
			".dshu-tipDim{color:rgba(255,255,255,.62)}" +
			".dshu-empty{padding:40px 0;text-align:center;color:var(--dsw-alias-label-tertiary,#8a93a8);font-size:12px;line-height:1.9}" +
			".dshu-foot{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.10));font-size:11px;color:var(--dsw-alias-label-caption,#98a0b3);line-height:1.75}" +
			".dshu-path{font-family:ui-monospace,Consolas,'Courier New',monospace;color:var(--dsw-alias-label-tertiary,#8a93a8);word-break:break-all}" +
			".dshu-warn{color:#b45309}";
		const tagId = "dsh-usage/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-usage";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region dsh-usage/client/index.js
		/** 宿主侧注册的读取接口（走 connection 的鉴权通道，同源 fetch 即可）。 */
		const API_PATH = "/api/usage.data";
		/**
		 * 模型配色：按「全期用量从多到少」分配，柱子与图例用同一份顺序，永远一致。
		 *
		 * 刻意走**柔和**的浅色系（天蓝/浅绿/杏黄…），不用饱和深色 —— 一天一根柱子
		 * 挨着排，深色堆一片会压得整块图很闷。相邻两位取了不同色相，叠在一起也分得开。
		 */
		const PALETTE = [
			"#6cb6f5",
			"#6ecf9e",
			"#f2b96b",
			"#a892f0",
			"#f2949f",
			"#5fc9c3",
			"#b5d96b",
			"#f0a184",
			"#8fa8f2",
			"#d3a0e8"
		];
		/** 柱状图固定画多少天：横轴永远是「今天往前 MAX_DAYS 天」，没数据的那天画占位。 */
		const MAX_DAYS = 15;
		/** 打开面板时的轮询间隔。 */
		const POLL_MS = 5000;
		const WAN = 1e4;
		const YI = 1e8;
		/** 四舍五入后就会到 1 亿的那个点 —— 用来避免写出「10000.0 万」。 */
		const YI_CUTOFF = 9999.5 * WAN;
		const h = react.createElement;

		/**
		 * 用量单位：不到 1 亿走「万」，到 1 亿进位成「亿」。
		 *
		 * 按**单个数值**自动选单位，不做全局面板统一：一个模型 1.2 亿、另一个
		 * 3000 万时，各显示各的读起来更顺；硬统一会冒出「0.30 亿」这种数字。
		 */
		function measure(tokens) {
			const value = Number(tokens) || 0;
			if (value >= YI_CUTOFF) return { value: value / YI, unit: "亿" };
			return { value: value / WAN, unit: "万" };
		}

		/** 数值本身的有效位：上千不留小数，小数则保两位。 */
		function formatValue(value) {
			if (value >= 1e3) return value.toFixed(0);
			if (value >= 100) return value.toFixed(1);
			return value.toFixed(2);
		}

		/** 「1.23 亿」/「456.7 万」。 */
		function formatAmount(tokens) {
			const amount = measure(tokens);
			return formatValue(amount.value) + " " + amount.unit;
		}

		function formatShare(part, whole) {
			if (!whole) return "0%";
			const pct = (part / whole) * 100;
			return (pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)) + "%";
		}

		/** 数据文件大小（脚注里显示，让你知道账本多大）。 */
		function formatSize(bytes) {
			const value = Number(bytes) || 0;
			if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB";
			if (value >= 1024) return (value / 1024).toFixed(1) + " KB";
			return value + " B";
		}

		/** 数据文件的最后修改时间：今天只给时分，别的日子补月日。 */
		function formatStamp(iso) {
			if (typeof iso !== "string" || iso.length === 0) return "";
			const parsed = new Date(iso);
			if (Number.isNaN(parsed.getTime())) return "";
			const pad = (value) => String(value).padStart(2, "0");
			const clock = pad(parsed.getHours()) + ":" + pad(parsed.getMinutes()) + ":" + pad(parsed.getSeconds());
			const now = new Date();
			const sameDay =
				parsed.getFullYear() === now.getFullYear() &&
				parsed.getMonth() === now.getMonth() &&
				parsed.getDate() === now.getDate();
			return sameDay ? clock : pad(parsed.getMonth() + 1) + "-" + pad(parsed.getDate()) + " " + clock;
		}

		/**
		 * 横轴刻度：只写「日」，不写月份。
		 *
		 * 列宽被压到 20px（柱子要细），写「09-15」放不下会被 overflow 裁掉；
		 * 完整日期在 hover 气包和 `title` 里都有。
		 */
		function formatDay(date) {
			return typeof date === "string" && date.length === 10 ? date.slice(8) : String(date ?? "");
		}

		/** 本地日期键 YYYY-MM-DD（和宿主切天的口径一致：本地时区，不用 UTC）。 */
		function dateKey(date) {
			const pad = (value) => String(value).padStart(2, "0");
			return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
		}

		/**
		 * 横轴：从 anchor（今天是哪天）往前数 count 天的日期键。
		 *
		 * 天数在这里补齐，而不是拿账本里「有记录的天」来铺 —— 中间某天完全没调用过
		 * 模型时，账本里根本没有那一天，直接铺会让柱子错位、也看不出中间空了一段。
		 */
		function recentKeys(anchor, count) {
			const base = new Date(anchor + "T00:00:00");
			const keys = [];
			for (let back = count - 1; back >= 0; back -= 1) {
				const day = new Date(base);
				day.setDate(day.getDate() - back);
				keys.push(dateKey(day));
			}
			return keys;
		}

		/** 图例 + 柱子共用的配色表。 */
		function colorTable(models) {
			const colors = new Map();
			(models || []).forEach((model, index) => {
				colors.set(model.id, PALETTE[index % PALETTE.length]);
			});
			return colors;
		}

		/**
		 * 堆叠柱状图：横轴是固定的 MAX_DAYS 天（今天往前数），每天一根柱子，
		 * 柱子按模型分色自下而上堆叠。鼠标移到某一段上弹「模型 + 颜色 + 占比 + 用量」。
		 *
		 * 那天完全没有用量时不画柱子，只留一条浅色短横当占位 —— 日期照常出现在横轴上，
		 * 一眼能看出「那天没用过」，而不是柱子整体左移、看不出缺了哪天。
		 *
		 * 用的是普通 div + 百分比高度，不用 SVG/Canvas：hover 命中、气包容错、
		 * 主题变量继承都更省事，十几根柱子也没性能问题。
		 *
		 * 每根柱子都按**同一个全局模型顺序**（用量从多到少）自下而上铺色，某天缺某个
		 * 模型就跳过 —— 这样同一个颜色在各天永远落在同一层，横向比得起来。
		 */
		function UsageChart({ days, models, colors }) {
			const [tip, setTip] = react.useState(null);
			const scale = Math.max(
				1,
				...days.map((day) => day.total || 0)
			);
			/**
			 * 弹气泡：显示**这一整天**的全部模型，而不是鼠标底下那一块。
			 *
			 * 一行一个模型 —— 色点 + 模型名 + 用量 + 当日占比，四列靠 grid 对齐。
			 * 占比的分母是**当天**合计（不是全期）：柱子本来就是「一天一根」，
			 * 看的是那天各模型怎么分的。
			 */
			const show = (event, day) => {
				const rect = event.currentTarget.getBoundingClientRect();
				const rows = models
					.map((model) => ({ id: model.id, tokens: day.models[model.id]?.tokens ?? 0 }))
					.filter((row) => row.tokens > 0)
					.map((row) => ({ ...row, color: colors.get(row.id) ?? PALETTE[0] }));
				setTip({
					x: rect.left + rect.width / 2,
					y: rect.top,
					date: day.date,
					total: day.total || 0,
					rows
				});
			};
			const hide = () => setTip(null);
			/** 一天的一根柱子：有量就按模型从下往上叠色，没量就只给一条占位短横。 */
			const bars = (day) => {
				if (!(day.total > 0)) {
					return h("div", { className: "dshu-segEmpty", title: day.date + "：没有用量" });
				}
				return models.map((model) => {
					const tokens = day.models[model.id]?.tokens ?? 0;
					if (tokens <= 0) return null;
					return h("div", {
						key: model.id,
						className: "dshu-seg",
						style: {
							height: Math.max(2, (tokens / scale) * 100) + "%",
							background: colors.get(model.id) ?? PALETTE[0]
						}
					});
				});
			};
			return h(
				"div",
				null,
				h(
					"div",
					{ className: "dshu-chart" },
					days.map((day) =>
						h(
							"div",
							{
								className: "dshu-col",
								key: day.date,
								onMouseEnter: (event) => show(event, day),
								onMouseLeave: hide
							},
							h("div", { className: "dshu-bar" }, bars(day)),
							h(
								"div",
								{
									className: "dshu-dayLabel" + (day.total > 0 ? "" : " dshu-dayEmpty"),
									title: day.date
								},
								formatDay(day.date)
							)
						)
					)
				),
				tip === null
					? null
					: h(
							"div",
							{ className: "dshu-tip", style: { left: tip.x, top: tip.y } },
							h(
								"div",
								{ className: "dshu-tipHead" },
								tip.date,
								tip.total > 0
									? h("span", { className: "dshu-tipHeadTotal" }, "合计 " + formatAmount(tip.total))
									: null
							),
							tip.rows.length > 0
								? h(
										"div",
										{ className: "dshu-tipList" },
										tip.rows.map((row) =>
											h(
												react.Fragment,
												{ key: row.id },
												h("span", { className: "dshu-tipSwatch", style: { background: row.color } }),
												h("span", { className: "dshu-tipName", title: row.id }, row.id),
												h("span", { className: "dshu-tipNum" }, formatAmount(row.tokens)),
												h("span", { className: "dshu-tipPct" }, formatShare(row.tokens, tip.total))
											)
										)
									)
								: h("div", { className: "dshu-tipDim" }, "没有用量")
						)
			);
		}

		/** 面板本体：头 + 总量 + 图例 + 柱状图 + 脚注。 */
		function UsagePanel({ state, anchor, onRefresh, onClose }) {
			const data = state.data;
			const models = data?.models ?? [];
			const total = data?.total ?? 0;
			// 横轴固定 MAX_DAYS 天（今天往前数）：账本里根本没有的那天补成 0，画成占位短横
			const recorded = new Map((data?.days ?? []).map((day) => [day.date, day]));
			const days = recentKeys(data?.today || dateKey(new Date()), MAX_DAYS).map(
				(date) => recorded.get(date) ?? { date, total: 0, models: {} }
			);
			const totalAmount = measure(total);
			const file = data?.file;
			const colors = colorTable(models);
			return h(
				"div",
				{ className: "dshu-panel", style: anchor, role: "dialog", "aria-label": "Token 用量" },
				h(
					"div",
					{ className: "dshu-head" },
					h("span", { className: "dshu-title" }, "Token 用量"),
					h("button", { type: "button", className: "dshu-btn", onClick: onRefresh }, state.phase === "loading" ? "读取中…" : "刷新"),
					h("button", { type: "button", className: "dshu-btn", onClick: onClose }, "关闭")
				),
				state.phase === "error"
					? h("div", { className: "dshu-sum" }, h("span", { className: "dshu-warn" }, "读取失败：" + state.error + "（显示的是上一次的结果）"))
					: null,
				h(
					"div",
					{ className: "dshu-sum" },
					h("span", { className: "dshu-sumNum" }, formatValue(totalAmount.value)),
					h("span", { className: "dshu-sumUnit" }, totalAmount.unit + " token 累计"),
					h("span", { className: "dshu-sumUnit" }, models.length > 0 ? "· " + models.length + " 个模型" : "")
				),
				total <= 0
					? h(
							"div",
							{ className: "dshu-empty" },
							"还没有采集到用量。",
							h("br", null),
							"插件只统计「安装之后」新发生的模型调用；发起一轮对话后这里就会有数据。"
						)
					: h(
							react.Fragment,
							null,
							h(
								"div",
								{ className: "dshu-legend" },
								models.map((model) =>
									h(
										"span",
										{ className: "dshu-legendItem", key: model.id },
										h("span", { className: "dshu-swatch", style: { background: colors.get(model.id) } }),
										h("span", { className: "dshu-legendName", title: model.id }, model.id),
										h("span", { className: "dshu-legendNum" }, formatAmount(model.tokens)),
										h("span", { className: "dshu-legendNum" }, formatShare(model.tokens, total))
									)
								)
							),
							h(UsageChart, { days, models, colors })
						),
				h(
					"div",
					{ className: "dshu-foot" },
					"数据文件：",
					file?.path ? h("span", { className: "dshu-path", title: file.path }, file.path) : "（还没生成）",
					file?.mtime
						? h(
								"span",
								{ className: "dshu-legendNum" },
								" · " + formatStamp(file.mtime) + " 写入 · " + formatSize(file.size)
							)
						: null
				)
			);
		}

		/**
		 * 左下角「设置上方」的入口。
		 *
		 * 它挂在侧边栏的 `sidebar.footer.action` 上 —— 那个 slot 在 DOM 里排在
		 * `sidebar.settings` **之前**，而侧边栏底栏是 flex-column，所以这个入口
		 * 天然就在设置按钮上方（展开是整行，收起成 56px 轨道时只剩图标）。
		 *
		 * 面板用 createPortal 挂到 body 上并 `position: fixed`：侧边栏有
		 * overflow / transform 动画，留在原位会被裁掉。
		 */
		function UsageFooterAction({ wide }) {
			const [open, setOpen] = react.useState(false);
			const [anchor, setAnchor] = react.useState(null);
			const [state, setState] = react.useState({ phase: "loading", data: null, error: "" });
			const triggerRef = react.useRef(null);
			const controllerRef = react.useRef(null);

			const load = react.useCallback(() => {
				controllerRef.current?.abort();
				const controller = new AbortController();
				controllerRef.current = controller;
				setState((previous) => ({ ...previous, phase: previous.data ? "refreshing" : "loading" }));
				fetch(API_PATH, { signal: controller.signal, cache: "no-store" })
					.then((response) => {
						if (!response.ok) throw new Error("HTTP " + response.status);
						return response.json();
					})
					.then((data) => {
						if (!controller.signal.aborted) setState({ phase: "ready", data, error: "" });
					})
					.catch((error) => {
						if (controller.signal.aborted) return;
						setState((previous) => ({
							phase: "error",
							data: previous.data,
							error: String(error?.message ?? error)
						}));
					});
			}, []);

			// 入口上顺手显示今天的用量，所以挂载就读一次
			react.useEffect(() => {
				load();
				return () => controllerRef.current?.abort();
			}, [load]);

			// 打开时才轮询，关掉就停
			react.useEffect(() => {
				if (!open) return undefined;
				load();
				const timer = window.setInterval(load, POLL_MS);
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKey);
				return () => {
					window.clearInterval(timer);
					document.removeEventListener("keydown", onKey);
					controllerRef.current?.abort();
				};
			}, [open, load]);

			const toggle = () => {
				const rect = triggerRef.current?.getBoundingClientRect();
				// 贴着入口右边缘展开、与入口底边对齐 —— 侧边栏在左边，面板自然落到右侧
				setAnchor(
					rect
						? { left: Math.min(rect.right + 10, window.innerWidth - 60), bottom: Math.max(12, window.innerHeight - rect.bottom) }
						: { left: 72, bottom: 24 }
				);
				setOpen((current) => !current);
			};

			const today = state.data?.today;
			const todayTokens = state.data?.days?.find((day) => day.date === today)?.total ?? 0;
			const badge = state.data === null ? "" : formatAmount(todayTokens);

			return h(
				react.Fragment,
				null,
				h(
					"div",
					{ className: "dshu-root" },
					h(
						"button",
						{
							ref: triggerRef,
							type: "button",
							className: "dshu-trigger" + (wide ? "" : " dshu-rail") + (open ? " dshu-open" : ""),
							title: "Token 用量",
							"aria-label": "Token 用量",
							"aria-haspopup": "dialog",
							"aria-expanded": open,
							onClick: toggle
						},
						h(
							"span",
							{ className: "dshu-icon", "aria-hidden": "true" },
							h("i", { style: { height: 5 } }),
							h("i", { style: { height: 9 } }),
							h("i", { style: { height: 13 } })
						),
						wide ? h("span", { className: "dshu-label" }, "Token 用量") : null,
						wide && badge ? h("span", { className: "dshu-badge", title: "今天" }, badge) : null
					)
				),
				open && anchor !== null
					? react_dom.createPortal(
							h(
								react.Fragment,
								null,
								h("div", { className: "dshu-backdrop", onClick: () => setOpen(false) }),
								h(UsagePanel, {
									state,
									anchor,
									onRefresh: load,
									onClose: () => setOpen(false)
								})
							),
							document.body
						)
					: null
			);
		}

		/** 本插件需要的客户端服务：只有 slot 注册表。 */
		const inject = ["slots"];

		/**
		 * 把入口挂到侧边栏底栏。
		 *
		 * 用 `slots.inject(name, cb)` 而不是直接 register：槽位是 ui-sidebar 声明的，
		 * 谁先加载不确定，声明感知的注入保证两边顺序颠倒也能生效（和 ui-jobs 一致）。
		 *
		 * @param ctx - 客户端 root context。
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "usage",
						order: 50
					},
					UsageFooterAction
				)
			);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
