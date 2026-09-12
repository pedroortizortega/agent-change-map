#!/usr/bin/env python3
"""Static Python analyzer using only the standard-library AST."""

from __future__ import annotations

import ast
import builtins
import json
import sys
from dataclasses import dataclass
from typing import Any

BUILTIN_NAMES = frozenset(dir(builtins))


def entity_id(kind: str, qualified_name: str, start_byte: int | None = None) -> str:
    base = f"{kind}:{qualified_name}"
    return base if start_byte is None else f"{base}@{start_byte}"


def module_name(path: str) -> str:
    without_suffix = path[:-3] if path.endswith(".py") else path
    if without_suffix.endswith("/__init__"):
        without_suffix = without_suffix[: -len("/__init__")]
    return without_suffix.replace("/", ".")


@dataclass
class SourceFile:
    path: str
    content: str

    def __post_init__(self) -> None:
        self.lines = self.content.splitlines(keepends=True)
        self.line_byte_offsets: list[int] = []
        offset = 0
        for line in self.lines:
            self.line_byte_offsets.append(offset)
            offset += len(line.encode("utf-8"))

    def byte_offset(self, line: int, column: int) -> int:
        return self.line_byte_offsets[line - 1] + column

    def span(self, node: ast.AST) -> dict[str, Any]:
        start_line = getattr(node, "lineno", 1)
        start_column = getattr(node, "col_offset", 0)
        end_line = getattr(node, "end_lineno", start_line)
        end_column = getattr(node, "end_col_offset", start_column)
        return _span(self.path, self.byte_offset(start_line, start_column), self.byte_offset(end_line, end_column), start_line, start_column, end_line, end_column)


class FileVisitor(ast.NodeVisitor):
    def __init__(self, source: SourceFile, module: str, root_id: str, known_modules: set[str], is_package: bool) -> None:
        self.source = source
        self.module = module
        self.is_package = is_package
        self.known_modules = known_modules
        self.nodes: list[dict[str, Any]] = []
        self.edges: list[dict[str, Any]] = []
        self.calls: list[tuple[str, str, ast.Call]] = []
        self.from_imports: list[tuple[dict[str, Any], str]] = []
        self.import_aliases: list[tuple[str, str, str]] = []
        self.local_bindings: list[tuple[str, str, str]] = []
        self.attribute_bindings: list[tuple[str, str, str]] = []
        self.self_scopes: set[str] = set()
        self.stack: list[tuple[str, str, str]] = [(root_id, module, "module")]
        # Populated by `_prescan` before the main visit (design D9 / identifierRoles): every
        # class/function/imported name declared anywhere in this file, used to tag identifier
        # *usages* by role. Deliberately whole-file rather than lexically-scoped - an
        # approximation acceptable per the spec's "no determinable role -> simply absent"
        # fallback contract.
        self.class_names: set[str] = set()
        self.function_names: set[str] = set()
        self.imported_names: set[str] = set()

    def prescan(self, tree: ast.AST) -> None:
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                self.class_names.add(node.name)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.function_names.add(node.name)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    self.imported_names.add((alias.asname or alias.name).split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name != "*":
                        self.imported_names.add(alias.asname or alias.name)

    def _collect_identifier_roles(self, node: ast.AST, entity_start_byte: int, self_scope: bool, parameter_names: set[str]) -> list[dict[str, Any]]:
        """Walks `node`'s full subtree for `ast.Name` *usages* (`Load` context - assignment
        targets carry no role) and tags each with a role, offsets relative to
        `entity_start_byte` (the owning entity's own span start, matching the draft view's
        rendered text). Precedence: self > parameter > class name > function name > imported
        name > builtin. A name matching none of these is simply omitted (design D9 / spec
        "Unresolvable identifier role falls back gracefully")."""
        roles: list[dict[str, Any]] = []
        for child in ast.walk(node):
            if not isinstance(child, ast.Name) or not isinstance(child.ctx, ast.Load):
                continue
            name = child.id
            role: str | None = None
            if self_scope and name == "self":
                role = "self"
            elif name in parameter_names:
                role = "parameter"
            elif name in self.class_names:
                role = "className"
            elif name in self.function_names:
                role = "functionName"
            elif name in self.imported_names:
                role = "importedName"
            elif name in BUILTIN_NAMES:
                role = "builtin"
            if role is None:
                continue
            name_span = self.source.span(child)
            # Decorator expressions (e.g. `@staticmethod`) lexically precede the definition's
            # own span start (per Python's `lineno` convention), so a `Name` inside one would
            # otherwise produce a negative offset; skip anything outside the entity's own span.
            if name_span["startByte"] < entity_start_byte:
                continue
            roles.append({"start": name_span["startByte"] - entity_start_byte, "end": name_span["endByte"] - entity_start_byte, "role": role})
        return roles

    @property
    def current_id(self) -> str:
        return self.stack[-1][0]

    @property
    def current_qualified_name(self) -> str:
        return self.stack[-1][1]

    def add_definition(self, node: ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef, kind: str) -> None:
        qualified_name = f"{self.current_qualified_name}.{node.name}"
        actual_kind = "method" if kind == "function" and self.stack[-1][2] == "class" else kind
        span = self.source.span(node)
        identifier = entity_id(actual_kind, qualified_name, span["startByte"])
        module_prefix = f"{self.module}." if self.module else ""
        dotted_name = qualified_name[len(module_prefix):] if module_prefix and qualified_name.startswith(module_prefix) else qualified_name
        callable_kind = "class" if kind == "class" else "function"
        target = {"module": self.module, "dottedName": dotted_name, "callableKind": callable_kind}
        self_scope = qualified_name in self.self_scopes
        parameter_names: set[str] = set()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            parameter_names = {parameter.arg for parameter in node.args.posonlyargs + node.args.args + node.args.kwonlyargs}
            if node.args.vararg:
                parameter_names.add(node.args.vararg.arg)
            if node.args.kwarg:
                parameter_names.add(node.args.kwarg.arg)
            if self_scope:
                parameter_names.discard("self")
        identifier_roles = self._collect_identifier_roles(node, span["startByte"], self_scope, parameter_names)
        self.nodes.append({"id": identifier, "kind": actual_kind, "qualifiedName": qualified_name, "containerId": self.current_id, "span": span, "target": target, "identifierRoles": identifier_roles})
        self.edges.append({"kind": "contains", "source": self.current_id, "resolution": {"kind": "resolved", "target": identifier}, "span": span})
        self.stack.append((identifier, qualified_name, actual_kind))
        self.generic_visit(node)
        self.stack.pop()

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.add_definition(node, "class")

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._bind_signature(node)
        self.add_definition(node, "function")

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._bind_signature(node)
        self.add_definition(node, "function")

    def _bind_signature(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        """Record the receiver, parameter annotations, and return sources for the scope this definition opens."""
        scope = f"{self.current_qualified_name}.{node.name}"
        parameters = node.args.posonlyargs + node.args.args + node.args.kwonlyargs
        if self.stack[-1][2] == "class" and parameters and parameters[0].arg == "self" and not any(isinstance(decorator, ast.Name) and decorator.id in {"staticmethod", "classmethod"} for decorator in node.decorator_list):
            self.self_scopes.add(scope)
            parameters = parameters[1:]
        for parameter in parameters:
            if isinstance(parameter.annotation, ast.Name):
                self.local_bindings.append((scope, parameter.arg, parameter.annotation.id))

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            resolution = {"kind": "resolved", "target": entity_id("module", alias.name)} if alias.name in self.known_modules else {"kind": "unresolved"}
            self.edges.append({"kind": "import", "source": self.current_id, "resolution": resolution, "span": self.source.span(node), "importedName": alias.name})

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        prefix = "." * node.level + (node.module or "")
        base = self._from_import_base(node)
        for alias in node.names:
            imported = f"{prefix}.{alias.name}" if prefix and not prefix.endswith(".") else f"{prefix}{alias.name}"
            edge = {"kind": "import", "source": self.current_id, "resolution": {"kind": "unresolved"}, "span": self.source.span(node), "importedName": imported}
            self.edges.append(edge)
            if base:
                target_qualified_name = f"{base}.{alias.name}"
                self.from_imports.append((edge, target_qualified_name))
                if alias.name != "*":
                    self.import_aliases.append((self.current_qualified_name, alias.asname or alias.name, target_qualified_name))

    def _from_import_base(self, node: ast.ImportFrom) -> str | None:
        """Resolve the absolute dotted module an `import ... from` targets, relative imports included."""
        if node.level == 0:
            return node.module
        parts = self.module.split(".") if self.module else []
        # A package's own `__init__.py` *is* the level-1 package; a plain module's
        # level-1 package is its parent, so packages need one fewer level stripped.
        strip = node.level - (1 if self.is_package else 0)
        if strip < 0 or strip > len(parts):
            return None
        base = ".".join(parts[: len(parts) - strip]) if strip else self.module
        if node.module:
            return f"{base}.{node.module}" if base else node.module
        return base or None

    def visit_Assign(self, node: ast.Assign) -> None:
        """Bind `var = ClassName(...)` for the current scope; every other assignment shape is ignored."""
        if len(node.targets) == 1 and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name):
            self._bind_target(node.targets[0], node.value.func.id)
        self.generic_visit(node)

    def _bind_target(self, target: ast.expr, class_name: str) -> None:
        """Route a plain-name target to the lexical binding table and a `self.attr` target to its class's table."""
        if isinstance(target, ast.Name):
            self.local_bindings.append((self.current_qualified_name, target.id, class_name))
        elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "self" and self.current_qualified_name in self.self_scopes:
            self.attribute_bindings.append((self.current_qualified_name, target.attr, class_name))

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        """Bind `x: ClassName` from the annotation alone, whether or not a value is assigned."""
        if isinstance(node.annotation, ast.Name):
            self._bind_target(node.target, node.annotation.id)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        self.calls.append((self.current_id, self.current_qualified_name, node))
        self.generic_visit(node)


def analyze(request: dict[str, Any]) -> dict[str, Any]:
    files = [SourceFile(item["path"], item["content"]) for item in request["files"]]
    known_modules = {module_name(source.path) for source in files}
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    visitors: list[FileVisitor] = []

    package_sources = {module_name(source.path): source for source in files if source.path.endswith("/__init__.py")}
    for package, source in sorted(package_sources.items()):
        parent = package.rpartition(".")[0]
        package_node: dict[str, Any] = {"id": entity_id("package", package), "kind": "package", "qualifiedName": package, "span": _file_span(source)}
        if parent in package_sources:
            package_node["containerId"] = entity_id("package", parent)
        nodes.append(package_node)

    for source in files:
        module = module_name(source.path)
        is_package = source.path.endswith("/__init__.py")
        root_id = entity_id("package" if is_package else "module", module)
        if not is_package:
            module_node: dict[str, Any] = {"id": root_id, "kind": "module", "qualifiedName": module, "span": _file_span(source)}
            package = module.rpartition(".")[0]
            if package in package_sources:
                module_node["containerId"] = entity_id("package", package)
            nodes.append(module_node)
        try:
            tree = ast.parse(source.content, filename=source.path)
        except SyntaxError as error:
            diagnostic: dict[str, Any] = {"path": source.path, "message": error.msg, "severity": "error"}
            if error.lineno and error.offset and error.lineno <= len(source.line_byte_offsets):
                start = max(error.offset - 1, 0)
                start_byte = source.byte_offset(error.lineno, start)
                diagnostic["span"] = _span(source.path, start_byte, start_byte + 1, error.lineno, start, error.lineno, start + 1)
            diagnostics.append(diagnostic)
            continue
        visitor = FileVisitor(source, module, root_id, known_modules, is_package)
        visitor.prescan(tree)
        visitor.visit(tree)
        nodes.extend(visitor.nodes)
        edges.extend(visitor.edges)
        visitors.append(visitor)

    by_qualified_name: dict[str, list[str]] = {}
    for node in nodes:
        by_qualified_name.setdefault(node["qualifiedName"], []).append(node["id"])

    qualified_by_id: dict[str, str] = {node["id"]: node["qualifiedName"] for node in nodes}

    alias_targets: dict[str, list[str]] = {}
    for visitor in visitors:
        for edge, qualified_name in visitor.from_imports:
            edge["resolution"] = _resolution(by_qualified_name.get(qualified_name, []))
        for scope, local_name, target_qualified_name in visitor.import_aliases:
            alias_targets.setdefault(f"{scope}.{local_name}", []).extend(by_qualified_name.get(target_qualified_name, []))

    variable_classes: dict[str, list[str]] = {}
    for visitor in visitors:
        for scope, var, constructor in visitor.local_bindings:
            class_names = _class_names(constructor, scope, visitor.module, by_qualified_name, alias_targets, qualified_by_id)
            if not class_names:
                continue
            _extend(variable_classes.setdefault(f"{scope}.{var}", []), class_names)

    attribute_classes: dict[str, list[str]] = {}
    for visitor in visitors:
        for scope, attribute, raw in visitor.attribute_bindings:
            class_names = _class_names(raw, scope, visitor.module, by_qualified_name, alias_targets, qualified_by_id)
            if not class_names:
                continue
            _extend(attribute_classes.setdefault(f"{scope.rpartition('.')[0]}.{attribute}", []), class_names)

    for visitor in visitors:
        for source_id, scope, call in visitor.calls:
            resolution: dict[str, Any] = {"kind": "unresolved"}
            if isinstance(call.func, ast.Name):
                resolution = _resolve_lexical(call.func.id, scope, visitor.module, by_qualified_name, alias_targets)
            elif isinstance(call.func, ast.Attribute):
                receiver = call.func.value
                class_names: list[str] = []
                if isinstance(receiver, ast.Name):
                    class_names = variable_classes.get(f"{scope}.{receiver.id}", [])
                elif isinstance(receiver, ast.Attribute) and isinstance(receiver.value, ast.Name) and receiver.value.id == "self" and scope in visitor.self_scopes:
                    class_names = attribute_classes.get(f"{scope.rpartition('.')[0]}.{receiver.attr}", [])
                candidates: list[str] = []
                for class_name in class_names:
                    candidates.extend(by_qualified_name.get(f"{class_name}.{call.func.attr}", []))
                resolution = _resolution(candidates)
            edges.append({"kind": "call", "source": source_id, "resolution": resolution, "span": visitor.source.span(call)})

    return {"snapshot": request["snapshot"], "nodes": nodes, "edges": edges, "diagnostics": diagnostics}


def _extend(target: list[str], names: list[str]) -> None:
    target.extend(name for name in names if name not in target)


def _class_names(name: str, scope: str, module: str, symbols: dict[str, list[str]], aliases: dict[str, list[str]], qualified_by_id: dict[str, str]) -> list[str]:
    """Resolve a raw source name to the deduplicated qualified names of the classes it can denote."""
    names: list[str] = []
    for identifier in _lexical_candidates(name, scope, module, symbols, aliases):
        if identifier.startswith("class:"):
            _extend(names, [qualified_by_id[identifier]])
    return names


def _lexical_candidates(name: str, scope: str, module: str, symbols: dict[str, list[str]], aliases: dict[str, list[str]]) -> list[str]:
    current = scope
    while True:
        candidates = symbols.get(f"{current}.{name}", []) + aliases.get(f"{current}.{name}", [])
        if candidates:
            return candidates
        if current == module:
            break
        current = current.rpartition(".")[0]
        # Class attributes are not lexical bindings inside method bodies.
        if current and symbols.get(current, [""])[0].startswith("class:"):
            current = current.rpartition(".")[0]
    return []


def _resolve_lexical(name: str, scope: str, module: str, symbols: dict[str, list[str]], aliases: dict[str, list[str]]) -> dict[str, Any]:
    return _resolution(_lexical_candidates(name, scope, module, symbols, aliases))


def _resolution(candidates: list[str]) -> dict[str, Any]:
    ordered = sorted(candidates)
    if len(ordered) == 1:
        return {"kind": "resolved", "target": ordered[0]}
    if len(ordered) > 1:
        return {"kind": "ambiguous", "candidates": ordered}
    return {"kind": "unresolved"}


def _span(path: str, start_byte: int, end_byte: int, start_line: int, start_column: int, end_line: int, end_column: int) -> dict[str, Any]:
    return {"path": path, "startByte": start_byte, "endByte": end_byte, "startLine": start_line, "startColumn": start_column, "endLine": end_line, "endColumn": end_column}


def _file_span(source: SourceFile) -> dict[str, Any]:
    byte_length = len(source.content.encode("utf-8"))
    if not source.content:
        return _span(source.path, 0, 0, 1, 0, 1, 0)
    if source.content.endswith(("\n", "\r")):
        end_line, end_column = len(source.content.splitlines()) + 1, 0
    else:
        end_line = len(source.content.splitlines())
        end_column = len(source.content.splitlines()[-1].encode("utf-8"))
    return _span(source.path, 0, byte_length, 1, 0, end_line, end_column)


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            if request.get("type") != "analyze":
                raise ValueError("Unsupported request type")
            response = analyze(request)
        except Exception as error:
            response = {"error": {"message": str(error)}}
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
