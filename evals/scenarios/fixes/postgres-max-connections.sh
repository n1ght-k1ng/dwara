#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-db bash -c "printf 'max_connections = 100\nsuperuser_reserved_connections = 3\n' > /etc/postgresql/16/main/conf.d/90-dwara-break.conf"
lab_root lab-db systemctl restart postgresql@16-main.service
lab_root lab-db bash -c 'until pg_isready -q; do sleep 1; done'
