# Dwara lab base image: an Ubuntu 24.04 "host" running systemd as PID 1 with sshd.
#
# This image exists only to give the testbed something that behaves like a real
# Linux server (systemd units, journald, sudo, key-only SSH). It contains no real
# company code, configuration, hostnames or credentials.
FROM ubuntu:24.04

# The lab SSH public key, passed by testbed/scripts/up.sh. Public keys are not
# secret, so a build arg is fine; the private key never enters the image.
ARG AUTHORIZED_KEY

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# Package installs must not try to start services at build time: there is no
# systemd running yet. `systemctl enable` still works (it only writes symlinks).
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session \
      openssh-server sudo \
      ca-certificates curl iproute2 procps psmisc \
      less nano file jq python3-minimal \
      logrotate \
 && rm -rf /var/lib/apt/lists/*

# Units that cannot work inside a container and would otherwise leave the host
# permanently "degraded" for reasons unrelated to the scenario under test.
RUN systemctl mask \
      systemd-udevd.service \
      systemd-udev-trigger.service \
      systemd-udevd-control.socket \
      systemd-udevd-kernel.socket \
      systemd-modules-load.service \
      systemd-journald-audit.socket \
      systemd-networkd-wait-online.service \
      e2scrub_reap.service \
      getty.target \
      console-getty.service

# Journald must keep logs on disk: tail_logs and the log-explosion scenario both
# depend on a persistent journal.
RUN mkdir -p /var/log/journal /etc/systemd/journald.conf.d \
 && printf '[Journal]\nStorage=persistent\nSystemMaxUse=200M\n' \
      > /etc/systemd/journald.conf.d/10-dwara-lab.conf

# Key-only SSH on a plain ssh.service (Ubuntu ships socket activation by default,
# which makes `systemctl status ssh` misleading during diagnosis).
RUN ssh-keygen -A \
 && mkdir -p /run/sshd /etc/ssh/sshd_config.d \
 && printf '%s\n' \
      'PasswordAuthentication no' \
      'KbdInteractiveAuthentication no' \
      'PermitRootLogin no' \
      'PubkeyAuthentication yes' \
      'UseDNS no' \
      'AcceptEnv DWARA_*' \
      > /etc/ssh/sshd_config.d/10-dwara-lab.conf \
 && systemctl disable ssh.socket \
 && systemctl enable ssh.service

# uid 1000 is taken by Ubuntu 24.04's stock `ubuntu` user; the lab wants it for
# `dwara` so bind-mounted files line up with the developer's uid.
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd --create-home --uid 1000 --shell /bin/bash dwara \
 && mkdir -p /home/dwara/.ssh \
 && printf '%s\n' "${AUTHORIZED_KEY}" > /home/dwara/.ssh/authorized_keys \
 && chmod 700 /home/dwara/.ssh \
 && chmod 600 /home/dwara/.ssh/authorized_keys \
 && chown -R dwara:dwara /home/dwara/.ssh

# Passwordless sudo for an explicit allowlist only. Dwara's safety guarantees do
# not rest on this file, but a realistic lab should not hand the agent root.
COPY sudoers/dwara-common /etc/sudoers.d/dwara-common
RUN chmod 440 /etc/sudoers.d/dwara-common && visudo -c -q

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
