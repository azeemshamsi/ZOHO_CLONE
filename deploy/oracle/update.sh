#!/usr/bin/env bash
# Pull the latest code from GitHub, rebuild and restart. Run on the server (GitHub Actions runs it after every push).
set -euo pipefail
cd /opt/ordexago
git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ "${1:-}" != "--force" ]; then echo "Already up to date"; exit 0; fi
git reset --hard origin/main
npm run build
sudo systemctl restart ordexago
for i in $(seq 1 30); do sleep 2; curl -fsS http://127.0.0.1:8080/api/health >/dev/null && { echo "Updated to $(git log -1 --format='%h %s')"; exit 0; }; done
echo "App didn't come back up — see: sudo journalctl -u ordexago -n 100"; exit 1
