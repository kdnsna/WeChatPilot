import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

function normalizedProjectRoot(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) {
    throw new Error("Project root must be an absolute path");
  }
  const normalized = resolve(projectRoot);
  if (normalized === parse(normalized).root) {
    throw new Error("Project root cannot be a filesystem root");
  }
  return normalized;
}

function canonicalProjectRoot(projectRoot: string): string {
  const root = normalizedProjectRoot(projectRoot);
  try {
    const canonical = realpathSync(root);
    if (!statSync(canonical).isDirectory()) {
      throw new Error("Project root must be a directory");
    }
    return canonical;
  } catch {
    throw new Error("Project root must be an existing directory");
  }
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function deepestExistingAncestor(candidate: string, root: string): string {
  let current = candidate;
  while (true) {
    try {
      lstatSync(current);
      return current;
    } catch (error: unknown) {
      if (!isMissingPath(error)) {
        throw new Error("Unable to validate project path");
      }
      if (current === root) {
        return root;
      }
      current = dirname(current);
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

export function assertProjectPath(
  projectRoot: string,
  candidatePath: string,
): string {
  const root = normalizedProjectRoot(projectRoot);
  const candidate = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(root, candidatePath);
  if (!isWithin(root, candidate)) {
    throw new Error("Path is outside project root");
  }
  const canonicalRoot = canonicalProjectRoot(root);
  const existingAncestor = deepestExistingAncestor(candidate, root);
  let canonicalAncestor: string;
  try {
    canonicalAncestor = realpathSync(existingAncestor);
  } catch {
    throw new Error("Project path contains an invalid symlink");
  }
  if (!isWithin(canonicalRoot, canonicalAncestor)) {
    throw new Error("Project path symlink resolves outside project root");
  }
  return candidate;
}

export function assertNoSymlinkComponents(
  projectRoot: string,
  candidatePath: string,
): string {
  const root = normalizedProjectRoot(projectRoot);
  const candidate = assertProjectPath(root, candidatePath);
  const relativePath = relative(root, candidate);
  let current = root;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("Project path must not contain symlinks");
      }
    } catch (error: unknown) {
      if (isMissingPath(error)) {
        break;
      }
      throw error;
    }
  }
  return candidate;
}

function containsTraversal(segment: string): boolean {
  return segment.split(/[\\/]+/u).includes("..");
}

export function resolveProjectPath(
  projectRoot: string,
  ...segments: readonly string[]
): string {
  const root = normalizedProjectRoot(projectRoot);
  for (const segment of segments) {
    if (segment.includes("\0")) {
      throw new Error("Project path contains an invalid character");
    }
    if (isAbsolute(segment)) {
      throw new Error("Project path segments must not be absolute");
    }
    if (containsTraversal(segment)) {
      throw new Error("Project path traversal is not allowed");
    }
  }
  return assertProjectPath(root, resolve(root, ...segments));
}

export interface ProjectPaths {
  readonly root: string;
  readonly config: string;
  readonly data: string;
  readonly raw: string;
  readonly history: string;
  readonly output: string;
  readonly logs: string;
  readonly state: string;
}

export function createProjectPaths(projectRoot: string): ProjectPaths {
  const root = normalizedProjectRoot(projectRoot);
  return Object.freeze({
    root,
    config: resolveProjectPath(root, "config"),
    data: resolveProjectPath(root, "data"),
    raw: resolveProjectPath(root, "data", "raw"),
    history: resolveProjectPath(root, "data", "history"),
    output: resolveProjectPath(root, "output"),
    logs: resolveProjectPath(root, "logs"),
    state: resolveProjectPath(root, ".state"),
  });
}

export const buildProjectPaths = createProjectPaths;
