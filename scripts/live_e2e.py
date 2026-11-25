#!/usr/bin/env python3
"""Live end-to-end test of meetings.osmike.com with two real headless Chromes (fake camera + a WAV file as microphone).

  python3 scripts/live_e2e.py [--keep] [--shots DIR]

meshtest4 (signed in, host) and a guest without an account ("Gustav Gäst") meet in a fresh room; each Chrome "speaks"
its own Swedish espeak-ng recording. Proves: the guest must type a name; the recorded notice is shown; when the host
ends the meeting the transcript (both speakers) + summary appear under Previous meetings; meshtest5 (signed in, not in
the meeting) gets 404. Takes screenshots (390/1280 x light/dark). Deletes the test meeting at the end unless --keep.
Stdlib only + google-chrome + espeak-ng. Passwords from ~/.config/osmike/ai-keys.env (never printed).
"""
import argparse, base64, html, http.cookiejar, json, os, re, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request
sys.path.insert(0, "/opt/projects/mikeos-laptop-ui/stats")
from osmike_surf import WS  # stdlib websocket client for CDP

SITE, ACCOUNT = "https://meetings.osmike.com", "https://account.osmike.com"
SID = "__Host-meetings-sid"
A_TEXT = ("Hej allihop och välkomna till planeringsmötet. Vi har bestämt att den nya webbplatsen lanseras på fredag. "
          "Jag tar ansvar för att skriva pressmeddelandet och skickar det till torsdag. Budgeten för kampanjen är femtio tusen kronor.")
B_TEXT = ("Tack. Jag håller med om att vi lanserar på fredag. Jag ordnar testerna av betalningen på onsdag "
          "och bokar ett uppföljningsmöte nästa måndag klockan tio.")


def env(name):
    for line in open(os.path.expanduser("~/.config/osmike/ai-keys.env")):
        line = line.strip().removeprefix("export ")
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit(f"{name} missing")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Browser:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)

    def req(self, url, data=None, headers=None, method=None, js=None):
        body = urllib.parse.urlencode(data).encode() if data is not None else (json.dumps(js).encode() if js is not None else None)
        h = {"User-Agent": "osmike-meetings-e2e", **(headers or {})}
        if js is not None:
            h["Content-Type"] = "application/json"
        r = urllib.request.Request(url, data=body, headers=h, method=method)
        try:
            resp = self.op.open(r, timeout=30)
        except urllib.error.HTTPError as e:
            resp = e
        return resp.status if hasattr(resp, "status") else resp.code, resp.headers, resp.read().decode("utf-8", "replace")

    def to_callback(self, user, password):
        st, h, _ = self.req(SITE + "/auth/login")
        assert st == 302 and h["Location"].startswith(ACCOUNT + "/oauth/authorize"), (st, h.get("Location"))
        st, h, body = self.req(h["Location"])
        if st == 302:
            return h["Location"]
        fields = {m.group(1): html.unescape(m.group(2)) for m in re.finditer(r'<input type="hidden" name="([^"]+)" value="([^"]*)"', body)}
        fields.update(email=user, password=password)
        st, h, body = self.req(ACCOUNT + "/oauth/authorize/decision", fields)
        assert st in (302, 303) and h["Location"].startswith(SITE + "/auth/callback"), (st, h.get("Location"), body[:200])
        return h["Location"]

    def sid(self):
        return next(c.value for c in self.jar if c.name == SID)

    def api(self, path, method="GET", js=None):
        me = json.loads(self.req(SITE + "/api/me")[2])
        st, _, body = self.req(SITE + path, method=method, js=js, headers={"X-CSRF": me.get("csrf", "")} if method != "GET" else None)
        try:
            return st, json.loads(body)
        except ValueError:
            return st, {}


def check(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg, flush=True)
    if not ok:
        sys.exit(1)


class Chrome:
    def __init__(self, port, wav, tmp):
        self.dir = tempfile.mkdtemp(prefix=f"chrome{port}-", dir=tmp)
        self.p = subprocess.Popen(["google-chrome", "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={self.dir}",
                                   "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={wav}",
                                   "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check", "--window-size=1280,860",
                                   "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
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

    def open(self, url, wait_for=None):
        self.call("Page.navigate", url=url)
        for _ in range(100):
            time.sleep(0.25)
            try:
                if self.js("document.readyState") == "complete" and (not wait_for or self.js(f"!!document.querySelector({json.dumps(wait_for)})")):
                    break
            except Exception:
                pass
        time.sleep(0.6)

    def view(self, width, dark):
        self.call("Emulation.setDeviceMetricsOverride", width=width, height=860 if width > 600 else 844, deviceScaleFactor=1, mobile=width < 600)
        self.call("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": "dark" if dark else "light"}])

    def shot(self, path):
        time.sleep(0.5)
        d = self.call("Page.captureScreenshot", format="png", captureBeyondViewport=True)
        open(path, "wb").write(base64.b64decode(d["data"]))
        return self.js("[document.documentElement.scrollWidth, window.innerWidth]")

    def close(self):
        try:
            self.p.terminate(); self.p.wait(5)
        except Exception:
            self.p.kill()
        shutil.rmtree(self.dir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--media", choices=["", "sfu", "mesh"], default="", help="force the media path (?media=); default: the server's")
    ap.add_argument("--shots", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "screens"))
    a = ap.parse_args()
    mq = f"?media={a.media}" if a.media else ""
    os.makedirs(a.shots, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="meet-e2e-")
    shots = {}
    b4, b5 = Browser(), Browser()
    st, _, _ = b4.req(b4.to_callback("meshtest4@osmike.com", env("MESHTEST4_PASSWORD")))
    check(st == 302, "meshtest4 signed in")
    cb5 = b5.to_callback("meshtest5@osmike.com", env("MESHTEST5_PASSWORD"))
    st, _, body = b4.req(cb5)
    check(st == 400 and "another browser" in body, "meshtest5's callback refused in meshtest4's browser")
    st, _, _ = b5.req(cb5)
    check(st == 302, "meshtest5 signed in with its own callback")
    me4 = json.loads(b4.req(SITE + "/api/me")[2])["user"]
    check(bool(me4.get("name")), f"meshtest4 is {me4['name']}")
    st, room = b4.api("/api/rooms", "POST", {"title": "E2E testmöte"})
    check(st == 200 and room.get("room_id"), f"room {room.get('room_id')}")
    rid = room["room_id"]

    wa, wb = os.path.join(tmp, "a.wav"), os.path.join(tmp, "b.wav")
    subprocess.run(["espeak-ng", "-v", "sv", "-s", "135", "-w", wa, A_TEXT], check=True)
    subprocess.run(["espeak-ng", "-v", "sv+m3", "-s", "135", "-w", wb, B_TEXT], check=True)
    ca, cg = Chrome(9411, wa, tmp), Chrome(9412, wb, tmp)
    try:
        ca.call("Network.setCookie", name=SID, value=b4.sid(), url=SITE + "/", secure=True, httpOnly=True, sameSite="Lax", path="/")
        # guest: the join screen asks for a name and refuses an empty one
        cg.view(390, False)
        cg.open(f"{SITE}/r/{rid}{mq}", "#joinf")
        txt = cg.js("document.body.innerText")
        check("Your name" in txt and "recorded and transcribed" in txt, "guest join screen asks for a name and says the meeting is recorded")
        shots["join-guest-390-light"] = cg.shot(os.path.join(a.shots, "join-guest-390-light.png"))
        cg.js("document.querySelector('#gname').value='';document.querySelector('#joinf button[type=submit]').click()")
        time.sleep(0.8)
        check("Type your name to join" in cg.js("document.body.innerText"), "empty name refused")
        cg.view(1280, False)
        ca.view(1280, False)
        ca.open(f"{SITE}/r/{rid}{mq}", "#joinf")
        check(f"You join as {me4['name']}" in ca.js("document.body.innerText"), "signed-in person joins with the account name, no name field")
        shots["join-signedin-1280-light"] = ca.shot(os.path.join(a.shots, "join-signedin-1280-light.png"))
        ca.js("document.querySelector('#joinf button[type=submit]').click()")
        time.sleep(3)
        cg.js("document.querySelector('#gname').value='Gustav Gäst';document.querySelector('#joinf button[type=submit]').click()")
        for _ in range(40):
            time.sleep(0.5)
            if ca.js("document.querySelectorAll('.tile').length") >= 2 and cg.js("document.querySelectorAll('.tile').length") >= 2:
                break
        check(ca.js("document.querySelectorAll('.tile').length") >= 2, "both are in the call (video tiles)")
        check("Recorded" in ca.js("document.querySelector('.rec').innerText"), "room shows the Recorded indicator")
        names = ca.js("[...document.querySelectorAll('.tile .nm')].map(x=>x.textContent)")
        check(any("Gustav Gäst" in n for n in names), f"host sees the guest by name: {names}")
        check(not ca.js("document.querySelector('#endall').hidden") and cg.js("document.querySelector('#endall').hidden"), "only the host has End for all")
        mode = ca.js("window.osmikeMeeting && window.osmikeMeeting.mode ? window.osmikeMeeting.mode() : 'mesh'")
        print(f"media path: {mode}", flush=True)
        if a.media:
            check(mode == a.media and cg.js("window.osmikeMeeting.mode()") == a.media, f"both use the {a.media} path")
        if mode == "sfu":
            time.sleep(4)
            st0 = ca.js("window.osmikeMeeting.stats()") or {}
            check(any(r["frames"] > 0 for r in st0.get("remotes", [])), "host decodes the guest's video through the SFU")
        print("talking for 45 s ...", flush=True)
        time.sleep(20)
        shots["room-1280"] = ca.shot(os.path.join(a.shots, "room-1280.png"))
        # the guest's socket drops (no Leave): it must come back to the same place, the host never loses the guest
        cg.js("window.osmikeMeeting.dropSocket()")
        time.sleep(5)
        check("in call" in cg.js("document.querySelector('#cnt').textContent") and any("Gustav Gäst" in n for n in ca.js("[...document.querySelectorAll('.tile .nm')].map(x=>x.textContent)")),
              "a dropped socket resumes: guest back in the call, host still sees the guest")
        time.sleep(20)
        ca.js("window.confirm=()=>true;document.querySelector('#endall').click()")
        time.sleep(4)
        check("meeting ended" in cg.js("document.body.innerText").lower(), "guest sees that the host ended the meeting")
        check("Open the meeting notes" in ca.js("document.body.innerText"), "host gets a link to the meeting notes")
        mid = ca.js("document.querySelector('a[href^=\"/m/\"]').getAttribute('href')").split("/")[-1]
        t0 = time.time()
        while time.time() - t0 < 600:
            st, d = b4.api(f"/api/past/{mid}")
            if d.get("status") in ("done", "failed"):
                break
            time.sleep(5)
        print(f"processed in {time.time() - t0:.0f} s: status {d.get('status')} {d.get('error') or ''}", flush=True)
        check(d.get("status") == "done", "transcribed and summarised")
        speakers = {l["speaker"] for l in d["transcript"]}
        check({me4["name"], "Gustav Gäst"} <= speakers, f"transcript has both speakers: {speakers}")
        check(d["language"] == "sv", "language detected: Swedish")
        alltext = " ".join(l["text"] for l in d["transcript"]).lower()
        check("fredag" in alltext, "transcript content: " + alltext[:160])
        s = d["summary"] or {}
        print("summary:", json.dumps(s, ensure_ascii=False)[:900], flush=True)
        check(bool(s.get("overview")) and (s.get("decisions") or s.get("action_items")), "summary with decisions/action items")
        st, lst = b4.api("/api/past")
        check(any(m["id"] == mid for m in lst["meetings"]), "listed under Previous meetings for the host")
        st, _ = b5.api(f"/api/past/{mid}")
        check(st == 404, "meshtest5 (not in the meeting) gets 404 from the API")
        st, _, _ = b5.req(f"{SITE}/m/{mid}")
        check(st == 404, "meshtest5 gets HTTP 404 on the meeting page")
        st, lst5 = b5.api("/api/past")
        check(not any(m["id"] == mid for m in lst5["meetings"]), "not in meshtest5's list")
        # screenshots of the new pages
        for w in (390, 1280):
            for dark in (False, True):
                ca.view(w, dark)
                tag = f"{w}-{'dark' if dark else 'light'}"
                ca.open(f"{SITE}/m/{mid}", ".transcript"); shots[f"meeting-{tag}"] = ca.shot(os.path.join(a.shots, f"meeting-{tag}.png"))
                ca.open(f"{SITE}/", "#past .rows"); shots[f"home-{tag}"] = ca.shot(os.path.join(a.shots, f"home-{tag}.png"))
                ca.open(f"{SITE}/past", "#past .rows"); shots[f"past-{tag}"] = ca.shot(os.path.join(a.shots, f"past-{tag}.png"))
        cg.view(390, True); cg.open(f"{SITE}/r/{rid}", "#joinf"); shots["join-guest-390-dark"] = cg.shot(os.path.join(a.shots, "join-guest-390-dark.png"))
        over = {k: v for k, v in shots.items() if v and v[0] > v[1] + 1}
        check(not over, f"no horizontal scroll on any page ({len(shots)} screenshots)" + (f": {over}" if over else ""))
        json.dump(shots, open(os.path.join(a.shots, "screens.json"), "w"), indent=1)
        print("MEETING", mid)
        if not a.keep:
            st, d = b4.api(f"/api/past/{mid}", "DELETE")
            check(st == 200 and d.get("deleted"), "test meeting deleted")
            check(b4.api(f"/api/past/{mid}")[0] == 404, "gone afterwards")
        print("ALL PASSED")
    finally:
        ca.close(); cg.close(); shutil.rmtree(tmp, ignore_errors=True)
        for b in (b4, b5):
            try:
                b.api("/auth/logout", "POST")
            except Exception:
                pass


if __name__ == "__main__":
    main()
