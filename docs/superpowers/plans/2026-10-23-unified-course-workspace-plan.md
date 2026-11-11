# 统一课程工作区实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将课程网页和录音笔记面板合并到一个窗口，并支持把网页选中文字保存为录音时间戳笔记。

**Architecture:** 用 `BrowserWindow` 作为桌面壳，两个隔离的 `WebContentsView` 分别显示远程课程站和本地面板。主进程通过远程页面右键菜单取得选区，再通过本地面板 preload 通知 renderer；保存仍走现有校验过的笔记 IPC。

**Tech Stack:** Electron 39、Node.js、原生 HTML/CSS/JavaScript。

**Spec:** `docs/superpowers/specs/2026-10-23-unified-course-workspace-design.md`

## Global Constraints

- 远程课程页继续使用 `persist:xuesheng-web`、HTTPS 主机白名单、`contextIsolation`、`sandbox` 和 `nodeIntegration: false`。
- 远程课程页不加载 preload，也不获得通用 IPC 能力。
- 本地面板继续使用本地 preload，主进程继续校验 IPC 调用来源。
- 仅在录音进行且选区非空时，将用户明确选择的文字保存为时间戳笔记。
- 网页选区从触发菜单的 `WebContents` 即时读取，不保留跨导航的全局旧选区。
- 本阶段只有一个网页选区动作，不引入通用 `CommandBus` 或插件层。
- 保留录音资料库路径、转写流程；新录音采用 MP3，旧 WebM 仍可导出。
- 只采集应用自身音频；权限或目标无法确认时拒绝录音，不回退为系统 loopback。
- 按用户要求，本计划只包含人工界面检查，不新增或运行测试。

## Review Focus

- 远程导航和权限隔离在移入 WebContentsView 后必须继续由同一远程 session 执行。
- 收到右键菜单的选区时，如果录音刚结束或面板已关闭，不得写入错误会话。
- 窗口缩小、最大化和恢复时，左右视图边界不能遮挡或越界。
- 正在录音时关闭窗口仍要保留确认提示。
- 网页选区通过一个窄消息进入面板，不得引入远程页面可调用的 IPC API。
- 导航后或无选区时不得复用先前页面的选中文字。

---

### Task 1: 合并网页和面板窗口

**Files:**
- Modify: `src/main/main.js`

**Interfaces:**
- 保留主进程已有的录音、资料库、转写和导出接口。
- 用一个工作区 `BrowserWindow` 管理远程 `WebContentsView` 和本地面板 `WebContentsView`。

- [x] 改造窗口创建流程，使应用仅创建一个默认 1360×900、最小 980×700 的工作区窗口。
- [x] 将现有网页窗口安全选项、partition、导航拦截、外链策略和权限处理迁入远程 `WebContentsView`。
- [x] 将本地面板 preload 和现有关闭录音提示迁入工作区；移除会录系统混音的 loopback 处理器。
- [x] 在窗口 resize 和 ready 后按内容区域更新两视图 bounds，面板宽 420 px。
- [x] 保留菜单、单实例行为、窗口生命周期、配置与资料库菜单。
- [ ] 人工检查：启动只出现一个窗口，网页和面板均可见；最大化、恢复和缩放时两栏正确；窗口菜单与资料库菜单仍可用。已确认单窗口和两栏可见，缩放及菜单仍待人工验收。

### Task 2: 将网页选中文字记为时间戳笔记

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/preload/panel.js`
- Modify: `src/renderer/panel.js`

**Interfaces:**
- 主进程仅向本地面板发送 `{ text }` 选区事件。
- preload 暴露只读订阅方法 `onWebSelection(callback)`，并返回取消订阅函数。
- renderer 在当前录音有效时调用已有 `window.desk.addNote(id, t, text)`。

- [x] 在远程网页上下文菜单中添加“记为当前时间戳笔记”，仅当存在选中文字且录音正在进行时启用。
- [x] 主进程从触发菜单的远程页面取得选中文字，经长度限制后发给本地面板；不接受远程页面发起的 IPC。
- [x] preload 暴露选区事件订阅，并返回清理监听器。
- [x] renderer 收到选区后检查录音会话仍有效，使用当前 elapsed time 保存笔记并更新面板笔记列表；保存失败时显示状态错误。
- [ ] 人工检查：录音时右键选中文字并保存；停止录音后再次触发不能写入旧会话；历史笔记与 Markdown 导出显示该文字和时间戳。

### Task 3: 应用内音频采集与 MP3

**Files:**
- Modify: `src/main/main.js`, `src/main/recorder.js`, `src/main/library.js`
- Modify: `src/preload/panel.js`, `src/renderer/panel.js`, `electron-builder.yml`
- Modify: `package.json`, `package-lock.json`

- [x] 采用 `screencapturekit-audio-capture` 的 ScreenCaptureKit 应用隔离能力，目标锁定当前学升应用 PID。
- [x] 在开始录音前校验当前课程 URL 白名单和采集目标；失败时不调用全系统采集。
- [x] 采用 `@audio/encode-mp3` WASM 流式编码，新录音写为 48 kHz 单声道 128 kbps `audio.mp3`。
- [x] 录音列表、转写与导出按真实扩展名工作，并兼容已有 WebM 文件。
- [x] 同步更新权限说明、开源组件说明、设计与使用文档。
- [ ] 人工验收待用户授权：播放本应用课程网页并同时播放外部浏览器/QQ 音乐，确认只有课程网页声音写入 MP3。

### Task 4: 收尾文档和实际启动

**Files:**
- Modify: `README.md`

- [x] 更新启动和使用说明，描述单窗口布局、网页选区菜单、应用音频范围和 MP3 格式。
- [x] 语法检查通过；macOS arm64 打包完成并验证签名、原生采集模块打包。
- [ ] 重启新打包版并完成人工音源隔离验收；现有应用进程仍在运行，需要退出后重新打开才能加载本次代码。
