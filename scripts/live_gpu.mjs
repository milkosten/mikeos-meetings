// Live check of the two GPU services from inside the container network:  node scripts/live_gpu.mjs <audio-file>
import { cutPieces, whisper, qwenJson, maxVolume } from '../lib/pipeline.js';
const file = process.argv[2];
const t0 = Date.now();
const pieces = await cutPieces(file, '/tmp/livegpu');
console.log('pieces', pieces.length, 'max volume', await maxVolume(pieces[0].file));
const r = await whisper(pieces[0].file, '', { url: process.env.STT_URL, token: process.env.GPU_OSMIKE_TOKEN });
console.log('stt', r.language, r.segments.length, 'segments in', Date.now() - t0, 'ms:', r.segments.map((s) => s.text).join(' ').slice(0, 200));
const t1 = Date.now();
const j = await qwenJson([{ role: 'system', content: 'Return ONLY JSON {"overview": "...", "decisions": ["..."]}. Write in Swedish.' },
  { role: 'user', content: 'Transcript:\n[00:00:01] Anna: ' + r.segments.map((s) => s.text).join(' ') }],
  { url: process.env.LLM_URL, token: process.env.GPU_OSMIKE_TOKEN, model: process.env.LLM_MODEL });
console.log('qwen in', Date.now() - t1, 'ms:', JSON.stringify(j).slice(0, 400));
