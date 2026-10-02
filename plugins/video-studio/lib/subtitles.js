/**
 * Subtitle segmentation and SRT/ASS serialization.
 *
 * Subtitle lines are derived from recognized text plus the speech intervals the
 * recognizer ran on, so a line always lands on real speech rather than on a
 * uniform split of the whole clip.
 */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
const FALLBACK_FONT = 'PingFang SC';

/** Weight one character for line-length planning: CJK counts 1, latin 0.5. */
export function charWeight(text) {
  let weight = 0;
  for (const char of String(text)) weight += CJK.test(char) ? 1 : 0.5;
  return weight;
}

/** Collapse whitespace and drop characters that would break ASS event text. */
export function cleanSubtitleText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[{}]/g, (match) => (match === '{' ? '（' : '）'))
    .trim();
}

/** Split into sentence-ish pieces, keeping terminal punctuation attached. */
function sentencePieces(text) {
  const pieces = [];
  let buffer = '';
  for (const char of text) {
    buffer += char;
    if ('。！？!?；;…'.includes(char)) {
      pieces.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) pieces.push(buffer.trim());
  return pieces;
}

/** Split one over-long piece on soft punctuation so lines stay readable. */
function splitLongPiece(piece, maxWeight) {
  if (charWeight(piece) <= maxWeight) return [piece];
  const parts = [];
  let buffer = '';
  for (const char of piece) {
    buffer += char;
    if ('，,、：:）)】」'.includes(char) && charWeight(buffer) >= maxWeight * 0.55) {
      parts.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) parts.push(buffer.trim());
  return parts;
}

/**
 * Group recognized text into display lines bounded by a weight budget.
 *
 * Each sentence keeps its own line: subtitles are read one line at a time, and
 * merging two complete sentences produces a card the viewer cannot finish.
 * Unpunctuated output (some recognizers) is still split by the weight budget.
 * @returns {string[]} display lines.
 */
export function planLines(text, options = {}) {
  const maxWeight = options.maxWeight ?? 18;
  const raw = cleanSubtitleText(text);
  if (!raw) return [];
  const lines = [];
  for (const piece of sentencePieces(raw)) {
    for (const part of splitLongPiece(piece, maxWeight)) {
      if (part) lines.push(part);
    }
  }
  return lines;
}

/**
 * Map a cumulative-speech-time position back to wall-clock time inside a chunk.
 * Speech intervals are the only places words exist, so time is distributed
 * across them in order instead of across the chunk's full span.
 */
function makeTimeMapper(intervals) {
  const spans = intervals.map((span) => ({
    start: span.start,
    end: span.end,
    speech: Math.max(0, span.end - span.start),
  }));
  const totalSpeech = spans.reduce((sum, span) => sum + span.speech, 0);
  return (speechTime) => {
    if (totalSpeech <= 0) return spans[0]?.start ?? 0;
    const target = Math.max(0, Math.min(speechTime, totalSpeech));
    let consumed = 0;
    for (const span of spans) {
      if (consumed + span.speech >= target) {
        return span.start + (target - consumed);
      }
      consumed += span.speech;
    }
    return spans[spans.length - 1]?.end ?? 0;
  };
}

/**
 * Turn one recognized chunk into timed subtitle segments.
 * @param {{ text: string, offset: number, intervals: Array<{start:number,end:number}> }} input
 * @returns {Array<{start:number,end:number,text:string}>}
 */
export function segmentsFromChunk(input) {
  const { text, offset, intervals } = input;
  const lines = planLines(text);
  if (lines.length === 0 || intervals.length === 0) return [];
  const weights = lines.map((line) => Math.max(1, charWeight(line)));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const totalSpeech = intervals.reduce((sum, span) => sum + Math.max(0, span.end - span.start), 0);
  const map = makeTimeMapper(intervals);
  const segments = [];
  let consumedWeight = 0;
  for (const [index, line] of lines.entries()) {
    const from = (consumedWeight / totalWeight) * totalSpeech;
    consumedWeight += weights[index];
    const to = (consumedWeight / totalWeight) * totalSpeech;
    let start = offset + map(from);
    let end = offset + map(to);
    if (segments.length > 0) start = Math.max(start, segments[segments.length - 1].end);
    end = Math.max(end, start + 0.7);
    segments.push({
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      text: line,
    });
  }
  // Keep the last line from running past the speech it came from.
  const lastSpan = intervals[intervals.length - 1];
  const limit = offset + lastSpan.end + 0.6;
  const last = segments[segments.length - 1];
  if (last && last.end > limit) last.end = Math.round(Math.max(last.start + 0.4, limit) * 1000) / 1000;
  return segments;
}

/** srt timestamp: 00:00:01,250 */
export function srtTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total - hours * 3600) / 60);
  const secs = Math.floor(total - hours * 3600 - minutes * 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** ass timestamp: 0:00:01.25 */
export function assTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total - hours * 3600) / 60);
  const secs = total - hours * 3600 - minutes * 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
}

/** Serialize segments as SubRip. */
export function toSrt(segments) {
  return `${segments
    .map((segment, index) =>
      `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${cleanSubtitleText(segment.text)}\n`)
    .join('\n')}`;
}

/** #RRGGBB to ASS &HAABBGGRR (opaque). */
export function assColor(hex, alpha = '00') {
  const value = String(hex ?? '#ffffff').replace('#', '').slice(0, 6).padEnd(6, 'f');
  const r = value.slice(0, 2);
  const g = value.slice(2, 4);
  const b = value.slice(4, 6);
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

/**
 * Serialize an ASS script. The script carries its own style, so the ffmpeg
 * `subtitles=` filter needs no force_style argument.
 * @param {Array<{start:number,end:number,text:string}>} segments
 * @param {{width:number,height:number,style?:object}} options
 */
export function toAss(segments, options) {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const style = options.style ?? {};
  const fontSize = Math.round(Number(style.fontSize) || height * 0.055);
  const marginV = Math.round(Number(style.marginV) || height * 0.055);
  const outline = Number(style.outline ?? 2.4);
  const shadow = Number(style.shadow ?? 0);
  const font = style.fontFamily || FALLBACK_FONT;
  const alignment = Number(style.alignment) || 2;
  const primary = assColor(style.color ?? '#ffffff');
  const outlineColor = assColor(style.outlineColor ?? '#000000');
  const backColor = assColor('#000000', '80');
  const marginH = Math.round(width * 0.06);
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${fontSize},${primary},${primary},${outlineColor},${backColor},0,0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = segments.map((segment) => {
    const text = cleanSubtitleText(segment.text).replace(/\r?\n/g, '\\N');
    return `Dialogue: 0,${assTime(segment.start)},${assTime(segment.end)},Default,,0,0,0,,${text}`;
  });
  return `${[...header, ...events].join('\n')}\n`;
}

/**
 * Re-time free text onto a media duration when no speech intervals exist
 * (for example a narration script read over silent footage).
 */
export function segmentsFromScript(text, duration, options = {}) {
  const lines = planLines(text, options);
  if (lines.length === 0) return [];
  const weights = lines.map((line) => Math.max(1, charWeight(line)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const segments = [];
  let cursor = 0;
  for (const [index, line] of lines.entries()) {
    const span = (weights[index] / total) * Math.max(0.5, duration);
    const start = cursor;
    const end = Math.min(duration, start + span);
    segments.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: line });
    cursor = end;
  }
  return segments;
}
