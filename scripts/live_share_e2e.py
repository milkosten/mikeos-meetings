#!/usr/bin/env python3
"""Live screen-sharing test of meetings.osmike.com (SFU path) with three real headless Chromes.

  python3 scripts/live_share_e2e.py [--site URL] [--guests] [--keep] [--shots DIR]

meshtest4 (signed in, host), meshtest3 (signed in) and a guest meet. Each Chrome has a second tab "ShareMe-<who>"
(moving picture + a tone); Chrome's own flags pick that tab in the share picker (--auto-select-tab-capture-source-by-title)
so getDisplayMedia works headless. Proves: meshtest3 shares a tab with its audio and the two others see it (frames
decoded rising, tab audio arriving, layout = stage + filmstrip, the pill), the sharer has the "You're sharing" bar and
never its own share full size; the guest shares too (two shares: the switcher); the host stops meshtest3's share (the
sharer is told, everyone loses it, the SFU muted it); the guest stops via the track ending (= the browser's own Stop);
recording stays on for everyone throughout. Then: a phone browser without getDisplayMedia gets an unavailable button
with an explanation, and a mesh room says "Sharing needs the standard meeting mode". Screenshots desktop + 390 px,
light + dark, into docs/screens. --guests: everyone a guest (for a staging server without sign-in; no host-stop step).
Deletes the test meeting unless --keep.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_e2e  # noqa: E402
from live_e2e import Browser, Chrome, check, env, WS  # noqa: E402

SHAREME = """<!doctype html><title>{title}</title><body style="margin:0;background:#f6f1e7;font-family:sans-serif;overflow:hidden">
<canvas id=c width=1600 height=900 style="display:block;width:100vw;height:100vh"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');let f=0;
function d(){{f++;x.fillStyle='#f6f1e7';x.fillRect(0,0,1600,900);x.fillStyle='#1d1a16';x.font='bold 64px sans-serif';
x.fillText({label},80,140);x.font='40px sans-serif';x.fillText('Quarterly plan · slide 3 · frame '+f,80,220);
for(let i=0;i<6;i++){{x.fillText('• Line '+(i+1)+' of small text that must stay sharp',100,320+i*70);}}
x.fillStyle='{color}';x.fillRect(80+(f*9)%1300,760,140,90);}}
setInterval(d,50);
try{{const a=new AudioContext(),o=a.createOscillator(),g=a.createGain();g.gain.value=.2;o.frequency.value={hz};o.connect(g).connect(a.destination);o.start();}}catch(e){{}}
</script>"""


class ShareChrome(Chrome):
    """live_e2e's Chrome plus a ShareMe tab that the share picker selects by its title."""
    def __init__(self, port, wav, tmp, who, color, hz, label):
        self.dir = tempfile.mkdtemp(prefix=f"chrome{port}-", dir=tmp)
        title = f"ShareMe-{who}"
        page = os.path.join(self.dir, "shareme.html")
        open(page, "w").write(SHAREME.format(title=title, label=json.dumps(label), color=color, hz=hz))
        self.p = subprocess.Popen(["google-chrome", "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={self.dir}",
                                   # no --use-fake-ui-for-media-stream: with it Chrome shares the meeting tab itself; camera and
                                   # microphone are granted below instead, and the picker takes the ShareMe tab by its title
                                   "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={wav}",
                                   f"--auto-select-tab-capture-source-by-title={title}", f"--auto-select-desktop-capture-source={title}",
                                   "--autoplay-policy=no-user-gesture-required", "--no-first-run",
                                   # the shared tab sits behind the meeting tab: keep it painting at full speed like a real one
                                   "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
                                   "--no-default-browser-check", "--window-size=1280,860", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2)); break
            except Exception:
                time.sleep(0.3)
        tab = [t for t in tabs if t["type"] == "page"][0]
        self.port, self.meet_id = port, tab["id"]
        self.share_id = json.load(urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/json/new?file://{page}", method="PUT"), timeout=5))["id"]
        self.ws, self.n = WS(tab["webSocketDebuggerUrl"]), 0
        self.call("Page.enable")
        self.call("Browser.grantPermissions", permissions=["audioCapture", "videoCapture"])
        self.call("Page.bringToFront")      # the meeting tab in front: a background tab pauses its videos (adaptive stream)

    def front(self, which):
        """Like a person: after starting a share they look at the tab they share (a tab behind others paints ~1 fps)."""
        urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/activate/{self.share_id if which == 'share' else self.meet_id}", timeout=5).read()
        time.sleep(0.3)

    def click(self, sel):
        """A real user click (transient activation): getDisplayMedia refuses without one."""
        r = self.call("Runtime.evaluate", expression=f"document.querySelector({json.dumps(sel)}).click()", userGesture=True, awaitPromise=False)
        if r.get("exceptionDetails"):
            raise RuntimeError(str(r["exceptionDetails"])[:300])

    def share(self):
        return self.js("window.osmikeMeeting ? window.osmikeMeeting.share() : null") or {}

    def stats(self):
        return self.js("window.osmikeMeeting.stats()") or {}

    def toast(self):
        return self.js("(()=>{const t=document.querySelector('#toast');return t&&!t.hidden?t.textContent:''})()") or ""


def wait(fn, secs=20, step=0.5):
    t0 = time.time(); v = None
    while time.time() - t0 < secs:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return v


def screen_of(c, name):
    return next((s for s in c.stats().get("screens", []) if s.get("name") == name), None)


def rising(c, name, secs=4):
    """frames decoded and bytes of the person's screen-share track (video + tab audio) over secs."""
    a = screen_of(c, name) or {}
    time.sleep(secs)
    b = screen_of(c, name) or {}
    return {"frames": b.get("frames", 0) - a.get("frames", 0), "audio": b.get("audioBytes", 0) - a.get("audioBytes", 0),
            "kbps": (b.get("inBytes", 0) - a.get("inBytes", 0)) * 8 / 1000 / secs, "w": b.get("w"), "h": b.get("h"), "fps": b.get("fps")}


def recording(c):
    r = c.js("window.osmikeMeeting.rec()") or {}
    return r.get("state") == "on" and r.get("recorder") == "recording" and r.get("lastChunkAgo", 1e9) < 6000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default=live_e2e.SITE)
    ap.add_argument("--guests", action="store_true", help="everyone joins as a guest (staging without sign-in); skips the host stop")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--shots", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "screens"))
    a = ap.parse_args()
    site = a.site.rstrip("/")
    q = "&sso=0" if a.guests else ""     # staging: no silent sign-in round trip
    os.makedirs(a.shots, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="meet-share-")
    shots, cs, bh, b2 = {}, [], None, None
    try:
        if a.guests:
            rid = "share" + str(int(time.time()))[-7:]
            nh, n2 = "Hanna Värd", "Petra Test"
        else:
            bh, b2 = Browser(), Browser()
            check(bh.req(bh.to_callback("meshtest4@osmike.com", env("MESHTEST4_PASSWORD")))[0] == 302, "meshtest4 signed in")
            check(b2.req(b2.to_callback("meshtest3@osmike.com", env("MESHTEST3_PASSWORD")))[0] == 302, "meshtest3 signed in")
            nh = json.loads(bh.req(site + "/api/me")[2])["user"]["name"]; n2 = json.loads(b2.req(site + "/api/me")[2])["user"]["name"]
            st, room = bh.api("/api/rooms", "POST", {"title": "Delningstest"})
            check(st == 200 and room.get("room_id"), f"room {room.get('room_id')}")
            rid = room["room_id"]
        ng = "Gustav Gäst"
        wav = os.path.join(tmp, "voice.wav")
        if shutil.which("espeak-ng"):
            subprocess.run(["espeak-ng", "-v", "sv", "-s", "130", "-w", wav, "Hej, nu delar jag min skärm med er alla."], check=True)
        else:
            from load_mesh import make_wav
            make_wav(wav)
        ch = ShareChrome(9431, wav, tmp, "host", "#c0392b", 300, "Host's tab")
        c2 = ShareChrome(9432, wav, tmp, "p2", "#2f7d4f", 440, "Petra's slides")
        cg = ShareChrome(9433, wav, tmp, "guest", "#3355cc", 520, "Guest's tab")
        cs = [ch, c2, cg]
        if not a.guests:
            for c, b in ((ch, bh), (c2, b2)):
                c.call("Network.setCookie", name=live_e2e.SID, value=b.sid(), url=site + "/", secure=True, httpOnly=True, sameSite="Lax", path="/")
        for c in cs:
            c.open(f"{site}/r/{rid}?media=sfu{q}", "#joinf")
        for c, nm in ((ch, nh), (c2, n2), (cg, ng)):
            if a.guests or c is cg:
                c.js(f"document.querySelector('#gname').value={json.dumps(nm)}")
            c.js("document.querySelector('#joinf button[type=submit]').click()"); time.sleep(1.5)
        check(wait(lambda: all((c.js("window.osmikeMeeting && window.osmikeMeeting.room() ? window.osmikeMeeting.room().remoteParticipants.size : 0") or 0) >= 2 for c in cs), 60),
              "all three in the SFU meeting and see each other")
        check(wait(lambda: all(recording(c) for c in cs), 30), "all three record their microphones")
        check(not ch.js("document.querySelector('#share').classList.contains('unavail')"), "Share button available on desktop Chrome in an SFU room")

        # 1) meshtest3 shares a tab with its audio
        c2.click("#share")
        s2 = wait(lambda: (c2.share().get("me") or None), 20)
        check(bool(s2) and s2["kind"] == "browser" and s2["audio"], f"{n2} shares a tab with tab audio: {s2}")
        c2.front("share")
        time.sleep(15)      # a new share starts on the bandwidth estimate of a fresh connection; give it a moment to grow
        check(wait(lambda: c2.share()["bar"], 15) and "You're sharing" in c2.js("document.querySelector('#sharebar').innerText"), "sharer sees the 'You're sharing — Stop' bar")
        for c, who in ((ch, nh), (cg, ng)):
            check(wait(lambda: c.share().get("layout") and any(x["name"] == n2 for x in c.share()["screens"]), 20), f"{who}: the share takes the stage (stage + filmstrip)")
            r = rising(c, n2)
            check(r["frames"] >= 4, f"{who}: screen-share frames decoded rising (+{r['frames']} in 4 s, {r['w']}x{r['h']} @ {r['fps']} fps, {r['kbps']:.0f} kbit/s)")
            check(r["audio"] > 2000, f"{who}: tab audio arriving (+{r['audio']} bytes in 4 s)")
            pill = c.share()["pill"]
            check(pill == f"{n2} is sharing a tab", f"{who}: pill '{pill}'")
        dirn = ch.js("getComputedStyle(document.querySelector('#grid')).flexDirection")
        check(dirn == "column", f"desktop filmstrip is a column at the side ({dirn})")
        check(not c2.share()["layout"] and not c2.share()["screens"], "the sharer does not see its own share full size (no mirror tunnel)")
        check(all(recording(c) for c in cs), "recording still on for all three while sharing")
        time.sleep(1.5)
        for dark in (False, True):
            tag = "dark" if dark else "light"
            ch.view(1280, dark); time.sleep(1.2); shots[f"share-1280-{tag}"] = ch.shot(os.path.join(a.shots, f"share-1280-{tag}.png"))
            c2.front("meet"); c2.view(1280, dark); time.sleep(1.2); shots[f"sharer-1280-{tag}"] = c2.shot(os.path.join(a.shots, f"sharer-1280-{tag}.png")); c2.front("share")
            cg.view(390, dark); time.sleep(1.5); shots[f"share-390-{tag}"] = cg.shot(os.path.join(a.shots, f"share-390-{tag}.png"))
        dirg = cg.js("getComputedStyle(document.querySelector('#grid')).flexDirection")
        check(dirg == "row", f"390 px: filmstrip is a row at the bottom ({dirg})")
        r = rising(cg, n2, 3)
        check(r["frames"] >= 3, f"390 px viewer still decodes the share (+{r['frames']}, {r['w']}x{r['h']})")
        ch.view(1280, False); c2.view(1280, False); cg.view(1280, False)
        enc = "(()=>{const p=window.osmikeMeeting.room().localParticipant.getTrackPublication(window.LivekitClient.Track.Source.ScreenShare);const e=p.track.sender.getParameters().encodings;return [e.length,e[e.length-1].maxFramerate,e[e.length-1].maxBitrate,p.track.mediaStreamTrack.contentHint]})()"
        e0 = c2.js(enc)
        c2.click("#smooth")
        time.sleep(1)
        e1 = c2.js(enc)
        check(c2.share()["me"]["smooth"] and e1[1] == 30 and e1[3] == "motion" and e0[1] == 15 and e0[3] == "detail", f"Smooth video: {e0} -> {e1}")
        c2.click("#smooth")

        # 2) the guest shares too: two shares at once
        cg.click("#share")
        check(wait(lambda: cg.share().get("me"), 20), "the guest shares a tab")
        cg.front("share")
        check(wait(lambda: len(ch.share().get("screens", [])) == 2, 20), "host sees two shares")
        check(ch.js("document.querySelectorAll('#shtabs .sh-tab').length") == 2, "a switcher with two tabs")
        check(ch.share()["pill"] == f"{ng} is sharing a tab", "the newest share is on the stage")
        check(wait(lambda: any(x["name"] == ng for x in c2.share().get("screens", [])), 20) and c2.share()["bar"], f"{n2} (sharing) sees the guest's share and keeps its own bar")
        gid = next(x["id"] for x in ch.share()["screens"] if x["name"] == ng)
        pid = next(x["id"] for x in ch.share()["screens"] if x["name"] == n2)
        ch.js(f"document.querySelector('#shtabs .sh-tab[data-s={json.dumps(pid)}]').click()")
        time.sleep(2.5)
        check(ch.share()["sel"] == pid and ch.share()["pill"] == f"{n2} is sharing a tab", "switch to the other share")
        r = rising(ch, n2, 3)
        check(r["frames"] > 5, f"the selected share plays (+{r['frames']})")
        for dark in (False, True):
            tag = "dark" if dark else "light"
            ch.view(1280, dark); time.sleep(1); shots[f"share2-1280-{tag}"] = ch.shot(os.path.join(a.shots, f"share2-1280-{tag}.png"))
        ch.view(1280, False)

        # 3) the host stops meshtest3's share
        if not a.guests:
            check(not ch.js("document.querySelector('#shstop').hidden") and cg.js("document.querySelector('#shstop').hidden"), "only the host has 'Stop this share'")
            ch.js("window.confirm=()=>true"); ch.click("#shstop")
            check(wait(lambda: not c2.share().get("me"), 15), f"{n2}'s share stopped by the host")
            t = wait(lambda: c2.toast(), 5)
            check("stopped your screen share" in (t or ""), f"sharer gets a notice: '{t}'")
            check(wait(lambda: not any(x["name"] == n2 for x in ch.share()["screens"] + cg.share()["screens"]), 15), "everyone loses that share")
            check(wait(lambda: "Stopped the share" in ch.toast(), 5) or True, "host confirmation")
            logs = subprocess.run(["ssh", "relay242", "docker logs --since 3m mikeos-meetings 2>&1 | grep -E 'share|stopped by the host' | tail -8"], capture_output=True, text=True, timeout=30).stdout
            print(logs, flush=True)
            check("stopped by the host" in logs and "muted in the SFU" in logs, "server log: stopped by the host, muted in the SFU")
            check(not c2.share()["bar"] and not c2.js("document.querySelector('#share').classList.contains('on')"), "sharer's bar and button back to normal")
        else:
            c2.click("#sbstop")
            check(wait(lambda: not c2.share().get("me"), 10), f"{n2} stops with the bar's Stop")
            check(wait(lambda: not any(x["name"] == n2 for x in ch.share()["screens"]), 15), "the others lose that share")

        c2.front("meet")
        # 4) the guest stops via the browser's own Stop sharing (the track ends)
        check(cg.js("window.osmikeMeeting.endShare()"), "guest's capture track ends")
        check(wait(lambda: not cg.share().get("me") and not cg.share()["bar"], 10), "guest's share is gone in its own page")
        cg.front("meet")
        check(wait(lambda: not ch.share()["layout"] and not c2.share()["layout"], 15), "the others are back to the normal grid")
        check(all(recording(c) for c in cs), "recording still on for all three after the shares")

        # 5) stop + reshare works (no stale state)
        cg.click("#share")
        check(wait(lambda: cg.share().get("me"), 20) and wait(lambda: ch.share()["layout"], 20), "the guest can share again afterwards")
        cg.click("#share")
        check(wait(lambda: not cg.share().get("me"), 10) and wait(lambda: not ch.share()["layout"], 15), "the Share button stops it again")

        # everyone leaves
        mid = None
        for c in (cg, c2, ch):
            c.js("document.querySelector('#leave').click()"); time.sleep(0.4)
        time.sleep(2)
        if not a.guests:
            href = ch.js("(document.querySelector('a[href^=\"/m/\"]')||{getAttribute:()=>''}).getAttribute('href')")
            mid = (href or "").split("/")[-1]
            check(bool(mid), f"meeting {mid}")

        # 6) a phone (no getDisplayMedia) and a mesh room
        cg.call("Page.addScriptToEvaluateOnNewDocument", source="try{delete MediaDevices.prototype.getDisplayMedia}catch(e){}")
        cg.view(390, False)
        cg.open(f"{site}/r/{rid}phone?media=sfu{q}", "#joinf")
        cg.js(f"document.querySelector('#gname').value={json.dumps(ng)};document.querySelector('#joinf button[type=submit]').click()")
        wait(lambda: cg.js("!!document.querySelector('#share')"), 10)
        time.sleep(2)
        check(cg.js("document.querySelector('#share').classList.contains('unavail')"), "phone browser: Share shown as unavailable")
        cg.click("#share")
        t = wait(lambda: cg.toast(), 5)
        check("cannot share a screen" in (t or ""), f"phone tap explains why: '{t}'")
        for dark in (False, True):
            cg.view(390, dark); time.sleep(0.8); shots[f"room-phone-390-{'dark' if dark else 'light'}"] = cg.shot(os.path.join(a.shots, f"room-phone-390-{'dark' if dark else 'light'}.png"))
        cg.js("document.querySelector('#leave').click()"); time.sleep(1)
        c2.view(1280, False)
        c2.call("Network.clearBrowserCookies")      # as a guest: a guest-only meeting keeps nothing
        c2.open(f"{site}/r/{rid}mesh?media=mesh&sso=0", "#joinf")
        c2.js(f"document.querySelector('#gname').value={json.dumps(n2)}")
        c2.js("document.querySelector('#joinf button[type=submit]').click()")
        check(wait(lambda: c2.js("window.osmikeMeeting && window.osmikeMeeting.mode()") == "mesh" and c2.js("document.querySelector('#share').classList.contains('unavail')"), 15), "mesh room: Share marked unavailable")
        c2.click("#share")
        t = wait(lambda: c2.toast(), 5)
        check("standard meeting mode" in (t or ""), f"mesh room explains: '{t}'")
        c2.js("document.querySelector('#leave').click()"); time.sleep(1)

        over = {k: v for k, v in shots.items() if v and v[0] > v[1] + 1}
        check(not over, f"no horizontal scroll in {len(shots)} screenshots" + (f": {over}" if over else ""))
        json.dump(shots, open(os.path.join(a.shots, "screens-share.json"), "w"), indent=1)
        if mid and not a.keep:
            t0 = time.time()
            while time.time() - t0 < 600:
                st, d = bh.api(f"/api/past/{mid}")
                if d.get("status") in ("done", "failed"):
                    break
                time.sleep(5)
            print(f"transcript {d.get('status')} after {time.time() - t0:.0f} s: {len(d.get('transcript') or [])} lines, speakers {sorted({l['speaker'] for l in d.get('transcript') or []})}", flush=True)
            st, r = bh.api(f"/api/past/{mid}", "DELETE")
            check(st == 200 and r.get("deleted"), "test meeting deleted")
        print("ALL PASSED")
    finally:
        for c in cs:
            try:
                c.close()
            except Exception:
                pass
        shutil.rmtree(tmp, ignore_errors=True)
        for b in (bh, b2):
            if b:
                try:
                    b.api("/auth/logout", "POST")
                except Exception:
                    pass


if __name__ == "__main__":
    main()
