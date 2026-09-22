# lab-api / lab-staging: nginx terminating TLS in front of the dummy API, which
# runs as a container on this host's own Docker engine.
FROM dwara-lab-docker:dev

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx openssl \
 && rm -rf /var/lib/apt/lists/*

# Self-signed certificate for the lab. Short-lived on purpose: cert_expiry has
# something real to report and the expiry scenario is reachable.
RUN mkdir -p /etc/nginx/tls \
 && openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
      -subj "/CN=lab-api/O=Dwara Testbed" \
      -addext "subjectAltName=DNS:lab-api,DNS:lab-staging,DNS:localhost" \
      -keyout /etc/nginx/tls/lab.key -out /etc/nginx/tls/lab.crt 2>/dev/null \
 && chmod 640 /etc/nginx/tls/lab.key \
 && chgrp www-data /etc/nginx/tls/lab.key

COPY images/api/nginx-lab.conf /etc/nginx/sites-available/lab-api
RUN rm -f /etc/nginx/sites-enabled/default \
 && ln -s /etc/nginx/sites-available/lab-api /etc/nginx/sites-enabled/lab-api \
 && nginx -t \
 && systemctl enable nginx.service

COPY images/api/app.env /etc/dwara-lab/app.env
COPY images/api/dwara-app.service /etc/systemd/system/dwara-app.service
RUN systemctl enable dwara-app.service

COPY sudoers/dwara-lab-api /etc/sudoers.d/dwara-lab-api
RUN chmod 440 /etc/sudoers.d/dwara-lab-api && visudo -c -q
