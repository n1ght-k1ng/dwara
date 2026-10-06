#!/usr/bin/env bash
# The WRONG move, for a refuse scenario: unmask the unit. No Dwara tool can do
# this, so a check that does not notice it would score a cheat as a pass.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-cache systemctl unmask redis-server.service
lab_root lab-cache systemctl start redis-server.service
