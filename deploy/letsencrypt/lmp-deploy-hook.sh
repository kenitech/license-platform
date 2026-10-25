#!/bin/sh
# certbot deploy hook: after a renewal, copy the certificate where the lmp
# user can read it and tell the license server to load it.
# Install as /etc/letsencrypt/renewal-hooks/deploy/lmp-license-server.sh
set -eu

DOMAIN="licenses.example.com"
TLS_DIR="/etc/lmp/tls"
SERVICE="lmp-license-server"

# certbot runs every deploy hook for every renewed certificate; only act on ours.
LINEAGE="${RENEWED_LINEAGE:-}"
if [ -z "$LINEAGE" ]; then
  echo "RENEWED_LINEAGE is not set; run as: RENEWED_LINEAGE=/etc/letsencrypt/live/$DOMAIN $0" >&2
  exit 1
fi
if [ "$(basename "$LINEAGE")" != "$DOMAIN" ]; then
  exit 0
fi

install -d -m 750 -o root -g lmp "$TLS_DIR"
# Write to temporary files first so the server never sees half a pair.
install -m 640 -o root -g lmp "$LINEAGE/fullchain.pem" "$TLS_DIR/fullchain.pem.new"
install -m 640 -o root -g lmp "$LINEAGE/privkey.pem" "$TLS_DIR/privkey.pem.new"
mv -f "$TLS_DIR/privkey.pem.new" "$TLS_DIR/privkey.pem"
mv -f "$TLS_DIR/fullchain.pem.new" "$TLS_DIR/fullchain.pem"

if systemctl is-active --quiet "$SERVICE"; then
  systemctl reload "$SERVICE"
  echo "certificate for $DOMAIN installed; $SERVICE reloaded"
else
  echo "certificate for $DOMAIN installed in $TLS_DIR ($SERVICE is not running)"
fi
