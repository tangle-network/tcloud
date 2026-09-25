# Published packages sweep 4

Base audited: `db71cb5a19ff370c5d32c3518ec6f4bfc16c0341`.

## Findings

- `packages/tcloud/src/sandbox.ts` wraps published `@tangle-network/sandbox`, but also contains direct Sandbox HTTP helpers. The repository's own May audit records three sandbox surfaces: Router REST sandbox methods, `TCloudSandbox`, and tcloud-agent transport.
- `packages/tcloud-agent/src/agent-runner.ts` implements an agent criterion/run loop and sandbox transport layer instead of composing published `@tangle-network/agent-runtime`.
- `packages/tcloud-agent/src/pi-extension.ts` calls Router chat over raw `fetch` instead of using this repository's published TCloud client surface.
- No vendored package directory was found.

## Replacement boundary

TCloud owns the model/service SDK. Sandbox lifecycle belongs to `@tangle-network/sandbox`. Agent execution belongs to `@tangle-network/agent-runtime`. tcloud-agent should be a thin adapter or be removed after consumers move to Runtime.

## Follow-up required

Collapse sandbox lifecycle onto `@tangle-network/sandbox`, move tcloud-agent execution to `@tangle-network/agent-runtime`, and route the Pi extension through `TCloudClient`. Delete the duplicate Router REST sandbox and custom run-loop surfaces once compatibility shims are no longer needed.
