#!/usr/bin/env python3
"""Screen-share load test for meetings.osmike.com (SFU): one guest shares a tab, N guests watch it.

  python3 scripts/load_share.py --n 8 [--site URL] [--secs 20] [--smooth] [--out share.json]

All guests, so the meeting keeps nothing. The sharer's tab is a slide with text plus a moving block (ShareMe page of
live_share_e2e.py). After everyone decodes the share, measures over --secs: what the sharer uploads (screen-share
layer size, fps, kbit/s, the bandwidth estimate), what every viewer receives (frames rising, fps, size, kbit/s, tab
audio), and this box's CPU (all browsers run here). Stdlib + google-chrome.
"""
import argparse, json, os, shutil, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from load_mesh import Chrome, make_wav, cpu_times  # noqa: E402
from live_share_e2e import ShareChrome, wait  # noqa: E402

UP = """(async()=>{const r=window.osmikeMeeting.room(),S=window.LivekitClient.Track.Source;const p=r&&r.localParticipant.getTrackPublication(S.ScreenShare);
if(!p||!p.track)return null;const st=await p.track.getRTCStatsReport();const o={layers:[]};
st.forEach(x=>{if(x.type==='candidate-pair'&&x.nominated&&x.state==='succeeded')o.estimate=x.availableOutgoingBitrate;
if(x.type==='outbound-rtp'&&x.kind==='video')o.layers.push({rid:x.rid||'',w:x.frameWidth||0,h:x.frameHeight||0,fps:x.framesPerSecond||0,bytes:x.bytesSent||0,limit:x.qualityLimitationReason,frames:x.framesEncoded||0})});
const a=r.localParticipant.getTrackPublication(S.ScreenShareAudio);o.audio=0;
if(a&&a.track){(await a.track.getRTCStatsReport()).forEach(x=>{if(x.type==='outbound-rtp')o.audio=x.bytesSent||0})}return o})()"""
VIEW = "window.osmikeMeeting && window.osmikeMeeting.stats ? window.osmikeMeeting.stats().then(s=>(s.screens||[])[0]||null) : null"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="https://meetings.osmike.com")
    ap.add_argument("--n", type=int, default=8, help="viewers")
    ap.add_argument("--secs", type=int, default=20)
    ap.add_argument("--smooth", action="store_true", help="the sharer ticks Smooth video")
    ap.add_argument("--port", type=int, default=9700)
    ap.add_argument("--cams", action="store_true", help="viewers keep their cameras on (default off: 9 Chromes on one box run out of CPU encoding + decoding 9 cameras, which hides what the share costs)")
    ap.add_argument("--room", default="", help="join this room (several boxes: one with the sharer, the others --viewers-only)")
    ap.add_argument("--viewers-only", action="store_true", help="no sharer on this box: viewers join --room and wait for the share")
    ap.add_argument("--expect", type=int, default=0, help="people in the room in total before the sharer starts (default: this box's)")
    ap.add_argument("--hold", type=int, default=0, help="stay in the call this many seconds after measuring")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    site = a.site.rstrip("/")
    q = "?media=sfu" + ("&sso=0" if not site.startswith("https://meetings.osmike.com") else "")
    room = a.room or "shareload" + str(int(time.time()))[-6:]
    tmp = tempfile.mkdtemp(prefix="meet-shareload-")
    wav = os.path.join(tmp, "voice.wav"); make_wav(wav)
    cs, res = [], {"room": room, "viewers": a.n, "smooth": a.smooth, "box": os.uname().nodename}
    tag = os.uname().nodename.split("-")[0][:8]
    try:
        sh = None
        if not a.viewers_only:
            sh = ShareChrome(a.port, wav, tmp, "load", "#c0392b", 330, "Load test slides"); cs.append(sh)
        for i in range(a.n):
            cs.append(Chrome(a.port + 1 + i, wav, tmp))
        vw = cs[1:] if sh else cs
        for i, c in enumerate(cs):
            c.call("Page.navigate", url=f"{site}/r/{room}{q}")
            wait(lambda: c.js("!!document.querySelector('#gname')"), 20, 0.25)
            nm = "Sharer" if c is sh else f"Viewer {tag} {cs.index(c) + (0 if sh else 1)}"
            c.js(f"document.querySelector('#gname').value={json.dumps(nm)};document.querySelector('#joinf button[type=submit]').click()")
            time.sleep(0.8)
            if c is not sh and not a.cams:
                wait(lambda: c.js("!!document.querySelector('#cam')"), 20, 0.25); time.sleep(1.5); c.js("document.querySelector('#cam').click()")
        res["viewer_cams"] = a.cams
        t0 = time.time()
        if sh:
            expect = (a.expect or a.n + 1) - 1
            wait(lambda: (sh.js("window.osmikeMeeting && window.osmikeMeeting.room() ? window.osmikeMeeting.room().remoteParticipants.size : 0") or 0) >= expect, 180, 1)
            res["join_s"] = round(time.time() - t0, 1)
            res["in_room"] = 1 + (sh.js("window.osmikeMeeting.room().remoteParticipants.size") or 0)
            sh.click("#share")
            assert wait(lambda: (sh.share().get("me") or None), 20), "share did not start"
            if a.smooth:
                time.sleep(2); sh.click("#smooth")
            sh.front("share")
        t1 = time.time()
        wait(lambda: all(((c.js(VIEW) or {}).get("frames") or 0) > 0 for c in vw), 600 if not sh else 90, 1)
        res["first_frame_all_s"] = round(time.time() - t1, 1)
        full = lambda: all(((c.js(VIEW) or {}).get("w") or 0) >= 1200 for c in vw)
        wait(full, 60, 1)
        res["full_size_all_s"] = round(time.time() - t1, 1)
        time.sleep(5)
        tot0, idle0 = cpu_times(); u0 = (sh.js(UP) if sh else None) or {}; v0 = [c.js(VIEW) or {} for c in vw]; ts = time.time()
        time.sleep(a.secs)
        tot1, idle1 = cpu_times(); u1 = (sh.js(UP) if sh else None) or {}; v1 = [c.js(VIEW) or {} for c in vw]; dt = time.time() - ts
        res["cpu_pct_box"] = round(100 * (1 - (idle1 - idle0) / max(1, tot1 - tot0)), 1)
        res["cores"] = os.cpu_count(); res["load1"] = os.getloadavg()[0]
        l0 = {x["rid"]: x for x in u0.get("layers", [])}
        res["sharer_up"] = {"estimate_kbps": round((u1.get("estimate") or 0) / 1000), "audio_kbps": round((u1.get("audio", 0) - u0.get("audio", 0)) * 8 / dt / 1000),
                            "layers": [{"rid": x["rid"], "res": f'{x["w"]}x{x["h"]}', "fps": round((x["frames"] - l0.get(x["rid"], x)["frames"]) / dt, 1),
                                        "kbps": round((x["bytes"] - l0.get(x["rid"], x)["bytes"]) * 8 / dt / 1000), "limit": x["limit"]} for x in u1.get("layers", [])]}
        vs = []
        for i, (b0, b1) in enumerate(zip(v0, v1)):
            vs.append({"viewer": i + 1, "res": f'{b1.get("w")}x{b1.get("h")}', "fps": round((b1.get("frames", 0) - b0.get("frames", 0)) / dt, 1),
                       "kbps": round((b1.get("inBytes", 0) - b0.get("inBytes", 0)) * 8 / dt / 1000),
                       "audio_kbps": round((b1.get("audioBytes", 0) - b0.get("audioBytes", 0)) * 8 / dt / 1000)})
        res["viewers_detail"] = vs
        res["all_rising"] = all(v["fps"] > 0 for v in vs)
        if vs:
            res["viewer_fps_min_max"] = [min(v["fps"] for v in vs), max(v["fps"] for v in vs)]
            res["viewer_kbps_min_max"] = [min(v["kbps"] for v in vs), max(v["kbps"] for v in vs)]
        print(json.dumps(res, indent=1), flush=True)
        if a.out:
            json.dump(res, open(a.out, "w"), indent=1)
        time.sleep(a.hold)
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
