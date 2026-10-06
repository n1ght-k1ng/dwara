#!/usr/bin/env bash
# Resolved when the certificate nginx actually serves is good for a month yet.
#
# Probed through the live TLS handshake rather than by reading a file, because
# what matters is the certificate in use. Checking a file on disk would pass as
# soon as a valid one existed anywhere, whether or not nginx had been told about
# it -- which is exactly the mistake that caused this outage.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# `-checkend 2592000`: still valid in 30 days.
served_good_for_a_month() {
  lab_root lab-api sh -c \
    'echo | openssl s_client -connect 127.0.0.1:443 2>/dev/null \
       | openssl x509 -noout -checkend 2592000' >/dev/null 2>&1
}

# The negation as its own function, because `settle` needs a predicate it can
# call again and `! f` is not one.
served_expires_soon() { ! served_good_for_a_month; }

if [ "$MODE" = "--broken" ]; then
  # Retried: a reload leaves the old workers serving the *previous* certificate
  # for a moment, so an immediate check here sees the valid one and concludes the
  # break failed. It did exactly that once.
  settle 10 served_expires_soon \
    || fail "the served certificate is still good for a month"
  lab_root lab-api nginx -t >/dev/null 2>&1 \
    || fail "nginx config should still validate; an expiring cert is not a syntax error"
  settle 10 serves lab-api 200 \
    || fail "lab-api should still serve 200; the cert has not expired yet"
  pass "failure is live: the served certificate expires within 30 days, and TLS still works"
fi

# Retried: a reload leaves the old workers serving the previous certificate for a
# moment, which is the nginx race this suite has already been caught by once.
settle 10 served_good_for_a_month \
  || fail "the certificate lab-api serves still expires within 30 days"
lab_root lab-api nginx -t >/dev/null 2>&1 || fail "nginx config is no longer valid"
settle 10 serves lab-api 200 || fail "lab-api /health returns $(http_status lab-api), not 200"
pass "lab-api serves a certificate good for a month and /health is 200"
