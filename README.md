# Yaqeen Platform

![Health Check](https://api.checklyhq.com/v1/badges/checks/c7dc410d-96a2-4409-8524-7b7fa272182a?style=flat&theme=default)
![Full Cycle](https://api.checklyhq.com/v1/badges/checks/1de56a50-79c5-42a2-9ce6-3fa5b462aae9?style=flat&theme=default)

[Live System Status](https://qpm5p92k.checkly-status-page.com/)

Yaqeen is a **reference platform for small and medium digital-service providers** that use PayLock Core. It provides a thin provider-facing API for creating a PayLock session, recording a provider acknowledgement, recording a client unlock, and checking the resulting technical delivery evidence.

PayLock Core remains the source of the protocol invariants: it issues H0 and produces H1 only after the required execution signals exist. Yaqeen does not process, verify, govern, or control money or funds. A provider may apply its own optional commercial eligibility policy before it accepts an order; that policy is external to PayLock's evidence logic.

## Operating boundary

The `/api/execute` convenience route records `provider_ack` with an `auto` reference. It exists for local reference and interface demonstration only. It must not be presented as an independently authenticated provider acknowledgement. A production provider integration must supply its own authenticated acknowledgement through the appropriate integration boundary.

## Runtime configuration

| Variable | Purpose | Production rule |
| --- | --- | --- |
| `NODE_ENV` | Runtime mode | Set to `production` for a live deployment. |
| `API_KEY` | Yaqeen API key and the key forwarded to the configured Core endpoint | Required in production and may not equal `test-key`. The server exits before listening if this rule is violated. |
| `PAYLOCK_URL` | Base URL of PayLock Core | Configure the intended Core endpoint explicitly for a live deployment. |
| `REDIS_URL` | Optional Yaqeen log store | Configure for durable logs; without it, logs are console-only. |

`test-key` remains a local-development convenience only. It is rejected when `NODE_ENV=production`.

## Local release test

Run `pnpm test:release` from this repository with PayLock Core checked out as a sibling directory named `paylock-core`, or set `PAYLOCK_CORE_DIR` to its path. The test starts isolated local processes with explicit non-default keys and verifies the shared sequence:

`H0 session → provider_ack → user_unlock → one H1 → replay rejection`

It also verifies that Yaqeen refuses both a missing production key and `test-key` in production mode. This is a reproducible local integration check; it does not represent a live external provider delivery.
