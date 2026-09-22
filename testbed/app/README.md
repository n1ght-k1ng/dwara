# dwara-lab-app

Throwaway NestJS service for the Dwara testbed. It exists so the lab has a real
application to break: it depends on Postgres, Redis and Kafka, exposes
`GET /health` (503 when any dependency is down), `GET /orders` and `POST /orders`,
and exits at boot when the database is unreachable so the supervisor restarts it.

It is written for this repository and models no real system. It is deliberately
outside the pnpm workspace — its dependency tree belongs to the lab, not to Dwara.
