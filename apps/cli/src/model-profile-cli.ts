import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import { ModelCatalog, analyzeModelCoverage, resolveOperatorState } from "@braingate/operator";

export interface ModelProfileCliDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export interface ModelProfileCliResult { readonly exitCode: number; readonly data: unknown; }

export async function runModelProfileCli(argv: readonly string[], deps: ModelProfileCliDependencies = {}): Promise<ModelProfileCliResult> {
  const args = [...argv];
  const jsonIndex = args.indexOf("--json");
  const json = jsonIndex >= 0;
  if (json) args.splice(jsonIndex, 1);
  const cwd = realpathSync.native(resolve(deps.cwd ?? process.cwd()));
  void cwd;
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    if (args[0] !== "models" || args[1] !== "profile" || args.length !== 2) throw new BrainGateInvariantError("CLI_ARGUMENT_INVALID", "Use `braingate models profile [--json]`.");
    const state = resolveOperatorState(env);
    const profile = analyzeModelCoverage(new ModelCatalog(state.modelCatalogPath).load());
    const providers = profile.providers.map((provider) => `${provider.providerId}: ${provider.models.length} model(s), speeds=${provider.speeds.join("/") || "none"}, reviewer=${provider.roles.reviewer}`).join("\n");
    const human = [
      `Configured models: ${profile.configuredModels}`,
      `Single-provider mode: ${profile.singleProviderMode ? "yes" : "no"}`,
      `Reviewer independence: ${profile.reviewerIndependence}`,
      `Coverage: ${Object.entries(profile.coverage).map(([level, ready]) => `${level}=${ready ? "yes" : "no"}`).join(" · ")}`,
      providers,
      ...profile.warnings.map((warning) => `Warning: ${warning}`),
    ].filter(Boolean).join("\n");
    stdout(json ? `${JSON.stringify(profile, null, 2)}\n` : `${human}\n`);
    return Object.freeze({ exitCode: profile.configuredModels > 0 ? 0 : 1, data: profile });
  } catch (error) {
    const safe = error instanceof BrainGateInvariantError
      ? { code: error.code, message: error.message }
      : { code: "CLI_UNEXPECTED", message: "Unexpected model profile failure." };
    stderr(json ? `${JSON.stringify({ error: safe }, null, 2)}\n` : `BrainGate ${safe.code}: ${safe.message}\n`);
    return Object.freeze({ exitCode: 1, data: { error: safe } });
  }
}
