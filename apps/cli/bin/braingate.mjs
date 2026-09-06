#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tsx = import.meta.resolve("tsx");
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const child = spawnSync(process.execPath, ["--import", tsx, main, ...process.argv.slice(2)], { stdio: "inherit" });
if (child.error) {
  console.error("BrainGate CLI launcher failed.");
  process.exitCode = 1;
} else {
  process.exitCode = child.status ?? 1;
}
