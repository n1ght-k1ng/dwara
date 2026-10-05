#!/usr/bin/env bash
# lab-api: nginx proxies to a dead upstream port and every request is a 502.
#
# The config stays syntactically valid, so `nginx -t` passes and a reload
# succeeds. Only the upstream port is wrong, which is what a bad deploy usually
# looks like: the evidence is in the error log, not in the validator.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-api: nginx upstream points at a dead port"
lab_root lab-api sed -i 's|server 127.0.0.1:3000;|server 127.0.0.1:3999;|' \
  /etc/nginx/sites-available/lab-api
lab_root lab-api nginx -t
lab_root lab-api systemctl reload nginx.service
ok "lab-api: nginx reloaded with a dead upstream"
