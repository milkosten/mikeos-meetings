# mikeos-meetings — meetings.osmike.com

**Recorded meetings (2026-11-25).** Every meeting is recorded and transcribed — shown on the join screen and as a
"Recorded" pill in the call. Each browser records only its own microphone (MediaRecorder, opus, 4 s chunks over the
signaling socket) into `/data/meetings/meetings/<id>/audio/` (242 RAID6). The meeting ends when everyone has left for
45 s or the host presses *End for all*; then `lib/pipeline.js` cuts the audio into ≤150 s pieces, skips silent ones,
transcribes them with Whisper large-v3-turbo on the Kittelfjäll GPU (`STT_URL`, Bearer `GPU_OSMIKE_TOKEN`, 429 = wait),
picks the meeting's language (sv/en by speech time) and writes a summary (overview, key points, decisions, action items
with owners) with Qwen on gpu.osmike.com (`/api/chat`, num_ctx 12288; long meetings in parts). Nothing goes to an
outside AI service. Visible only to the host and the signed-in people who were in it (others: 404); a meeting with only
guests keeps nothing. Guests (no account) type their name before joining. If the room is on a calendar event, the
meeting links to it (and to its CRM customer).

## Media paths: SFU (LiveKit) and mesh (2026-11-25)
- **SFU** — LiveKit `livekit/livekit-server:v1.13.11` (Apache-2.0) on **relay 114** (`osmike-livekit`, host network,
  `/opt/osmike-livekit/{livekit.yaml,run.sh,.env}`; copies in `ops/livekit-114.*`). Signaling `wss://livekit.osmike.com`
  (114 Caddy → `172.17.0.1:7880`), media **UDP 7882** (one port, all participants) + **TCP 7881** fallback, plus our
  coturn on 114 as TURN (the browser gets `/api/ice`). No participant ceiling. Each browser uploads ONE camera stream as
  simulcast (180p/360p/540p); LiveKit forwards to everyone the layer that fits (adaptiveStream + dynacast).
  Client: `public/static/vendor/livekit-client-2.23.0.umd.js` (pinned, vendored, loaded only for SFU rooms).
- **Mesh** — the old peer-to-peer path (good for 2–6).
- The `/ws` socket stays the authority on both paths: presence, names, per-browser recording, end of meeting. On the
  SFU path the server mints a short-lived LiveKit token in `welcome` (identity = peer id, name = account name or the
  guest's typed name, room = the meeting id), removes a person from LiveKit when their socket leaves and deletes the
  LiveKit room when the meeting ends. Keys: secretz `livekit-api-key` / `livekit-api-secret`, `.env` on 242
  (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`).
- **Flag:** `MEETINGS_MEDIA=sfu|mesh` (compose, from `.env`) picks the path for new rooms; the first person in a room
  decides and everyone in that meeting uses the same path. `/r/<room>?media=mesh|sfu` overrides it for one room
  (tests). Without LiveKit keys every room is mesh. **Way back to mesh:** on 242
  `cd /opt/mikeos-meetings && sed -i 's/^MEETINGS_MEDIA=.*/MEETINGS_MEDIA=mesh/' .env && docker compose --env-file .env up -d mikeos-meetings`
  (restarting ends meetings that are running), or for one meeting just send people `/r/<room>?media=mesh`.
- Dropped sockets: a socket that closes without Leave keeps its place for 30 s (`RESUME_MS`); the browser reconnects
  with the resume key from its welcome (same peer id, same LiveKit identity; the browser keeps recording meanwhile and
  sends the kept audio into the same segment with `rec-resume`). Caddy on 242 and 114
  has `stream_close_delay 12h` so config reloads (other sites) no longer cut meeting sockets.
- Recording robustness (2026-11-25): a MediaRecorder dies silently when its microphone track ends or is swapped
  (LiveKit re-acquires an ended mic itself and mutes the publication if that fails). The browser restarts its recorder
  when the mic track changes/ends, the recorder stops, no chunk came for 10 s while unmuted, or the server sends
  `rec-restart` (someone in the meeting with no audio for `NO_AUDIO_MS`=20 s; logged). In SFU mode it waits for
  LiveKit's own restart before taking the mic, and keeps the mic on exactly when the person has it on. `●Rec` in the
  call shows your own state (dashed = reconnecting / not recording). The server logs join/leave/drop/resume/restarts
  per person. Live test: `scripts/live_rec_e2e.py` (3 Chromes on the SFU, ws drop, mute, mic switch, mic ended,
  recorder death; then the meeting page right after the end).
- Meeting page before it is done: `live` (running → "still going on"; ending → "Transcribing…"), `queued`/`processing`
  ("Transcribing… (part n of N)", `progress` in the API), then the transcript appears without a reload. "No speech was
  recorded" only when done with zero lines; failed shows the error. The Previous meetings list polls the same way.
- Load test: `scripts/load_sfu.py` (same flags as `load_mesh.py`, plus `--tcp K` = TURN over TCP only).
- Follow-up: TURN over TLS on 443 for strict corporate firewalls (needs Caddy layer4 or a second IP on 114).

## Screen sharing (2026-11-25, SFU rooms)
- **Share** button in the call bar (everyone, guests too). Chrome/Edge open the picker on *This tab / Window / Entire
  screen* with tabs first (`displaySurface:'browser'`), offer the tab's sound, never offer the meeting tab itself
  (`selfBrowserSurface:'exclude'`), allow switching what is shared (`surfaceSwitching:'include'`), no system audio.
  Firefox/Safari: window or screen, no sound. Browsers without `getDisplayMedia` (phones, tablets): the button is dimmed
  and a tap explains why; they can still watch. Mesh rooms: "Sharing needs the standard meeting mode" (no mesh sharing).
- Published as LiveKit `ScreenShare` (+ `ScreenShareAudio` for tab sound), name `screen:<browser|window|monitor>`; the
  camera keeps running. One full-size VP8 layer: text = `contentHint 'detail'`, 15 fps, ≤2.5 Mbit/s,
  keep-resolution; the sharer's **Smooth video** tick = `'motion'`, 30 fps, ≤4 Mbit/s, keep-frame-rate (changed live,
  remembered per browser). No spatial simulcast for the share: measured live, an extra 360p layer stalled Chrome's
  bandwidth estimate at 0.5–0.9 Mbit/s and viewers got 427x239 for 45 s+; one layer gave 1280x716 @15 fps within 5 s.
- Viewers: the share takes the stage, people become a filmstrip (right side on desktop, a row at the bottom ≤640 px),
  pill "Name is sharing a tab/a window/their screen", two or more shares get a switcher (newest first on stage; hidden
  ones are paused by the SFU). Pinch / ctrl+wheel zoom, drag while zoomed, double tap resets; full-screen button (locks
  landscape where allowed, iPhone uses the video's own full screen). The sharer gets a "You're sharing" bar with a small
  preview, Smooth video and Stop, and never sees its own share full size. The browser's own *Stop sharing* ends it in
  the meeting too (track `ended`).
- **Host stop**: the host sees *Stop this share* on someone else's share → `/ws {type:'stop-share', target}` → the
  server checks host (signed in, `host_sub`), SFU room, target in the meeting, tells the sharer (`share-stopped`, they
  get a notice) and mutes exactly their `SCREEN_SHARE`/`SCREEN_SHARE_AUDIO` tracks in LiveKit (`GetParticipant` →
  `MutePublishedTrack`), answer `stop-share-result`. Everyone else gets `only_the_host_can_stop_shares`. Logged.
- Recording: unchanged. Tab/system audio is never recorded or transcribed: each browser records only its microphone
  publication; the share's audio is a separate LiveKit track that is only played to the others.
- Tests: `test/share.test.js` (offline); live `scripts/live_share_e2e.py` (3 Chromes; `--site` + `--guests` for a staging
  server), load `scripts/load_share.py` (one sharer + N viewers, CPU/bitrate).

## Link formats
- `https://meetings.osmike.com/r/<room>` — join (guests type a name)
- `https://meetings.osmike.com/m/<meeting>` — notes of one past meeting (participants only)
- `https://meetings.osmike.com/past` — all your previous meetings (search titles, people and what was said)

## Tests
- Offline: `docker build -t mikeos-meetings:test . && docker run --rm mikeos-meetings:test node --test test/`
- Live sharing: `python3 scripts/live_share_e2e.py` (see Screen sharing).
- Live: `python3 scripts/live_e2e.py` (two headless Chromes with espeak WAVs as microphones; meshtest4 host + a guest,
  meshtest5 must get 404; screenshots into docs/screens; deletes its meeting). `scripts/live_gpu.mjs` checks STT + Qwen.
- Agents: `osmike-meetings past|notes ID|transcript ID` (osmike-cli) → osmike-runs `/v1/runs/meetings/past` →
  `/api/agent/meetings` here with the person's account token.

Real-time video meetings for MikeOS. LiveKit **SFU** or WebRTC **mesh** (see Media paths above),
same-origin **WebSocket signaling**, self-hosted **STUN/TURN (coturn)** — zero Google,
zero paid services, zero CDNs. Sign in with a MikeOS Account (OAuth2 Auth-Code+PKCE
against account.osmike.com). Scheduled meetings are written to the MikeOS-native
calendar (`mikeos-events`, at calendar-api.osmike.com) as `type:"calendar"` events, so
they appear in MikeTime / a future calendar.osmike.com UI.

## Run / deploy (242 box)
`docker compose --env-file .env up -d --build` then `./deploy.sh` (adds the Caddy block).
Containers: `mikeos-meetings` (app, :8095, deploy_default) + `mikeos-meetings-turn`
(coturn, host net, UDP/TCP 3478 + relay 49160–49200).

## Endpoints
- `/auth/*`, `/api/me` — OAuth session (server-side, `__Host-meetings-sid`, state bound to the browser, identity from userinfo).
- `GET /api/past`, `GET|DELETE /api/past/<id>` — previous meetings (DELETE: host only, `X-CSRF`). `GET /api/agent/meetings[/<id>]` — Bearer account token.
- `POST /api/rooms` — instant room. `POST /api/meetings` — schedule (writes to calendar,
  never-trust-200). `GET /api/meetings` — upcoming. `GET /api/ice` — ICE server list.
- `/ws` — WebSocket signaling (join/welcome/peer-joined/signal/peer-left).
- `/r/<id>` — room (client-routed).
