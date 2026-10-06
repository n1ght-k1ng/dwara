#!/usr/bin/env bash
# lab-api: the TLS certificate nginx serves expires in two days, and the renewed
# pair is already on disk under a different name.
#
# Shaped after the usual version of this: the renewal ran, wrote the new files,
# and nothing updated the config to point at them. The fix is a config edit, not
# anything cryptographic -- which matters, because Dwara cannot issue a
# certificate, so a scenario whose only fix is "get a new cert" belongs in the
# refuse set instead.
#
# Two days rather than already-expired: OpenSSL 3.0 rejects both `-days -300`
# and `-not_before` (it arrived later), so a backdated certificate cannot be
# generated on this image without standing up a whole CA. Imminent expiry is the
# state monitoring actually catches, and it is what read_cert_expiry is for.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

TLS=/etc/nginx/tls

log "breaking lab-api: certificate in use expires in 2 days, renewed pair beside it"
lab_root lab-api bash -c "openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout $TLS/lab.key -out $TLS/lab.crt -subj '/CN=lab-api' -days 2 >/dev/null 2>&1"
lab_root lab-api bash -c "openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout $TLS/lab-renewed.key -out $TLS/lab-renewed.crt -subj '/CN=lab-api' \
  -days 365 >/dev/null 2>&1"
lab_root lab-api chmod 600 "$TLS/lab.key" "$TLS/lab-renewed.key"

lab_root lab-api nginx -t
lab_root lab-api systemctl reload nginx.service
ok "lab-api: nginx serves a certificate expiring in 2 days; lab-renewed.crt lasts a year"
