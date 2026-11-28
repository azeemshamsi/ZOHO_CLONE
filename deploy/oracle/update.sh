#!/usr/bin/env bash
# Pull the latest code from GitHub, rebuild and restart. Run on the server (GitHub Actions runs it after every push).
set -euo pipefail
cd /opt/ordexago
git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ "${1:-}" != "--force" ]; then echo "Already up to date"; exit 0; fi
git reset --hard origin/main
# Keep the previous builds' files for a week: pages opened before this update still find their scripts
# (otherwise "Failed to fetch dynamically imported module" until they reload).
OLD=/opt/ordexago/.old-assets
mkdir -p "$OLD"
[ -d frontend/dist/assets ] && cp -n frontend/dist/assets/* "$OLD"/ 2>/dev/null || true
npm run build
cp -n "$OLD"/* frontend/dist/assets/ 2>/dev/null || true
find "$OLD" -type f -mtime +7 -delete 2>/dev/null || true
# Allow big imports (older setups had a 50 MB limit).
if sudo grep -q "client_max_body_size 50m" /etc/nginx/sites-available/ordexago 2>/dev/null; then
  sudo sed -i 's/client_max_body_size 50m;/client_max_body_size 100m;/' /etc/nginx/sites-available/ordexago && sudo nginx -t && sudo systemctl reload nginx
fi
# Don't reveal the nginx version (security scan finding). Never fails the deploy; undone if nginx rejects it.
if ! sudo grep -qE '^\s*server_tokens\s+off;' /etc/nginx/nginx.conf 2>/dev/null && sudo grep -qE '^\s*#\s*server_tokens\s+off;' /etc/nginx/nginx.conf 2>/dev/null; then
  sudo sed -i -E 's/^(\s*)#\s*server_tokens\s+off;/\1server_tokens off;/' /etc/nginx/nginx.conf
  if sudo nginx -t 2>/dev/null; then sudo systemctl reload nginx || true; else sudo sed -i -E 's/^(\s*)server_tokens off;/\1# server_tokens off;/' /etc/nginx/nginx.conf; fi
fi
# The app listens only on 127.0.0.1 (nginx is the only way in).
if [ -f backend/.env ] && ! grep -qE '^HOST=' backend/.env; then
  [ -n "$(tail -c1 backend/.env)" ] && echo >> backend/.env   # the file may not end with a newline
  echo "HOST=127.0.0.1" >> backend/.env
fi
sudo systemctl daemon-reload || true
sudo systemctl restart ordexago
for i in $(seq 1 30); do sleep 2; curl -fsS http://127.0.0.1:8080/api/health >/dev/null && { echo "Updated to $(git log -1 --format='%h %s')"; sudo journalctl -u ordexago --since "-3 hours" --no-pager 2>/dev/null | grep -E "Startup|Migration|failed|Could not|No-discount|\[tracking\]" | tail -200 || true; exit 0; }; done
echo "App didn't come back up. Last log lines:"
sudo journalctl -u ordexago -n 80 --no-pager 2>/dev/null | sed -E 's/(mongodb(\+srv)?:\/\/)[^@ ]*@/\1***@/g; s/(password|secret|token|key)=[^ &]*/\1=***/Ig' || true
exit 1
