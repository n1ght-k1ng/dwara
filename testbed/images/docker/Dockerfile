# Lab host variant that runs its own Docker engine, for hosts whose workloads are
# containers (lab-api, lab-staging, lab-queue). Docker-in-Docker needs the
# container to be privileged and /var/lib/docker to sit on a real filesystem
# (a named volume), not on the outer overlayfs.
FROM dwara-lab-base:dev

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# The agent inspects containers through group membership rather than sudo, which
# mirrors how a real ops user is set up.
RUN usermod -aG docker dwara \
 && systemctl enable docker.service \
 && systemctl disable docker.socket

# Docker 29 keeps image snapshots under /var/lib/containerd, so both paths need
# to be volumes or overlay mounts inside the lab host fail with EINVAL.
VOLUME /var/lib/docker
VOLUME /var/lib/containerd
