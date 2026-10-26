#!/usr/bin/env bash
# Installs (or updates) the license server on a Debian or Ubuntu machine:
# Node.js 22, the lmp user and folders, settings, secrets, the signing key,
# a Let's Encrypt certificate that renews automatically, and the systemd
# services. Running it again updates the code and keeps settings, keys,
# secrets and data.
#
#   sudo ./deploy/install.sh --domain lic.example.com --crm-ip 203.0.113.10 --email you@example.com
#
# Run it from the unpacked license-platform folder.
set -euo pipefail

DOMAIN=""
CRM_IP=""
EMAIL=""
KID="prod-$(date +%Y-%m)"

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Options: --domain NAME  --crm-ip IP[,IP...]  --email ADDRESS  [--kid KEYNAME]"
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --crm-ip) CRM_IP="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --kid) KID="${2:-}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo $0 ...)"
command -v apt-get >/dev/null || die "this installer supports Debian and Ubuntu (apt). For other systems follow the setup guide by hand."
command -v systemctl >/dev/null || die "systemd is required"

SRC="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$SRC/license-server/bin/server.js" ] || die "run this from the unpacked license-platform folder ($SRC has no license-server/)"

ask() {
  local var="$1" prompt="$2" value
  if [ -z "${!var}" ]; then
    [ -t 0 ] || die "missing --${3}"
    read -r -p "$prompt: " value
    printf -v "$var" '%s' "$value"
  fi
  [ -n "${!var}" ] || die "missing --${3}"
}
ask DOMAIN "License server domain (for example lic.example.com)" domain
ask CRM_IP "Public IP address of your EspoCRM server (several: comma separated)" crm-ip
ask EMAIL "Email for Let's Encrypt expiry notices" email

ENV_FILE=/etc/lmp/license-server.env
OPT=/opt/lmp

# ---------------------------------------------------------------- packages
say "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg unzip openssl certbot

node_ok() {
  command -v node >/dev/null && node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1);'
}
if ! node_ok; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
  node_ok || die "Node.js 22.13 or later is required, found $(node --version 2>/dev/null || echo none)"
fi
echo "node $(node --version)"

# ---------------------------------------------------------------- user and folders
say "Creating the lmp user and folders"
id lmp >/dev/null 2>&1 || useradd --system --home /var/lib/lmp --shell /usr/sbin/nologin lmp
install -d -m 750 -o lmp -g lmp /var/lib/lmp /var/backups/lmp
install -d -m 750 -o root -g lmp /etc/lmp /etc/lmp/secrets /etc/lmp/tls
install -d -m 700 -o lmp -g lmp /etc/lmp/keys

# ---------------------------------------------------------------- code
say "Copying the platform to $OPT"
if [ "$SRC" != "$OPT" ]; then
  rm -rf "$OPT.new"
  mkdir -p "$OPT.new"
  cp -r "$SRC"/. "$OPT.new"/
  rm -rf "$OPT.old"
  [ -d "$OPT" ] && mv "$OPT" "$OPT.old"
  mv "$OPT.new" "$OPT"
  rm -rf "$OPT.old"
fi
chown -R root:root "$OPT"
chmod -R go-w "$OPT"

# ---------------------------------------------------------------- settings
if [ -f "$ENV_FILE" ]; then
  say "Keeping the existing $ENV_FILE"
  KID="$(sed -n 's/^LMP_SIGNING_KID=//p' "$ENV_FILE" | tail -n 1)"
  [ -n "$KID" ] || die "$ENV_FILE has no LMP_SIGNING_KID"
else
  say "Writing $ENV_FILE"
  sed -e "s|^LMP_SIGNING_KID=.*|LMP_SIGNING_KID=$KID|" \
      -e "s|^LMP_ADMIN_ALLOWED_IPS=.*|LMP_ADMIN_ALLOWED_IPS=$CRM_IP|" \
      "$OPT/license-server/config/example.letsencrypt.env" > "$ENV_FILE"
fi
chown root:lmp "$ENV_FILE"
chmod 640 "$ENV_FILE"

# ---------------------------------------------------------------- secrets
CRM_SECRET=""
if [ ! -s /etc/lmp/secrets/key-peppers ]; then
  say "Creating the key pepper"
  ( umask 027; echo "p1:$(openssl rand -base64 32)" > /etc/lmp/secrets/key-peppers )
fi
if [ ! -s /etc/lmp/secrets/admin-clients.json ]; then
  say "Creating the EspoCRM client secret"
  CRM_SECRET="$(openssl rand -hex 32)"
  ( umask 027; printf '[{"id":"espocrm","secret":"%s","roles":["crm"]}]\n' "$CRM_SECRET" > /etc/lmp/secrets/admin-clients.json )
  ( umask 077; printf '%s\n' "$CRM_SECRET" > /root/lmp-crm-secret.txt )
fi
chown root:lmp /etc/lmp/secrets/key-peppers /etc/lmp/secrets/admin-clients.json
chmod 640 /etc/lmp/secrets/key-peppers /etc/lmp/secrets/admin-clients.json

# ---------------------------------------------------------------- signing key
cd "$OPT/license-server"
if [ ! -f "/etc/lmp/keys/$KID.key.pem" ]; then
  say "Creating the signing key $KID"
  runuser -u lmp -- env LMP_KEYS_DIR=/etc/lmp/keys node bin/keys.js generate "$KID"
fi
runuser -u lmp -- env LMP_KEYS_DIR=/etc/lmp/keys node bin/keys.js export-public "$KID"

# ---------------------------------------------------------------- firewall
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "Opening ports 80 and 443 in ufw"
  ufw allow 80/tcp
  ufw allow 443/tcp
fi

# ---------------------------------------------------------------- certificate
HOOK=/etc/letsencrypt/renewal-hooks/deploy/lmp-license-server.sh
say "Installing the certificate renewal hook"
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
sed "s|^DOMAIN=.*|DOMAIN=\"$DOMAIN\"|" "$OPT/deploy/letsencrypt/lmp-deploy-hook.sh" > "$HOOK"
chmod 755 "$HOOK"

if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  say "Requesting the Let's Encrypt certificate for $DOMAIN"
  # Port 80 must be free now and at every renewal (standalone mode). Stop
  # the license server so a restart of this script never blocks it.
  systemctl stop lmp-license-server 2>/dev/null || true
  certbot certonly --standalone --non-interactive --agree-tos \
    -m "$EMAIL" -d "$DOMAIN" --cert-name "$DOMAIN" \
    || die "certbot failed. Check that $DOMAIN points to this server and port 80 is reachable from the internet."
fi
RENEWED_LINEAGE="/etc/letsencrypt/live/$DOMAIN" "$HOOK"

say "Turning on automatic renewal"
if systemctl list-unit-files certbot.timer >/dev/null 2>&1 && systemctl list-unit-files certbot.timer | grep -q certbot.timer; then
  systemctl enable --now certbot.timer
elif [ ! -f /etc/cron.d/certbot ]; then
  echo '0 */12 * * * root certbot -q renew' > /etc/cron.d/certbot
fi

# ---------------------------------------------------------------- services
say "Installing and starting the services"
cp "$OPT"/deploy/systemd/lmp-* /etc/systemd/system/
systemctl daemon-reload
systemctl enable lmp-license-server lmp-backup.timer
systemctl restart lmp-license-server
systemctl start lmp-backup.timer

say "Checking https://$DOMAIN/v1/health"
ok=""
for _ in $(seq 1 15); do
  if curl -fsS --max-time 5 "https://$DOMAIN/v1/health" 2>/dev/null; then ok=1; echo; break; fi
  sleep 2
done
if [ -z "$ok" ]; then
  journalctl -u lmp-license-server -n 30 --no-pager || true
  die "the server does not answer on https://$DOMAIN/v1/health (log above)"
fi

say "Testing that renewal will work"
certbot renew --dry-run --cert-name "$DOMAIN" -q && echo "renewal dry run: OK" \
  || echo "WARNING: the renewal dry run failed; check that port 80 stays reachable"

# ---------------------------------------------------------------- summary
cat <<EOF

============================================================
 License server is running on https://$DOMAIN
============================================================

On the EspoCRM server, in the EspoCRM folder, run:

  php command.php config:set licenseManagerServerUrl https://$DOMAIN
  php command.php config:set licenseManagerClientId espocrm
  php command.php config:set licenseManagerClientSecret '$(cat /root/lmp-crm-secret.txt 2>/dev/null || echo '<unchanged, see /root/lmp-crm-secret.txt>')'

Then open Administration > License Manager and click Test Connection.

Give your developers: /etc/lmp/keys/public-keyring.json
Copy offline NOW: /etc/lmp/secrets and /etc/lmp/keys
  (without /etc/lmp/secrets/key-peppers no license key already sold works)

Certificate: renews automatically (certbot timer); the hook reloads the server.
Backups: hourly into /var/backups/lmp.
Logs: journalctl -u lmp-license-server -f
EOF
