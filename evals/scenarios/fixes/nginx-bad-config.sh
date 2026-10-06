#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-api bash -c "sed -i 's|127.0.0.1:3999|127.0.0.1:3000|' /etc/nginx/sites-available/lab-api && nginx -t && nginx -s reload"
