# DeepSeek Harness 本地桌面客户端

一个 Electron 桌面应用：启动时**内嵌拉起 DSH 后端**（`dsh web`），把完整聊天界面装进原生窗口，**不需要打开浏览器**。

- 若 `127.0.0.1:3080` 已有一个 DSH Web 实例在运行（比如你正开着浏览器界面），客户端会直接复用，不会重复启动后端。
- 否则自动挑一个空闲端口（3080 起）拉起自己的后端，轮询就绪后加载界面。
- 关闭窗口即退出；退出时用 `taskkill /T` 清理整个后端进程树。
- 与现有 `dsh web` 共享同一份 `$DSH_HOME`（会话、设置、存储互通）。

## 目录结构

```
dsh-desktop/
├── src/
│   ├── main.js        # 主进程：内嵌后端、就绪探测、窗口、退出清理
│   ├── preload.js     # 最小 preload（只暴露启动状态事件）
│   └── loading.html   # 启动等待页
├── scripts/pack.js    # 便携版打包脚本（免安装）
├── assets/icon.png    # 应用图标
└── package.json
```

## 开发运行

```bash
npm install
npm start
```

首次运行会弹出「正在启动 DSH 后端…」等待页，就绪后自动进入聊天界面。

## 打包为 Windows 便携版（免安装 exe）

```bash
npm run pack
```

## 打包为安装器（可在别的电脑安装）

```bash
npm run dist
```

产物在 `release/DeepSeek Harness Setup 0.2.0.exe`（约 135MB）——标准 NSIS 安装向导：
可选手动选安装目录、自动创建桌面快捷方式和开始菜单、带卸载程序（控制面板可卸载）。
安装后无需 node / npm / 浏览器。

> 构建环境变量：`ELECTRON_BUILDER_BINARIES_MIRROR`（NSIS 二进制镜像）与
> `ELECTRON_BUILDER_CACHE`（缓存目录），国内网络可指向 npmmirror。
> 静默安装：`DeepSeek Harness Setup 0.2.0.exe /S /D=<目录>`；静默卸载：`Uninstall DeepSeek Harness.exe /S`。

## 便携版（免安装）

```bash
npm run pack
```

产物在 `dist/DeepSeek Harness-win32-x64/`，把整个文件夹拷走即可，双击 `DeepSeek Harness.exe` 运行。

> 说明：两种打包都通过 `ELECTRON_RUN_AS_NODE=1` 复用 Electron 自带的 Node 来跑 DSH 后端，无需额外携带 node。
> 注意：electron-builder 会按依赖图裁剪 node_modules，dsh 的 peer/间接依赖需在
> `package.json` 的 `dependencies` 里显式列出（见 `cordis-plugin-group` 等 19 个包），否则安装版启动后
> 后端会报 `ERR_MODULE_NOT_FOUND`。

## 功能

- **托盘常驻**：关闭窗口默认最小化到托盘（后台继续运行），托盘菜单可显示窗口、在浏览器打开、开机自启开关、系统通知开关、设置、退出
- **崩溃自动重启**：后端异常退出后自动重启（最多 5 次，带 5s 退避），稳定运行 2 分钟重置计数
- **dsh 版本检测**：启动时对比本机 `@deepseek-ai/dsh` 与 npm 最新版，有新版本时通知并显示在设置面板
- **设置面板**（托盘菜单 → 设置）：复用已有实例开关、关闭行为、开机自启、系统通知、起始端口
- **系统通知**：后端就绪 / 崩溃重启 / 新版本提醒
- **开机自启**：通过设置或托盘菜单开关

## 日志

后端输出写入 Electron 用户数据目录下的 `dsh-backend.log`（Windows 通常在
`%APPDATA%/DeepSeek Harness/dsh-backend.log`），排查启动问题先看它。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DSH_DESKTOP_REUSE` | 设为 `0` 时跳过「复用已有 3080 实例」检测，总是启动独立的 DSH 后端实例（优先级高于设置面板的开关） |

## 常见问题

- **安装慢 / 下载失败**：npm 走 `registry.npmmirror.com`，electron 二进制走
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，可自行设置镜像。
- **端口全被占用**：起始端口起的 40 个端口都被占时会报错，可在设置面板改起始端口。
- **窗口打不开 / 界面空白**：看 `dsh-backend.log` 里后端的输出。
- **找不到托盘图标**：点击系统托盘区的「^」展开图标；左键单击托盘图标可显示/聚焦主窗口。
