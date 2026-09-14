import {
  BrainGateInvariantError,
  DEFAULT_MANIFEST,
  ProjectRegistry,
  executionScopeFor,
  requireAttached,
  resolveAttachment,
  type ExecutionScope,
  type RegisteredProject,
} from "@braingate/core";

/**
 * The project this process is attached to, and the workspace its execution state belongs to.
 *
 * One function for every command, because "which project is this, and is it the one I am standing
 * in" has one right answer and had three copies. Each copy compared the registration against
 * `git rev-parse --show-toplevel`, which is not the directory the operator selected: `braingate`
 * launched inside `repo/flutter_migration` refused, because the registered path was never going to
 * equal the repository root that Git reported.
 *
 * Identity is the selected directory, canonicalized, and it is the workspace native workers run in.
 * Git is metadata a workspace may have. A registration naming a *parent* of this directory is
 * accepted — the operator may have registered the repository and then descended into it — and the
 * workspace stays the directory they are in.
 *
 * Two handles come back, and the difference between them is the whole of M20.4:
 *
 * - `project` owns durable knowledge: memory, preferences, the registry. It outlives every workspace.
 * - `scope` owns execution truth: the ledger, goals and conversations, the corpus, results,
 *   snapshots and worktrees of *this* workspace, at `scope.storageDir`.
 *
 * A command that ran a worker in workspace A and filed its receipt under workspace B is the defect
 * this shape makes unrepresentable: the stores that write execution state take `scope.project`, and
 * only the memory surfaces take `project`.
 */
export interface AttachedProject {
  /** Project-level: durable knowledge, valid across every workspace. */
  readonly project: RegisteredProject;
  /** This workspace's execution state, and the directory workers run in. */
  readonly scope: ExecutionScope;
}

export function attachFromManifest(state: { readonly home: string }, manifest: string, cwd: string): AttachedProject {
  // `--project <path>` names a project from wherever the operator is; the default names wherever they
  // are. Only the second can be a copied registration, so only the second is refused when it
  // disagrees. Reading another workspace's record is what the explicit form is for, and in that case
  // the workspace is the one the registration names rather than the directory being inspected from.
  const attachment = resolveAttachment({
    cwd,
    registry: new ProjectRegistry(state.home),
    manifest,
    namedByOperator: manifest !== DEFAULT_MANIFEST,
  });
  // A missing manifest is the ordinary "you are not in a registered project" case, especially now
  // that `braingate` is on PATH and gets run from anywhere. Without this it reaches the catch-all
  // and prints CLI_UNEXPECTED with details suppressed, which says nothing about what to do next.
  // The message names the relative path only, never the resolved one.
  if (attachment.kind === "unregistered") {
    throw new BrainGateInvariantError(
      "CLI_PROJECT_NOT_FOUND",
      `No BrainGate project found here (looked for ${manifest} in this directory or above it). Run \`braingate init --project-id <id> --name <name>\` in the directory you want as the workspace, or pass --project <manifest>.`,
    );
  }
  // The refusal message is the one core already wrote: it names both directories and both remedies,
  // so every surface reports the same two paths and the same way forward.
  const project = requireAttached(attachment);
  /**
   * The workspace is the directory the *manifest* names, not the one the shell happens to be in.
   *
   * Those differ whenever the operator launches from below the workspace — `repo/src`,
   * `repo/packages/api` — and the difference decides where execution state is filed. Taking the
   * current directory would mint a second workspace for every subdirectory of a project and show an
   * empty ledger to an operator whose tasks are one directory up; taking the registration means a
   * project has the workspaces it was registered with, and nothing else.
   *
   * A directory that was *itself* registered — `braingate init` inside `repo/flutter_migration` —
   * is named by its own manifest, so it is still its own workspace with its own storage. And the
   * directory they launched from is still where workers run: the provider's `cwd` is never widened
   * to the workspace, only the state is filed there.
   */
  // `null` only for the "names no repository" refusal, which `requireAttached` has already thrown on.
  const workspacePath = attachment.registeredRoot ?? attachment.checkout.root;
  return Object.freeze({ project, scope: executionScopeFor(project, workspacePath) });
}
