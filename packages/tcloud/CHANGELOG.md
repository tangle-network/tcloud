# Changelog

## 0.6.0

- Forward chat, streaming-chat and search cancellation to the actual HTTP transport and response body. Abort retry waits without another attempt. Preserve cancellation through the relayer.
- Expose per-response `tangle.costUsd` with a receipt/rates source. Never label the legacy aggregate fallback estimate as a reported cost. This avoids concurrent-call accounting races in consumers.
- Move the SDK and Pi package to the published Sandbox 0.54 line. No Sandbox REST facade or agent-runner consolidation is included.
- Retain the Pi raw-HTTP deletion already merged in #58.

Knowledge's transport migration must install this published release before it can use these APIs. A packed candidate is only a pre-release build check, not a registry publication.
