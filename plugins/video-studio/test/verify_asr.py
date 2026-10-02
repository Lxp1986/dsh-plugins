#!/usr/bin/env python3
"""
Real end-to-end verification through the running plugin's HTTP surface:
import real Chinese speech -> auto subtitles with the local SenseVoice model ->
auto dubbing -> export with burned subtitles, then check the artifacts.

Run after the speech model reports ready:
    python3 test/verify_asr.py
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

BASE = os.environ.get('VIDEO_STUDIO_BASE', 'http://127.0.0.1:19387/video-studio/api')
DEMO = os.environ.get('VIDEO_STUDIO_DEMO', os.path.expanduser('~/Movies/dsh-demo'))
EXPECTED = [
    '欢迎使用视频剪辑插件，这是自动字幕测试。',
    '第二句话用来验证时间轴对齐是否准确。',
    '最后一句用于检查自动配音和渲染导出。',
]

failures = []


def call(path, body=None, method=None, raw=None, headers=None, timeout=180):
    url = f'{BASE}{path}'
    data = None
    hdrs = dict(headers or {})
    if raw is not None:
        data = raw
    elif body is not None:
        data = json.dumps(body).encode()
        hdrs['content-type'] = 'application/json'
    request = urllib.request.Request(url, data=data, method=method or ('POST' if data is not None else 'GET'), headers=hdrs)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode() or '{}')


def check(name, condition, detail=''):
    if condition:
        print(f'  ✓ {name}' + (f'  {detail}' if detail else ''))
    else:
        failures.append(name)
        print(f'  ✗ {name}  {detail}')


def wait_job(job_id, timeout=900):
    started = time.time()
    last = ''
    while time.time() - started < timeout:
        job = call(f'/job?id={job_id}')['job']
        line = f"{job['status']} {int(job['progress'] * 100)}% {job.get('message') or ''}"
        if line != last:
            print(f"      {line}", flush=True)
            last = line
        if job['status'] != 'running':
            return job
        time.sleep(3)
    raise SystemExit('job timeout')


def probe(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
        capture_output=True, text=True,
    ).stdout
    return json.loads(out)


def normalize(text):
    return re.sub(r'[^\u4e00-\u9fffA-Za-z0-9]', '', text)


def similarity(a, b):
    a, b = normalize(a), normalize(b)
    if not a or not b:
        return 0.0
    common = sum(1 for ch in a if ch in b)
    return common / max(len(a), len(b))


print('=== 语音服务状态 ===')
state = call('/state')
speech = state['speech']
provider = speech['providers'][0]
print(f"  provider={provider['id']} phase={provider['phase']} ready={speech['ready']}")
if not speech['ready']:
    print('  模型尚未就绪，先运行 /api/speech/prepare 并等待。')
    call('/speech/prepare', {})
    for _ in range(200):
        state = call('/state')
        speech = state['speech']
        provider = speech['providers'][0]
        steps = ','.join(f"{s['kind']}:{s['status']}" for s in (provider.get('steps') or []))
        print(f"    phase={provider['phase']} {steps}", flush=True)
        if speech['ready'] or provider['phase'] == 'failed':
            break
        time.sleep(15)
    if not speech['ready']:
        raise SystemExit(f"模型未就绪：{provider['phase']} {provider.get('message')}")
check('语音模型就绪', speech['ready'], provider['phase'])

print('=== 新建项目并导入真实中文语音素材 ===')
project = call('/project/create', {'name': '自动字幕验证', 'preset': 'landscape'})['project']
pid = project['id']
imported = call('/import', {'projectId': pid, 'paths': [f'{DEMO}/speech.mp4', f'{DEMO}/broll.mp4']})
check('导入素材', len(imported['added']) == 2, str([c['name'] for c in imported['added']]))
check('生成胶片缩略条', all(c['strip'] for c in imported['added']), str([bool(c['strip']) for c in imported['added']]))
check('生成音频波形', bool(imported['added'][0]['waveform']))

print('=== 自动字幕（真实 SenseVoice 识别）===')
job = wait_job(call('/subtitles/auto', {'projectId': pid, 'language': 'zh'})['job']['id'])
check('识别任务完成', job['status'] == 'done', str(job.get('error') or job.get('result')))
segments = call(f'/state?projectId={pid}')['project']['subtitles']['segments']
print('  识别结果：')
for segment in segments:
    print(f"    [{segment['start']:6.2f} → {segment['end']:6.2f}] {segment['text']}")
check('识别出至少 3 条字幕', len(segments) >= 3, f'{len(segments)} 条')

joined = ''.join(segment['text'] for segment in segments)
for index, expected in enumerate(EXPECTED):
    score = max((similarity(segment['text'], expected) for segment in segments), default=0.0)
    check(f'第 {index + 1} 句识别正确', score >= 0.7, f'相似度 {score:.2f}')

# timing sanity: speech starts after the 0.8 s leading silence
if segments:
    check('首条字幕落在语音起点附近', 0.4 <= segments[0]['start'] <= 2.0, f"start={segments[0]['start']}")
    check('字幕时间单调递增', all(
        segments[i]['end'] <= segments[i + 1]['start'] + 0.6 for i in range(len(segments) - 1)
    ))

print('=== 自动配音 ===')
job = wait_job(call('/dub/start', {'projectId': pid, 'voice': 'Tingting', 'rate': 180, 'mode': 'segments'})['job']['id'])
check('配音任务完成', job['status'] == 'done', str(job.get('error') or job.get('result')))
detail = call(f'/state?projectId={pid}')['project']
check('生成配音轨', bool(detail['dub'].get('track')) and os.path.exists(detail['dub']['track']))
check('逐句配音音频齐全', all(os.path.exists(s['file']) for s in detail['dub']['segments']),
      f"{len(detail['dub']['segments'])} 句")

print('=== 导出（烧字幕 + 混配音）===')
job = wait_job(call('/render/start', {
    'projectId': pid,
    'options': {'burnSubtitles': True, 'includeDub': True, 'originalVolume': 0.2, 'crf': 24, 'preset': 'veryfast'},
})['job']['id'])
check('渲染任务完成', job['status'] == 'done', str(job.get('error') or job.get('result')))
output = job['result']['file']
info = probe(output)
video = next(s for s in info['streams'] if s['codec_type'] == 'video')
audio = [s for s in info['streams'] if s['codec_type'] == 'audio']
total = sum(c['out'] - c['in'] for c in call(f'/state?projectId={pid}')['project']['clips'])
duration = float(info['format']['duration'])
check('成片分辨率正确', (video['width'], video['height']) == (1920, 1080), f"{video['width']}x{video['height']}")
check('成片含音轨', len(audio) == 1)
check('成片时长与时间线一致', abs(duration - total) < 1.0, f'{duration:.2f}s vs {total:.2f}s')

frame = '/tmp/asr_verify_frame.png'
# pick the middle of the second recognized line so a subtitle must be visible
target = segments[1]['start'] + 0.4 if len(segments) > 1 else 2.0
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(target), '-i', output, '-frames:v', '1', frame], check=True)
check('导出字幕帧', os.path.exists(frame), frame)

print()
if failures:
    print(f'✗ {len(failures)} 项失败：{failures}')
    sys.exit(1)
print('✅ 真实语音识别 + 配音 + 导出 全链路验证通过')
print(f'   成片：{output}')
print(f'   字幕帧：{frame}')
