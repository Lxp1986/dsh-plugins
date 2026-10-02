# Video Studio 剪辑工作台（@local/dsh-video-studio）

一个跑在 DeepSeek Harness 里的剪映式视频剪辑插件：**多轨时间线 + 自动字幕 + 自动配音 + 一键导出**。
宿主侧用 ffmpeg 完成真正的渲染；客户端是 Harness Web UI 里的完整剪辑面板（侧栏「剪辑工作台」图标）；
Agent 侧同时暴露 7 个 `video_studio_*` 工具 —— 你可以自己剪，也可以让我替你剪。

```
plugins/video-studio/       仓库中的插件目录（@local/dsh-video-studio）
├── package.json            物料清单：bundle patch + dsh.client 声明
├── cordis.patch.yml        插入宿主插件行 video-studio
├── index.js                宿主入口：解析配置、注册工具与 /video-studio 路由
├── client.js               Web 面板（剪映风格：顶栏 / 媒体库 / 预览 / 检查器 / 多轨时间线）
├── locale/{zh,en}.json     插件卡片文案
├── lib/                    ffmpeg 管线、字幕、配音、项目存储、HTTP API、工具
├── tools/ffmpeg-wrap.py    ffmpeg 包装器（可选，见文末 WAV 兼容）
└── test/                   三套测试：管线 16 项、激活 7 项、客户端契约 1 项
```

环境要求：`ffmpeg`/`ffprobe`（需含 **libass** 才能烧字幕，macOS 可用 `brew install ffmpeg`）；
自动配音依赖 macOS `say`；自动字幕依赖 Harness 内置的本地 SenseVoice 识别包（见下）。

## 界面（剪映风格）

```
┌────────────────────────────────────────────────────────────────────────────┐
│ [☰] VideoStudio  项目名  [画幅▾]              ffmpeg ✓  语音 ✓  [项目▾] [导出]│
├───────────┬──────────────────────────────────────────────┬─────────────────┤
│ 媒体/音频/文本 │              预览画面（黑底）                  │   检查器        │
│  缩略图网格    │  ─────────────────────────────────────────  │  选中片段：入出点 │
│  目录/工作区   │  ⏮  ▶  ⏭   00:03.2 / 00:25.6   [时间线|成片] │  选中字幕：文本  │
├───────────┴──────────────────────────────────────────────┴─────────────────┤
│ [时间线] [✂分割] [合并] [删除] [加字幕]              [缩放 ──●──] [适配]      │
│ 0:00      0:05      0:10      0:15      0:20      ← 标尺 + 红色播放头         │
│ V1 │ ▓▓胶片缩略条▓▓│▓▓▓▓▓▓│██图片██│      ← 拖动两端裁剪、点击选中            │
│ A1 │ ~~~~~~~~波形~~~~~~~~~~~~~~~ │      ← ffmpeg 生成的音频波形              │
│ T1 │ [字幕块][字幕块] [字幕块]        ← 点击定位、右侧编辑文本                │
└────────────────────────────────────────────────────────────────────────────┘
```

- 快捷键：`空格` 播放/暂停，`←/→` 步进 0.1s（`Shift` 为 1s），`Delete` 删除选中片段，
  `⌘Z` 撤销 / `⇧⌘Z` 重做，`⌘/Ctrl+S` 保存字幕。
- 预览即合成效果：播放到某条字幕时会**在画面上叠加字幕**（跟随字幕样式），并**同步播放配音轨**；
  控制条上的「配音」按钮可开关配音试听，播放器音量则跟随导出设置里的原声音量/静音。
- 时间线缩放：滑杆或 ± 按钮；「适配」按窗口宽度自动铺满。
- 选片段后两端出现拖拽手柄，可直接拖拽裁剪；右侧检查器同时提供精确数值输入。
- 时间线上的拖动、缩放、播放头均为本地交互，只有提交时才写回宿主（裁剪在松手时提交）。

## 功能

| 能力 | 说明 |
|---|---|
| 素材导入 | 视频 / 音频 / 图片静帧，自动探测分辨率、帧率、音轨；缩略图/胶片缩略条/音频波形**在导入返回后后台补齐**，大文件不阻塞面板 |
| 撤销/重做 | 每次改动前的项目快照存于 `dataRoot/history/<id>.json`（保留 20 步），面板按钮或 `⌘Z`/`⇧⌘Z` |
| 访问令牌（可选） | 设 `requireToken: true` 后进程生成一次性令牌并注入页面，所有 `/api/*` 请求需携带；**默认关闭**，因为该门依赖「首页注入 + 模块缓存」两者一致，改代码后未重启会把面板锁在外面 |
| 时间线 | 多片段顺序拼接、入/出点裁剪（拖拽或数值）、左右调序、**播放头处分割**、同源邻段合并、删除 |
| 预览播放 | 浏览器内跨片段连续播放（播完自动跳下一条并定位入点），可切换「时间线 / 成片」 |
| 自动字幕 | ffmpeg `silencedetect` 找停顿 → 按语音区间切块 → 本地 SenseVoice 识别 → 按语音时长把句子映射回真实时间轴 |
| 字幕编辑 | 面板内新增/改文本/改时间/删除、下载 SRT；也可由我翻译后经 `video_studio_subtitles set` 回填 |
| 自动配音 | macOS `say` 逐句合成，超长自动变速（atempo）对齐，按时间轴混排成配音轨；支持「按字幕」与「按文稿」 |
| 背景音乐 | 从媒体目录选音频作为 BGM，独立音量，循环铺满并混入 |
| 字幕烧录 | 按画幅生成 ASS（PingFang SC、白字黑边、底部居中），颜色/字号/描边/位置可调 |
| 导出 | H.264 + AAC、`+faststart`、原声/配音/BGM 三路混音、画幅预设 横屏/竖屏/方形/720p |
| 任务 | 识别/配音/渲染都是带进度的后台任务，面板与工具都能轮询 |

## 面板用法

1. 侧栏点「剪辑工作台」→ 中间出现工作台；没有项目时中间是新建/打开项目的卡片。
2. 左栏「导入」上传文件，或在工作区/目录里双击（或点右上「+」）把素材加到时间线。
3. 时间线点选片段 → 拖两端裁剪，或在右侧检查器输入精确入/出点；`✂分割` 在播放头处切开。
4. 右栏「字幕」→ 选语言 → **自动字幕**（首次先点「准备语音模型」）；`加字幕` 可在播放头手写一条。
5. 右栏「配音」→ 选音色/语速 → **生成配音**；可试听配音轨，并设置原声与 BGM 音量。
6. 右栏「导出」→ 勾选烧字幕/混配音/混音乐 → **开始导出**；成片可播放、下载、复制到工作目录。

## 自动字幕的模型

自动字幕依赖 Harness 内置的本地 SenseVoice 识别，需启用官方可选包
**`@deepseek-ai/dsh-experimental-voice-input-bundle`**（本插件安装时已一并启用）。

- 首次点「准备语音模型」，下载约 **239 MB** 量化模型到 `~/.dsh/speech-to-text/sensevoice/`，之后完全离线。
- 两个下载源（HuggingFace / hf-mirror）都会尝试，已校验文件可复用；面板显示当前阶段（check/downloading/verify/load）。
- **下载太慢的解法**：国内直连 HuggingFace / hf-mirror 实测只有 ~50 KB/s，而同一模型的
  [GitHub release 资源](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2)
  实测 **2.6 MB/s**（约 55 倍）。下完取出 `model.int8.onnx` 与 `tokens.txt` 放进
  `~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/`，再点「准备语音模型」触发自校验即可（SHA256 与插件固定值一致才通过）。
- **实测调参**（中文口播、每句话一条字幕）：`chunkSeconds: 2.5` + `silenceNoise: -42dB` + `silenceMin: 0.35`
  让「一次识别只覆盖一个语音区间」，字幕时间误差实测 **0.02s**；再配 `chunkLeadSeconds: 0.2`
  （识别前多留 0.2s 起音）可救回被切掉的句首字。
- 模型未就绪时「自动字幕」会明确报出阶段与原因，不会静默失败。
- 没有模型也能用：字幕可手写或由我翻译后回填，其余功能全部可用。

## Agent 工具

| 工具 | 用途 |
|---|---|
| `video_studio_status` | 能力总览：ffmpeg、语音提供方与模型状态、音色、项目列表 |
| `video_studio_project` | create / open / list / update（改名、画幅、字幕样式、BGM、配音参数）/ delete |
| `video_studio_media` | files / import / clips / update（裁剪，自动重算字幕时间）/ remove / **split** / **merge** |
| `video_studio_subtitles` | auto / set（翻译回填）/ get / script（逐行稿，便于翻译） |
| `video_studio_dub` | voices / start（音色、语速、按字幕或按文稿） |
| `video_studio_render` | start（烧字幕/混配音/BGM/画质）/ status / copy |
| `video_studio_job` | 任务列表与等待（进度、结果、错误） |

典型自动化：`status` → `project create` → `media import` → `subtitles auto` → `subtitles script` →（我翻译）→
`subtitles set` → `dub start` → `render start` → `job` 轮询。

## 配置

`~/.dsh/profiles/desktop/cordis.patch.yml` 中 `video-studio` 行的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `dataRoot` | `<DSH_HOME>/video-studio` | 项目、工作目录、缩略图、成片存放处 |
| `mediaRoot` | 最近使用的工作区 | 媒体库初始目录；导入支持绝对路径 |
| `ffmpegPath` / `ffprobePath` | `ffmpeg` / `ffprobe` | 可执行文件 |
| `imageDuration` | `5` | 图片静帧默认秒数 |
| `chunkSeconds` | `18` | 单次识别请求的最大语音秒数 |
| `silenceNoise` / `silenceMin` / `minSpeech` | `-32dB` / `0.4` / `0.2` | 停顿检测阈值 |
| `speechProviderId` | 自动选择 | 指定语音提供方 |
| `tts.voice` / `tts.rate` | `Tingting` / `180` | 默认音色与语速 |
| `tts.engine` / `tts.command` | `say` / `say` | 本地 TTS 引擎（目前支持 macOS `say`） |

## HTTP 接口

面板与工具共用同一套宿主接口（前缀 `/video-studio`）：

```
GET  /api/state /api/files /api/jobs /api/job /api/voices /api/srt.txt
GET  /api/media?p=      媒体字节，支持 Range（预览/拖拽进度）
GET  /api/thumb?p=      任意素材的缩略图（带磁盘缓存）
POST /api/project/create|open|update|delete|undo|redo
POST /api/import /api/upload(原始字节)
POST /api/clips/update|remove|split|merge
POST /api/subtitles/auto|set|script /api/speech/prepare
POST /api/dub/start /api/render/start /api/export/copy
```

`/api/media` 与 `/api/thumb` 只服务数据目录、素材目录，以及项目文档引用过的文件；其它路径一律 404。

鉴权（**默认关闭**）：开启 `requireToken` 后，浏览器无法给 `<video>`/`<img>`/`<a>` 设置请求头，
所以这些 URL 用 `&t=<token>` 传令牌，`fetch` 用 `x-vs-token` 头；缺少或错误返回 `401 {code:"unauthorized"}`。

## 数据位置

```
~/.dsh/video-studio/
├── projects/*.json     项目文档（时间线、字幕、配音、导出记录）
├── history/<id>.json   撤销/重做快照（最多 20 步）
├── work/<project>/     中间产物：规范化片段、时间线、字幕 ASS、配音轨
├── renders/            导出的 MP4
├── posters/<project>/  缩略图 / 胶片条 / 波形（bin/ 为素材库缩略图缓存）
├── imports/            通过面板上传的原始素材
└── state.json          当前项目
```

## 已知限制

- 本地配音目前是 macOS `say`（中文音色：婷婷/美佳/善怡等）；其它平台需在 `tts.command` 接自己的 TTS。
- 识别为 CPU 推理，长视频按停顿分块，速度与音频时长同量级。
- 时间线是「单视频轨 + 单音频轨 + 单字幕轨」：没有多轨/画中画、转场、变速、调色、关键帧、蒙版。
- 导出通路是"逐片段规格化 → 拼接 → 混音"，长项目会比单遍 filter 慢；功能正确性优先。
- 界面为深色专业工作台配色（不跟随 Harness 亮色主题），这是刻意的：视频时间线需要稳定的对比度与判色环境。
- 面板编辑属于插件自有状态，不写入会话日志；项目数据以 `projects/*.json` 为准。

## 开发与验证

```bash
node test/pipeline.test.mjs     # 16 项：合成素材 → 导入 → 可视图层 → 分割合并 → 撤销重做 → 字幕 → 配音 → BGM/样式 → 渲染 → HTTP API(上传/Range/缩略图)
node test/activation.test.mjs   # 7 项：假 Context 走一遍真实激活路径（工具/schema/无损 JSON/HTTP 路由/令牌门两种模式）
node test/client.test.mjs       # 1 项：客户端模块封装、插件形态、两个槽位注册
KEEP_TEST_DIR=1 node test/pipeline.test.mjs   # 保留测试产物以便查看成片
python3 test/verify_asr.py      # 真实中文语音：识别 → 字幕 → 配音 → 导出（需先准备语音模型）
```

**改宿主代码后必须重启 Harness 进程**：运行中的进程不会重新导入插件模块（ESM 缓存），
`install_bundle` 对已安装包只会更新依赖并返回 `restart-required`，`set_bundle` 开关与配置改动都不会刷新代码。
客户端改动刷新页面即可（bundle 版本号由文件 mtime/size 派生）。

### WAV 兼容（踩过的坑）

Harness 内置识别器只接受 `data` 紧接 `fmt ` 的规范 44 字节头 WAV，而 ffmpeg 输出的 WAV 会带 `LIST` 元数据块
（`data` 落在偏移 70~92）→ 直接送进去报 `Invalid speech WAV`。插件现在自己拼规范头（`lib/ffmpeg.js` 的
`canonicalWav()`，实测 `data@36`），`tools/ffmpeg-wrap.py` 是同一件事的进程级双保险，可按需从 `ffmpegPath` 移除。
