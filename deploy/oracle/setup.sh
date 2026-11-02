#!/usr/bin/env bash
# OrdexaGo on an Oracle Cloud server (Ubuntu 22.04/24.04, Ampere ARM or AMD).
# Run on the server as the "ubuntu" user:
#   bash <(curl -fsSL https://raw.githubusercontent.com/azeemshamsi/ZOHO_CLONE/main/deploy/oracle/setup.sh)
# (for a private repo, copy this file to the server and run: bash setup.sh)
#
# It installs Node.js, nginx and a free HTTPS certificate, downloads the app from GitHub,
# asks for the database connection string, builds the app and starts it as a service.
set -euo pipefail
APP_DIR=/opt/ordexago
REPO_SSH=git@github.com:azeemshamsi/ZOHO_CLONE.git
SERVICE=ordexago
say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ask() { local v; read -r -p "$1: " v; echo "$v"; }

say "1/8 System packages"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git nginx certbot python3-certbot-nginx curl ca-certificates iptables-persistent

say "2/8 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

say "3/8 Open web ports 80 and 443 on the server firewall"
# Oracle's Ubuntu images block everything except SSH in iptables; the VCN security list must allow 80/443 too (see the guide).
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $p -m state --state NEW -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p tcp --dport $p -m state --state NEW -j ACCEPT
done
sudo netfilter-persistent save

say "4/8 Download the app from GitHub"
if [ ! -d "$APP_DIR/.git" ]; then
  if [ ! -f ~/.ssh/ordexago_deploy ]; then
    ssh-keygen -t ed25519 -N "" -f ~/.ssh/ordexago_deploy -C "ordexago-oracle-server" >/dev/null
  fi
  grep -q ordexago_deploy ~/.ssh/config 2>/dev/null || cat >> ~/.ssh/config <<CFG
Host github.com
  IdentityFile ~/.ssh/ordexago_deploy
  StrictHostKeyChecking accept-new
CFG
  chmod 600 ~/.ssh/config
  echo
  echo "Add this key on GitHub: repo ZOHO_CLONE → Settings → Deploy keys → Add deploy key (read-only is fine):"
  echo
  cat ~/.ssh/ordexago_deploy.pub
  echo
  read -r -p "Press Enter once the key is added… " _
  sudo mkdir -p "$APP_DIR" && sudo chown "$USER":"$USER" "$APP_DIR"
  git clone "$REPO_SSH" "$APP_DIR"
fi
cd "$APP_DIR" && git pull --ff-only

say "5/8 Settings (saved in $APP_DIR/backend/.env)"
ENVF="$APP_DIR/backend/.env"
if [ ! -f "$ENVF" ]; then
  DOMAIN=$(ask "Your domain (e.g. ordexago.com)")
  echo "Paste the Oracle MongoDB connection string (mongodb://USER:PASSWORD@…:27017/USER?authMechanism=PLAIN&authSource=\$external&ssl=true&retryWrites=false&loadBalanced=true)"
  read -r -s -p "Connection string (hidden): " URI; echo
  cat > "$ENVF" <<ENV
NODE_ENV=production
PORT=8080
MONGODB_URI=$URI
JWT_SECRET=$(openssl rand -hex 32)
APP_URL=https://$DOMAIN
DB_POOL_SIZE=10
ENV
  chmod 600 "$ENVF"
  echo "Saved. Add other keys from your Render environment (email, Shopify, couriers…) to $ENVF later if you set them there."
else
  DOMAIN=$(grep -E '^APP_URL=' "$ENVF" | sed -E 's#APP_URL=https?://##')
fi

say "6/8 Check the database works with OrdexaGo"
(cd "$APP_DIR/backend" && npm ci --omit=dev --silent && node scripts/dbcheck.js) || {
  echo "Some database checks failed — send the output above to Claude before going live."
  read -r -p "Continue anyway? [y/N] " c; [ "${c,,}" = y ] || exit 1
}

say "7/8 Build and start the app"
cd "$APP_DIR" && npm run build
sudo tee /etc/systemd/system/$SERVICE.service >/dev/null <<UNIT
[Unit]
Description=OrdexaGo
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/backend/.env
ExecStart=$(command -v node) backend/src/server.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now $SERVICE
sleep 4
curl -fsS http://127.0.0.1:8080/api/health && echo " ← app is running"

say "8/8 Web server and HTTPS for $DOMAIN"
sudo tee /etc/nginx/sites-available/ordexago >/dev/null <<NGX
server {
  listen 80;
  server_name $DOMAIN www.$DOMAIN;
  client_max_body_size 50m;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 180s;
  }
}
NGX
sudo ln -sf /etc/nginx/sites-available/ordexago /etc/nginx/sites-enabled/ordexago
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
echo
echo "Point your domain's DNS A records (@ and www) to this server's public IP: $(curl -fsS https://api.ipify.org || echo '?')"
read -r -p "Press Enter once DNS points here (check with: ping $DOMAIN) to get the HTTPS certificate… " _
sudo certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --redirect --agree-tos -m "admin@$DOMAIN" -n || echo "Certificate failed — check DNS, then run: sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN"

say "Done. OrdexaGo is live at https://$DOMAIN"
echo "Logs: sudo journalctl -u $SERVICE -f    Update: bash $APP_DIR/deploy/oracle/update.sh"
