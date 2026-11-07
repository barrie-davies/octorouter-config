#!/usr/bin/env bash
# Set up the team Octorouter on this Ubuntu machine, reachable over Tailscale only.
#
#   sudo office/bootstrap.sh        (from a clone of this repo)
#
# Does what the EC2 user-data in ../infra/octorouter.ts did, without AWS:
#   - files come from this repo instead of S3, into the same /opt/octorouter layout;
#   - secrets are generated here once instead of coming from SST secrets;
#   - `tailscale serve` provides HTTPS on the tailnet instead of Caddy + Let's Encrypt;
#   - the deploy webhook listens on the Docker bridge only, not on every interface.
#
# Safe to re-run: it refreshes compose and webhook files from the repo, and never overwrites
# /opt/octorouter/.env, config.yaml or auths/ once they exist.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $0" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
SERVICES="$HERE/../services"
DIR=/opt/octorouter
LOGDIR=/var/log/octorouter
API_PORT=18317
DASH_PORT=13000
WEBHOOK_PORT=9000
WEBHOOK_VERSION=2.8.2

log() { echo "[octorouter] $*"; }

# ── 1. Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null; then
  log "installing Docker (Ubuntu packages docker.io + docker-compose-v2)"
  apt-get update
  apt-get install -y docker.io docker-compose-v2
elif ! docker compose version >/dev/null 2>&1; then
  echo "Docker is installed but 'docker compose' is not. Install the Compose plugin that matches your" >&2
  echo "Docker (docker-compose-plugin for Docker CE, docker-compose-v2 for Ubuntu's docker.io), then re-run." >&2
  exit 1
fi
systemctl enable --now docker

# ── 2. Tailscale ─────────────────────────────────────────────────────────────
if ! command -v tailscale >/dev/null; then
  log "installing Tailscale (official install script)"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
  log "sign this machine in to Tailscale: open the URL printed below"
  tailscale up
fi
TS_NAME="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
case "$TS_NAME" in
  *.ts.net) ;;
  *) echo "Could not read this machine's Tailscale name (got '$TS_NAME'). Turn on MagicDNS in the Tailscale admin console." >&2; exit 1 ;;
esac
API_URL="https://$TS_NAME"
DASHBOARD_URL="https://$TS_NAME:8443"

# ── 3. Files, same layout as EC2 ─────────────────────────────────────────────
log "installing files into $DIR"
mkdir -p "$DIR/auths" "$DIR/logs" "$DIR/webhook" "$LOGDIR"
install -m 0644 "$SERVICES/docker-compose.yml"           "$DIR/docker-compose.yml"
install -m 0644 "$HERE/docker-compose.override.yml"      "$DIR/docker-compose.override.yml"
install -m 0644 "$SERVICES/Caddyfile"                    "$DIR/Caddyfile"
install -m 0644 "$SERVICES/config.example.yaml"          "$DIR/config.example.yaml"
install -m 0755 "$SERVICES/webhook/deploy-dashboard.sh"  "$DIR/webhook/deploy-dashboard.sh"

# ── 4. Secrets (.env): generated once, in place of the SST secrets ───────────
if [ ! -f "$DIR/.env" ]; then
  log "generating secrets in $DIR/.env"
  umask 077
  cat > "$DIR/.env" <<EOF
CLIPROXYAPI_PORT=8317
CLIPROXYAPI_AUTH_DIR=$DIR/auths
CLIPROXYAPI_DEPLOY=cloud
POSTGRES_PASSWORD=$(openssl rand -hex 32)
DASHBOARD_PORT=3000
JWT_SECRET=$(openssl rand -base64 32)
MANAGEMENT_API_KEY=$(openssl rand -hex 32)
DEPLOY_SECRET=$(openssl rand -hex 32)
WEBHOOK_HOST=http://host.docker.internal:$WEBHOOK_PORT
EOF
  umask 022
fi
# The Tailscale name can change (machine or tailnet renamed), so these are refreshed every run.
sed -i '/^API_URL=/d; /^DASHBOARD_URL=/d' "$DIR/.env"
printf 'API_URL=%s\nDASHBOARD_URL=%s\n' "$API_URL" "$DASHBOARD_URL" >> "$DIR/.env"
chmod 0600 "$DIR/.env"
DEPLOY_SECRET="$(sed -n 's/^DEPLOY_SECRET=//p' "$DIR/.env")"

# ── 5. config.yaml: the template, with a real first client key ───────────────
FIRST_KEY=""
if [ ! -f "$DIR/config.yaml" ]; then
  FIRST_KEY="sk-team-$(openssl rand -hex 24)"
  sed "s|^  - \"my-cliproxy-key\"\$|  - \"$FIRST_KEY\"  # admin (first key)|" "$SERVICES/config.example.yaml" > "$DIR/config.yaml"
  grep -q "$FIRST_KEY" "$DIR/config.yaml" || { echo "Could not replace the placeholder API key in config.yaml" >&2; rm -f "$DIR/config.yaml"; exit 1; }
  chmod 0600 "$DIR/config.yaml"
fi

# ── 6. Deploy webhook, bound to the Docker bridge (not the office network) ───
GW="$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)"
[ -n "$GW" ] || { echo "No docker0 address found; is Docker running?" >&2; exit 1; }
sed "s|{{DEPLOY_SECRET}}|$DEPLOY_SECRET|g" "$SERVICES/webhook/webhook.yaml" > "$DIR/webhook/webhook.yaml"
chmod 0600 "$DIR/webhook/webhook.yaml"
sed "s|-ip 0.0.0.0|-ip $GW|" "$SERVICES/webhook/octorouter-webhook.service" > /etc/systemd/system/octorouter-webhook.service
if [ ! -x /usr/local/bin/webhook ]; then
  log "installing adnanh/webhook $WEBHOOK_VERSION"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/adnanh/webhook/releases/download/${WEBHOOK_VERSION}/webhook-linux-amd64.tar.gz" -o "$tmp/webhook.tar.gz"
  tar -xzf "$tmp/webhook.tar.gz" -C "$tmp"
  install -m 0755 "$tmp/webhook-linux-amd64/webhook" /usr/local/bin/webhook
  rm -rf "$tmp"
fi
if command -v ufw >/dev/null && ufw status | grep -q "^Status: active"; then
  # Containers reach the webhook via host.docker.internal; ufw's default deny would drop that.
  ufw allow from 172.16.0.0/12 to "$GW" port "$WEBHOOK_PORT" proto tcp comment "octorouter webhook (containers only)" >/dev/null
fi
systemctl daemon-reload
systemctl enable octorouter-webhook >/dev/null
systemctl restart octorouter-webhook

# ── 7. Start the stack ───────────────────────────────────────────────────────
log "starting containers (first run pulls images; this takes a few minutes)"
( cd "$DIR" && docker compose up -d )

# ── 8. HTTPS on the tailnet only ─────────────────────────────────────────────
if ! tailscale serve --bg --https=443 "http://127.0.0.1:$API_PORT" \
   || ! tailscale serve --bg --https=8443 "http://127.0.0.1:$DASH_PORT"; then
  echo "tailscale serve failed. In the Tailscale admin console, turn on MagicDNS and HTTPS Certificates" >&2
  echo "(DNS page), then re-run this script." >&2
  exit 1
fi

cat <<EOF

Team Octorouter is up (tailnet only).
  API              $API_URL/v1
  Dashboard        $DASHBOARD_URL
  Management page  $API_URL/management.html
  Management key   sudo sed -n 's/^MANAGEMENT_API_KEY=//p' $DIR/.env
EOF
[ -n "$FIRST_KEY" ] && printf '  First client key %s   (saved in %s/config.yaml)\n' "$FIRST_KEY" "$DIR"
cat <<EOF

Check it:  curl -H "Authorization: Bearer <client key>" $API_URL/v1/models
Next: connect provider accounts in the dashboard, then add a key per teammate (see office/README.md).
EOF
