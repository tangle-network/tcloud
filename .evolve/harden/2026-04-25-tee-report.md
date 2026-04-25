# Harden Report — TEE SDK Path
Date: 2026-04-25

## Proven invariants
| Invariant | Inputs tested | Result |
|---|---:|---|
| TEE requests verify by default | focused Vitest create-path tests | HOLDS |
| Requested hardware TEE must match returned attestation type | TDX request with Nitro evidence | FIXED |
| Provider-backed TEE requests accept only valid hardware/provider evidence | Azure request with SEV evidence | HOLDS |
| Caller nonce must be 32-64 bytes of hex before create side effects | short and non-hex nonce cases | FIXED |
| Sandbox SDK confidential options pass through to Tangle path | existing sandbox SDK targeted tests | HOLDS |
| Sandbox API refuses confidential requests without Tangle driver | existing sandbox API targeted tests | HOLDS |
| Blueprint TEE backend/type/nonce handling passes current tests | targeted Rust TEE tests | HOLDS |

## Exploit chains
No critical exploit chain remains from this pass.

### Finding 1: Requested TEE mismatch could verify the wrong backend
Severity: HIGH

Before the fix, `TCloudSandbox.create({ tee: 'tdx', ... })` verified against the default attestation policy, which accepts any supported non-None TEE. A malicious or misrouted operator could return Nitro evidence and still satisfy structural verification when `allowUnverifiedHardware` was enabled for staged/live bring-up.

Fix: requested TEE now constrains `acceptedTeeTypes`. Provider names map to their hardware attestation classes: Phala -> TDX, Azure -> SEV-SNP, GCP -> TDX or SEV-SNP.

Regression: `packages/tcloud/tests/sandbox-create.test.ts` now fails a TDX request backed by Nitro evidence.

### Finding 2: Malformed nonce failed too late
Severity: MEDIUM

Before the fix, malformed caller nonces could reach `Sandbox.create`, then fail during verification. That risks side effects and cost before rejecting a request that was invalid locally.

Fix: caller-supplied nonces are validated before create option dispatch.

Regression: `packages/tcloud/tests/sandbox.test.ts` covers short and non-hex nonce rejection.

## Still unknown
| Surface | Reason |
|---|---|
| Live vendor-root quote verification | `@tangle-network/tcloud-attestation` is still intentionally fail-closed for vendor signatures. |
| Live TEE deployment with real quote | No cloud/operator credentials were used in this local pass. |
| Result-level computation provenance | Requires attested session key/output signing protocol beyond one-time quote verification. |

## Validation
- `pnpm vitest run tests/sandbox.test.ts tests/sandbox-create.test.ts tests/attestation-export.test.ts`
- `pnpm exec tsc --noEmit`
- `pnpm --filter @tangle-network/tcloud build`
- `pnpm test` from `packages/tcloud`
- `pnpm --filter @tangle-network/tcloud-attestation test`
- `pnpm --filter @tangle-network/tcloud-attestation build`
- `pnpm exec vitest run tests/unit/confidential.test.ts tests/unit/client-confidential.test.ts tests/unit/sandbox-instance.test.ts tests/unit/tangle-client.test.ts` from sandbox SDK
- `pnpm exec vitest run tests/config.test.ts tests/orchestrator-router.test.ts` from sandbox API
- `cargo test -p sandbox-runtime tee --lib --tests`
- `cargo test -p ai-agent-tee-instance-blueprint-lib tee_config`

## Dispatch
Next route: `/pursue` for the missing live TEE eval harness and attested session/output binding protocol. The local SDK hardening fixes are ready for PR.
