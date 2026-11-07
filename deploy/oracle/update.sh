#!/usr/bin/env bash
# Pull the latest code from GitHub, rebuild and restart. Run on the server (GitHub Actions runs it after every push).
set -euo pipefail
cd /opt/ordexago
git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ "${1:-}" != "--force" ]; then echo "Already up to date"; exit 0; fi
git reset --hard origin/main
npm run build
# Allow big imports (older setups had a 50 MB limit).
if sudo grep -q "client_max_body_size 50m" /etc/nginx/sites-available/ordexago 2>/dev/null; then
  sudo sed -i 's/client_max_body_size 50m;/client_max_body_size 100m;/' /etc/nginx/sites-available/ordexago && sudo nginx -t && sudo systemctl reload nginx
fi
# Don't reveal the nginx version (security scan finding). Never fails the deploy; undone if nginx rejects it.
if ! sudo grep -qE '^\s*server_tokens\s+off;' /etc/nginx/nginx.conf 2>/dev/null && sudo grep -qE '^\s*#\s*server_tokens\s+off;' /etc/nginx/nginx.conf 2>/dev/null; then
  sudo sed -i -E 's/^(\s*)#\s*server_tokens\s+off;/\1server_tokens off;/' /etc/nginx/nginx.conf
  if sudo nginx -t 2>/dev/null; then sudo systemctl reload nginx || true; else sudo sed -i -E 's/^(\s*)server_tokens off;/\1# server_tokens off;/' /etc/nginx/nginx.conf; fi
fi
sudo systemctl restart ordexago
for i in $(seq 1 30); do sleep 2; curl -fsS http://127.0.0.1:8080/api/health >/dev/null && { echo "Updated to $(git log -1 --format='%h %s')"; exit 0; }; done
echo "App didn't come back up — see: sudo journalctl -u ordexago -n 100"; exit 1
