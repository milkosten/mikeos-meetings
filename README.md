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

## Link formats
- `https://meetings.osmike.com/r/<room>` — join (guests type a name)
- `https://meetings.osmike.com/m/<meeting>` — notes of one past meeting (participants only)
- `https://meetings.osmike.com/past` — all your previous meetings (search titles, people and what was said)

## Tests
- Offline: `docker build -t mikeos-meetings:test . && docker run --rm mikeos-meetings:test node --test test/`
- Live: `python3 scripts/live_e2e.py` (two headless Chromes with espeak WAVs as microphones; meshtest4 host + a guest,
  meshtest5 must get 404; screenshots into docs/screens; deletes its meeting). `scripts/live_gpu.mjs` checks STT + Qwen.
- Agents: `osmike-meetings past|notes ID|transcript ID` (osmike-cli) → osmike-runs `/v1/runs/meetings/past` →
  `/api/agent/meetings` here with the person's account token.

Real-time video meetings for MikeOS. WebRTC **mesh** (peer-to-peer, good for 2–6),
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
