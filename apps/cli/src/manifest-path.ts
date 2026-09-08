import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const DEFAULT_MANIFEST = ".brain/project.json";

/**
 * Finds the project manifest for a directory, walking upward.
 *
 * `braingate init` writes the manifest at the repository's top level, because that is what the
 * project is. Every reader looked for it in the current directory instead, so running anywhere
 * below the root — a package in a monorepo, `apps/web`, anywhere — reported no project, offered
 * to register one, and then refused with PROJECT_INIT_CONFLICT because a manifest already
 * existed where init had put it.
 *
 * Searching upward is also what the operator expects: git works from any subdirectory, and a
 * project-scoped tool that only worked from one is surprising for no reason.
 *
 * An explicitly passed `--project` path is never searched for; it is used exactly as given, so a
 * caller naming a manifest still gets that manifest or a clear failure.
 */
export function findManifest(cwd: string, explicit?: string): string {
  if (explicit !== undefined && explicit !== DEFAULT_MANIFEST) {
    return isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
  }
  let directory = resolve(cwd);
  for (;;) {
    const candidate = resolve(directory, DEFAULT_MANIFEST);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    // At the filesystem root, dirname returns the same path.
    if (parent === directory) return resolve(cwd, DEFAULT_MANIFEST);
    directory = parent;
  }
}
