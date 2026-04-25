# Harden Inventory — TEE SDK Path
Date: 2026-04-25

## Test infra
- tcloud: Vitest in `packages/tcloud/tests`, package build through `tsup`, root typecheck through `tsc --noEmit`.
- tcloud-attestation: Vitest in `packages/tcloud-attestation/tests`, package build through `tsup`.
- sandbox SDK/API: Vitest in `products/sandbox/sdk/tests` and `products/sandbox/api/tests`.
- blueprint: Rust `cargo test` in `sandbox-runtime` and `ai-agent-tee-instance-blueprint-lib`.
- Real-vs-mocked ratio: SDK path is mostly mocked at process boundaries. This is acceptable for caller-side policy checks, but not enough for live TEE proof.

## Eval infra
- `.evolve/` exists for SDK readiness history.
- No dedicated live TEE attestation eval exists yet.

## Benchmark infra
- No benchmark gate for attestation verification latency in tcloud.
- Blueprint has Rust benches, but not tied to the tcloud caller flow.

## Observability
- No production telemetry contract for attestation status yet.
- SDK exposes `attestationStatus` for caller display and machine checks.

## Findings should land
- Caller-side policy bugs: `packages/tcloud/tests/sandbox-create.test.ts`.
- Attestation parser/verifier bugs: `packages/tcloud-attestation/tests/attestation.test.ts`.
- Sandbox passthrough bugs: `products/sandbox/sdk/tests/unit/*confidential*` and `products/sandbox/api/tests/*`.
- Blueprint nonce/backend bugs: `sandbox-runtime` TEE tests.
