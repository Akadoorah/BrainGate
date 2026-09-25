// Restores the development `package.json` and README that `prepack.mjs` set aside, and removes the
// LICENSE copy it staged, so a `pnpm pack` never leaves the working tree changed.
import { renameSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(cliDir, "package.json");
const backupPath = path.join(cliDir, "package.json.prepack-backup");

if (!existsSync(backupPath)) {
  throw new Error(`${backupPath} is missing — prepack.mjs did not run, or already cleaned up.`);
}

renameSync(backupPath, pkgPath);

const readmeBackupPath = path.join(cliDir, "dev-readme.prepack-backup");
if (existsSync(readmeBackupPath)) renameSync(readmeBackupPath, path.join(cliDir, "README.md"));
rmSync(path.join(cliDir, "LICENSE"), { force: true });
