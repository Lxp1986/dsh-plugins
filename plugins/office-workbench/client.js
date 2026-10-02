window.__ModuleLoader__.load({
  id: '@local/dsh-office-workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;
    const base = new URL('office-workbench/', document.baseURI).href;
    const api = (path, options) => fetch(`${base}api/${path}`, options).then(async (r) => { const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data; });
    const css = `
      .ow-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--background,#11151b);color:var(--text,#e9edf3);font:14px system-ui,sans-serif}
      .ow-top{height:54px;display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid var(--border,#303640);flex-shrink:0}
      .ow-brand{font-size:17px;font-weight:700;margin-right:auto}.ow-btn{border:1px solid var(--border,#3a414c);background:var(--panel,#1c222b);color:inherit;border-radius:7px;padding:7px 11px;cursor:pointer}.ow-btn:hover{border-color:var(--accent,#529bff)}
      .ow-status{color:#91a0b3;font-size:12px}.ow-body{display:grid;grid-template-columns:210px minmax(260px,1fr) minmax(360px,1fr);flex:1;min-height:0}.ow-side{border-right:1px solid var(--border,#303640);overflow:auto;padding:12px}.ow-side h3{font-size:12px;color:#98a6b9;text-transform:uppercase;letter-spacing:.08em}.ow-item{width:100%;text-align:left;display:flex;flex-direction:column;gap:4px;border:0;background:transparent;color:inherit;padding:10px;border-radius:7px;cursor:pointer}.ow-item:hover,.ow-item.active{background:#27313d}.ow-item small{color:#8e9bad}.ow-editor{min-width:0;display:flex;flex-direction:column;padding:14px 20px;gap:10px}.ow-title{font:600 18px system-ui;border:0;border-bottom:1px solid transparent;background:transparent;color:inherit;padding:8px 2px;outline:none}.ow-title:focus{border-color:var(--accent,#529bff)}.ow-text{flex:1;min-height:180px;resize:none;white-space:pre-wrap;background:transparent;color:inherit;border:0;outline:none;font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px 2px}.ow-empty{margin:auto;text-align:center;color:#95a3b5}.ow-toolbar{display:flex;align-items:center;gap:8px}.ow-spacer{flex:1}.ow-help{font-size:12px;color:#8e9bad}@media(max-width:760px){.ow-body{grid-template-columns:180px minmax(0,1fr)}.ow-editor{padding:10px}.ow-body{grid-template-rows:minmax(240px,1fr) minmax(320px,1fr);overflow:auto}.ow-agent{grid-column:1/-1;min-height:320px}}`;
    function NativeAgent(props) {
      const session = props.useSession(s => s);
      const conversation = props.useConversation(s => s);
      const summaryBlank = props.useSessions(s => props.sessionId ? s.byId[props.sessionId]?.blank : undefined);
      const hero = !props.sessionId || (session?.blank && (session.openState === 'open' || summaryBlank === true));
      const phase = session?.openState === 'loading' ? 'settling' : hero ? 'hero' : 'active';
      return props.renderFactorySlot('conversation.content', { variant: 'main', phase, hero: !!hero });
    }
    function Panel(props) {
      const [docs, setDocs] = useState([]), [id, setId] = useState(''), [name, setName] = useState(''), [content, setContent] = useState(''), [status, setStatus] = useState('就绪'), [busy, setBusy] = useState(false);
      const [office, setOffice] = useState(null), [originalItems, setOriginalItems] = useState({}), [updatedAt, setUpdatedAt] = useState(''), [dirty, setDirty] = useState(false);
      const accept = (d) => { const o = d.office || null, base = o?.items || []; setId(d.id); setName(d.name); setContent(d.content || ''); setOffice(o ? { ...o, items: [...base, ...(o.appendItems || []).map(x => ({ ...x, text: '' }))] } : null); setOriginalItems(Object.fromEntries(base.map(x => [x.key, x.text]))); setUpdatedAt(d.updatedAt); setDirty(false); };
      const refresh = useCallback(async () => { try { const result = await api('documents'); setDocs(result.documents); } catch (e) { setStatus(e.message); } }, []);
      useEffect(() => { refresh(); }, [refresh]);
      const open = async (doc) => { if (dirty && !window.confirm('放弃未保存修改并重新打开？')) return; setBusy(true); try { const d = await api(`document?id=${encodeURIComponent(doc.id)}`); accept(d); setStatus('已打开'); } catch (e) { setStatus(e.message); } finally { setBusy(false); } };
      const newDoc = () => { if (dirty && !window.confirm('放弃未保存修改？')) return; setId(''); setOffice(null); setName('未命名文档.md'); setContent(''); setDirty(false); setStatus('新文档'); };
      const save = async () => { setBusy(true); try { const d = await api(office ? 'save-office' : 'document', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(office ? { id, edits: office.items.filter(x => x.text !== (originalItems[x.key] || '')).map(({ key, text }) => ({ key, text })), expectedUpdatedAt: updatedAt } : { id, name: name || id || '未命名文档.md', content }) }); accept(d); setStatus('保存成功'); await refresh(); } catch (e) { setStatus(`保存失败：${e.message}`); } finally { setBusy(false); } };
      const importFile = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (!/\.(md|txt|csv|html|json|docx|xlsx|pptx)$/i.test(file.name)) { setStatus('仅支持 MD/TXT/CSV/HTML/JSON/DOCX/XLSX/PPTX'); return; }
        if (file.size > 8 * 1024 * 1024) { setStatus('打开失败：文件超过 8 MiB'); return; }
        if (name && !window.confirm('打开文件将替换当前编辑内容。未保存的修改会丢失，继续吗？')) return;
        setBusy(true);
        try {
          if (/\.(docx|xlsx|pptx)$/i.test(file.name)) {
            const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
            accept(await api('import-office', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: file.name, base64 }) }));
            setStatus('Office 文件已导入 · 原文件不修改'); await refresh(); return;
          }
          const text = await file.text();
          setOffice(null); setDirty(true); setId(''); setName(file.name); setContent(text);
          setStatus('已打开本地文件 · 保存后导入工作台，不修改原文件');
        } catch (e) { setStatus(`打开失败：${e.message}`); }
        finally { setBusy(false); }
      };
      const remove = async () => { if (!id || !window.confirm(`删除「${name}」？`)) return; try { await api(`document?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); newDoc(); await refresh(); setStatus('已删除'); } catch (e) { setStatus(e.message); } };
      const editor = name
        ? h(React.Fragment, null,
          h('input', { className: 'ow-title', value: name, readOnly: !!office, onChange: (e) => { setName(e.target.value); setDirty(true); }, placeholder: '文件名.md', 'aria-label': '文档名称' }),
          office ? h('div', { style: { flex: 1, overflow: 'auto' } }, h('p', { className: 'ow-help' }, office.limitations), ...office.items.map((item, i) => h('label', { key: item.key, style: { display: 'block', marginBottom: 12 } }, h('small', null, `${item.group} · ${item.label}`), h('textarea', { value: item.text, 'aria-label': `${item.group} ${item.label}`, style: { display: 'block', width: '100%', minHeight: office.kind === 'spreadsheet' ? 36 : 64, color: 'inherit', background: 'transparent', border: '1px solid #45505f' }, onChange: e => { setDirty(true); setOffice({ ...office, items: office.items.map((x, j) => j === i ? { ...x, text: e.target.value } : x) }); } })))) : h('textarea', { className: 'ow-text', value: content, onChange: (e) => { setContent(e.target.value); setDirty(true); }, placeholder: '开始写作…\\n\\nAgent 也可以通过 office_list_documents / office_read_document / office_save_document 与这些文档协作。', spellCheck: true, 'aria-label': '文档内容' }),
          h('div', { className: 'ow-toolbar' },
            h('span', { className: 'ow-help' }, id ? `文件：${id}` : '未保存'),
            h('span', { className: 'ow-spacer' }),
            h('button', { className: 'ow-btn', onClick: remove, disabled: !id }, '删除'),
            h('button', { className: 'ow-btn', onClick: save, disabled: busy }, '保存文档')))
        : h('div', { className: 'ow-empty' }, h('h2', null, '从一份文档开始'), h('p', null, '手动编辑，或在 DSH 会话中让 Agent 使用办公文档工具协作。'), h('button', { className: 'ow-btn', onClick: newDoc }, '新建文档'));
      return h('div', { className: 'ow-root' },
        h('style', null, css),
        h('div', { className: 'ow-top' }, h('span', { className: 'ow-brand' }, '▤ 办公工作台'), h('span', { className: 'ow-status', role: 'status' }, status), h('label', { className: 'ow-btn' }, '打开文件', h('input', { type: 'file', accept: '.md,.txt,.csv,.html,.json,.docx,.xlsx,.pptx', onChange: importFile, disabled: busy, style: { display: 'none' }, 'aria-label': '打开本地文件' })), h('button', { className: 'ow-btn', onClick: newDoc, disabled: busy }, '新建'), h('button', { className: 'ow-btn', onClick: save, disabled: busy }, '保存'), h('button', { className: 'ow-btn', onClick: () => id && window.open(`${base}api/export?id=${encodeURIComponent(id)}`, '_blank'), disabled: !id }, '导出')),
        h('div', { className: 'ow-body' },
          h('aside', { className: 'ow-side' }, h('h3', null, '我的文档'), h('button', { className: 'ow-btn', onClick: refresh, style: { width: '100%' } }, '刷新列表'), docs.length ? docs.map((doc) => h('button', { key: doc.id, className: `ow-item${id === doc.id ? ' active' : ''}`, onClick: () => open(doc) }, h('span', null, doc.name), h('small', null, `${(doc.bytes / 1024).toFixed(1)} KB · ${new Date(doc.updatedAt).toLocaleString()}`))) : h('p', { className: 'ow-help' }, '暂无文档 · 点击「新建」')),
          h('main', { className: 'ow-editor' }, editor),
          h('section', { className: 'ow-agent', 'aria-label': 'DSH 原生 Agent', style: { display: 'flex', flexDirection: 'column', minHeight: 0, borderLeft: '1px solid #303640' } },
            h('div', { className: 'ow-help', style: { padding: 10 } }, 'DSH 原生 Agent · 模型 / 插件工具 / skill / 权限沿用原生会话',
              h('button', { className: 'ow-btn', onClick: () => { if (id) navigator.clipboard.writeText(`请使用 office_read_document 读取办公工作台文档 ${JSON.stringify(id)}。需要修改 Office 文件时使用 office_update_office，其他任务可调用本会话全部可用插件工具和 skill。`); }, disabled: !id }, '复制文档指令'),
              h('button', { className: 'ow-btn', onClick: () => id && open({ id }), disabled: !id || busy }, '重载 Agent 修改')),
            props.renderSlot('office-workbench.agent', {}))));
    }
    function Icon() { return h('span', { style: { fontSize: 17 } }, '▤'); }
    return { inject: ['slots'], apply(ctx) {
      ctx.effect(() => { const style = document.createElement('style'); style.dataset.plugin = 'office-workbench'; style.textContent = css; document.head.appendChild(style); return () => style.remove(); });
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'office-workbench', order: 19, label: '办公工作台' }, Icon));
      ctx.slots.inject('main', () => {
        const panel = ctx.slots.register({ name: 'main', key: 'office-workbench', children: { 'office-workbench.agent': { kind: 'single', scope: 'session-maybe' } } }, Panel);
        const agent = ctx.slots.register({ name: 'office-workbench.agent' }, NativeAgent);
        return () => { agent?.(); panel?.(); };
      });
    } };
  },
});
