# Tasks: Interactive Snippet Draft (introspection, call box, semantic highlighting)

Strict TDD: every implementation task is preceded by its RED test task (test written and
observed failing before the corresponding production code is written). Tasks are grouped by
slice per design.md's "Migration / Rollout" section, further split for review-budget compliance
per the user's delivery decision (`delivery_strategy=auto-chain`, `chain_strategy=stacked-to-main`):
**1a**, **1b-i**, **1b-ii**, **2-i**, **2-ii**, **3a-i**, **3a-ii-a**, **3a-ii-b**, **3b** — nine
review-sized PRs (1b, 2, and 3a-ii were each split in two after implementation measured over the
400-line budget; 3a-i was kept as one PR with a documented `size:exception`). No slice references
a later slice's symbols. Revert order is 3b → 3a-ii-b → 3a-ii-a → 3a-i → 2-ii → 2-i → 1b-ii →
1b-i → 1a. See "Delivery Plan" at the end of this document for the exact branch stacking order.

---

## Slice 1a — Introspection core (target identity, driver synthesis, sandbox wrapper)

Depends on: nothing (first slice). Unblocks: Slice 1b, and Slice 2 (needs `target` field +
`callDriver.ts` module shipped). Task-id range: **1a.1–1a.4** (was 1.1–1.4).

### 1a.1 — `entitySchema.target` field (D1)

- [x] **RED**: `test/unit/protocol.test.ts` — add cases asserting `entitySchema` accepts an
      optional `target: { module, dottedName, callableKind: "function"|"class" }`, rejects a
      malformed `target` shape, and still validates an entity with `target` entirely absent
      (back-compat with existing golden fixtures).
      Satisfies: `python-structure-analysis` spec, Requirement "Address a specific callable for
      introspection and invocation" (all three scenarios).
- [x] **GREEN**: `src/protocol.ts` — add optional `target` to `entitySchema`.

### 1a.2 — Analyzer emits `target` per function/method/class (D1, spec: python-structure-analysis)

- [x] **RED**: `test/unit/pythonAnalyzer.test.ts` — add cases for: top-level function entity
      carries `target.module`/`target.dottedName`/`callableKind: "function"`; class entity's
      `target` resolves to `__init__` addressing (`callableKind: "class"`, dottedName still names
      the class — introspection consumer applies the `__init__` step, per design driver shape);
      instance method entity's `target.dottedName` is qualified relative to its containing class
      (not a same-named method on an unrelated class); nested/module-level defs get distinct
      `dottedName`s.
      Satisfies: `python-structure-analysis` spec scenarios "Function entity carries an
      addressable module path and qualified name", "Class entity resolves to its constructor for
      introspection", "Method entity carries identity relative to its containing class".
- [x] **GREEN**: `python/analyzer.py` — emit `target` per function/method/class entity.

### 1a.3 — Driver synthesis (`buildIntrospectionDriver`) — pure, no I/O (D2/D3)

- [x] **RED**: `test/unit/callDriver.test.ts` (new file) — cases:
      - happy path: given module source + dottedName + `callableKind: "function"`, the produced
        driver text embeds the module source as a base64 literal and decodes it via
        `base64.b64decode`.
      - class shape: `callableKind: "class"` produces a driver that introspects `cls.__init__`
        (function shape differs from class shape, per design's driver template).
      - **security (adversarial, args-are-JSON-only invariant)**: for adversarial arg values —
        `"'''"`, `"\n_t=__import__('os')"`, embedded NUL, non-ASCII — the args payload segment of
        the generated driver text matches `/^[A-Za-z0-9+/=]*$/` (base64 alphabet only) and no raw
        substring of any adversarial value appears anywhere in the driver text.
      Satisfies: `snippet-function-invocation` spec Requirement "Pass argument values only as a
      JSON payload, never interpolated into source" (scenario "An adversarial value must not
      execute as code" — introspection path shares the same driver synthesis, so this is proven
      here for the base64-envelope invariant reused by slice 2's call driver).
- [x] **GREEN**: `src/execution/callDriver.ts` (new) — `buildIntrospectionDriver(content,
      dottedName, callableKind)`; pure string synthesis + base64 encoding, no I/O.

### 1a.4 — `runIntrospection()` wrapper + `<<ACM>>` frame parsing (D2)

- [x] **RED**: `test/unit/dockerRunner.test.ts` — cases:
      - `runIntrospection()` delegates to the same hardened argv builder as `runSnippet`/`runCall`
        (asserts `buildDockerRunArgs`/`killAndVerifyContainer` are not bypassed or duplicated).
      - `<<ACM>>` sentinel line parsed into structured JSON; when multiple lines match the
        sentinel prefix (e.g. attacker-controlled `print` output before the real result), **only
        the final matching line is authoritative** (per design's risk note) — assert a fabricated
        earlier `<<ACM>>` line is ignored in favor of the last one.
      - malformed/absent `<<ACM>>` frame → `signatureUnavailable`-shaped result, not a thrown
        error.
      - **security**: non-`.py` target (e.g. `requirements.txt`, `README.sh`, an executable
        `.md`) is rejected by `assertEligibleForExecution` **before any container spawn** — assert
        the spawn function is never invoked for these targets.
      - 5s short timeout used for introspection, not `DEFAULT_RUN_LIMITS`.
      Satisfies: `snippet-signature-introspection` spec Requirement "Introspect the selected
      target's signature via sandboxed runtime execution" (scenarios "Introspect a selected
      function", "Introspect a selected class via its constructor"); `sandboxed-snippet-execution`
      spec Requirement "Apply sandbox isolation guarantees to introspection and invocation runs"
      (scenario "Introspection round-trip runs under full sandbox restrictions",
      "Introspection is refused if a required restriction cannot be applied"); Threat Matrix row
      "Documentation-like paths".
- [x] **GREEN**: `src/execution/dockerRunner.ts` — `runIntrospection()` thin wrapper over
      `runSnippet()`; `<<ACM>>` frame parser (last-match-wins).

**Slice 1a exit criteria**: `entitySchema.target` shipped and consumed by the analyzer; pure
driver synthesis and the `runIntrospection` wrapper fully covered, including the base64-envelope
security invariant and pre-spawn `.py`-only rejection. No cache, no form, no UI yet (Slice 1b).

---

## Slice 1b — Introspection cache + parameter form rendering

Depends on: Slice 1a (`target` field on the wire, `callDriver.ts`/`runIntrospection` shipped).
Task-id range: **1b.1–1b.3** (was 1.5–1.7).

**PR split (review-budget guard, applied after implementation measured ~519 changed lines against
the 400-line budget)**: task 1b.1–1b.2 ship as **1b-i** (protocol + host-side cache, wired but not
yet rendered), task 1b.3 ships as **1b-ii** (form rendering that consumes 1b-i's output) — same
"wired but unused until the next PR" pattern already used for slice 3a-i/3a-ii.

### 1b.1 — Host-side LRU introspection cache (D4) — ships in PR **1b-i**

- [x] **RED**: `test/unit/webviewHost.test.ts` — cases:
      - cache hit: re-selecting the same unchanged target (same `entityId` + same content hash)
        does not invoke `runIntrospection`/`runSnippet` a second time.
      - cache miss: editing the snippet content for a previously-cached target triggers a fresh
        introspection round-trip and replaces the cache entry for that key.
      - LRU eviction at 32 entries: inserting a 33rd distinct key evicts the least-recently-used
        entry.
      - Docker unavailable → `signatureUnavailable` posted, no cache entry created, no spawn
        attempted.
      Satisfies: `snippet-signature-introspection` spec Requirement "Cache introspection results
      per target identity and snippet content hash" (both scenarios) and "Docker unavailable
      disables the form without a static fallback" scenario.
- [x] **GREEN**: `src/webviewHost.ts` — `handleRequestSignature`, bounded LRU (32) keyed
      `` `${entityId}|${sha256(content)}` ``.

### 1b.2 — Protocol branches: `requestSignature` / `signatureResult` / `signatureUnavailable` — ships in PR **1b-i**

- [x] **RED**: `test/unit/webviewProtocol.test.ts` — round-trip encode/decode for
      `requestSignature{requestId,sourceId,targetId}`, `signatureResult{requestId,targetId,
      parameters,cached}`, `signatureUnavailable{requestId,targetId,reason}`; rejection cases for
      malformed payloads (missing `targetId`, wrong `parameters` shape).
      Satisfies: `snippet-signature-introspection` spec (both requirements — wire contract that
      carries introspection results and the disabled state).
- [x] **GREEN**: `src/webviewProtocol.ts` — add the three variants/branches.

### 1b.3 — Parameter form rendering + widget mapping table (webview) — ships in PR **1b-ii**

- [x] **RED**: `test/unit/webviewDom.test.ts` — cases:
      - `widgetFor(annotation)` mapping table: `int`/`float` → number input; `bool` → checkbox;
        `str` → text input; `Optional[X]` → toggle + inner widget of `X`; `list[…]`, `dict[…]`,
        unknown/missing annotation, `*args`/`**kwargs` → raw-JSON textarea.
      - raw-JSON fallback: invalid JSON in the textarea blocks the call (call button
        disabled/error shown), valid JSON is `JSON.parse`d before send.
      - Docker-unavailable disabled state: when `signatureUnavailable` is received, the
        input/call form renders as disabled with a visible "unavailable" message, and no static
        AST-derived signature is substituted.
      Satisfies: `snippet-function-invocation` spec Requirement "Render a dynamic per-parameter
      input form from the introspection result" (both scenarios); `snippet-signature-
      introspection` spec scenario "Docker unavailable disables the form without a static
      fallback".
- [x] **GREEN**: `webview/index.ts` — parameter form renderer, `widgetFor` pure function;
      `webview/styles.css` — form styles.

**Slice 1b exit criteria**: `entitySchema.target` consumed end-to-end; selecting a
function/class/method renders a real signature-derived form; cache verified; Docker-unavailable
path verified. No call box yet (slice 2).

---

## Slice 2 — Call-function box

Depends on: Slice 1a (`target` field, `callDriver.ts` module, `runIntrospection` pattern reused
for `runCall`). Can start once 1a.1–1a.4 land; does not need Slice 1b to begin its own RED tests.
Task-id range: **2.1–2.5** (unchanged).

**PR split (review-budget guard, applied after implementation measured ~642 changed lines against
the 400-line budget)**: tasks 2.1–2.4 ship as **2-i** (call-path plumbing: driver, runner,
protocol, host — wired but not yet exposed in the UI; measured ~424 lines, accepted as
`size:exception` — 6% over budget on one tightly-coupled plumbing chain), task 2.5 ships as
**2-ii** (call-box UI + result area, measured ~218 lines) — same split seam already used for
1b-i/1b-ii.

### 2.1 — `buildCallDriver` — class `__init__` construction + function invocation shapes (D3) — ships in PR **2-i**

- [x] **RED**: `test/unit/callDriver.test.ts` — add cases:
      - function target: driver embeds `_t(**_ARGS)` call shape.
      - class target: driver constructs an instance (`_t(**_ARGS)` where `_t` resolves to the
        class, invoking `__init__` implicitly through construction).
      - **security (adversarial, same alphabet/absence assertions as 1.3, now for the args
        payload specifically)**: for the spec's literal adversarial scenario value
        `"); import os; os.system('rm -rf /')"` and additional adversarial values (`"'''"`,
        newline-breakout attempts, NUL, non-ASCII), the args-literal segment matches
        `/^[A-Za-z0-9+/=]*$/` and no raw substring of the adversarial value appears in the
        driver text.
      Satisfies: `snippet-function-invocation` spec Requirement "Pass argument values only as a
      JSON payload, never interpolated into source" (scenario "An adversarial value must not
      execute as code"); Requirement "Construct a class instance via `__init__` for a class
      target" (scenario "Calling a class target constructs an instance").
- [x] **GREEN**: `src/execution/callDriver.ts` — `buildCallDriver(content, dottedName,
      callableKind, argsJson)`.

### 2.2 — `runCall()` wrapper + `<<ACM>>` result frame handling for calls — ships in PR **2-i**

- [x] **RED**: `test/unit/dockerRunner.test.ts` — add cases:
      - `runCall()` delegates to the same hardened argv builder (no new spawn path).
      - non-`.py` target rejected pre-spawn (same assertion pattern as 1.4, for the call path).
      - successful call: `<<ACM>>` frame with `{ok: true, repr}` parsed into a call result;
        interleaved `runEvent` stdout lines before/after the frame are preserved and not
        swallowed.
      - failing call: target raises inside the driver → non-`<<ACM>>`-framed stderr/exception
        output surfaces as a failure result with captured error output (same shape as a run
        failure).
      Satisfies: `snippet-function-invocation` spec Requirement "Reuse the existing confirm → run
      → stream → cleanup pipeline" (both scenarios); `sandboxed-snippet-execution` spec scenario
      "Invocation run is cleaned up like an ordinary run".
- [x] **GREEN**: `src/execution/dockerRunner.ts` — `runCall()` wrapper.

### 2.3 — Protocol branches: `requestCall` / `callConfirmationRequired` / `confirmCall` /
      `callResult` — ships in PR **2-i**

- [x] **RED**: `test/unit/webviewProtocol.test.ts` — round-trip + rejection for
      `requestCall{requestId,sourceId,targetId,args}` (assert `args` is a `z.record(z.string()
      .max(256), z.unknown())` bound — an overlong key is rejected), `callConfirmationRequired
      {requestId,dottedName,argsPreview}`, `confirmCall{requestId,confirmed}`,
      `callResult{requestId,result,returnRepr?}`.
      Satisfies: `snippet-function-invocation` spec wire contract for confirm-before-invoke and
      result reporting (Requirements "Require an explicit confirm step..." and "Reuse the
      existing confirm → run → stream → cleanup pipeline").
- [x] **GREEN**: `src/webviewProtocol.ts` — add the four variants/branches.

### 2.4 — Host: `handleRequestCall`, `callConfirmationRequired`/`confirmCall`, `executeCall` — ships in PR **2-i**

- [x] **RED**: `test/unit/webviewHost.test.ts` — add cases:
      - a `requestCall` triggers `callConfirmationRequired` and does **not** spawn a container
        yet, mirroring `pendingRunConfirmations` (D5) — assert it is tracked independently of any
        `confirmRun` state.
      - `confirmCall{confirmed: false}` → no container spawned, no code executed.
      - `confirmCall{confirmed: true}` → `buildCallDriver` invoked with the decoded args and
        `executeCall` spawns via `runCall`, streaming `runEvent`s and finally posting
        `callResult`.
      - class target call constructs an instance via the `__init__` driver path (asserts the
        `callableKind: "class"` branch is exercised end-to-end through the host).
      Satisfies: `snippet-function-invocation` spec Requirement "Require an explicit confirm step
      before invoking, independent of introspection" (both scenarios); Requirement "Construct a
      class instance via `__init__` for a class target"; Requirement "Reuse the existing confirm
      → run → stream → cleanup pipeline" (both scenarios).
- [x] **GREEN**: `src/webviewHost.ts` — `handleRequestCall`, `callConfirmationRequired`
      /`confirmCall` tracking, `executeCall`.

### 2.5 — Call box UI + result area (webview) — ships in PR **2-ii**

- [x] **RED**: `test/unit/webviewDom.test.ts` — add cases:
      - "Call function" box renders a confirm step before any `requestCall` triggers a spawn
        (UI-level assertion that the confirm screen shows the exact args JSON preview, per D5's
        rationale that the run-preview format cannot express it).
      - declining the confirmation performs no invocation (no `confirmCall{confirmed:true}` sent).
      - successful/failing `callResult` renders success/failure with output, mirroring existing
        run-result rendering.
      Satisfies: `snippet-function-invocation` spec Requirement "Require an explicit confirm step
      before invoking, independent of introspection" (scenario "Confirm before invocation",
      "Declining the call confirmation performs no invocation").
- [x] **GREEN**: `webview/index.ts` — call box + result area; `webview/styles.css` — call-box
      styles.

**Slice 2 exit criteria**: selecting a function/class, filling the form, confirming, and calling
works end-to-end through the real sandbox pipeline with streamed output and success/failure
reporting; adversarial-injection tests pass for the call path.

---

## Slice 3a-i — Theme resolver core (extension/file resolution, include chain, JSONC)

Depends on: nothing from slices 1–2 (independently shippable and revertable per design). Unblocks
Slice 3a-ii (color extraction consumes this slice's resolved-and-merged theme document). Task-id
range: **3a-i.1–3a-i.4** (was 3a.1–3a.4).

**Split rationale**: this seam is clean, not forced. 3a-i produces one artifact — a single merged,
JSONC-clean theme document located and assembled from disk (contributor lookup → `include` chain
merge → comment/trailing-comma strip) — with no knowledge of *how* colors are extracted from it.
3a-ii consumes that merged document and is purely about extracting/prioritizing colors from
already-valid JSON, plus the never-throw degrade contract and host wiring. The two halves have
almost no shared vocabulary (file/tree resolution vs. color/precedence logic) and 3a-ii's tests can
be written entirely against small merged-document fixtures without re-deriving the `include` chain
machinery, so there is no awkward coupling introduced by splitting here.

### 3a-i.1 — Fixture set for theme resolution tests

- [x] Add committed fixtures under a test fixtures directory mirroring real theme shapes:
      a `dark_modern.json`-style file with `"include": "./dark_plus.json"` and no
      `tokenColors`/`semanticTokenColors`; a `dark_plus.json`-style file with `tokenColors` and a
      `semanticTokenColors` limited to `newOperator`/`stringLiteral`/`customLiteral`/
      `numberLiteral`; a `dark_vs.json`-style base file; a built-in-style `package.json` with an
      NLS-placeholder `label` (`"%darkPlusColorThemeLabel%"`) and a real `id`; a JSONC-styled
      theme file with `//` comments and trailing commas, including comment-like sequences
      **inside string literals** (e.g. a scope value containing `"//not-a-comment"` or a color
      string containing `/*`) to prove the stripper is string/escape-aware; a theme file whose
      `tokenColors` value is a plist **path string** instead of an array; an `include` cycle
      fixture (A includes B includes A); an `include` chain fixture deeper than depth cap 5.
      No RED/GREEN split — this is fixture data, not behavior; tests in 3a-i.2–3a-i.4 and
      3a-ii.1 depend on it.

### 3a-i.2 — `id`-not-`label` theme contributor matching

- [x] **RED**: `test/unit/themeResolver.test.ts` (new) — given the NLS-placeholder-label fixture,
      resolving by the configured theme `id` finds the contributor; matching by `label` alone
      would fail (assert the resolver does not depend on `label` resolution).
      Satisfies: `snippet-semantic-highlighting` spec Requirement "Color draft text using
      AST-derived identifier roles and the active theme" (theme-sourced color values must be
      resolvable to actually apply; design D8 correction).
- [x] **GREEN**: `src/theme/themeResolver.ts` (new) — contributor lookup via `id ?? label`.

### 3a-i.3 — `include` chain resolution: mandatory recursive merge, cycle + depth guards

- [x] **RED**: `test/unit/themeResolver.test.ts` — cases:
      - `dark_modern → dark_plus → dark_vs` chain resolves and merges child-wins (a key present
        in both child and ancestor takes the child's value).
      - a fixture with no `tokenColors`/`semanticTokenColors` at its own level still yields
        colors sourced from its `include` ancestor.
      - `include` cycle (A→B→A) does not infinite-loop; resolution degrades to the default
        palette instead of hanging or throwing.
      - `include` chain deeper than depth cap 5 stops at the cap and degrades gracefully.
      - each `include` path is resolved relative to the *including file's* directory, not the
        resolver's working directory (fixture with nested subdirectories).
      Satisfies: `snippet-semantic-highlighting` spec Requirement "Color draft text using
      AST-derived identifier roles and the active theme" and scenario "Unresolvable identifier
      role falls back gracefully" (theme-resolution failure modes feed the same fallback path);
      design D8 mandatory-`include` correction.
- [x] **GREEN**: `src/theme/themeResolver.ts` — recursive `include` resolver with visited-set +
      depth cap 5, child-wins merge.

### 3a-i.4 — JSONC tolerant strip (comments + trailing commas, string/escape-aware)

- [x] **RED**: `test/unit/themeResolver.test.ts` — cases:
      - ordinary `//` line comments and `/* */` block comments outside strings are stripped.
      - trailing commas in objects/arrays are stripped.
      - **adversarial (string/escape-aware)**: a JSON string value containing the literal
        characters `//` or `/*` is preserved verbatim, not treated as a comment; an escaped quote
        inside a string (`"a\"//b"`) does not terminate the string early and does not trigger
        false comment-stripping; a string containing a literal trailing-comma-like substring
        (`"a,}"`) is preserved untouched.
      - if the stripped result is still invalid JSON, resolution degrades to the default palette
        rather than throwing.
      Satisfies: `snippet-semantic-highlighting` spec (same requirement as 3a.3 — malformed
      theme JSON is a named degrade-path input) and design's explicit adversarial testing
      instruction for the JSONC stripper.
- [x] **GREEN**: `src/theme/themeResolver.ts` — JSONC strip helper.

**Slice 3a-i exit criteria**: given a configured theme name, the resolver locates the contributing
extension by `id`, resolves and merges its full `include` chain (cycle/depth-guarded), and yields a
single valid, comment-free JSON document — fully covered by fixtures, with no color-extraction
logic yet (Slice 3a-ii).

---

## Slice 3a-ii — Theme color extraction, precedence, degrade path, host wiring

Depends on: Slice 3a-i (consumes its merged theme document). Task-id range: **3a-ii.1–3a-ii.2**
(was 3a.5–3a.6).

**PR split (review-budget guard, applied after implementation measured ~553 changed lines against
the 400-line budget)**: task 3a-ii.1 ships as **3a-ii-a** (pure color-extraction/precedence/
degrade logic — 378 lines), task 3a-ii.2 ships as **3a-ii-b** (host wiring that consumes it — 175
lines). Unlike 3a-i, this seam splits cleanly with BOTH halves under budget, so no `size:exception`
was needed — same pattern as 1b-i/1b-ii.

### 3a-ii.1 — Role→color mapping, override precedence, and `tokenColors`-as-plist-path fallback — ships in PR **3a-ii-a**

- [x] **RED**: `test/unit/themeResolver.test.ts` — cases:
      - `semanticTokenColorCustomizations` (user override) wins over `workbench.
        colorCustomizations.textMateRules` wins over theme `semanticTokenColors` wins over theme
        `tokenColors` fallback scope map wins over the kind-based default palette — assert the
        full precedence chain with a fixture where each layer defines a conflicting color for the
        same role, and only the highest-precedence one is emitted.
      - the `tokenColors`-fallback-is-primary case: the `dark_plus`-style fixture (whose
        `semanticTokenColors` only covers `newOperator`/`stringLiteral`/`customLiteral`/
        `numberLiteral`) resolves `parameter`/`class`/`function` roles via the `tokenColors`
        scope map, not via `semanticTokenColors`.
      - longest-prefix, last-matching-rule-wins scope matching for `tokenColors`.
      - a theme whose `tokenColors` value is a plist path string (not an array) degrades that
        theme's contribution to the default palette instead of throwing or attempting plist
        parsing.
      - **never-throw invariant**: every failure mode covered by 3a-i.2–3a-i.4 and 3a-ii.1
        (missing theme, missing extension, malformed JSON post-strip, cycle, depth overflow,
        plist-path `tokenColors`) returns the default palette for the affected roles rather than
        throwing or rejecting.
      Satisfies: `snippet-semantic-highlighting` spec scenario "Unresolvable identifier role
      falls back gracefully"; design D8 degradation contract ("total and silent-to-the-user-but-
      logged").
- [x] **GREEN**: `src/theme/themeResolver.ts` — scope→role mapping, override layering, default
      palette fallback.

### 3a-ii.2 — Host wiring: resolve on activation, re-resolve on theme/config change, post
      (unconsumed) — ships in PR **3a-ii-b**

- [x] **RED**: `test/unit/webviewHost.test.ts` — add cases:
      - on panel creation, `themeResolver` is invoked and a `themeTokens` message is posted.
      - `onDidChangeActiveColorTheme` triggers a re-resolve and a new `themeTokens` post.
      - `onDidChangeConfiguration` for each of the four watched keys (`workbench.colorTheme`,
        `window.autoDetectColorScheme`, `workbench.preferredDarkColorTheme`, `workbench.
        preferredLightColorTheme`) triggers a re-resolve.
      - resolver failure (injected seam throws or returns a degrade result) still results in a
        `themeTokens` post with the default palette — panel rendering is never blocked.
      Satisfies: `snippet-semantic-highlighting` spec scenario "Theme change updates rendered
      colors" (wiring half; rendering consumption is 3b).

      Note: the RED cases for `onDidChangeActiveColorTheme`/`onDidChangeConfiguration` and the
      four watched keys are exercised through the vscode-free `subscribeThemeChange` seam (one
      generic re-resolve trigger, mirroring the existing `onAutoRefreshConfigChange` convention);
      the real `vscode` event filtering for the four keys lives in `src/extension.ts` and is
      wired but not covered by a dedicated unit test in this slice (no `vscode` mock harness
      exists for `extension.ts` yet).
- [x] **GREEN**: `src/webviewHost.ts` — theme forwarding on activation + the two watched-event
      listeners; `src/webviewProtocol.ts` — `themeTokens` branch (RED for this branch belongs in
      `webviewProtocol.test.ts`, round-trip only, alongside the above); `src/extension.ts` —
      real `vscode` wiring (`resolveActiveThemeTokens`, `onDidChangeActiveColorTheme`/
      `onDidChangeConfiguration` subscriptions for the four watched keys).

**Slice 3a-ii exit criteria**: `themeResolver.ts` fully covered by fixture tests including all
adversarial/degrade paths; host posts `themeTokens` on activation and on both change events; no
rendering consumes it yet (webview ignores the message or no-ops on it).

---

## Slice 3b — Semantic highlighting rendering

Depends on: Slice 3a-ii (`themeTokens` message + resolver shipped). Also depends on analyzer AST
work being independent of slices 1/2 target-identity changes (identifier-role emission is
additive to the same AST walk). Task-id range: **3b.1–3b.3** (unchanged).

### 3b.1 — Analyzer emits `identifierRoles` spans

- [x] **RED**: `test/unit/pythonAnalyzer.test.ts` — add cases: a snippet with `self` inside a
      method, a parameter reference, a class name reference, an imported name reference, and a
      builtin call each produce an `identifierRoles` span with correct byte offsets and role tag;
      an identifier with no determinable role (e.g. a local variable with no special role) is
      simply absent from `identifierRoles`, not emitted with a null/error role.
      Satisfies: `snippet-semantic-highlighting` spec Requirement "Color draft text using
      AST-derived identifier roles and the active theme" (scenario "Draft renders with
      role-colored identifiers") and scenario "Unresolvable identifier role falls back
      gracefully" (analyzer half: simply omit, don't emit garbage).
- [x] **GREEN**: `python/analyzer.py` — AST walk emitting `identifierRoles: {start, end, role}[]`
      for `self`, parameter, class name, imported name, builtin roles (D9 — tested only through
      the existing TS bridge, no new pytest suite).

### 3b.2 — `webview/highlight.ts` lexer (string/comment/keyword/number spans)

- [x] **RED**: `test/unit/highlight.test.ts` (new — the DOM suite is a poor seam for pure-function
      lexer/merge testing; `highlight.ts` exports pure functions directly, mirroring
      `themeResolver.ts`'s own dedicated test file) — cases:
      - string, comment, keyword, and number literal spans are correctly identified and
        non-overlapping.
      - the lexer output plus the analyzer's `identifierRoles` spans can be composed into a
        single non-overlapping span list (role spans take priority over generic keyword/name
        spans at the same offset, since design D7 treats AST roles as an overlay on top of the
        minimal lexer); a partially-overlapping lexer span is clipped, not dropped.
      - rendered HTML's `textContent` equals the original text exactly, including when no role
        applies (plain escaped text, no `<span>`).
      Satisfies: `snippet-semantic-highlighting` spec Requirement "Color draft text using
      AST-derived identifier roles and the active theme" (approximate lexer + AST overlay, per
      design D6/D7).
- [x] **GREEN**: `webview/highlight.ts` (new) — minimal lexer + role overlay → span HTML.

### 3b.3 — Overlay DOM: transparent `<textarea>` over synchronized `<pre>`, theme token classes

- [x] **RED**: `test/unit/webviewDom.test.ts` — cases:
      - after rendering, the overlay `<pre>` text content equals the `<textarea>` text content
        (byte-for-byte) — the core D6 synchronization invariant.
      - editing the textarea (simulated input event) re-renders the overlay and the equality
        invariant still holds after the edit.
      - `themeTokens` message received → CSS custom properties/token classes update to the new
        theme's colors without requiring the node to be reselected (this is the DOM half of the
        "Theme change updates rendered colors" scenario; 3a-ii.2 covers the host-side
        re-resolve/re-post half).
      - an identifier with no role renders as plain unstyled text within the same overlay,
        without breaking layout alignment with the textarea underneath.
      Satisfies: `snippet-semantic-highlighting` spec Requirement "Color draft text using
      AST-derived identifier roles and the active theme" (scenario "Draft renders with
      role-colored identifiers", "Theme change updates rendered colors", "Unresolvable identifier
      role falls back gracefully" — DOM half of each).
- [x] **GREEN**: `webview/index.ts` — overlay renderer wiring `highlight.ts` output +
      `themeTokens` handling; `webview/styles.css` — token classes bound to CSS vars, overlay/
      textarea alignment rules.

**Slice 3b exit criteria**: draft view renders theme-colored, role-aware Python; live theme
changes update colors without reselection; DOM tests prove overlay/textarea text equality is
maintained across edits.

---

## Review Workload Forecast (post-split, final)

Original slices 1 and 3a were each flagged as exceeding the 400-line budget. Per the user's
delivery decision, both are split below into six total review-sized PRs. Line estimates are
re-partitioned from the original slice totals (slice 1: ~480–560; slice 3a: ~420–500) along the
task-id seams defined above; totals are unchanged, only the partitioning is new.

| PR (slice) | New/modified files (approx.) | Estimated changed lines (impl + tests) | 400-line budget risk |
|---|---|---|---|
| 1a | `protocol.ts`, `analyzer.py`, `callDriver.ts` (new), `dockerRunner.ts` + 4 test files (`protocol`, `pythonAnalyzer`, `callDriver` new, `dockerRunner`) | ~270–330 | **Medium** (largest of the six, includes the security-invariant adversarial test suite, but under budget) |
| 1b | `webviewHost.ts` (cache), `webviewProtocol.ts` (3 branches), `webview/index.ts` (form), `webview/styles.css` + 3 test files (`webviewHost`, `webviewProtocol`, `webviewDom`) | ~200–250 | **Low** |
| 2 | `callDriver.ts`, `dockerRunner.ts`, `webviewProtocol.ts`, `webviewHost.ts`, `webview/index.ts`, `webview/styles.css` + 5 test files (`callDriver`, `dockerRunner`, `webviewProtocol`, `webviewHost`, `webviewDom`) | ~320–380 | **Medium** (borderline, kept as one PR per user decision — re-estimate diff size once 1a/1b land; revisit only if actual diff exceeds budget) |
| 3a-i | `themeResolver.ts` (new — contributor lookup, `include` merge, JSONC strip only), fixtures (7+ files) + `themeResolver.test.ts` (new — matching, chain/cycle/depth, JSONC adversarial cases) | ~240–280 | **Low–Medium** |
| 3a-ii | `themeResolver.ts` (color extraction/precedence/degrade), `webviewHost.ts`, `webviewProtocol.ts` (`themeTokens` branch) + `themeResolver.test.ts` additions (precedence matrix, plist-path fallback, never-throw invariant), `webviewHost.test.ts` additions | ~180–220 | **Low** |
| 3b | `analyzer.py`, `highlight.ts` (new), `webview/index.ts`, `webview/styles.css` + `pythonAnalyzer.test.ts`, `highlight`/`webviewDom` test additions | ~260–320 | **Low–Medium** |
| **Total** | 10 files touched/created across TS + Python, 4 new files, 6 PRs | **~1470–1780** | — |

**Split rationale recap**:

- **Slice 1 → 1a/1b**: seam is protocol/analyzer/driver-synthesis/sandbox-wrapper (1a, pure logic
  + security invariants, no UI) vs. host cache + wire branches + webview form rendering (1b,
  consumes 1a's shipped `target`/`callDriver`/`runIntrospection`). Clean split — 1b has zero
  reason to touch `callDriver.ts` or the driver-synthesis tests.
- **Slice 3a → 3a-i/3a-ii**: seam is file/tree resolution (3a-i: find the theme, merge `include`
  chain, produce clean JSON) vs. color extraction from that already-valid document (3a-ii:
  scope/role mapping, precedence, degrade, host wiring). Confirmed clean per the reasoning in the
  Slice 3a-i section header — no shared vocabulary, 3a-ii tests only need small merged-document
  fixtures.
- **Slice 2**: kept as one PR (~320–380 lines) per explicit user instruction; flagged Medium
  rather than High since it stays under 400 on current estimates. If the real diff exceeds budget
  once 1a/1b land, split along `buildCallDriver`+`runCall`+protocol-branches (call-path plumbing)
  vs. host `handleRequestCall`/`executeCall`+call-box UI (consumer), mirroring the 1a/1b seam —
  but this is not being pre-decided now.
- **Slice 3b**: kept as one PR (final slice) — no "wired but unused" seam exists between analyzer
  role emission and the webview overlay that renders it, so splitting would ship a non-functional
  half. **Correction (post-verify)**: this forecast line was written before implementation and
  said "already under budget" — actual PR #39 measured 496 changed lines (over the 400-line
  budget) and was correctly accepted as `size:exception` at commit/PR-body level; this pre-
  implementation forecast just was never reconciled with that outcome. See "Update 4" below.

---

## Delivery Plan (stacked-to-main)

`delivery_strategy=auto-chain`, `chain_strategy=stacked-to-main`: seven PRs, each based on the
previous PR's branch (first PR bases on `main`). Merge/land in this exact order; `sdd-apply`
should create branches and PRs mechanically from this table.

**Update 1**: slice 1b was split into **1b-i**/**1b-ii** after implementation measured ~519 changed
lines against the 400-line review budget (protocol+host-cache vs. form-rendering — the same
"wired but unused until the next PR" seam already used for 3a-i/3a-ii).

**Update 2**: slice 2 was split into **2-i**/**2-ii** after implementation measured ~642 changed
lines (call-path plumbing vs. call-box UI). 2-i (~424 lines) was accepted as `size:exception` —
6% over budget on one tightly-coupled plumbing chain (driver, runner, protocol, host) rather than
splitting further.

**Update 3**: slice 3a-i (~535 lines) was accepted as `size:exception` in a single PR — new
isolated module, no clean split available (include-chain resolution needs JSONC-stripping
already applied). Slice 3a-ii was split into **3a-ii-a**/**3a-ii-b** after implementation
measured ~605 changed lines. **Correction (post-verify)**: this section originally claimed
3a-ii-a landed at 378 lines with "BOTH halves under budget, no exception needed" — `gh pr view 37`
shows the actual PR diff is 430 changed lines (+416/-14), over the 400-line budget. The 378
figure was the production+test-only count from `git diff --stat` on specific files, which
undercounted relative to the PR's full diff (it also includes doc/task-list lines the local
measurement excluded). **PR #37 (3a-ii-a) should be treated as an undisclosed `size:exception`**
— accepted after the fact: the seam (color-precedence logic vs. host wiring) is still the correct
one, and the overage is concentrated in fixture/test additions for the precedence-chain matrix,
not runaway production code. 3a-ii-b (#38, 175 lines) remains genuinely under budget.

**Update 4**: slice 3b (final slice, PR #39) measured 496 changed lines per `gh pr view 39`
(+483/-13) — over the 400-line budget. This matches the `size:exception` rationale actually
documented in the PR #39 body/commit message at apply time (no clean split seam exists between
analyzer role emission and webview rendering); the pre-implementation forecast note above this
table was simply never updated to reflect that outcome.

This replaces the single `3a-ii` row below and renumbers the rest of the stack.

| Order | PR branch | Base branch | Task-id range | Slice |
|---|---|---|---|---|
| 1 | `feat/extended-snippet-draft-1a-introspection-core` | `feat/extended-instance-resolution-self-attr` (see note below) | 1a.1–1a.4 | 1a |
| 2 | `feat/extended-snippet-draft-1b-i-protocol-and-cache` | `feat/extended-snippet-draft-1a-introspection-core` | 1b.1–1b.2 | 1b-i |
| 3 | `feat/extended-snippet-draft-1b-ii-parameter-form` | `feat/extended-snippet-draft-1b-i-protocol-and-cache` | 1b.3 | 1b-ii |
| 4 | `feat/extended-snippet-draft-2-i-call-plumbing` | `feat/extended-snippet-draft-1b-ii-parameter-form` | 2.1–2.4 | 2-i |
| 5 | `feat/extended-snippet-draft-2-ii-call-box-ui` | `feat/extended-snippet-draft-2-i-call-plumbing` | 2.5 | 2-ii |
| 6 | `feat/extended-snippet-draft-3a-i-theme-resolver-core` | `feat/extended-snippet-draft-2-ii-call-box-ui` | 3a-i.1–3a-i.4 | 3a-i |
| 7 | `feat/extended-snippet-draft-3a-ii-a-color-precedence` | `feat/extended-snippet-draft-3a-i-theme-resolver-core` | 3a-ii.1 | 3a-ii-a |
| 8 | `feat/extended-snippet-draft-3a-ii-b-theme-host-wiring` | `feat/extended-snippet-draft-3a-ii-a-color-precedence` | 3a-ii.2 | 3a-ii-b |
| 9 | `feat/extended-snippet-draft-3b-semantic-highlighting` | `feat/extended-snippet-draft-3a-ii-b-theme-host-wiring` | 3b.1–3b.3 | 3b |

**Note on PR #31's base branch (post-verify correction)**: this table originally listed PR #31's
base as `main`. The actual base (confirmed via `gh pr view 31`) is
`feat/extended-instance-resolution-self-attr` — the tip of a prior, unrelated, still-open change
(PRs #28-30) at the time this change's implementation began. This was a real sequencing decision
made at apply time (branching from the actual current state of the codebase rather than a stale
local `main`), not a documentation error about intent, but the "base: main" claim in this table
was factually wrong and should be read as: **this entire 9-PR stack has an external merge
dependency on the `extended-instance-resolution` chain (#28-30) merging to `main` first.**

Notes:

- Slice 2-i is stacked after 1b-ii (not directly after 1a) even though it only needs 1a's shipped
  symbols, because 1b-i/1b-ii already merge to main first in this strict linear stack —
  `stacked-to-main` here means one linear chain, not parallel branches off 1a. If parallel review
  is desired later, that requires reopening the chain-strategy decision; not assumed here.
- Revert order mirrors the reverse of this table: 3b → 3a-ii → 3a-i → 2-ii → 2-i → 1b-ii → 1b-i →
  1a. Each revert is clean because protocol branches are additive and no slice references a later
  slice's symbols (per design's Migration/Rollout section).
- Each PR's diff should be reviewed against the merged tree of its base branch, not against
  `main`, consistent with a stacked-PR workflow.
