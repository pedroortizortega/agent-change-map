# Design: Interactive Snippet Draft (introspection, call box, semantic highlighting)

## Technical Approach

Three additive slices over the existing bridge (`webview/index.ts` ↔ `src/webviewProtocol.ts` ↔ `src/webviewHost.ts` ↔ `src/execution/dockerRunner.ts` ↔ `python/analyzer.py`). No new sandbox primitive: both new Docker uses are *synthesized driver programs* fed to the existing `runSnippet()`, so `buildDockerRunArgs()` and `killAndVerifyContainer()` are untouched.

## Architecture Decisions

| # | Decision | Alternatives rejected | Rationale |
|---|---|---|---|
| D1 | Extend `entitySchema` with optional `target: { module, dottedName, callableKind: "function"\|"class" }` | Derive host-side from `qualifiedName`+`span.path` | Module/qualified split is analyzer knowledge (packages, `__init__.py`); optional field keeps existing golden fixtures valid. |
| D2 | Introspection and call reuse `runSnippet()` via thin `runIntrospection()` / `runCall()` wrappers in `dockerRunner.ts` (short 5s timeout, otherwise `DEFAULT_RUN_LIMITS`) | New docker invocation path | Sandbox flags stay single-sourced; only the `content` string differs. |
| D3 | Driver embeds module source **and** the args payload as two base64 string literals | stdin second channel; `docker … python3 - <argv>`; literal splicing | Stdin is already consumed by `python3 -u -` (the program itself). Base64's alphabet `[A-Za-z0-9+/=]` cannot terminate a Python string literal, so interpolation is *structurally* impossible and unit-assertable without Docker. argv would require editing the frozen hardened argv builder. |
| D4 | Introspection cache lives **host-side**: bounded LRU (32) keyed `` `${entityId}|${sha256(content)}` `` | Webview `getState()` | Webview state is lost on panel reload and would duplicate the trust boundary. Content hash in the key makes any draft edit a natural miss — no explicit invalidation logic. |
| D5 | Call gets its own `callConfirmationRequired`/`confirmCall`, mirroring `pendingRunConfirmations` | Reuse `confirmRun` | Proposal decision 6; preview must show the exact args JSON, which the run preview cannot express. |
| D6 | Highlighting = transparent-text `<textarea>` over a synchronized `<pre>` overlay | `contenteditable`; Monaco/CodeMirror; Shiki | Keeps the existing `#draft-content` textarea (undo, IME, a11y, `saveDraft` wiring, current DOM tests) intact. `contenteditable` requires manual caret restoration per keystroke. A bundled editor/highlighter violates the "no heavy dependency" posture (explore Approach A). |
| D7 | Tokenizing = minimal in-repo lexer (`webview/highlight.ts`) for string/comment/keyword/number spans, plus AST identifier roles overlaid by byte offset | Full Python lexer; TextMate grammar | "Approximate by contract" per proposal risk row; roles come from the analyzer, which already walks the AST. |
| D8 | **Resolve the active theme's JSON from disk** (see "Theme resolution" below), layer user customizations on top, and degrade to a kind-based default palette only when resolution fails | (i) kind-based default palette alone; (ii) reading colors from `activeColorTheme` | `vscode.window.activeColorTheme` exposes only `.kind` — token colors are *not* programmatically readable, so (ii) is impossible. (i) was the original decision but produces visibly wrong colors for every user not on a default theme. Disk resolution adds **no dependency** (`vscode.extensions`, `node:fs/promises`, `node:path` — `fs/promises` is already used in `src/git/gitService.ts` and `src/editing/writeGuard.ts`) and the parse/merge/override logic is pure and fixture-testable, which suits Strict TDD. Bounded and fallback-first, so worst case equals (i). |
| D9 | New analyzer AST logic is tested through the existing TS bridge (`test/unit/pythonAnalyzer.test.ts`) | Introduce `pytest` | That bridge is the only proven seam, spawns the real `python3 analyzer.py`, and asserts the wire contract that actually matters. A second runner would need new CI wiring for no additional coverage. Revisit only if pure-Python helpers grow untestable through the wire. |

## Data Flow

    change-map selection ──→ host.selectSource + selectedTarget (entity.target)
             │
    webview requestSignature{sourceId,targetId}
             ↓
    host: LRU lookup (entityId|sha256(content))
       hit ──────────────────────────────→ signatureResult
       miss ─→ buildIntrospectionDriver(content, dottedName, kind)
                 └→ runSnippet(driver) ─→ stdout JSON ─→ parse ─→ cache ─→ signatureResult
                                                    └ non-zero/parse fail ─→ signatureUnavailable{reason}

    form values ─→ requestCall{sourceId,targetId,args}
             ↓ callConfirmationRequired → confirmCall{confirmed}
       buildCallDriver(content, dottedName, kind, argsJson) → runSnippet → runEvent* → callResult

## Theme resolution (D8)

Lives in `src/theme/themeResolver.ts`. Impure I/O is confined to an injectable seam (`{ listExtensions, readFile }`); everything else is pure.

1. `themeName = workspace.getConfiguration("workbench").get<string>("colorTheme")`. When `window.autoDetectColorScheme` is on, read `workbench.preferredDarkColorTheme` / `preferredLightColorTheme` selected by `activeColorTheme.kind` instead.
2. Find the contributor: `extensions.all.find(e => e.packageJSON?.contributes?.themes?.some(t => (t.id ?? t.label) === themeName))`.
   **Correction to the proposed algorithm — matching on `t.label` alone does not work.** Verified in `/usr/lib/code/extensions/theme-defaults/package.json`: every built-in entry has `"label": "%darkPlusColorThemeLabel%"` — an unresolved NLS placeholder. `workbench.colorTheme` stores the **`id`** (`"Dark Modern"`). Match `id ?? label`; do not attempt to resolve `package.nls.json`.
3. Read `path.join(extension.extensionPath, theme.path)` and parse.
4. **Resolve `include` recursively, child-wins merge**, depth cap 5 + visited-path cycle guard, each `include` resolved relative to the *including file's* directory. This is mandatory, not an edge case: verified that `dark_modern.json` contains `"include": "./dark_plus.json"` and defines **no** `tokenColors` and **no** `semanticTokenColors` — the entire chain is `dark_modern → dark_plus → dark_vs`.
5. Extract `tokenColors` (TextMate rules) and `semanticTokenColors`.
6. Map our ~7 identifier roles to colors, in priority order: `editor.semanticTokenColorCustomizations` → `workbench.colorCustomizations.textMateRules` → theme `semanticTokenColors` → theme `tokenColors` via a hardcoded standard-token→scope fallback map (`parameter`→`variable.parameter`,`variable`; `class`→`entity.name.type.class`,`entity.name.type`,`support.class`; `function`→`entity.name.function`,`support.function`; etc.) → kind-based default palette.
   Step 6's `tokenColors` fallback is the **primary** path, not a rare one: `dark_plus.json`'s `semanticTokenColors` contains only `newOperator`, `stringLiteral`, `customLiteral`, `numberLiteral` — none of the roles this feature needs.
7. Scope matching is longest-prefix on dotted scopes, last-matching-rule-wins (VS Code's ordering). No selector-specificity engine for semantic modifiers/language suffixes (`variable.readonly:python`): exact-key lookup only, then fall through. This is the deliberate accuracy ceiling.

**Degradation is total and silent-to-the-user-but-logged**: any failure at any step (theme not found, extension disabled/uninstalled mid-session, missing file, malformed JSON, `include` cycle or depth overflow, `tokenColors` given as a `.tmTheme` plist *path string* rather than an array — some themes do this and plist parsing is explicitly out of scope) falls back to the kind-based palette for the affected roles. `themeTokens` is always posted; the resolver never throws and never blocks panel rendering. Re-resolve and re-post on `onDidChangeActiveColorTheme` and on `onDidChangeConfiguration` for the four watched keys.

**JSONC**: theme files are JSON-with-comments by contract. Built-ins are strict minified JSON, but third-party themes commonly ship `//` comments and trailing commas. Use a small in-repo tolerant pre-parse strip (comments + trailing commas, string/escape aware) rather than adding `jsonc-parser`; if the strip still yields invalid JSON, degrade per above.

## Interfaces / Contracts

```ts
// src/webviewProtocol.ts — new zod branches
{ type: "requestSignature", requestId, sourceId, targetId: requestId }
{ type: "requestCall", requestId, sourceId, targetId: requestId,
  args: z.record(z.string().max(256), z.unknown()) }        // JSON values, never source text
{ type: "confirmCall", requestId, confirmed: z.boolean() }

// HostToWebviewMessage additions
| { type: "signatureResult"; requestId; targetId: string; parameters: ParameterInfo[]; cached: boolean }
| { type: "signatureUnavailable"; requestId; targetId: string; reason: string }
| { type: "callConfirmationRequired"; requestId; dottedName: string; argsPreview: string }
| { type: "callResult"; requestId; result: RunResult; returnRepr?: string }
| { type: "themeTokens"; kind: "light" | "dark" | "highContrast"; colors: Record<TokenRole, string> }

interface ParameterInfo {
  name: string;
  kind: "positional" | "keyword" | "varargs" | "varkwargs";
  annotation?: string;        // str(inspect.Parameter.annotation)
  defaultRepr?: string;
  required: boolean;
}
```

**Widget mapping** (webview, pure function `widgetFor(annotation)`):

| Annotation | Widget | Encoded as |
|---|---|---|
| `int` / `float` | `<input type=number>` | JSON number |
| `bool` | `<input type=checkbox>` | JSON bool |
| `str` | `<input type=text>` | JSON string |
| `Optional[X]` | "provide value" toggle + inner widget of `X` | value or `null` |
| `list[…]`, `dict[…]`, unknown, missing, `*args`/`**kwargs` | `<textarea>` raw JSON | parsed with `JSON.parse` before send; parse error blocks the call |

**Driver shape** (identical for both modes; `buildIntrospectionDriver` / `buildCallDriver` in `src/execution/callDriver.ts`):

```python
import base64, json, inspect, types, sys
_SRC = base64.b64decode("<b64 module source>")
_ARGS = json.loads(base64.b64decode("<b64 args json>"))   # "{}" for introspection
_m = types.ModuleType("acm_target")
exec(compile(_SRC, "<acm-target>", "exec"), _m.__dict__)
_t = _m
for _p in "<dotted.name>".split("."): _t = getattr(_t, _p)
# introspect: json.dump of inspect.signature(_t.__init__ if inspect.isclass(_t) else _t)
# call:       _r = _t(**_ARGS)   # class → constructs an instance; function → invokes
print("<<ACM>>" + json.dumps({"ok": True, "repr": repr(_r)}))
```

A class target is uniform: `inspect.signature(cls.__init__)` minus `self` for the form, `cls(**args)` for the call. Structured results are framed with a `<<ACM>>` sentinel line so user prints stream normally as `runEvent`.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/protocol.ts` | Modify | Optional `target` on `entitySchema` (D1) |
| `python/analyzer.py` | Modify | Emit `target` per function/method/class; emit `identifierRoles` spans (slice 3) |
| `src/execution/callDriver.ts` | Create | Pure driver synthesis + base64 encoding; no I/O |
| `src/execution/dockerRunner.ts` | Modify | `runIntrospection()` / `runCall()` wrappers + `<<ACM>>` frame parsing |
| `src/webviewProtocol.ts` | Modify | New branches/variants above |
| `src/webviewHost.ts` | Modify | `handleRequestSignature`, `handleRequestCall`, `executeCall`, signature LRU, theme forwarding |
| `src/theme/themeResolver.ts` | Create | Theme JSON resolution, `include` merge, JSONC strip, scope→role mapping, override layering, palette fallback (D8) |
| `webview/highlight.ts` | Create | Lexer + role overlay → span HTML |
| `webview/index.ts` | Modify | Overlay renderer, parameter form, call box + result area |
| `webview/styles.css` | Modify | Token classes bound to CSS vars, overlay/textarea alignment, form styles |

## Testing Strategy (Strict TDD — RED first per item)

| Layer | Test file | What |
|---|---|---|
| Protocol | `test/unit/webviewProtocol.test.ts` | Round-trip + rejection for each new branch; `args` record bounds |
| Driver synthesis | `test/unit/callDriver.test.ts` (new) | **Security**: for adversarial arg values (`"'''"`, `"\n_t=__import__('os')"`, NUL, non-ASCII) assert the args literal matches `/^[A-Za-z0-9+/=]*$/` and no raw arg substring appears in the driver text; class vs. function shape |
| Runner | `test/unit/dockerRunner.test.ts` | `runIntrospection`/`runCall` delegate to the same argv; `<<ACM>>` frame parse, malformed frame → unavailable; non-`.py` target rejected pre-spawn |
| Host | `test/unit/webviewHost.test.ts` | Cache hit avoids a second `runSnippet`; edited content misses; LRU eviction at 32; call requires `confirmCall`, decline never spawns; Docker unavailable → `signatureUnavailable` |
| Analyzer | `test/unit/pythonAnalyzer.test.ts` | `target` fields for module/class/method/nested defs; identifier-role spans (D9) |
| Theme | `test/unit/themeResolver.test.ts` (new) | Against committed fixtures: `id`-not-`label` match incl. an NLS-placeholder label; `include` chain merge (dark_modern→dark_plus→dark_vs shape) with child-wins; cycle + depth-cap guards; JSONC comments/trailing commas; `tokenColors`-as-plist-path → fallback; override precedence order; every failure mode returns the default palette instead of throwing |
| Webview | `test/unit/webviewDom.test.ts` | `widgetFor` mapping table; raw-JSON fallback + parse error blocks call; disabled state without Docker; overlay text equals textarea text after edit |

## Threat Matrix

| Boundary | Applicability | Design response | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | **Applicable** — drivers reach `runSnippet` | Driver inherits the target's `path`; `assertEligibleForExecution` still runs first, so a non-`.py` target is refused before any spawn | `dockerRunner.test.ts`: `requirements.txt` / `README.sh` / executable `.md` targets reject pre-spawn |
| Argument→source injection (added row) | **Applicable** | D3 base64 envelope; args never spliced as text | `callDriver.test.ts` alphabet + absence assertions |
| Git repository selection | N/A — no git invocation in this change |  |  |
| Commit state | N/A — no index/worktree mutation |  |  |
| Push state / PR commands | N/A — no VCS automation |  |  |

## Migration / Rollout

No migration. All protocol additions are additive; `entitySchema.target` is optional, so an older analyzer response still validates. Three independently mergeable PRs in proposal order: **(1)** D1+D2+D3(introspection half)+D4+form rendering; **(2)** call driver, `confirmCall`, `callResult`, call box — depends only on slice 1's shipped `target` field; **(3)** highlighting — touches only `analyzer.py` role emission, `themeTokens`, `themeResolver.ts`, `highlight.ts`, CSS. No slice references a later slice's symbols. Revert 3 → 2 → 1.

D8 pushes slice 3 over the 400-line review budget, so split it: **3a** = `themeResolver.ts` + fixtures + tests, shipping behind the default palette with the resolver wired but its output unused; **3b** = `analyzer.py` roles, `highlight.ts`, overlay DOM/CSS, consuming 3a's `themeTokens`. 3a is independently revertable and independently valuable (it is pure logic with no UI surface).

## Open Questions

- [x] **Resolved — D8.** Investigated the disk-read alternative and **adopted** it. Feasibility confirmed: this is a Node extension host (`main` only, no `browser` target in `package.json`), `node:fs/promises` is already an established convention here, theme files are ordinary local extension assets needing no special permission, and no new dependency is required. Two concrete corrections to the proposed algorithm came out of verifying against `/usr/lib/code/extensions/theme-defaults`: match on **`id ?? label`** (built-in `label`s are unresolved NLS placeholders like `%darkPlusColorThemeLabel%`), and treat `include`-chain resolution as **mandatory** (`dark_modern.json` defines no token colors at all). The residual accuracy ceiling is semantic-selector specificity, which stays out of scope and is consistent with the proposal's "approximate by contract, no parity guarantee".
- [ ] Confirm the accuracy ceiling in step 7 is acceptable: semantic selectors with modifiers/language suffixes (`variable.readonly:python`) are matched by exact key only, so a theme styling those will fall through to its TextMate scope color rather than the semantic one.
