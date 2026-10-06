#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-api truncate -s 0 /var/log/lab-api/debug.log
