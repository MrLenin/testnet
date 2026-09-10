#!/bin/bash
# Write PASTE's config.php for the bed and derive the FILEHOST public key
# from the ircd's Authtoken key (mounted bed ircd.conf), so the test key has
# exactly one home.
set -euo pipefail
cd /var/www/html

KEY="${FILEHOST_KEY:-}"
if [ -z "$KEY" ] && [ -r /bed-ircd.conf ]; then
  KEY=$(awk '/^Authtoken "FILEHOST"/{f=1} f && /key = "/{gsub(/.*key = "|".*/,""); print; exit}' /bed-ircd.conf)
fi
PEM=""
if [ -n "$KEY" ]; then
  # base64url scalar -> DER ECPrivateKey (RFC 5915, no public part) -> SPKI PEM.
  PEM=$(printf '%s' "$KEY" | perl -MMIME::Base64 -e '
    local $/; my $k = <STDIN>; $k =~ tr|-_|+/|; $k .= "=" x ((4 - length($k) % 4) % 4);
    my $s = decode_base64($k); die "bad key" unless length($s) == 32;
    print pack("H*", "30310201010420") . $s . pack("H*", "a00a06082a8648ce3d030107");' \
    | openssl ec -inform DER -pubout 2>/dev/null || true)
fi
if [ -z "$PEM" ]; then
  echo "paste-entrypoint: no FILEHOST key found; FILEHOST stays unconfigured" >&2
fi
FILEHOST_PEM="$PEM" php /gen-config.php
mkdir -p /var/filehost && chown www-data:www-data /var/filehost

for i in $(seq 1 60); do
  if mysql -h"${DB_HOST:-paste-db}" -u"${DB_USER:-paste}" -p"${DB_PASSWORD:-paste}" "${DB_NAME:-paste}" \
       -e "UPDATE site_info SET baseurl='${PASTE_BASEURL:-http://localhost:8089/}' WHERE id=1" 2>/dev/null; then
    break
  fi
  sleep 2
done
php -l filehost.php && php -l includes/filehost_jwt.php && php -l includes/filehost_store.php
exec "$@"
