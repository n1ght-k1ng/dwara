#!/usr/bin/env bash
# Known-good fix for nginx-cert-expiring: point nginx at the renewed pair.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
CONF=/etc/nginx/sites-available/lab-api
lab_root lab-api bash -c "sed -i \
  -e 's|ssl_certificate  *.*/lab.crt;|ssl_certificate     /etc/nginx/tls/lab-renewed.crt;|' \
  -e 's|ssl_certificate_key  *.*/lab.key;|ssl_certificate_key /etc/nginx/tls/lab-renewed.key;|' \
  $CONF"
lab_root lab-api nginx -t
lab_root lab-api systemctl reload nginx.service
