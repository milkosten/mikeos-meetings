// After a meeting: audio -> transcript (Whisper large-v3-turbo on the Kittelfjäll GPU) -> summary (Qwen on the same GPU).
// Everything stays on OsMike machines; nothing goes to an outside AI service.
//
// Audio: every person's browser records ONLY their own microphone (echo-cancelled), so each audio segment has one
// speaker and the transcript gets exact speaker labels. Segments are cut into <=150 s WAV pieces (the speech server
// takes 25 MB / 180 s per request, one job at a time, 429 = wait for your turn). Silent pieces are skipped (Whisper
// invents text on silence). Language: detected per piece, then the meeting's main language (by speech time) is used
// for every piece, so a short "ok" does not flip the language.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const PIECE_SECONDS = 150;
const SILENT_DB = -45;            // max_volume below this = nobody spoke in the piece
// Whisper's well-known inventions on silence/noise (Swedish subtitle credits, YouTube outros).
const HALLUCINATION = /^(tack för att (ni|du) (tittade|lyssnade)[.!]*|(svensk)?textning\b.*|undertext(er|ning)?\b.*|thanks? for watching[.!]*|thank you for watching[.!]*|subtitles? by[^.]*|you|\.+|…)$/i;

export function run(cmd, args, { timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeout);
    p.stdout.on('data', (d) => { out += d; if (out.length > 1e6) out = out.slice(-1e6); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 1e6) err = err.slice(-1e6); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exit ${code}: ${err.slice(-400)}`)); });
  });
}

// One recorded segment (webm/opus) -> 16 kHz mono WAV pieces of <= PIECE_SECONDS. Returns [{file, offset}].
export async function cutPieces(src, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const base = path.join(workDir, path.basename(src).replace(/\.[^.]+$/, ''));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-ac', '1', '-ar', '16000',
    '-f', 'segment', '-segment_time', String(PIECE_SECONDS), '-reset_timestamps', '1', `${base}-%03d.wav`]);
  return fs.readdirSync(workDir).filter((f) => f.startsWith(path.basename(base) + '-') && f.endsWith('.wav')).sort()
    .map((f, i) => ({ file: path.join(workDir, f), offset: i * PIECE_SECONDS }));
}

export async function maxVolume(file) {
  const { err } = await run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = err.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  if (!m) return null;
  return m[1] === '-inf' ? -200 : parseFloat(m[1]);
}

export function wavSeconds(file) {
  try { return Math.max(0, (fs.statSync(file).size - 44) / 32000); } catch { return 0; }
}

// Speech to text, waiting our turn on the shared GPU. Returns {language, segments:[{start,end,text}]}.
export async function whisper(file, language, { url, token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), prompt } = {}) {
  const buf = fs.readFileSync(file);
  let lastErr = '';
  for (let attempt = 0; attempt < 60; attempt++) {
    const fd = new FormData();
    fd.append('model', 'large-v3-turbo');
    fd.append('response_format', 'verbose_json');
    if (language) fd.append('language', language);
    if (prompt) fd.append('prompt', prompt.slice(0, 200));
    fd.append('file', new Blob([buf], { type: 'audio/wav' }), path.basename(file));
    let r;
    try {
      r = await fetchImpl(`${url}/v1/audio/transcriptions`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(300_000) });
    } catch (e) { lastErr = e.message; await sleep(5000); continue; }
    if (r.status === 429 || r.status === 503 || r.status === 502) {
      lastErr = `busy ${r.status}`;
      await sleep(Math.min(15, parseFloat(r.headers.get('retry-after')) || 4) * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`speech to text answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return { language: j.language || language || '', segments: (j.segments || []).map((s) => ({ start: +s.start || 0, end: +s.end || 0, text: String(s.text || '').trim() })) };
  }
  throw new Error(`speech to text stayed busy (${lastErr})`);
}

export function cleanSegments(segs) {
  return segs.filter((s) => s.text && !HALLUCINATION.test(s.text.trim()));
}

// Pick the meeting language: most speech time among sv/en; anything else -> the detected majority anyway.
export function mainLanguage(results) {
  const t = {};
  for (const r of results) {
    if (!r.language) continue;
    const secs = r.segments.reduce((a, s) => a + Math.max(0, s.end - s.start), 0);
    t[r.language] = (t[r.language] || 0) + secs;
  }
  const best = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : '';
}

// Lines from all speakers on one time line; consecutive lines of the same speaker (gap < 2.5 s) are joined.
export function buildTranscript(pieces) {
  const lines = [];
  for (const p of pieces) {
    for (const s of p.segments) {
      lines.push({ at: Math.round(p.t0 + (p.offset + s.start) * 1000), end: Math.round(p.t0 + (p.offset + s.end) * 1000), speaker: p.speaker, sub: p.sub || null, text: s.text });
    }
  }
  lines.sort((a, b) => a.at - b.at);
  const out = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && prev.speaker === l.speaker && l.at - prev.end < 2500 && prev.text.length < 900) {
      prev.text = `${prev.text} ${l.text}`; prev.end = Math.max(prev.end, l.end);
    } else out.push({ ...l });
  }
  return out;
}

const hms = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
export function transcriptText(m) {
  return (m.transcript || []).map((l) => `[${hms(l.at - m.started_at)}] ${l.speaker}: ${l.text}`).join('\n');
}

// ---- summary (Qwen on gpu.osmike.com, native /api/chat so num_ctx is honoured; Ollama otherwise cuts at 4096) ----
const LANG_NAME = { sv: 'Swedish', en: 'English' };
function sysPrompt(lang, people) {
  const L = LANG_NAME[lang] || 'the same language as the transcript';
  return `You write meeting notes from a transcript. Write EVERYTHING in ${L}.
People in the meeting: ${people.join(', ') || 'unknown'}.
Return ONLY a JSON object: {"overview": "2-4 sentences: what the meeting was about and how it ended",
"key_points": ["..."], "decisions": ["..."], "action_items": [{"owner": "a person's name from the list or \\"\\"", "task": "...", "due": "only if a date or day was said, else \\"\\""}]}.
Use only what was said. No invented facts, names or dates. Empty lists are fine. The transcript comes from speech recognition, so fix obvious mishearings silently.`;
}

export async function qwenJson(messages, { url, token, model, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetchImpl(`${url}/api/chat`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, think: false, format: 'json', keep_alive: '10m',
          options: { num_ctx: 12288, num_predict: 2500, temperature: 0.3 } }),
        signal: AbortSignal.timeout(420_000),
      });
      if (!r.ok) { lastErr = `qwen ${r.status}`; await sleep(8000 * (attempt + 1)); continue; }
      const j = await r.json();
      const text = String(j.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      const start = text.indexOf('{'), end = text.lastIndexOf('}');
      if (start < 0 || end <= start) { lastErr = 'no JSON in answer'; continue; }
      return JSON.parse(text.slice(start, end + 1));
    } catch (e) { lastErr = e.message; await sleep(5000); }
  }
  throw new Error(`summary failed (${lastErr})`);
}

export function normSummary(j) {
  const arr = (v) => (Array.isArray(v) ? v : []).map((x) => (typeof x === 'string' ? x : x?.text || x?.point || '')).map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
  const items = (Array.isArray(j?.action_items) ? j.action_items : []).map((a) => (typeof a === 'string' ? { owner: '', task: a, due: '' }
    : { owner: String(a?.owner || '').trim().slice(0, 80), task: String(a?.task || a?.text || '').trim().slice(0, 400), due: String(a?.due || '').trim().slice(0, 60) }))
    .filter((a) => a.task).slice(0, 30);
  return { overview: String(j?.overview || '').trim().slice(0, 2000), key_points: arr(j?.key_points), decisions: arr(j?.decisions), action_items: items };
}

const CHUNK_CHARS = 18000;   // ~5-6k tokens: fits num_ctx 12288 with the answer
export async function summarize(m, llm) {
  const text = transcriptText(m);
  const words = text.split(/\s+/).filter(Boolean).length;
  const lang = m.language;
  if (words < 25) {
    return { overview: lang === 'sv' ? 'För lite sades för att sammanfatta.' : 'Too little was said to summarise.', key_points: [], decisions: [], action_items: [], short: true };
  }
  const people = [...new Set((m.participants || []).map((p) => p.name))];
  const sys = sysPrompt(lang, people);
  if (text.length <= CHUNK_CHARS) {
    return normSummary(await llm([{ role: 'system', content: sys }, { role: 'user', content: `Transcript:\n${text}` }]));
  }
  // Long meeting: notes per part, then one set of notes from the parts.
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length > CHUNK_CHARS && cur) { parts.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur) parts.push(cur);
  const notes = [];
  for (let i = 0; i < parts.length; i++) {
    notes.push(normSummary(await llm([{ role: 'system', content: sys }, { role: 'user', content: `Part ${i + 1} of ${parts.length} of the transcript:\n${parts[i]}` }])));
  }
  const merged = JSON.stringify(notes).slice(0, CHUNK_CHARS * 1.3);
  return normSummary(await llm([{ role: 'system', content: sys },
    { role: 'user', content: `These are notes from the ${parts.length} parts of one meeting, in order. Combine them into ONE set of notes for the whole meeting (remove repeats; keep every decision and action item):\n${merged}` }]));
}

// ---- the whole job for one meeting ----
export async function processMeeting(store, m, deps) {
  const { stt, llm, log = () => {} } = deps;
  const work = path.join(store.meetingDir(m.id), 'work');
  fs.rmSync(work, { recursive: true, force: true });
  m.status = 'processing'; m.stage = 'transcribing'; m.error = null; store.saveMeeting(m);
  const pieces = [];
  for (const seg of m.segments || []) {
    const src = path.join(store.audioDir(m.id), `${seg.id}.webm`);
    if (!fs.existsSync(src) || fs.statSync(src).size < 2000) continue;
    let cut;
    try { cut = await cutPieces(src, work); } catch (e) { log(`segment ${seg.id}: ${e.message}`); continue; }
    for (const c of cut) {
      const vol = await maxVolume(c.file).catch(() => null);
      if (vol !== null && vol < SILENT_DB) continue;
      pieces.push({ ...c, t0: seg.started_at, speaker: seg.name, sub: seg.sub, seconds: wavSeconds(c.file) });
    }
  }
  const forced = ['sv', 'en'].includes(m.language_hint) ? m.language_hint : '';
  for (const p of pieces) {
    const r = await stt(p.file, forced);
    p.language = r.language; p.segments = cleanSegments(r.segments);
  }
  let lang = forced || mainLanguage(pieces);
  if (!['sv', 'en'].includes(lang)) lang = lang || 'sv';
  for (const p of pieces) {
    if (p.language && p.language !== lang && p.seconds > 0) {   // re-read in the meeting's language
      const r = await stt(p.file, lang);
      p.segments = cleanSegments(r.segments);
    }
  }
  m.language = lang;
  m.transcript = buildTranscript(pieces);
  m.stage = 'summarizing'; store.saveMeeting(m);
  m.summary = await summarize(m, llm);
  m.status = 'done'; m.stage = null; m.processed_at = Date.now();
  fs.rmSync(work, { recursive: true, force: true });
  store.saveMeeting(m);
  return m;
}
