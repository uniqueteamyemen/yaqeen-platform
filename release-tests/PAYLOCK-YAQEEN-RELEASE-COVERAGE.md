# PayLock–Yaqeen Release Test Coverage

**Scope:** local, reproducible integration verification between Yaqeen and an unmodified PayLock Core checkout.

## Invocation

```bash
PAYLOCK_CORE_DIR=/path/to/paylock-core pnpm test:release
```

## Verified cases

| Case | Expected invariant | Observed assertion |
|---|---|---|
| Production key guard | Production refuses no API key and refuses `test-key`. | Process exits with code `1` and a clear configuration error. |
| Server-key boundary | Yaqeen `/api` routes reject missing or incorrect instance server credentials. | Both requests return HTTP `401`; the test also confirms that Express does not emit its implementation header. |
| Normal execution | A valid session with `provider_ack` and `user_unlock` yields one H1. | H0 and H1 match the expected digest format; verification returns `valid: true`. |
| Unlock replay | A second client unlock cannot create another proof. | HTTP `409` and `user_unlock already recorded`. |
| Delayed provider acknowledgement | No H1 exists before the provider acknowledgement; the prior unlock is resolved only after the acknowledgement arrives. | Initial unlock returns missing `provider_ack`; later `resolve` yields one H1; further unlock is rejected. |
| Provider cancellation | A closed session cannot later produce H1. | Core returns `CANCELLED`; a later Yaqeen unlock returns HTTP `409`. |
| Client abort before dispatch | A request aborted before dispatch creates no user unlock and no H1. | `AbortError`; `resolve` reports missing `user_unlock`; one clean retry creates H1. |

## Interpretation limits

The client-abort case is deliberately deterministic: the abort occurs before the HTTP request is dispatched. It proves that a local cancellation before dispatch leaves no server-side state. It does not claim to simulate every network failure that can occur after a server receives a request body.

The suite verifies the shared local release path. It does not replace a provider-specific production acceptance exercise, prove an external secret manager's configuration, or make any claim about payment processing, funds, refunds, or external provider settlement.
