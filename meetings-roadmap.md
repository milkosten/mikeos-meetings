# meetings.osmike.com — Roadmap
Status: ✅ done · 🔜 next · ⬜ not started

## Phase 0 — Baseline (SHIPPED) ✅
- ✅ MikeOS Account sign-in (OAuth Auth-Code + PKCE)
- ✅ Instant meeting + schedule (writes a calendar event to calendar-api.osmike.com, never-trust-200)
- ✅ Upcoming meetings list from the calendar
- ✅ WebRTC mesh video/audio (2–6), same-origin WebSocket signaling
- ✅ Self-hosted STUN/TURN (coturn) — no Google/paid
- ✅ In-room controls: mute, camera toggle, leave, copy link, participant tiles

## Phase 1 — Meeting quality ⬜
- ⬜ Screen share, active-speaker highlight, device pickers, connection/quality indicators
- ⬜ Pre-join lobby (preview mic/cam), grid/spotlight layouts

## Phase 2 — Scale ⬜
- ⬜ SFU (mediasoup/LiveKit self-hosted) for larger meetings; simulcast
- ⬜ TURN over TLS/443 for strict firewalls

## Phase 3 — Collaboration ⬜
- ⬜ In-call chat, reactions, hand-raise; recording -> files.osmike.com
- ⬜ Co-edit data channel (bridge to MikeOffice docmodel)

## Phase 4 — Ecosystem ⬜
- ⬜ Auto meeting notes/transcript (Whisper) -> MikeBrief; "Join" from MikeTime + calendar.osmike.com
- ⬜ Native MikeMeet Android app on the same signaling/SFU

## Phase 5 — Hardening ⬜
- ⬜ Durable sessions, rate-limit, mobile polish, a11y, i18n
