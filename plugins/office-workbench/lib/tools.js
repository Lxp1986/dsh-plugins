const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const render = (_args, value) => [{ type: 'text', text: `${JSON.stringify(value, null, 2)}\n` }];

export function registerTools(ctx, store) {
  const disposers = [];
  const register = (definition) => disposers.push(ctx.tools.register({ ...definition, async execute(args, exec) { return await definition.execute(args, exec); } }));
  register({
    name: 'office_list_documents',
    description: '列出办公工作台中的文档。当前文档根目录为插件的 office-workbench/documents 子目录。',
    parameters: obj({}), output: { schema: { type: 'object', additionalProperties: true }, render },
    async execute() { return { documents: await store.list(), root: store.root }; },
  });
  register({
    name: 'office_read_document',
    description: '读取办公工作台文档全文；先 office_list_documents 获取准确 id。',
    parameters: obj({ id: { type: 'string', description: '精确文档文件名/id' } }, ['id']),
    output: { schema: { type: 'object', additionalProperties: true }, render },
    async execute(args) { return await store.read(args.id); },
  });
  register({
    name: 'office_save_document',
    description: '创建或更新办公工作台文档，覆盖前先读取现有内容并基于其修改；默认 Markdown。仅能写入办公工作台自有文档目录。',
    parameters: obj({ id: { type: 'string', description: '已有文件名；省略则新建' }, name: { type: 'string', description: '新文档名或重命名后的文件名，支持 md/txt/csv/html/json' }, content: { type: 'string', description: '完整文档文本' } }, ['content']),
    output: { schema: { type: 'object', additionalProperties: true }, render },
    async execute(args) { return await store.save(args); },
  });
  register({
    name: 'office_delete_document',
    description: '删除办公工作台文档；必须先确认精确 id。',
    parameters: obj({ id: { type: 'string', description: '精确文档文件名/id' } }, ['id']),
    output: { schema: { type: 'object', additionalProperties: true }, render },
    async execute(args) { return await store.remove(args.id); },
  });
  register({
    name: 'office_update_office',
    description: '更新 docx/xlsx/pptx 的段落、单元格、幻灯片或备注文字。必须先 office_read_document 获取 office.items 与 office.appendItems 的 key 和 updatedAt。可编辑正文/页眉/页脚段落、幻灯片与备注段落、工作表单元格；office.appendItems 提供「新增段落」「新增行（Tab 分隔单元格）」的 key，text 非空时在末尾追加。只提交变化项；未修改的媒体与 XML 保留，修改段落沿用首个 run 样式。',
    parameters: obj({ id: { type: 'string' }, expectedUpdatedAt: { type: 'string' }, edits: { type: 'array', items: obj({ key: { type: 'string' }, text: { type: 'string' } }, ['key', 'text']) } }, ['id', 'expectedUpdatedAt', 'edits']),
    output: { schema: { type: 'object', additionalProperties: true }, render },
    async execute(args) { return await store.saveOffice(args); },
  });
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
