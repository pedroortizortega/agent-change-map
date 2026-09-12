# Exploration: Interactive Snippet Draft (highlighting, dynamic inputs, call-function box)

## Request

Improve the Snippet Draft panel of the agent-change-map VS Code extension with three capabilities:

1. Python syntax highlighting for classes/functions/etc. matching VS Code's Python color theme (ms-python-style).
2. For each detected function/class/script, dynamically read and analyze its input types and render input fields so the user can supply values.
3. A new box in the Snippet Draft panel to invoke ("call") the function with those supplied inputs, running it in the existing Docker sandbox to verify the function can be called with those values.

## Current State

**Snippet Draft UI.** Not a standalone component — DOM built imperatively inside `initialize()` in `webview/index.ts:405-462`, driven by `src/webviewHost.ts` over the message-passing bridge in `src/webviewProtocol.ts`.

- `#draft-content` (`webview/index.ts:424`) is a plain `<textarea>` bound to the selected `SourceId` — no highlighting.
- `save-draft` → `{type:"saveDraft", sourceId, content}`; `write-snippet` → guarded direct-write flow with confirm/decline.
- "Run variants" `<fieldset>` (original/current/draft checkboxes) + `request-run`/`cancel-run` buttons.
- `#run-output` (`webview/index.ts:458`) is a plain `<pre>` fed via streamed `runEvent` messages — no styling.
- The diff panel (`renderDiffPanel`, `webview/index.ts:331-368`) uses `<code>` elements but only sets `textContent` — still plain text.

**Rendering.** 100% plain text. `webview/styles.css` has no highlighting classes/tokens. No bundled highlighter, no VS Code theme-color plumbing exists today.

**Analyzer / signature introspection (`python/analyzer.py`).**
- `FileVisitor._bind_signature()` (lines 95-104) records `(scope, parameterName, annotationName)` only for bare `ast.Name` annotations (e.g. `int`, `Foo`), stripping `self`/`cls`. Added for instance-call resolution (commits `81494c5`/`032c33b`) and is **never serialized** into the JSON response.
- The public DTO (`entitySchema`, `src/protocol.ts:37-43`) exposes only `{id, kind: package|module|class|function|method, qualifiedName, containerId?, span}` — **no signature/parameter field exists on the wire today.**
- Bridge: `analyzePython()` (`src/analysis/pythonAnalyzer.ts`) spawns `python3 python/analyzer.py`, one JSON line in via stdin, one JSON line out via stdout, zod-validated. Only a whole-batch `analyze` request type exists — no per-node/per-snippet request.

**"Run in Docker" flow** (`src/execution/dockerRunner.ts`, wired via `src/webviewHost.ts:418-465`):
1. Webview sends `requestRun {variants}`. Host builds `sources` from `activeSources` (`selectSource()`, `src/webviewHost.ts:406-416`): `original`/`current` from the committed snapshot, `draft` from `DraftStore`.
2. Host posts `runConfirmationRequired` with a preview; webview requires explicit confirm/decline (`confirmAction`, `webview/index.ts:463-481`).
3. On confirm, `runSnippet()` (`dockerRunner.ts:275-363`) spawns:
   `docker run --rm -i --network none --read-only --tmpfs /tmp:rw,... --cap-drop=ALL --security-opt=no-new-privileges --user 65534:65534 --pids-limit N --cpus X --memory Y python:3.12-slim python3 -u -`
   feeding the entire snippet via stdin only — no bind mount, ever. 10s default timeout, cooperative `AbortSignal` cancellation, forced `docker kill` verified via `killAndVerifyContainer`.
4. Streamed stdout/stderr as `runEvent` (capped 1MB/run); final `runResult` with `{kind: success|failure|timeout|cancelled|unavailable}` per variant.
5. **Gap**: today the runner executes the snippet body as a top-level script — there is no mechanism to call a specific function/class with arguments. A "call function" feature must synthesize a driver wrapper around the snippet content before handing it to the existing `runSnippet()`/`runVariants()`; the sandbox/timeout/isolation plumbing needs no change.

**Message-passing architecture** (`src/webviewProtocol.ts`): a strict zod-validated discriminated union `WebviewToHostMessage` (13 branches) and a plain discriminated union `HostToWebviewMessage` (14 variants). Every new action needs: a new zod branch, matching response variant(s), a `case` in the host switch (`src/webviewHost.ts`), and DOM wiring in `webview/index.ts`.

## Affected Areas

- `webview/index.ts` — new box (parameter form + "Call function" button + result area); a highlighting renderer replacing the plain `<textarea>`/`<pre>`.
- `webview/styles.css` — needs theme-derived CSS variables/classes if a tokenizer is adopted.
- `src/webviewProtocol.ts` — new message types (`requestSignature`/`signatureResult`, `requestCall`/confirmation/`callResult`), plus a payload carrying VS Code's active theme colors for highlighting.
- `src/webviewHost.ts` — new handlers analogous to `handleRequestRun`/`executeRun`.
- `src/analysis/pythonAnalyzer.ts` / `python/analyzer.py` — extend the batch `analyze` protocol to emit full signature metadata per `function`/`method`/class-`__init__` node.
- `src/execution/dockerRunner.ts` — "call with args" mode: a synthesized driver script as `content` for the existing `runSnippet()`. Argument coercion (form strings → typed Python literals) is new and security-sensitive.
- `test/unit/webviewDom.test.ts`, `webviewHost.test.ts`, `webviewProtocol.test.ts`, `dockerRunner.test.ts`, `pythonAnalyzer.test.ts` — existing per-layer TDD suites need parallel new coverage. No standalone Python pytest suite for `analyzer.py` was located — only TS-side `pythonAnalyzer.test.ts`.

## Approaches

### 1) Python syntax highlighting matching VS Code's Python theme

"ms-python's color code" isn't a literal reusable artifact — Pylance's semantic tokenizer is a separate language-server process; ms-python's syntax grammar is a bundled TextMate grammar. Practical path: read the user's active color theme host-side (`vscode.window.activeColorTheme` + its `tokenColors`/`semanticTokenColors`) and tokenize with a TextMate-compatible engine.

- **A — Shiki + bundled Python TextMate grammar + extracted VS Code theme JSON.** Pixel-accurate syntax coloring, same engine VS Code uses, mature library. Adds bundle-size dependency; true semantic (Pylance-level) accuracy needs an extra AST-driven approximate layer (param/self/class-name coloring mapped to `semanticTokenColors`) or accepting syntax-only fidelity. Effort: Medium (syntax-only) → High (semantic-accurate).
- **B — Hand-rolled tokenizer + CSS vars from the VS Code theme**, reusing analyzer AST data for identifier coloring. No new dependency, but reinventing a full Python lexer (f-strings, decorators, nested strings) is significant edge-case work and will diverge from VS Code's own tokenization. Effort: Medium-High.
- **C — Regex-based keyword coloring only.** Low effort, not "theme-accurate", breaks on nested strings/comments.

### 2) Dynamic input form from introspected parameter types

- **A — Extend the analyzer's AST visitor** to emit full static signatures (param name/kind, `ast.unparse(annotation)` text, statically-evaluable default reprs, return annotation) as new DTO fields, then map type-hint text → widget (`int`→number, `bool`→checkbox, `str`→text, `Optional[X]`→toggle, `list/dict[...]`→JSON textarea, unknown→raw JSON). Reuses proven-safe AST machinery, no code execution needed. Static-only — decorator-mangled/dataclass-generated signatures, `*args`/`**kwargs`-only functions aren't resolvable; needs an explicit fallback UI. Effort: Medium.
- **B — Runtime introspection inside the Docker sandbox** (`inspect.signature()` after importing the module in-container). Handles dynamically constructed signatures accurately, but forces module-level import (and its side effects) merely to draw a form, before the user has supplied any input — a materially different trust boundary than pure static analysis; adds Docker round-trip latency to something currently instant. Effort: Medium-High.
- **Lean**: A, with an explicit "type unknown — enter raw JSON" fallback rather than silent failure.

### 3) New "call function" UI box + Docker execution wiring

- **A — New DOM section**, posts `requestCall {sourceId, args: Record<string,string>}` with raw form strings; host coerces types and builds the driver script, then reuses `runSnippet` unchanged (confirmation, streaming, timeout, cleanup). Maximal reuse of the hardened sandbox and existing conventions; string→typed coercion is itself a validation surface needing explicit tested error paths.
- **B — Coerce inside the sandbox**: pass argument values as a JSON payload consumed via `json.loads()`/manual cast inside a small Python driver, never string-interpolated into source. Closer to real Python semantics, avoids reimplementing coercion rules in TS, structurally rules out code injection. Errors surface only after spawning a container; harder to unit-test the coercion path without Docker.
- **Lean**: combine A's host/UI wiring with B's coercion boundary — arguments always travel as a JSON payload consumed by `json.loads()` inside the driver, **never** spliced into Python source text as a literal.

## Recommendation

Sequence as independently shippable slices:
1. Extend `python/analyzer.py`/`entitySchema` with full static parameter metadata (item 2, Approach A) — smallest, safest, unblocks the form UI.
2. Add the "call function" box (item 3: A wiring + B coercion) reusing the existing confirm/run/stream/cleanup pipeline verbatim, with arguments passed strictly as JSON, never string-interpolated.
3. Add Python syntax highlighting (item 1, Approach A) last — purely visual and independent, but carries a "how faithful to Pylance" ambiguity that should be resolved with the user first (syntax-only vs. approximate-semantic).

## Risks

- **Code injection via argument coercion** if any implementation string-interpolates user-supplied values into Python source rather than passing them through `json.loads`/`ast.literal_eval` inside the sandbox — this would reopen exactly the RCE surface the current stdin-only, no-mount, no-network sandbox was built to close. Must be a hard design constraint.
- **Static type hints are frequently incomplete** (`*args`/`**kwargs`, undecorated dynamic signatures, dataclasses) — form generation needs an explicit raw-JSON fallback, not silent failure or guessing.
- **"Match ms-python's color code" is ambiguous** — needs an explicit product decision (syntax-only TextMate grammar vs. an approximate AST-driven semantic layer) before implementation.
- **Docker round-trip latency** if runtime-in-sandbox introspection (item 2, Approach B) is chosen — every function selection would spawn a container just to draw a form and reopens the import-side-effect question static analysis avoids.
- **Message-protocol growth** — every new capability needs new zod schema branches in `webviewToHostMessageSchema` and new `HostToWebviewMessage` variants, with round-trip tests in `test/unit/webviewProtocol.test.ts` written first under Strict TDD.
- **No dedicated Python test suite was located** for `python/analyzer.py` (only the TS-side `test/unit/pythonAnalyzer.test.ts`) — confirm the actual Python-side test setup before adding new AST extraction logic, since Strict TDD requires tests-first at whichever layer the logic lands.

## Ready for Proposal

Yes — architecture (message schema, Docker sandbox, AST analyzer bridge) is well understood with clear extension points for all three improvements. Open questions for the user before/during proposal:

1. Highlighting fidelity: syntax-only (Shiki + TextMate grammar + theme colors) vs. approximate-semantic (AST-driven, closer to Pylance)?
2. Signature introspection: static-AST-only (safe, may miss dynamic signatures) vs. runtime-in-sandbox (`inspect.signature()`, accurate but adds import side effects + Docker latency)?
