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
			".dshu-panel{position:fixed;z-index:9001;box-sizing:border-box;width:640px;max-width:calc(100vw - 28px);max-height:min(80vh,660px);overflow:auto;overscroll-behavior:contain;padding:16px 18px 14px;border-radius:16px;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-primary,#1b2130);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(16,24,40,.20));font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;font-size:13px;line-height:1.6;-webkit-user-select:none;user-select:none}" +
			".dshu-head{display:flex;align-items:center;gap:10px}" +
			".dshu-title{flex:1;font-size:14px;font-weight:600}" +
			".dshu-btn{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.14));border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6478);font:inherit;font-size:12px;line-height:1;cursor:pointer}" +
			".dshu-btn:hover{color:var(--dsw-alias-label-primary,#1b2130);border-color:rgba(22,32,58,.30)}" +
			".dshu-sum{display:flex;align-items:baseline;gap:8px;margin-top:10px}" +
			".dshu-sumNum{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}" +
			".dshu-sumUnit{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a93a8)}" +
			".dshu-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px}" +
			".dshu-legendItem{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6478);max-width:100%}" +
			".dshu-legendName{max-width:220px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}" +
			".dshu-swatch{flex:none;width:10px;height:10px;border-radius:3px}" +
			".dshu-legendNum{color:var(--dsw-alias-label-tertiary,#8a93a8);font-variant-numeric:tabular-nums}" +
			".dshu-chart{display:flex;align-items:stretch;gap:6px;height:180px;margin-top:14px;padding:0 0 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.10))}" +
			".dshu-col{flex:1;min-width:0;display:flex;flex-direction:column;height:100%}" +
			".dshu-bar{flex:1;display:flex;flex-direction:column-reverse;min-height:0;border-radius:4px 4px 0 0;overflow:hidden}" +
			".dshu-seg{flex:none;width:100%;transition:filter .12s ease}" +
			".dshu-seg:hover{filter:brightness(1.18)}" +
			".dshu-dayLabel{margin-top:6px;height:14px;font-size:10px;line-height:14px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a93a8);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}" +
			".dshu-tip{position:fixed;z-index:9002;transform:translate(-50%,-100%);margin-top:-10px;padding:8px 11px;border-radius:10px;background:rgba(23,29,44,.95);color:#fff;font-size:12px;line-height:1.75;white-space:nowrap;box-shadow:0 10px 26px rgba(16,24,40,.30);pointer-events:none}" +
			".dshu-tipRow{display:flex;align-items:center;gap:6px}" +
			".dshu-tipSwatch{flex:none;width:9px;height:9px;border-radius:2px}" +
			".dshu-tipDim{color:rgba(255,255,255,.62)}" +
			".dshu-empty{padding:40px 0;text-align:center;color:var(--dsw-alias-label-tertiary,#8a93a8);font-size:12px;line-height:1.9}" +
			".dshu-foot{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.10));font-size:11px;color:var(--dsw-alias-label-caption,#98a0b3);line-height:1.75}" +
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
		/** 模型配色：按「全期用量从多到少」分配，柱子与图例用同一份顺序，永远一致。 */
		const PALETTE = [
			"#4d6bfe",
			"#119e6a",
			"#e8912d",
			"#8b5cf6",
			"#d63c4c",
			"#0ea5e9",
			"#7a9e1e",
			"#e5679b",
			"#0f766e",
			"#7c4dff"
		];
		/** 柱状图最多画多少天（宿主一次最多给 30 天，这里只取最后 14 天让柱子够宽）。 */
		const MAX_DAYS = 14;
		/** 打开面板时的轮询间隔。 */
		const POLL_MS = 5000;
		const WAN = 1e4;
		const h = react.createElement;

		/** 万 token，保留两位（用量按用户要求统一走「万」）。 */
		function formatWan(tokens) {
			const value = (Number(tokens) || 0) / WAN;
			if (value >= 1e3) return value.toFixed(0);
			if (value >= 100) return value.toFixed(1);
			return value.toFixed(2);
		}

		function formatShare(part, whole) {
			if (!whole) return "0%";
			const pct = (part / whole) * 100;
			return (pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)) + "%";
		}

		function formatClock(iso) {
			if (typeof iso !== "string" || iso.length === 0) return "";
			const parsed = new Date(iso);
			if (Number.isNaN(parsed.getTime())) return "";
			const pad = (value) => String(value).padStart(2, "0");
			return pad(parsed.getHours()) + ":" + pad(parsed.getMinutes());
		}

		function formatDay(date) {
			return typeof date === "string" && date.length === 10 ? date.slice(5) : String(date ?? "");
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
		 * 堆叠柱状图：横轴是最近 MAX_DAYS 天，每天一根柱子，柱子按模型分色自下而上堆叠。
		 * 鼠标移到某一段上，弹出「模型 + 颜色 + 占比 + 用量」的气泡。
		 *
		 * 用的是普通 div + 百分比高度，不用 SVG/Canvas：hover 命中、气包容错、
		 * 主题变量继承都更省事，13 根柱子也没性能问题。
		 *
		 * 每根柱子都按**同一个全局模型顺序**（用量从多到少）自下而上铺色，某天缺某个
		 * 模型就跳过 —— 这样同一个颜色在各天永远落在同一层，横向比得起来。
		 */
		function UsageChart({ days, models, colors, total }) {
			const [tip, setTip] = react.useState(null);
			const scale = Math.max(
				1,
				...days.map((day) => day.total || 0)
			);
			const show = (event, date, modelId, tokens) => {
				const rect = event.currentTarget.getBoundingClientRect();
				setTip({
					x: rect.left + rect.width / 2,
					y: rect.top,
					date,
					modelId,
					tokens,
					color: colors.get(modelId) ?? PALETTE[0],
					share: formatShare(tokens, total)
				});
			};
			const hide = () => setTip(null);
			return h(
				"div",
				null,
				h(
					"div",
					{ className: "dshu-chart" },
					days.map((day) =>
						h(
							"div",
							{ className: "dshu-col", key: day.date },
							h(
								"div",
								{ className: "dshu-bar" },
								models.map((model) => {
									const tokens = day.models[model.id]?.tokens ?? 0;
									if (tokens <= 0) return null;
									return h("div", {
										key: model.id,
										className: "dshu-seg",
										style: {
											height: Math.max(2, (tokens / scale) * 100) + "%",
											background: colors.get(model.id) ?? PALETTE[0]
										},
										onMouseEnter: (event) => show(event, day.date, model.id, tokens),
										onMouseLeave: hide
									});
								})
							),
							h("div", { className: "dshu-dayLabel", title: day.date }, formatDay(day.date))
						)
					)
				),
				tip === null
					? null
					: h(
							"div",
							{ className: "dshu-tip", style: { left: tip.x, top: tip.y } },
							h("div", { className: "dshu-tipRow" }, h("span", { style: { fontWeight: 600 } }, tip.modelId)),
							h(
								"div",
								{ className: "dshu-tipRow" },
								h("span", { className: "dshu-tipSwatch", style: { background: tip.color } }),
								h("span", { className: "dshu-tipDim" }, tip.color),
								h("span", { className: "dshu-tipDim" }, "· 占比 " + tip.share)
							),
							h(
								"div",
								{ className: "dshu-tipRow" },
								"用量 ",
								h("span", { style: { fontWeight: 600 } }, formatWan(tip.tokens) + " 万"),
								h("span", { className: "dshu-tipDim" }, " · " + tip.date)
							)
						)
			);
		}

		/** 面板本体：头 + 总量 + 图例 + 柱状图 + 脚注。 */
		function UsagePanel({ state, anchor, onRefresh, onClose }) {
			const data = state.data;
			const days = (data?.days ?? []).filter((day) => day.total > 0).slice(-MAX_DAYS);
			const models = data?.models ?? [];
			const total = data?.total ?? 0;
			const colors = colorTable(models);
			const clock = formatClock(data?.updatedAt);
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
					h("span", { className: "dshu-sumNum" }, formatWan(total)),
					h("span", { className: "dshu-sumUnit" }, "万 token 累计" + (clock ? " · " + clock + " 更新" : "")),
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
										h("span", { className: "dshu-legendNum" }, formatWan(model.tokens) + " 万"),
										h("span", { className: "dshu-legendNum" }, formatShare(model.tokens, total))
									)
								)
							),
							h(UsageChart, { days, models, colors, total })
						),
				h(
					"div",
					{ className: "dshu-foot" },
					"数据来源：模型返回的 usage（input + cache 读 + cache 写 + output），按本地日期切天、按模型分组，单位「万 token」。",
					h("br", null),
					"记录写在插件目录的 data/usage.json；柱子按天堆叠，鼠标移到色块上看模型、颜色、占比与用量。"
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
			const badge = state.data === null ? "" : formatWan(todayTokens) + " 万";

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
