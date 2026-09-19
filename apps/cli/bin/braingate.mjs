#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const distMain = fileURLToPath(new URL("../dist/main.js", import.meta.url));

// A packed install (`pnpm --filter braingate build` then `pnpm pack`) ships the bundle built by
// `apps/cli/scripts/build.mjs`, so it runs directly under plain `node` with no TypeScript
// toolchain required on the installing machine. Inside this monorepo, where nobody has run
// `build`, the launcher falls back to running the TypeScript source through `tsx` exactly as it
// always has.
let child;
if (existsSync(distMain)) {
  child = spawnSync(process.execPath, [distMain, ...args], { stdio: "inherit" });
} else {
  const tsx = import.meta.resolve("tsx");
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  child = spawnSync(process.execPath, ["--import", tsx, main, ...args], { stdio: "inherit" });
}

if (child.error) {
  console.error("BrainGate CLI launcher failed.");
  process.exitCode = 1;
} else {
  process.exitCode = child.status ?? 1;
}
