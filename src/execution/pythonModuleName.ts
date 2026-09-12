const PYTHON_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INIT_BASENAME = "__init__";
const PY_EXTENSION = ".py";

export interface PythonModuleEntry {
  readonly dottedName: string;
  readonly posixPath: string;
  readonly isPackage: boolean;
}

/**
 * Maps a set of captured `.py` posixPaths to deterministic dotted Python module names,
 * following classic (`__init__.py`-required) package semantics. Pure, no I/O.
 */
export function mapPathsToModules(posixPaths: readonly string[]): PythonModuleEntry[] {
  const initDirs = new Set<string>();
  for (const posixPath of posixPaths) {
    const segments = posixPath.split("/");
    const basename = segments[segments.length - 1];
    if (basename === `${INIT_BASENAME}${PY_EXTENSION}`) {
      const dirSegments = segments.slice(0, -1);
      initDirs.add(dirSegments.join("/"));
    }
  }

  const byDottedName = new Map<string, PythonModuleEntry>();

  for (const posixPath of posixPaths) {
    if (!posixPath.endsWith(PY_EXTENSION)) {
      continue;
    }
    const segments = posixPath.split("/");
    const fileName = segments[segments.length - 1];
    const dirSegments = segments.slice(0, -1);
    const basename = fileName.slice(0, -PY_EXTENSION.length);

    if (!dirSegments.every((segment) => PYTHON_IDENTIFIER.test(segment))) {
      continue;
    }

    // Every directory segment in the chain must itself be a package: its own
    // `<dir>/__init__.py` must be present in the same input array.
    const everyAncestorIsPackage = dirSegments.every((_segment, index) => {
      const prefix = dirSegments.slice(0, index + 1).join("/");
      return initDirs.has(prefix);
    });

    let dottedName: string;
    let isPackage: boolean;

    if (basename === INIT_BASENAME) {
      if (dirSegments.length === 0) {
        // Root-level __init__.py: empty dotted name, skipped.
        continue;
      }
      if (!everyAncestorIsPackage) {
        continue;
      }
      dottedName = dirSegments.join(".");
      isPackage = true;
    } else {
      if (!PYTHON_IDENTIFIER.test(basename)) {
        continue;
      }
      if (dirSegments.length > 0 && !everyAncestorIsPackage) {
        continue;
      }
      dottedName = [...dirSegments, basename].join(".");
      isPackage = false;
    }

    const existing = byDottedName.get(dottedName);
    if (existing !== undefined && existing.isPackage && !isPackage) {
      // Package wins on collision; skip the module entry.
      continue;
    }
    byDottedName.set(dottedName, { dottedName, posixPath, isPackage });
  }

  return Array.from(byDottedName.values()).sort((a, b) => a.dottedName.localeCompare(b.dottedName));
}
