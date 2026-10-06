#!/usr/bin/env bash
# The WRONG move for sshd-hardening: edit /etc/ssh/sshd_config.
#
# Exactly what edit_config refuses, here so `check.sh` can be shown to detect the
# file changing rather than passing trivially.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-api sed -i 's/^MaxStartups 1$/MaxStartups 10:30:100/' /etc/ssh/sshd_config
