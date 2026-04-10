# Pursuit: Retry, Timeouts, and Reliability
Generation: 2
Date: 2026-04-10
Status: evaluated — ADVANCE

## System Audit
Gen 1 shipped shared _request()/_fetch() helpers, 195 tests, consistent error handling.
Remaining: no retry, no timeouts, chat/chatStream duplicated ~100 lines, proxiedFetch/stop() untested.

## Baselines
- 195 tests, 8 files
- 0 retry logic anywhere
- 0 per-request timeout on regular calls
- chat()/chatStream() have ~100 lines of duplicated operator routing + SpendAuth setup
- proxiedFetch: 3 modes, 0 tests
- Instance.stop(): 0 dedicated tests

## Generation 2 Design

### Thesis
Add resilience primitives (retry + timeout) and eliminate the last DRY violation, making the SDK ready for production traffic.

### Changes

#### Architectural (must ship together)
1. **Retry with exponential backoff** — configurable via TCloudConfig.retry, defaults to 3 retries on 429/5xx with jitter. Applied in _request/_fetch/_requestRaw.
2. **Per-request timeout** — configurable via TCloudConfig.timeout, defaults to 60s. Applied via AbortController in _request/_fetch/_requestRaw.
3. **Shared _prepareChatHeaders()** — extracts operator routing + SpendAuth from chat/chatStream into one helper, eliminating the duplicated setup.

#### Tests
4. **Retry tests** — verify retry count, backoff timing, retryable vs non-retryable status codes
5. **Timeout tests** — verify AbortError → TCloudError conversion
6. **proxiedFetch tests** — relayer mode payload shape, socks5 error on missing dep, direct passthrough
7. **Instance.stop() tests** — SIGTERM, SIGKILL fallback, idempotency

### Success Criteria
- Retry on 429/500/502/503/504 with exponential backoff
- 60s default timeout on all non-SSE calls
- chat()/chatStream() share header preparation
- proxiedFetch: 3 modes tested
- Instance.stop(): dedicated test coverage
- 230+ total tests
- Version bump to 0.2.0
