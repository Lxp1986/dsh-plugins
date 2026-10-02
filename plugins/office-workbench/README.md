# 办公工作台

独立 DSH Web 工作台：文档列表、结构化编辑区、嵌入的 DSH 原生 conversation.content 会话。Agent 不是自建聊天后端，沿用当前 DSH 会话、模型、权限、插件工具和 skill；是否可用取决于会话当前配置与授权。通过侧栏选择会话；办公工作台提供“复制文档指令”和“重载 Agent 修改”。

## 支持内容与边界

- MD/TXT/CSV/HTML/JSON：文本新建、打开、手动编辑、保存、删除、导出。
- DOCX：打开真实文件、编辑正文/表格/页眉/页脚中的段落文字、在正文或页眉页脚末尾新增段落、保存与导出真实 DOCX。
- XLSX：打开真实文件、编辑已有单元格值及公式、在工作表末尾新增整行（Tab 分隔单元格）、保存与导出真实 XLSX；不计算公式，不支持新增工作表或含计算链工作簿的修改。
- PPTX：打开真实文件、编辑已有幻灯片与备注页的段落文字、保存与导出真实 PPTX。
- Office 编辑直接修改包内 XML，未修改的包条目保留。修改段落沿用首个文字 run 的样式，不能保证混合字符格式原样保留。
- 这是结构化内容编辑器，不是完整 WPS 页面排版引擎。不支持图表/动画/图片可视化编辑、删除段落或单元格、插入图片、数字签名保真、加密 Office 文件、宏格式或旧版 DOC/XLS/PPT。
- 本地文件导入工作台副本，不覆盖用户原文件。已有同名 Office 文件拒绝导入；请改名后导入。
- 显式保存，非自动保存。Office 保存检查读取时的 updatedAt，避免常见的 Agent/手动编辑旧版本覆盖；修改后需重载才看到 Agent 的最新内容。
- 文件上限 8 MiB、解压包总量上限 100 MiB、处理超时 30 秒。

## Agent 工具

`office_list_documents`、`office_read_document`、`office_save_document`、`office_delete_document`、`office_update_office`。

Office 更新：先读取获取 `office.items`、`office.appendItems` 和 `updatedAt`，再提交 `{id, expectedUpdatedAt, edits: [{key, text}]}`。只提交改变的项。`appendItems` 提供「新增段落」「新增行（Tab 分隔单元格）」的 key，text 非空时在末尾追加。文本工具不能将字符串伪装保存为 Office 文件。

## 运行依赖与安装

使用 DSH 管理器安装本地包。Host 更改可能需要完整重启 DSH；管理器返回 restart-required 时，仅刷新页面或关闭再打开插件不能替代重启。

Office Python 默认为 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3`，需要 lxml。可通过 Host 环境变量 `DSH_OFFICE_PYTHON` 指定其他已配置解释器。其他平台需配置实际 Python 路径。

数据根目录由插件 config.dataRoot 控制；未配置时为 `~/.dsh/office-workbench`，文档在其 documents 子目录。不会覆盖导入来源。

## 当前验证记录

- store.test.mjs：文本 CRUD、路径/类型/大小限制通过。
- client.test.mjs：模块加载与面板/侧栏注册通过。
- office-roundtrip.test.mjs：用 python-docx/openpyxl/python-pptx 生成真实 DOCX/XLSX/PPTX，验证页眉/页脚、备注页编辑与新增段落/新增行，再由同一批库独立解析输出，全部通过。
- plugin.test.mjs：五个工具注册、原生工具 CRUD、HTTP 文档列表、注销清理通过。
- host-acceptance.mjs：面向**运行中宿主**的完整链路验收（导入 → 编辑 → 保存 → 导出 → 独立解析）。宿主插件代码改动后必须完整重启 DSH；重启前该脚本按预期在 `/api/import-office` 得到 404，证明 live Host 仍在跑旧模块。
- 管理器安装返回 restart-required；重启前 live Host 仍是旧模块，新增 HTTP 路由返回 404。原生 Agent 子 slot 已在 Client Inspect 注册；实际页面交互与插件/skill 调用还需重启后的端到端验收。
