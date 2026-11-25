#!/usr/bin/env python3
"""Mesh load test for meetings.osmike.com: N headless Chromes (fake camera + fake microphone) join one room as guests.

  python3 scripts/load_mesh.py --room ROOM --n 5 --relay 2 --tag acer [--site URL] [--secs 60] [--out stats.json]

Run it on several machines with the same --room (and the sum of --n as --expect) to put people on different networks.
--relay K forces the first K browsers through TURN (?relay=1 → iceTransportPolicy 'relay'). Every browser is sampled
with getStats twice, 10 s apart: video frames decoded per remote person (must rise), the picture size it receives, the
bitrate it sends to each person, its total upload, the candidate types in use (relay/srflx/host) and the CPU of this box.
Guest-only meetings are discarded by the server when everyone has left (nothing to clean up). Stdlib only + google-chrome.
"""
import argparse, json, math, os, shutil, struct, subprocess, sys, tempfile, time, urllib.request, wave

HERE = os.path.dirname(os.path.abspath(__file__))
for p in (HERE, "/opt/projects/mikeos-laptop-ui/stats", "/opt/osmike-surf"):
    sys.path.insert(0, p)
from osmike_surf import WS  # noqa: E402  stdlib websocket client for CDP

STATS_JS = r"""(async () => {
  const o = window.osmikeMeeting; if (!o) return null;
  const out = { peers: o.pcs.size, tier: o.tier(), tiles: document.querySelectorAll('.tile:not(.self) video').length, pcs: [] };
  for (const [id, pc] of o.pcs) {
    const st = await pc.getStats();
    const r = { id, state: pc.connectionState, frames: 0, w: 0, h: 0, fps: 0, inBytes: 0, outBytes: 0, outW: 0, outH: 0, outFps: 0,
      limit: null, aOut: 0, lt: null, rt: null, rtt: null };
    let pair = null;
    st.forEach((x) => {
      if (x.type === 'inbound-rtp' && x.kind === 'video') { r.frames = x.framesDecoded || 0; r.w = x.frameWidth || 0; r.h = x.frameHeight || 0; r.fps = x.framesPerSecond || 0; r.inBytes = x.bytesReceived || 0; }
      if (x.type === 'outbound-rtp' && x.kind === 'video') { r.outBytes += x.bytesSent || 0; r.outW = x.frameWidth || 0; r.outH = x.frameHeight || 0; r.outFps = x.framesPerSecond || 0; r.limit = x.qualityLimitationReason; }
      if (x.type === 'outbound-rtp' && x.kind === 'audio') r.aOut = x.bytesSent || 0;
      if (x.type === 'transport' && x.selectedCandidatePairId) pair = st.get(x.selectedCandidatePairId);
    });
    if (!pair) st.forEach((x) => { if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') pair = x; });
    if (pair) { r.lt = st.get(pair.localCandidateId)?.candidateType; r.rt = st.get(pair.remoteCandidateId)?.candidateType; r.rtt = pair.currentRoundTripTime; }
    const s = pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    const e = s && s.getParameters().encodings; r.maxBitrate = e && e[0] ? e[0].maxBitrate : null;
    out.pcs.push(r);
  }
  return out;
})()"""


def make_wav(path, secs=30):
    """A voice-like test tone (pitch glides + syllable rhythm) so the microphone sends real Opus audio."""
    sr = 16000
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        frames = bytearray()
        for i in range(sr * secs):
            t = i / sr
            f = 160 + 60 * math.sin(2 * math.pi * 0.7 * t)
            env = max(0.0, math.sin(2 * math.pi * 3.1 * t)) ** 0.6
            frames += struct.pack("<h", int(9000 * env * math.sin(2 * math.pi * f * t)))
        w.writeframes(bytes(frames))


class Chrome:
    def __init__(self, port, wav, tmp):
        self.dir = tempfile.mkdtemp(prefix=f"chrome{port}-", dir=tmp)
        self.p = subprocess.Popen(["google-chrome", "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={self.dir}",
                                   "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={wav}",
                                   "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check",
                                   "--window-size=1280,800", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tabs = []
        for _ in range(80):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2)); break
            except Exception:
                time.sleep(0.3)
        tab = [t for t in tabs if t["type"] == "page"][0]
        self.ws, self.n = WS(tab["webSocketDebuggerUrl"]), 0

    def call(self, method, **params):
        self.n += 1; self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.n:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error'].get('message')}")
                return m.get("result", {})

    def js(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"):
            raise RuntimeError(str(r["exceptionDetails"])[:300])
        return r.get("result", {}).get("value")

    def close(self):
        try:
            self.p.terminate(); self.p.wait(5)
        except Exception:
            self.p.kill()
        shutil.rmtree(self.dir, ignore_errors=True)


def cpu_times():
    v = [int(x) for x in open("/proc/stat").readline().split()[1:]]
    return sum(v), v[3] + v[4]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="https://meetings.osmike.com")
    ap.add_argument("--room", required=True)
    ap.add_argument("--n", type=int, default=8)
    ap.add_argument("--relay", type=int, default=0, help="force the first K browsers through TURN")
    ap.add_argument("--expect", type=int, default=0, help="people in the room in total (all machines); default --n")
    ap.add_argument("--tag", default=os.uname().nodename)
    ap.add_argument("--secs", type=int, default=60, help="stay in the call this long after everyone is connected")
    ap.add_argument("--port", type=int, default=9500)
    ap.add_argument("--out", default="")
    ap.add_argument("--restart-test", action="store_true", help="browser 1 forces an ICE restart with everyone, checks nobody drops")
    a = ap.parse_args()
    expect = a.expect or a.n
    tmp = tempfile.mkdtemp(prefix="meet-load-")
    wav = os.path.join(tmp, "voice.wav"); make_wav(wav)
    cs, result = [], {"tag": a.tag, "room": a.room, "n": a.n, "relay": a.relay, "expect": expect}
    try:
        for i in range(a.n):
            c = Chrome(a.port + i, wav, tmp); cs.append(c)
            name = f"Load {a.tag} {i + 1}" + (" (TURN)" if i < a.relay else "")
            q = "?relay=1" if i < a.relay else ""
            c.call("Page.navigate", url=f"{a.site}/r/{a.room}{q}")
            for _ in range(80):
                time.sleep(0.25)
                try:
                    if c.js("!!document.querySelector('#gname')"):
                        break
                except Exception:
                    pass
            c.js(f"document.querySelector('#gname').value={json.dumps(name)};document.querySelector('#joinf button[type=submit]').click()")
            time.sleep(1.0)
        t0 = time.time()
        while time.time() - t0 < 120:                          # wait until every browser sees everyone else connected
            ok = 0
            for c in cs:
                s = c.js(STATS_JS) or {}
                ok += sum(1 for p in s.get("pcs", []) if p["state"] == "connected") >= expect - 1
            if ok == len(cs):
                break
            time.sleep(2)
        result["connect_s"] = round(time.time() - t0, 1)
        time.sleep(8)                                           # let the bitrate settle after the last tier change
        tot0, idle0 = cpu_times(); s0 = [c.js(STATS_JS) or {} for c in cs]; t1 = time.time()
        time.sleep(10)
        tot1, idle1 = cpu_times(); s1 = [c.js(STATS_JS) or {} for c in cs]; dt = time.time() - t1
        result["cpu_pct"] = round(100 * (1 - (idle1 - idle0) / max(1, tot1 - tot0)), 1)
        result["load1"] = os.getloadavg()[0]
        result["cores"] = os.cpu_count()
        browsers = []
        for i, (b0, b1) in enumerate(zip(s0, s1)):
            prev = {p["id"]: p for p in b0.get("pcs", [])}
            peers = []
            for p in b1.get("pcs", []):
                q = prev.get(p["id"], p)
                peers.append({"state": p["state"], "fps_in": round((p["frames"] - q["frames"]) / dt, 1), "frames_rising": p["frames"] > q["frames"],
                              "in_res": f'{p["w"]}x{p["h"]}', "in_kbps": round((p["inBytes"] - q["inBytes"]) * 8 / dt / 1000),
                              "out_kbps": round((p["outBytes"] - q["outBytes"]) * 8 / dt / 1000), "out_res": f'{p["outW"]}x{p["outH"]}',
                              "out_fps": p["outFps"], "limit": p["limit"], "max_kbps": (p["maxBitrate"] or 0) // 1000,
                              "path": f'{p["lt"]}->{p["rt"]}', "rtt_ms": round((p["rtt"] or 0) * 1000)})
            browsers.append({"i": i + 1, "relay_forced": i < a.relay, "peers_seen": len(peers), "video_tiles": b1.get("tiles"),
                             "rising": sum(x["frames_rising"] for x in peers), "upload_kbps": sum(x["out_kbps"] for x in peers),
                             "download_kbps": sum(x["in_kbps"] for x in peers), "tier_kbps": (b1.get("tier") or {}).get("maxBitrate", 0) // 1000,
                             "peers": peers})
        result["browsers"] = browsers
        if a.restart_test and cs:                               # browser 1 restarts ICE with everyone (both roles)
            c = cs[0]
            roles = c.js("[...window.osmikeMeeting.pcs.values()].map(p=>p._initiator)")
            c.js("window.osmikeMeeting.pcs.forEach((pc,id)=>window.osmikeMeeting.heal(id,'frozen'))")
            f0 = {p["id"]: p["frames"] for p in (c.js(STATS_JS) or {}).get("pcs", [])}
            time.sleep(22)
            s2 = c.js(STATS_JS) or {}
            ufrag = c.js("[...window.osmikeMeeting.pcs.values()].filter(p=>!p._healing).length")
            result["restart_test"] = {"initiator_roles": roles, "peers_after": len(s2.get("pcs", [])),
                                      "connected_after": sum(p["state"] == "connected" for p in s2.get("pcs", [])),
                                      "rising_after": sum(p["frames"] > f0.get(p["id"], 0) for p in s2.get("pcs", [])), "healed_cleared": ufrag,
                                      "log": c.js("window.osmikeMeeting.log.slice(-80)")}
        print(json.dumps(result, indent=1), flush=True)
        if a.out:
            json.dump(result, open(a.out, "w"), indent=1)
        time.sleep(max(0, a.secs - 18))
    finally:
        for c in cs:
            try:
                c.js("document.querySelector('#leave')?.click()")
            except Exception:
                pass
        time.sleep(1.5)
        for c in cs:
            c.close()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
