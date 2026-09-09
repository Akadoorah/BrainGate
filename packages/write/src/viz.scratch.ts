import { ProjectRegistry } from "@braingate/core";
import { ProviderDiscovery } from "@braingate/providers";
import { CodexIsolationVerifier, NodeShadowProcessExecutor, planCodexVisualInvocation, extractCodexAgentMessage } from "@braingate/shadow";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const snapshots = await new ProviderDiscovery().discoverAll();
const codex = snapshots.find((s) => s.providerId === "openai")!;
const attestation = await new CodexIsolationVerifier().verify(codex);

const registry = new ProjectRegistry(mkdtempSync(join(tmpdir(), "bg-viz-")));
const repo = "/private/tmp/viz";
const project = registry.register({ projectId: "viz", name: "Viz", repositories: [repo] } as never);
const work = join(project.storageDir, "worktrees", "probe");
mkdirSync(work, { recursive: true });

const plan = planCodexVisualInvocation({
  snapshot: codex,
  model: { providerId: "openai", modelId: "gpt-6-astra", quotaPool: "chatgpt-subscription" },
  cwd: work,
  payload: { schemaVersion: 1, role: "visual", task: "a simple flat blue circle centred on a white background, PNG", context: {} },
  codexIsolation: attestation,
});
console.log("args:", plan.args.join(" ").slice(0, 400));
const result = await new NodeShadowProcessExecutor().run({ project, plan, timeoutMs: 180_000 });
console.log("exit:", result.exitCode, "timedOut:", result.timedOut, "ms:", result.durationMs);
try { console.log("AGENT MESSAGE:\n", extractCodexAgentMessage(result.stdout)); }
catch (e) { console.log("no agent message:", (e as Error).message); console.log(result.stdout.slice(0, 1500)); }
if (result.stderr.trim()) console.log("stderr:", result.stderr.slice(0, 600));
