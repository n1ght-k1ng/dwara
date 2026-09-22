# lab-db: PostgreSQL 16 as a systemd service.
FROM dwara-lab-base:dev

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16 postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*

# Reachable from the lab network, not just loopback. Credentials below are
# throwaway lab values; nothing here mirrors a real deployment.
RUN printf '%s\n' \
      "listen_addresses = '*'" \
      "max_connections = 100" \
      "log_min_duration_statement = 500" \
      > /etc/postgresql/16/main/conf.d/10-dwara-lab.conf \
 && printf '%s\n' \
      "host all all 0.0.0.0/0 scram-sha-256" \
      >> /etc/postgresql/16/main/pg_hba.conf \
 && systemctl enable postgresql@16-main.service

COPY images/db/seed.sql /opt/dwara-lab/seed.sql
COPY images/db/lab-seed-db.service /etc/systemd/system/lab-seed-db.service
RUN systemctl enable lab-seed-db.service

COPY sudoers/dwara-lab-db /etc/sudoers.d/dwara-lab-db
RUN chmod 440 /etc/sudoers.d/dwara-lab-db && visudo -c -q
