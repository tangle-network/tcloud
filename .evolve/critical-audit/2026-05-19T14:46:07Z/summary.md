# Re-audit - tcloud agent sandbox transport unification

Prior run: `.evolve/critical-audit/2026-05-19T14:07:42Z`

Result: 7 resolved, 1 partially resolved, 0 still present.

## Resolved

1. [HIGH] `tcloud-agent` no longer hard-codes CLI Bridge as its architecture. It now runs over `AgentSessionTransport` with router bridge, local cli-bridge, and Sandbox SDK adapters.
2. [HIGH] `providerOptions` no longer overrides protected chat fields; sandbox `agentProfile` and `sessionId` are typed.
3. [HIGH] direct cli-bridge now supports `client.bridge({ harness, model, resume })` as a first-class local shim path.
4. [MEDIUM] USD budgets force non-streaming execution so usage can be read.
5. [MEDIUM] sandbox surfaces are tied together through `TCloud.sandbox()` plus `sandboxSdkTransport`.
6. [LOW] the misleading providerOptions override test was replaced.
7. [MEDIUM] misleading tool-call `AgentEvent` variants were removed until stable upstream tool parts exist.
8. The workspace package export map now exposes top-level `types` conditions so dependent DTS builds resolve `@tangle-network/tcloud` and subpaths reliably.

## Partial

1. [MEDIUM] Workspace is no longer prompt-smuggled and is passed to transports, but router/local bridge enforcement still depends on bridge/runtime workspace support.
