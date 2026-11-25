#!/bin/sh
# TURN/STUN for meetings.osmike.com (moved here from 242 on 2026-11-25: the Hetzner firewall in front of 242 blocks 3478/UDP).
. /opt/osmike-turn/.env
docker rm -f osmike-turn >/dev/null 2>&1
exec docker run -d --name osmike-turn --restart unless-stopped --network host coturn/coturn:latest \
  -n --use-auth-secret --static-auth-secret="$TURN_SECRET" --realm=meetings.osmike.com --server-name=turn.osmike.com \
  --listening-port=3478 --min-port=49160 --max-port=49200 --external-ip=144.76.45.114 --no-tls --no-cli \
  --fingerprint --stale-nonce --no-multicast-peers --user-quota=12 --total-quota=1200 --simple-log --log-file=stdout \
  --denied-peer-ip=10.0.0.0-10.255.255.255 --denied-peer-ip=172.16.0.0-172.31.255.255 --denied-peer-ip=192.168.0.0-192.168.255.255 --denied-peer-ip=127.0.0.0-127.255.255.255
