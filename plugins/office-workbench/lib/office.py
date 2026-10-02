"""Patch editable OOXML text nodes without rebuilding unrelated package parts."""
import sys, json, zipfile, io, copy
from lxml import etree as E

NS={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
XS='{http://www.w3.org/XML/1998/namespace}space'
P=E.XMLParser(resolve_entities=False, no_network=True)
def xml(data): return E.fromstring(data, parser=P)
def serialize(root): return E.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
def col_index(ref):
    n=0
    for ch in ref:
        if ch.isalpha(): n=n*26+(ord(ch.upper())-64)
        else: break
    return n
def col_letter(n):
    s=''
    while n>0:
        n,r=divmod(n-1,26); s=chr(65+r)+s
    return s
def set_cell(c, text):
    for child in list(c):
        if E.QName(child).localname in ('f','v','is'): c.remove(child)
    if text.startswith('='):
        c.attrib.pop('t',None); E.SubElement(c,'{'+NS['s']+'}f').text=text[1:]
        return
    try: float(text); numeric=bool(text.strip())
    except ValueError: numeric=False
    if numeric:
        c.attrib.pop('t',None); E.SubElement(c,'{'+NS['s']+'}v').text=text
    else:
        c.set('t','inlineStr'); st=E.SubElement(c,'{'+NS['s']+'}is'); t=E.SubElement(st,'{'+NS['s']+'}t'); t.text=text; t.set(XS,'preserve')
def sheet_names(z, names):
    try:
        rels={r.get('Id'):r.get('Target').split('/')[-1] for r in xml(z.read('xl/_rels/workbook.xml.rels')).findall('.//{http://schemas.openxmlformats.org/package/2006/relationships}Relationship')}
        out={}
        for sh in xml(z.read('xl/workbook.xml')).findall('.//s:sheet',NS):
            target=rels.get(sh.get('{'+NS['r']+'}id'),'')
            if target: out['xl/worksheets/'+target]=sh.get('name') or target
        return out
    except Exception: return {}
def process(path, edits=None):
    with zipfile.ZipFile(path) as z:
        if sum(x.file_size for x in z.infolist()) > 100*1024*1024: raise ValueError('解压内容超过 100 MiB')
        names=z.namelist()
        if len(names)>10000: raise ValueError('Office 包条目过多')
        changed={}; items=[]; append_items=[]
        low=path.lower()
        if low.endswith('.docx'):
            parts=['word/document.xml']+sorted(n for n in names if n.startswith('word/header') and n.endswith('.xml') and '/_rels/' not in n)+sorted(n for n in names if n.startswith('word/footer') and n.endswith('.xml') and '/_rels/' not in n)
            kind='word'
        elif low.endswith('.pptx'):
            parts=sorted([n for n in names if n.startswith('ppt/slides/slide') and n.endswith('.xml') and '/_rels/' not in n], key=lambda n:int(n.split('slide')[-1].split('.')[0]))+sorted([n for n in names if n.startswith('ppt/notesSlides/notesSlide') and n.endswith('.xml')], key=lambda n:int(n.split('notesSlide')[-1].split('.')[0]))
            kind='presentation'
        else:
            parts=sorted([n for n in names if n.startswith('xl/worksheets/sheet') and n.endswith('.xml')])
            kind='spreadsheet'
        parts=[p for p in parts if p in names]
        editmap={x['key']:x['text'] for x in (edits or [])}
        known=set()
        shared=[]
        if 'xl/sharedStrings.xml' in names:
            shared=[''.join(t.text or '' for t in si.findall('.//s:t',NS)) for si in xml(z.read('xl/sharedStrings.xml')).findall('s:si',NS)]
        sheets=sheet_names(z,names) if kind=='spreadsheet' else {}
        for part in parts:
            root=xml(z.read(part))
            if kind!='spreadsheet':
                tag='w' if kind=='word' else 'a'
                if kind=='word': group='正文与表格' if part=='word/document.xml' else ('页眉' if '/header' in part else '页脚')
                else: group=part.split('/')[-1]
                for i,p in enumerate(root.findall('.//'+tag+':p',NS)):
                    ts=p.findall('.//'+tag+':t',NS)
                    key=f'{part}#{i}'; known.add(key)
                    text=''.join(t.text or '' for t in ts)
                    items.append({'key':key,'group':group,'label':f'段落 {i+1}','text':text})
                    if key in editmap and editmap[key]!=text:
                        if not ts:
                            r=E.SubElement(p,'{'+NS[tag]+'}r'); ts=[E.SubElement(r,'{'+NS[tag]+'}t')]
                        ts[0].text=editmap[key]; ts[0].set(XS,'preserve')
                        for t in ts[1:]: t.text=''
                        changed[part]=serialize(root)
                if kind=='word':
                    akey=f'{part}#append'; known.add(akey)
                    append_items.append({'key':akey,'group':group,'label':'新增段落','append':True})
                    if editmap.get(akey,'').strip():
                        body=root.find('w:body',NS)
                        if body is None: body=root
                        last=body.findall('w:p',NS)[-1] if body.findall('w:p',NS) else None
                        np=E.Element('{'+NS['w']+'}p')
                        if last is not None:
                            ppr=last.find('w:pPr',NS)
                            if ppr is not None: np.append(copy.deepcopy(ppr))
                        r=E.SubElement(np,'{'+NS['w']+'}r')
                        if last is not None:
                            fr=last.find('w:r',NS)
                            if fr is not None:
                                rpr=fr.find('w:rPr',NS)
                                if rpr is not None: r.insert(0,copy.deepcopy(rpr))
                        t=E.SubElement(r,'{'+NS['w']+'}t'); t.text=editmap[akey]; t.set(XS,'preserve')
                        sect=body.find('w:sectPr',NS)
                        if sect is not None: sect.addprevious(np)
                        else: body.append(np)
                        changed[part]=serialize(root)
            else:
                group=sheets.get(part) or part.split('/')[-1]
                for row in root.findall('.//s:sheetData/s:row',NS):
                    for c in row.findall('s:c',NS):
                        addr=c.get('r'); key=f'{part}#{addr}'; known.add(key)
                        f=c.find('s:f',NS); v=c.find('s:v',NS); inline=c.find('s:is',NS)
                        val=v.text or '' if v is not None else ''
                        if f is not None: text='='+(f.text or '')
                        elif c.get('t')=='s': text=shared[int(val)] if val else ''
                        elif inline is not None: text=''.join(t.text or '' for t in inline.findall('.//s:t',NS))
                        else: text=val
                        items.append({'key':key,'group':group,'label':addr,'text':text})
                        if key in editmap and editmap[key]!=text:
                            set_cell(c,editmap[key]); changed[part]=serialize(root)
                akey=f'{part}#append'; known.add(akey)
                append_items.append({'key':akey,'group':group,'label':'新增行（Tab 分隔单元格）','append':True})
                if editmap.get(akey,'').strip():
                    sheet_data=root.find('.//s:sheetData',NS)
                    if sheet_data is None: raise ValueError('工作表缺少 sheetData，无法新增行')
                    rnum=max([int(r.get('r') or 0) for r in sheet_data.findall('s:row',NS)] or [0])+1
                    new_row=E.SubElement(sheet_data,'{'+NS['s']+'}row'); new_row.set('r',str(rnum))
                    for ci,val in enumerate(editmap[akey].split('\t'),start=1):
                        if val=='': continue
                        nc=E.SubElement(new_row,'{'+NS['s']+'}c',{'r':col_letter(ci)+str(rnum)}); set_cell(nc,val)
                    changed[part]=serialize(root)
        if edits is not None:
            if set(editmap)-known: raise ValueError('编辑位置不存在，请重新打开文档')
            if kind=='spreadsheet' and changed and 'xl/calcChain.xml' in names: raise ValueError('此工作簿含计算链，当前不支持修改；请先在 Excel 中另存为无计算链副本')
            out=io.BytesIO()
            with zipfile.ZipFile(out,'w') as dest:
                for info in z.infolist(): dest.writestr(info,changed.get(info.filename,z.read(info.filename)))
            return out.getvalue()
        return {'kind':kind,'items':items,'appendItems':append_items,'limitations':'结构化内容编辑：未改动的 XML/媒体保留；修改段落文字会沿用首个文字 run 的样式；可编辑正文/页眉/页脚段落、幻灯片与备注段落、单元格，并可在正文末尾新增段落、在末尾新增整行。暂不提供完整页面排版、图表、动画编辑或公式计算。'}
if __name__=='__main__':
    args=json.load(sys.stdin)
    result=process(args['path'],args.get('edits'))
    if isinstance(result,bytes): sys.stdout.buffer.write(result)
    else: print(json.dumps(result,ensure_ascii=False))
