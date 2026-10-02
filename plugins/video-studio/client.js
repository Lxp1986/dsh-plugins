/**
 * Video Studio client half — a CapCut-style editing surface.
 *
 * Layout: top bar, media bin / viewer / contextual inspector, and a full-width
 * multitrack timeline (ruler + playhead + video / audio / subtitle tracks) with
 * drag-to-trim, zoom and keyboard transport. Everything it shows comes from the
 * plugin's own HTTP surface; React comes from the browser module table.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    const NS = 'video-studio';
    const API_BASE = (() => {
      try {
        return new URL('video-studio/api', document.baseURI).href;
      } catch {
        return '/video-studio/api';
      }
    })();

    const T = {
      // top bar
      app: '剪辑工作台', ratio: '画幅', newProject: '新建项目', captions: '字幕',
      openProject: '打开项目', export: '导出', noProject: '未打开项目',
      // media
      media: '媒体', audio: '音频', text: '文本', upload: '导入', addToTimeline: '添加到时间线',
      emptyDir: '这个目录里没有可用的媒体文件', up: '上一层', workspace: '工作区',
      // viewer
      play: '播放', pause: '暂停', prevClip: '上一条', nextClip: '下一条',
      // timeline
      timeline: '时间线', videoTrack: '视频轨', audioTrack: '音频轨', subtitleTrack: '字幕轨',
      zoom: '缩放', split: '分割', merge: '合并', remove: '删除', addText: '加字幕',
      emptyTrack: '把左侧素材加进来，或用「导入」上传文件',
      emptySubtitles: '点「自动字幕」，或在这里「加字幕」手写',
      // inspector
      clipProps: '片段', subtitleProps: '字幕',
      inPoint: '入点', outPoint: '出点', duration: '时长', sourceLength: '素材长度',
      subtitleText: '字幕文本', startTime: '开始', endTime: '结束', seekHere: '跳到此处',
      // subtitle tab
      autoSubtitles: '自动字幕', language: '语言', prepareModel: '准备语音模型',
      speechReady: '语音模型就绪', speechUnprepared: '语音模型未就绪', speechOff: '未启用语音识别',
      speechHint: '请在插件页启用 @deepseek-ai/dsh-experimental-voice-input-bundle 后准备模型',
      saveSubtitles: '保存字幕', downloadSrt: '下载 SRT', segments: '条字幕', noSegments: '还没有字幕',
      // dub tab
      dub: '配音', voice: '音色', rate: '语速', sourceMode: '来源', fromSubtitles: '按字幕',
      fromScript: '按文稿', script: '旁白文稿', startDub: '生成配音', originalVolume: '原声音量', muteOriginal: '静音原声', bgm: '背景音乐', bgmVolume: '音乐音量', clearBgm: '移除', noBgm: '未设置', dubHint: '先做自动字幕，或切换到「按文稿」',
      dubTrackReady: '配音轨已生成',
      // export tab
      exportSettings: '导出设置', burnSubtitles: '烧录字幕', mixDub: '混入配音', mixBgm: '混入背景音乐',
      quality: '画质', startRender: '开始导出', renders: '成片列表', noRenders: '还没有导出记录',
      copyToWorkspace: '复制到工作目录', download: '下载', playRender: '预览',
      // jobs / status
      jobs: '任务', noJobs: '暂无任务', running: '进行中', undo: '撤销', redo: '重做',
      undone: '已撤销', redone: '已重做',
      copyDone: '已复制到', ffmpegMissing: '未检测到 ffmpeg：brew install ffmpeg', fatal: '面板发生错误',
    };
    // English uses the Chinese dictionary as a per-key fallback so a missing
    // translation degrades to Chinese text rather than to a raw key.
    const T_EN = {
      ...Object.fromEntries(Object.keys(T).map((key) => [key, T[key]])),
      app: 'Video Studio', project: 'Project', ratio: 'Aspect', newProject: 'New project',
      openProject: 'Open project', export: 'Export', noProject: 'No project open',
      media: 'Media', audio: 'Audio', text: 'Text', upload: 'Import', addToTimeline: 'Add to timeline',
      emptyDir: 'No media files in this folder', up: 'Up', workspace: 'Workspace',
      play: 'Play', pause: 'Pause', prevClip: 'Previous clip', nextClip: 'Next clip',
      timeline: 'Timeline', videoTrack: 'Video', audioTrack: 'Audio', subtitleTrack: 'Subtitles',
      zoom: 'Zoom', split: 'Split', merge: 'Merge', remove: 'Delete', addText: 'Add subtitle',
      emptyTrack: 'Add media from the left, or use Import to upload files',
      emptySubtitles: 'Run Auto subtitles, or add a subtitle here',
      clipProps: 'Clip', subtitleProps: 'Subtitle', inspector: 'Inspector',
      inPoint: 'In', outPoint: 'Out', duration: 'Duration', sourceLength: 'Source length',
      subtitleText: 'Text', startTime: 'Start', endTime: 'End', seekHere: 'Go here',
      autoSubtitles: 'Auto subtitles', language: 'Language', prepareModel: 'Prepare model',
      speechReady: 'Speech model ready', speechUnprepared: 'Speech model not prepared',
      speechOff: 'Speech recognition is off',
      speechHint: 'Enable @deepseek-ai/dsh-experimental-voice-input-bundle, then prepare the model',
      saveSubtitles: 'Save', downloadSrt: 'Download SRT', segments: 'subtitles', noSegments: 'No subtitles yet',
      dub: 'Dubbing', voice: 'Voice', rate: 'Rate', sourceMode: 'Source', fromSubtitles: 'From subtitles',
      fromScript: 'From script', script: 'Narration script', startDub: 'Generate dubbing',
      originalVolume: 'Original volume', muteOriginal: 'Mute original',
      bgm: 'Background music', bgmVolume: 'Music volume', clearBgm: 'Remove', noBgm: 'None',
      dubHint: 'Run auto subtitles first, or switch to From script',
      dubTrackReady: 'Dub track ready', exportSettings: 'Export settings', burnSubtitles: 'Burn subtitles',
      mixDub: 'Mix dubbing', mixBgm: 'Mix music', quality: 'Quality', startRender: 'Export video',
      renders: 'Exports', noRenders: 'No exports yet', copyToWorkspace: 'Copy to workspace',
      download: 'Download', playRender: 'Preview', jobs: 'Jobs', noJobs: 'No jobs',
      running: 'Running', done: 'Done', failed: 'Failed', copyDone: 'Copied to', ready: 'Ready',
      ffmpegMissing: 'ffmpeg not found: brew install ffmpeg', retry: 'Retry',
      fatal: 'Panel error', undo: 'Undo', redo: 'Redo',
    };
    let translate = (key) => T[key] ?? key;
    const t = (key) => translate(key);

    const css = `
.vs-root{--bg:#0d0f13;--stage:#000;--panel:#15181d;--panel2:#1c2027;--panel3:#242934;--line:#2a3040;--text:#e8eaf0;--dim:#99a1b0;--accent:#37a6ff;--accent-soft:rgba(55,166,255,.16);--gold:#ffd166;--danger:#ff5f5f;
display:flex;flex-direction:column;height:100%;max-height:100vh;min-height:0;overflow:hidden;background:var(--bg);color:var(--text);font-size:12px;line-height:1.5;user-select:none}
.vs-root *{box-sizing:border-box}
.vs-top{display:flex;align-items:center;gap:8px;height:44px;padding:0 10px;background:var(--panel);border-bottom:1px solid var(--line);flex:none}
.vs-top .vs-logo{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;color:var(--text)}
.vs-top .vs-logo b{color:var(--accent)}
.vs-spacer{flex:1}
.vs-name{background:transparent;border:1px solid transparent;border-radius:5px;color:var(--text);font-size:12px;padding:3px 6px;min-width:120px;max-width:260px}
.vs-name:hover{border-color:var(--line)}
.vs-name:focus{border-color:var(--accent);outline:none;background:var(--panel2)}
.vs-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap}
.vs-btn:hover{background:var(--panel3)}
.vs-btn[disabled]{opacity:.4;cursor:not-allowed}
.vs-btn.primary{background:var(--accent);border-color:var(--accent);color:#04121f;font-weight:600}
.vs-btn.primary:hover{filter:brightness(1.08)}
.vs-btn.ghost{background:transparent}
.vs-btn.danger{color:var(--danger)}
.vs-btn.on{background:var(--accent-soft);border-color:var(--accent);color:#bfe1ff}
.vs-ico{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--text);cursor:pointer}
.vs-ico:hover{background:var(--panel2);border-color:var(--line)}
.vs-ico[disabled]{opacity:.35;cursor:not-allowed}
.vs-sel,.vs-inp,.vs-area{background:var(--panel2);border:1px solid var(--line);border-radius:5px;color:var(--text);font-size:12px;padding:4px 7px;min-width:0}
.vs-sel:focus,.vs-inp:focus,.vs-area:focus{outline:none;border-color:var(--accent)}
.vs-area{width:100%;min-height:76px;resize:vertical;font-family:inherit}
.vs-inp.num{width:74px}
.vs-main{flex:1 1 auto;display:flex;min-height:0;overflow:hidden}
.vs-left{width:238px;flex:none;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.vs-left.collapsed{width:0;overflow:hidden;border-right:none}
.vs-tabs{display:flex;gap:2px;padding:8px 8px 0;flex:none}
.vs-tab{flex:1;height:28px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dim);font-size:12px;cursor:pointer}
.vs-tab:hover{background:var(--panel2)}
.vs-tab.on{background:var(--panel3);color:var(--text);border-color:var(--line)}
.vs-leftbody{flex:1;min-height:0;display:flex;flex-direction:column;padding:8px;gap:8px}
.vs-crumb{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dim)}
.vs-crumb span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.vs-grid{flex:1;min-height:0;overflow:auto;display:grid;grid-template-columns:1fr 1fr;gap:6px;align-content:start}
.vs-tile{position:relative;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--panel2);cursor:pointer}
.vs-tile:hover{border-color:var(--accent)}
.vs-tile.picked{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent) inset}
.vs-tile.picked::after{content:'✓';position:absolute;left:4px;top:4px;width:18px;height:18px;border-radius:50%;background:var(--accent);color:#04121f;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center}
.vs-tile img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#000}
.vs-tile .cap{font-size:10px;padding:3px 4px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vs-tile .plus{position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;border:none;background:var(--accent);color:#04121f;font-weight:700;cursor:pointer;display:none;align-items:center;justify-content:center;font-size:14px;line-height:1}
.vs-tile:hover .plus{display:flex}
.vs-folder{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:5px;cursor:pointer;font-size:12px}
.vs-folder:hover{background:var(--panel2)}
.vs-center{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.vs-viewer{flex:1 1 auto;min-height:120px;max-height:calc(100vh - 380px);background:var(--stage);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.vs-viewer video,.vs-viewer img{max-width:100%;max-height:100%;display:block}
.vs-hint{color:var(--dim);text-align:center;padding:20px;max-width:520px}
.vs-overlay{position:absolute;left:6%;right:6%;bottom:5%;text-align:center;font-weight:600;line-height:1.35;pointer-events:none;user-select:none;text-shadow:0 0 2px #000,0 0 5px #000,0 2px 3px rgba(0,0,0,.9),1px 1px 0 #000,-1px -1px 0 #000}
.vs-ovtag{position:absolute;top:8px;right:10px;font-size:10px;color:var(--dim);background:rgba(0,0,0,.45);padding:2px 6px;border-radius:999px;pointer-events:none}
.vs-hint .big{font-size:14px;color:var(--text);margin-bottom:8px}
.vs-transport{height:42px;flex:none;display:flex;align-items:center;gap:6px;padding:0 10px;background:var(--panel);border-top:1px solid var(--line)}
.vs-time{font-variant-numeric:tabular-nums;font-size:12px;color:var(--text)}
.vs-time small{color:var(--dim)}
.vs-right{width:302px;flex:none;background:var(--panel);border-left:1px solid var(--line);overflow:auto;padding:10px}
.vs-sec{margin-bottom:12px}
.vs-sec h4{margin:0 0 8px;font-size:11px;font-weight:600;color:var(--dim);letter-spacing:.06em;text-transform:uppercase}
.vs-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.vs-row.wrap{flex-wrap:wrap}
.vs-row .grow{flex:1}
.vs-lbl{color:var(--dim);font-size:11px;min-width:44px}
.vs-val{color:var(--text);font-variant-numeric:tabular-nums;font-size:11px}
.vs-range{flex:1;accent-color:var(--accent);height:18px}
.vs-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;border:1px solid var(--line);background:var(--panel2);color:var(--dim);font-size:11px}
.vs-chip.ok{color:#7ee2b8;border-color:#2c5744}
.vs-chip.warn{color:var(--gold);border-color:#5a4a1f}
.vs-chip.bad{color:var(--danger);border-color:#5a2a2a}
.vs-list{display:flex;flex-direction:column;gap:3px;max-height:230px;overflow:auto}
.vs-item{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:5px;font-size:11px}
.vs-item:hover{background:var(--panel2)}
.vs-item.on{background:var(--accent-soft);border:1px solid var(--accent)}
.vs-item .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vs-sub-inp{flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:5px;color:var(--text);font-size:11px;padding:3px 6px;min-width:0}
.vs-bar{height:4px;border-radius:2px;background:var(--panel3);overflow:hidden;margin-top:4px}
.vs-bar i{display:block;height:100%;background:var(--accent);transition:width .3s}
.vs-msg{font-size:11px;padding:6px 8px;border-radius:5px;margin-bottom:8px;white-space:pre-wrap}
.vs-msg.err{background:rgba(255,95,95,.12);color:#ffb4b4;border:1px solid rgba(255,95,95,.3)}
.vs-msg.ok{background:rgba(55,166,255,.1);color:#bfe1ff;border:1px solid rgba(55,166,255,.28)}
.vs-tl{height:252px;flex:0 0 252px;display:flex;flex-direction:column;background:var(--panel);border-top:1px solid var(--line);width:100%}
.vs-tl-bar{height:36px;flex:none;display:flex;align-items:center;gap:6px;padding:0 10px;border-bottom:1px solid var(--line)}
.vs-tl-body{flex:1;min-height:0;display:flex}
.vs-heads{width:64px;flex:none;border-right:1px solid var(--line);background:var(--panel)}
.vs-heads .rulerpad{height:22px;border-bottom:1px solid var(--line)}
.vs-head{display:flex;align-items:center;gap:4px;padding:0 6px;color:var(--dim);font-size:10px;border-bottom:1px solid var(--line);overflow:hidden}
.vs-head.v1{height:62px}.vs-head.a1{height:42px}.vs-head.t1{height:32px}
.vs-scroll{flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;position:relative}
.vs-content{position:relative;min-height:100%;padding-bottom:6px}
.vs-ruler{height:22px;position:relative;border-bottom:1px solid var(--line);cursor:ew-resize;background:var(--panel)}
.vs-tick{position:absolute;top:0;bottom:0;border-left:1px solid var(--line)}
.vs-tick.major{border-left-color:#3b4457}
.vs-tick span{position:absolute;left:3px;top:2px;font-size:9px;color:var(--dim);font-variant-numeric:tabular-nums}
.vs-track{position:relative;border-bottom:1px solid var(--line);background:repeating-linear-gradient(90deg,transparent,transparent 39px,var(--line) 39px,var(--line) 40px)}
.vs-track.v1{height:62px}.vs-track.a1{height:42px}.vs-track.t1{height:32px}
.vs-clip{position:absolute;top:3px;height:56px;border-radius:5px;border:1px solid #333a49;overflow:hidden;cursor:pointer;background-color:#101318;background-repeat:repeat-x;background-size:auto 100%;background-position:left center}
.vs-clip:hover{border-color:#4a5568}
.vs-clip.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.vs-clip .tag{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(transparent,rgba(0,0,0,.75));color:#e9edf5;font-size:9px;padding:6px 5px 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vs-clip .noaudio{position:absolute;top:2px;left:3px;font-size:9px;color:var(--gold)}
.vs-handle{position:absolute;top:0;bottom:0;width:9px;cursor:ew-resize;background:linear-gradient(var(--accent),var(--accent));opacity:.85;display:none}
.vs-clip.on .vs-handle{display:block}
.vs-handle.l{left:0;border-radius:5px 0 0 5px}
.vs-handle.r{right:0;border-radius:0 5px 5px 0}
.vs-aud{position:absolute;top:3px;height:36px;border-radius:4px;border:1px solid #2c3240;background:#101318;overflow:hidden}
.vs-aud{background-color:#101318;background-repeat:repeat-x;background-size:auto 100%}
.vs-aud.dim{background:repeating-linear-gradient(90deg,#171b22,#171b22 6px,#1c2129 6px,#1c2129 12px);border-color:#252b36}
.vs-sub{position:absolute;top:3px;height:26px;border-radius:4px;background:#2a3a52;border:1px solid #3d557a;color:#dbe7f7;font-size:10px;padding:3px 6px;overflow:hidden;white-space:nowrap;cursor:pointer}
.vs-sub:hover{background:#33465f}
.vs-sub.on{background:var(--accent-soft);border-color:var(--accent);color:#dcefff}
.vs-playline{position:absolute;top:0;bottom:0;width:1px;background:#ff5f5f;pointer-events:none;z-index:5}
.vs-snapline{position:absolute;top:0;bottom:0;width:1px;background:var(--gold);box-shadow:0 0 0 1px rgba(255,209,102,.25);pointer-events:none;z-index:4}
.vs-sub.on{cursor:grab}
.vs-subhandle{position:absolute;top:0;bottom:0;width:7px;cursor:ew-resize;background:var(--accent);opacity:.9;border-radius:3px}
.vs-subhandle.l{left:-3px}.vs-subhandle.r{right:-3px}
.vs-playhandle{position:absolute;top:0;width:11px;height:11px;background:#ff5f5f;border-radius:2px;transform:translateX(-5px);pointer-events:none;z-index:6}
.vs-tl-empty{position:absolute;left:12px;top:30px;color:var(--dim);font-size:11px}
`;

    // ---------------------------------------------------------------- helpers

    async function call(path, options = {}) {
      const response = await fetch(`${API_BASE}${path}`, {
        method: options.method ?? (options.body ? 'POST' : 'GET'),
        headers: {
          ...(options.body instanceof Blob ? {} : { 'content-type': 'application/json' }),
          ...(readToken() === null ? {} : { 'x-vs-token': readToken() }),
        },
        body: options.body instanceof Blob ? options.body : (options.body ? JSON.stringify(options.body) : undefined),
        credentials: 'same-origin',
      });
      const text = await response.text();
      let value;
      try {
        value = text ? JSON.parse(text) : {};
      } catch {
        value = { ok: false, error: text };
      }
      if (!response.ok || value.ok === false) throw new Error(value.error ?? `请求失败（${response.status}）`);
      return value;
    }

    // The host injects a per-activation token into the page; browsers cannot set
    // headers on <video>/<img>/<a>, so those URLs carry it as a query parameter.
    const readToken = () => {
      try {
        if (typeof window.__VIDEO_STUDIO_TOKEN__ === 'string') return window.__VIDEO_STUDIO_TOKEN__;
        const attribute = document.body?.dataset?.vsToken ?? document.documentElement?.dataset?.vsToken;
        return typeof attribute === 'string' && attribute.length > 0 ? attribute : null;
      } catch {
        return null;
      }
    };
    const withToken = (url) => {
      const token = readToken();
      return token === null ? url : `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
    };
    const mediaUrl = (file) => withToken(`${API_BASE}/media?p=${encodeURIComponent(file)}`);
    const thumbUrl = (file) => withToken(`${API_BASE}/thumb?p=${encodeURIComponent(file)}`);
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const round = (value) => Math.round((Number(value) || 0) * 100) / 100;

    /** mm:ss.d — the transport readout. */
    function clock(seconds) {
      const total = Math.max(0, Number(seconds) || 0);
      const m = Math.floor(total / 60);
      const s = total - m * 60;
      return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
    }

    /** mm:ss — ruler labels. */
    function clockShort(seconds) {
      const total = Math.max(0, Number(seconds) || 0);
      const m = Math.floor(total / 60);
      const s = Math.floor(total - m * 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    }

    const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

    // ------------------------------------------------------------------ icons

    function Svg({ children, size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, children);
    }
    const Icon = {
      logo: (p) => h(Svg, p, h('rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2.5 }), h('path', { d: 'M2.5 9.5h19' }), h('path', { d: 'M7 5l2.2 4.5M12 5l2.2 4.5M17 5l2.2 4.5' }), h('path', { d: 'M9.6 13.2l5.2 3-5.2 3z', fill: 'currentColor', stroke: 'none' })),
      play: (p) => h(Svg, p, h('path', { d: 'M7 4.5l12 7.5-12 7.5z', fill: 'currentColor', stroke: 'none' })),
      pause: (p) => h(Svg, p, h('rect', { x: 6.5, y: 4.5, width: 3.6, height: 15, rx: 1, fill: 'currentColor', stroke: 'none' }), h('rect', { x: 13.9, y: 4.5, width: 3.6, height: 15, rx: 1, fill: 'currentColor', stroke: 'none' })),
      prev: (p) => h(Svg, p, h('path', { d: 'M18 5v14L8 12z', fill: 'currentColor', stroke: 'none' }), h('path', { d: 'M6 5v14' })),
      next: (p) => h(Svg, p, h('path', { d: 'M6 5v14l10-7z', fill: 'currentColor', stroke: 'none' }), h('path', { d: 'M18 5v14' })),
      scissors: (p) => h(Svg, p, h('circle', { cx: 6, cy: 6, r: 2.6 }), h('circle', { cx: 6, cy: 18, r: 2.6 }), h('path', { d: 'M8.2 7.6L20 18M8.2 16.4L20 6' })),
      trash: (p) => h(Svg, p, h('path', { d: 'M4 7h16M9.5 7V4.8h5V7M6.5 7l1 13h9l1-13' })),
      plus: (p) => h(Svg, p, h('path', { d: 'M12 5v14M5 12h14' })),
      merge: (p) => h(Svg, p, h('path', { d: 'M4 12h7M13 12h7M11 8l2 4-2 4' }), h('path', { d: 'M4 7v10M20 7v10' })),
      upload: (p) => h(Svg, p, h('path', { d: 'M12 16V4M7.5 8.5L12 4l4.5 4.5M4.5 19.5h15' })),
      folder: (p) => h(Svg, p, h('path', { d: 'M3.5 6.5h5l1.6 2h10.4v9.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z' })),
      film: (p) => h(Svg, p, h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2 }), h('path', { d: 'M7.5 4.5v15M16.5 4.5v15M3 12h18' })),
      music: (p) => h(Svg, p, h('path', { d: 'M9 18V6l10-2v12' }), h('circle', { cx: 6.5, cy: 18, r: 2.5 }), h('circle', { cx: 16.5, cy: 16, r: 2.5 })),
      captions: (p) => h(Svg, p, h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }), h('path', { d: 'M9.5 10.5a2.5 2.5 0 1 0 0 3M16.5 10.5a2.5 2.5 0 1 0 0 3' })),
      sparkle: (p) => h(Svg, p, h('path', { d: 'M12 3.5l1.9 4.9 4.9 1.9-4.9 1.9L12 17.1l-1.9-4.9-4.9-1.9 4.9-1.9z' }), h('path', { d: 'M18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z' })),
      mic: (p) => h(Svg, p, h('rect', { x: 9, y: 3.5, width: 6, height: 10, rx: 3 }), h('path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6' })),
      zoomIn: (p) => h(Svg, p, h('circle', { cx: 10.5, cy: 10.5, r: 6 }), h('path', { d: 'M15 15l4.5 4.5M10.5 8v5M8 10.5h5' })),
      zoomOut: (p) => h(Svg, p, h('circle', { cx: 10.5, cy: 10.5, r: 6 }), h('path', { d: 'M15 15l4.5 4.5M8 10.5h5' })),
      volume: (p) => h(Svg, p, h('path', { d: 'M4 9.5h3l4-3.5v12l-4-3.5H4z' }), h('path', { d: 'M15 9a4.5 4.5 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11' })),
      download: (p) => h(Svg, p, h('path', { d: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M4.5 19.5h15' })),
      copy: (p) => h(Svg, p, h('rect', { x: 8.5, y: 8.5, width: 11, height: 11, rx: 2 }), h('path', { d: 'M15.5 5.5h-9a2 2 0 0 0-2 2v9' })),
      left: (p) => h(Svg, p, h('path', { d: 'M14.5 5.5L8 12l6.5 6.5' })),
      right: (p) => h(Svg, p, h('path', { d: 'M9.5 5.5L16 12l-6.5 6.5' })),
      close: (p) => h(Svg, p, h('path', { d: 'M6 6l12 12M18 6L6 18' })),
    };

    function IconBtn({ icon, title, onClick, disabled, on, size = 16 }) {
      return h('button', {
        type: 'button',
        className: `vs-ico${on ? ' on' : ''}`,
        title,
        'aria-label': title,
        disabled,
        onClick,
      }, h(icon, { size }));
    }

    /** Sidebar panel glyph; the sidebar owns the button and its click. */
    function PanelIcon({ size = 18 }) {
      return h('span', { style: { display: 'flex', pointerEvents: 'none' } }, h(Icon.logo, { size }));
    }

    // ------------------------------------------------------------ left: media

    function MediaPanel({ state, listing, dir, busy, onOpenDir, onImport, onUpload, onAddSubtitle, subtitles, onSeek, playhead }) {
      const [tab, setTab] = useState('media');
      const [query, setQuery] = useState('');
      const [picked, setPicked] = useState([]);
      const inputRef = useRef(null);
      const files = listing?.files ?? [];
      const match = (name) => name.toLowerCase().includes(query.trim().toLowerCase());
      const audioFiles = files.filter((file) => /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?)$/i.test(file.name) && match(file.name));
      const visualFiles = files.filter((file) => !audioFiles.includes(file) && match(file.name));
      const togglePicked = (path) => setPicked((current) => (current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path]));
      const pickedAudio = audioFiles.filter((file) => picked.includes(file.path));
      const pickedVisual = visualFiles.filter((file) => picked.includes(file.path));

      return h('div', { className: 'vs-left' },
        h('div', { className: 'vs-tabs' },
          [['media', t('media')], ['audio', t('audio')], ['text', t('text')]].map(([key, label]) =>
            h('button', {
              key, type: 'button', className: `vs-tab${tab === key ? ' on' : ''}`, onClick: () => setTab(key),
            }, label))),
        h('div', { className: 'vs-leftbody' },
          h('div', { className: 'vs-row' },
            h('button', { type: 'button', className: 'vs-btn primary', disabled: !state?.project || Boolean(busy), onClick: () => inputRef.current?.click() },
              h(Icon.upload, { size: 14 }), t('upload')),
            h('button', { type: 'button', className: 'vs-btn', disabled: !listing?.parent, onClick: () => onOpenDir(listing.parent), title: t('up') },
              h(Icon.left, { size: 14 })),
            h('input', {
              ref: inputRef, type: 'file', multiple: true, style: { display: 'none' },
              onChange: (event) => {
                const chosen = [...(event.target.files ?? [])];
                event.target.value = '';
                if (chosen.length) onUpload(chosen);
              },
            })),
          (state?.workspaces ?? []).length > 0
            ? h('select', {
              className: 'vs-sel', value: '',
              onChange: (event) => event.target.value && onOpenDir(event.target.value),
            },
            h('option', { value: '' }, `${t('workspace')}…`),
            state.workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.path }, `${workspace.title ?? workspace.id}`)))
            : null,
          h('div', { className: 'vs-row' },
            h('input', {
              className: 'vs-inp grow', placeholder: '搜索文件名…', value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            picked.length > 0
              ? h('button', {
                type: 'button', className: 'vs-btn primary',
                disabled: !state?.project || Boolean(busy),
                onClick: () => {
                  const paths = [...pickedAudio, ...pickedVisual].map((file) => file.path);
                  setPicked([]);
                  if (paths.length) onImport(paths);
                },
              }, `加入 ${picked.length}`)
              : null,
            picked.length > 0
              ? h('button', { type: 'button', className: 'vs-btn', onClick: () => setPicked([]) }, '清空')
              : null),
          h('div', { className: 'vs-crumb' }, h(Icon.folder, { size: 12 }), h('span', { title: dir ?? '' }, dir ?? '')),

          tab === 'media' || tab === 'audio'
            ? h('div', { className: 'vs-grid' },
              (listing?.directories ?? []).map((entry) => h('div', {
                key: entry.path, className: 'vs-folder', style: { gridColumn: '1 / -1' }, onClick: () => onOpenDir(entry.path),
              }, h(Icon.folder, { size: 14 }), entry.name)),
              (tab === 'audio' ? audioFiles : visualFiles).map((file) => h('div', {
                key: file.path, className: `vs-tile${picked.includes(file.path) ? ' picked' : ''}`,
                onClick: () => togglePicked(file.path),
                onDoubleClick: () => onImport([file.path]),
                title: `${file.name}\n单击多选，双击直接加入时间线`,
              },
              h('img', {
                src: thumbUrl(file.path), loading: 'lazy', alt: '',
                // the thumbnail endpoint may be absent before a host restart
                onError: (event) => { event.currentTarget.style.visibility = 'hidden'; },
              }),
              h('button', {
                type: 'button', className: 'plus', title: t('addToTimeline'),
                onClick: (event) => { event.stopPropagation(); onImport([file.path]); },
              }, '+'),
              h('div', { className: 'cap', title: file.name }, file.name))),
              ((tab === 'audio' ? audioFiles : visualFiles).length === 0
                ? h('div', { className: 'vs-hint', style: { gridColumn: '1 / -1' } }, t('emptyDir'))
                : null))
            : h('div', { className: 'vs-list' },
              h('div', { className: 'vs-row' },
                h('button', { type: 'button', className: 'vs-btn primary', onClick: () => onAddSubtitle(playhead) },
                  h(Icon.plus, { size: 14 }), t('addText'))),
              subtitles.length === 0
                ? h('div', { className: 'vs-hint' }, t('emptySubtitles'))
                : subtitles.map((segment, index) => h('div', {
                  key: index, className: 'vs-item', onClick: () => onSeek(segment.start),
                },
                h('span', { className: 'nm', title: segment.text }, segment.text),
                h('span', { className: 'vs-val' }, clock(segment.start))))),
        ));
    }

    // ------------------------------------------------------------------ panel

    function Panel() {
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(null);
      const [listing, setListing] = useState(null);
      const [dir, setDir] = useState(null);
      const [draft, setDraft] = useState([]);
      const [dirty, setDirty] = useState(false);
      const [selectedClip, setSelectedClip] = useState(null);
      const [selectedSub, setSelectedSub] = useState(null);
      const [clipDraft, setClipDraft] = useState({});
      const [snapLine, setSnapLine] = useState(null);
      const [tab, setTab] = useState('subtitles');
      const [previewMode, setPreviewMode] = useState('timeline');
      const [previewRender, setPreviewRender] = useState(null);
      const [clipIndex, setClipIndex] = useState(0);
      const [playhead, setPlayhead] = useState(0);
      const [containerWidth, setContainerWidth] = useState(0);
      const [playing, setPlaying] = useState(false);
      const [zoom, setZoom] = useState(null);
      const [newName, setNewName] = useState('');
      const [preset, setPreset] = useState('landscape');
      const [language, setLanguage] = useState('auto');
      const [voice, setVoice] = useState('Tingting');
      const [rate, setRate] = useState(180);
      const [dubMode, setDubMode] = useState('segments');
      const [script, setScript] = useState('');
      const [bgmPath, setBgmPath] = useState('');
      const [options, setOptions] = useState({ burnSubtitles: true, includeDub: true, includeBgm: true, muteOriginal: false, crf: 21, originalVolume: 0.25, bgmVolume: 0.28 });
      const [leftOpen, setLeftOpen] = useState(true);

      const videoRef = useRef(null);
      const dubRef = useRef(null);
      const [previewDub, setPreviewDub] = useState(true);
      const staleErrorRef = useRef(null);
      const scrollRef = useRef(null);
      const contentRef = useRef(null);
      const clipDraftRef = useRef({});
      const zoomRef = useRef(60);
      const playheadRef = useRef(0);
      const durationRef = useRef(0);

      const project = state?.project ?? null;
      const clips = project?.clips ?? [];
      const segments = draft;
      const duration = useMemo(() => clips.reduce((sum, clip) => sum + Math.max(0, clip.out - clip.in), 0), [clips]);
      const jobs = state?.jobs ?? [];
      const activeJob = jobs.find((job) => job.status === 'running') ?? null;
      const speech = state?.speech ?? null;
      const speechReady = Boolean(speech?.providers?.some((provider) => ['ready', 'standby'].includes(provider.phase)));
      const autoZoom = duration > 0 && containerWidth > 0 ? clamp(containerWidth / duration, 12, 240) : 60;
      const pxPerSec = zoom ?? autoZoom;

      zoomRef.current = pxPerSec;
      playheadRef.current = playhead;
      durationRef.current = duration;
      clipDraftRef.current = clipDraft;

      const applyState = useCallback((next) => {
        setState(next);
        if (next?.tts?.defaultVoice) setVoice((current) => (current === 'Tingting' ? next.tts.defaultVoice : current));
      }, []);

      const refresh = useCallback(async (projectId) => {
        try {
          const next = await call(`/state${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
          applyState(next);
          staleErrorRef.current = null;
          setError(null);
          return next;
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          staleErrorRef.current = message;
          setError(message);
          return null;
        }
      }, [applyState]);

      const withBusy = useCallback(async (label, fn) => {
        setBusy(label);
        setNotice(null);
        try {
          return await fn();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
          return null;
        } finally {
          setBusy(null);
        }
      }, []);

      const pollJob = useCallback(async (id) => {
        for (let i = 0; i < 900; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 900));
          try {
            const { job } = await call(`/job?id=${encodeURIComponent(id)}`);
            if (job.status !== 'running') {
              await refresh();
              if (job.status === 'failed') setError(job.error);
              else setNotice(job.message);
              return;
            }
          } catch {
            return;
          }
        }
      }, [refresh]);

      // initial load + polling
      useEffect(() => {
        let cancelled = false;
        let timer = null;
        const tick = async () => {
          const next = await refresh();
          if (cancelled) return;
          if (next === null && /未授权|unauthorized/.test(String(staleErrorRef.current ?? ''))) return;
          const running = (next?.jobs ?? []).some((job) => job.status === 'running');
          timer = setTimeout(tick, running ? 800 : 5000);
        };
        tick();
        return () => {
          cancelled = true;
          if (timer) clearTimeout(timer);
        };
      }, [refresh]);

      useEffect(() => {
        if (!project) {
          setDraft([]);
          return;
        }
        if (!dirty) setDraft(project.subtitles?.segments ?? []);
        if (project.dub?.voice) setVoice(project.dub.voice);
        if (project.dub?.rate) setRate(project.dub.rate);
        if (project.dub?.mode) setDubMode(project.dub.mode);
        if (project.dub?.script) setScript(project.dub.script);
        if (project.bgm?.path) setBgmPath(project.bgm.path);
        setOptions((current) => ({
          ...current,
          originalVolume: project.dub?.originalVolume ?? current.originalVolume,
          muteOriginal: project.dub?.muteOriginal ?? current.muteOriginal,
          bgmVolume: project.bgm?.volume ?? current.bgmVolume,
        }));
      }, [project?.id, project?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

      const loadDir = useCallback(async (target) => {
        return withBusy('files', async () => {
          const result = await call(`/files${target ? `?dir=${encodeURIComponent(target)}` : ''}`);
          setListing(result);
          setDir(result.dir);
          return result;
        });
      }, [withBusy]);

      useEffect(() => {
        loadDir(null);
      }, [loadDir]);

      // track the timeline viewport so "fit" follows window resizes
      useEffect(() => {
        const element = scrollRef.current;
        if (!element) return undefined;
        const update = () => setContainerWidth(element.clientWidth);
        update();
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(update);
          observer.observe(element);
          return () => observer.disconnect();
        }
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
      }, [project?.id, leftOpen]);

      // ---- playback ------------------------------------------------------

      const currentClip = clips[Math.min(clipIndex, Math.max(0, clips.length - 1))] ?? null;
      const previewSource = previewMode === 'render' && previewRender
        ? mediaUrl(previewRender)
        : currentClip ? mediaUrl(currentClip.path) : null;
      const previewIsImage = previewMode === 'timeline' && currentClip?.kind === 'image';
      const dubTrack = project?.dub?.track ?? null;
      const dubEnabled = Boolean(dubTrack) && previewDub && previewMode === 'timeline';
      // Editing preview shows the subtitle the playhead is sitting on, the way a
      // burned export would; an export preview already carries its own subtitles.
      const activeSubtitle = previewMode === 'timeline'
        ? segments.find((segment) => playhead >= segment.start - 0.001 && playhead <= segment.end + 0.001) ?? null
        : null;

      const offsets = useMemo(() => {
        let cursor = 0;
        return clips.map((clip) => {
          const entry = { start: cursor, end: cursor + Math.max(0, clip.out - clip.in) };
          cursor = entry.end;
          return entry;
        });
      }, [clips]);

      const seekTo = useCallback((seconds) => {
        const target = clamp(seconds, 0, Math.max(0.01, durationRef.current));
        setPlayhead(target);
        if (previewMode === 'render') {
          const video = videoRef.current;
          if (video) video.currentTime = target;
          return;
        }
        const list = offsets;
        let index = 0;
        while (index < list.length - 1 && list[index].end < target) index += 1;
        const clip = clips[index];
        if (!clip) return;
        setClipIndex(index);
        const local = clip.in + Math.max(0, target - list[index].start);
        const video = videoRef.current;
        if (video) video.currentTime = Math.min(local, clip.out - 0.02);
        if (dubRef.current) dubRef.current.currentTime = target;
      }, [clips, offsets, previewMode]);

      const togglePlay = useCallback(() => {
        const video = videoRef.current;
        if (previewIsImage) return;
        if (!video) return;
        if (video.paused) {
          video.play().catch(() => {});
          setPlaying(true);
        } else {
          video.pause();
          setPlaying(false);
        }
      }, [previewIsImage]);

      const onTimeUpdate = () => {
        const video = videoRef.current;
        if (!video) return;
        if (previewMode === 'timeline' && currentClip && offsets[clipIndex]) {
          const timelineTime = offsets[clipIndex].start + Math.max(0, video.currentTime - currentClip.in);
          setPlayhead(timelineTime);
          const audio = dubRef.current;
          if (audio && dubEnabled && !audio.paused && Math.abs(audio.currentTime - timelineTime) > 0.35) {
            audio.currentTime = timelineTime;
          }
        } else {
          setPlayhead(video.currentTime);
        }
      };

      const onEnded = () => {
        if (previewMode !== 'timeline') {
          setPlaying(false);
          return;
        }
        if (clipIndex + 1 < clips.length) {
          setClipIndex(clipIndex + 1);
          setTimeout(() => videoRef.current?.play().catch(() => {}), 50);
        } else {
          setPlaying(false);
        }
      };

      useEffect(() => {
        const video = videoRef.current;
        if (!video || previewMode !== 'timeline' || !currentClip || previewIsImage) return;
        try {
          if (Math.abs(video.currentTime - currentClip.in) > 0.25) video.currentTime = currentClip.in;
        } catch {
          /* seeking can fail for exotic containers */
        }
      }, [clipIndex, previewMode, currentClip?.id]); // eslint-disable-line react-hooks/exhaustive-deps

      // element volumes mirror the export mix so the preview sounds like the result
      useEffect(() => {
        const video = videoRef.current;
        if (video) video.volume = options.muteOriginal ? 0 : clamp(options.originalVolume, 0, 1);
      }, [options.muteOriginal, options.originalVolume, previewSource]);

      useEffect(() => {
        if (dubRef.current) dubRef.current.volume = clamp(project?.dub?.volume ?? 1, 0, 1);
      }, [project?.dub?.volume, dubTrack]);

      // the dub track is timeline-global: follow play/pause and mode changes
      useEffect(() => {
        const audio = dubRef.current;
        if (!audio) return;
        if (dubEnabled && playing) audio.play().catch(() => {});
        else audio.pause();
        if (!dubEnabled) audio.currentTime = 0;
      }, [dubEnabled, playing]);

      // ---- keyboard transport --------------------------------------------

      useEffect(() => {
        const onKey = (event) => {
          const tag = document.activeElement?.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
          if (event.code === 'Space') {
            event.preventDefault();
            togglePlay();
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            seekTo(playheadRef.current - (event.shiftKey ? 1 : 0.1));
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            seekTo(playheadRef.current + (event.shiftKey ? 1 : 0.1));
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            if (selectedClip) {
              event.preventDefault();
              removeClip(selectedClip);
            }
          } else if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
            if (dirty) {
              event.preventDefault();
              saveSubtitles();
            }
          } else if (event.key === 'z' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (event.shiftKey) redoProject();
            else undoProject();
          } else if (event.key === 'y' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            redoProject();
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }); // re-bound each render so the handlers close over fresh state

      // ---- drag helpers ---------------------------------------------------

      const beginDrag = useCallback((event, onMove, onEnd) => {
        event.preventDefault();
        event.stopPropagation();
        const move = (moveEvent) => onMove(moveEvent);
        const up = (upEvent) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          onEnd?.(upEvent);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        onMove(event);
      }, []);

      const scrub = (event) => {
        const rect = contentRef.current?.getBoundingClientRect();
        if (!rect) return;
        const scale = zoomRef.current;
        beginDrag(event, (moveEvent) => {
          seekTo((moveEvent.clientX - rect.left) / scale);
        }, null);
      };

      const trim = (event, clip, side) => {
        const startX = event.clientX;
        const scale = zoomRef.current;
        const origin = { in: clip.in, out: clip.out };
        const duration0 = clip.duration;
        beginDrag(event, (moveEvent) => {
          const delta = (moveEvent.clientX - startX) / scale;
          const patch = side === 'in'
            ? { in: clamp(origin.in + delta, 0, origin.out - 0.1) }
            : { out: clamp(origin.out + delta, origin.in + 0.1, duration0) };
          setClipDraft((current) => ({ ...current, [clip.id]: { ...(current[clip.id] ?? {}), ...patch } }));
        }, async () => {
          const patch = clipDraftRef.current[clip.id];
          if (patch) {
            await withBusy('trim', async () => {
              await call('/clips/update', {
                body: { projectId: project.id, clips: clips.map((item) => (item.id === clip.id ? { ...item, ...patch } : item)) },
              });
              await refresh(project.id);
            });
          }
          setClipDraft((current) => {
            const next = { ...current };
            delete next[clip.id];
            return next;
          });
        });
      };

      /**
       * Drag a subtitle block along the timeline, snapping to the playhead, the
       * timeline edges, clip boundaries and neighbouring subtitle edges.
       */
      const dragSubtitle = (event, index, mode = 'move') => {
        const segment = segments[index];
        if (!segment) return;
        const startX = event.clientX;
        const scale = zoomRef.current;
        const origin = { start: segment.start, end: segment.end };
        const otherEdges = segments
          .filter((_item, position) => position !== index)
          .flatMap((item) => [item.start, item.end]);
        const clipEdges = offsets.flatMap((entry) => [entry.start, entry.end]);
        const snapPoints = [0, durationRef.current, playheadRef.current, ...otherEdges, ...clipEdges]
          .filter((value) => Number.isFinite(value));
        const tolerance = 9 / scale;
        let active = false;

        const move = (moveEvent) => {
          if (!active) {
            if (Math.abs(moveEvent.clientX - startX) < 3) return;
            active = true;
          }
          const rawDelta = (moveEvent.clientX - startX) / scale;
          const total = durationRef.current;
          const span = origin.end - origin.start;
          let snappedAt = null;
          const snapValue = (value) => {
            for (const point of snapPoints) {
              if (Math.abs(value - point) <= tolerance) {
                snappedAt = point;
                return point;
              }
            }
            return value;
          };

          if (mode === 'move') {
            const start = clamp(snapValue(origin.start + rawDelta), 0, Math.max(0, total - span));
            setSnapLine(snappedAt);
            setDraft((current) => current.map((item, position) =>
              (position === index ? { ...item, start: round(start), end: round(start + span) } : item)));
          } else if (mode === 'start') {
            const start = clamp(snapValue(origin.start + rawDelta), 0, origin.end - 0.3);
            setSnapLine(snappedAt);
            setDraft((current) => current.map((item, position) =>
              (position === index ? { ...item, start: round(start) } : item)));
          } else {
            const end = clamp(snapValue(origin.end + rawDelta), origin.start + 0.3, total);
            setSnapLine(snappedAt);
            setDraft((current) => current.map((item, position) =>
              (position === index ? { ...item, end: round(end) } : item)));
          }
          setDirty(true);
        };

        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          setSnapLine(null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };

      // ---- actions --------------------------------------------------------

      const createProject = () => withBusy('create', async () => {
        const result = await call('/project/create', { body: { name: newName || undefined, preset } });
        setNewName('');
        setDirty(false);
        setClipIndex(0);
        setPlayhead(0);
        setPreviewMode('timeline');
        await refresh(result.project.id);
        setNotice(`已创建项目「${result.project.name}」`);
      });

      const openProject = (id) => withBusy('open', async () => {
        await call('/project/open', { body: { id } });
        setDirty(false);
        setClipIndex(0);
        setPlayhead(0);
        setSelectedClip(null);
        setSelectedSub(null);
        setPreviewMode('timeline');
        await refresh(id);
      });

      const removeProject = (id) => withBusy('removeProject', async () => {
        await call('/project/delete', { body: { id } });
        await refresh();
      });

      const renameProject = (name) => withBusy('rename', async () => {
        await call('/project/update', { body: { projectId: project.id, patch: { name } } });
        await refresh(project.id);
      });

      const applyPreset = (presetId) => withBusy('preset', async () => {
        await call('/project/update', { body: { projectId: project.id, patch: { target: { preset: presetId } } } });
        await refresh(project.id);
      });

      const importPaths = (paths) => withBusy('import', async () => {
        if (!project) throw new Error('先新建项目');
        const result = await call('/import', { body: { projectId: project.id, paths } });
        await refresh(project.id);
        if (result.skipped?.length) setError(`部分文件跳过：${result.skipped.map((item) => `${item.path}（${item.error}）`).join('；')}`);
        else setNotice(`已添加 ${result.added.length} 个片段`);
      });

      const uploadFiles = (files) => withBusy('upload', async () => {
        if (!project) throw new Error('先新建项目');
        for (const file of files) {
          const response = await fetch(withToken(
            `${API_BASE}/upload?name=${encodeURIComponent(file.name)}&projectId=${encodeURIComponent(project.id)}`,
          ), {
            method: 'POST',
            body: file,
            credentials: 'same-origin',
            ...(readToken() === null ? {} : { headers: { 'x-vs-token': readToken() } }),
          });
          const value = await response.json().catch(() => ({ ok: false, error: '上传失败' }));
          if (!response.ok || value.ok === false) throw new Error(value.error ?? '上传失败');
        }
        await refresh(project.id);
        setNotice(`已导入 ${files.length} 个文件`);
      });

      const pushClips = (nextClips, label) => withBusy(label, async () => {
        await call('/clips/update', {
          body: { projectId: project.id, clips: nextClips.map((clip) => ({ id: clip.id, in: clip.in, out: clip.out })) },
        });
        await refresh(project.id);
      });

      const removeClip = (id) => withBusy('removeClip', async () => {
        await call('/clips/remove', { body: { projectId: project.id, clipId: id } });
        if (selectedClip === id) setSelectedClip(null);
        await refresh(project.id);
      });

      const moveClip = (index, delta) => {
        const next = [...clips];
        const target = index + delta;
        if (target < 0 || target >= next.length) return;
        const [item] = next.splice(index, 1);
        next.splice(target, 0, item);
        return pushClips(next, 'move');
      };

      const splitAtPlayhead = () => withBusy('split', async () => {
        const id = selectedClip ?? clips[Math.min(clipIndex, clips.length - 1)]?.id;
        if (!id) throw new Error('先选中一个片段');
        await call('/clips/split', { body: { projectId: project.id, clipId: id, at: playhead } });
        await refresh(project.id);
        setNotice('已在播放头处分割');
      });

      const mergeSelected = () => withBusy('merge', async () => {
        const id = selectedClip ?? clips[Math.min(clipIndex, clips.length - 1)]?.id;
        if (!id) throw new Error('先选中一个片段');
        await call('/clips/merge', { body: { projectId: project.id, clipId: id } });
        await refresh(project.id);
        setNotice('已与相邻片段合并');
      });

      const autoSubtitles = () => withBusy('subtitles', async () => {
        setDirty(false);
        const result = await call('/subtitles/auto', { body: { projectId: project.id, language } });
        setNotice('字幕识别已开始…');
        pollJob(result.job.id);
      });

      const cancelSpeech = () => withBusy('speechCancel', async () => {
        await call('/speech/cancel', { body: {} });
        setNotice('已中止模型下载');
        await refresh(project?.id);
      });

      const prepareSpeech = () => withBusy('speech', async () => {
        await call('/speech/prepare', { body: {} });
        setNotice('开始准备语音模型，首次需下载约 239 MB');
        await refresh(project?.id);
      });

      const saveSubtitles = () => withBusy('saveSubtitles', async () => {
        const cleaned = draft.filter((segment) => String(segment.text ?? '').trim().length > 0);
        await call('/subtitles/set', { body: { projectId: project.id, segments: cleaned, source: 'edited' } });
        setDirty(false);
        await refresh(project.id);
        setNotice(`已保存 ${cleaned.length} 条字幕`);
      });

      const addSubtitleAt = (at) => {
        const start = Math.round((Number(at) || 0) * 10) / 10;
        const next = [...draft, { start, end: start + 2, text: '新字幕' }].sort((a, b) => a.start - b.start);
        setDraft(next);
        setDirty(true);
        setSelectedSub(next.findIndex((segment) => segment.start === start));
        setTab('subtitles');
      };

      const startDub = () => withBusy('dub', async () => {
        const result = await call('/dub/start', {
          body: { projectId: project.id, voice, rate, mode: dubMode, script, fitToSegment: true },
        });
        setNotice('配音生成中…');
        pollJob(result.job.id);
      });

      const saveDubSettings = () => withBusy('dubSettings', async () => {
        await call('/project/update', {
          body: {
            projectId: project.id,
            patch: {
              dub: { voice, rate, mode: dubMode, script, enabled: true, originalVolume: options.originalVolume, muteOriginal: options.muteOriginal },
              bgm: { path: bgmPath || null, volume: options.bgmVolume },
            },
          },
        });
        await refresh(project.id);
        setNotice('配音与音乐设置已保存');
      });

      const startRender = () => withBusy('render', async () => {
        await call('/project/update', {
          body: {
            projectId: project.id,
            patch: {
              dub: { enabled: true, originalVolume: options.originalVolume, muteOriginal: options.muteOriginal },
              bgm: { path: bgmPath || project.bgm?.path || null, volume: options.bgmVolume },
            },
          },
        });
        const result = await call('/render/start', {
          body: {
            projectId: project.id,
            options: {
              burnSubtitles: options.burnSubtitles && draft.length > 0,
              includeDub: options.includeDub,
              includeBgm: options.includeBgm && Boolean(bgmPath || project.bgm?.path),
              originalVolume: options.originalVolume,
              muteOriginal: options.muteOriginal,
              crf: options.crf,
            },
          },
        });
        setNotice('导出中…');
        pollJob(result.job.id);
      });

      const undoProject = () => withBusy('undo', async () => {
        const result = await call('/project/undo', { body: { projectId: project.id } });
        setDirty(false);
        setSelectedSub(null);
        await refresh(result.project.id);
        setNotice(t('undone'));
      });

      const redoProject = () => withBusy('redo', async () => {
        const result = await call('/project/redo', { body: { projectId: project.id } });
        setDirty(false);
        setSelectedSub(null);
        await refresh(result.project.id);
        setNotice(t('redone'));
      });

      const copyRender = (file) => withBusy('copy', async () => {
        const result = await call('/export/copy', { body: { file } });
        setNotice(`${t('copyDone')} ${result.file}`);
      });

      // ---- render ---------------------------------------------------------

      const audioFiles = (listing?.files ?? []).filter((file) => /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?)$/i.test(file.name));
      const step = TICK_STEPS.find((value) => value * pxPerSec >= 72) ?? TICK_STEPS[TICK_STEPS.length - 1];
      const contentWidth = Math.max(240, duration * pxPerSec);
      const ticks = [];
      for (let time = 0; time <= duration + 0.001 && ticks.length < 400; time += step) {
        ticks.push({ time, major: true });
      }
      const selectedClipData = clips.find((clip) => clip.id === selectedClip) ?? null;
      const selectedSubData = selectedSub !== null ? draft[selectedSub] : null;
      const clipBox = (clip, index) => {
        const patch = clipDraft[clip.id] ?? {};
        const inPoint = patch.in ?? clip.in;
        const outPoint = patch.out ?? clip.out;
        const blockDuration = Math.max(0.05, outPoint - inPoint);
        const entry = offsets[index] ?? { start: 0 };
        // while trimming, re-derive the start from the preceding clips in the draft
        let start = entry.start;
        if (patch.in !== undefined || patch.out !== undefined) {
          start = 0;
          for (let i = 0; i < index; i += 1) {
            const other = clips[i];
            const otherPatch = clipDraft[other.id] ?? {};
            start += Math.max(0, (otherPatch.out ?? other.out) - (otherPatch.in ?? other.in));
          }
        }
        return { start, width: blockDuration * pxPerSec, inPoint, outPoint, blockDuration };
      };

      return h('div', { className: 'vs-root' },
        // ------------------------------------------------------------- top bar
        h('div', { className: 'vs-top' },
          h('button', { type: 'button', className: 'vs-ico', title: leftOpen ? '收起媒体库' : '展开媒体库', onClick: () => setLeftOpen(!leftOpen) },
            h(Icon.film, { size: 16 })),
          h('div', { className: 'vs-logo' }, h('b', {}, 'Video'), 'Studio'),
          project
            ? h('input', {
              className: 'vs-name', defaultValue: project.name, key: project.name,
              onBlur: (event) => { const value = event.target.value.trim(); if (value && value !== project.name) renameProject(value); },
              title: '项目名',
            })
            : h('span', { className: 'vs-chip' }, t('noProject')),
          project
            ? h('select', {
              className: 'vs-sel', value: project.target?.width === 1080 && project.target?.height === 1920 ? 'portrait'
                : project.target?.width === 1080 ? 'square'
                  : project.target?.width === 1280 ? '720p' : 'landscape',
              onChange: (event) => applyPreset(event.target.value),
              title: t('ratio'),
            }, (state?.presets ?? []).map((item) => h('option', { key: item.id, value: item.id }, item.label)))
            : null,
          h('span', { className: 'vs-spacer' }),
          state && state.tools && !state.tools.ok ? h('span', { className: 'vs-chip bad' }, t('ffmpegMissing')) : null,
          speech ? h('span', { className: `vs-chip ${speechReady ? 'ok' : 'warn'}` }, speechReady ? t('speechReady') : t('speechUnprepared')) : null,
          (state?.projects ?? []).length > 0
            ? h('select', {
              className: 'vs-sel', value: project?.id ?? '', onChange: (event) => event.target.value && openProject(event.target.value),
            },
            h('option', { value: '' }, t('openProject')),
            state.projects.map((item) => h('option', { key: item.id, value: item.id }, item.name)))
            : null,
          h('button', { type: 'button', className: 'vs-btn', onClick: () => refresh(project?.id), title: '刷新' }, h(Icon.right, { size: 14 })),
          h('button', {
            type: 'button', className: 'vs-btn primary',
            disabled: Boolean(busy) || clips.length === 0,
            onClick: () => { setTab('export'); startRender(); },
          }, h(Icon.download, { size: 14 }), t('export')),
        ),

        error
          ? h('div', {
            className: 'vs-msg err',
            style: { margin: '8px 10px 0', display: 'flex', alignItems: 'center', gap: 10 },
          },
          h('span', { style: { flex: 1 } }, error),
          /未授权|unauthorized/.test(String(error))
            ? h('button', {
              type: 'button', className: 'vs-btn primary',
              onClick: () => window.location.reload(),
            }, '重新加载页面')
            : null)
          : null,
        notice ? h('div', { className: 'vs-msg ok', style: { margin: '8px 10px 0' } }, notice) : null,

        // ---------------------------------------------------------- main row
        h('div', { className: 'vs-main' },
          !project
            ? h('div', { className: 'vs-center' },
              h('div', { className: 'vs-viewer' },
                h('div', { className: 'vs-hint' },
                  h('div', { className: 'big' }, '开始你的第一个项目'),
                  h('div', { style: { marginBottom: 12 } }, '新建项目后即可导入素材、自动字幕、自动配音并导出'),
                  h('div', { className: 'vs-row', style: { justifyContent: 'center' } },
                    h('input', { className: 'vs-inp', placeholder: '项目名（可留空）', value: newName, onChange: (event) => setNewName(event.target.value) }),
                    h('select', { className: 'vs-sel', value: preset, onChange: (event) => setPreset(event.target.value) },
                      (state?.presets ?? []).map((item) => h('option', { key: item.id, value: item.id }, item.label))),
                    h('button', { type: 'button', className: 'vs-btn primary', disabled: Boolean(busy), onClick: createProject }, t('newProject'))),
                  (state?.projects ?? []).length > 0
                    ? h('div', { style: { marginTop: 14 } },
                      h('div', { className: 'vs-lbl' }, '或打开已有项目'),
                      h('div', { className: 'vs-list', style: { maxWidth: 420, margin: '0 auto' } },
                        state.projects.map((item) => h('div', { key: item.id, className: 'vs-item' },
                          h('span', { className: 'nm' }, item.name),
                          h('span', { className: 'vs-val' }, `${item.clipCount} 片段 · ${clockShort(item.duration)}`),
                          h('button', { type: 'button', className: 'vs-btn', onClick: () => openProject(item.id) }, t('openProject'))))))
                    : null)))
            : h(React.Fragment, null,
              leftOpen
                ? h(MediaPanel, {
                  state, listing, dir, busy,
                  onOpenDir: loadDir,
                  onImport: importPaths,
                  onUpload: uploadFiles,
                  onAddSubtitle: addSubtitleAt,
                  subtitles: segments,
                  onSeek: (time) => { setPreviewMode('timeline'); seekTo(time); },
                  playhead,
                })
                : null,

              // ----------------------------------------------------- viewer
              h('div', { className: 'vs-center' },
                h('div', { className: 'vs-viewer' },
                  previewSource
                    ? (previewIsImage
                      ? h('img', { src: previewSource, alt: '' })
                      : h('video', {
                        ref: videoRef,
                        src: previewSource,
                        playsInline: true,
                        poster: previewMode === 'timeline' && currentClip?.poster ? mediaUrl(currentClip.poster) : undefined,
                        onTimeUpdate,
                        onEnded,
                        onPlay: () => {
                          setPlaying(true);
                          if (dubEnabled) dubRef.current?.play().catch(() => {});
                        },
                        onPause: () => {
                          setPlaying(false);
                          dubRef.current?.pause();
                        },
                        onClick: togglePlay,
                      }))
                    : h('div', { className: 'vs-hint' }, t('emptyTrack')),
                  activeSubtitle
                    ? h('div', {
                      className: 'vs-overlay',
                      style: {
                        color: project?.subtitles?.style?.color ?? '#ffffff',
                        fontFamily: project?.subtitles?.style?.fontFamily || 'PingFang SC',
                        fontSize: 'clamp(14px, 3.2vh, 34px)',
                      },
                    }, activeSubtitle.text)
                    : null,
                  previewMode === 'render'
                    ? h('div', { className: 'vs-ovtag' }, '成片（已含字幕/配音）')
                    : null,
                  h('audio', { ref: dubRef, src: dubTrack ? mediaUrl(dubTrack) : undefined, preload: 'auto', style: { display: 'none' } })),
                h('div', { className: 'vs-transport' },
                  h(IconBtn, { icon: Icon.prev, title: t('prevClip'), disabled: clips.length === 0, onClick: () => seekTo(offsets[Math.max(0, clipIndex - 1)]?.start ?? 0) }),
                  h(IconBtn, { icon: playing ? Icon.pause : Icon.play, title: playing ? t('pause') : t('play'), disabled: !previewSource || previewIsImage, onClick: togglePlay }),
                  h(IconBtn, { icon: Icon.next, title: t('nextClip'), disabled: clipIndex + 1 >= clips.length, onClick: () => seekTo(offsets[clipIndex + 1]?.start ?? duration) }),
                  h('span', { className: 'vs-time' }, clock(playhead), h('small', {}, ` / ${clock(duration)}`)),
                  h('span', { className: 'vs-spacer' }),
                  dubTrack
                    ? h('button', {
                      type: 'button', className: `vs-btn${previewDub ? ' on' : ''}`,
                      title: '预览时播放配音轨',
                      onClick: () => setPreviewDub(!previewDub),
                    }, h(Icon.volume, { size: 14 }), t('dub'))
                    : null,
                  project?.renders?.[0]
                    ? h('button', {
                      type: 'button', className: `vs-btn${previewMode === 'render' ? ' on' : ''}`,
                      onClick: () => { setPreviewRender(project.renders[0].file); setPreviewMode('render'); },
                    }, h(Icon.film, { size: 14 }), '成片')
                    : null,
                  h('button', {
                    type: 'button', className: `vs-btn${previewMode === 'timeline' ? ' on' : ''}`,
                    onClick: () => { setPreviewMode('timeline'); setClipIndex(Math.min(clipIndex, Math.max(0, clips.length - 1))); },
                  }, h(Icon.film, { size: 14 }), '时间线'),
                  activeJob
                    ? h('span', { className: 'vs-chip warn', title: activeJob.message }, `${Math.round((activeJob.progress ?? 0) * 100)}%`)
                    : null),

              ),

              // -------------------------------------------------- inspector
              h('div', { className: 'vs-right' },
                selectedClipData
                  ? h('div', { className: 'vs-sec' },
                    h('h4', {}, `${t('clipProps')} · ${clips.findIndex((clip) => clip.id === selectedClip) + 1}/${clips.length}`),
                    h('div', { className: 'vs-row' }, h('span', { className: 'vs-lbl' }, '素材'), h('span', { className: 'vs-val nm', title: selectedClipData.path }, selectedClipData.name)),
                    h('div', { className: 'vs-row' },
                      h('span', { className: 'vs-lbl' }, t('inPoint')),
                      h('input', {
                        type: 'range', className: 'vs-range', min: 0, max: selectedClipData.duration, step: 0.05,
                        value: clipDraft[selectedClipData.id]?.in ?? selectedClipData.in,
                        onChange: (event) => setClipDraft((current) => ({ ...current, [selectedClipData.id]: { ...(current[selectedClipData.id] ?? {}), in: Number(event.target.value) } })),
                        onPointerUp: () => pushClips(clips.map((clip) => (clip.id === selectedClipData.id ? { ...clip, ...(clipDraft[selectedClipData.id] ?? {}) } : clip)), 'trim'),
                      }),
                      h('input', {
                        className: 'vs-inp num', type: 'number', step: '0.1',
                        value: (clipDraft[selectedClipData.id]?.in ?? selectedClipData.in).toFixed(2),
                        onChange: (event) => setClipDraft((current) => ({ ...current, [selectedClipData.id]: { ...(current[selectedClipData.id] ?? {}), in: Number(event.target.value) } })),
                        onBlur: () => pushClips(clips.map((clip) => (clip.id === selectedClipData.id ? { ...clip, ...(clipDraft[selectedClipData.id] ?? {}) } : clip)), 'trim'),
                      })),
                    h('div', { className: 'vs-row' },
                      h('span', { className: 'vs-lbl' }, t('outPoint')),
                      h('input', {
                        type: 'range', className: 'vs-range', min: 0, max: selectedClipData.duration, step: 0.05,
                        value: clipDraft[selectedClipData.id]?.out ?? selectedClipData.out,
                        onChange: (event) => setClipDraft((current) => ({ ...current, [selectedClipData.id]: { ...(current[selectedClipData.id] ?? {}), out: Number(event.target.value) } })),
                        onPointerUp: () => pushClips(clips.map((clip) => (clip.id === selectedClipData.id ? { ...clip, ...(clipDraft[selectedClipData.id] ?? {}) } : clip)), 'trim'),
                      }),
                      h('input', {
                        className: 'vs-inp num', type: 'number', step: '0.1',
                        value: (clipDraft[selectedClipData.id]?.out ?? selectedClipData.out).toFixed(2),
                        onChange: (event) => setClipDraft((current) => ({ ...current, [selectedClipData.id]: { ...(current[selectedClipData.id] ?? {}), out: Number(event.target.value) } })),
                        onBlur: () => pushClips(clips.map((clip) => (clip.id === selectedClipData.id ? { ...clip, ...(clipDraft[selectedClipData.id] ?? {}) } : clip)), 'trim'),
                      })),
                    h('div', { className: 'vs-row' },
                      h('span', { className: 'vs-lbl' }, t('duration')),
                      h('span', { className: 'vs-val' }, `${((clipDraft[selectedClipData.id]?.out ?? selectedClipData.out) - (clipDraft[selectedClipData.id]?.in ?? selectedClipData.in)).toFixed(2)}s`),
                      h('span', { className: 'vs-lbl' }, t('sourceLength')),
                      h('span', { className: 'vs-val' }, `${selectedClipData.duration.toFixed(2)}s`)),
                    h('div', { className: 'vs-row wrap' },
                      h('button', { type: 'button', className: 'vs-btn', onClick: () => moveClip(clips.findIndex((clip) => clip.id === selectedClipData.id), -1) }, '← 前移'),
                      h('button', { type: 'button', className: 'vs-btn', onClick: () => moveClip(clips.findIndex((clip) => clip.id === selectedClipData.id), 1) }, '后移 →'),
                      h('button', { type: 'button', className: 'vs-btn', onClick: splitAtPlayhead }, t('split')),
                      h('button', { type: 'button', className: 'vs-btn danger', onClick: () => removeClip(selectedClipData.id) }, t('remove'))),
                    h('div', { className: 'vs-row' },
                      h('button', { type: 'button', className: 'vs-btn', onClick: () => { seekTo(offsets[clips.findIndex((clip) => clip.id === selectedClipData.id)]?.start ?? 0); } }, '定位到此片段'),
                      h('button', { type: 'button', className: 'vs-btn', onClick: () => setSelectedClip(null) }, '取消选择')))
                  : selectedSubData
                    ? h('div', { className: 'vs-sec' },
                      h('h4', {}, `${t('subtitleProps')} ${selectedSub + 1}/${segments.length}`),
                      h('div', { className: 'vs-row' },
                        h('span', { className: 'vs-lbl' }, t('subtitleText')),
                        h('input', {
                          className: 'vs-sub-inp', value: selectedSubData.text,
                          onChange: (event) => {
                            const next = [...draft];
                            next[selectedSub] = { ...next[selectedSub], text: event.target.value };
                            setDraft(next);
                            setDirty(true);
                          },
                        })),
                      h('div', { className: 'vs-row' },
                        h('span', { className: 'vs-lbl' }, t('startTime')),
                        h('input', {
                          className: 'vs-inp num', type: 'number', step: '0.1', value: selectedSubData.start.toFixed(2),
                          onChange: (event) => {
                            const next = [...draft];
                            next[selectedSub] = { ...next[selectedSub], start: Number(event.target.value) };
                            setDraft(next);
                            setDirty(true);
                          },
                        }),
                        h('span', { className: 'vs-lbl' }, t('endTime')),
                        h('input', {
                          className: 'vs-inp num', type: 'number', step: '0.1', value: selectedSubData.end.toFixed(2),
                          onChange: (event) => {
                            const next = [...draft];
                            next[selectedSub] = { ...next[selectedSub], end: Number(event.target.value) };
                            setDraft(next);
                            setDirty(true);
                          },
                        })),
                      h('div', { className: 'vs-row wrap' },
                        h('button', { type: 'button', className: 'vs-btn', onClick: () => seekTo(selectedSubData.start) }, t('seekHere')),
                        h('button', { type: 'button', className: 'vs-btn primary', disabled: !dirty, onClick: saveSubtitles }, t('saveSubtitles')),
                        h('button', {
                          type: 'button', className: 'vs-btn danger',
                          onClick: () => {
                            setDraft(draft.filter((_item, index) => index !== selectedSub));
                            setDirty(true);
                            setSelectedSub(null);
                          },
                        }, t('remove'))))
                    : h(React.Fragment, null,
                      h('div', { className: 'vs-tabs', style: { padding: 0, marginBottom: 10 } },
                        [['subtitles', t('captions')], ['dub', t('dub')], ['export', t('export')]].map(([key, label]) =>
                          h('button', {
                            key, type: 'button', className: `vs-tab${tab === key ? ' on' : ''}`, onClick: () => setTab(key),
                          }, label))),

                      tab === 'subtitles'
                        ? h('div', { className: 'vs-sec' },
                          h('h4', {}, t('captions')),
                          h('div', { className: 'vs-row' },
                            h('span', { className: 'vs-lbl' }, t('language')),
                            h('select', { className: 'vs-sel grow', value: language, onChange: (event) => setLanguage(event.target.value) },
                              ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].map((item) => h('option', { key: item, value: item }, item)))),
                          h('div', { className: 'vs-row' },
                            h('button', {
                              type: 'button', className: 'vs-btn primary grow',
                              disabled: Boolean(busy) || !state?.tools?.ok || !speech,
                              onClick: autoSubtitles,
                            }, h(Icon.sparkle, { size: 14 }), t('autoSubtitles'))),
                          !speech
                            ? h('div', { className: 'vs-lbl' }, t('speechHint'))
                            : (!speechReady
                              ? h('div', null,
                                h('div', { className: 'vs-row' },
                                  h('button', { type: 'button', className: 'vs-btn', disabled: Boolean(busy), onClick: prepareSpeech }, h(Icon.mic, { size: 14 }), t('prepareModel')),
                                  ['checking', 'downloading', 'verifying'].includes(speech.providers?.[0]?.phase)
                                    ? h('button', { type: 'button', className: 'vs-btn danger', disabled: Boolean(busy), onClick: cancelSpeech }, '中止下载')
                                    : null,
                                  h('span', { className: 'vs-chip warn' }, speech.providers?.[0]?.phase ?? '')),
                                h('div', { className: 'vs-lbl' },
                                  (speech.providers?.[0]?.steps ?? []).map((item) => `${item.kind}${item.status === 'complete' ? '✓' : item.status === 'running' ? '…' : '·'}`).join(' ')))
                              : null),
                          h('div', { className: 'vs-row', style: { marginTop: 6 } },
                            h('span', { className: 'vs-lbl' }, `${segments.length} ${t('segments')}`),
                            h('span', { className: 'vs-spacer' }),
                            h('button', { type: 'button', className: 'vs-btn', disabled: !dirty || Boolean(busy), onClick: saveSubtitles }, t('saveSubtitles')),
                            h('a', {
                              className: 'vs-btn', href: withToken(`${API_BASE}/srt.txt?projectId=${encodeURIComponent(project.id)}`),
                              download: `${project.name}.srt`,
                            }, t('downloadSrt'))),
                          segments.length === 0
                            ? h('div', { className: 'vs-lbl' }, t('noSegments'))
                            : h('div', { className: 'vs-list' },
                              segments.map((segment, index) => h('div', {
                                key: index, className: `vs-item${index === selectedSub ? ' on' : ''}`,
                                onClick: () => setSelectedSub(index),
                              },
                              h('span', { className: 'vs-val' }, clockShort(segment.start)),
                              h('span', { className: 'nm', title: segment.text }, segment.text),
                              h('button', {
                                type: 'button', className: 'vs-btn ghost', title: t('remove'),
                                onClick: (event) => {
                                  event.stopPropagation();
                                  setDraft(draft.filter((_item, position) => position !== index));
                                  setDirty(true);
                                },
                              }, h(Icon.close, { size: 12 }))))))
                        : null,

                      tab === 'dub'
                        ? h('div', { className: 'vs-sec' },
                          h('h4', {}, t('dub')),
                          h('div', { className: 'vs-row' },
                            h('span', { className: 'vs-lbl' }, t('voice')),
                            h('select', { className: 'vs-sel grow', value: voice, onChange: (event) => setVoice(event.target.value) },
                              (state?.tts?.voices ?? []).map((item) => h('option', { key: `${item.id}-${item.locale}`, value: item.id }, `${item.label ?? item.id} · ${item.locale}`)))),
                          h('div', { className: 'vs-row' },
                            h('span', { className: 'vs-lbl' }, t('rate')),
                            h('input', { type: 'range', className: 'vs-range', min: 90, max: 320, value: rate, onChange: (event) => setRate(Number(event.target.value)) }),
                            h('span', { className: 'vs-val' }, String(rate))),
                          h('div', { className: 'vs-row' },
                            h('span', { className: 'vs-lbl' }, t('sourceMode')),
                            h('select', { className: 'vs-sel grow', value: dubMode, onChange: (event) => setDubMode(event.target.value) },
                              h('option', { value: 'segments' }, t('fromSubtitles')),
                              h('option', { value: 'narrate' }, t('fromScript')))),
                          dubMode === 'narrate'
                            ? h('textarea', { className: 'vs-area', placeholder: t('script'), value: script, onChange: (event) => setScript(event.target.value) })
                            : null,
                          h('div', { className: 'vs-row' },
                            h('button', {
                              type: 'button', className: 'vs-btn primary grow',
                              disabled: Boolean(busy) || !state?.tts?.available,
                              onClick: startDub,
                            }, h(Icon.mic, { size: 14 }), t('startDub'))),
                          !state?.tts?.available ? h('div', { className: 'vs-lbl' }, state?.tts?.message ?? '') : null,
                          dubMode === 'segments' && segments.length === 0 ? h('div', { className: 'vs-lbl' }, t('dubHint')) : null,
                          project.dub?.track
                            ? h('div', null,
                              h('div', { className: 'vs-lbl' }, t('dubTrackReady')),
                              h('audio', { controls: true, src: mediaUrl(project.dub.track), style: { width: '100%', marginTop: 4 } }))
                            : null,

                          h('h4', { style: { marginTop: 14 } }, t('bgm')),
                          h('div', { className: 'vs-row' },
                            h('select', {
                              className: 'vs-sel grow', value: audioFiles.some((file) => file.path === bgmPath) ? bgmPath : '',
                              onChange: (event) => setBgmPath(event.target.value),
                            },
                            h('option', { value: '' }, project.bgm?.path ? (project.bgm.path.split('/').pop()) : t('noBgm')),
                            audioFiles.map((file) => h('option', { key: file.path, value: file.path }, file.name)))),
                          h('div', { className: 'vs-row' },
                            h('span', { className: 'vs-lbl' }, t('bgmVolume')),
                            h('input', {
                              type: 'range', className: 'vs-range', min: 0, max: 1, step: 0.02, value: options.bgmVolume,
                              onChange: (event) => setOptions({ ...options, bgmVolume: Number(event.target.value) }),
                            }),
                            h('button', { type: 'button', className: 'vs-btn', onClick: () => setBgmPath('') }, t('clearBgm'))),

                          h('h4', { style: { marginTop: 14 } }, '混音'),
                          h('div', { className: 'vs-row' },
                            h('span', { className: 'vs-lbl' }, t('originalVolume')),
                            h('input', {
                              type: 'range', className: 'vs-range', min: 0, max: 1, step: 0.05, value: options.originalVolume,
                              onChange: (event) => setOptions({ ...options, originalVolume: Number(event.target.value) }),
                            }),
                            h('span', { className: 'vs-val' }, options.originalVolume.toFixed(2))),
                          h('label', { className: 'vs-row' },
                            h('input', {
                              type: 'checkbox', checked: options.muteOriginal,
                              onChange: (event) => setOptions({ ...options, muteOriginal: event.target.checked }),
                            }),
                            h('span', { className: 'vs-lbl' }, t('muteOriginal'))),
                          h('div', { className: 'vs-row' },
                            h('button', { type: 'button', className: 'vs-btn', onClick: saveDubSettings }, '保存配音/音乐设置')))
                        : null,

                      tab === 'export'
                        ? h('div', { className: 'vs-sec' },
                          h('h4', {}, t('exportSettings')),
                          h('label', { className: 'vs-row' },
                            h('input', { type: 'checkbox', checked: options.burnSubtitles, onChange: (event) => setOptions({ ...options, burnSubtitles: event.target.checked }) }),
                            h('span', { className: 'vs-lbl' }, t('burnSubtitles'))),
                          h('label', { className: 'vs-row' },
                            h('input', { type: 'checkbox', checked: options.includeDub, onChange: (event) => setOptions({ ...options, includeDub: event.target.checked }) }),
                            h('span', { className: 'vs-lbl' }, t('mixDub'))),
                          h('label', { className: 'vs-row' },
                            h('input', { type: 'checkbox', checked: options.includeBgm, onChange: (event) => setOptions({ ...options, includeBgm: event.target.checked }) }),
                            h('span', { className: 'vs-lbl' }, t('mixBgm'))),
                          h('div', { className: 'vs-row' },
                            h('span', { className: 'vs-lbl' }, t('quality')),
                            h('input', { type: 'range', className: 'vs-range', min: 14, max: 32, value: options.crf, onChange: (event) => setOptions({ ...options, crf: Number(event.target.value) }) }),
                            h('span', { className: 'vs-val' }, `CRF ${options.crf}`)),
                          h('div', { className: 'vs-row' },
                            h('button', {
                              type: 'button', className: 'vs-btn primary grow',
                              disabled: Boolean(busy) || !state?.tools?.ok || clips.length === 0,
                              onClick: startRender,
                            }, h(Icon.download, { size: 14 }), t('startRender'))),

                          h('h4', { style: { marginTop: 14 } }, t('renders')),
                          (project.renders ?? []).length === 0
                            ? h('div', { className: 'vs-lbl' }, t('noRenders'))
                            : h('div', { className: 'vs-list' },
                              project.renders.map((render) => h('div', { key: render.id, className: 'vs-item' },
                                h('span', { className: 'nm', title: render.file }, render.file.split('/').pop()),
                                h('span', { className: 'vs-val' }, clockShort(render.duration)),
                                h(IconBtn, {
                                  icon: Icon.play, title: t('playRender'),
                                  onClick: () => { setPreviewRender(render.file); setPreviewMode('render'); },
                                }),
                                h('a', { className: 'vs-ico', href: mediaUrl(render.file), download: render.file.split('/').pop(), title: t('download') }, h(Icon.download, { size: 15 })),
                                h(IconBtn, { icon: Icon.copy, title: t('copyToWorkspace'), onClick: () => copyRender(render.file) })))))
                        : null),

                h('div', { className: 'vs-sec' },
                  h('h4', {}, t('jobs')),
                  jobs.length === 0
                    ? h('div', { className: 'vs-lbl' }, t('noJobs'))
                    : h('div', { className: 'vs-list' },
                      jobs.slice(0, 6).map((job) => h('div', { key: job.id, className: 'vs-item', style: { flexDirection: 'column', alignItems: 'stretch' } },
                        h('div', { className: 'vs-row', style: { margin: 0 } },
                          h('span', { className: 'nm' }, `${job.kind === 'render' ? '渲染' : job.kind === 'dub' ? '配音' : '字幕'} · ${job.message || ''}`),
                          h('span', { className: `vs-chip ${job.status === 'done' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn'}` },
                            job.status === 'running' ? `${Math.round((job.progress ?? 0) * 100)}%` : job.status)),
                        job.status === 'running' ? h('div', { className: 'vs-bar' }, h('i', { style: { width: `${Math.round((job.progress ?? 0) * 100)}%` } })) : null,
                        job.status === 'failed' ? h('div', { className: 'vs-lbl', style: { color: 'var(--danger)' } }, String(job.error).slice(0, 120)) : null)))),
              ))),
        // ---------------------------------------------------------------- timeline（通栏）
        h('div', { className: 'vs-tl' },
          h('div', { className: 'vs-tl-bar' },
            h('span', { className: 'vs-lbl' }, t('timeline')),
            h('button', { type: 'button', className: 'vs-btn', disabled: clips.length === 0, onClick: splitAtPlayhead }, h(Icon.scissors, { size: 14 }), t('split')),
            h('button', { type: 'button', className: 'vs-btn', disabled: !selectedClip, onClick: mergeSelected }, h(Icon.merge, { size: 14 }), t('merge')),
            h('button', { type: 'button', className: 'vs-btn danger', disabled: !selectedClip, onClick: () => removeClip(selectedClip) }, h(Icon.trash, { size: 14 }), t('remove')),
            h('button', { type: 'button', className: 'vs-btn', onClick: () => addSubtitleAt(playhead) }, h(Icon.captions, { size: 14 }), t('addText')),
            h('span', { style: { width: 1, height: 18, background: 'var(--line)' } }),
            h('button', {
              type: 'button', className: 'vs-btn', title: `${t('undo')} ⌘Z`,
              disabled: Boolean(busy) || !(state?.history?.past > 0), onClick: undoProject,
            }, '↶'),
            h('button', {
              type: 'button', className: 'vs-btn', title: `${t('redo')} ⇧⌘Z`,
              disabled: Boolean(busy) || !(state?.history?.future > 0), onClick: redoProject,
            }, '↷'),
            h('span', { className: 'vs-spacer' }),
            h(IconBtn, { icon: Icon.zoomOut, title: t('zoom'), onClick: () => setZoom(clamp(pxPerSec / 1.4, 6, 400)) }),
            h('input', {
              type: 'range', className: 'vs-range', style: { maxWidth: 150 }, min: 6, max: 400, value: Math.round(pxPerSec),
              onChange: (event) => setZoom(Number(event.target.value)),
            }),
            h(IconBtn, { icon: Icon.zoomIn, title: t('zoom'), onClick: () => setZoom(clamp(pxPerSec * 1.4, 6, 400)) }),
            h('button', { type: 'button', className: 'vs-btn ghost', onClick: () => setZoom(null) }, '适配'),
          ),
          h('div', { className: 'vs-tl-body' },
            h('div', { className: 'vs-heads' },
              h('div', { className: 'rulerpad' }),
              h('div', { className: 'vs-head v1' }, h(Icon.film, { size: 12 }), t('videoTrack')),
              h('div', { className: 'vs-head a1' }, h(Icon.music, { size: 12 }), t('audioTrack')),
              h('div', { className: 'vs-head t1' }, h(Icon.captions, { size: 12 }), t('subtitleTrack'))),
            h('div', { className: 'vs-scroll', ref: scrollRef },
              h('div', { className: 'vs-content', ref: contentRef, style: { width: contentWidth } },
                h('div', { className: 'vs-ruler', onPointerDown: scrub },
                  ticks.map((tick) => h('div', { key: tick.time, className: 'vs-tick major', style: { left: tick.time * pxPerSec } },
                    h('span', {}, clockShort(tick.time))))),

                h('div', { className: 'vs-track v1', onPointerDown: (event) => { if (event.target === event.currentTarget) scrub(event); } },
                  clips.map((clip, index) => {
                    const box = clipBox(clip, index);
                    return h('div', {
                      key: clip.id,
                      className: `vs-clip${clip.id === selectedClip ? ' on' : ''}`,
                      style: {
                        left: box.start * pxPerSec,
                        width: box.width,
                        backgroundImage: clip.strip ? `url(${mediaUrl(clip.strip)})` : (clip.poster ? `url(${mediaUrl(clip.poster)})` : undefined),
                      },
                      title: `${clip.name}\n${box.inPoint.toFixed(2)}s → ${box.outPoint.toFixed(2)}s`,
                      onClick: (event) => { event.stopPropagation(); setSelectedClip(clip.id); setClipIndex(index); },
                    },
                    h('div', { className: 'vs-handle l', onPointerDown: (event) => trim(event, clip, 'in') }),
                    h('div', { className: 'vs-handle r', onPointerDown: (event) => trim(event, clip, 'out') }),
                    !clip.hasAudio ? h('span', { className: 'noaudio' }, '🔇') : null,
                    h('div', { className: 'tag' }, `${index + 1}. ${clip.name}`));
                  })),

                h('div', { className: 'vs-track a1', onPointerDown: (event) => { if (event.target === event.currentTarget) scrub(event); } },
                  clips.map((clip, index) => {
                    const box = clipBox(clip, index);
                    return h('div', {
                      key: clip.id,
                      className: `vs-aud${clip.waveform ? '' : ' dim'}`,
                      style: {
                        left: box.start * pxPerSec,
                        width: box.width,
                        backgroundImage: clip.waveform ? `url(${mediaUrl(clip.waveform)})` : undefined,
                      },
                      title: clip.hasAudio ? '原始音频' : '无音轨',
                    });
                  })),

                h('div', { className: 'vs-track t1', onPointerDown: (event) => { if (event.target === event.currentTarget) scrub(event); } },
                  segments.map((segment, index) => h('div', {
                    key: index,
                    className: `vs-sub${index === selectedSub ? ' on' : ''}`,
                    style: { left: segment.start * pxPerSec, width: Math.max(16, (segment.end - segment.start) * pxPerSec) },
                    title: `${segment.text}\n${clock(segment.start)} → ${clock(segment.end)}\n拖动可移动，拖两端可改时长（自动吸附）`,
                    onPointerDown: (ev) => { setSelectedSub(index); dragSubtitle(ev, index, 'move'); },
                    onClick: (event) => { event.stopPropagation(); setPreviewMode('timeline'); seekTo(segment.start); },
                  },
                  index === selectedSub
                    ? h('div', { className: 'vs-subhandle l', onPointerDown: (ev) => { ev.stopPropagation(); dragSubtitle(ev, index, 'start'); } })
                    : null,
                  segment.text,
                  index === selectedSub
                    ? h('div', { className: 'vs-subhandle r', onPointerDown: (ev) => { ev.stopPropagation(); dragSubtitle(ev, index, 'end'); } })
                    : null))),

                clips.length === 0
                  ? h('div', { className: 'vs-tl-empty' }, t('emptyTrack'))
                  : null,
                segments.length === 0 && clips.length > 0
                  ? h('div', { className: 'vs-tl-empty', style: { top: 108 } }, t('emptySubtitles'))
                  : null,
                snapLine !== null
                  ? h('div', { className: 'vs-snapline', style: { left: snapLine * pxPerSec } })
                  : null,
                h('div', { className: 'vs-playline', style: { left: playhead * pxPerSec } }),
                h('div', { className: 'vs-playhandle', style: { left: playhead * pxPerSec } }),
              ))),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Visible text goes through the host locale service when available.
        try {
          if (typeof ctx?.locale?.register === 'function') {
            ctx.locale.register(NS, { zh: T, en: T_EN });
            const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null;
            if (typeof bound === 'function') translate = (key) => bound(key) ?? T[key] ?? key;
          }
        } catch (error) {
          console.warn('[video-studio] locale 注册失败，使用内置文案', error);
        }
        try {
          ctx.effect(() => {
            const style = document.createElement('style');
            style.setAttribute('data-plugin', NS);
            style.textContent = css;
            document.head.appendChild(style);
            return () => style.remove();
          });
        } catch (error) {
          console.warn('[video-studio] 样式注入失败', error);
        }
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'video-studio',
            order: 20,
            label: () => T.app,
          }, PanelIcon));
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'video-studio',
          }, Panel));
        } catch (error) {
          console.error('[video-studio] 面板注册失败', error);
        }
      },
    };
  },
});
