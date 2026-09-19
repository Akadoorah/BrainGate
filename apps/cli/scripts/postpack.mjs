// Restores the development `package.json` that `prepack.mjs` set aside, so a `pnpm pack` never
// leaves the workspace deps and toolchain stripped out of the working tree.
import { renameSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(cliDir, "package.json");
const backupPath = path.join(cliDir, "package.json.prepack-backup");

if (!existsSync(backupPath)) {
  throw new Error(`${backupPath} is missing — prepack.mjs did not run, or already cleaned up.`);
}

renameSync(backupPath, pkgPath);
