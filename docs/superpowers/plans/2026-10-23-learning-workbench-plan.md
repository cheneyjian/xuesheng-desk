# 学习工作台第一版实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Electron 工作区中实现课程/课节组织、固定网页来源、MP3 录音、可编辑转写稿和时间戳笔记的学习闭环。

**Architecture:** 保持单个 `BrowserWindow`，左侧远程 `WebContentsView` 承载固定课程网页和网页内视频，右侧本地工具面板管理课程、课节、录音与转写。主进程负责来源白名单、录音关联和本地资料库；新来源默认不允许录音，录音时锁定当前可录音来源。

**Tech Stack:** Electron 39、Node.js、ScreenCaptureKit N-API、`@audio/encode-mp3` WASM、原生 HTML/CSS/JavaScript、本地 JSON 资料库。

**Spec:** `docs/superpowers/specs/2026-10-23-learning-workbench-design.md`

## Global Constraints

- 固定网页来源只使用 HTTPS，来源 URL 的主机自动合并到导航白名单。
- 只有 `recordAudio: true` 的固定来源可以开始录音；录音进行时不允许切换来源。
- 音频只捕获学升桌面版应用进程；无法确认来源或权限时失败关闭，不回退到系统 loopback。
- 新录音为 MP3；已有 WebM 录音、笔记与转写不得丢失。
- 首版只支持固定网页内的视频，不导入本地视频或绕过站点媒体保护。
- 不新增或运行自动化测试；进行语法检查、macOS arm64 打包，并留出用户手动验收。

## Review Focus

- 旧版 `library.json` 缺少课程/课节字段时，历史录音仍能列出、导出和转写，并归入“未归档”。
- 固定站点无效、非 HTTPS、重复 ID 时，不会逃逸白名单或让录音来源错配。
- 录音期间点击固定网站入口或网页跳到另一来源时，导航被阻止且当前 MP3 正常收尾。
- ASR 输出为空或格式异常时，现有转写不被清空。
- 用户编辑时间轴转写时只更新文本，不移动现有时间戳；原始笔记保持原位。

---

### Task 1: 固定来源选择与录音来源锁定

**Files:**
- Modify: `src/main/config.js`
- Modify: `src/main/main.js`
- Modify: `src/preload/panel.js`
- Modify: `src/renderer/panel.html`
- Modify: `src/renderer/panel.css`
- Modify: `src/renderer/panel.js`
- Modify: `README.md`

**Interfaces:**
- `config.sites`: `{ id, name, url, host, recordAudio }[]`。
- Main IPC `sites()` 返回 `{ sites: { id, name, url, recordAudio }[], currentId }`。
- Main IPC `navigateSite(id)` 只接受配置中的固定来源 ID。
- preload 暴露 `sites()`、`navigateSite(id)`、`onSiteChanged(callback)`。

- [ ] **Step 1: 标准化来源配置**
  - 默认保留 `xuesheng` 来源并设为 `recordAudio: true`。
  - 校验 ID、名称、HTTPS URL；过滤重复 ID；把每个来源主机合并进 `allowedHosts`。
  - 用户配置里的其他来源 `recordAudio` 默认 false。

- [ ] **Step 2: 实现只接受固定 ID 的主进程导航**
  - `navigateSite(id)` 查 `config.sites` 后才 `loadURL`，不得接受 renderer 传入任意 URL。
  - `recStart` 必须确认当前 origin 属于 `recordAudio: true` 来源。
  - 录音开始后记录当前 origin；`will-navigate`、窗口打开处理器和 `navigateSite` 阻止离开该 origin，停止录音后解除。

- [ ] **Step 3: 在右侧面板加入网站选择器**
  - 用 IPC 获取固定来源，展示站点名；切换时仅提交来源 ID。
  - 收到 `did-navigate` 后同步当前来源；录音中禁用选择器。
  - 无效来源或切换失败时恢复先前选择并显示错误。

- [ ] **Step 4: 语法检查主进程、preload 和 renderer**
  - Run: `node --check src/main/main.js && node --check src/main/config.js && node --check src/preload/panel.js && node --check src/renderer/panel.js`
  - Expected: 全部退出码为 0。

### Task 2: 课程、课节与历史资料迁移

**Files:**
- Modify: `src/main/library.js`
- Modify: `src/main/main.js`
- Modify: `src/preload/panel.js`
- Modify: `src/renderer/panel.html`
- Modify: `src/renderer/panel.js`

**Interfaces:**
- Course: `{ id, title, createdAt, lessons: Lesson[] }`。
- Lesson: `{ id, title, siteId, sourceUrl, createdAt }`。
- Recording session 增加 `courseId`, `lessonId`, `siteId`, `sourceUrl`，历史会话允许这些字段为 null。
- Library 提供 `createCourse(title)`、`createLesson(courseId, { title, siteId, sourceUrl })`、`getLesson(courseId, lessonId)`。
- Main IPC：`courses()`、`createCourse(title)`、`createLesson(courseId, title)`。

- [ ] **Step 1: 迁移资料库索引结构**
  - `_load()` 将旧索引规范为 `{ courses: [], sessions: [...] }`。
  - 不改写或删除已有录音文件；旧 session 继续保留 `courseId: null`。
  - 新建的课程与课节使用现有安全 ID 生成方式。

- [ ] **Step 2: 在开始录音时校验并保存课程关联**
  - `recStart(title, courseId, lessonId)` 检查课节存在且 `lesson.siteId` 对应当前固定来源。
  - `RecordingWriter.start` 把课程、课节、来源 URL 和来源 ID 一起写入新 session。

- [ ] **Step 3: 添加课程和课节选择入口**
  - 面板支持新建课程、在选定课程下新建课节、选择当前课节。
  - 创建课节时自动关联当前来源 URL；录音需选中有效课节。
  - 历史录音列表显示课程/课节名；无关联的旧录音显示“未归档”。

- [ ] **Step 4: 检查相关 JavaScript 语法**
  - Run: `node --check src/main/library.js && node --check src/main/main.js && node --check src/preload/panel.js && node --check src/renderer/panel.js`
  - Expected: 全部退出码为 0。

### Task 3: 转写稿编辑与录音回放

**Files:**
- Modify: `src/main/library.js`
- Modify: `src/main/main.js`
- Modify: `src/preload/panel.js`
- Modify: `src/renderer/panel.html`
- Modify: `src/renderer/panel.js`
- Modify: `src/renderer/panel.css`

**Interfaces:**
- Main IPC `saveTranscript(id, segments)` 校验 session ID、时间戳和文本后调用 `library.setTranscript`。
- Main IPC `audioUrl(id)` 仅返回由 `library.audioPath(id)` 生成的本地音频 URL。
- preload 暴露 `saveTranscript(id, segments)`、`audioUrl(id)`。

- [ ] **Step 1: 增加安全的转写稿保存入口**
  - `segments` 接受数组 `{ start, end, text }`；时间以毫秒保存，过滤空文本，拒绝非数字时间和超长文本。
  - 不提供远程网页可调用的接口；继续复用面板来源校验。

- [ ] **Step 2: 实现逐句转写编辑器**
  - 已转写的 session 显示“编辑转写稿”；逐句展示时间和可编辑文本。
  - 保存仅更新文本和原时间戳；取消关闭不改数据。
  - 未有 transcript 时保留“转写”入口；转写失败不得清空旧稿。

- [ ] **Step 3: 在资料卡中加入音频播放控件**
  - 通过受 session ID 限制的 IPC 返回 MP3/WebM 文件 URL。
  - 面板 CSP 仅为媒体资源开放所需本地协议；不接受 renderer 自带的任意文件路径。
  - 旧 WebM 与新 MP3 都可播放。

- [ ] **Step 4: 更新录音导出状态与用户说明**
  - 保留 Markdown、SRT、音频导出；在录音详情显示关联课程/课节。
  - 说明固定来源配置格式和新旧音频兼容规则。

### Task 4: 打包并交付第一版

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-23-learning-workbench-design.md`

- [ ] Run all changed JavaScript files through `node --check`。
- [ ] Run: `npm run pack`
- [ ] Verify: `codesign --verify --deep --strict dist/mac-arm64/XueshengDesk.app`
- [ ] Verify packaged app contains the ScreenCaptureKit addon and MP3 encoder.
- [ ] 给用户提供 `.app` 路径及手动验收清单：创建课程/课节、网页视频播放、内录 MP3、其他应用声音排除、转写编辑、时间戳笔记、旧 WebM 导出。
