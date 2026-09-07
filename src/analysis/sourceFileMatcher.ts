export interface SourceFileMatcher {
  readonly extensions: readonly string[];
  matches(posixPath: string): boolean;
}

export function createSourceFileMatcher(extensions: readonly string[]): SourceFileMatcher {
  const normalizedExtensions = extensions.map((extension) => extension.toLowerCase());
  return {
    extensions: [...extensions],
    matches(posixPath: string): boolean {
      const lowerPath = posixPath.toLowerCase();
      return normalizedExtensions.some((extension) => lowerPath.endsWith(extension));
    },
  };
}

export const defaultSourceFileMatcher: SourceFileMatcher = createSourceFileMatcher([".py"]);
