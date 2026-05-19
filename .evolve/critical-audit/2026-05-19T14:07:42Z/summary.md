# Critical Audit - tcloud agent sandbox/bridge coupling

Scope: `packages/tcloud-agent`, bridge/session APIs in `packages/tcloud`, direct cli-bridge and sandbox-agent examples, and targeted tests.

Head: `9d7b8ffe9e2f1fb387ee27e9f8cc8891133fe3e0`

Tests run:

- `pnpm --filter @tangle-network/tcloud-agent test` - passed, 16 tests.
- `pnpm --filter @tangle-network/tcloud test -- tests/chat.test.ts tests/rotating-client.test.ts tests/sandbox-create.test.ts` - passed, 248 tests, 32 skipped.

Score: 5/10. The unit tests pass, but the agent abstraction is not yet the clean unified primitive it appears to be. It is a CLI Bridge sandbox loop with adjacent sandbox SDK code, not a transport-neutral sandbox agent.

## Fix plan

1. [HIGH] `packages/tcloud-agent/src/agent-runner.ts:255` - `Agent.stream` hard-codes `TCloudClient.bridge({ harness: 'sandbox' })`, so `tcloud-agent` cannot be backed by the Sandbox SDK runtime even though the SDK sandbox facade exists separately.
   Action: Replace the `BridgeClient` dependency with a small `AgentSessionTransport` interface and ship adapters for router bridge, direct cli-bridge local shim, and `TCloudSandbox`/Sandbox SDK sessions.
   Verification: Add an opt-in integration suite that runs the same `AgentRunOptions` through direct cli-bridge and Sandbox SDK transports and asserts resume/session continuity plus identical criterion-loop behavior.

2. [HIGH] `packages/tcloud/src/client.ts:563` - `providerOptions` is spread after standard chat fields, so callers can override `model`, `messages`, `stream`, `tools`, and `gateway` fields while `tcloud-agent` uses that escape hatch to smuggle sandbox `agent_profile`.
   Action: Make `providerOptions` non-overriding or denylist protected keys, and add a typed sandbox/bridge extension field for `agent_profile`/`session_id` instead of relying on raw body mutation.
   Verification: Change the existing providerOptions override test to assert `model`/`messages`/`stream` cannot be overridden, and add a typed inline `AgentProfile` test proving sandbox dispatch still serializes the expected body.

3. [HIGH] `packages/tcloud/src/client.ts:202` - `fromCliBridge` explicitly tells users to bypass the SDK and POST raw `session_id` for resumable agentic sessions, so the local shim path is not first-class or API-compatible with router-mediated bridge sessions.
   Action: Add a first-class direct cli-bridge session adapter that maps `resume` to cli-bridge `session_id` and `model` to `<harness>/<model>`, then make `tcloud-agent` use it through the shared transport interface.
   Verification: Add a local cli-bridge integration test, gated by `CLI_BRIDGE_URL` and `CLI_BRIDGE_BEARER`, that creates a resumable sandbox agent session through the SDK without `@ts-expect-error` body fields.

4. [MEDIUM] `packages/tcloud-agent/src/agent-runner.ts:268` - `workspace.dir` is appended to the prompt as text instead of becoming a sandbox mount or permission-scoped workspace, which makes it look authoritative while providing no execution boundary.
   Action: Either rename the option to `workspaceHint` or implement it as transport-level workspace configuration enforced by the sandbox/profile permissions.
   Verification: Add tests that prove workspace configuration is passed to the transport layer, or if renamed, that no prompt-only workspace binding remains in `AgentRunOptions`.

5. [MEDIUM] `packages/tcloud-agent/src/agent-runner.ts:319` - USD budget enforcement is silently disabled on the default streaming path because streaming chunks do not carry usage and `extractUsd` only runs for non-streaming completions.
   Action: When `budget.usd` is set, force non-streaming, require a bridge final-usage event, or fail configuration up front instead of returning `usd: null` after an unbounded streamed run.
   Verification: Add a test where `stream: true` plus `budget.usd` fails closed or switches to non-streaming, and a non-streaming test where reported cost stops the loop.

6. [MEDIUM] `packages/tcloud-agent/src/agent-runner.ts:84` - `ToolPart` and tool events are exposed as part of the agent event model, but the streaming implementation only extracts text deltas and never converts upstream tool-call parts into tool events.
   Action: Parse the sandbox/bridge part stream into tool events or remove tool events from the public contract until the bridge emits them in the OpenAI stream.
   Verification: Add a fixture or integration stream with a tool-call part and assert `Agent.stream` yields tool events, or assert the public type no longer advertises tool events.

7. [MEDIUM] `packages/tcloud/src/client.ts:1250` - The SDK exposes router REST sandbox sessions via `TCloudClient.sandboxCreate` while `TCloudSandbox.create` wraps `@tangle-network/sandbox`, but `tcloud-agent` uses neither, leaving three sandbox surfaces without a canonical ownership boundary.
   Action: Define one public sandbox-agent facade and document/implement which layer owns provisioning, TEE attestation, session gateway access, and agent run-loop execution.
   Verification: Add a single end-to-end example and test path that provisions or attaches to a sandbox through the facade and runs an agent through `tcloud-agent` without directly touching bridge internals.

8. [LOW] `packages/tcloud/tests/chat.test.ts:169` - The test name says `providerOptions` do not override standard fields while the assertion proves the opposite, making the current unsafe behavior easy to miss during review.
   Action: Rename the test to describe the current escape hatch only if the override behavior remains, or invert the assertion as part of the protected-field fix.
   Verification: Run `packages/tcloud` chat tests and confirm the test title and assertion agree with the intended API contract.

## Target architecture

The clean version is `tcloud-agent` owning the loop and depending on one transport contract, not on CLI Bridge directly:

```ts
interface AgentSessionTransport {
  start(input: AgentSessionStart): Promise<AgentSessionHandle>
}

interface AgentSessionHandle {
  resumeId?: string
  chat(input: AgentTurnInput): Promise<AgentTurnResult>
  stream(input: AgentTurnInput): AsyncIterable<AgentTurnEvent>
}
```

Then ship three adapters:

- `RouterBridgeSandboxTransport` for `TCloudClient.bridge({ harness: 'sandbox' })`.
- `LocalCliBridgeSandboxTransport` for `TCloudClient.fromCliBridge(...)`, mapping `resume` to `session_id`.
- `SandboxSdkTransport` for `TCloudSandbox` / `@tangle-network/sandbox` session gateway execution.

`AgentRunOptions` should select or receive a transport. Inline `AgentProfile`, resume IDs, workspace permissions, and budget/cost reporting should be typed transport inputs, not raw `providerOptions` body fields or prompt suffixes.
