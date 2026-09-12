/**
 * Pure synthesis of the Python "driver" programs fed to the existing sandboxed
 * `runSnippet()` for signature introspection (and, in a later slice, invocation).
 *
 * No I/O happens here - only string construction. The module source and the args JSON
 * payload are each embedded as base64 string literals decoded at driver runtime via
 * `base64.b64decode`. Base64's alphabet (`[A-Za-z0-9+/=]`) cannot terminate a Python
 * string literal, so no adversarial value - however it is shaped - can break out of the
 * literal and execute as code. This is the security invariant asserted by
 * `test/unit/callDriver.test.ts`.
 */

import type { BundledModule } from "../navigation/sourceProvider.js";

export type CallableKind = "function" | "class";

function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** JSON-encodes a value known to be a safe Python-identifier-shaped string (e.g. a dotted name or callable kind literal) for embedding as a Python string literal. */
function pythonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/**
 * Builds the optional `sys.meta_path` finder bootstrap that lets the driver's own
 * `import` machinery resolve same-repo local imports against `bundle`, per
 * design.md's "Driver bootstrap" section. Returns `""` for an empty bundle so both
 * builders remain byte-identical to their pre-bundle output when no bundle is supplied.
 *
 * The whole bundle is embedded as ONE base64-enveloped JSON literal (`_BUNDLE`), keyed by
 * dotted module name, for the same reason the target's own source is base64-enveloped:
 * base64's alphabet (`[A-Za-z0-9+/=]`) cannot terminate the Python string literal, so no
 * adversarial bundled file content can break out of the literal and execute as code. This
 * is the security invariant asserted by `test/unit/callDriver.test.ts`'s bundle-bootstrap
 * adversarial cases.
 *
 * Laziness is structural: nothing in `bundle` executes until a real `import` statement
 * inside the target (or a transitively-imported bundled module) triggers `exec_module`.
 */
function buildBundleBootstrap(bundle: readonly BundledModule[]): string {
  if (bundle.length === 0) return "";

  const payload: Record<string, { source: string; isPackage: boolean }> = {};
  for (const entry of bundle) {
    payload[entry.dottedName] = { source: entry.source, isPackage: entry.isPackage };
  }
  const bundleLiteral = pythonStringLiteral(toBase64(JSON.stringify(payload)));

  return `import sys
from importlib.abc import Loader as _AcmLoaderBase, MetaPathFinder as _AcmFinderBase
from importlib.machinery import ModuleSpec as _AcmSpec
_BUNDLE = json.loads(base64.b64decode(${bundleLiteral}))

class _AcmLoader(_AcmLoaderBase):
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        _e = _BUNDLE[module.__name__]
        exec(compile(_e["source"], "<acm-bundle:" + module.__name__ + ">", "exec"), module.__dict__)

class _AcmFinder(_AcmFinderBase):
    def find_spec(self, fullname, path=None, target=None):
        _e = _BUNDLE.get(fullname)
        if _e is None:
            return None
        _s = _AcmSpec(fullname, _AcmLoader(), is_package=_e["isPackage"])
        if _e["isPackage"]:
            _s.submodule_search_locations = []
        return _s

sys.meta_path.insert(0, _AcmFinder())
`;
}

/**
 * Builds a driver program that imports `content` as a synthetic module, resolves
 * `dottedName` within it, introspects its signature via `inspect.signature()` (or
 * `__init__`'s signature for a class target), and prints the parameter metadata framed
 * by the `<<ACM>>` sentinel so `runIntrospection()` can parse it out of ordinary stdout.
 */
export function buildIntrospectionDriver(content: string, dottedName: string, callableKind: CallableKind, bundle: readonly BundledModule[] = []): string {
  const sourceLiteral = pythonStringLiteral(toBase64(content));
  const argsLiteral = pythonStringLiteral(toBase64("{}"));
  const dottedNameLiteral = pythonStringLiteral(dottedName);
  const callableKindLiteral = pythonStringLiteral(callableKind);
  const bundleBootstrap = buildBundleBootstrap(bundle);

  return `import base64, json, inspect, types
${bundleBootstrap}_SRC = base64.b64decode(${sourceLiteral})
_ARGS = json.loads(base64.b64decode(${argsLiteral}))
_m = types.ModuleType("acm_target")
exec(compile(_SRC, "<acm-target>", "exec"), _m.__dict__)
_t = _m
for _p in ${dottedNameLiteral}.split("."):
    _t = getattr(_t, _p)
_callable_kind = ${callableKindLiteral}
_sig_target = _t.__init__ if _callable_kind == "class" else _t
_sig = inspect.signature(_sig_target)
_params = []
for _name, _param in _sig.parameters.items():
    if _callable_kind == "class" and _name == "self":
        continue
    _params.append({
        "name": _name,
        "kind": str(_param.kind),
        "annotation": None if _param.annotation is inspect.Parameter.empty else str(_param.annotation),
        "defaultRepr": None if _param.default is inspect.Parameter.empty else repr(_param.default),
        "required": _param.default is inspect.Parameter.empty,
    })
print("<<ACM>>" + json.dumps({"ok": True, "parameters": _params}))
`;
}

/**
 * Builds a driver program that imports `content` as a synthetic module, resolves
 * `dottedName` within it, and invokes it with the decoded `argsJson` payload:
 * `_t(**_ARGS)`. For a class target this is uniform - calling the class constructs an
 * instance via `__init__` implicitly, using the same `_t(**_ARGS)` shape as a function
 * call (design's "driver shape" section). The result (or the raised exception, left to
 * propagate and be captured as ordinary stderr/exit-code failure) is reported via the
 * `<<ACM>>` sentinel-framed line so `runCall()` can parse it out of stdout.
 */
export function buildCallDriver(content: string, dottedName: string, callableKind: CallableKind, argsJson: string, bundle: readonly BundledModule[] = []): string {
  const sourceLiteral = pythonStringLiteral(toBase64(content));
  const argsLiteral = pythonStringLiteral(toBase64(argsJson));
  const dottedNameLiteral = pythonStringLiteral(dottedName);
  const bundleBootstrap = buildBundleBootstrap(bundle);

  return `import base64, json, types
${bundleBootstrap}_SRC = base64.b64decode(${sourceLiteral})
_ARGS = json.loads(base64.b64decode(${argsLiteral}))
_m = types.ModuleType("acm_target")
exec(compile(_SRC, "<acm-target>", "exec"), _m.__dict__)
_t = _m
for _p in ${dottedNameLiteral}.split("."):
    _t = getattr(_t, _p)
_r = _t(**_ARGS)
print("<<ACM>>" + json.dumps({"ok": True, "repr": repr(_r)}))
`;
}
