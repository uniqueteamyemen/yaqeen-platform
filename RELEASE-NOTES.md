# Yaqeen 0.1.0 — Release Preparation

**Status:** ready for owner review; not a public release notice.

## Included changes

- Updated the README to present Yaqeen accurately as the reference platform for small and medium providers using PayLock.
- Recorded the permanent native/direct Yaqeen ↔ PayLock Core integration. Adapter is reserved for external-platform translation into PayLock Core and is not part of the Yaqeen-to-Core path.
- Removed obsolete H2 wording from Yaqeen documentation.
- Added a production-startup guard: `NODE_ENV=production` requires an explicitly configured `API_KEY` and rejects the default `test-key`.
- Defined `API_KEY` as an instance-scoped server credential only: it is not an end-user key, browser value, or user-facing interface value. Each provider may operate an isolated Yaqeen instance with a separate production key.
- Added a reproducible PayLock–Yaqeen joint release suite, including edge cases for delayed provider acknowledgement, provider cancellation, and a client abort before request dispatch.

## Verification command

```bash
PAYLOCK_CORE_DIR=/path/to/paylock-core pnpm test:release
```

The suite starts local temporary PayLock Core and Yaqeen processes, uses unique test data, redacts proof values in output, and terminates both processes after the run.

## Boundary preserved

This release preparation does not change PayLock Core. Yaqeen remains a reference platform and does not convert PayLock into a payment processor. Any provider-specific commercial condition remains an optional provider policy around H0.

## Owner actions before a public release

1. Review the merged source and release-test report.
2. Supply a non-default production API key through the deployment secret mechanism for each Yaqeen provider instance; give it only to that instance's trusted server-side caller.
3. Run the same release command against the release checkout.
