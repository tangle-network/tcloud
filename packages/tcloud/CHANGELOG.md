# Changelog

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
