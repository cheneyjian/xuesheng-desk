# 学习工作台（macOS 优先）

将固定课程网站放进桌面工作区，并在同一窗口管理课程、课时、应用内录音、时间戳笔记、转写稿和导出。

单窗口左右分栏：

- **课程网页**：加载课程网站。它没有通往本地功能的通用接口，且只能停留在白名单域名里。
- **学习面板**：本地页面，负责课程/课时归档、内录、记笔记、转写稿编辑、回放和导出。

## 运行（macOS）

需要 Node.js 20 或更高版本。

```bash
cd xuesheng-desk
npm install
npm test          # 单元测试，不需要图形界面
npm run pack      # 打出可运行的 .app，放在 dist/mac-*/ 下
```

内录直接绑定到当前课程网页的 Chromium `WebContents` 音轨。不会请求系统混音、桌面录音权限或麦克风；其他网页和外部应用的声音不属于采集源。录音时切换网站、重载或关闭课程页会停止这段录音。

## 使用

1. 在左侧课程网页登录并打开课程。
2. 在右侧新建课程和课时，课时自动关联当前固定网站；填写学习记录名，点“开始内录”，然后播放课程。声音条会跳动。
3. 录音中可在右侧输入笔记按回车记下当前时刻；也可在网页里选中文字并右键，选择“记为当前时间戳笔记”。
4. 点“停止并保存”。录音会关联课程和课时。录音列表支持回放、转写、编辑逐句文字、导出文字稿 / 字幕 / 音频、打开所在文件夹。旧录音显示为“未归档”。

数据位置：`~/Library/Application Support/XueshengDesk/library/`（菜单“工具 → 打开资料库文件夹”）。
每段录音一个目录，新录音保存为通用的 `audio.mp3`（48 kHz、单声道、128 kbps），边录边编码并追加写盘；异常退出时已写入的 MP3 部分通常仍可播放。旧的 WebM 录音仍可读取和导出。

## 配置

菜单“工具 → 打开配置文件”。常用项：

| 项 | 说明 |
|---|---|
| `allowedHosts` | 网页窗口允许停留的域名。登录若跳转到其他域名（统一登录、微信等），把域名加进来，改完重启 |
| `startUrl` | 起始页 |
| `sites` | 右侧“切换网站”固定列表；每项提供 `id`、`name`、`url` 和可选 `recordAudio` |
| `asr` | 转写命令，见下 |

固定网站示例：

```json
"sites": [
  { "id": "xuesheng", "name": "学升课程", "url": "https://webapp.songy.info/#/home", "recordAudio": true },
  { "id": "example", "name": "示例站点", "url": "https://example.com/", "recordAudio": false }
]
```

网站条目的 HTTPS 主机自动加入导航白名单。只有 `recordAudio: true` 的固定站点能开始录音；录音时锁定当前网站。音轨由 Electron 的 `setDisplayMediaRequestHandler` 明确指定为课程网页的 `mainFrame`，本地隐藏录音页通过 `getDisplayMedia` 接收并转成 PCM 编码 MP3。网页麦克风权限仍被拒绝；浏览器、QQ 音乐等其他来源不会进入录音。新增站点默认不能录音，只有信任且确认可用后才在配置中显式设置 `recordAudio: true`。

每条转写按毫秒时间戳保存。编辑器只允许改文本，不调整时间轴；保存转写会保留时间戳笔记。

## 转写

默认调用 `tools/funasr_transcribe.py`（FunASR 的 `paraformer-zh`，本地离线，带标点和时间戳）：

```bash
brew install ffmpeg
pip install funasr modelscope torch torchaudio
```

首次转写会下载模型，需要联网。**这个脚本没有在真实环境跑过**，FunASR 的参数随版本有变化，报错时把信息贴出来调整即可。

想换别的引擎（whisper.cpp 等），只要命令满足这个约定就能接入：

- 参数里的 `{audio}` 是输入音频路径，`{out}` 是要写出的 JSON 路径，`{app}` 是应用资源目录
- 输出 JSON：`{"segments":[{"start":秒,"end":秒,"text":"..."}]}`

## 安全设计

- 网页窗口：`contextIsolation`、`sandbox` 开启，`nodeIntegration` 关闭，不加载 preload。
- 导航白名单：只允许 https 且域名在 `allowedHosts` 内，其余链接交给系统浏览器，且只放行 https。
- 权限：网页窗口默认拒绝所有权限请求（Electron 默认是全部批准）。
- 音频来源：主进程只把明确选定课程网页的 Chromium 音轨交给隔离的本地录音页。没有系统混音或麦克风回退；录音中网页音轨中断时停止并保留已写入的 MP3。
- IPC：每个处理器都校验调用方是本地面板；会话编号做格式校验，防止路径穿越。

## 开源组件

- [@audio/encode-mp3](https://github.com/audiojs/encode)：MIT，负责 WASM 流式 MP3 编码。
- Electron `session.setDisplayMediaRequestHandler`：选定当前 `WebContents` 的网页帧音轨（Tab audio）。

## 还没做的

- Windows / Linux 的内录实测；目前真实音频隔离验收在 macOS 完成。
- 动态生成与发布（图加文）
- 签名、公证、自动更新

## 合规提醒

内录和导出只限个人学习研究，不要外传；使用前请确认平台条款没有禁止录制。
