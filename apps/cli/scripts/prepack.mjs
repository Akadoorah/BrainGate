// `pnpm pack` reads this package's `package.json` to build the tarball's manifest. In the
// monorepo, `dependencies` lists the `@braingate/*` workspace packages so `pnpm install` links
// them for local development, and `devDependencies` carries the TypeScript/tsx toolchain. Neither
// belongs in a tarball meant to be installed on another machine: the workspace packages are never
// published (installing the tarball would 404 trying to fetch them from the registry), and `pnpm
// build` has already bundled their code into `dist/main.js`. The only real runtime dependency left
// outside the bundle is `better-sqlite3`, kept external by `scripts/build.mjs` because it ships a
// native addon.
//
// This rewrites `package.json` in place for the duration of the pack, and `postpack.mjs` restores
// the development version immediately after. Both run automatically as `pnpm pack` lifecycle
// scripts, so a plain `pnpm pack` always leaves the working tree exactly as it found it.
import { copyFileSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(cliDir, "package.json");
const backupPath = path.join(cliDir, "package.json.prepack-backup");
const repoRoot = path.resolve(cliDir, "..", "..");
const readmePath = path.join(cliDir, "README.md");
const readmeBackupPath = path.join(cliDir, "dev-readme.prepack-backup");
const licensePath = path.join(cliDir, "LICENSE");

if (existsSync(backupPath) || existsSync(readmeBackupPath)) {
  throw new Error(
    `${backupPath} or ${readmeBackupPath} already exists — a previous pack did not clean up. Restore the originals from ` +
      "them manually (or discard them if the originals are already correct) before packing again.",
  );
}

copyFileSync(pkgPath, backupPath);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const keptDependencies = {};
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  if (!name.startsWith("@braingate/")) {
    keptDependencies[name] = range;
  }
}
if (!keptDependencies["better-sqlite3"]) {
  throw new Error(
    "better-sqlite3 is missing from apps/cli/package.json dependencies — dist/main.js imports it " +
      "at runtime and a packed install would be missing it.",
  );
}
pkg.dependencies = keptDependencies;
delete pkg.devDependencies;

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// The registry shows the tarball's README on the package page, and npm only picks one up from the
// package directory. This package's own README is a note for working inside the monorepo, so the
// root README — the one a person arriving from npm should read — stands in for it during the pack.
// Its relative links resolve on npmjs.com against `repository`, which names the repository root.
// The license is copied for the same reason: npm includes a LICENSE only from the package itself.
renameSync(readmePath, readmeBackupPath);
copyFileSync(path.join(repoRoot, "README.md"), readmePath);
copyFileSync(path.join(repoRoot, "LICENSE"), licensePath);
