# Harden Surface — TEE SDK Path
Date: 2026-04-25

## Ranked targets
1. Requested TEE mismatch: caller requests `tdx`, returned evidence is `nitro`, SDK still marks verified.
2. Provider-to-hardware mismatch: caller requests provider-backed TEE such as `azure` or `gcp`; returned evidence uses hardware class (`Sev`/`Tdx`) rather than provider label.
3. Malformed nonce side effect: caller supplies invalid nonce, SDK creates sandbox, then verification fails after side effects/cost.
4. Missing evidence path: metadata lacks attestation and installed sandbox SDK cannot fetch fresh evidence.
5. Replay path: metadata contains stale evidence not bound to generated nonce.
6. Sandbox passthrough: confidential config must fail closed unless the effective driver is `tangle`.
7. Blueprint backend mismatch: TEE config type must match configured backend type.

## Selected attacks
- Active PoC for #1: mocked sandbox returns Nitro evidence for a TDX request with nonce present and structural verification allowed.
- Active PoC for #2: mocked sandbox returns SEV evidence for Azure request and must pass because Azure maps to SEV-SNP.
- Active PoC for #3: caller-supplied malformed nonce must throw before `Sandbox.create`.
- Regression validation for #6/#7 through existing sandbox SDK/API and blueprint tests.
