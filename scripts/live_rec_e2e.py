#!/usr/bin/env python3
"""Live recording-robustness test of meetings.osmike.com on the SFU path: three real headless Chromes, ~5 minutes.

  python3 scripts/live_rec_e2e.py [--keep] [--secs 300]

meshtest4 (signed in, host), meshtest3 (signed in) and a guest each "speak" their own looping Swedish espeak-ng
recording. During the meeting meshtest3 goes through everything that used to end a recording silently: its meeting
socket drops, it mutes and unmutes, it switches microphone (new track), its microphone track ends (LiveKit brings a new
one), its recorder dies without a word; the guest's socket drops too. After each event the browser must be recording
again (window.osmikeMeeting.rec()). Then all three press Leave and the host opens the meeting page at once: it must say
"Transcribing…" (never "No speech was recorded") and show the transcript by itself, without a reload. The transcript
must have all three speakers, and meshtest3 must be heard after every event. Deletes the meeting unless --keep.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, time, wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from live_e2e import SITE, Browser, Chrome, check, env  # noqa: E402

TEXTS = {
    "host": "Hej allihop. Jag pratar om budgeten för kampanjen, femtio tusen kronor, och lanseringen på fredag.",
    "p2": "Jag heter Petra och jag ansvarar för testerna av betalningen. Vi ses på onsdag klockan tio.",
    "guest": "Det här är gästen Gustav. Jag bokar lokalen i Göteborg och skickar fakturan till kunden.",
}
KEY = {"host": "budget", "p2": "betalning", "guest": "göteborg"}   # a word Whisper reliably gets from each voice


def wav(path, text, voice):
    raw = path + ".raw.wav"
    subprocess.run(["espeak-ng", "-v", voice, "-s", "130", "-w", raw, text], check=True)
    # 4 s of silence after each sentence: the file loops, so every person talks every ~12 s like in a real meeting
    with wave.open(raw) as r, wave.open(path, "wb") as w:
        w.setparams(r.getparams()); w.writeframes(r.readframes(r.getnframes()) + b"\0" * (r.getframerate() * r.getsampwidth() * r.getnchannels() * 4))
    os.remove(raw)


def rec_ok(c, label, within=25):
    t0 = time.time(); r = {}
    while time.time() - t0 < within:
        r = c.js("window.osmikeMeeting.rec()") or {}
        if r.get("state") == "on" and r.get("recorder") == "recording" and r.get("lastChunkAgo", 1e9) < 6000 and r.get("queued", 9) == 0 and r.get("seg"):
            break
        time.sleep(1)
    check(r.get("state") == "on" and r.get("recorder") == "recording" and r.get("lastChunkAgo", 1e9) < 6000 and r.get("seg"),
          f"{label}: recording again after {time.time() - t0:.0f} s (restarts {r.get('restarts')}, seg {r.get('seg')})")
    return r


def server_meeting(mid):
    out = subprocess.run(["ssh", "relay242", f"docker exec mikeos-meetings cat /data/meetings/{mid}/meeting.json"], capture_output=True, text=True, timeout=30).stdout
    return json.loads(out) if out.strip() else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--secs", type=int, default=300)
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="meet-rec-")
    bh, b2 = Browser(), Browser()
    check(bh.req(bh.to_callback("meshtest4@osmike.com", env("MESHTEST4_PASSWORD")))[0] == 302, "meshtest4 signed in")
    check(b2.req(b2.to_callback("meshtest3@osmike.com", env("MESHTEST3_PASSWORD")))[0] == 302, "meshtest3 signed in")
    nh = json.loads(bh.req(SITE + "/api/me")[2])["user"]["name"]; n2 = json.loads(b2.req(SITE + "/api/me")[2])["user"]["name"]
    st, room = bh.api("/api/rooms", "POST", {"title": "Inspelningstest"})
    check(st == 200 and room.get("room_id"), f"room {room.get('room_id')} ({nh}, {n2}, Gustav Gäst)")
    rid = room["room_id"]
    files = {k: os.path.join(tmp, k + ".wav") for k in TEXTS}
    wav(files["host"], TEXTS["host"], "sv"); wav(files["p2"], TEXTS["p2"], "sv+f3"); wav(files["guest"], TEXTS["guest"], "sv+m3")
    ch, c2, cg = Chrome(9421, files["host"], tmp), Chrome(9422, files["p2"], tmp), Chrome(9423, files["guest"], tmp)
    events, mid = [], None
    try:
        for c, b in ((ch, bh), (c2, b2)):
            c.call("Network.setCookie", name="__Host-meetings-sid", value=b.sid(), url=SITE + "/", secure=True, httpOnly=True, sameSite="Lax", path="/")
        for c in (ch, c2, cg):
            c.open(f"{SITE}/r/{rid}?media=sfu", "#joinf")
        ch.js("document.querySelector('#joinf button[type=submit]').click()"); time.sleep(2)
        c2.js("document.querySelector('#joinf button[type=submit]').click()"); time.sleep(1)
        cg.js("document.querySelector('#gname').value='Gustav Gäst';document.querySelector('#joinf button[type=submit]').click()")
        for _ in range(60):
            time.sleep(1)
            if all((c.js("window.osmikeMeeting && window.osmikeMeeting.room() ? window.osmikeMeeting.room().remoteParticipants.size : 0") or 0) >= 2 for c in (ch, c2, cg)):
                break
        check(all(c.js("window.osmikeMeeting.mode()") == "sfu" for c in (ch, c2, cg)), "all three on the SFU path")
        check(all((c.js("window.osmikeMeeting.room().remoteParticipants.size") or 0) >= 2 for c in (ch, c2, cg)), "all three see each other")
        for c, l in ((ch, nh), (c2, n2), (cg, "guest")):
            rec_ok(c, f"{l} records from the start")
        check("Rec" in ch.js("document.querySelector('#recst').innerText") and ch.js("document.querySelector('#recst').classList.contains('on')"), "own ●Rec indicator is on")
        t0 = time.time()
        plan = [
            (40, "socket drop", lambda: c2.js("window.osmikeMeeting.dropSocket()"), c2),
            (75, "mute", lambda: c2.js("document.querySelector('#mic').click()"), None),
            (95, "unmute", lambda: c2.js("document.querySelector('#mic').click()"), c2),
            (120, "switch microphone (new track)", lambda: c2.js("window.osmikeMeeting.swapMic()"), c2),
            (155, "microphone track ended", lambda: c2.js("window.osmikeMeeting.endMic()"), c2),
            (195, "recorder dies silently", lambda: c2.js("window.osmikeMeeting.killRecorder()"), c2),
            (230, "guest socket drop", lambda: cg.js("window.osmikeMeeting.dropSocket()"), cg),
        ]
        for at, what, act, who in plan:
            time.sleep(max(0, at - (time.time() - t0)))
            act(); events.append((what, int(time.time() * 1000)))
            print(f"[{int(time.time() - t0):3d} s] {what}", flush=True)
            if what == "mute":
                time.sleep(3)
                r = c2.js("window.osmikeMeeting.rec()")
                check(r["state"] == "on" and r["recorder"] == "recording", "muted: still recording (silence), no restart storm")
            if who is not None:
                rec_ok(who, f"after '{what}'")
        time.sleep(max(0, a.secs - (time.time() - t0)))
        print("recorder logs (meshtest3):", json.dumps(c2.js("window.osmikeMeeting.rec()").get("log"), ensure_ascii=False), flush=True)
        # everyone leaves; the host opens the meeting page at once (Mike's case)
        for c in (cg, c2, ch):
            c.js("document.querySelector('#leave').click()"); time.sleep(0.4)
        time.sleep(2)
        href = ch.js("(document.querySelector('a[href^=\"/m/\"]')||{}).getAttribute ? document.querySelector('a[href^=\"/m/\"]').getAttribute('href') : ''")
        check(bool(href), f"host gets the meeting notes link {href}")
        mid = href.split("/")[-1]
        ch.open(f"{SITE}/m/{mid}", ".page-title")
        txt = ch.js("document.body.innerText")
        check("Transcribing" in txt and "No speech" not in txt, "right after the end the page says Transcribing… (not 'No speech'): " + re.sub(r"\s+", " ", txt)[:160])
        st, lst = bh.api("/api/past")
        badge = next((m for m in lst["meetings"] if m["id"] == mid), {})
        check(bool(badge) and badge["status"] in ("live", "queued", "processing"), f"listed under Previous meetings while transcribing ({badge.get('status')}/{badge.get('live_state')})")
        seen, t1 = set(), time.time()
        while time.time() - t1 < 900:
            s = ch.js("(()=>{const t=document.body.innerText;return {tr:!!document.querySelector('.transcript'),n:t.includes('No speech'),p:(t.match(/(Transcribing…[^\\n]*|Writing the summary…)/)||[''])[0]}})()") or {}
            if s.get("p"): seen.add(s["p"][:40])
            if s.get("tr") or s.get("n"):
                break
            time.sleep(3)
        print("states seen without reload:", sorted(seen), flush=True)
        check(bool(s.get("tr")) and not s.get("n"), f"transcript appeared by itself after {time.time() - t1:.0f} s, no reload")
        d = bh.api(f"/api/past/{mid}")[1]
        m = server_meeting(mid) or {}
        for sg in m.get("segments", []):
            print(f"  segment {sg['name']:<22} {time.strftime('%H:%M:%S', time.gmtime(sg['started_at'] / 1000))}  {sg['bytes'] / 1024:8.0f} KB", flush=True)
        dur = (m["ended_at"] - m["started_at"]) / 1000 if m.get("ended_at") else a.secs
        by = {}
        for sg in m.get("segments", []):
            by[sg["name"]] = by.get(sg["name"], 0) + sg["bytes"]
        for name in (nh, n2, "Gustav Gäst"):
            kb_s = by.get(name, 0) / 1024 / max(1, dur)
            check(kb_s > 2.5, f"{name}: audio for the whole meeting ({by.get(name, 0) / 1024:.0f} KB, {kb_s:.1f} KB/s)")
        speakers = {}
        for l in d["transcript"]:
            speakers.setdefault(l["speaker"], []).append(l)
        print({k: len(v) for k, v in speakers.items()}, flush=True)
        check({nh, n2, "Gustav Gäst"} <= set(speakers), f"transcript has all three speakers: {sorted(speakers)}")
        for what, ts in events:
            if what in ("mute", "guest socket drop"):
                continue
            after = [l for l in speakers.get(n2, []) if ts + 2000 <= l["at"] <= ts + 60000]
            check(len(after) > 0, f"{n2} heard within 60 s after '{what}' ({len(after)} lines)")
        last = max(l["at"] for l in speakers.get(n2, [{"at": 0}]))
        left = max(p["left_at"] for p in m["participants"])   # ended_at is END_GRACE_MS after the last person left
        check(left - last < 40000, f"{n2} heard until people left (last line {(left - last) / 1000:.0f} s before)")
        g_after = [l for l in speakers.get("Gustav Gäst", []) if l["at"] > dict(events)["guest socket drop"] + 2000]
        check(len(g_after) > 0, "the guest is heard after its socket drop")
        alltext = " ".join(l["text"] for l in d["transcript"]).lower()
        for k, w in KEY.items():
            print(f"  '{w}' in transcript: {w in alltext}", flush=True)
        print("MEETING", mid)
        if not a.keep:
            st, r = bh.api(f"/api/past/{mid}", "DELETE")
            check(st == 200 and r.get("deleted"), "test meeting deleted")
        print("ALL PASSED")
    finally:
        for c in (ch, c2, cg):
            try:
                c.close()
            except Exception:
                pass
        shutil.rmtree(tmp, ignore_errors=True)
        for b in (bh, b2):
            try:
                b.api("/auth/logout", "POST")
            except Exception:
                pass


if __name__ == "__main__":
    main()
