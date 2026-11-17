# Engineering Review: SABR Reload Doom Loop & Rising 403 Errors

**Branch:** `sabr-reload-doom-loop-review`
**Author:** Private fork investigation (alkimiadev/FreeTube)
**Base:** FreeTube `development` @ `8b854d9dd` (post-0.26.0-beta)
**Related upstream issues:**
- https://github.com/FreeTubeApp/FreeTube/issues/10090 — *Many breaks at video playing (SABR reloads)* — locked as widely-reported
- https://github.com/FreeTubeApp/FreeTube/issues/10114 — *Slowly increasing frequency of 403 errors* — locked as widely-reported
- https://github.com/FreeTubeApp/FreeTube/issues/10024 — *Uptick in reloading due to SABR request messages* (earlier report)
- https://github.com/FreeTubeApp/FreeTube/pull/10131 — *Fix reloading video view reloads twice every time* (open; addresses only one amplifier, see §3.5)

This document is a code-level review of the feedback loops that plausibly link the two
reported symptoms: (a) repeated "Reloading player according to SABR request" interruptions,
and (b) increasingly frequent `[BAD_HTTP_STATUS: 403]` hard failures that resolve on refresh
or IP change. It also records the verdict on third-party dependencies (§4), the upstream
contribution-policy interpretation (§6), and candidate fixes (§5).

---

## 1. Background: how SABR streaming works in FreeTube

FreeTube's Local API DASH backend does not download `videoplayback` segments from static
URLs. It speaks YouTube's **SABR** (Server-Audio-Video-Bandwidth-Negotiation, a.k.a.
server-side ABR) protocol: the client POSTs protobuf ABR requests to a googlevideo
ustreamer endpoint and receives a UMP (Unified Media Player) byte stream containing media
segments interleaved with *control plane* parts:

- `NextRequestPolicy` — tells the client how to shape the **next** POST: playback cookie,
  readahead targets, and a **`backoffTimeMs`** the client should wait before issuing the
  next request. Retrying is the *normal steady-state* of this protocol; a segment fetch is
  almost always followed by another fetch.
- `SabrRedirect` — relocate the streaming endpoint.
- `ReloadPlaybackContext` — the server decides the client must abandon the stream and
  re-request playback from Innertube (a full "player reload").
- `SabrError`, `StreamProtectionStatus` (poToken validation), SABR context updates, etc.

The control plane is implemented entirely in
`src/renderer/helpers/player/SabrSchemePlugin.js` (`doRequest`, lines 284-606), registered
as a shaka-player custom `sabr:` scheme by `setupSabrScheme()` (line 616). Playback
data-plane correctness (manifest/segment bookkeeping) lives in
`src/renderer/helpers/player/SabrManifestParser.js` and was not the focus of this review.

---

## 2. Observed symptom set (from upstream reports + user observation)

| Observation | Source |
|---|---|
| "Reloading player according to SABR request" toast repeats 2-7× , mostly early in a video; sometimes "every 5-10 seconds", sometimes "endless looping with SABR request and the same sequence over and over" | #10090 (multiple commenters, e.g. NoxStellans, Cyborgscode, lanmarc77) |
| Devtools shows massive numbers of identical requests to googlevideo, many per second, during an active loop | User's own capture (this fork's maintainer) |
| Reload bursts are followed by `[BAD_HTTP_STATUS: 403]` on `sabr:...?init` requests (shaka data shows 403 for the *first* two request numbers, `rn=0` and `rn=1`) | #10114 console logs (alimima, M0ahgra, DSero-Asturi) |
| 403s "resolve after reloading the page", are not persistent per-video, and increasing in frequency over weeks | #10114 (M0ahgra) |
| Users switch VPN endpoints more often; symptom pattern consistent with soft IP rate-limiting rather than a hard ban | User experience, MAD-hatter-IZZY in #10114 |
| Frequency of reloads "exploded" in mid-November 2026 | #10114 timeline comments |

The `rn=` parameter in the 403'd URLs is set by `SabrSchemePlugin.js:477`
(`sabrURL.searchParams.set('rn', ...)`) — it is the per-request counter of the SABR control
plane, not shaka's own retry counter, which confirms the failing requests are the plugin's
POST stream.

---

## 3. Findings

All line numbers refer to `SabrSchemePlugin.js` unless noted.

### 3.1 Zero/absent `backoffTimeMs` produces unthrottled retry bursts (HIGH)

`doRequest` only delays between recursive self-calls when the server explicitly asked it to:

```js
// line 305
if ((currentState.sabrStreamState.nextRequestPolicy?.backoffTimeMs || 0) > 0) { ... }
```

When YouTube sends `NextRequestPolicy` with `backoffTimeMs = 0` or omits the field (both
legal — the proto field is an optional int32), the client waits **nothing** before issuing
the next POST. The only guard is a counter:

```js
// line 326
if (shouldReloadDueToBackoffLoop || currentState.cumulativeRetryDueToNextRequestPolicy >= 100)
```

i.e. up to **100 network-speed POSTs** per shaka request-op before the "fake reload"
breaks out. Since shaka issues separate ops for video and audio (each op has its own
`cumulativeRetryDueToNextRequestPolicy` counter — the `rn` parameter is a session-wide
counter shared across ops, see `sabrStreamState.requestNumber`), the effective burst is up
to ~200 requests, repeated after every player reload, with the counter resetting each
session.

This matches the devtools observation of "many per second, the same request"
(all requests in a burst are byte-identical except `rn=`).

**Important negative finding:** the value itself is NOT mis-decoded. We vendored and
inspected `googlevideo@5.0.1`
(`dist/protos/generated/video_streaming/next_request_policy.js:34`): `backoffTimeMs` is a
plain `int32` wiretype (`writer.uint32(32).int32(...)`), no `Long`/string conversion
pitfall, so `|| 0 > 0` behaves correctly for any positive value the server sends. The bug
is FreeTube's *policy* for handling a zero/no-backoff value, not the decode.

### 3.2 `SABR_REDIRECT` retries bypass all loop detection (HIGH)

```js
// lines 357-363
case UMPPartId.SABR_REDIRECT: {
  ...
  currentState.sabrStreamState.sabrUrl = sabrRedirect.url
  shouldRetry = true    // <-- but shouldRetryDueToNextRequestPolicy is NOT set
  break
}
```

The recursion guard `cumulativeRetryDueToNextRequestPolicy` is only incremented for
`NextRequestPolicy` retries (line 526-529). A redirect chain that points back to itself
(or ping-pongs between two endpoints) is therefore an unbounded, zero-delay infinite
recursion in `doRequest`. This is the most severe hole in the file. Whether production
traffic actually hits a self-redirect is unconfirmed, but the code admits it without any
cap.

**Precision note:** the recursion is only *zero-delay* when no `NextRequestPolicy` with a
positive `backoffTimeMs` is in play. `sabrStreamState.nextRequestPolicy` persists across
ops (it is only overwritten when a new NRP part arrives), so a stale positive backoff
would add a wait per redirect iteration and could eventually trip the ≥3-backoff
watchdog (§3.3). The truly unbounded case — a redirect loop with zero/absent
`backoffTimeMs`, exactly the §3.1 regime — is unaffected.

### 3.3 The player-reload chain is unbounded and unthrottled (HIGH — best fit for the reports)

Reload triggers exist in two places:

1. `UMPPartId.RELOAD_PLAYER_RESPONSE` (lines 457-467) — server-ordered reload.
2. The internal watchdog (lines 304-333) — fires on either ≥3 cumulative backoffs
   (`cumulativeBackOffRequested >= 3`) *or* ≥100 `NextRequestPolicy` retries.

Both do: `abortController.abort()` + `eventEmitter.emit('reload')` →
`onReloadOnce` in `FtShakaVideoPlayer.vue:1314` →
`Watch.vue:59` → `Watch.js:1991 onSabrReloadRequested()` →
`reloadView()` (`Watch.js:359`) → full refetch of the watch page HTML, `/youtubei/v1/player`
and `/next` (via `getLocalVideoInfo`, youtubei.js), then a **brand-new SABR session** in
which **all counters have reset**.

Gaps in the governor:

- `onSabrReloadRequested` has **no throttle** (compare the manual reload path,
  `Watch.js:1986 onManualReloadRequested`, throttled to 1 s).
- There is **no cap on consecutive server-requested reloads** of the same video, no
  backoff between sessions, and no memory of why the previous reload happened. If the
  server (or the client's request shape — same cookie, same clientInfo, fresh poToken)
  keeps eliciting the same `RELOAD_PLAYER_RESPONSE`, the loop repeats indefinitely with
  each iteration amplifying traffic to `youtubei` + `googlevideo`.
- The ≥3-backoff tripwire (line 322) is aggressive: three *legitimate* backoffs at stream
  start — a normal SABR pattern — trigger a full player reload. This plausibly explains
  the "2-7 reloads in the first minute, then it works" signature in #10090.

This unbounded chain is the best mechanism to connect the two issues: a client that
relentlessly re-issues playback + streaming requests is exactly the profile that Google's
edge soft-rate-limits. A limit on `googlevideo.com`/`youtubei/v1/playback` from a given IP
or session then produces the intermittent, refresh-resolving 403s of #10114 — observed on
the *first* SABR POST of a fresh session (`rn=0`), consistent with IP/session-level
throttling rather than stale stream params.

### 3.4 Secondary hazards (MEDIUM/LOW)

- **Op timeout interacts badly with multi-backoff streams.** `createTimeoutController`
  (lines 263-278) resets the op-wide timeout **once** (`resetTimeoutOnce`). A stream with a
  second long backoff past the 60 s op timeout (configured in
  `FtShakaVideoPlayer.vue:2835`) aborts mid-backoff → `RecoverableNetworkError(TIMEOUT)` →
  shaka's own bounded retry issues the request again. Bounded, but adds request churn.
- **Aborted backoff wait leaks a timer.** Line 309-312: the `abort` listener rejects the
  promise but the `setTimeout(resolve, ...)` is never cleared. Cosmetic, not loop-relevant.
- **Post-reload stale scheme state.** `playerReloadRequested` stays `true` for the whole
  session (line 298 makes every further request throw immediately) until
  `destroyPlayer` → `sabrStream.cleanup()` (`FtShakaVideoPlayer.vue:3254`). If `reloadView`
  fails midway (e.g. `getVideoInformationLocal` throws — note the
  "Could not find /next response in the HTML page" errors in #10114 logs, suggesting the
  HTML fetch was already degraded), the scheme sits registered and dead; user-facing result
  is a stuck player, not a loop. LOW.

### 3.5 Confirmed amplifier: SABR reload runs the view reload twice (see upstream PR #10131)

`onSabrReloadRequested` → `saveWatchProgressForReload` (`Watch.js:1972`) does
`$router.replace({...oneTimeTimestamp...})`. When the route query actually changes, the
`$route` watcher (line 338) fires and calls `reloadView()` *a second time*, on top of the
explicit one. PR #10131 (open, unmerged at review time) makes `reloadView` idempotent
against concurrency. Merging it halves reload traffic but does **not** close the
unbounded-chain hole (§3.3).

---

## 4. Dependency verdict

- `googlevideo@5.0.1` — protos decode correctly (see §3.1). The retry/backoff policy code
  is FreeTube-vendored (`SabrSchemePlugin.js`), not library code. **Bug location: FreeTube.**
- `youtubei.js@18.3.0` — Innertube fetch layer; per-reload HTML parsing failure (`/next`)
  observed upstream is a symptom of degraded responses, not the loop driver.
- `shaka-player@5.3.3` — the custom `sabr:` scheme's failures are surfaced as
  Recoverable/Critical ShakaErrors; shaka's built-in retry caps bounded paths and is not
  implicated in the unbounded loops.

---

## 5. Remediation plan for this fork

**Process model**

- One commit per change, on this branch, ordered so each change is independently
  revertable (bisectable) and locally testable.
- **No unit-test harness.** The codebase (upstream and this fork) carries no test
  infrastructure at all, none is being introduced. Verification is (a) dev-build manual
  repro passes on the maintainer's machine following §7, and (b) build-time-gated
  instrumentation counters (item A) compared before/after. Note: instrumentation is
  gated behind `process.env.NODE_ENV === 'development'` (webpack-baked per build mode,
  the existing idiom in e.g. `src/renderer/helpers/player/Mp4SegmentIndexParser.js:86`),
  so release builds contain none of it.
- Each item below is updated in-place (checkbox + short verdict) at commit time, so a
  later session can resume from the list without re-reading the whole thread.

**Order and progress checklist**

1. [ ] **A. Instrumentation (dev-only).** Counters on the SABR control plane, logged to
   the devtools console: POSTs-per-minute to the ustreamer endpoint, control-plane
   breakouts (backoff-loop fake reload, NRP-retry cap, redirect loop), and reload requests
   per video view. This is the measuring stick for every other item, and doubles as the
   evidence generator for a future upstream contribution (#10090 asked for such data).
2. [ ] **B. §5.2 redirect cap (`SabrSchemePlugin.js`).** Per-op redirect counter plus
   self-redirect detection (target normalizing to the current `sabrUrl` modulo `rn`);
   on trip, use the same breakout as the backoff watchdog (abort + `reload` emit).
   Closes the only unbounded recursion.
3. [ ] **C. NRP-retry backoff floor (`SabrSchemePlugin.js:305`).** When the last
   `NextRequestPolicy` sets `backoffTimeMs` to 0/absent, wait a jittered floor
   (250–1000 ms) before the next POST instead of retrying at network speed. Both existing
   breakouts (≥3 real backoffs / ≥100 NRP retries) keep their current semantics; floored
   waits do **not** count toward the ≥3 tripwire (so a legitimate zero-backoff policy can
   never turn the request burst into an unbounded *reload* burst — that would trade one
   doom loop for another).
4. [ ] **D. Reload governor (`Watch.js`).** Throttle `onSabrReloadRequested`; additionally
   cap consecutive *server-initiated* reloads per video+session (e.g. ≤5), with an
   escalating cooldown (e.g. 2 s, 5 s, 15 s, …) between them. On cap exhaustion, surface
   an error state instead of reloading again. Bounds worst-case request rate to YouTube
   regardless of server behavior.
5. [ ] **E. Backoff-aware timeout (`SabrSchemePlugin.js:263`).** Let each backoff wait
   push the op deadline forward so long-but-legitimate backoffs don't churn
   abort/retry cycles. Needs care with shaka's retry semantics — deliberately last.
6. [ ] **F. Ameliorate the double-`reloadView` amplifier** (§3.5, upstream PR #10131). Held
   until the upstream diff is reviewed: it is another contributor's fix and courtesy
   dictates we port it with attribution, or leave it to merge upstream.

**Sequencing note:** items A–C land in this branch's first remediation series. After B
and C the maintainer re-runs the §7 repro locally and compares the instrumentation
numbers against the pre-fix baseline; item D follows once that baseline is recorded (D
changes user-visible reload behavior and is safest to design against measured data).

**Original fix sketches** (superseded in ordering/detail by the checklist above, kept
for the underlying design notes):

1. **Govern the reload chain (Watch.js).** Throttle `onSabrReloadRequested`; additionally
   cap consecutive *server-initiated* reloads per video+session (e.g. ≤5), and apply an
   increasing cooldown (e.g. 2 s, 5 s, 15 s...) between them. On cap exhaustion, surface an
   error state instead of reloading again. This bounds worst-case request rate to YouTube
   regardless of server misbehavior.
2. **Close the redirect hole (SabrSchemePlugin.js).** Increment a per-op counter on
   `SABR_REDIRECT` (like `cumulativeRetryDueToNextRequestPolicy`), and/or ignore redirects
   whose target URL normalizes to the current `sabrUrl` (modulo `rn`), converting the
   would-be infinite recursion into a bounded retry or reload.
3. **Floor the effective backoff (SabrSchemePlugin.js:305).** Treat `backoffTimeMs <= 0`
   as a small floor (e.g. 250-1000 ms jittered) so "retry now" bursts degrade gracefully;
   keep the existing ≥3/≥100 breakouts.
4. **Backoff-aware timeout (SabrSchemePlugin.js:263).** Let each backoff wait push the op
   deadline forward (or drop `resetTimeoutOnce`'s one-shot limit for waits caused by
   server policy), so long-but-legitimate backoffs don't churn abort/retry cycles.
5. **Merge/port #10131** (double `reloadView`) for the amplifier.
6. Optional instrumentation (dev-only): counter of POSTs/min + reload count logged to the
   console, to make the fix demonstrable in a screen recording for upstream (they asked
   for such evidence in #10090).

---

## 6. Upstream contribution policy interpretation (CONTRIBUTING.md)

Relevant text (CONTRIBUTING.md, "Before starting to code", bullet 4):

> Please refrain from using AI/LLMs to create issues, pull requests, comments, or any
> other content submitted to the FreeTube project. It's a waste of our team's time.
> Repeat offenders will be banned.

Reading: the prohibition is scoped to **AI-generated GitHub-facing content** (issues, PR
text, comments). It does not prohibit the use of tooling/LLMs during private development,
debugging, or in one's own fork. The same PR template comment observed on #10131
("PRs created mainly with AI will be closed... We ban repeat offenders") is likewise about
submission hygiene. Practically: a human-authored PR describing a human-understood fix is
compliant; wholesale AI-authored prose or unreviewed AI patches are not. Any eventual
upstream contribution from this fork should be written and verified by the maintainer
personally, referencing this review only as background. Plan to notify the team via their
Matrix room as suggested in CONTRIBUTING.md ("Before starting to code", bullet 3) that a
working fork with candidate fixes exists.

---

## 7. Reproduction & verification notes (for follow-up branches)

- Reproduce `rn`-burst: enable devtools network filtering on `googlevideo.com` + `POST`
  while a loop is active; group by URL excluding `rn`. Expect ≥100 identical URLs per
  burst when `backoffTimeMs` is 0/absent.
- Confirm reload-chain: count consecutive "Reloading player according to SABR request"
  toasts per video view; log `getLocalVideoInfo` invocations (`/youtubei/v1/player`) per
  minute before/after fix #1.
- The 403 signature to reproduce for #10114: sustained ≥100 POSTs/min to the ustreamer
  endpoint for some minutes, then a fresh session; expect the new session's `rn=0` POST to
  be rejected while the same URL works after an IP change.
