#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-cache systemctl start redis-server.service
