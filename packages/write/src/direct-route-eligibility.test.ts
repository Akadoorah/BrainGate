import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { budgetFor, classifyTask, ProjectRegistry, executionScopeFor, type ExecutionProject } from "@braingate/core";
import { ModelRegistry, CapabilityRouter } from "@braingate/router";
import type { ProviderSnapshot } from "@braingate/providers";
import { buildWriteTaskPlan } from "./write-runner.js";

/**
 * Who an automatic DIRECT write may go to.
 *
 * This used to be decided by name: with no pin, `openai`, `google` and `xai` were pushed out of the
 * automatic route so that DIRECT work went to the reference provider. That was defensible while the
 * operator's `/use` was what chose a worker, and it is wrong now that the route chooses: a task whose
 * best worker was Grok or Codex could not reach it, and an exhausted Claude pool left the write with
 * no eligible worker at all instead of the subscription that was free.
 *
 * What replaces it is a measured capability, not a preference: the providers the caller measured as
 * able to run this policy, which for a DIRECT write is the set with a DIRECT write invocation.
 */

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}

function fixture(label: string): { readonly project: ExecutionProject; readonly repo: string } {
  const root = mkdtempSync(join(tmpdir(), `braingate-write-route-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  const registered = new ProjectRegistry(join(root, "home")).register({ projectId: label as never, name: label, repositories: [repo] });
  return { project: executionScopeFor(registered, repo).project, repo };
}

function snapshot(providerId: "anthropic" | "xai" | "google"): ProviderSnapshot {
  const observedAt = "2026-09-14T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName: providerId,
    binary: providerId === "anthropic" ? "claude" : providerId === "xai" ? "grok" : "agy",
    available: obs(true),
    version: obs(providerId === "anthropic" ? "2.1.270" : providerId === "xai" ? "1.0.24" : "1.2.2"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: false }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    removedBillingOverrides: [],
    warnings: [],
  };
}

/** Two subscriptions, one clearly better at this work and one merely capable. */
function router(): CapabilityRouter {
  const registry = new ModelRegistry();
  registry.register({ providerId: "anthropic", modelId: "claude-weak", quotaPool: "claude-subscription", capabilities: { coder: 60, reviewer: 60, judge: 60 }, speed: "balanced", contextCapacity: 200_000, writeCapable: true, reasoning: 60, underlyingFamily: null }, { available: true, quotaState: "healthy", quotaHint: 0, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-14T00:00:00.000Z" });
  registry.register({ providerId: "xai", modelId: "grok-strong", quotaPool: "grok-subscription", capabilities: { coder: 92, reviewer: 80, judge: 76 }, speed: "balanced", contextCapacity: 256_000, writeCapable: true, reasoning: 88, underlyingFamily: null }, { available: true, quotaState: "healthy", quotaHint: 0, refusalBackoffUntil: null, quotaObservedAt: null, observedAt: "2026-09-14T00:00:00.000Z" });
  return new CapabilityRouter(registry);
}

function plan(input: { readonly providers: readonly ProviderSnapshot[]; readonly supported: readonly string[]; readonly policyCapability: boolean }) {
  const f = fixture("direct-route");
  const classification = classifyTask({ text: "Rename the button label in the header component", mode: "write" });
  return buildWriteTaskPlan({
    router: router(),
    providers: input.providers,
    classification,
    budget: budgetFor(classification, { writeRequested: true }),
    requiredContextTokens: 500,
    repositoryPath: f.repo,
    baseRef: "main",
    policy: "direct",
    review: false,
    ...(input.policyCapability ? { policyCapability: { id: "direct", supportedProviders: input.supported } } : {}),
  });
}

test("an automatic DIRECT write can route to whichever subscription has the better worker", () => {
  const routed = plan({ providers: [snapshot("anthropic"), snapshot("xai")], supported: ["anthropic", "xai"], policyCapability: true });
  assert.equal(routed.roles[0]?.model.providerId, "xai", "the stronger measured worker takes the write, whichever subscription it is on");
  assert.equal(routed.roles[0]?.model.modelId, "grok-strong");

  // And the measured capability is still a gate: a provider the caller did not measure as able to
  // run this policy is not a candidate, however strong it is.
  const gated = plan({ providers: [snapshot("anthropic"), snapshot("xai")], supported: ["anthropic"], policyCapability: true });
  assert.equal(gated.roles[0]?.model.providerId, "anthropic", "a provider that cannot run the policy is not routed to");
  assert.equal(
    gated.roles[0]?.route.rejected.find((rejection) => rejection.model.providerId === "xai")?.reasons.includes("provider-excluded"),
    true,
  );
});
