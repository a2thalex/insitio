#!/usr/bin/env bash
# Installs or updates GitFkd on Ubuntu 24.04. Safe to re-run.
# Usage (as root): DOMAIN=git.example.com bash setup.sh /path/to/gitfkd.tar.gz
set -euo pipefail

TARBALL=${1:?usage: DOMAIN=git.example.com setup.sh <gitfkd.tar.gz>}
DOMAIN=${DOMAIN:?set DOMAIN, e.g. DOMAIN=git.example.com}
APP=/opt/gitfkd
DATA=/var/lib/gitfkd
export DEBIAN_FRONTEND=noninteractive

echo "==> System packages"
apt-get update -q
apt-get install -y -q git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v24.* ]]; then
  echo "==> Node.js 24 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Caddy"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "==> Service user and data directory"
id gitfkd >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin gitfkd
install -d -o gitfkd -g gitfkd -m 750 "$DATA"

echo "==> App code"
rm -rf "$APP.new"
mkdir -p "$APP.new"
tar -xzf "$TARBALL" -C "$APP.new"
(cd "$APP.new" && npm ci --omit=dev --no-audit --no-fund)
rm -rf "$APP.old"
if [ -d "$APP" ]; then mv "$APP" "$APP.old"; fi
mv "$APP.new" "$APP"

if [ ! -f /etc/gitfkd.env ]; then
  echo "==> Writing /etc/gitfkd.env"
  cat > /etc/gitfkd.env <<EOF
PORT=3000
BASE_URL=https://$DOMAIN
DATA_DIR=$DATA
TRUST_PROXY=1
EOF
  chmod 640 /etc/gitfkd.env
  chgrp gitfkd /etc/gitfkd.env
fi

echo "==> systemd and Caddy"
install -m 644 "$APP/deploy/gitfkd.service" /etc/systemd/system/gitfkd.service
sed "s/{DOMAIN}/$DOMAIN/" "$APP/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable gitfkd >/dev/null
systemctl restart gitfkd
systemctl reload caddy || systemctl restart caddy

sleep 2
systemctl is-active --quiet gitfkd && echo "Insitio is running" || { journalctl -u gitfkd -n 30 --no-pager; exit 1; }
curl -fsS -o /dev/null -w "Local health check: HTTP %{http_code}\n" http://127.0.0.1:3000/login
