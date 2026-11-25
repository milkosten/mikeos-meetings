#!/usr/bin/env python3
"""SFU (LiveKit) load test for meetings.osmike.com: N headless Chromes (fake camera + fake microphone) join one room as guests.

  python3 scripts/load_sfu.py --room ROOM --n 6 --expect 14 --tag acer [--relay K] [--tcp K] [--secs 90] [--out stats.json]

Run it on several machines with the same --room and the total as --expect (people on different networks). The room is
forced onto the SFU with ?media=sfu (the first person decides; works while the server default is still mesh).
--relay K: the first K browsers go through our TURN (UDP or TCP); --tcp K: the next K browsers through TURN over TCP only.
Every browser is sampled twice, 10 s apart (window.osmikeMeeting.stats()): frames decoded per remote person (must
rise), the picture size received, what it uploads (simulcast layers), the ICE path, and this box's CPU.
Guest-only meetings keep nothing on the server. Stdlib + google-chrome; reuses the Chrome driver of load_mesh.py.
"""
import argparse, json, os, shutil, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from load_mesh import Chrome, make_wav, cpu_times  # noqa: E402

STATS = "window.osmikeMeeting && window.osmikeMeeting.stats ? window.osmikeMeeting.stats() : null"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="https://meetings.osmike.com")
    ap.add_argument("--room", required=True)
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--relay", type=int, default=0)
    ap.add_argument("--tcp", type=int, default=0)
    ap.add_argument("--expect", type=int, default=0)
    ap.add_argument("--tag", default=os.uname().nodename)
    ap.add_argument("--secs", type=int, default=90, help="stay in the call this long after the measurement")
    ap.add_argument("--wait", type=int, default=180, help="max seconds to wait for everyone")
    ap.add_argument("--port", type=int, default=9600)
    ap.add_argument("--media", default="sfu")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    expect = a.expect or a.n
    tmp = tempfile.mkdtemp(prefix="meet-sfu-")
    wav = os.path.join(tmp, "voice.wav"); make_wav(wav)
    cs, res = [], {"tag": a.tag, "room": a.room, "n": a.n, "expect": expect, "relay": a.relay, "tcp": a.tcp}
    kinds = []
    try:
        for i in range(a.n):
            kind = "relay" if i < a.relay else "tcp" if i < a.relay + a.tcp else "direct"; kinds.append(kind)
            c = Chrome(a.port + i, wav, tmp); cs.append(c)
            q = f"?media={a.media}" + ("&relay=1" if kind == "relay" else "&tcp=1" if kind == "tcp" else "")
            c.call("Page.navigate", url=f"{a.site}/r/{a.room}{q}")
            for _ in range(80):
                time.sleep(0.25)
                try:
                    if c.js("!!document.querySelector('#gname')"):
                        break
                except Exception:
                    pass
            name = f"Load {a.tag} {i + 1}" + ({"relay": " (TURN)", "tcp": " (TURN-TCP)"}.get(kind, ""))
            c.js(f"document.querySelector('#gname').value={json.dumps(name)};document.querySelector('#joinf button[type=submit]').click()")
            time.sleep(0.8)
        t0 = time.time()
        while time.time() - t0 < a.wait:
            ok = 0
            for c in cs:
                s = c.js(STATS) or {}
                ok += sum(1 for r in s.get("remotes", []) if r["frames"] > 0) >= expect - 1
            if ok == len(cs):
                break
            time.sleep(2)
        res["connect_s"] = round(time.time() - t0, 1)
        time.sleep(8)
        tot0, idle0 = cpu_times(); s0 = [c.js(STATS) or {} for c in cs]; t1 = time.time()
        time.sleep(10)
        tot1, idle1 = cpu_times(); s1 = [c.js(STATS) or {} for c in cs]; dt = time.time() - t1
        res["cpu_pct"] = round(100 * (1 - (idle1 - idle0) / max(1, tot1 - tot0)), 1)
        res["load1"] = os.getloadavg()[0]; res["cores"] = os.cpu_count()
        out = []
        for i, (b0, b1) in enumerate(zip(s0, s1)):
            prev = {r["id"]: r for r in b0.get("remotes", [])}
            rem = []
            for r in b1.get("remotes", []):
                q = prev.get(r["id"], r)
                rem.append({"name": r["name"], "rising": r["frames"] > q["frames"], "fps": round((r["frames"] - q["frames"]) / dt, 1),
                            "res": f'{r["w"]}x{r["h"]}', "kbps": round((r["inBytes"] - q["inBytes"]) * 8 / dt / 1000), "q": r.get("quality")})
            l0 = {x["rid"]: x["bytes"] for x in b0.get("up", {}).get("layers", [])}
            layers = [{"rid": x["rid"], "res": f'{x["w"]}x{x["h"]}', "fps": x["fps"], "kbps": round((x["bytes"] - l0.get(x["rid"], x["bytes"])) * 8 / dt / 1000),
                       "limit": x.get("limit")} for x in b1.get("up", {}).get("layers", [])]
            a0, a1 = b0.get("up", {}).get("audio", 0), b1.get("up", {}).get("audio", 0)
            out.append({"i": i + 1, "kind": kinds[i], "state": b1.get("state"), "remotes": len(rem), "tiles": b1.get("tiles"),
                        "rising": sum(x["rising"] for x in rem), "download_kbps": sum(x["kbps"] for x in rem),
                        "upload_video_kbps": sum(x["kbps"] for x in layers), "upload_audio_kbps": round((a1 - a0) * 8 / dt / 1000),
                        "layers": layers, "up_path": b1.get("upPath"), "down_path": b1.get("down"),
                        "in_res": sorted({x["res"] for x in rem}), "remotes_detail": rem})
        res["browsers"] = out
        res["view"] = cs[0].js("(()=>{const ts=[...document.querySelectorAll('.tile:not(.self)')];return {inner:[innerWidth,innerHeight],"
                               "stage:[document.querySelector('#grid').clientWidth,document.querySelector('#grid').clientHeight],"
                               "room:document.querySelector('.room').offsetHeight,"
                               "onscreen:ts.filter(t=>{const r=t.getBoundingClientRect();return r.bottom<=innerHeight+1&&r.top>=0}).length,tiles:ts.length,"
                               "w:ts[0]&&ts[0].offsetWidth}})()")
        print(json.dumps(res, indent=1), flush=True)
        if a.out:
            json.dump(res, open(a.out, "w"), indent=1)
        time.sleep(max(0, a.secs))
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
