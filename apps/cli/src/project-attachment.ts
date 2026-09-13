import { BrainGateInvariantError, DEFAULT_MANIFEST, ProjectRegistry, requireAttached, resolveAttachment, type RegisteredProject } from "@braingate/core";

/**
 * The project this process is attached to, and the workspace it will execute in.
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
 * A registration naming anything else is refused, in every command, rather than executed against.
 */
export function projectFromManifest(state: { readonly home: string }, manifest: string, cwd: string): RegisteredProject {
  // `--project <path>` names a project from wherever the operator is; the default names wherever they
  // are. Only the second can be a copied registration, so only the second is refused when it
  // disagrees. Reading another workspace's ledger is what the explicit form is for, and no execution
  // path treats the current directory as the workspace in that case.
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
  return requireAttached(attachment);
}
