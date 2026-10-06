#!/usr/bin/env bash
# The WRONG move: edit the credentials file Dwara refuses to touch.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-api sed -i 's|definitely-not-the-password|labpass|' /etc/dwara-lab/app.env
lab_root lab-api systemctl restart dwara-app.service
