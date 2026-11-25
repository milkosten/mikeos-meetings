#!/bin/sh
# TURN/STUN for meetings.osmike.com (moved here from 242 on 2026-11-25: the Hetzner firewall in front of 242 blocks 3478/UDP).
# Ports: every browser allocates a relay (UDP + TCP candidate) per other person, so a 10-person mesh needs ~180
# relay ports and ~18 allocations per browser: wide port range + user-quota 100 (usernames are unique per browser).
. /opt/osmike-turn/.env
docker rm -f osmike-turn >/dev/null 2>&1
exec docker run -d --name osmike-turn --restart unless-stopped --network host coturn/coturn:latest \
  -n --use-auth-secret --static-auth-secret="$TURN_SECRET" --realm=meetings.osmike.com --server-name=turn.osmike.com \
  --listening-port=3478 --min-port=49152 --max-port=65535 --external-ip=144.76.45.114 --no-tls --no-cli \
  --fingerprint --stale-nonce --no-multicast-peers --user-quota=100 --total-quota=4000 --simple-log --log-file=stdout \
  --denied-peer-ip=10.0.0.0-10.255.255.255 --denied-peer-ip=172.16.0.0-172.31.255.255 --denied-peer-ip=192.168.0.0-192.168.255.255 --denied-peer-ip=127.0.0.0-127.255.255.255
