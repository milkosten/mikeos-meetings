#!/usr/bin/env bash
# Idempotent deploy of MikeMeetings to the 242 box. Re-running is safe.
# Builds/starts ONLY mikeos-meetings + mikeos-meetings-turn (coturn, host net); opens
# the coturn UDP/TCP ports; appends the meetings.osmike.com Caddy block IF missing then
# `caddy reload`. NEVER touches any other container. NEVER sed -i the Caddyfile (that
# replaces the inode and breaks its read-only bind-mount) — always append with `cat >>`.
set -euo pipefail
APP_DIR="/opt/mikeos-meetings"
CADDYFILE="/opt/mikephotos/deploy/Caddyfile"
ENV="${APP_DIR}/.env"

# 1) secrets (persisted, stable across redeploys)
$(: "ensure env exists on box handled by caller"); [ -f "${ENV}" ] || { echo "MISSING ${ENV}"; exit 1; }

# 2) open coturn ports (STUN/TURN 3478 + relay range) — ufw if active, else assume open
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 3478/udp  >/dev/null 2>&1 || true
  ufw allow 3478/tcp  >/dev/null 2>&1 || true
  ufw allow 49160:49200/udp >/dev/null 2>&1 || true
  echo "==> ufw: opened 3478 (udp/tcp) + 49160-49200/udp"
else
  echo "==> no active ufw; assuming 3478 + 49160-49200/udp are open at the host/cloud firewall"
fi

# 3) build + up (our two containers only)
echo "==> build + up"; cd "${APP_DIR}"; docker compose --env-file .env up -d --build

# 4) Caddy: meetings.osmike.com -> mikeos-meetings:8095 (Caddy proxies WebSocket automatically)
if ! grep -q "^meetings.osmike.com {" "${CADDYFILE}"; then
  cat >> "${CADDYFILE}" <<'BLK'

meetings.osmike.com {
	encode zstd gzip
	# keep the meeting sockets (/ws) open across Caddy config reloads (default: closed on every reload)
	reverse_proxy mikeos-meetings:8095 {
		stream_close_delay 12h
	}
}
BLK
  echo "   appended meetings.osmike.com"
else echo "   meetings.osmike.com already present"; fi
echo "==> graceful caddy reload"; docker exec deploy-caddy-1 caddy reload --config /etc/caddy/Caddyfile
sleep 3
echo "==> health:"; docker exec mikeos-meetings wget -qO- http://localhost:8095/healthz 2>/dev/null || true; echo
