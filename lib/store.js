// Small JSON-file store on the 242 RAID6 (/data inside the container = /data/meetings on the host).
//   sessions.json            browser sessions (ids stored hashed) + the person's account tokens
//   rooms.json               room id -> who made it (host) + when
//   meetings/<id>/meeting.json   one meeting: people, audio segments, transcript, summary
//   meetings/<id>/audio/<seg>.webm  each person's own microphone, recorded in their browser
// Writes are atomic (temp file + rename). One process owns the directory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const digest = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const rid = (n = 12) => crypto.randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, n) || crypto.randomBytes(n).toString('hex').slice(0, n);

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'meetings'), { recursive: true, mode: 0o700 });
    this.sessionsFile = path.join(dir, 'sessions.json');
    this.roomsFile = path.join(dir, 'rooms.json');
    this.sessions = readJson(this.sessionsFile, {});
    this.rooms = readJson(this.roomsFile, {});
    this.cache = new Map(); // meeting id -> object (all meetings are small JSON; audio stays on disk)
    for (const id of fs.readdirSync(path.join(dir, 'meetings'))) {
      const m = readJson(this.meetingFile(id), null);
      if (m && m.id === id) this.cache.set(id, m);
    }
    this._saveTimer = null;
  }

  // ---- sessions ----
  saveSessions() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => writeJson(this.sessionsFile, this.sessions), 200);
  }
  flush() { clearTimeout(this._saveTimer); writeJson(this.sessionsFile, this.sessions); }
  getSession(sid) {
    if (!sid) return null;
    const s = this.sessions[digest(sid)];
    if (!s || s.expires < Date.now()) return null;
    return s;
  }
  putSession(sid, s) { this.sessions[digest(sid)] = s; this.saveSessions(); }
  dropSession(sid) { delete this.sessions[digest(sid || '')]; this.saveSessions(); }
  latestSessionFor(sub) {
    let best = null;
    for (const s of Object.values(this.sessions)) {
      if (s.user?.sub === sub && s.expires > Date.now() && (!best || s.created > best.created)) best = s;
    }
    return best;
  }
  pruneSessions() {
    const now = Date.now(); let n = 0;
    for (const [k, s] of Object.entries(this.sessions)) if (s.expires < now) { delete this.sessions[k]; n++; }
    if (n) this.saveSessions();
  }

  // ---- rooms ----
  room(id) { return this.rooms[id] || null; }
  putRoom(id, r) { this.rooms[id] = { ...(this.rooms[id] || {}), ...r }; writeJson(this.roomsFile, this.rooms); }

  // ---- meetings ----
  meetingDir(id) { return path.join(this.dir, 'meetings', id); }
  meetingFile(id) { return path.join(this.meetingDir(id), 'meeting.json'); }
  audioDir(id) { return path.join(this.meetingDir(id), 'audio'); }
  meeting(id) { return (typeof id === 'string' && /^[A-Za-z0-9]{6,40}$/.test(id)) ? this.cache.get(id) || null : null; }
  saveMeeting(m) {
    fs.mkdirSync(this.audioDir(m.id), { recursive: true, mode: 0o700 });
    m.updated_at = Date.now();
    writeJson(this.meetingFile(m.id), m);
    this.cache.set(m.id, m);
    return m;
  }
  deleteMeeting(id) {
    this.cache.delete(id);
    fs.rmSync(this.meetingDir(id), { recursive: true, force: true });
  }
  allMeetings() { return [...this.cache.values()]; }
}

// Who may see a meeting after it: the host and every signed-in person who was in it. Nobody else (404).
export function canSee(m, sub) {
  if (!m || !sub) return false;
  if (m.host_sub === sub) return true;
  return (m.participants || []).some((p) => p.sub && p.sub === sub);
}
