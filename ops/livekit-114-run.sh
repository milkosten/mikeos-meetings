#!/bin/sh
# LiveKit SFU on relay 114 (2026-11-25). Host network (UDP 7882 mux + TCP 7881 public; HTTP/WS 7880 only on
# 127.0.0.1 + docker0 for Caddy). Pinned version. Keys: /opt/osmike-livekit/.env (LIVEKIT_KEYS="<key>: <secret>").
# Install: copy ops/livekit-114.yaml to /opt/osmike-livekit/livekit.yaml and this file to /opt/osmike-livekit/run.sh.
set -e
cd /opt/osmike-livekit
docker rm -f osmike-livekit >/dev/null 2>&1 || true
exec docker run -d --name osmike-livekit --restart unless-stopped --network host \
  --env-file /opt/osmike-livekit/.env -v /opt/osmike-livekit/livekit.yaml:/etc/livekit.yaml:ro \
  --memory 2g --cpus 8 --log-opt max-size=20m --log-opt max-file=3 \
  livekit/livekit-server:v1.13.11 --config /etc/livekit.yaml
