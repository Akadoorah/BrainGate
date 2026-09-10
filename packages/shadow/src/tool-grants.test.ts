import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError } from "@braingate/core";
import { TOOL_CAPABILITIES, assertGrantCovers, grants, guaranteesFor, isToolCapability, requestedCapabilities, resolveToolGrant, type ProviderGrantSurface } from "./tool-grants.js";

const PROVEN: ProviderGrantSurface = { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: true, enforcedSandbox: true };
const BARE: ProviderGrantSurface = { isolatedPerInvocation: false, toolDenial: false, declaredSubagents: false, enforcedSandbox: false };

function grant(overrides: Partial<Parameters<typeof resolveToolGrant>[0]> = {}) {
  return resolveToolGrant({
    role: "planner", providerId: "xai", workspaceMode: "staged-clean", writeMode: false,
    surface: PROVEN, attested: true, operatorAccepted: false, fanOutAllowed: true, ...overrides,
  });
}

test("read is granted to every role, on every provider", () => {
  for (const role of ["planner", "primary", "reviewer", "judge"] as const) {
    assert.ok(grants(grant({ role, surface: BARE, attested: false }), "read"), role);
  }
});

test("a capability the role never asked for is absent without being refused", () => {
  const judge = grant({ role: "judge" });
  assert.deepEqual([...judge.requested], ["read"]);
  assert.deepEqual([...judge.granted], ["read"]);
  assert.deepEqual([...judge.refused], []);
});

test("subagents need definitions BrainGate can write, not merely a provider that has some", () => {
  const proven = grant({ role: "reviewer" });
  assert.ok(grants(proven, "subagents"));
  const cannotDeclare = grant({ role: "reviewer", surface: { ...PROVEN, declaredSubagents: false } });
  assert.equal(grants(cannotDeclare, "subagents"), false);
  assert.match(cannotDeclare.refused.find((item) => item.capability === "subagents")!.reason, /does not accept subagent definitions/);
});

test("an unproven provider may still have subagents once the operator accepts the residual", () => {
  const unproven = { ...PROVEN, isolatedPerInvocation: false };
  assert.equal(grants(grant({ role: "reviewer", surface: unproven }), "subagents"), false);
  assert.ok(grants(grant({ role: "reviewer", surface: unproven, operatorAccepted: true }), "subagents"));
});

test("network access is its own decision, and accepting an unscoped provider is not it", () => {
  const planner = grant({ role: "planner" });
  assert.equal(grants(planner, "web"), false);
  assert.match(planner.refused.find((item) => item.capability === "web")!.reason, /allow-web/);
  // Accepting a provider BrainGate cannot scope says what that CLI may reach on this machine.
  // It says nothing about what may leave it, and must not be read as if it did.
  assert.equal(grants(grant({ role: "planner", operatorAccepted: true }), "web"), false);
  assert.ok(grants(grant({ role: "planner", networkAccepted: true }), "web"));
  // And a provider BrainGate scopes perfectly well can still be granted the network.
  assert.ok(grants(grant({ role: "planner", surface: PROVEN, operatorAccepted: false, networkAccepted: true }), "web"));
});

test("a shell is refused against the registered checkout however capable the provider is", () => {
  const inProject = grant({ role: "primary", writeMode: true, workspaceMode: "project" });
  assert.equal(grants(inProject, "shell"), false);
  assert.match(inProject.refused.find((item) => item.capability === "shell")!.reason, /never granted against the registered checkout/);
});

test("editing needs a task worktree, not a staged directory", () => {
  const staged = grant({ role: "primary", writeMode: true, workspaceMode: "staged-clean" });
  assert.equal(grants(staged, "edit"), false);
  const worktree = grant({ role: "primary", writeMode: true, workspaceMode: "task-worktree" });
  assert.ok(grants(worktree, "edit"));
  assert.ok(grants(worktree, "shell"), "verification needs a shell where editing happens");
});

test("a shell in a worktree still needs a sandbox that fails closed, proven for this build", () => {
  const noSandbox = grant({ role: "primary", writeMode: true, workspaceMode: "task-worktree", surface: { ...PROVEN, enforcedSandbox: false } });
  assert.equal(grants(noSandbox, "shell"), false);
  assert.ok(grants(noSandbox, "edit"), "a missing sandbox refuses the shell, not the whole role");
  const stale = grant({ role: "primary", writeMode: true, workspaceMode: "task-worktree", attested: false });
  assert.equal(grants(stale, "shell"), false);
  assert.match(stale.refused.find((item) => item.capability === "shell")!.reason, /No current self-test/);
});

test("MCP is refused for every role, and says why rather than going quiet", () => {
  const asked = resolveToolGrant({
    role: "planner", providerId: "xai", workspaceMode: "staged-clean", writeMode: false,
    surface: PROVEN, attested: true, operatorAccepted: true,
  });
  assert.equal(grants(asked, "mcp"), false);
});

test("the grant can only take a guarantee away, never invent one", () => {
  const honest = { projectOnlyRead: true, noProjectWrites: true, noShell: false, noNetworkTools: true, noMcp: true, noSessionPersistence: false, isolatedUserConfig: true };
  const derived = guaranteesFor(grant({ role: "planner" }), honest);
  assert.equal(derived.noShell, false, "Grok keeps a shell BrainGate cannot remove; withholding the capability must not claim otherwise");
  const withWeb = guaranteesFor(grant({ role: "planner", networkAccepted: true }), honest);
  assert.equal(withWeb.noNetworkTools, false, "a granted capability removes the claim");
});

test("a run that needs a capability it was refused fails with the reason, not a generic block", () => {
  assert.throws(
    () => assertGrantCovers(grant({ role: "planner" }), ["web"]),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "SHADOW_GRANT_INSUFFICIENT" && /allow-web/.test(error.message),
  );
});

test("the capability list and its guard cannot drift apart", () => {
  for (const capability of TOOL_CAPABILITIES) assert.ok(isToolCapability(capability));
  assert.equal(isToolCapability("root"), false);
});

test("only the executing role asks to change anything", () => {
  for (const role of ["planner", "reviewer", "judge"] as const) {
    assert.ok(!requestedCapabilities({ role, writeMode: true }).includes("edit"), role);
  }
  assert.ok(requestedCapabilities({ role: "primary", writeMode: true }).includes("edit"));
  assert.ok(!requestedCapabilities({ role: "primary", writeMode: false }).includes("edit"));
});

test("a budget that allows one agent at a time gets no helpers, and is told why", () => {
  const cheap = grant({ role: "reviewer", fanOutAllowed: false });
  assert.equal(grants(cheap, "subagents"), false);
  assert.match(cheap.refused.find((item) => item.capability === "subagents")!.reason, /one agent at a time/);
});
