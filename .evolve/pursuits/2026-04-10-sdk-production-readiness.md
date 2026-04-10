# Pursuit: tcloud SDK Production Readiness
Generation: 1
Date: 2026-04-10
Status: building

## System Audit

### What exists and works
- TCloudClient with full OpenAI-compatible API surface (39 public methods)
- 5 routing strategies in PrivateRouter (round-robin, random, geo-distributed, min-exposure, latency-aware)
- ShieldedCredits with EIP-712 SpendAuth signing
- Instance harness for local dev (spawns cargo-tangle)
- watchJob() SSE streaming with token auth
- providerOptions pass-through for provider-specific params
- toolChoice support
- 97 tests across 6 files
- LiteLLM config pointing at router.tangle.tools for sandbox integration

### What exists but isn't integrated
- Spending limits (`checkLimits()`) only called by chat/chatStream/avatarGenerate — batch, fineTune, video, embeddings bypass it entirely
- Request counting (`_requestCount`) missing from 19 methods — usage stats are wrong

### What was tested and failed
- Nothing explicitly failed; gaps are untested code

### What doesn't exist yet
- Tests for shielded.ts (pure crypto functions — wallet gen, SpendAuth signing, cost estimation)
- Tests for proxiedFetch (privacy relay/socks5 routing)
- Retry/backoff on transient failures
- Consistent error handling across all methods

### Measurement gaps
- No way to verify request count accuracy across all methods
- No way to verify spending limits enforcement across all methods

## Current Baselines
- 97 tests, 6 files
- 6/39 public methods have direct test coverage (15%)
- 3 different error handling patterns across methods
- 19 methods missing request count tracking
- 4 expensive methods bypass spending limits

## Diagnosis
The SDK grew method-by-method without enforcing consistency. Each new endpoint copied a slightly different error handling pattern. Spending limits and request counting were added to chat methods but not retroactively applied to other methods. The result is an SDK that works for the happy path but has silent inconsistencies that will bite production users.

Root causes (architectural, not tunable):
1. No shared request helper — each method builds its own fetch call
2. No test coverage for the common path forces manual consistency checking
3. Shielded module is untested because it imports viem — needs mocking strategy

## Generation 1 Design

### Thesis
Consolidate all API methods through a shared request path that enforces counting, limits, and error handling uniformly — then cover the remaining untested modules.

### Changes (ordered by impact)

#### Architectural
1. **Shared `_request()` helper** — all API methods route through one internal method that handles: checkLimits, request counting, error parsing, proxiedFetch. Eliminates 3 error patterns → 1.
2. **Consistent error handling** — all methods use detailed error parsing (Pattern 1), not generic messages.
3. **checkLimits on all billable methods** — batch, fineTune, video, embeddings all check limits before firing.

#### Tests
4. **shielded.ts tests** — generateWallet, signSpendAuth, estimateCost (pure functions, no blockchain needed)
5. **proxiedFetch tests** — mock fetch for direct/relayer/socks5 modes
6. **Error handling consistency tests** — verify all methods parse error details
7. **Request counting tests** — verify all billable methods increment counter

### Success Criteria
- All 39 public methods route through shared request path
- checkLimits called for all billable operations
- _requestCount incremented for all billable operations
- Error messages always include server details (not generic strings)
- shielded pure functions tested
- 130+ total tests
