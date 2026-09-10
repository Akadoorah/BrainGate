import { BrainGateInvariantError } from "@braingate/core";
import { resolveToolGrant } from "./tool-grants.js";
import type { ProviderSnapshot } from "@braingate/providers";
import type { ModelRef } from "@braingate/router";
import {
  CODEX_REVIEW_DISABLED_FEATURES,
  acceptedFeatureKeys,
  codexReviewerConfigArgs,
  validCodexIsolationAttestation,
  type CodexIsolationAttestation,
} from "./codex-isolation.js";
import { STAGE_PATH_TOKEN } from "./types.js";
import type { ShadowInvocationPlan } from "./types.js";

/**
 * The Codex profile for the visual role (ADR 0007).
 *
 * It is the reviewer profile with one feature re-enabled, and the workspace stays read-only.
 * That reads like an oversight and is the point: Codex writes generated images into its own
 * home rather than the working directory, so generation needs no write access to the worktree
 * at all. BrainGate collects the file afterwards. A profile that granted workspace writes to
 * obtain an image would be widening the boundary for something that never needed it.
 *
 * `image_generation` is enabled here and nowhere else. The reviewer keeps it disabled, because
 * a reviewer that can also produce artifacts is not independent of what it is judging.
 */

export const VISUAL_FEATURE = "image_generation";

/**
 * The visual instruction.
 *
 * The provider is told to declare what it produced, because BrainGate collects by declared path
 * and infers nothing from prose. Without the declaration a generated file simply stays in the
 * provider's home and never reaches the task.
 */
export const CODEX_VISUAL_PROMPT = [
  "You are given one JSON request object (appended below this instruction).",
  "Use its `task` field as the request and its `context` field as supporting data.",
  "Produce the image or images the task asks for.",
  "Do not modify, create or delete any file in the working directory; it is read-only, and you do not need to write there.",
  "Finish your reply with a line of the form:",
  'BRAINGATE_ARTIFACTS {"artifacts":[{"sourcePath":"<absolute path you actually wrote>","destination":"<path within the project the task asked for>"}]}',
  "Declare every file you produced and want kept, and declare nothing you did not produce: a path that does not exist fails the task.",
  "If you produced nothing, omit the block entirely rather than declaring an empty or invented path.",
].join(" ");

/**
 * Feature keys for a visual run: the declared deny list, minus whatever this build rejects, minus
 * image generation itself.
 */
export function codexVisualFeatureKeys(droppedFeatureKeys: readonly string[]): readonly string[] {
  return Object.freeze(acceptedFeatureKeys(droppedFeatureKeys).filter((key) => key !== VISUAL_FEATURE));
}

export function planCodexVisualInvocation(input: {
  readonly snapshot: ProviderSnapshot;
  readonly model: ModelRef;
  readonly cwd: string;
  readonly payload: unknown;
  readonly codexIsolation?: CodexIsolationAttestation;
  readonly now?: Date;
}): ShadowInvocationPlan {
  if (input.snapshot.providerId !== "openai" || input.model.providerId !== "openai") {
    throw new BrainGateInvariantError("VISUAL_PROVIDER_UNSUPPORTED", "The Codex visual profile accepts only the OpenAI provider.");
  }
  if (input.snapshot.authMode.value === "api") {
    throw new BrainGateInvariantError("VISUAL_API_AUTH_DENIED", "Codex is authenticated for API billing, not subscription visual usage.");
  }
  // The same attestation the reviewer requires. Generation does not lower the bar for proving
  // that the sandbox holds; it raises the consequence of it not holding.
  if (!validCodexIsolationAttestation(input.codexIsolation, input.snapshot, { now: input.now ?? new Date() })) {
    throw new BrainGateInvariantError("VISUAL_ISOLATION_REQUIRED", "The Codex visual profile requires a current sandbox self-test attestation for this version, platform and profile.");
  }

  const dropped = input.codexIsolation?.droppedFeatureKeys ?? [];
  const args = Object.freeze([
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--json",
    "--model", input.model.modelId,
    "-C", STAGE_PATH_TOKEN,
    ...codexReviewerConfigArgs(STAGE_PATH_TOKEN, codexVisualFeatureKeys(dropped)),
    `-c`, `features.${VISUAL_FEATURE}=true`,
    "-",
  ]);
  if (args.includes("--sandbox") || args.includes("--dangerously-bypass-approvals-and-sandbox") || args.includes("--full-auto")) {
    throw new BrainGateInvariantError("VISUAL_PROFILE_UNSAFE", "Unsafe or legacy Codex sandbox flags are forbidden for the visual profile.");
  }

  return Object.freeze({
    providerId: "openai",
    executable: input.snapshot.binary,
    args,
    cwd: input.cwd,
    workspaceMode: "staged-clean",
    modelId: input.model.modelId,
    quotaPool: input.model.quotaPool,
    inputMode: "stdin",
    stdin: JSON.stringify(input.payload),
    attachmentContent: null,
    attachmentToken: null,
    allowedEnvKeys: Object.freeze(["CODEX_HOME"]),
    envOverrides: Object.freeze({}),
    // A visual pass reads its brief and produces a file outside the workspace. It asks for
    // nothing beyond that, so the grant is the smallest one BrainGate issues.
    grant: resolveToolGrant({
      role: "primary",
      providerId: "openai",
      workspaceMode: "staged-clean",
      writeMode: false,
      surface: { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: false, enforcedSandbox: true },
      attested: true,
      operatorAccepted: false,
    }),
    streamDialect: null,
    // The workspace guarantees are unchanged from the reviewer: the image is produced outside
    // it, so nothing here is relaxed to make generation possible.
    guarantees: Object.freeze({ projectOnlyRead: true, noProjectWrites: true, noShell: true, noNetworkTools: true, noMcp: true, noSessionPersistence: true, isolatedUserConfig: true }),
    minimumVersion: null,
  });
}

/** Every declared control key still disabled on a visual run, for the receipt. */
export function codexVisualDisabledFeatures(droppedFeatureKeys: readonly string[]): readonly string[] {
  const enabled = new Set<string>([VISUAL_FEATURE]);
  return Object.freeze(CODEX_REVIEW_DISABLED_FEATURES.filter((key) => !enabled.has(key) && !droppedFeatureKeys.includes(key)));
}
