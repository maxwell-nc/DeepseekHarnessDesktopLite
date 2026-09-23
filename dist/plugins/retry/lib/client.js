window.__ModuleLoader__.load({
	id: "dsh-ui-retry",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region dsh-ui-retry/client.css
		/**
		 * 样式全部走自己的 `dshr-` 前缀，颜色一律引用 dsh 主题的 `--dsw-*` 变量并带浅色兜底值。
		 *
		 * 两个按钮刻意**不套自己的容器**：直接插在 dsh 的 actions 行里，靠那一行的
		 * `gap:8px` 和 `flex` 排列，看起来就和内置的复制/分支按钮是一家。
		 * 动作按钮的尺寸跟着 dsh 的 `--dsh-content-font-delta` 走（用户在设置里
		 * 调内容字号时按钮跟着变），别写死。
		 */
		const css =
			".dshr-action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));display:inline-flex;align-items:center;justify-content:center;padding:6px;border:0;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a93a8);cursor:pointer}" +
			".dshr-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}" +
			".dshr-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(22,32,58,.08));color:var(--dsw-alias-label-secondary,#5b6478)}" +
			".dshr-action[data-busy=\"1\"]{cursor:default;opacity:.4}" +
			".dshr-action[data-busy=\"1\"]:hover{background:transparent;color:var(--dsw-alias-label-tertiary,#8a93a8)}" +
			".dshr-backdrop{position:fixed;inset:0;z-index:9400;background:rgba(16,24,40,.28)}" +
			".dshr-panel{position:fixed;z-index:9401;left:50%;top:18vh;transform:translateX(-50%);box-sizing:border-box;width:min(640px,calc(100vw - 32px));max-height:min(76vh,720px);display:flex;flex-direction:column;padding:16px 18px 14px;border-radius:16px;background:var(--dsw-specific-menu,#fff);backdrop-filter:var(--dsw-menu-backdrop-filter,none);color:var(--dsw-alias-label-primary,#1b2130);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(16,24,40,.24));font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;font-size:13px;line-height:1.6}" +
			".dshr-head{display:flex;align-items:center;gap:10px}" +
			".dshr-title{flex:1;font-size:14px;font-weight:600}" +
			".dshr-hint{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a93a8);line-height:1.7}" +
			".dshr-note{margin-top:6px;font-size:12px;color:#b45309;line-height:1.7}" +
			".dshr-input{box-sizing:border-box;width:100%;min-height:168px;max-height:44vh;margin-top:10px;padding:10px 12px;resize:vertical;border:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.14));border-radius:10px;background:var(--dsw-alias-fill-l1,rgba(22,32,58,.03));color:var(--dsw-alias-label-primary,#1b2130);font-family:inherit;font-size:13px;line-height:1.7;outline:none}" +
			".dshr-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}" +
			".dshr-input:disabled{opacity:.6}" +
			".dshr-error{margin-top:8px;font-size:12px;color:#c0392b;line-height:1.7;word-break:break-word}" +
			".dshr-foot{display:flex;align-items:center;gap:8px;margin-top:12px}" +
			".dshr-footGap{flex:1}" +
			".dshr-btn{height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1,rgba(22,32,58,.14));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6478);font:inherit;font-size:13px;line-height:1;cursor:pointer}" +
			".dshr-btn:hover{color:var(--dsw-alias-label-primary,#1b2130);border-color:rgba(22,32,58,.30)}" +
			".dshr-btnPrimary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}" +
			".dshr-btnPrimary:hover{background:var(--dsw-alias-brand-primary-hover,#3f5ae0);color:#fff;border-color:transparent}" +
			".dshr-btn:disabled{cursor:default;opacity:.55}" +
			".dshr-toast{position:fixed;z-index:9402;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);max-width:min(560px,calc(100vw - 32px));padding:9px 14px;border-radius:10px;background:rgba(23,29,44,.94);color:#fff;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;font-size:12.5px;line-height:1.7;box-shadow:0 12px 30px rgba(16,24,40,.32);pointer-events:none;word-break:break-word}" +
			".dshr-toast[data-tone=\"error\"]{background:rgba(150,32,32,.95)}";
		const tagId = "dsh-ui-retry/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-ui-retry";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region dsh-ui-retry/client/index.js
		/** 宿主半边的读取接口（走 connection 的鉴权通道，同源 fetch 即可）。 */
		const ORIGIN_API = "/api/dsh-ui-retry.origin";
		/** 宿主半边的重发接口：建分支 + 把消息发出去（有副作用，所以是 POST）。 */
		const COMMIT_API = "/api/dsh-ui-retry.commit";
		/** 新插入的按钮/弹窗都带这个标记，用来做「插过了没有」的判断和卸载。 */
		const MARK = "data-dshr-ui";
		/** 行上用来标记「正在跑」的自定义属性（React 不认它，不会冲突）。 */
		const BUSY_ATTR = "data-dshr-busy";
		/** 提示条活多久。 */
		const TOAST_MS = 4600;
		/** DOM 变动后攒多久再扫一次（流式输出时改动很密集）。 */
		const SWEEP_DELAY_MS = 80;

		/** 两个动作按钮的内联图标（Lucide 的 pencil / rotate-cw，16px 视觉）。 */
		const ICON_EDIT =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
		const ICON_RETRY =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';

		/** 动作行容器的类名。CSS Modules 生成的是 `<hash>_actions`，后缀稳定、哈希会变。 */
		const ACTIONS_CLASS = /(?:^|\s)[A-Za-z0-9_-]+_actions(?:\s|$)/;

		/** 插件运行态（apply 时填）。单页单实例。 */
		const state = { sessions: null, uiWorkspace: null };

		/* --------------------------------------------------------------------- */
		/* 极简 DOM 工具                                                          */
		/* --------------------------------------------------------------------- */

		/** 建一个元素。 */
		function element(tag, className, text) {
			const node = document.createElement(tag);
			if (typeof className === "string" && className.length > 0) node.className = className;
			if (typeof text === "string") node.textContent = text;
			return node;
		}

		/** 属性读成一个字符串（没有就是空串）——免得满地写 `?? ""`。 */
		function attr(node, name) {
			if (node === null || node === undefined || typeof node.getAttribute !== "function") return "";
			const value = node.getAttribute(name);
			return typeof value === "string" ? value : "";
		}

		/** 元素子节点（**只算元素**，不碰文本节点）。 */
		function elementChildren(node) {
			if (node === null || node === undefined || node.children === null || node.children === undefined) return [];
			return Array.prototype.slice.call(node.children);
		}

		/**
		 * 先序遍历子树。
		 *
		 * `visit` 的返回值决定往下怎么走：
		 *   - `"stop"`：整棵树都不用再找了（「找第一个」这类查询用）；
		 *   - `false`：**只跳过这个节点的子树**，兄弟继续（碰到「行」的边界就用它，
		 *     一行内部不再下钻，但别的行还要接着扫）；
		 *   - 其他：继续往下钻。
		 */
		function walk(root, visit) {
			const stack = [root];
			while (stack.length > 0) {
				const node = stack.pop();
				if (node === null || node === undefined || node.nodeType !== 1) continue;
				const verdict = visit(node);
				if (verdict === "stop") return;
				if (verdict === false) continue;
				const kids = elementChildren(node);
				for (let index = kids.length - 1; index >= 0; index -= 1) stack.push(kids[index]);
			}
		}

		/** 这个元素是我们插进去的没有（按钮 / 弹窗 / 提示条都带这个标记）。 */
		function marked(node) {
			return attr(node, MARK) === "1";
		}

		/* --------------------------------------------------------------------- */
		/* 找到用户消息那一行                                                     */
		/* --------------------------------------------------------------------- */

		/**
		 * 这一行是不是**用户自己发的那条**消息。
		 *
		 * `data-chat-flow-kind` 是 dsh 自己给每行标的 kind：用户气泡是 `user`，
		 * 中途插话是 `steering`（那种没有「这一轮」的概念，不给按钮），
		 * 助手/工具/系统行另说。`data-chat-turn` 是这一轮在会话日志里的轮次号
		 * （就是 `turn/start` 事件里的 `turn`，重发时宿主拿它去日志里找切点）。
		 *
		 * 两个都带上才算数：缺 turn 的（比如还没落库的本地回显）点了也没用。
		 */
		function isUserRow(node) {
			if (attr(node, "data-chat-flow-kind") !== "user") return false;
			const raw = attr(node, "data-chat-turn");
			if (!/^\d+$/.test(raw)) return false;
			return Number.parseInt(raw, 10) > 0;
		}

		/** 离这个节点最近的一行（含自身）。 */
		function nearestRow(node) {
			let current = node;
			while (current !== null && current !== undefined && current.nodeType === 1) {
				if (attr(current, "data-chat-flow-kind").length > 0) return current;
				current = current.parentElement ?? null;
			}
			return null;
		}

		/** 一个只打一次的控制台警告（每行都喊会把控制台刷爆）。 */
		let warned = false;
		function warnOnce(text) {
			if (warned) return;
			warned = true;
			console.warn("[dsh-ui-retry] " + text);
		}

		/** 这一行里插过我们的按钮没有。 */
		function hasUi(row) {
			let found = false;
			walk(row, (node) => {
				if (marked(node)) {
					found = true;
					return "stop";
				}
				return true;
			});
			return found;
		}

		/** 一行里的动作行容器（`<hash>_actions` 那个 div）。 */
		function actionsBox(row) {
			let found = null;
			walk(row, (node) => {
				if (node.tagName !== "DIV") return true;
				const name = typeof node.className === "string" ? node.className : "";
				if (!ACTIONS_CLASS.test(name)) return true;
				found = node;
				return "stop";
			});
			return found;
		}

		/** 子树里第一个按钮（用户行的动作行里就是那个「复制」）。 */
		function firstButton(node) {
			let found = null;
			walk(node, (child) => {
				if (child.tagName !== "BUTTON") return true;
				found = child;
				return "stop";
			});
			return found;
		}

		/** 一行上取轮次号。 */
		function turnOf(row) {
			const value = Number.parseInt(attr(row, "data-chat-turn"), 10);
			return Number.isSafeInteger(value) && value > 0 ? value : 0;
		}

		/* --------------------------------------------------------------------- */
		/* 按钮                                                                   */
		/* --------------------------------------------------------------------- */

		/** 造一个和 dsh 内置动作按钮同款的圆按钮。 */
		function actionButton(action, icon, label, onClick) {
			const button = element("button", "dshr-action");
			button.type = "button";
			button.setAttribute(MARK, "1");
			button.setAttribute("data-dshr-action", action);
			button.setAttribute("aria-label", label);
			button.setAttribute("title", label);
			button.innerHTML = icon;
			button.addEventListener("click", (event) => {
				if (event?.preventDefault !== undefined) event.preventDefault();
				if (event?.stopPropagation !== undefined) event.stopPropagation();
				if (button.getAttribute("data-busy") === "1") return;
				onClick(button);
			});
			return button;
		}

		/**
		 * 给一行插上「编辑 / 重试」两个按钮。
		 *
		 * 插在**复制按钮正后面**（`nextSibling` 那份）：dsh 自己会往这个动作行里塞
		 * 别的动作（助手行的 extraActions / usage 那个药丸），插在复制按钮之后是最稳的
		 * ——既贴着复制按钮，又不会被后来的兄弟节点顶掉位置。
		 *
		 * 幂等：整行搜一遍我们的标记，插过就什么都不做（MutationObserver 会反复扫）。
		 */
		function decorate(row) {
			if (!isUserRow(row) || hasUi(row)) return false;
			const box = actionsBox(row);
			if (box === null) {
				warnOnce("这一行的动作行没认出来（dsh 的界面结构可能变了），按钮插不进去");
				return false;
			}
			const copy = firstButton(box);
			const parent = copy !== null ? copy.parentElement : box;
			if (parent === null || parent === undefined) return false;
			const anchor = copy !== null ? copy.nextSibling : null;

			const edit = actionButton("edit", ICON_EDIT, "编辑并重发（从这一轮新建分支）", () => {
				runEdit(row).catch((error) => toast("编辑失败：" + message(error), "error"));
			});
			const retry = actionButton("retry", ICON_RETRY, "重试这一轮（从这一轮新建分支）", () => {
				runRetry(row).catch((error) => toast("重试失败：" + message(error), "error"));
			});

			if (anchor === null) {
				parent.appendChild(edit);
				parent.appendChild(retry);
			} else {
				parent.insertBefore(edit, anchor);
				parent.insertBefore(retry, anchor);
			}
			return true;
		}

		/* --------------------------------------------------------------------- */
		/* 提示条                                                                 */
		/* --------------------------------------------------------------------- */

		let toastNode = null;
		let toastTimer = null;

		/** 底部居中弹一条提示，几秒后自己消失（同时只留一条）。 */
		function toast(text, tone) {
			if (typeof document === "undefined" || document.body === null || document.body === undefined) return;
			if (toastNode !== null && toastNode.parentNode !== null && toastNode.parentNode !== undefined) {
				toastNode.parentNode.removeChild(toastNode);
			}
			if (toastTimer !== null) {
				clearTimeout(toastTimer);
				toastTimer = null;
			}
			toastNode = element("div", "dshr-toast", text);
			toastNode.setAttribute(MARK, "1");
			if (tone === "error") toastNode.setAttribute("data-tone", "error");
			document.body.appendChild(toastNode);
			toastTimer = setTimeout(() => {
				toastTimer = null;
				if (toastNode !== null && toastNode.parentNode !== null && toastNode.parentNode !== undefined) {
					toastNode.parentNode.removeChild(toastNode);
				}
				toastNode = null;
			}, TOAST_MS);
		}

		/** 错误对象的可读文本。 */
		function message(error) {
			if (error === null || error === undefined) return "未知错误";
			if (typeof error === "string") return error;
			const text = typeof error.message === "string" ? error.message.trim() : "";
			return text.length > 0 ? text : String(error);
		}

		/* --------------------------------------------------------------------- */
		/* 编辑弹窗                                                               */
		/* --------------------------------------------------------------------- */

		/**
		 * 弹出编辑框。
		 *
		 * `submit(text)` 返回的 Promise 成功就关窗；失败把原因显示在窗里（不关），
		 * 让用户改完再试 —— 把弹窗留着比「报个 toast 让人重来一遍」有用得多。
		 */
		function openEditor(options, submit) {
			if (typeof document === "undefined" || document.body === null || document.body === undefined) return;
			const backdrop = element("div", "dshr-backdrop");
			const panel = element("div", "dshr-panel");
			backdrop.setAttribute(MARK, "1");
			panel.setAttribute(MARK, "1");
			panel.setAttribute("role", "dialog");
			panel.setAttribute("aria-label", "编辑并重发");

			const head = element("div", "dshr-head");
			head.appendChild(element("span", "dshr-title", "编辑并重发（第 " + String(options.turn) + " 轮）"));

			const hint = element(
				"div",
				"dshr-hint",
				"发送后会从这一轮「之前」新建一个分支，再把这段文本作为新的一轮发出去；原会话原样保留。"
			);
			const note =
				options.attachments > 0
					? element("div", "dshr-note", "原消息里还有 " + String(options.attachments) + " 个附件，重发时带不上（附件没法重新上传）。")
					: null;

			const input = element("textarea", "dshr-input");
			input.value = options.text;
			input.setAttribute("spellcheck", "false");

			const error = element("div", "dshr-error");
			error.style.display = "none";

			const foot = element("div", "dshr-foot");
			const cancel = element("button", "dshr-btn", "取消");
			cancel.type = "button";
			const send = element("button", "dshr-btn dshr-btnPrimary", "发送并新建分支");
			send.type = "button";
			foot.appendChild(element("span", "dshr-footGap"));
			foot.appendChild(cancel);
			foot.appendChild(send);

			panel.appendChild(head);
			panel.appendChild(hint);
			if (note !== null) panel.appendChild(note);
			panel.appendChild(input);
			panel.appendChild(error);
			panel.appendChild(foot);
			document.body.appendChild(backdrop);
			document.body.appendChild(panel);

			let busy = false;
			const close = () => {
				document.removeEventListener("keydown", onKey, true);
				if (backdrop.parentNode !== null && backdrop.parentNode !== undefined) backdrop.parentNode.removeChild(backdrop);
				if (panel.parentNode !== null && panel.parentNode !== undefined) panel.parentNode.removeChild(panel);
			};
			const fail = (text) => {
				error.textContent = text;
				error.style.display = "block";
			};
			const submitOnce = () => {
				if (busy) return;
				const text = typeof input.value === "string" ? input.value : "";
				if (text.trim().length === 0) {
					fail("内容不能是空的。");
					return;
				}
				busy = true;
				send.disabled = true;
				cancel.disabled = true;
				input.disabled = true;
				send.textContent = "发送中…";
				submit(text)
					.then(() => {
						close();
					})
					.catch((failure) => {
						busy = false;
						send.disabled = false;
						cancel.disabled = false;
						input.disabled = false;
						send.textContent = "发送并新建分支";
						fail("发送失败：" + message(failure));
					});
			};
			function onKey(event) {
				if (event.key === "Escape") {
					event.preventDefault();
					if (!busy) close();
					return;
				}
				if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					submitOnce();
				}
			}

			cancel.addEventListener("click", () => {
				if (!busy) close();
			});
			send.addEventListener("click", submitOnce);
			backdrop.addEventListener("click", () => {
				if (!busy) close();
			});
			document.addEventListener("keydown", onKey, true);
			input.focus();
			try {
				input.setSelectionRange(input.value.length, input.value.length);
			} catch {
				// 某些宿主里 textarea 还没上屏，选不了就算了
			}
		}

		/* --------------------------------------------------------------------- */
		/* 干活：读原文 → 切分支 → 发出去                                          */
		/* --------------------------------------------------------------------- */

		/** 当前正在看的会话 id。 */
		function currentSessionId() {
			const sessions = state.sessions;
			if (sessions === null || sessions === undefined) return undefined;
			let snapshot;
			try {
				snapshot = sessions.list.getSnapshot();
			} catch {
				return undefined;
			}
			const current = snapshot?.current;
			return typeof current === "string" && current.length > 0 ? current : undefined;
		}

		/**
		 * 现有会话的标题（就是侧边栏那份列表里的），跟着重发请求一起送给宿主。
		 *
		 * 宿主拿它给新分支算一个**没被占用**的序号：连续从同一个会话切两次，
		 * 只按「源标题 +1」会得到两个同名的 `xxx (1)`，侧边栏里分不清。
		 * 拿不到列表就送空数组 —— 宿主会退化成 `xxx (1)`，不影响功能。
		 */
		function existingTitles() {
			const sessions = state.sessions;
			if (sessions === null || sessions === undefined) return [];
			let snapshot;
			try {
				snapshot = sessions.list.getSnapshot();
			} catch {
				return [];
			}
			const byId = snapshot?.byId;
			if (byId === null || typeof byId !== "object") return [];
			const titles = [];
			for (const id of Object.keys(byId)) {
				const title = byId[id]?.title;
				if (typeof title === "string" && title.trim().length > 0) titles.push(title);
			}
			return titles;
		}

		/**
		 * 问宿主：「这一轮能不能重发、切哪儿、原文是什么」。
		 *
		 * 业务失败（轮次不存在、还没跑完、只有附件…）也是 200 + `ok:false`，
		 * 只有「接口根本没挂上」（插件没开 / 不是 web profile）才是 HTTP 错误。
		 */
		async function fetchOrigin(sessionId, turn) {
			const url = ORIGIN_API + "?sessionId=" + encodeURIComponent(sessionId) + "&turn=" + String(turn);
			let response;
			try {
				response = await fetch(url, { cache: "no-store" });
			} catch (error) {
				throw new Error("读不到宿主接口（" + message(error) + "）");
			}
			if (!response.ok) {
				throw new Error("宿主接口返回 HTTP " + String(response.status) + "（插件可能刚更新过：托盘「插件管理器 → 重启服务并生效」之后再刷新界面）");
			}
			const payload = await response.json();
			if (payload === null || typeof payload !== "object") throw new Error("宿主接口返回的不是对象");
			return payload;
		}

		/**
		 * 让宿主建分支（或第一轮新建会话）并把文本发出去。
		 *
		 * 这两步都在宿主做（`retry.mjs` 的文件头写了为什么）：
		 *
		 * - **分组**：侧边栏按工作区分组，而归属关系记在工作区那边，只有宿主能算；
		 *   浏览器只给 `cwd` 会拿到一个「不属于任何工作区」的会话，掉进未分组。
		 * - **少一个时序坑**：浏览器发消息要先 `binding(childId)` 拿到会话面，新会话刚
		 *   建出来时不一定立刻挂得上；`prompt` 那套模型选择/附件准入本来也在宿主里。
		 *
		 * 所以这里只负责「读原文 → POST → 把界面切过去」。
		 */
		async function requestCommit(sessionId, turn, text) {
			let response;
			try {
				response = await fetch(COMMIT_API, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId, turn, text, titles: existingTitles() })
				});
			} catch (error) {
				throw new Error("调不到宿主接口（" + message(error) + "）");
			}
			if (!response.ok) {
				throw new Error("宿主接口返回 HTTP " + String(response.status) + "（插件可能刚更新过：托盘「插件管理器 → 重启服务并生效」之后再刷新界面）");
			}
			const payload = await response.json();
			if (payload === null || typeof payload !== "object") throw new Error("宿主接口返回的不是对象");
			if (payload.ok !== true) throw new Error(message(payload.message ?? "宿主拒绝了这次重发"));
			return payload;
		}

		/**
		 * 把界面切到某个会话 —— 换会话的入口随 dsh 版本搬过家：
		 *
		 *   dsh ≥ 0.1.7-alpha   `sessions.open(id)` 被删掉了，界面本身改用
		 *                       `uiWorkspace.openSession(id)`（切主视图 + 关侧栏面板）。
		 *   dsh ≤ 0.1.5-rc.x    `uiWorkspace.openSession(id)` 也在（它内部就是
		 *                       `sessions.open(id)` + `layout.selectPanel(null)`），
		 *                       所以优先走它，两个版本都是同一条路。
		 *   兜底：`sessions.open(id)`（更老的部署，或者 uiWorkspace 没挂上时）。
		 *
		 * @returns 是否真的切过去了（两条路都不通就是 false）。
		 */
		function openSession(childId) {
			const uiWorkspace = state.uiWorkspace;
			if (uiWorkspace !== null && uiWorkspace !== undefined && typeof uiWorkspace.openSession === "function") {
				uiWorkspace.openSession(childId);
				return true;
			}
			const sessions = state.sessions;
			if (sessions !== null && sessions !== undefined && typeof sessions.open === "function") {
				sessions.open(childId);
				return true;
			}
			return false;
		}

		/**
		 * 把界面切到新分支。
		 *
		 * 子会话是宿主建的，浏览器这边的会话列表还不知道它 —— 先 `refresh()` 拉一次权威
		 * 列表，再 `openSession()`。第一次没切开（列表还没落进 store）就再刷一次；
		 * 还是不行就不切了（分支已经建好、消息也发出去了，用户去侧边栏点开一样）。
		 *
		 * @returns 是否真的切过去了。
		 */
		async function showChild(childId) {
			const sessions = state.sessions;
			if (sessions === null || sessions === undefined) return false;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				try {
					await sessions.refresh();
				} catch {
					// 刷新失败也接着试切换（可能列表本来就更新过了）
				}
				try {
					if (openSession(childId)) return true;
				} catch {
					// 多半是列表里还没有这个 id，再刷一次
				}
			}
			return false;
		}

		/** 把按钮置成「正在跑」，返回恢复函数。 */
		function beginBusy(row) {
			const buttons = [];
			walk(row, (node) => {
				if (node.tagName === "BUTTON" && marked(node)) {
					buttons.push(node);
					node.setAttribute("data-busy", "1");
				}
				return true;
			});
			row.setAttribute(BUSY_ATTR, "1");
			return () => {
				row.removeAttribute(BUSY_ATTR);
				for (const button of buttons) button.removeAttribute("data-busy");
			};
		}

		/** 整条链路：读原文 →（弹窗）→ 让宿主建分支并发出去 → 界面切过去。 */
		async function run(sessionId, row, override) {
			const turn = turnOf(row);
			if (turn <= 0) throw new Error("这一行读不到轮次号");
			const origin = await fetchOrigin(sessionId, turn);
			if (origin.ok !== true) throw new Error(message(origin.message ?? "宿主拒绝了这次重发"));
			const text = typeof override === "string" ? override : origin.text;
			const committed = await requestCommit(sessionId, turn, text);
			const opened = await showChild(committed.childId);
			const kept = origin.attachments > 0 ? "；原消息的附件没有带上" : "";
			toast("已从第 " + String(turn) + " 轮重新开始（新分支）" + kept + (opened ? "" : "；新分支在侧边栏里，点开就是它"));
			return origin;
		}

		/** 「重试」：原文重发。 */
		async function runRetry(row) {
			const sessionId = currentSessionId();
			if (sessionId === undefined) throw new Error("当前没有打开的会话");
			const release = beginBusy(row);
			try {
				await run(sessionId, row);
			} finally {
				release();
			}
		}

		/** 「编辑」：先把原文读回来填进弹窗，改完再发。 */
		async function runEdit(row) {
			const sessionId = currentSessionId();
			if (sessionId === undefined) throw new Error("当前没有打开的会话");
			const turn = turnOf(row);
			if (turn <= 0) throw new Error("这一行读不到轮次号");
			const release = beginBusy(row);
			let origin;
			try {
				origin = await fetchOrigin(sessionId, turn);
			} finally {
				release();
			}
			if (origin.ok !== true) throw new Error(message(origin.message ?? "宿主拒绝了这次编辑"));
			openEditor({ turn, text: origin.text, attachments: origin.attachments }, (text) => run(sessionId, row, text));
		}

		/* --------------------------------------------------------------------- */
		/* 装到界面上                                                             */
		/* --------------------------------------------------------------------- */

		/** 扫一个子树（以及它所在的那一行），该插按钮的就插。 */
		function sweep(node) {
			if (node === null || node === undefined || node.nodeType !== 1) return;
			const owner = nearestRow(node);
			if (owner !== null) {
				if (isUserRow(owner)) decorate(owner);
				return;
			}
			walk(node, (child) => {
				const kind = attr(child, "data-chat-flow-kind");
				if (kind.length === 0) return true;
				if (isUserRow(child)) decorate(child);
				return false; // 一行的内部不再下钻，但别的行还要接着扫
			});
		}

		/** 全量扫一遍（首次挂载 / 换会话兜底）。 */
		function sweepAll() {
			if (typeof document === "undefined" || document.body === null || document.body === undefined) return;
			sweep(document.body);
		}

		/** 把插进去的节点全摘掉（热重载 / 卸载）。 */
		function removeUi() {
			if (typeof document === "undefined" || document.body === null || document.body === undefined) return;
			const doomed = [];
			walk(document.body, (node) => {
				if (marked(node)) doomed.push(node);
				return true;
			});
			for (const node of doomed) {
				if (node.parentNode !== null && node.parentNode !== undefined) node.parentNode.removeChild(node);
			}
		}

		/**
		 * 挂观察器 + 首扫。
		 *
		 * 为什么要 MutationObserver：按钮是插进 React 管的 DOM 里的，行重建 / 切会话
		 * 都会把它们冲掉，得能自己长回来。扫的动作**攒 80ms 再跑**，而且只扫新增的
		 * 子树 + 它所在的那一行 —— 对话流式输出时 DOM 每分钟变上万次，全量扫会把
		 * 界面拖卡。
		 */
		/**
		 * 挂到界面上。
		 *
		 * 只留 `sessions`（定位当前会话、刷列表、切过去都要它）：建分支和发消息都在
		 * 宿主那边，浏览器不用再看工作区/模型选择那套。
		 */
		function install(sessions, uiWorkspace) {
			// 上一份（热重载前）先撤干净：两套观察器和两套按钮叠在一起会互相打架。
			// 注意必须在首扫**之前**撤 —— `dispose()` 会把带标记的节点全摘掉。
			const previous = window.__DSH_UI_RETRY__;
			if (previous !== undefined && previous !== null && typeof previous.dispose === "function") {
				try {
					previous.dispose();
				} catch {
					// 旧实例收尾失败不影响新实例
				}
			}

			state.sessions = sessions;
			state.uiWorkspace = uiWorkspace;
			const queue = [];
			let timer = null;

			const flush = () => {
				timer = null;
				const batch = queue.splice(0, queue.length);
				for (const node of batch) sweep(node);
			};
			const schedule = () => {
				if (timer !== null) return;
				timer = setTimeout(flush, SWEEP_DELAY_MS);
			};

			const observer =
				typeof MutationObserver === "function"
					? new MutationObserver((records) => {
							for (const record of records) {
								const added = record?.addedNodes;
								if (added === null || added === undefined) continue;
								for (let index = 0; index < added.length; index += 1) {
									const node = added[index];
									if (node?.nodeType === 1) queue.push(node);
								}
							}
							if (queue.length > 0) schedule();
						})
					: null;
			if (observer !== null) observer.observe(document.body, { childList: true, subtree: true });

			sweepAll();

			window.__DSH_UI_RETRY__ = {
				dispose() {
					if (observer !== null) observer.disconnect();
					if (timer !== null) clearTimeout(timer);
					timer = null;
					queue.length = 0;
					removeUi();
				}
			};
		}

		/** 本插件需要的客户端服务：只要会话对象层。 */
		const inject = ["sessions"];

		/**
		 * 取一个**可选**服务：能拿到就返回，没有（或还没挂上）返回 null。
		 *
		 * 为什么不能直接 `ctx.uiWorkspace`：cordis 里属性访问只对**写进 `inject`
		 * 且已就绪**的服务安全 —— 其它情况那个 getter 会**抛**
		 * `cannot get property "uiWorkspace" without inject`（服务还没被 provide、
		 * 或在别的 isolate 里都算「没有」）。`ctx.get(id)` 才是可选服务的正规入口。
		 */
		function optionalService(ctx, id) {
			try {
				if (typeof ctx.get === "function") {
					const found = ctx.get(id);
					if (found !== undefined && found !== null) return found;
				}
			} catch {
				// 落到属性访问再试一次
			}
			try {
				return ctx[id] !== undefined ? ctx[id] : null;
			} catch {
				return null;
			}
		}

		/**
		 * 客户端半边入口。
		 *
		 * @param ctx - 客户端 root context。
		 */
		function apply(ctx) {
			const start = () => {
				try {
					install(optionalService(ctx, "sessions"), optionalService(ctx, "uiWorkspace"));
				} catch (error) {
					console.error("[dsh-ui-retry] 挂界面失败：" + message(error));
				}
			};
			// 引导脚本可能还在 <head> 里跑，这时候 body 还没建出来
			if (typeof document === "undefined") return;
			if (document.body === null || document.body === undefined) {
				document.addEventListener("DOMContentLoaded", start, { once: true });
				return;
			}
			start();
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
