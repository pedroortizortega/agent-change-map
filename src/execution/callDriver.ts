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

export type CallableKind = "function" | "class";

function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** JSON-encodes a value known to be a safe Python-identifier-shaped string (e.g. a dotted name or callable kind literal) for embedding as a Python string literal. */
function pythonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/**
 * Builds a driver program that imports `content` as a synthetic module, resolves
 * `dottedName` within it, introspects its signature via `inspect.signature()` (or
 * `__init__`'s signature for a class target), and prints the parameter metadata framed
 * by the `<<ACM>>` sentinel so `runIntrospection()` can parse it out of ordinary stdout.
 */
export function buildIntrospectionDriver(content: string, dottedName: string, callableKind: CallableKind): string {
  const sourceLiteral = pythonStringLiteral(toBase64(content));
  const argsLiteral = pythonStringLiteral(toBase64("{}"));
  const dottedNameLiteral = pythonStringLiteral(dottedName);
  const callableKindLiteral = pythonStringLiteral(callableKind);

  return `import base64, json, inspect, types
_SRC = base64.b64decode(${sourceLiteral})
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
