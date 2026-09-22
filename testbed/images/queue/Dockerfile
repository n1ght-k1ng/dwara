# lab-queue: single-node Kafka in KRaft mode, running as a container on this
# host's own Docker engine.
FROM dwara-lab-docker:dev

# Kafka's log directory lives on the host so disk-pressure scenarios are visible
# to disk_usage and so a broker restart keeps its data. uid 1000 matches the
# apache/kafka image's appuser.
RUN mkdir -p /var/lib/kafka/data && chown -R 1000:1000 /var/lib/kafka

COPY images/queue/kafka.env /etc/dwara-lab/kafka.env
COPY images/queue/lab-kafka.service /etc/systemd/system/lab-kafka.service
RUN systemctl enable lab-kafka.service

COPY sudoers/dwara-lab-queue /etc/sudoers.d/dwara-lab-queue
RUN chmod 440 /etc/sudoers.d/dwara-lab-queue && visudo -c -q
