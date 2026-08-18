# Yaqeen Platform

![Health Check](https://api.checklyhq.com/v1/badges/checks/c7dc410d-96a2-4409-8524-7b7fa272182a?style=flat&theme=default)
![Full Cycle](https://api.checklyhq.com/v1/badges/checks/1de56a50-79c5-42a2-9ce6-3fa5b462aae9?style=flat&theme=default)

[Live System Status](https://qpm5p92k.checkly-status-page.com/)

Yaqeen is a **reference platform for small and medium digital-service providers** that use PayLock Core. It provides a thin provider-facing API for creating a PayLock session, recording a provider acknowledgement, recording a client unlock, and checking the resulting technical delivery evidence.

PayLock Core remains the source of the protocol invariants: it issues H0 and produces H1 only after the required execution signals exist. **Yaqeen integrates with PayLock Core directly and natively; no Adapter sits between them.** Yaqeen does not process, verify, govern, or control money or funds. A provider may apply its own optional commercial eligibility policy before it accepts an order; that policy is external to PayLock's evidence logic.

## Integration boundary

There are two distinct operating paths. A provider that already owns a delivery platform integrates that platform with PayLock Core directly; if an external platform needs event translation, the path is `External Platform → Adapter → PayLock Core`. Adapter is reserved for that external boundary and is never inserted between Yaqeen and PayLock Core.

A provider that does not own a delivery platform may operate a dedicated Yaqeen instance. That instance calls PayLock Core directly and keeps its own production credential at the server boundary.

## Operating boundary

The `/api/execute` convenience route records `provider_ack` with an `auto` reference. It exists for local reference and interface demonstration only. It must not be presented as an independently authenticated provider acknowledgement. A production provider integration must supply its own authenticated acknowledgement through the appropriate integration boundary.

## Runtime configuration

| Variable | Purpose | Production rule |
| --- | --- | --- |
| `NODE_ENV` | Runtime mode | Set to `production` for a live deployment. |
| `API_KEY` | Instance-scoped Yaqeen server API credential; it protects `/api` and is forwarded only by the Yaqeen server on its direct Core calls. | Required in production and may not equal `test-key`. The server exits before listening if this rule is violated. Keep it only in the deployment secret store and trusted server-to-server configuration; never place it in browser code, a user-facing interface, or a client device. |
| `PAYLOCK_URL` | Base URL of PayLock Core | Configure the intended Core endpoint explicitly for a live deployment. |
| `REDIS_URL` | Optional Yaqeen log store | Configure for durable logs; without it, logs are console-only. |

`test-key` remains a local-development convenience only. It is rejected when `NODE_ENV=production`.

### Production key operation

Each provider may run a separate Yaqeen instance with an independent, high-entropy production `API_KEY`. The key belongs to the instance and its trusted provider backend—not to an end user. The repository does not implement, require, or expose a user API-key system.

The deployment operator creates the key in its secret manager, injects it as `API_KEY` at deploy time, and provides it only to the trusted backend that calls that instance's `/api` routes. If the credential must be replaced or revoked, create a new server secret, update that trusted backend, restart the instance with the new secret, and remove the former secret. With the current single-key runtime, replacement intentionally invalidates the former key immediately after the restart; no overlap or user-key registry is implied.

## Local release test

Run `pnpm test:release` from this repository with PayLock Core checked out as a sibling directory named `paylock-core`, or set `PAYLOCK_CORE_DIR` to its path. The test starts isolated local processes with explicit non-default keys and verifies the shared sequence:

`H0 session → provider_ack → user_unlock → one H1 → replay rejection`

It also verifies that Yaqeen refuses both a missing production key and `test-key` in production mode, and that `/api` rejects both a missing and an incorrect server key. This is a reproducible local integration check; it does not represent a live external provider delivery.
