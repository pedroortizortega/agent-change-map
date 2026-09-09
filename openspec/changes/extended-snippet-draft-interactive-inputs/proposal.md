# Proposal: Interactive Snippet Draft (semantic highlighting, dynamic inputs, call-function box)

## Intent

The Snippet Draft panel is plain text and can only run a snippet as a top-level script. A user inspecting a function found by the change map cannot read it comfortably, cannot see what it expects, and cannot try calling it — they must leave the extension. This change makes the panel a place to read, parameterize, and invoke a specific function/class inside the existing hardened Docker sandbox.

## Scope

### In Scope

- Approximate-semantic Python highlighting in the draft editor/view: AST identifier roles (self, parameter, class name, imported name, builtin) mapped to the active theme's `semanticTokenColors`, on top of TextMate syntax coloring.
- Runtime signature introspection: import the module and run `inspect.signature()` inside the existing sandbox, returning parameter metadata as JSON.
- Dynamic per-parameter input form rendered from that metadata, with a raw-JSON fallback for unrepresentable parameters (`*args`, `**kwargs`, unknown types).
- New "Call function" box that invokes the selected target with the supplied values, reusing the confirm → run → stream → cleanup pipeline, and reports success/failure/output.
- Class support: for a class target, introspect `__init__` the same way as a function and construct an instance with the supplied values on call.
- Introspection result caching, keyed by (target identity, snippet content hash), so re-selecting the same unchanged target does not trigger another Docker round-trip.

### Out of Scope

- Interactive stdin during a call; the driver runs non-interactively.
- Persisting past call inputs across sessions (in-memory only for the active selection).
- Language support beyond Python; editing/refactoring from the panel; debugging or breakpoints.
- Installing third-party packages into the sandbox image; calls that need missing imports simply fail.
- Pixel-exact Pylance parity or a bundled language server.

## Capabilities

### New Capabilities

- `snippet-signature-introspection`: sandboxed runtime discovery of a target's parameters and rendering of a per-parameter input form.
- `snippet-function-invocation`: invoking a selected function/class with user-supplied values and reporting the outcome.
- `snippet-semantic-highlighting`: theme-driven, AST-informed Python coloring in the draft view.

### Modified Capabilities

- `sandboxed-snippet-execution`: adds two new sandbox uses — introspection round-trip and driver-wrapped call — under the same isolation, confirmation, timeout, and cleanup requirements.
- `python-structure-analysis`: entity DTO must carry enough target identity (module path + qualified name) to address a specific callable for introspection/invocation.

## Approach

Decisions locked with the user (not open questions):

1. **Highlighting = approximate-semantic.** Host reads `vscode.window.activeColorTheme` token colors and pushes them to the webview; the analyzer's AST supplies identifier roles; the webview renders colored spans instead of a bare `<textarea>`/`<pre>`.
2. **Introspection = runtime, in-sandbox.** Drawing the form costs one short Docker round-trip (spawn → import module → `inspect.signature()` → JSON out). Static-AST-only is rejected as insufficient for dynamic signatures.
3. **Import side effects accepted.** Existing containment (`--network none`, `--read-only`, non-privileged user, no bind mounts, pids/cpu/memory caps) is deemed sufficient; no extra mitigation in this change.
4. **Arguments are JSON-only.** Values travel as a JSON payload consumed by `json.loads()`/`ast.literal_eval` inside a synthesized driver script. String interpolation of user values into Python source is forbidden — hard security constraint.
5. **Target selection follows the change-map selection.** The panel introspects/calls whichever node (function/method/class) is already selected in the change map — no separate in-panel picker.
6. **Call has its own explicit confirm step.** Invoking a function/class with supplied values is treated like a Run: a confirmation screen precedes spawning the container, independent of any confirmation already given for introspection.
7. **Docker unavailable → form disabled.** No static-AST fallback form; the input/call box shows a clear "unavailable" state, consistent with how Run already degrades.
8. **Introspection is cached** per (target identity, snippet content hash); re-selecting the same unchanged target reuses the cached signature instead of re-spawning a container.
9. **Classes are in scope.** `__init__` is introspected like a function; calling constructs an instance with the supplied values.

### Sequencing (independently shippable)

1. Signature/introspection plumbing (protocol + host + analyzer/runner + form rendering).
2. Call-function box (driver synthesis, JSON coercion, result surface).
3. Semantic highlighting (purely visual, independent of 1–2).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/webviewProtocol.ts` | Modified | New zod branches `requestSignature`/`requestCall`; new host variants `signatureResult`/`callResult`/theme payload |
| `src/webviewHost.ts` | Modified | Handlers mirroring `handleRequestRun`/`executeRun`; theme color extraction |
| `webview/index.ts` | Modified | Highlighted draft view, dynamic parameter form, call box + result area |
| `webview/styles.css` | Modified | Theme-derived token CSS variables/classes, form and call-box styles |
| `src/execution/dockerRunner.ts` | Modified | Introspection mode and driver-wrapped call mode over existing `runSnippet()` |
| `python/analyzer.py`, `src/analysis/pythonAnalyzer.ts` | Modified | Target identity + identifier-role data on the wire |
| `test/unit/*.test.ts` | Modified | Tests-first per layer (protocol, host, DOM, runner, analyzer bridge) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| RCE via argument coercion | Med | JSON-only payload, `json.loads`/`ast.literal_eval` in driver; explicit negative tests for interpolation |
| Import side effects during introspection | High | Accepted by user; contained by existing sandbox flags |
| Message-protocol growth / drift | Med | Round-trip zod tests written first for every new branch |
| Strict TDD across TS + Python layers | Med | Confirm whether a Python-side test suite exists for `analyzer.py`; if not, decide the test layer before writing AST logic |
| Docker latency degrading form UX | Med | Cache introspection per target+content hash; show pending state; keep run timeout |
| Highlighting drift from real VS Code coloring | Low | Approximate by contract; no parity guarantee promised |

## Rollback Plan

Each slice is a separate commit/PR. Revert order 3 → 2 → 1; each revert restores the prior panel because no persisted state, migration, or on-disk format changes. Protocol branches are additive, so reverting the webview and host together leaves no orphan messages.

## Dependencies

- Docker available locally (already required by the existing run flow).
- `vscode.window.activeColorTheme` token color access from the host.

## Success Criteria

- [ ] Selecting a function renders a per-parameter form derived from real `inspect.signature()` output, with a raw-JSON fallback for unrepresentable parameters.
- [ ] Calling that function with supplied values runs in the sandbox and reports success/failure/output through the existing streaming pipeline.
- [ ] No user-supplied value is ever interpolated into Python source; a test asserts this.
- [ ] The draft view shows theme-colored Python with role-aware identifier coloring.
- [ ] Introspection and call failures surface as explicit, readable errors rather than silent no-ops.

## Proposal question round — resolved

All five open questions were answered by the user:

1. **Target selection**: from the change-map selection (no in-panel dropdown).
2. **Call confirmation**: yes, its own explicit confirm step, independent of introspection.
3. **Docker unavailable**: form is disabled, no static-AST fallback.
4. **Introspection caching**: yes, keyed by (target identity, snippet content hash).
5. **Class support**: in scope for this iteration — introspect `__init__`, call constructs an instance.
