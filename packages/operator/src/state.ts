import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";

export interface OperatorStatePaths {
  readonly home: string;
  readonly globalDir: string;
  readonly modelCatalogPath: string;
  readonly providerAcceptancePath: string;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* best effort on platforms without POSIX modes */ }
}

export function resolveOperatorState(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): OperatorStatePaths {
  const configured = env.BRAINGATE_HOME?.trim();
  if (configured !== undefined && configured.length === 0) {
    throw new BrainGateInvariantError("OPERATOR_HOME_INVALID", "BRAINGATE_HOME cannot be blank.");
  }
  const home = configured === undefined
    ? resolve(userHome, ".braingate")
    : resolve(isAbsolute(configured) ? configured : resolve(process.cwd(), configured));
  const globalDir = resolve(home, "global");
  privateDirectory(home);
  privateDirectory(globalDir);
  return Object.freeze({
    home,
    globalDir,
    modelCatalogPath: resolve(globalDir, "models.json"),
    providerAcceptancePath: resolve(globalDir, "provider-acceptance.json"),
  });
}
