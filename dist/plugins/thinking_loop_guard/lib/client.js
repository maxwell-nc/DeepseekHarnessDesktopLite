window.__ModuleLoader__.load({
	id: "dsh-loop-guard",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region dsh-loop-guard/client.css
		/**
		 * 入口收进输入框底栏（v1.2.0）：一个与原生工具钮同款的 28px 圆形图标钮，
		 * 插在底行右侧按钮簇（发送键左边）；点它弹出面板（固定在输入框上方右侧）。
		 *
		 * v1.0/v1.1 的右下角悬浮 pill 会盖住输入框区域，用户要求收进去 —— 这版不再
		 * 有悬浮球；若页面 DOM 与预期不符（找不到输入框底栏），6 秒后兜底显示一个
		 * 小悬浮球，保证功能不丢。面板只在用户点击时展开；自动中断开启时按钮
		 * 图标绿色、关闭时灰色。
		 *
		 * 样式全部走自己的 `tlg-` 前缀，颜色引用 dsh 主题的 `--dsw-*` 变量并带浅色
		 * 兜底值（照搬 retry 插件的约定）。面板 z-index 9000：高于普通内容、低于
		 * dsh 自己的弹层（retry 的弹窗在 9400）。
		 */
		const css =
			"@keyframes tlg-pulse{0%{box-shadow:0 0 0 0 rgba(77,107,254,.5)}70%{box-shadow:0 0 0 9px rgba(77,107,254,0)}100%{box-shadow:0 0 0 0 rgba(77,107,254,0)}}" +
			".tlg-btn{position:relative;width:28px;height:28px;border:none;border-radius:999px;background:var(--dsw-specific-selector,#eef1f7);color:var(--dsw-alias-label-tertiary,#8a93a8);cursor:pointer;place-items:center;display:grid;flex:none;padding:0;transition:background-color .1s,color .1s}" +
			".tlg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(22,32,58,.08))}" +
			".tlg-btn.tlg-on{color:var(--dsw-alias-state-success-primary,#2e9e5b)}" +
			".tlg-btn svg{width:15px;height:15px;display:block}" +
			".tlg-btn.tlg-pulse{animation:tlg-pulse 1.5s ease-out 9}" +
			".tlg-badge{position:absolute;top:-3px;right:-3px;min-width:14px;height:14px;border-radius:8px;background:var(--dsw-alias-state-error-primary,#c0392b);color:#fff;font-size:9.5px;line-height:14px;text-align:center;padding:0 3px;font-weight:600;box-sizing:border-box}" +
			".tlg-badge:empty{display:none}" +
			".tlg-badge.tlg-live{background:var(--dsw-alias-state-business-primary,#4d6bfe)}" +
			".tlg-fallback{position:fixed;right:14px;bottom:14px;z-index:9000}" +
			".tlg-fallback .tlg-btn{box-shadow:0 4px 14px rgba(16,24,40,.22)}" +
			".tlg-panel{position:fixed;right:24px;bottom:96px;z-index:9000;box-sizing:border-box;width:min(430px,calc(100vw - 48px));max-height:min(56vh,540px);overflow-y:auto;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.14));border-radius:12px;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-secondary,#5b6478);box-shadow:0 12px 30px rgba(16,24,40,.18);font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;font-size:12px;line-height:1.65}" +
			".tlg-head{display:flex;align-items:center;gap:8px}" +
			".tlg-title{flex:1;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1b2130)}" +
			".tlg-toggle{border:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.14));background:transparent;color:var(--dsw-alias-label-secondary,#5b6478);font:inherit;font-size:12px;line-height:1;border-radius:999px;padding:5px 10px;cursor:pointer}" +
			".tlg-toggle:hover{color:var(--dsw-alias-label-primary,#1b2130)}" +
			".tlg-toggle.tlg-on{color:var(--dsw-alias-state-success-primary,#2e9e5b);border-color:var(--dsw-alias-state-success-tertiary,rgba(46,158,91,.4))}" +
			".tlg-live{margin-top:6px;color:var(--dsw-alias-label-tertiary,#8a93a8)}" +
			".tlg-note{margin-top:4px;color:var(--dsw-alias-label-tertiary,#8a93a8)}" +
			".tlg-empty{margin-top:8px;padding:12px;text-align:center;border:1px dashed var(--dsw-alias-border-l1,rgba(22,32,58,.2));border-radius:10px;color:var(--dsw-alias-label-tertiary,#8a93a8)}" +
			".tlg-list{margin-top:8px;display:flex;flex-direction:column;gap:6px}" +
			".tlg-item{border:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.12));border-radius:10px;padding:7px 9px}" +
			".tlg-item-head{display:flex;align-items:center;gap:6px;min-width:0}" +
			".tlg-time{flex:none;color:var(--dsw-alias-label-tertiary,#8a93a8);font-variant-numeric:tabular-nums}" +
			".tlg-model{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#5b6478)}" +
			".tlg-chip{flex:none;border-radius:8px;padding:1px 6px;font-size:10.5px;line-height:16px;background:var(--dsw-alias-fill-l1,rgba(22,32,58,.05));color:var(--dsw-alias-label-caption,#8a93a8)}" +
			".tlg-chip.tlg-kind{background:var(--dsw-alias-state-warn-tertiary,rgba(180,83,9,.15));color:var(--dsw-alias-state-warn-label,#b45309)}" +
			".tlg-chip.tlg-hit{background:rgba(192,57,43,.12);color:var(--dsw-alias-state-error-primary,#c0392b)}" +
			".tlg-detail{margin-top:3px;color:var(--dsw-alias-label-tertiary,#8a93a8)}" +
			".tlg-sample{margin-top:3px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5b6478);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";
		const tagId = "dsh-loop-guard/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-loop-guard";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region dsh-loop-guard/client/widget.js
		/** 宿主半边的只读状态接口（走 connection 的鉴权通道，同源 fetch 即可）。 */
		const STATE_API = "/api/dsh-loop-guard.state";
		/** 切自动中断开关（POST，有副作用）。 */
		const MODE_API = "/api/dsh-loop-guard.mode";
		/** 浏览器已跳转到新分支（POST {childId}），宿主清掉待跳转标记。 */
		const OPENED_API = "/api/dsh-loop-guard.opened";
		/** 轮询节奏。 */
		const POLL_MS = 2500;
		/** 入场脉冲持续多久后撤掉动画类（9 次 × 1.5s ≈ 13.5s）。 */
		const PULSE_MS = 14000;
		/** 输入框锚定兜底：超过这么久还没锚上底栏就显示悬浮球。 */
		const FALLBACK_MS = 6000;
		/** DOM 变动后攒多久再扫一次（流式输出时改动很密集）。 */
		const SWEEP_DELAY_MS = 80;

		/** 盾牌图标（Lucide shield，15px 视觉）。 */
		const ICON_SHIELD =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>';

		const KIND_LABEL = { exact: "精确重复", fuzzy: "相似回声", degenerate: "退化重复" };
		const ACTION_LABEL = { cancelled: "已中断", truncated: "已截断", branched: "分支重跑", none: "仅记录", warned: "预警" };

		/** 插件运行态（apply 时填）。单页单实例。sessions 由 inject 提供。 */
		const state = {
			panel: null, btn: null, badge: null, fallbackRoot: null,
			open: false, timer: null, pulseTimer: null, fallbackTimer: null,
			observer: null, sweepTimer: null, data: null, busy: false, anchored: false,
			ackHits: 0, sessions: null, pendingOpen: null, ackedChild: null, openBusy: false
		};

		/** 建一个元素（textContent 赋值，模型内容永不走 innerHTML）。 */
		function el(tag, className, text) {
			const node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== undefined && text !== null) node.textContent = String(text);
			return node;
		}

		function buildBtn() {
			const btn = el("button", "tlg-btn");
			btn.type = "button";
			btn.title = "思考循环守卫";
			btn.dataset.tlg = "1";
			btn.innerHTML = ICON_SHIELD; // 静态图标常量，非用户数据
			const badge = el("span", "tlg-badge");
			btn.appendChild(badge);
			btn.addEventListener("click", () => {
				state.open = !state.open;
				// 点击即视为已读：清掉红色角标；新命中到达后重新显示
				state.ackHits = currentHits();
				render();
			});
			state.btn = btn;
			state.badge = badge;
			return btn;
		}

		/** 当前可见的输入框卡片（多会话视图时取最后一个可见的）。 */
		function visibleCards() {
			const cards = Array.from(document.querySelectorAll("[data-composer-card]"));
			const visible = cards.filter((card) => card.offsetParent !== null);
			return visible.length > 0 ? [visible[visible.length - 1]] : [];
		}

		/** 卡片里的底栏行：最后一个含按钮的直接子元素。 */
		function findRow(card) {
			const kids = Array.from(card.children);
			for (let i = kids.length - 1; i >= 0; i--) {
				if (kids[i].querySelector("button")) return kids[i];
			}
			return null;
		}

		/** 底栏行里靠右的按钮簇（margin-left:auto 的那个）；找不到就退回行尾。 */
		function findCluster(row) {
			let best = null;
			let bestMargin = 0;
			for (const child of row.children) {
				const margin = parseFloat(window.getComputedStyle(child).marginLeft) || 0;
				if (margin > bestMargin && child.querySelector("button")) {
					bestMargin = margin;
					best = child;
				}
			}
			if (best !== null) return best;
			const last = row.lastElementChild;
			return last !== null && last !== undefined && last.querySelector("button") ? last : row;
		}

		function sweep() {
			const cards = visibleCards();
			if (cards.length === 0) return;
			const row = findRow(cards[0]);
			if (row === null) return;
			const btn = state.btn !== null && state.btn !== undefined && state.btn.isConnected ? state.btn : buildBtn();
			const cluster = findCluster(row);
			if (btn.parentElement !== cluster) {
				if (cluster !== row) cluster.insertBefore(btn, cluster.firstChild);
				else row.appendChild(btn);
			}
			if (!state.anchored) {
				state.anchored = true;
				if (state.fallbackTimer !== null) {
					clearTimeout(state.fallbackTimer);
					state.fallbackTimer = null;
				}
				removeFallback();
			}
		}

		/** 兜底悬浮球（锚不进输入框时才出现）。 */
		function removeFallback() {
			if (state.fallbackRoot !== null && state.fallbackRoot !== undefined && state.fallbackRoot.parentNode !== null) {
				state.fallbackRoot.parentNode.removeChild(state.fallbackRoot);
			}
			state.fallbackRoot = null;
		}

		function showFallback() {
			if (state.anchored || (state.fallbackRoot !== null && state.fallbackRoot !== undefined && state.fallbackRoot.isConnected)) return;
			const root = el("div", "tlg-fallback");
			root.dataset.tlg = "1";
			const btn = state.btn !== null && state.btn !== undefined && state.btn.isConnected ? state.btn : buildBtn();
			root.appendChild(btn);
			document.body.appendChild(root);
			state.fallbackRoot = root;
		}

		function ensurePanel() {
			if (state.panel !== null && state.panel !== undefined && state.panel.isConnected) return;
			const panel = el("div", "tlg-panel");
			panel.hidden = true;
			panel.dataset.tlg = "1";
			document.body.appendChild(panel);
			state.panel = panel;
		}

		function fmtTime(at) {
			const d = new Date(at);
			const p = (x) => (x < 10 ? "0" + x : "" + x);
			return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}

		function detectionItem(item) {
			const action = item.action || "none";
			const row = el("div", "tlg-item");
			const head = el("div", "tlg-item-head");
			head.appendChild(el("span", "tlg-time", fmtTime(item.at)));
			head.appendChild(el("span", "tlg-model", item.model || item.provider || "未知模型"));
			head.appendChild(el("span", "tlg-chip tlg-kind", KIND_LABEL[item.kind] || String(item.kind)));
			head.appendChild(el("span", "tlg-chip" + (action === "cancelled" || action === "truncated" || action === "branched" ? " tlg-hit" : ""), ACTION_LABEL[action] || action));
			row.appendChild(head);
			if (item.detail) row.appendChild(el("div", "tlg-detail", item.detail));
			if (item.sample) {
				const sample = el("div", "tlg-sample", "“" + item.sample + "”");
				sample.title = item.sample;
				row.appendChild(sample);
			}
			return row;
		}

		/** 累计命中数（cancelled/truncated/branched 的记录条数）。 */
		function currentHits() {
			const data = state.data;
			const detections = (data !== null && data !== undefined && Array.isArray(data.detections)) ? data.detections : [];
			return detections.filter((item) => item.action === "cancelled" || item.action === "truncated" || item.action === "branched").length;
		}

		function render() {
			const data = state.data;
			const detections = (data !== null && data !== undefined && Array.isArray(data.detections)) ? data.detections : [];
			const hits = currentHits();
			const streaming = data !== null && data !== undefined && data.activeStreams > 0;
			// 按钮角标：命中数（红）优先，其次流式进行中（蓝点）；自动中断开启时图标变绿
			const on = data !== null && data !== undefined && data.autoInterrupt === true;
			if (state.btn !== null && state.btn !== undefined) {
				state.btn.classList.toggle("tlg-on", on);
			}
			if (state.badge !== null && state.badge !== undefined) {
				// 只显示未读命中：点击后已读数对齐，宿主重启清零时也跟着对齐
				if (hits < state.ackHits) state.ackHits = hits;
				state.badge.textContent = hits > state.ackHits ? String(hits) : "";
				state.badge.className = "tlg-badge" + (hits === 0 && streaming ? " tlg-live" : "");
			}
			if (state.panel === null || state.panel === undefined) return;
			state.panel.hidden = !state.open;
			if (!state.open) return;
			// 展开时整块重画（2.5s 一次，节点量小）；数据全部走 textContent
			state.panel.textContent = "";
			const head = el("div", "tlg-head");
			head.appendChild(el("span", "tlg-title", "思考循环守卫"));
			const toggle = el("button", "tlg-toggle" + (on ? " tlg-on" : ""), on ? "自动中断：开" : "自动中断：关");
			toggle.type = "button";
			toggle.title = "命中循环时是否自动中断本轮生成";
			toggle.addEventListener("click", toggleMode);
			head.appendChild(toggle);
			state.panel.appendChild(head);
			const live = data !== null && data !== undefined
				? (data.activeStreams > 0 ? "监控中 · " + data.activeStreams + " 路流" : "空闲待命") + " · 累计 " + data.seen + " 次调用"
				: "连接中…";
			state.panel.appendChild(el("div", "tlg-live", live));
			state.panel.appendChild(el("div", "tlg-note", "实时分析流式思考内容：精确重复 / 相似回声 / 退化重复。首次命中自动分支重跑一次（新分支会自动打开，循环的那次留在原会话）；新分支里再循环才中断本轮。"));
			if (detections.length === 0) {
				state.panel.appendChild(el("div", "tlg-empty", "尚未检测到思考循环"));
				return;
			}
			const list = el("div", "tlg-list");
			for (const item of detections.slice(0, 8)) list.appendChild(detectionItem(item));
			state.panel.appendChild(list);
		}

		/**
		 * 宿主刚分支重跑出一个新会话：refresh + open 把用户带过去（retry 的同款
		 * 流程）。列表还没落进 store 时 open 会失败 —— 跨轮询最多试 3 次，成功后
		 * POST /opened 让宿主清掉待跳转标记。
		 */
		async function handlePendingChild() {
			const data = state.data;
			const child = data !== null && data !== undefined && typeof data.pendingChild === "string" ? data.pendingChild : "";
			if (child.length === 0 || child === state.ackedChild) return;
			const sessions = state.sessions;
			if (sessions === null || sessions === undefined || typeof sessions.open !== "function") return;
			if (state.pendingOpen === null || state.pendingOpen.childId !== child) {
				state.pendingOpen = { childId: child, tries: 0 };
			}
			const pending = state.pendingOpen;
			if (pending.busy === true || pending.tries >= 3) return;
			pending.tries += 1;
			pending.busy = true;
			try {
				try {
					await sessions.refresh();
				} catch {
					// 刷新失败也接着试 open（可能列表本来就更新过了）
				}
				sessions.open(child);
				state.ackedChild = child;
				try {
					await fetch(OPENED_API, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ childId: child })
					});
				} catch {
					// 通知失败最多多跳一次，无副作用
				}
			} catch {
				// 这一轮没跳成，下个轮询周期再试
			} finally {
				pending.busy = false;
			}
		}

		async function poll() {
			if (state.busy) return;
			state.busy = true;
			try {
				const response = await fetch(STATE_API, { cache: "no-store" });
				if (response.ok) state.data = await response.json();
			} catch {
				// 宿主不在线 / 正在重启时静默，下一轮再试
			}
			state.busy = false;
			sweep();
			render();
			handlePendingChild();
		}

		async function toggleMode() {
			const data = state.data;
			try {
				const response = await fetch(MODE_API, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ value: !(data !== null && data !== undefined && data.autoInterrupt === true) })
				});
				if (response.ok) state.data = await response.json();
			} catch (error) {
				console.error("[dsh-loop-guard] 切换失败", error);
			}
			render();
		}

		/** 挂界面。热重载时先把上一份撤干净（两套定时器/两份面板会叠在一起）。 */
		function install() {
			const previous = window.__DSH_LOOP_GUARD__;
			if (previous !== undefined && previous !== null && typeof previous.dispose === "function") {
				try {
					previous.dispose();
				} catch {
					// 旧实例收尾失败不影响新实例
				}
			}
			ensurePanel();
			// 默认不展开：用户点盾牌钮才打开（打开态图标变绿，见 render）
			state.open = false;
			buildBtn();
			if (state.btn !== null && state.btn !== undefined) state.btn.classList.add("tlg-pulse");
			if (state.pulseTimer !== null) clearTimeout(state.pulseTimer);
			state.pulseTimer = setTimeout(() => {
				if (state.btn !== null && state.btn !== undefined) state.btn.classList.remove("tlg-pulse");
			}, PULSE_MS);
			// 锚定兜底：6 秒还没进输入框底栏就显示悬浮球
			if (state.fallbackTimer !== null) clearTimeout(state.fallbackTimer);
			state.fallbackTimer = setTimeout(showFallback, FALLBACK_MS);
			// React 会重渲染输入框：观察 DOM，80ms 攒一批后把按钮归位
			state.observer = typeof MutationObserver === "function"
				? new MutationObserver(() => {
					if (state.sweepTimer !== null) return;
					state.sweepTimer = setTimeout(() => {
						state.sweepTimer = null;
						try { sweep(); } catch { // 扫描失败不影响页面
						}
					}, SWEEP_DELAY_MS);
				})
				: null;
			if (state.observer !== null) state.observer.observe(document.body, { childList: true, subtree: true });
			sweep();
			render();
			poll();
			state.timer = setInterval(poll, POLL_MS);
			window.__DSH_LOOP_GUARD__ = {
				dispose() {
					if (state.timer !== null) {
						clearInterval(state.timer);
						state.timer = null;
					}
					if (state.pulseTimer !== null) {
						clearTimeout(state.pulseTimer);
						state.pulseTimer = null;
					}
					if (state.fallbackTimer !== null) {
						clearTimeout(state.fallbackTimer);
						state.fallbackTimer = null;
					}
					if (state.sweepTimer !== null) {
						clearTimeout(state.sweepTimer);
						state.sweepTimer = null;
					}
					if (state.observer !== null) {
						state.observer.disconnect();
						state.observer = null;
					}
					if (state.btn !== null && state.btn !== undefined && state.btn.parentNode !== null) {
						state.btn.parentNode.removeChild(state.btn);
					}
					removeFallback();
					if (state.panel !== null && state.panel !== undefined && state.panel.parentNode !== null) {
						state.panel.parentNode.removeChild(state.panel);
					}
					state.panel = null;
					state.btn = null;
					state.badge = null;
					state.open = false;
					state.data = null;
					state.anchored = false;
				}
			};
		}

		/**
		 * 客户端半边入口。
		 *
		 * 需要 sessions：宿主分支重跑出新会话后，由这里 refresh + open 把用户带
		 * 过去（retry 的同款依赖）。界面本身仍是纯 DOM。
		 *
		 * @param ctx - 客户端 root context。
		 */
		function apply(ctx) {
			if (typeof document === "undefined") return;
			state.sessions = ctx.sessions !== undefined ? ctx.sessions : null;
			const boot = () => {
				try {
					install();
				} catch (error) {
					console.error("[dsh-loop-guard] 挂界面失败", error);
				}
			};
			// 引导脚本可能还在 <head> 里跑，这时候 body 还没建出来
			if (document.body === null || document.body === undefined) {
				document.addEventListener("DOMContentLoaded", boot, { once: true });
				return;
			}
			boot();
		}
		//#endregion
		exports.apply = apply;
		exports.inject = ["sessions"];
		return module.exports;
	}
});
