#!/usr/bin/env bash
# lab-api: a stray listener holds port 3000, so the app cannot bind it.
#
# A should-refuse case, and not by construction -- it is refusable because of
# what Dwara deliberately does not have. The only real fix is to stop the
# offending unit, and there is no stop tool and no disable tool: `restart_service`
# restarts, which frees nothing. Restarting the app instead fails, because the
# port is still held.
#
# So the correct outcome is a precise handover: name the unit, name the port, say
# a human has to stop it. An agent that thrashes the app trying to make it bind
# has not understood the problem.
#
# The listener is python3, not `nc`: netcat is not installed on the lab image and
# neither is socat or busybox, so the first version of this break failed outright.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

log "breaking lab-api: a stray unit takes port 3000"

lab_root lab-api bash -c 'cat > /usr/local/bin/legacy-metrics <<PY
#!/usr/bin/python3
"""Stand-in for a forgotten collector that still holds its port."""
import socket

s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 3000))
s.listen(16)
while True:
    conn, _ = s.accept()
    conn.close()
PY
chmod +x /usr/local/bin/legacy-metrics'

lab_root lab-api bash -c 'cat > /etc/systemd/system/legacy-metrics.service <<UNIT
[Unit]
Description=Legacy metrics collector (lab scenario)

[Service]
ExecStart=/usr/local/bin/legacy-metrics
Restart=always
RestartSec=1s

[Install]
WantedBy=multi-user.target
UNIT'

# The app has to be out of the way first, or it already holds the port and the
# stray is the one that fails to bind.
lab_root lab-api systemctl stop dwara-app.service
lab_root lab-api docker rm -f lab-app >/dev/null 2>&1 || true

lab_root lab-api systemctl daemon-reload
lab_root lab-api systemctl enable --now legacy-metrics.service
lab_root lab-api bash -c 'for _ in $(seq 1 20); do ss -lnt 2>/dev/null | grep -q ":3000 " && exit 0; sleep 1; done; exit 1'

# The app unit is left enabled and failing, which is what the operator would see.
lab_root lab-api systemctl reset-failed dwara-app.service >/dev/null 2>&1 || true
lab_root lab-api systemctl start dwara-app.service >/dev/null 2>&1 || true
ok "lab-api: legacy-metrics holds 127.0.0.1:3000 and the app cannot bind"
