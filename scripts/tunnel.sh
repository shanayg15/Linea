#!/usr/bin/env bash
# Keeps a public HTTPS tunnel to :8787 up for Twilio, and writes its URL into .env as PUBLIC_BASE_URL every time it
# (re)connects. The server re-reads PUBLIC_BASE_URL before each call, so a dropped tunnel heals itself — no restart.
# Usage: npm run tunnel   (leave it running)
cd "$(dirname "$0")/.."
set_url() {
  sed -i '' "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=$1#" .env
  echo "[tunnel] PUBLIC_BASE_URL=$1  (live calls will use this)"
}
while true; do
  echo "[tunnel] connecting to localhost.run…"
  ssh -tt -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
    -R 80:localhost:8787 nokey@localhost.run 2>&1 | while IFS= read -r line; do
      url="$(printf '%s' "$line" | grep -oE 'https://[a-z0-9.-]+\.lhr\.life' | head -1)"
      if [ -n "$url" ]; then set_url "$url"; fi
    done
  echo "[tunnel] dropped — reconnecting in 2 s"
  sleep 2
done
