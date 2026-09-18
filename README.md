# DeepSeek Harness 桌面壳（dsh-ui）

把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`@deepseek-ai/dsh`）的 Web UI
包成一个 Windows 桌面程序。

## 特性

- **WebView2 内核**：用系统自带的 Edge WebView2 渲染界面，不依赖外部浏览器
- **亮色界面**：启动页与插件管理器都是亮色主题（底色 `#f4f6fb`，DeepSeek 蓝强调色 `#4d6bfe`）
- **无命令行窗口**：打包为 windowed 单文件 exe，服务进程用 `CREATE_NO_WINDOW` 静默拉起
- **系统托盘**：关闭窗口只是收进托盘，服务继续在后台跑；托盘菜单可重新打开界面
- **插件管理器**：托盘 →「插件管理器」，绿灯启用 / 红灯关闭，下面一个「重启服务并生效」
- **插件自动加载**：启动时按启用状态把 exe 同目录 `plugins/` 里的插件装进 dsh
  （`~/.dsh/profiles/web/`），关掉的就撤下来，不用手工改 dsh 的配置
- **一键更新**：托盘 →「检查更新（npm）」，自动执行
  `停止服务 → npm install @deepseek-ai/dsh@latest → 重启服务 → 重载界面`
- **默认走国内镜像**（`registry.npmmirror.com`），托盘菜单可在镜像 / 跟随系统之间切换

## 目录结构

```
src/                         代码（含构建、打包、自测）
├── dsh_shell.py             主程序（服务管理 / WebView2 / 托盘 / 更新 / 插件同步 / 两个界面）
├── app_icon.py              运行时绘制图标，无外部资源依赖
├── build.py                 一键打包入口
├── assets/app.ico           打包用的图标（缺了 build.py 会按 app_icon.py 重新生成）
├── packaging/*.spec         PyInstaller 打包配置
└── tools/                   自测脚本
    ├── probe_service.py         服务层：安装 / 启动 / 健康检查 / 更新 / 停止
    ├── probe_auth.py            鉴权链路：401 → 303 + Set-Cookie → 200
    ├── probe_gui.py             GUI + 托盘：发 WM_CLOSE，确认收进托盘且进程存活
    ├── probe_update.py          npm 更新动作
    ├── probe_plugins.py         插件同步：扫描 → 镜像进 dsh → 重写托管补丁块
    └── probe_plugin_manager.py  插件管理器窗口 + js_api 桥 + 红绿灯渲染

build/                       PyInstaller 工作目录 + Python 字节码缓存（build/pycache）
dist/                        产物：DeepSeekHarness.exe + plugins/（运行时资产，不进 exe）
```

`.pyc` 不走源码目录：`dsh_shell.py` / `build.py` / `tools/*.py` 都设了 `sys.pycache_prefix`，
字节码统一落在 `build/pycache/` 下，源码树里不会再冒 `__pycache__`。

## 构建

```bash
# 准备隔离环境
python -m venv .venv
.venv/Scripts/pip install pywebview pystray pillow pyinstaller

# 打包
.venv/Scripts/python src/build.py
```

产物：`dist/DeepSeekHarness.exe`

`dist/plugins/` 是运行时资产（exe 同目录的插件包），**不打包进 exe**；
构建脚本只会报一下有几个包，不会动它。

## 运行前提

- Windows 10/11，已安装 **WebView2 运行时**（Win11 与近期 Win10 一般自带）
- **Node.js 18+**（`node` 需在 PATH 中，或装在常见默认位置）

首次启动会自动在数据目录里 `npm install @deepseek-ai/dsh`（依赖约 520 个包、
2.3 万个文件，首次需要几分钟，之后走缓存会快很多）。

## 数据目录

两个地方，别搞混：

**① `%LOCALAPPDATA%\DeepSeekHarness\`** —— 本壳程序自己的工作目录，**可丢、可重建**。
换台电脑不用带；只有想省掉重装和重登才值得拷。

| 路径 | 说明 | 丢了会怎样 |
| --- | --- | --- |
| `runtime/` | dsh 的 npm 安装目录（更新就是更新这里，约 220 MB） | 首次启动重新 `npm install`，几分钟 |
| `workspace/` | dsh 启动时的工作目录 | 里面放过东西的话就没了 |
| `webview/` | WebView2 用户数据（Cookie、localStorage） | 界面偏好重置；登录态由下面的 `.dsh` 决定 |
| `config.json` | 配置，`registry` 字段控制 npm 源，留空表示跟随系统 npm 配置 | 回到默认（国内镜像） |
| `plugins.json` | 插件启用状态（插件管理器写，红灯/绿灯就是它） | 所有插件回到默认「开启」 |
| `shell.log` / `service.log` / `stdio.log` | 日志 | 无影响 |

**② `%USERPROFILE%\.dsh\`** —— dsh 自己的数据目录，**这个才是有状态的部分**：
`.credentials.yaml`（账号凭据）、`sessions/`（会话历史）、`storages/`、
`settings.yaml`，加上 `profiles/web/`（profile、插件安装副本、`cordis.patch.yml`）。
换机器想保住登录和聊天记录，要带的是它。

## 插件

插件包放在 **exe 同目录的 `plugins/`**，一个插件一个子目录：

```
dist/
├── DeepSeekHarness.exe
└── plugins/
    └── gitbash/
        ├── manifest.json        # id / name / description / order / entry / patch
        ├── cordis.patch.yml     # 要合进 dsh profile 的补丁片段
        ├── gitbash-shell.mjs    # 插件本体
        └── README.md
```

**装进 dsh 的规则**（dsh-ui 每次启动、以及管理器点「重启」时执行）：

1. 扫 `plugins/` 下所有带 `manifest.json` 的包；没记录过的插件默认**开启**；
2. 开启的包 → 整目录镜像到 `%USERPROFILE%\.dsh\profiles\web\plugins\<id>\`
   （源目录没变就跳过复制，靠 `.dsh-ui-plugin.json` 指纹判断）；
3. 关闭的包 → 删掉安装副本（只删本程序装的，认指纹文件；目录链接一律不碰）；
4. 把已启用插件的补丁片段按 `order` 拼成一个托管块，重写
   `~/.dsh/profiles/web/cordis.patch.yml` ——
   两个 `dsh-ui 插件管理块` 标记之外的内容原样保留，没有插件时回到 `[]`。

插件目录里 `cordis.patch.yml` 的 `./plugins/<id>/<entry>` 是**相对 profile 目录**的
路径，dsh 的 loader 会把它转成 `file://` —— 所以插件本身可以放在任何地方。

### 内置：`gitbash`

Windows 上把 shell 执行器换成 Git Bash，并把模型看到的 shell 工具从 `pwsh`
改成 `bash`。**纯插件**：不写 agent 预设、不动 `$DSH_HOME/.agent-presets`，
改名和提示词改写都在运行时拦截工具注册完成。原理、代价和踩过的坑见
[dist/plugins/gitbash/README.md](dist/plugins/gitbash/README.md)。

## 两个容易踩的坑

1. **访问必须带 token。** `dsh web` 启动时会打印
   `http://127.0.0.1:3080/?token=xxx`，直接访问裸地址会返回 `401`。
   本程序启动服务时抓取该地址（`--no-open` 同时阻止 dsh 自己弹浏览器），
   带 token 访问会拿到 `303 + Set-Cookie`，Cookie 落在 `webview/` 里持久化。
2. **token 每次启动都变**，所以服务必须由本程序自己拉起，不能复用外部已在跑的实例。

### 自测

```bash
<venv>/Scripts/python.exe src/tools/probe_plugins.py --list      # 只看扫描到哪些插件
<venv>/Scripts/python.exe src/tools/probe_plugins.py             # 真同步一次到 ~/.dsh
# 想不碰真实环境，指向临时目录：
<venv>/Scripts/python.exe src/tools/probe_plugins.py \
    --plugins-dir <临时插件目录> --dsh-home <临时 dsh 目录>
```

`probe_gui.py` 可以带一个参数：不传跑源码，传 exe 路径就测打包产物。

## 已验证的边界

`dsh web` 只监听 loopback，不允许对外提供服务：`--host 0.0.0.0` 被 CLI 直接拒绝，
`--host <具体IP>` 过不了配置校验。要让其他设备访问只能套反向代理/隧道，
且真实 authority 必须进 `--trusted-host`，否则 `/api` 会被 browser-trust fence 挡成 403。
