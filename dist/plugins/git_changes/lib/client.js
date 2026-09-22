window.__ModuleLoader__.load({
	id: "dsh-git-changes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var react_dom = require("react-dom");
		//#region dsh-git-changes/client.css
		const css =
			".dsgc-trigger{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#e6e8ec);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;transition:border-color .15s ease,background .15s ease}" +
			".dsgc-trigger:hover,.dsgc-trigger:focus-visible{border-color:var(--dsw-alias-state-business-primary,#3d7eff);outline:none}" +
			".dsgc-trigger.dsgc-open,.dsgc-trigger.dsgc-hot{border-color:var(--dsw-alias-state-business-primary,#3d7eff);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3d7eff) 12%,var(--dsw-alias-bg-layer-2,#161921))}" +
			".dsgc-ic{flex:none;display:flex;align-items:center;font-size:12px;color:var(--dsw-alias-state-business-primary,#7aa7ff)}" +
			".dsgc-label{white-space:nowrap}" +
			".dsgc-badge{flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#3d7eff);color:#fff;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;justify-content:center}" +
			".dsgc-overlay{position:fixed;inset:0;z-index:12000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#0f1115);color:var(--dsw-alias-label-primary,#e6e8ec);font-family:var(--dsw-font-family,ui-sans-serif,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:13px}" +
			".dsgc-bar{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));flex-wrap:wrap}" +
			".dsgc-title{font-size:14px;font-weight:600;margin-right:4px}" +
			".dsgc-caption{color:var(--dsw-alias-label-tertiary,#8a93a8);font-size:12px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}" +
			".dsgc-spacer{flex:1}" +
			".dsgc-btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa4b2);font:inherit;font-size:12px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}" +
			".dsgc-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,#fff);border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.3))}" +
			".dsgc-btn:disabled{opacity:.4;cursor:default}" +
			".dsgc-btn-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#3d7eff);color:#fff}" +
			".dsgc-btn-danger{border-color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 18%,transparent);color:var(--dsw-alias-state-error-primary,#ff6b70)}" +
			".dsgc-btn-close{border-color:transparent;background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}" +
			".dsgc-btn-close:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 82%,#000);color:#fff;border-color:transparent}" +
			".dsgc-main{flex:1;display:flex;min-height:0}" +
			".dsgc-side{flex:none;width:300px;min-width:220px;border-right:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));display:flex;flex-direction:column;min-height:0}" +
			".dsgc-tabs{flex:none;display:flex;gap:4px;padding:8px}" +
			".dsgc-tab{flex:1;height:28px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a93a8);font:inherit;font-size:12px;cursor:pointer}" +
			".dsgc-tab-on{background:var(--dsw-alias-fill-l2,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#fff)}" +
			".dsgc-list{flex:1;min-height:0;overflow:auto;padding:4px 6px}" +
			".dsgc-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa4b2);font:inherit;font-size:12px;text-align:left;cursor:pointer}" +
			".dsgc-item:hover{background:var(--dsw-alias-fill-l2,rgba(255,255,255,.06))}" +
			".dsgc-item-on{background:var(--dsw-alias-interactive-bg-active,rgba(61,126,255,.14));color:var(--dsw-alias-label-primary,#fff)}" +
			".dsgc-item-path{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:11px}" +
			".dsgc-item-meta{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a93a8);font-variant-numeric:tabular-nums}" +
			".dsgc-chip{flex:none;font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-fill-l2,rgba(255,255,255,.08));color:var(--dsw-alias-label-tertiary,#8a93a8)}" +
			".dsgc-chip-untracked{color:#d97706;background:color-mix(in srgb,#d97706 16%,transparent)}" +
			".dsgc-chip-added{color:#34c759;background:color-mix(in srgb,#34c759 16%,transparent)}" +
			".dsgc-chip-deleted{color:#ff6b70;background:color-mix(in srgb,#ff6b70 16%,transparent)}" +
			".dsgc-chip-modified{color:#3d7eff;background:color-mix(in srgb,#3d7eff 16%,transparent)}" +
			".dsgc-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8a93a8);font-size:12px;padding:24px;text-align:center}" +
			".dsgc-detail{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}" +
			".dsgc-filehead{flex:none;display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.05));flex-wrap:wrap}" +
			".dsgc-fpath{flex:1;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:12px;word-break:break-word;overflow-wrap:anywhere;white-space:normal}" +
			".dsgc-fsub{display:none}" +
			".dsgc-tools{flex:none;display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.05));flex-wrap:wrap}" +
			".dsgc-mini{height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa4b2);font:inherit;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}" +
			".dsgc-mini:hover:not(:disabled){color:var(--dsw-alias-label-primary,#fff)}" +
			".dsgc-mini:disabled{opacity:.4;cursor:default}" +
			".dsgc-mini-danger:hover:not(:disabled){border-color:#ff6b70;color:#ff6b70}" +
			".dsgc-mini-primary:hover:not(:disabled){border-color:#3d7eff;color:#3d7eff}" +
			".dsgc-body{flex:1;overflow:auto;padding:12px 14px 40px}" +
			".dsgc-emptydetail{color:var(--dsw-alias-label-tertiary,#8a93a8);text-align:center;padding:40px 0;font-size:12px}" +
			".dsgc-diff{background:var(--dsw-alias-bg-layer-1,#0f1115);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));border-radius:10px;overflow:hidden}" +
			".dsgc-files{flex:none;max-height:38%;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.05))}" +
			".dsgc-logfiles{display:none}" +
			".dsgc-line{font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;padding:0 10px;overflow-wrap:anywhere;display:flex;align-items:flex-start}" +
			".dsgc-lno{flex:none;width:3.2em;color:var(--dsw-alias-label-tertiary,#8a93a8);text-align:right;margin-right:10px;user-select:none;-webkit-user-select:none;font-variant-numeric:tabular-nums;opacity:.7}" +
			".dsgc-lsign{flex:none;width:1.2em;color:var(--dsw-alias-label-tertiary,#8a93a8);user-select:none;-webkit-user-select:none}" +
			".dsgc-ltext{flex:1;min-width:0}" +
			".dsgc-ldel{color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff6b70) 82%,#fff);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 14%,transparent)}" +
			".dsgc-ladd{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c759) 82%,#fff);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c759) 13%,transparent)}" +
			".dsgc-lctx{color:var(--dsw-alias-label-secondary,#9aa4b2)}" +
			".dsgc-lblank{background:var(--dsw-alias-bg-layer-2,#161921)}" +
			".dsgc-binary{color:var(--dsw-alias-label-tertiary,#8a93a8);padding:20px;text-align:center;font-size:12px}" +
			".dsgc-side2{display:flex;gap:0}" +
			".dsgc-sidecol{flex:1;min-width:0;overflow:auto}" +
			".dsgc-sidelabel{padding:3px 10px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a93a8);background:var(--dsw-alias-bg-layer-2,#161921);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}" +
			".dsgc-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:12001;background:rgba(23,29,44,.96);color:#fff;padding:8px 14px;border-radius:9px;font-size:12px;box-shadow:0 10px 26px rgba(0,0,0,.35)}" +
			".dsgc-commit{display:flex;flex-direction:column;gap:2px;min-width:0}" +
			".dsgc-commit-subject{font-size:12px;color:var(--dsw-alias-label-primary,#e6e8ec);word-break:break-word;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}" +
			".dsgc-commit-meta{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a93a8);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}" +
			".dsgc-commit-refs{font-size:10px;color:#d97706;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}" +
			".dsgc-sheet-collapse{display:none}" +
			".dsgc-check{flex:none;width:15px;height:15px;accent-color:var(--dsw-alias-state-business-primary,#3d7eff);cursor:pointer}" +
			".dsgc-batchbar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));background:var(--dsw-alias-bg-layer-2,#161921);flex-wrap:wrap}" +
			".dsgc-batchcount{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a93a8)}" +
			".dsgc-loading{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8a93a8);font-size:12px;padding:24px}" +
			".dsgc-error{flex:none;padding:8px 14px;color:#ff6b70;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.05))}" +
			// 手机版（电脑版样式一律不动）：
			// 1. 本地变更 = 列表占满整屏，点文件弹出 diff 窗口；
			// 2. 提交日志 = 日志列表 50% + 改动文件列表 50%（没选中也占着），点文件弹出 diff 窗口；
			// 3. diff 窗口 = 底部浮层，标题最多三行、超出部分在标题框里自己滑动。
			"@media (max-width:640px){" +
				".dsgc-main{flex-direction:column}" +
				// 列表区占满整屏（细节由下面的 50% 规则分配）
				".dsgc-side{width:auto;flex:1;height:auto;min-height:0;border-right:none;border-bottom:none}" +
				// 列表项别再撑出横向滚动条（占满高度的列表里特别碍眼）
				".dsgc-side .dsgc-item{width:auto}" +
				".dsgc-side-log .dsgc-list{flex:1 1 50%}" +
				".dsgc-logfiles{display:block;flex:1 1 50%;min-height:0;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.05))}" +
				".dsgc-bar{max-height:45vh;overflow:auto}" +
				// diff 窗口：底部弹出的浮层（本地 / 日志同一套）
				".dsgc-detail{position:fixed;left:0;right:0;bottom:0;top:5%;height:95%;z-index:12005;min-height:0;background:var(--dsw-alias-bg-layer-1,#0f1115);border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:14px 14px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.4)}" +
				".dsgc-detail-hidden{display:none}" +
				".dsgc-detail-empty{display:none}" +
				".dsgc-sheet-collapse{display:inline-flex;margin-left:auto}" +
				// 标题（变更内容标题）：最多三行，超出部分在框内自己滑动
				".dsgc-fpath{flex:1 1 100%;line-height:1.45;max-height:4.35em;overflow-y:auto}" +
				".dsgc-fsub{display:block;flex:1 1 auto;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:10.5px;line-height:1.5;max-height:4.5em;overflow-y:auto;color:var(--dsw-alias-label-tertiary,#8a93a8);word-break:break-word;overflow-wrap:anywhere}" +
				// diff 上下堆叠
				".dsgc-side2{flex-direction:column}" +
				".dsgc-sidecol{max-height:40vh}" +
				".dsgc-detail-log:not(.dsgc-has-file){display:none}" +
				".dsgc-detail-log .dsgc-files{display:none}" +
			"}";
		const tagId = "dsh-git-changes/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-git-changes";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region dsh-git-changes/client/index.js
		const h = react.createElement;
		const API = {
			bind: "/api/git_changes.bind",
			local: "/api/git_changes.local",
			localDiff: "/api/git_changes.local.diff",
			localRevert: "/api/git_changes.local.revert",
			log: "/api/git_changes.log",
			logFiles: "/api/git_changes.log.files",
			logDiff: "/api/git_changes.log.diff",
		};

		async function call(path, body) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 20000);
			try {
				const resp = await fetch(path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body || {}),
					cache: "no-store",
					signal: controller.signal,
				});
				const data = await resp.json().catch(() => null);
				if (!resp.ok) throw new Error(data?.error || "HTTP " + resp.status);
				return data;
			} finally {
				clearTimeout(timer);
			}
		}

		/** 尽力复制到剪贴板；失败退回临时 textarea 法。 */
		function copyText(text) {
			const fallback = () => {
				try {
					const ta = document.createElement("textarea");
					ta.value = text;
					ta.style.position = "fixed";
					ta.style.opacity = "0";
					document.body.appendChild(ta);
					ta.focus();
					ta.select();
					document.execCommand("copy");
					document.body.removeChild(ta);
				} catch { /* ignore */ }
			};
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text).catch(fallback);
			} else fallback();
		}

		function baseName(p) {
			if (!p) return p || "";
			const seg = String(p).split(/[\\/]/).filter(Boolean);
			return seg.length ? seg[seg.length - 1] : String(p);
		}

		/* ---------- 顶部入口（对话 header 工具区） ---------- */
		function GitEntry({ sessionId }) {
			const [open, setOpen] = react.useState(false);
			const [count, setCount] = react.useState(null);
			const [repo, setRepo] = react.useState("");

			const refresh = react.useCallback(async () => {
				try {
					const d = await call(API.local, { sessionId });
					if (d.ok) {
						setCount(d.files.length);
						setRepo(d.repoRoot || "");
					} else {
						setCount(null);
						setRepo("");
					}
				} catch { /* ignore */ }
			}, [sessionId]);

			react.useEffect(() => {
				refresh();
				const timer = window.setInterval(() => refresh().catch(() => {}), 8000);
				return () => window.clearInterval(timer);
			}, [refresh]);

			return h(react.Fragment, null,
				h("button", {
					type: "button",
					className: "dsgc-trigger" + (open ? " dsgc-open" : "") + (count !== null && count > 0 ? " dsgc-hot" : ""),
					title: repo ? "Git 变更查看 · " + repo : "Git 变更查看",
					onClick: () => setOpen(!open),
				},
					h("span", { className: "dsgc-ic", "aria-hidden": "true" }, "\u{1F5C2}"),
					h("span", { className: "dsgc-label" }, "Git 变更"),
					count !== null && count > 0 ? h("span", { className: "dsgc-badge" }, count) : null
				),
				open ? h(GitOverlay, { sessionId, onClose: () => setOpen(false) }) : null
			);
		}

		/* ---------- 覆盖层 ---------- */
		function GitOverlay({ sessionId, onClose }) {
			const [tab, setTab] = react.useState("local"); // local | log
			const [repo, setRepo] = react.useState("");
			const [error, setError] = react.useState("");
			const [toast, setToast] = react.useState("");
			const [confirm, setConfirm] = react.useState(null);

			// 本地变更
			const [localFiles, setLocalFiles] = react.useState(null);
			const [localLoading, setLocalLoading] = react.useState(false);
			const [selLocal, setSelLocal] = react.useState(null);
			const [localDiff, setLocalDiff] = react.useState(null);
			const [localDiffLoading, setLocalDiffLoading] = react.useState(false);
			const [selected, setSelected] = react.useState({});

			// 日志
			const [commits, setCommits] = react.useState(null);
			const [logLoading, setLogLoading] = react.useState(false);
			const [selCommit, setSelCommit] = react.useState(null);
			const [commitFiles, setCommitFiles] = react.useState(null);
			const [commitFilesLoading, setCommitFilesLoading] = react.useState(false);
			const [selLogFile, setSelLogFile] = react.useState(null);
			const [logDiff, setLogDiff] = react.useState(null);
			const [logDiffLoading, setLogDiffLoading] = react.useState(false);

			const toastShow = (msg) => {
				setToast(msg);
				window.setTimeout(() => setToast(""), 1800);
			};

			// 绑定仓库
			react.useEffect(() => {
				let alive = true;
				call(API.bind, { sessionId }).then((d) => {
					if (!alive) return;
					if (d.ok) setRepo(d.repoRoot || "");
					else setError(d.error || "无法绑定仓库");
				}).catch((e) => { if (alive) setError(String(e?.message ?? e)); });
				return () => { alive = false; };
			}, [sessionId]);

			// 加载本地变更
			const loadLocal = react.useCallback(async () => {
				setLocalLoading(true);
				try {
					const d = await call(API.local, { sessionId });
					if (d.ok) {
						setLocalFiles(d.files);
						setRepo(d.repoRoot || "");
						setError("");
					} else {
						setError(d.error || "读取本地变更失败");
					}
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setLocalLoading(false);
				}
			}, [sessionId]);

			// 加载日志
			const loadLog = react.useCallback(async () => {
				setLogLoading(true);
				try {
					const d = await call(API.log, { sessionId });
					if (d.ok) {
						setCommits(d.commits);
						setRepo(d.repoRoot || "");
						setError("");
					} else {
						setError(d.error || "读取日志失败");
					}
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setLogLoading(false);
				}
			}, [sessionId]);

			// 首次加载
			react.useEffect(() => {
				loadLocal();
			}, [loadLocal]);

			// 会话切换时重置所有选中状态，避免显示上一个仓库的残留数据
			const prevSession = react.useRef(sessionId);
			react.useEffect(() => {
				if (prevSession.current !== sessionId) {
					prevSession.current = sessionId;
					setSelLocal(null);
					setLocalDiff(null);
					setSelected({});
					setSelCommit(null);
					setCommitFiles(null);
					setSelLogFile(null);
					setLogDiff(null);
					setCommits(null);
					setLocalFiles(null);
					setError("");
					loadLocal();
				}
			}, [sessionId, loadLocal]);

			// 切 tab
			const switchTab = (t) => {
				setTab(t);
				setError("");
				if (t === "log" && commits === null) loadLog();
			};

			// 选中本地文件 → 加载 diff
			react.useEffect(() => {
				if (tab !== "local" || !selLocal) { setLocalDiff(null); return; }
				let alive = true;
				setLocalDiffLoading(true);
				call(API.localDiff, { sessionId, path: selLocal }).then((d) => {
					if (!alive) return;
					if (d.ok) setLocalDiff(d);
					else setError(d.error || "读取差异失败");
				}).catch((e) => { if (alive) setError(String(e?.message ?? e)); })
				.finally(() => { if (alive) setLocalDiffLoading(false); });
				return () => { alive = false; };
			}, [tab, selLocal, sessionId]);

			// 选中提交 → 加载文件列表
			react.useEffect(() => {
				if (tab !== "log" || !selCommit) { setCommitFiles(null); setSelLogFile(null); setLogDiff(null); return; }
				let alive = true;
				setCommitFilesLoading(true);
				call(API.logFiles, { sessionId, hash: selCommit }).then((d) => {
					if (!alive) return;
					if (d.ok) { setCommitFiles(d.files); setSelLogFile(null); setLogDiff(null); }
					else setError(d.error || "读取提交文件失败");
				}).catch((e) => { if (alive) setError(String(e?.message ?? e)); })
				.finally(() => { if (alive) setCommitFilesLoading(false); });
				return () => { alive = false; };
			}, [tab, selCommit, sessionId]);

			// 选中日志文件 → 加载 diff
			react.useEffect(() => {
				if (tab !== "log" || !selCommit || !selLogFile) { setLogDiff(null); return; }
				let alive = true;
				setLogDiffLoading(true);
				call(API.logDiff, { sessionId, hash: selCommit, path: selLogFile }).then((d) => {
					if (!alive) return;
					if (d.ok) setLogDiff(d);
					else setError(d.error || "读取差异失败");
				}).catch((e) => { if (alive) setError(String(e?.message ?? e)); })
				.finally(() => { if (alive) setLogDiffLoading(false); });
				return () => { alive = false; };
			}, [tab, selCommit, selLogFile, sessionId]);

			// 回滚（单个或批量）
			const doRevert = async (files) => {
				try {
					const d = await call(API.localRevert, { sessionId, files });
					if (d.ok) {
						toastShow("已回滚 " + d.done.length + " 个文件");
						setSelected({});
						setSelLocal(null);
						setLocalDiff(null);
						await loadLocal();
					} else {
						toastShow(d.error || "回滚失败");
					}
				} catch (e) {
					setError(String(e?.message ?? e));
				}
			};
			const askRevert = (message, files) => setConfirm({ message, onConfirm: () => { setConfirm(null); doRevert(files); } });

			const revertOne = (path) => askRevert("确定回滚文件「" + baseName(path) + "」的全部改动吗？\n已跟踪文件将还原为 HEAD 状态；未跟踪文件将被直接删除。", [path]);
			const revertSelected = () => {
				const paths = (localFiles || []).filter((f) => selected[f.path]).map((f) => f.path);
				if (paths.length === 0) return;
				askRevert("确定回滚选中的 " + paths.length + " 个文件吗？\n已跟踪文件将还原为 HEAD 状态；未跟踪文件将被直接删除。", paths);
			};
			const revertAll = () => {
				if (!localFiles || localFiles.length === 0) return;
				askRevert("确定回滚全部 " + localFiles.length + " 个文件的改动吗？\n已跟踪文件将还原为 HEAD 状态；未跟踪文件将被直接删除。", localFiles.map((f) => f.path));
			};

			const copyDiff = (diff) => {
				if (!diff || diff.binary) return toastShow("二进制文件无法复制");
				copyText(diff.newText);
				toastShow("已复制文件内容");
			};

			const currentLocal = selLocal ? (localFiles || []).find((f) => f.path === selLocal) : null;

			return h("div", { className: "dsgc-overlay", role: "dialog", "aria-label": "Git 变更查看" },
				h("div", { className: "dsgc-bar" },
					h("span", { className: "dsgc-title" }, "\u{1F5C2} Git 变更查看"),
					h("span", { className: "dsgc-caption", title: repo }, repo || "未绑定仓库"),
					h("span", { className: "dsgc-spacer" }),
					h("button", { className: "dsgc-btn", onClick: () => { if (tab === "local") loadLocal(); else loadLog(); } }, "刷新"),
					h("button", { className: "dsgc-btn dsgc-btn-close", onClick: onClose }, "\u2715 关闭")
				),
				error ? h("div", { className: "dsgc-error" }, error) : null,
				h("div", { className: "dsgc-main" },
					// -------- 左：列表 --------
					// dsgc-side-log：手机版把侧栏拆成「日志 50% + 改动文件 50%」，电脑版不用这条
					h("div", { className: "dsgc-side" + (tab === "log" ? " dsgc-side-log" : "") },
						h("div", { className: "dsgc-tabs" },
							h("button", { className: "dsgc-tab" + (tab === "local" ? " dsgc-tab-on" : ""), onClick: () => switchTab("local") },
								"本地变更" + (localFiles && localFiles.length > 0 ? " (" + localFiles.length + ")" : "")),
							h("button", { className: "dsgc-tab" + (tab === "log" ? " dsgc-tab-on" : ""), onClick: () => switchTab("log") }, "提交日志")
						),
						tab === "local"
							? h(react.Fragment, null,
									h("div", { className: "dsgc-list" },
										localLoading && !localFiles
											? h("div", { className: "dsgc-loading" }, "读取中…")
											: !localFiles || localFiles.length === 0
												? h("div", { className: "dsgc-empty" }, "没有本地变更。")
												: localFiles.map((f) =>
														h("div", { key: f.path, className: "dsgc-item" + (currentLocal === f ? " dsgc-item-on" : ""), onClick: () => { setSelLocal(f.path); setSelected({}); } },
															h("input", { type: "checkbox", className: "dsgc-check", checked: !!selected[f.path], onClick: (e) => e.stopPropagation(), onChange: (e) => setSelected((s) => ({ ...s, [f.path]: e.target.checked })) }),
															h("span", { className: "dsgc-item-path", title: f.path }, baseName(f.path)),
															h("span", { className: "dsgc-chip" + (f.untracked ? " dsgc-chip-untracked" : f.code[0] === "A" ? " dsgc-chip-added" : f.deleted ? " dsgc-chip-deleted" : " dsgc-chip-modified") }, f.status)
														)
													)
									),
									localFiles && localFiles.length > 0
										? h("div", { className: "dsgc-batchbar" },
												h("span", { className: "dsgc-batchcount" }, "已选 " + Object.keys(selected).filter((p) => selected[p]).length + " 个"),
												h("button", { className: "dsgc-mini dsgc-mini-danger", onClick: revertSelected, disabled: Object.keys(selected).filter((p) => selected[p]).length === 0 }, "回滚选中"),
												h("button", { className: "dsgc-mini dsgc-mini-danger", onClick: revertAll }, "全部回滚")
											)
										: null
								)
							: h(react.Fragment, null,
								h("div", { className: "dsgc-list" },
									logLoading && !commits
										? h("div", { className: "dsgc-loading" }, "读取中…")
										: !commits || commits.length === 0
											? h("div", { className: "dsgc-empty" }, "没有提交记录。")
											: commits.map((c) =>
														h("div", { key: c.hash, className: "dsgc-item" + (selCommit === c.hash ? " dsgc-item-on" : ""), onClick: () => setSelCommit(c.hash) },
															h("div", { className: "dsgc-commit" },
																h("span", { className: "dsgc-commit-subject" }, c.subject),
																h("span", { className: "dsgc-commit-meta" }, c.author + " · " + c.date + " · " + c.short),
																c.refs ? h("span", { className: "dsgc-commit-refs" }, c.refs) : null
															)
														)
													)
									),
								// 手机版：这块一直占着下半屏（电脑版靠 .dsgc-logfiles{display:none} 隐藏）
								h("div", { className: "dsgc-logfiles" },
									!selCommit
										? h("div", { className: "dsgc-emptydetail" }, "选择一个提交查看改动文件")
										: commitFilesLoading
											? h("div", { className: "dsgc-loading" }, "读取文件…")
											: !commitFiles || commitFiles.length === 0
												? h("div", { className: "dsgc-emptydetail" }, "该提交没有改动文件。")
												: commitFiles.map((f) =>
															h("div", { key: f.path, className: "dsgc-item" + (selLogFile === f.path ? " dsgc-item-on" : ""), onClick: () => setSelLogFile(f.path) },
																h("span", { className: "dsgc-chip" + (f.code[0] === "A" ? " dsgc-chip-added" : f.code[0] === "D" ? " dsgc-chip-deleted" : " dsgc-chip-modified") }, f.status),
																h("span", { className: "dsgc-item-path", title: f.path }, baseName(f.path))
															)
													)
								)
								)
					),
					// -------- 右：详情 --------
					tab === "local"
						? h("div", { className: "dsgc-detail dsgc-detail-local" + (currentLocal ? "" : " dsgc-detail-hidden") },
								!currentLocal
									? h("div", { className: "dsgc-empty dsgc-detail-empty" }, "从左侧选择一个文件查看变更")
									: h(react.Fragment, null,
											h("div", { className: "dsgc-filehead" },
												h("span", { className: "dsgc-fpath", title: currentLocal.path }, currentLocal.path),
												h("span", { className: "dsgc-chip" + (currentLocal.untracked ? " dsgc-chip-untracked" : currentLocal.code[0] === "A" ? " dsgc-chip-added" : currentLocal.deleted ? " dsgc-chip-deleted" : " dsgc-chip-modified") }, currentLocal.status),
												h("button", { className: "dsgc-btn dsgc-sheet-collapse", onClick: () => { setSelLocal(null); setLocalDiff(null); } }, "\u25BC 收起")
											),
											h("div", { className: "dsgc-tools" },
												h("button", { className: "dsgc-mini dsgc-mini-primary", onClick: () => copyDiff(localDiff), disabled: !localDiff || localDiff.binary }, "复制代码"),
												h("button", { className: "dsgc-mini dsgc-mini-danger", onClick: () => revertOne(currentLocal.path) }, "回滚此文件")
											),
											h("div", { className: "dsgc-body" },
												localDiffLoading
													? h("div", { className: "dsgc-loading" }, "读取差异…")
													: !localDiff
														? h("div", { className: "dsgc-emptydetail" }, "无差异。")
														: localDiff.binary
															? h("div", { className: "dsgc-binary" }, "二进制文件，无法显示差异。")
															: h(DiffView, { diff: localDiff })
											)
									)
							)
						: h("div", { className: "dsgc-detail dsgc-detail-log" + (selLogFile ? " dsgc-has-file" : "") + (selCommit ? "" : " dsgc-detail-hidden") },
								!selCommit
									? h("div", { className: "dsgc-empty dsgc-detail-empty" }, "从左侧选择一个提交查看改动文件")
									: h(react.Fragment, null,
											h("div", { className: "dsgc-filehead" },
												h("span", { className: "dsgc-fpath", title: selCommit }, (commits || []).find((c) => c.hash === selCommit)?.subject || selCommit),
												selLogFile ? h("span", { className: "dsgc-fsub", title: selLogFile }, selLogFile) : null,
												h("button", { className: "dsgc-btn dsgc-sheet-collapse", onClick: () => { setSelLogFile(null); setLogDiff(null); } }, "\u25BC 收起")
											),
											h("div", { className: "dsgc-tools" },
												h("span", { className: "dsgc-caption" }, "日志只读，不支持回滚")
											),
											h("div", { className: "dsgc-files" },
												commitFilesLoading
													? h("div", { className: "dsgc-loading" }, "读取文件…")
													: !commitFiles || commitFiles.length === 0
														? h("div", { className: "dsgc-emptydetail" }, "该提交没有改动文件。")
														: commitFiles.map((f) =>
																h("div", { key: f.path, className: "dsgc-item" + (selLogFile === f.path ? " dsgc-item-on" : ""), onClick: () => setSelLogFile(f.path) },
																	h("span", { className: "dsgc-chip" + (f.code[0] === "A" ? " dsgc-chip-added" : f.code[0] === "D" ? " dsgc-chip-deleted" : " dsgc-chip-modified") }, f.status),
																	h("span", { className: "dsgc-item-path", title: f.path }, baseName(f.path))
																)
															)
											),
											selLogFile
												? h("div", { className: "dsgc-body" },
														logDiffLoading
															? h("div", { className: "dsgc-loading" }, "读取差异…")
															: !logDiff
																? h("div", { className: "dsgc-emptydetail" }, "无差异。")
																: logDiff.binary
																	? h("div", { className: "dsgc-binary" }, "二进制文件，无法显示差异。")
																	: h(DiffView, { diff: logDiff })
													)
												: null
									)
							)
				),
				toast ? h("div", { className: "dsgc-toast" }, toast) : null,
				confirm ? h(ConfirmDialog, { message: confirm.message, onConfirm: confirm.onConfirm, onCancel: () => setConfirm(null) }) : null
			);
		}

		function ConfirmDialog({ message, onConfirm, onCancel }) {
			return h("div", { style: { position: "fixed", inset: 0, zIndex: 13010, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center" }, onClick: onCancel },
				h("div", { style: { background: "var(--dsw-alias-bg-layer-1,#14161b)", border: "1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16))", borderRadius: 12, padding: "16px 18px", width: "min(380px, 86vw)", boxShadow: "0 12px 40px rgba(0,0,0,.5)" }, onClick: (e) => e.stopPropagation() },
					h("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 8, color: "var(--dsw-alias-label-primary,#e6e8ec)" } }, "确认回滚"),
					h("div", { style: { fontSize: 13, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary,#9aa4b2)", marginBottom: 14, wordBreak: "break-word", whiteSpace: "pre-wrap" } }, message),
					h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
						h("button", { className: "dsgc-btn", onClick: onCancel }, "取消"),
						h("button", { className: "dsgc-btn dsgc-btn-danger", onClick: onConfirm }, "确认回滚")
					)
				)
			);
		}

		/* ---------- 差异渲染（带行号，左右对照 / 上下堆叠由 CSS 媒体查询决定） ---------- */
		function DiffView({ diff }) {
			const hunks = diff.hunks || [];
			if (hunks.length === 0) return h("div", { className: "dsgc-emptydetail" }, "该文件没有差异。");
			return h("div", { className: "dsgc-diff" },
				hunks.map((hh, i) => h(Hunk, { key: i, hunk: hh }))
			);
		}

		function Hunk({ hunk }) {
			const rows = [];
			let oldNo = hunk.oldStart;
			let newNo = hunk.newStart;
			for (const l of hunk.lines) {
				if (l.type === "del") {
					rows.push({ old: { no: oldNo++, text: l.text }, new: null, type: "del" });
				} else if (l.type === "add") {
					rows.push({ old: null, new: { no: newNo++, text: l.text }, type: "add" });
				} else {
					rows.push({ old: { no: oldNo++, text: l.text }, new: { no: newNo++, text: l.text }, type: "ctx" });
				}
			}
			const blank = (key) => h("div", { key, className: "dsgc-line dsgc-lblank" },
				h("span", { className: "dsgc-lno" }, ""),
				h("span", { className: "dsgc-lsign" }, ""),
				h("span", { className: "dsgc-ltext" }, "")
			);
			return h("div", { className: "dsgc-diff" },
				h("div", { className: "dsgc-side2" },
					h("div", { className: "dsgc-sidecol" },
						h("div", { className: "dsgc-sidelabel" }, "旧版本"),
						rows.map((r, i) => r.old ? h(Line, { key: i, no: r.old.no, text: r.old.text, type: r.type }) : blank(i))
					),
					h("div", { className: "dsgc-sidecol" },
						h("div", { className: "dsgc-sidelabel" }, "新版本"),
						rows.map((r, i) => r.new ? h(Line, { key: i, no: r.new.no, text: r.new.text, type: r.type }) : blank(i))
					)
				)
			);
		}

		function Line({ no, text, type }) {
			const cls = type === "del" ? "dsgc-ldel" : type === "add" ? "dsgc-ladd" : "dsgc-lctx";
			const sign = type === "del" ? "-" : type === "add" ? "+" : " ";
			return h("div", { className: "dsgc-line " + cls },
				h("span", { className: "dsgc-lno" }, no !== null ? String(no) : ""),
				h("span", { className: "dsgc-lsign" }, sign),
				h("span", { className: "dsgc-ltext" }, text)
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.session.header.utilities", () =>
				ctx.slots.register(
					{
						name: "conversation.session.header.utilities",
						id: "dsh-git-changes",
						order: 40,
					},
					GitEntry
				)
			);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});