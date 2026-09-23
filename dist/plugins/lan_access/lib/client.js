window.__ModuleLoader__.load({
	id: "dsh-lan-access",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react_dom = require("react-dom");
		var react = require("react");
		//#region dsh-lan-access/client.css
		/**
		 * 样式走自己的 class 前缀（dshl-），颜色一律引用 dsh 主题的 `--dsw-*` 变量并带
		 * 浅色兜底值 —— 跟着主题走，变量缺失时也不会变透明。
		 *
		 * `.dshl-root` 的 `flex:1 1 100%` 是**独占一行**用的：footerActions 是不换行的
		 * 行容器，配合组件里给父节点加的 `flex-wrap:wrap` 才生效，见 LanFooterAction。
		 */
		const css =
			".dshl-root{display:flex;flex:1 1 100%;min-width:0}" +
			".dshl-trigger{display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6478);font:inherit;font-size:13px;line-height:1;cursor:pointer;text-align:left;transition:background .15s ease,color .15s ease}" +
			".dshl-trigger:hover,.dshl-trigger:focus-visible{background:var(--dsw-alias-fill-l2,rgba(22,32,58,.06));color:var(--dsw-alias-label-primary,#1b2130);outline:none}" +
			".dshl-trigger.dshl-open{background:var(--dsw-alias-fill-l2,rgba(22,32,58,.06));color:var(--dsw-alias-label-primary,#1b2130)}" +
			".dshl-trigger.dshl-rail{justify-content:center;padding:0}" +
			".dshl-icon{flex:none;display:block}" +
			".dshl-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}" +
			".dshl-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#9aa4b8}" +
			".dshl-dot.dshl-on{background:#119e6a}" +
			".dshl-dot.dshl-bad{background:#c2410c}" +
			".dshl-state{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6478)}" +
			".dshl-state b{color:var(--dsw-alias-label-primary,#1b2130);font-weight:600}" +
			".dshl-hint{margin-top:10px;font-size:12px;line-height:1.9;color:var(--dsw-alias-label-secondary,#5b6478)}" +
			".dshl-backdrop{position:fixed;inset:0;z-index:9000;background:transparent}" +
			".dshl-panel{position:fixed;z-index:9001;box-sizing:border-box;width:min(392px,calc(100vw - 28px));max-height:min(86vh,760px);overflow:auto;overscroll-behavior:contain;padding:16px 18px 14px;border-radius:16px;background:var(--dsw-specific-menu,#fff);backdrop-filter:var(--dsw-menu-backdrop-filter,none);color:var(--dsw-alias-label-primary,#1b2130);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(16,24,40,.20));font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;font-size:13px;line-height:1.6;-webkit-user-select:none;user-select:none}" +
			".dshl-head{display:flex;align-items:center;gap:10px}" +
			".dshl-title{flex:1;font-size:14px;font-weight:600}" +
			".dshl-btn{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.14));border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6478);font:inherit;font-size:12px;line-height:1;cursor:pointer}" +
			".dshl-btn:hover{color:var(--dsw-alias-label-primary,#1b2130);border-color:rgba(22,32,58,.30)}" +
			".dshl-btn:disabled{opacity:.5;cursor:default}" +
			".dshl-qrBox{display:flex;justify-content:center;margin-top:12px;padding:12px;border-radius:12px;background:#fff;border:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.12))}" +
			".dshl-qr{display:block;width:216px;height:216px}" +
			".dshl-url{margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-fill-l2,rgba(22,32,58,.05));font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary,#5b6478);word-break:break-all;-webkit-user-select:text;user-select:text}" +
			".dshl-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}" +
			".dshl-primary{height:28px;padding:0 12px;border:0;border-radius:7px;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;font:inherit;font-size:12px;line-height:1;cursor:pointer}" +
			".dshl-primary:hover{filter:brightness(1.06)}" +
			".dshl-primary:disabled{opacity:.5;cursor:default;filter:none}" +
			".dshl-link{font-size:12px;color:var(--dsw-alias-brand-primary,#4d6bfe);text-decoration:none;align-self:center}" +
			".dshl-note{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.10));font-size:11px;line-height:1.9;color:var(--dsw-alias-label-caption,#98a0b3)}" +
			".dshl-note b{color:var(--dsw-alias-label-tertiary,#8a93a8);font-weight:500}" +
			".dshl-warn{margin-top:10px;padding:8px 10px;border-radius:8px;background:rgba(180,83,9,.10);color:#b45309;font-size:12px;line-height:1.8}" +
			".dshl-alt{margin-top:4px;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a93a8);word-break:break-all}" +
			".dshl-empty{padding:32px 0;text-align:center;color:var(--dsw-alias-label-tertiary,#8a93a8);font-size:12px;line-height:1.9}";
		const tagId = "dsh-lan-access/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-lan-access";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region dsh-lan-access/client/index.js
		/** 宿主侧注册的三个接口（走 connection 的鉴权通道，同源 fetch 即可）。 */
		const INFO_PATH = "/api/lan_access.info";
		const SET_PATH = "/api/lan_access.set";
		const RESET_PATH = "/api/lan_access.reset";
		const h = react.createElement;

		/**
		 * 把宿主生成的 SVG 二维码转成 img 能用的 data URL。
		 *
		 * 二维码在**宿主侧**生成（lib/qr.mjs），前端只负责显示 —— 浏览器半边没有
		 * 编码器，也不该为了显示一张图多背几百行代码。
		 */
		function qrDataUrl(svg) {
			if (typeof svg !== "string" || svg.length === 0) return "";
			return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
		}

		/** 二维码图标：三个定位方块 + 几个点，一眼能认出是二维码。 */
		function QrIcon() {
			const square = (x, y) =>
				h("path", { key: "s" + x + y, fill: "currentColor", d: "M" + x + " " + y + "h6v6h-6zm2 2v2h2v-2z" });
			const dot = (x, y) => h("rect", { key: "d" + x + y, x: x, y: y, width: 2, height: 2, fill: "currentColor" });
			return h(
				"svg",
				{ className: "dshl-icon", width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true", focusable: "false" },
				square(0, 0),
				square(8, 0),
				square(0, 8),
				dot(8, 8),
				dot(12, 8),
				dot(8, 12),
				dot(12, 12)
			);
		}

		/** 复制到剪贴板：局域网 http 下不是安全上下文，navigator.clipboard 可能没有，兜一个 execCommand。 */
		function copyText(text) {
			if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
				return navigator.clipboard.writeText(text).then(
					() => true,
					() => fallbackCopy(text)
				);
			}
			return Promise.resolve(fallbackCopy(text));
		}

		function fallbackCopy(text) {
			try {
				const area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand("copy");
				document.body.removeChild(area);
				return ok;
			} catch {
				return false;
			}
		}

		/**
		 * 面板本体：开关 + 状态 + 二维码 + 链接 + 操作 + 说明。
		 *
		 * 三种状态界面不一样，别混着写：
		 *   running             → 二维码能用，给「复制 / 打开 / 重置」
		 *   enabled && !running → 代理没起来（多半端口被占），给「重试 / 关闭」
		 *   !enabled            → 默认态，给一段说明 + 「开启局域网访问」
		 *
		 * 宿主侧的 `enabled` 是**用户意图**、`running` 是**代理真的在监听**，两者会分叉
		 * （端口被占时 enabled=true 但 running=false）—— 所以二维码只看 running，
		 * 不然会摆出一张扫了没反应的图。
		 */
		function LanPanel({ state, anchor, onRefresh, onReset, onToggle, onClose, resetting, toggling }) {
			const data = state.data;
			const url = data?.url ?? "";
			const enabled = data?.enabled === true;
			const running = data?.running === true;
			const [copied, setCopied] = react.useState(false);
			const [confirming, setConfirming] = react.useState(false);

			const copy = () => {
				copyText(url).then((ok) => {
					if (!ok) return;
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1600);
				});
			};

			const others = (data?.addresses ?? []).filter((entry) => entry.address !== data?.ip);
			const tone = running ? "on" : enabled ? "bad" : "";
			const status = running ? "已开启" : enabled ? "开启失败" : "未开启";

			/** 开关按钮。`next` 是目标状态 —— 关闭态点「重试」也是 true。 */
			const switchButton = (label, next) =>
				h(
					"button",
					{ type: "button", className: "dshl-primary", disabled: toggling, onClick: () => onToggle(next) },
					toggling ? "处理中…" : label
				);

			const linkActions =
				running && url.length > 0
					? h(
							"div",
							{ className: "dshl-actions" },
							h("button", { type: "button", className: "dshl-primary", onClick: copy }, copied ? "已复制" : "复制链接"),
							h("a", { className: "dshl-link", href: url, target: "_blank", rel: "noreferrer" }, "在浏览器打开"),
							confirming
								? h(
										react.Fragment,
										null,
										h(
											"button",
											{
												type: "button",
												className: "dshl-btn",
												disabled: resetting,
												onClick: () => {
													setConfirming(false);
													onReset();
												}
											},
											resetting ? "重置中…" : "确定重置"
										),
										h("button", { type: "button", className: "dshl-btn", onClick: () => setConfirming(false) }, "取消")
									)
								: h(
										"button",
										{
											type: "button",
											className: "dshl-btn",
											title: "换一个新访问码，已发出的旧链接立即失效",
											onClick: () => setConfirming(true)
										},
										"重置访问码"
									)
						)
					: null;

			return h(
				"div",
				{ className: "dshl-panel", style: anchor, role: "dialog", "aria-label": "局域网访问" },
				h(
					"div",
					{ className: "dshl-head" },
					h("span", { className: "dshl-title" }, "局域网访问"),
					h("button", { type: "button", className: "dshl-btn", onClick: onRefresh }, state.phase === "loading" ? "读取中…" : "刷新"),
					h("button", { type: "button", className: "dshl-btn", onClick: onClose }, "关闭")
				),

				state.phase === "error"
					? h("div", { className: "dshl-warn" }, "读取失败：" + state.error + "（显示的是上一次的结果）")
					: null,

				data === null
					? h("div", { className: "dshl-empty" }, "正在读取…")
					: h(
							react.Fragment,
							null,

							// 状态行常驻：开还是关，一眼就能看见
							h(
								"div",
								{ className: "dshl-state" },
								h("span", { className: "dshl-dot" + (tone.length > 0 ? " dshl-" + tone : "") }),
								h("b", null, status)
							),

							// 开不起来的原因（端口被占最常见）
							enabled && !running
								? h(
										"div",
										{ className: "dshl-warn" },
										"局域网代理没起来：" + (data.error || "未知原因"),
										h("br", null),
										"常见原因是 " + data.port + " 端口被别的程序占用。关掉占用的程序后点「重试」。"
									)
								: null,

							// 关着的时候：先说清楚这是什么、点了会发生什么
							!enabled
								? h(
										"div",
										{ className: "dshl-hint" },
										"开启后，同一个局域网里的手机扫二维码就能直接打开网页版。",
										h("br", null),
										"链接是固定的：只要这台电脑的内网 IP 不变，链接和二维码就不变。",
										h("br", null),
										"默认关闭；开启后会记住，下次启动自动恢复。"
									)
								: null,

							enabled && url.length === 0
								? h("div", { className: "dshl-empty" }, "没有找到可用的内网地址。", h("br", null), "确认电脑已连上局域网（WiFi 或有线）后点「刷新」。")
								: null,

							// 开关：主要动作放最上面，下面才是它的结果（二维码）
							h(
								"div",
								{ className: "dshl-actions" },
								enabled ? switchButton("关闭局域网访问", false) : switchButton("开启局域网访问", true),
								enabled && !running ? switchButton("重试", true) : null
							),

							running && url.length > 0
								? h(
										react.Fragment,
										null,
										h(
											"div",
											{ className: "dshl-qrBox" },
											h("img", { className: "dshl-qr", src: qrDataUrl(data.qr), width: 216, height: 216, alt: "局域网访问二维码" })
										),
										h("div", { className: "dshl-url", title: url }, url)
									)
								: null,

							linkActions,

							h(
								"div",
								{ className: "dshl-note" },
								"手机和电脑要在同一个局域网，用手机扫码或直接打开上面的链接。",
								h("br", null),
								h("b", null, "首次连不上？"),
								" 多半是 Windows 防火墙拦了入站：在「允许应用通过防火墙」里勾上本程序自带的 node.exe（私有网络）。",
								h("br", null),
								h("b", null, "注意："),
								" 这条链接等于本机的操作权限，局域网内拿到的人都能用；别外传，泄露了就点「重置访问码」。",
								" 不用的时候点「关闭局域网访问」，端口会立刻释放。",
								enabled && others.length > 0
									? h(
											"div",
											null,
											h("b", null, "其他网卡地址（换 IP 时可试）："),
											others.map((entry) =>
												h("div", { className: "dshl-alt", key: entry.address + entry.name }, entry.address + "  (" + entry.name + ")")
											)
										)
									: null
							)
						)
			);
		}

		/**
		 * 左下角「设置上方」的入口。
		 *
		 * 挂在侧边栏的 `sidebar.footer.action` 上 —— 那个 slot 在 DOM 里排在
		 * `sidebar.settings` **之前**，底栏是 flex-column，所以天然就在设置按钮上方。
		 * 面板用 createPortal 挂到 body 上并 position:fixed：侧边栏有 overflow / transform
		 * 动画，留在原位会被裁掉。
		 *
		 * 这个 slot 是 `kind:"list"`，注册项直接摊在 footerActions 里（没有额外包裹层），
		 * 而 footerActions 是**不换行**的行容器 —— 所以要和 usage 分两行，得自己动手，
		 * 见下面那个改父节点 flex-wrap 的 effect。
		 */
		function LanFooterAction({ wide }) {
			const [open, setOpen] = react.useState(false);
			const [anchor, setAnchor] = react.useState(null);
			const [state, setState] = react.useState({ phase: "loading", data: null, error: "" });
			const [resetting, setResetting] = react.useState(false);
			const [toggling, setToggling] = react.useState(false);
			const triggerRef = react.useRef(null);
			/** 根节点，用来往上找真正的 flex 行容器（见下面独占一行的 effect）。 */
			const rootRef = react.useRef(null);
			const controllerRef = react.useRef(null);

			const load = react.useCallback(() => {
				controllerRef.current?.abort();
				const controller = new AbortController();
				controllerRef.current = controller;
				setState((previous) => ({ ...previous, phase: previous.data ? "refreshing" : "loading" }));
				fetch(INFO_PATH, { signal: controller.signal, cache: "no-store" })
					.then((response) => {
						if (!response.ok) throw new Error("HTTP " + response.status);
						return response.json();
					})
					.then((data) => {
						if (!controller.signal.aborted) setState({ phase: "ready", data, error: "" });
					})
					.catch((error) => {
						if (controller.signal.aborted) return;
						setState((previous) => ({ phase: "error", data: previous.data, error: String(error?.message ?? error) }));
					});
			}, []);

			// 入口上要显示一个在线小圆点，所以挂载就读一次
			react.useEffect(() => {
				load();
				return () => controllerRef.current?.abort();
			}, [load]);

			/**
			 * 独占一行。
			 *
			 * `sidebar.footer.action` 落在 dsh 的 `footerActions` 上，那是个 `display:flex`
			 * 且**不换行**的行容器 —— 两个插件（本插件 + usage）会各占一半挤在同一行。
			 * 把它改成可换行，配合 `.dshl-root` 的 `flex:1 1 100%`，本入口就独占一行。
			 *
			 * **不能只看 `parentElement`**：`renderSlot()` 会先套一层
			 * `<div data-slot="…" style="display:contents">`，而 `display:contents` 的盒子
			 * 不参与布局 —— 真正的 flex 容器是再往上的 `footerActions`。父节点取错的话
			 * `flex-wrap` 设在一个没有盒子的元素上，等于没设（踩过：改完还是两个一半一半）。
			 * 所以往上找**第一个 computed display 是 flex 的祖先**。
			 *
			 * 也刻意不写死 class：那是构建期哈希（`hHd-Xa_footerActions`），dsh 一升级就变；
			 * 结构（list 槽位摊开 + 上面有个 flex 行容器）反而稳定。退出时还原行内样式。
			 */
			react.useEffect(() => {
				let node = rootRef.current?.parentElement;
				while (node !== null && node !== undefined) {
					const display = window.getComputedStyle(node).display;
					if (display === "flex" || display === "inline-flex") {
						const container = node;
						const previous = container.style.flexWrap;
						container.style.flexWrap = "wrap";
						return () => {
							container.style.flexWrap = previous;
						};
					}
					node = node.parentElement;
				}
				return undefined;
			}, []);

			// 打开时刷新一次；Esc 关闭
			react.useEffect(() => {
				if (!open) return undefined;
				load();
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("keydown", onKey);
					controllerRef.current?.abort();
				};
			}, [open, load]);

			const reset = react.useCallback(() => {
				setResetting(true);
				fetch(RESET_PATH, { method: "POST", cache: "no-store" })
					.then((response) => {
						if (!response.ok) throw new Error("HTTP " + response.status);
						return response.json();
					})
					.then((data) => setState({ phase: "ready", data, error: "" }))
					.catch((error) => setState((previous) => ({ phase: "error", data: previous.data, error: String(error?.message ?? error) })))
					.finally(() => setResetting(false));
			}, []);

			/**
			 * 开关局域网通道。
			 *
			 * 落盘 + 起停都在宿主侧（POST 完再返回新快照），前端只负责把返回的快照画出来 ——
			 * 「开启成功了吗」以宿主的 `running` 为准，不靠前端猜。所以这里必须用返回值
			 * 覆盖 state，而不是本地先翻转再等刷新。
			 */
			const setEnabled = react.useCallback((next) => {
				setToggling(true);
				fetch(SET_PATH, {
					method: "POST",
					cache: "no-store",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ enabled: next })
				})
					.then((response) => {
						if (!response.ok) throw new Error("HTTP " + response.status);
						return response.json();
					})
					.then((data) => setState({ phase: "ready", data, error: "" }))
					.catch((error) => setState((previous) => ({ phase: "error", data: previous.data, error: String(error?.message ?? error) })))
					.finally(() => setToggling(false));
			}, []);

			const toggle = () => {
				const rect = triggerRef.current?.getBoundingClientRect();
				setAnchor(
					rect
						? { left: Math.min(rect.right + 10, window.innerWidth - 60), bottom: Math.max(12, window.innerHeight - rect.bottom) }
						: { left: 72, bottom: 24 }
				);
				setOpen((current) => !current);
			};

			const running = state.data?.running === true;
			const enabled = state.data?.enabled === true;
			// 灰=没开，绿=在跑，橙=想开但没起来
			const tone = running ? "on" : enabled ? "bad" : "";
			const status = running ? "已开启" : enabled ? "开启失败" : "未开启";

			return h(
				react.Fragment,
				null,
				h(
					"div",
					{ className: "dshl-root", ref: rootRef },
					h(
						"button",
						{
							ref: triggerRef,
							type: "button",
							className: "dshl-trigger" + (wide ? "" : " dshl-rail") + (open ? " dshl-open" : ""),
							title: "局域网访问（" + status + "）：扫码在手机上打开网页版",
							"aria-label": "局域网访问",
							"aria-haspopup": "dialog",
							"aria-expanded": open,
							onClick: toggle
						},
						h(QrIcon, null),
						wide ? h("span", { className: "dshl-label" }, "局域网访问") : null,
						wide && state.data !== null
							? h("span", { className: "dshl-dot" + (tone.length > 0 ? " dshl-" + tone : ""), title: status })
							: null
					)
				),
				open && anchor !== null
					? react_dom.createPortal(
							h(
								react.Fragment,
								null,
								h("div", { className: "dshl-backdrop", onClick: () => setOpen(false) }),
								h(LanPanel, {
									state,
									anchor,
									onRefresh: load,
									onReset: reset,
									onToggle: setEnabled,
									onClose: () => setOpen(false),
									resetting,
									toggling
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
		 * 谁先加载不确定，声明感知的注入保证两边顺序颠倒也能生效（和 usage 一致）。
		 *
		 * `order: 60` 排在 usage 的 50 之后 —— 底栏是 column，所以本入口落在 usage 下面、
		 * 设置按钮上面（也就是「设置上方」）。两行是分开的，见 LanFooterAction 里的
		 * flex-wrap effect。
		 *
		 * @param ctx - 客户端 root context。
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "lan-access",
						order: 60
					},
					LanFooterAction
				)
			);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
