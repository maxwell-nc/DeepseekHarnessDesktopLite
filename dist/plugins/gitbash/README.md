# dist/plugins/gitbash — 让 dsh 在 Windows 上只用 Git Bash（纯插件版）

把 DeepSeek Harness（`@deepseek-ai/dsh`）的 shell 执行器换成 Git Bash，
**并让模型看到的 shell 工具就叫 `bash`**。

这个目录是 **dsh-ui 的插件包**：exe 同目录的 `plugins/` 下每个子目录是一个插件，
dsh-ui 启动时会把「已启用」的插件镜像到 dsh 自己的插件目录并刷新 profile 补丁。

```
dist/plugins/gitbash/
├── manifest.json        # 插件元数据（dsh-ui 读它）
├── cordis.patch.yml     # 合进 <profile>/cordis.patch.yml 的补丁片段
├── gitbash-shell.mjs    # 插件本体（执行器 + 工具改写）
└── README.md
```

## 装法

不是手工装的 —— 托盘菜单 →「插件管理器」，绿灯是启用，点「重启服务并生效」。
dsh-ui 会把本目录镜像到 `%USERPROFILE%\.dsh\profiles\web\plugins\gitbash\`，
并把 `cordis.patch.yml` 的托管块写成：

```yaml
- id: bash-sandbox
  disabled: true
- id: pwsh-sandbox
  disabled: true
- insert:
    - id: bash-gitbash
      name: ./plugins/gitbash/gitbash-shell.mjs
      config: { timeoutMs: 60000, fromTool: pwsh, toolName: bash }
```

关掉插件时，安装副本和这几行补丁会被一起撤掉，`cordis.patch.yml` 回到 `[]`。

## 与旧版（preset 版）的区别

| | 旧版 | 现在 |
|---|---|---|
| host 平面（谁提供 `ctx.shell`） | `cordis.patch.yml` | 一样 |
| agent 平面（模型看到 bash 还是 pwsh） | `$DSH_HOME/.agent-presets/gitbash/agent.cordis.yml` + `settings.yaml` 的 `agent-presets.default` | **不需要了**：插件在运行时拦截工具注册，把 `pwsh` 改写成 `bash` |
| 升级 dsh 后 | 需要重新复制一份 shipped `standard` 预设（会落后） | 不用管，改写在运行时发生 |
| 卸载 | 4 步手工清理 | 管理器里点红灯 |

**为什么两层变一层是可行的**：`ctx.tools`（dsh-base 的 `tools` 行）是 host 平面
唯一的工具注册表，agent 预设里的工具行都是往**同一个 ToolRuntime 实例**注册的
（跨 scope 共享，`this.ctx` 由 cordis 的 tracker 按调用方作用域重绑）。
所以插件给 `ToolRuntime.prototype.register` 套一层，就能覆盖包括 per-preset 在内的
所有注册。`register` 本身只做「校验 + 按名字入表」，改写发生在入表之前 —— 后续
`view` / `schemaOf` / dispatch 全都自然读到新名字，**模型看到的 schema 和实际可执行
的名字不会不一致**。

改写只动三处：工具名、工具描述、`command` 参数说明。执行体一行未改，
它照旧走 `ctx.shell` —— 也就是下面的 Git Bash 执行器。

## 为什么需要它

上游 `dsh-base` 按平台二选一：win32 挂 `pwsh-sandbox`，其他平台挂 bash 那一套。
Windows 上改成 bash 有三层原因（都是实测，不是推测）：

1. **裸 `bash` 是 `ENOENT`**。Git for Windows 只把 `<Git>\cmd` 加进 PATH，
   那里只有 `git.exe`；bash.exe 在 `<Git>\bin` 和 `<Git>\usr\bin`，都不在 PATH 上。
   而上游执行器把 `"bash"` 硬编码成 argv[0]，没有配置项能改。
2. **两个 bash 不等价**。`<Git>\bin\bash.exe` 的 wrapper 会先把
   `/mingw64/bin:/usr/bin` 塞进 PATH；`<Git>\usr\bin\bash.exe` 是非登录 shell，
   `command -v ls` 直接找不到，还会继承宿主的 `BASH_ENV`。所以固定优先 `<Git>\bin`。
3. **Git Bash 跑不了 dsh 的 Windows ACL 沙箱**。`dsh-sandbox-windows-acl` 的
   runner 下实测：`cmd.exe` / `node.exe` 正常，`bash.exe` →
   `couldn't create signal pipe, Win32 error 5`（exit 127）。
   MSYS2 要在内核对象命名空间建信号管道，受限令牌不给权限。
   → 插件走**无沙箱**执行器；`DSH_GITBASH_SANDBOX=1` 保留沙箱分支备用。

**代价**：shell 命令以 harness 自身权限运行，不再受 workspace-write / read-only
文件访问限制。**文件工具那条路径不受影响** —— `dsh-fs-sandbox` 是独立体系。
工具描述里已经把这一点如实告诉了模型。

## 跨机器 / 跨项目的细节

- **插件里没有绝对路径。** 插件需要 `@deepseek-ai/dsh-bash-local` 这类包才能
  `extends`，而 Node 是按**插件文件自己的位置**解析裸包名的 —— 插件一旦离开
  `$DSH_HOME/profiles/`（本包就在 exe 目录里），静态 `import` 立刻
  `ERR_MODULE_NOT_FOUND`。所以插件用 `hostImport()`：从 dsh 运行时自己的
  `node_modules` 解析包入口再 `import`（顺序：`DSH_GITBASH_MODULE_ROOT` →
  从 `process.argv[1]` 往上找带 `@deepseek-ai` 的 `node_modules` →
  `%LOCALAPPDATA%\DeepSeekHarness\runtime\` → 按本文件位置正常解析）。
- **patch 里 `name` 只能是纯字符串。** 给 `!!js` 会让 loader 拿到表达式对象，
  然后 `name.startsWith is not a function` 崩掉。`disabled` 和 `config` 里可以用。
- **补丁必须成对处理两个执行器。** 上游的 bash/pwsh 执行器会抢同一个 `ctx.shell`，
  只关一个 profile 加载不了。
- **`sandboxMode` 必须声明。** `dsh-permission-presets` 构造函数第一件事就是
  `if (ctx.shell.sandboxMode === void 0) throw ...`。这里如实转述**部署的**模式
  （`ctx.sandboxPolicy.defaultMode`，即 `DSH_PERMISSION_MODE`），**不要**谎报
  `danger-full-access` —— `pinInitialPermission` 会钉住会话模式，连文件围栏一起解掉。
- **工具改写是拦截内部方法，属于"依赖实现"的接法。** 上游若重构
  `ToolRuntime.register`，改写会失效（日志里会打不出"已改写"，Git Bash 执行器部分
  仍然工作，只是模型看到的还是 pwsh 提示词）。异常一律被吞掉、不影响 dsh 启动。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | dsh 配置根，缺省 `~/.dsh` |
| `DSH_GIT_BASH` | 显式指定 bash.exe，优先于自动探测 |
| `DSH_GITBASH_MODULE_ROOT` | 显式指定 dsh 运行时的 `node_modules`（自动探测失败时用） |
| `DSH_GITBASH_SANDBOX=1` | 改用沙箱执行器（MSYS2 下会 error 5） |

## 启动横幅（用来确认插件生效）

```
[dsh-bash-gitbash] bash = C:\Program Files\Git\bin\bash.exe（无沙箱执行器）
[dsh-bash-gitbash] 工具改写已装：pwsh -> bash
[dsh-bash-gitbash] 正在注册的工具 pwsh 已改写为 bash      # 每个会话/预设挂载打一次
```
