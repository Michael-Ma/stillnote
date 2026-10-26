# Repository audit — 2026-10-25

**Audited revision:** `0b6568bd095562584ebd0c60e9f6b972cec7e38a` (`main` when the review began).
**Scope:** native capture/recognition and Auto-language arbitration; Electron IPC and lifecycle; AI providers/authentication; storage/search/import/export/deletion; renderer flows; calendar/call handling; build/install/signing scripts; tests and current reference docs.

Review and documentation changes were made in a separate managed worktree. The application code and the shared checkout were not changed by this audit. Findings below remain open at the audited revision. Earlier dated reviews are historical evidence, not proof that later changes are correct.

## Baseline verification

- `npm test`: **164 passed**.
- `npm run build`: **passed** (native helper and renderer/main bundles).
- `npm run test:e2e -- --no-build`: **all seven suites passed**: language, reminders, calls, recovery, notebook, capture, AI.
- Native checks: readiness probe, capture self-test (**11 checks**), and scheduler self-test (including **five silence-boundary checks**) passed without opening audio devices or making recognition requests.
- Additional isolated repros: `node docs/ai/review-probes.mjs` reproduced six uncovered behaviors using temporary data, the production main-process handlers, and synthetic provider/helper fixtures. **These probes assert the current defects, not product correctness; they are not a replacement for regression tests after a fix.**
- An installed Claude CLI status check used an empty temporary configuration and a synthetic token only. With `ANTHROPIC_BASE_URL=http://127.0.0.1:9`, it still reported `loggedIn: true, authMethod: oauth_token`. No inference request, real credential, or private meeting data was used.

Live microphones, real calendars/notifications, account inference, language downloads, signing setup, and installation into `/Applications` were not exercised. Native startup and missing-primary-language findings are static control-flow findings; their latency/failure was not induced on real hardware during this audit.

## Significant findings

### F1 — P1: speech-model initialization gates raw audio capture

**Locations:** [native/Capture.swift:1461–1472](../../native/Capture.swift#L1461), [1507–1518](../../native/Capture.swift#L1507), [437](../../native/Capture.swift#L437).

`Capture.start` awaits construction of the microphone's speech channel before calling `startMicrophone()`. The system track similarly awaits its transcriber before `SCStream.startCapture()`. Modern construction awaits locale/asset work and `analyzer.prepareToAnalyze`; there is no bound around this preparation.

**Trigger/impact:** a cold, slow, or stalled model delays the actual audio inputs, not merely the transcript. Audio spoken in that interval is absent from the WAV and cannot be recovered with Retry. This matters especially because Start/Join opens the meeting before recording readiness. A healthy recording after startup does not reveal this missing opening interval. The current second-language pre-roll does not protect first-language startup.

**Fix direction:** start authorized audio inputs and durable WAV writing independently of speech-model preparation. Attach recognition asynchronously, with a bounded pre-roll or catch-up from the saved audio; show separate capture and recognition readiness. A delayed/failing model must not prevent saving speech.

**Regression needed:** inject a delayed and a never-completing speech factory; assert both raw sources receive/persist frames before recognition becomes ready, and Stop remains bounded.

### F2 — P1: Claude's subscription-only and provider-routing boundary is not enforced per request

**Locations:** [app/providers/claude-code.mjs:36–50](../../app/providers/claude-code.mjs#L36), [325–336](../../app/providers/claude-code.mjs#L325).

`respond()` refreshes authentication only when installation is unknown or the cached state says signed out. A previously accepted plan session can therefore launch inference after the user's external CLI sign-in has changed to API billing. If status cannot be read, the nonempty `state.error` also bypasses the signed-out rejection. Separately, `cliEnv()` removes only two credential variables while preserving endpoint/provider overrides and other credentials.

**Evidence:** the fake-CLI repro first established plan authentication, changed the external CLI's reported method to `api_key`, and observed a print request with **no new status check**. The endpoint/env probe preserved a custom gateway and Bedrock routing. The real CLI status-only check described above showed that a custom endpoint can still look like `oauth_token` authentication.

**Impact:** the UI's connected-plan indication is not a billing or destination guarantee. Meeting text can follow incompatible CLI routing, or requests can use newly selected API authentication. This audit did not charge an account or transmit meeting data.

**Fix direction:** fail closed on unreadable auth status; revalidate the effective authentication/routing for every request; explicitly reject unsupported gateway/provider configurations instead of relying on two deleted environment variables. Respect managed organizational policy rather than silently bypassing it. Keep documentation conditional until the boundary is enforced.

Anthropic documents endpoint/provider environment overrides and that safe mode retains normal authentication and managed policy behavior: [environment variables](https://code.claude.com/docs/en/env-vars), [CLI safe mode](https://code.claude.com/docs/en/cli-reference#cli-flags). Safe mode is not a subscription-only transport.

### F3 — P2: a timed-out retry can leave the helper permanently busy

**Locations:** [app/main.mjs:1215–1229](../../app/main.mjs#L1215), [native/Capture.swift:2461–2483](../../native/Capture.swift#L2461).

The main process rejects the request and clears `transcriptionWait`, then sends `cancel-transcribe`. It does not wait for an acknowledgement or replace the helper if cancellation does not finish. The helper clears its `transcribing` flag only after the underlying transcription call returns. The native watchdog also asks the same analyzer to cancel; it does not guarantee that an unresponsive XPC call returns.

**Evidence:** a fault-injection helper kept transcription active after cancel. The production timeout handler sent cancel but did not kill/replace it; the next Record attempt became `startfailed`. This is a simulated unresponsive helper, not a claim that a real analyzer hang was observed in this review.

**Fix direction:** use correlated cancellation acknowledgements and a short grace deadline, then replace the stuck helper when idle capture permits it, as the existing stop watchdog already does. Preserve recordings and the prior transcript.

### F4 — P2: back-to-back reminders open the new call before the old stop is acknowledged

**Location:** [app/main.mjs:1537–1556](../../app/main.mjs#L1537).

The handoff defers `showMeeting(B)` through `afterStop`, but `openCall(B)` runs immediately outside that continuation. The notification promises to save A, then join and record B; the implementation does not preserve that ordering.

**Evidence:** the repro held A's native stop acknowledgement. B's call URL was opened while A remained the active, stopping recording and B had not begun capture.

**Impact:** depending on stop latency, the beginning of B can be captured in A or missed while A finalizes. The existing test checks eventual note switching and that a link opened, but not their order.

**Fix direction:** coordinate the handoff in one place: stop/save A, prepare B's raw capture, then open/join B. If immediate joining is intentional, explicitly handle and disclose the recording gap rather than claiming atomic switching.

### F5 — P2: stopping Auto language can persist an expired provisional phrase

**Locations:** [app/language-arbiter.mjs:537–549](../../app/language-arbiter.mjs#L537), [app/main.mjs:245–248](../../app/main.mjs#L245).

`flush()` calls `expire(s, now)` but ignores its returned discard actions. `expire` removes the entries from the arbiter's `shown`/`volatile` state, so the later cleanup cannot rediscover them. The main process still has the old entry in `pendingPartials`, and finalization appends those entries to the saved transcript.

**Evidence:** push a provisional phrase at time 0 and flush at 16 seconds without an intervening tick: `flush()` returns no actions and the caller still holds the expired text. Normal periodic ticks reduce the exposure window, but delayed ticks, sleep, or stop/timer ordering can expose it.

**Fix direction:** return/apply the expiry discards before force-resolution. Test the actual stop/finalization path with delayed timers, not just ordinary `tick()` expiration.

### F6 — P2: MCP search is incompatible with the new CJK index

**Locations:** [scripts/mcp.mjs:71–83](../../scripts/mcp.mjs#L71), [app/store.mjs:480–520](../../app/store.mjs#L480).

The store now indexes CJK characters as separate tokens. The application's search builds matching token phrases; the MCP server still submits the old whole-word query. Multi-character Chinese/Japanese/Korean searches therefore miss notes that the app finds.

**Evidence:** a synthetic note containing `项目进展` is found by `Store.search('项目')`, but the actual stdio MCP `search_meetings` tool returns zero results for the same query and database.

**Fix direction:** share the pure query-normalization/search logic with the read-only MCP implementation. Add protocol-level tests against a database written by the current store.

### F7 — P2: Auto retry cannot fall back when its primary language fails

**Locations:** [native/Capture.swift:2014–2028](../../native/Capture.swift#L2014), [2068–2074](../../native/Capture.swift#L2068).

The modern retry loop catches language failures only when `pass > 0`. If the primary Auto candidate is unavailable or fails initialization, the error escapes before trying the secondary candidate. Live capture explicitly supports the opposite case: the secondary can carry a source when the primary fails.

**Trigger/impact:** with a missing primary model and an installed secondary model, live recording can work in the secondary language, but Retry on that recording fails instead of recovering it in the same language. This is a static control-flow finding; no language was uninstalled to test it.

**Fix direction:** distinguish a failed language candidate from a missing/corrupt source file. Try the remaining candidates per source, return usable alternatives with explicit degradation metadata, and preserve old text if a source has no valid replacement.

## Additional data-retention/documentation caveat

Permanent deletion removes the note, FTS row, transcript versions, and `meeting:<id>` chat. It does **not** remove answers in `all` or folder chats that cite the deleted meeting. The repro removed a synthetic note and still found its quoted detail in notebook chat and in the next JSON backup.

This is a product/deletion-contract decision rather than an assertion that every cross-note conversation must be erased. However, confirmation and documentation should state the scope clearly, or deletion should cascade/redact the tracked source references if full erasure is intended. The existing database-file erasure test only covers meeting-scoped data. Source: [app/store.mjs:421–426](../../app/store.mjs#L421), [app/ui.jsx:665–674](../../app/ui.jsx#L665).

## Documentation corrections made in this review

- Added this audit and a reproducible synthetic probe script.
- Separated current verification from the October 20 historical validation record.
- Updated architecture documentation for schema version 3, separate transcript-history storage, ID-only search results, actual quit behavior, permanent deletion, and the current backup boundary.
- Qualified Claude routing/billing claims and corrected the signing/keychain description.
- Added the known CJK MCP search limitation and the cross-note deletion-retention caveat.

## Fix order and acceptance

1. **Capture reliability:** F1 and F4 together; then F3. Test delayed model preparation, delayed stop acknowledgements, and cancellation that never acknowledges.
2. **Provider boundary:** F2. Use stale/changed CLI auth and gateway/third-party environment fixtures; no real paid request is needed.
3. **Transcript correctness:** F5 and F7. Test stop-time expiry and primary-language failure explicitly.
4. **Cross-file search contract:** F6. Test the real MCP transport against current indexes.
5. Decide the deletion-retention contract and align confirmation, implementation, and backup docs.

Passing the existing suite does not close these findings. Real-device capture/notifications, bilingual accuracy, disk-full recovery, credential/keychain behavior, and installation were not revalidated here. No live account request or personal notebook was used. The review is pinned to the revision above; later commits need a delta review.
