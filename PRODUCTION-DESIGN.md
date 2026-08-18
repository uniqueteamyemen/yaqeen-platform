# Yaqeen Production Delivery Scope

This document defines the first production-capable scope for a provider-isolated Yaqeen stack. It implements digital-resource delivery, one-time user access, durable lifecycle records, optional provider Webhooks, and direct server-side integration with PayLock Core. It does not handle payment data, funds, refunds, settlement, or H2.

## Runtime roles

| Role | Access | What it may do | What it must not receive |
|---|---|---|---|
| Provider operator | Authenticated workspace session | Create delivery resources, issue a single-use access link, view bounded lifecycle history, configure a disabled-by-default Webhook | PayLock internal credential, raw H0, raw Webhook secret. |
| End user | Opaque single-use ticket | Redeem one link and access the assigned delivery resource | Any server credential, H0, H1, provider secret, or another resource. |
| Yaqeen server | Private service account | Call Core, persist operational records, and notify configured Webhook endpoints | Browser-visible secrets. |
| PayLock Core | Private companion service | Govern its H0/H1 lifecycle under its own source-defined contract | Public end-user traffic. |

## State model

`ISSUED → REDEEMING → DELIVERED` is the successful Yaqeen ticket state progression. `EXPIRED`, `REDEEMED`, `FAILED`, and `BLOCKED` preserve non-success paths. Redeeming the same ticket a second time never returns resource access. Lifecycle event records are append-only at the application level and contain an opaque event identifier and timestamp.

Yaqeen’s controlled server flow is: create a Core session, send a provider acknowledgement associated with the resource delivery, perform user unlock only after access is granted, then record the resulting Core outcome. It never auto-acknowledges a generic demo request and never exposes H0 or H1 on a delivery page.

## Webhook design

When enabled by a provider, Yaqeen sends a signed `delivery.lifecycle` event after a persisted state transition. The payload carries an event ID, type, delivery status, opaque resource/session reference, timestamp, and non-financial disclosure. It excludes raw tickets, H0, H1, user secrets, payment/funds data, and Webhook signing secret. HMAC-SHA256 covers the exact UTF-8 payload bytes. Receiver responses are non-authoritative.

## Environment contract

| Environment variable | Purpose | Production requirement |
|---|---|---|
| `REDIS_URL` | Durable records, ticket state, rate limiting, and retry bookkeeping | Required. |
| `PAYLOCK_URL` | Private PayLock Core base URL | Required; public Internet URL is not an approved production boundary. |
| `PAYLOCK_CORE_API_KEY` | Current Core-contract internal runtime credential | Required until Core supports an authenticated private boundary without a header. Never browser-visible. |
| `YAQEEN_OPERATOR_SECRET` | Bootstrap provider-operator session authorization | Required and non-test. Never browser-visible. |
| `YAQEEN_SESSION_SECRET` | Signs operator-session cookies | Required and non-test. Never browser-visible. |
| `YAQEEN_PUBLIC_ORIGIN` | Canonical public Yaqeen HTTPS URL used in access links | Required. |

The legacy `API_KEY` compatibility alias can remain only for a short controlled migration. It must not serve browsers, end users, or external public API consumers.
***
