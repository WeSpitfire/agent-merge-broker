import picomatch from "picomatch";

export function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\/+|\/+$/gu, "");
}

export function matchesPattern(file: string, pattern: string): boolean {
  const normalizedFile = normalizeGitPath(file);
  const normalizedPattern = normalizeGitPath(pattern);
  return picomatch.isMatch(normalizedFile, normalizedPattern, { dot: true });
}

export function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(file, pattern));
}

export function unexpectedPaths(actual: string[], expected: string[]): string[] {
  if (expected.length === 0) return [...actual];
  return actual.filter((file) => !matchesAny(file, expected));
}

function literalPrefix(pattern: string): string {
  const normalized = normalizeGitPath(pattern);
  const magic = normalized.search(/[?*{[(]/u);
  const prefix = magic === -1 ? normalized : normalized.slice(0, magic);
  return prefix.slice(0, prefix.lastIndexOf("/") + 1);
}

export function patternsMayOverlap(left: string, right: string): boolean {
  const a = normalizeGitPath(left);
  const b = normalizeGitPath(right);
  if (a === b || matchesPattern(a, b) || matchesPattern(b, a)) return true;
  const aHasMagic = /[?*{[(]/u.test(a);
  const bHasMagic = /[?*{[(]/u.test(b);
  if (!aHasMagic || !bHasMagic) return false;
  const aPrefix = literalPrefix(a);
  const bPrefix = literalPrefix(b);
  if (!aPrefix || !bPrefix) return true;
  return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
}

export function patternSetsMayOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => patternsMayOverlap(a, b)));
}

export function pathsOverlap(left: string[], right: string[]): string | undefined {
  const rightSet = new Set(right.map(normalizeGitPath));
  return left.map(normalizeGitPath).find((file) => rightSet.has(file));
}

export function matchedSerializedPatterns(paths: string[], patterns: string[]): string[] {
  return patterns.filter((pattern) => paths.some((file) => matchesPattern(file, pattern)));
}
