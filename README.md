# dsh-plugins · DeepSeek Harness 插件集合

[DeepSeek Harness](https://github.com/Lxp1986/dsh-plugins)（DSH）是一个本地运行的 Agent 应用：
它自带 Web 界面、工具/服务运行时与一套 **Cordis 插件系统**。本仓库用来集中存放给 DSH 用的插件，
每个插件一个子目录，各自独立安装、独立配置、独立文档。

## 插件清单

| 插件 | 说明 | 依赖 |
|---|---|---|
| [**video-studio**](plugins/video-studio/) | 剪映式视频剪辑工作台：多轨时间线、**自动字幕**（本地 SenseVoice，离线）、**自动配音**（macOS `say`）、BGM、字幕样式、一键导出 1080p H.264 | `ffmpeg`（含 libass）、macOS `say`、DSH 内置语音识别包 |
| [**office-workbench**](plugins/office-workbench/) | 独立办公工作台：编辑 Markdown/TXT/CSV/HTML/JSON 文档，并通过 DSH 原生 Agent 工具协作 | DSH |

video-studio 同时提供**完整 Web 面板**（DSH 侧栏「剪辑工作台」）和 **7 个 Agent 工具**
（`video_studio_status` / `project` / `media` / `subtitles` / `dub` / `render` / `job`），
所以既能自己点着剪，也能让 Agent 替你剪。

office-workbench 提供**独立文档工作台**（DSH 侧栏「办公工作台」）与文档 CRUD Agent 工具；当前 MVP 以文本文档为主，不宣称兼容完整 WPS 排版格式。

## 安装插件

**方式一：让 DSH 里的 Agent 装（推荐）**

```
plugin_manager install_bundle("/绝对路径/dsh-plugins/plugins/video-studio")
```

**方式二：手工接到 profile**

1. `git clone https://github.com/Lxp1986/dsh-plugins.git`
2. 在目标 profile 目录（如 `~/.dsh/profiles/desktop/`）的 `package.json` 里加依赖：

   ```json
   { "dependencies": { "@local/dsh-video-studio": "link:/绝对路径/dsh-plugins/plugins/video-studio" } }
   ```

3. 把 `@local/dsh-video-studio` 加进同一个 `package.json` 的 `dsh.profile.bundles`
4. 在该 profile 目录执行 `pnpm install`
5. **重启 DSH**（宿主插件代码只在进程启动时导入一次）

office-workbench 安装时使用 `@local/dsh-office-workbench`，链接值改为 `link:/绝对路径/dsh-plugins/plugins/office-workbench`，并将该包名加入 `dsh.profile.bundles`。其 `cordis.patch.yml` 已提供默认 `$DSH_HOME/office-workbench` 数据根；Host 工具首次注册须重启 DSH。

**配置覆盖**（可选）写进 profile 的 `cordis.patch.yml`：

```yaml
- id: video-studio
  name: "@local/dsh-video-studio"
  config:
    dataRoot: !!js dshHomePath('video-studio')   # 项目/成片/缓存目录
    mediaRoot: /Users/me/Movies                   # 媒体库初始目录
    # 中文口播调参（实测每句话一条字幕、时间误差 0.02s）
    chunkSeconds: 2.5
    silenceNoise: -42dB
    silenceMin: 0.35
    chunkLeadSeconds: 0.2                         # 识别前多留起音，救句首字
```

## 目录约定

```
dsh-plugins/
├── README.md               本文件：索引 + 通用安装说明
├── LICENSE
└── plugins/
    ├── video-studio/       一个插件 = 一个自带 package.json 的目录
    └── office-workbench/   文本文档工作台与 DSH Agent 文档工具
        ├── package.json    必须声明 dsh.bundle.patch（可选 dsh.client）
        ├── cordis.patch.yml 往宿主插入插件行
        ├── index.js        宿主入口：export name / inject / apply(ctx, config)
        ├── client.js       可选：Web 面板（window.__ModuleLoader__.load）
        ├── lib/            宿主实现
        ├── locale/         插件卡片文案
        ├── tools/          辅助脚本
        └── test/           本地测试
```

新增插件时：在 `plugins/` 下建目录、写自带 `package.json` 与 `README.md`，再回到本文件加一行清单即可。

## 两个必须知道的运行时事实

1. **宿主插件代码改动必须重启 DSH 进程。** 运行中的进程不会重新导入插件模块（ESM 缓存）：
   `install_bundle` 对已安装包只更新依赖并返回 `restart-required`，`set_bundle` 开关、配置改动都不会刷新代码
   （配置改动会实时生效，但那只换 config，不换代码）。客户端 `client.js` 改动刷新页面即可
   （bundle 版本号由文件 mtime/size 派生）。
2. **把仓库同步到已安装位置后再重启。** 仓库是源码，profile 里指向的目录是部署位置：

   ```bash
   rsync -a plugins/video-studio/ /path/to/workspace/plugins/video-studio/
   ```

## 开发

插件测试都是本地跑的（需要真 ffmpeg，故未接 CI）：

```bash
cd plugins/video-studio
node test/activation.test.mjs   # 假 Context 走真实激活路径：工具/schema/HTTP/令牌门
node test/client.test.mjs       # 客户端模块封装与槽位注册
node test/pipeline.test.mjs     # 合成素材 → 导入 → 剪辑 → 字幕 → 配音 → 渲染 → HTTP API
KEEP_TEST_DIR=1 node test/pipeline.test.mjs   # 保留测试产物以查看成片
```

## License

[MIT](LICENSE)
