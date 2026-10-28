# Changelog

## 1.0.0

- First stable release, the same code as the last 0.x release. Later compatible changes ship as patch releases ([release versioning](https://github.com/tangle-network/agent-runtime/blob/main/docs/release-versioning.md)).

## 0.8.6

- Move the SDK and `@tangle-network/tcloud-agent` 0.5.0 to Sandbox 1.x (`^1.0.15`). Agent App 0.63.67 and Agent Runtime 1.0.0 peer Sandbox `^1`, so the `<1.0.0` range gave every app a second Sandbox copy or an override. tcloud's Sandbox surface (the `Sandbox` client, `create`, and the re-exported `AgentProfile*` types) typechecks unchanged against 1.0.15.

## 0.8.5

- Accept every Sandbox 0.x release from 0.58.4 (`>=0.58.4 <1.0.0`). tcloud uses only the `Sandbox` client, `create` and the re-exported `AgentProfile*` types, and a range that ended at the next Sandbox minor held every consumer below Sandbox 0.65 until tcloud released again. A consumer now installs tcloud next to Sandbox 0.68 without a second Sandbox copy; its own typecheck covers each later Sandbox minor.

## 0.8.4

- Accept Sandbox 0.61 through 0.64 (`>=0.58.4 <0.65.0`). Sandbox 0.64.0 carries `backend.metadata.isolationPrincipal`, which keeps one UID, HOME and OpenCode session per session and member, so a consumer on 0.64 can install tcloud without a second Sandbox copy. tcloud's Sandbox surface (the `Sandbox` client, `create`, and the re-exported `AgentProfile*` types) is unchanged in 0.64.0.

## 0.7.0

Requires Node 22.12 or later, because commander 15 does.

- Move the SDK and the Pi package to the published Sandbox 0.55 line (`>=0.55.3 <0.56.0`).
- Update commander to 15 and viem to 2.56.9.
- The Pi extension (tcloud-agent) now names its optional peer `@earendil-works/pi-coding-agent` 0.87, the renamed Pi package, and checks against its real types.
- Build with tsdown and TypeScript 7. Export paths, formats and entry file names are unchanged.

## 0.6.0

Requires Node 20.19 or later. GTR proof uses Node 22.

- Forward chat, streaming-chat and search cancellation to the actual HTTP transport and response body. Abort retry waits without another attempt. Preserve cancellation through the relayer.
- Expose per-response `tangle.costUsd` with a receipt/rates source. Never label the legacy aggregate fallback estimate as a reported cost. This avoids concurrent-call accounting races in consumers.
- Meter billed response headers even when token usage is absent. Apply aggregate spend limits to those charges.
- Move the SDK and Pi package to the published Sandbox 0.54 line. No Sandbox REST facade or agent-runner consolidation is included.
- Retain the Pi raw-HTTP deletion already merged in #58.

Knowledge's transport migration must install this published release before it can use these APIs. A packed candidate is only a pre-release build check, not a registry publication.
