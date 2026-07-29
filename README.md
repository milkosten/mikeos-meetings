# mikeos-meetings — meetings.osmike.com

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
- `/auth/*`, `/api/me` — OAuth session.
- `POST /api/rooms` — instant room. `POST /api/meetings` — schedule (writes to calendar,
  never-trust-200). `GET /api/meetings` — upcoming. `GET /api/ice` — ICE server list.
- `/ws` — WebSocket signaling (join/welcome/peer-joined/signal/peer-left).
- `/r/<id>` — room (client-routed).
