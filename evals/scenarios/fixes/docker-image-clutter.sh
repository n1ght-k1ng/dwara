#!/usr/bin/env bash
# Known-good fix for docker-image-clutter: prune only the untagged images.
#
# `docker image prune -f` without -a, which is the distinction the scenario is
# about: -a would take dwara-lab-app:dev with it and the app could not start.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
lab_root lab-api docker image prune -f >/dev/null
