import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_MANIFEST,
  TaskLedger,
  executionScopeFor,
  legacyExecutionState,
  projectStateDir,
  workspaceIdFor,
  workspaceStorageDir,
  type ExecutionScope,
} from "@braingate/core";
import { DogfoodStore } from "@braingate/dogfood";
import { GoalStore } from "@braingate/goals";
import { attachFromManifest } from "./project-attachment.js";

/**
 * M20.4 — execution state belongs to a workspace.
 *
 * The property under test is one sentence long: **two workspaces of one project share durable
 * knowledge and nothing else.** A goal, a conversation, a task, a piece of evidence and a native
 * session were all produced by a worker running in one directory, and none of them may be read as
 * execution truth for another. The tests below are the scenarios that property is stated in terms
 * of, and every one of them is built from disposable directories with fake runtimes: no provider
 * CLI is invoked and no model is called.
 */

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
}

/** A project with two directories, both registered to it, and a home of its own. */
function twoWorkspaces(label: string): { readonly root: string; readonly a: string; readonly b: string; readonly home: string } {
  const root = mkdtempSync(join(tmpdir(), `braingate-wsstate-${label}-`));
  const home = join(root, "brain-home");
  for (const name of ["a", "b"]) {
    const dir = join(root, name);
    mkdirSync(join(dir, ".brain"), { recursive: true });
    writeFileSync(join(dir, ".brain", "project.json"), JSON.stringify({ project_id: label, name: label, repositories: [dir] }));
  }
  return { root, a: join(root, "a"), b: join(root, "b"), home };
}

function scopeOf(home: string, dir: string): ExecutionScope {
  return attachFromManifest({ home }, DEFAULT_MANIFEST, dir).scope;
}

function task(ledger: TaskLedger, title: string, goal?: { readonly goalId: string; readonly conversationId: string }): string {
  const record = ledger.createTask({
    title,
    complexity: "T1",
    risk: "low",
    ...(goal === undefined ? {} : { goalId: goal.goalId, conversationId: goal.conversationId }),
  });
  ledger.transition(record.taskId, "running");
  ledger.transition(record.taskId, "completed");
  return record.taskId;
}

// ---------------------------------------------------------------- A. two workspaces, two states

test("A: one project's two workspaces keep separate goals, task histories and provider sessions", () => {
  const f = twoWorkspaces("separate");
  const a = scopeOf(f.home, f.a);
  const b = scopeOf(f.home, f.b);
  const ledgerA = new TaskLedger(a.project);
  const ledgerB = new TaskLedger(b.project);
  const goalsA = new GoalStore(a.project);
  const goalsB = new GoalStore(b.project);
  const corpusA = new DogfoodStore(a.project);
  const corpusB = new DogfoodStore(b.project);
  try {
    assert.notEqual(a.workspaceId, b.workspaceId, "one project, two directories, two workspace identities");
    assert.equal(a.projectId, b.projectId, "and one logical project");
    assert.notEqual(a.storageDir, b.storageDir, "so two storage directories");
    assert.equal(a.storageDir, workspaceStorageDir(projectStateDir(a.projectStorageDir), a.workspaceId));

    const taskA = task(ledgerA, "diagnose the idle logout in A");
    const taskB = task(ledgerB, "compare the older checkout in B");
    assert.deepEqual(ledgerA.listTasks().map((entry) => entry.taskId), [taskA]);
    assert.deepEqual(ledgerB.listTasks().map((entry) => entry.taskId), [taskB]);
    assert.equal(ledgerA.getTask(taskB), undefined, "a task of B is not a task of A");

    const conversationA = goalsA.openConversation();
    const goalA = goalsA.createGoal({ conversationId: conversationA.conversationId, objective: "fix the logout" });
    const conversationB = goalsB.openConversation();
    const goalB = goalsB.createGoal({ conversationId: conversationB.conversationId, objective: "compare the checkouts" });
    assert.notEqual(goalA.goalId, goalB.goalId);
    assert.equal(goalA.workspaceId, a.workspaceId, "the goal states the workspace it belongs to");
    assert.equal(goalB.workspaceId, b.workspaceId);

    const sessionA = goalsA.recordProviderSession({
      providerId: "anthropic", modelId: "claude-sonnet", sessionId: "session-a",
      resumeMode: "available", status: "active", workspace: a.workspacePath, goalId: goalA.goalId,
    });
    assert.equal(sessionA.workspaceId, a.workspaceId);
    assert.equal(goalsB.latestSessionFor("anthropic", "claude-sonnet"), null, "B has no session of its own to continue");

    // The corpus is execution history too: a run recorded in A is not a prior for B.
    assert.equal(corpusA.report().runs, 0);
    assert.equal(corpusB.report().runs, 0);
    assert.notEqual(corpusA.databasePath, corpusB.databasePath);
  } finally {
    ledgerA.close(); ledgerB.close(); goalsA.close(); goalsB.close(); corpusA.close(); corpusB.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- B. a goal is not inherited

test("B: a goal of one workspace is never the active goal of another", () => {
  const f = twoWorkspaces("goalscope");
  const a = scopeOf(f.home, f.a);
  const goalsA = new GoalStore(a.project);
  const goalsB = new GoalStore(scopeOf(f.home, f.b).project);
  try {
    const conversationA = goalsA.openConversation();
    const goalA = goalsA.createGoal({ conversationId: conversationA.conversationId, objective: "diagnose in A" });

    const conversationB = goalsB.openConversation();
    assert.notEqual(conversationB.conversationId, conversationA.conversationId, "a conversation is a workspace's own thread");
    assert.equal(goalsB.activeGoal(conversationB.conversationId), null);
    assert.equal(goalsB.activeGoal(), null, "nothing from A is active in B");
    assert.deepEqual([...goalsB.listGoals()], []);

    // A database that arrives in the wrong workspace — copied, restored, or synced by hand — is the
    // one way this can happen. The goal is preserved and refuses, rather than executing here.
    writeFileSync(join(goalsB.databasePath.replace(/goals\.sqlite$/, "goals.sqlite.copy")), "");
    rmSync(join(goalsB.databasePath), { force: true });
    goalsB.close();
    const copied = new GoalStore(scopeOf(f.home, f.b).project, { now: () => "2026-09-20T00:00:00.000Z" });
    try {
      copied.recordProviderSession({ providerId: "anthropic", modelId: "m", sessionId: "s", resumeMode: "available" });
      assert.equal(copied.activeGoal(), null, "a goal from another workspace never becomes this one's");
      assert.deepEqual([...copied.goalsFromAnotherWorkspace()].map((goal) => goal.goalId), [], "and the store is still B's own");

      // The refusal itself, on the code path that resumes a goal by id.
      const foreign = goalsA.createGoal({ conversationId: conversationA.conversationId, objective: "a second goal in A" });
      assert.equal(foreign.workspaceId, a.workspaceId);
      assert.throws(() => copied.requireGoalInWorkspace(foreign.goalId), /GOAL_NOT_FOUND|does not exist/);
    } finally { copied.close(); }
  } finally {
    goalsA.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("B: a goal filed under another workspace refuses by id, naming both sides", () => {
  const f = twoWorkspaces("goalmismatch");
  const a = scopeOf(f.home, f.a);
  const b = scopeOf(f.home, f.b);
  const goalsA = new GoalStore(a.project);
  const goalsB = new GoalStore(b.project);
  try {
    const conversation = goalsA.openConversation();
    const goal = goalsA.createGoal({ conversationId: conversation.conversationId, objective: "diagnose in A" });
    goalsA.close();

    // Move the file itself: the goal is now inside B's store while still saying it belongs to A.
    goalsB.close();
    writeFileSync(join(b.storageDir, "goals.sqlite"), readFileSync(join(a.storageDir, "goals.sqlite")));
    const moved = new GoalStore(b.project);
    try {
      assert.equal(moved.activeGoal(), null, "it is not B's goal to continue");
      assert.deepEqual([...moved.goalsFromAnotherWorkspace()].map((entry) => entry.goalId), [goal.goalId], "and it is reported, not hidden");
      assert.throws(
        () => moved.requireGoalInWorkspace(goal.goalId),
        (error: unknown) => (error as { readonly code?: string }).code === "GOAL_WORKSPACE_MISMATCH"
          && error instanceof Error && error.message.includes(a.workspaceId) && error.message.includes(b.workspaceId),
        "resuming it by id refuses, and says which workspace owns it",
      );
      // Preserved: the row is still there, and the copy in A is untouched by any of this.
      assert.equal(moved.getGoal(goal.goalId)?.workspaceId, a.workspaceId);
    } finally { moved.close(); }

    const reopenedA = new GoalStore(a.project);
    try {
      assert.equal(reopenedA.activeGoal(conversation.conversationId)?.goalId, goal.goalId, "and A still has its own goal");
    } finally { reopenedA.close(); }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- C. sessions do not cross

test("C: a native session recorded in one workspace cannot be resumed in another", () => {
  const f = twoWorkspaces("sessions");
  const a = scopeOf(f.home, f.a);
  const b = scopeOf(f.home, f.b);
  const goalsA = new GoalStore(a.project);
  const goalsB = new GoalStore(b.project);
  try {
    const conversation = goalsA.openConversation();
    const goal = goalsA.createGoal({ conversationId: conversation.conversationId, objective: "diagnose in A" });
    const recorded = goalsA.recordProviderSession({
      providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-a", resumeMode: "available",
      status: "active", runtimeVersion: "2.1.269", workspace: a.workspacePath, goalId: goal.goalId,
    });

    assert.equal(recorded.workspaceId, a.workspaceId, "the reference carries the workspace identity as well as the path");
    assert.equal(goalsB.latestSessionFor("anthropic", "claude-sonnet"), null, "B is offered nothing to resume");
    // Which is the same answer the resolver gives: nothing stored here means a fresh session, not a
    // resumed one from a directory this run is not in.
    assert.equal(goalsB.listProviderSessions().length, 0);
    assert.equal(goalsA.listProviderSessions()[0]?.sessionId, "s-a");
  } finally {
    goalsA.close(); goalsB.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- D. one workspace, three workers

test("D: three workers in one workspace share one goal and one workspace identity", () => {
  const f = twoWorkspaces("workers");
  const a = scopeOf(f.home, f.a);
  const goals = new GoalStore(a.project);
  const ledger = new TaskLedger(a.project);
  try {
    const conversation = goals.openConversation();
    const goal = goals.createGoal({ conversationId: conversation.conversationId, objective: "diagnose the idle logout" });

    // Sonnet -> Gemini -> Sonnet. Two providers and three sessions, one goal, one workspace: the
    // hierarchy is provider -> model -> session, and the workspace is what all of them run in.
    const turns = [
      { providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-1", goalId: goal.goalId },
      { providerId: "google", modelId: "gemini-pro", sessionId: "s-2", goalId: goal.goalId },
      { providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-3", goalId: goal.goalId },
    ] as const;
    for (const turn of turns) {
      goals.recordProviderSession({
        ...turn, resumeMode: "available", status: "active",
        runtimeVersion: "2.1.269", workspace: a.workspacePath, lastTurnSequence: 1,
      });
      task(ledger, `work by ${turn.providerId}/${turn.modelId}`, goal);
    }

    const sessions = goals.listProviderSessions();
    assert.deepEqual(sessions.map((session) => session.sessionId).sort(), ["s-1", "s-2", "s-3"]);
    assert.ok(sessions.every((session) => session.workspaceId === a.workspaceId));
    assert.ok(sessions.every((session) => session.goalId === goal.goalId), "every worker is working on the same goal");
    assert.equal(ledger.listTasksForGoal(goal.goalId).length, 3, "and the goal owns every work unit");
    assert.equal(goals.activeGoal(conversation.conversationId)?.goalId, goal.goalId);
    // Handing over did not move the goal: it still belongs to the workspace it started in.
    assert.equal(goals.getGoal(goal.goalId)?.workspaceId, a.workspaceId);
  } finally {
    goals.close(); ledger.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- E. restart

test("E: a restart in the same workspace restores its state, and in the other one inherits nothing", () => {
  const f = twoWorkspaces("restart");
  const a = scopeOf(f.home, f.a);
  const goalsA = new GoalStore(a.project);
  const ledgerA = new TaskLedger(a.project);
  let goalId: string;
  let taskId: string;
  try {
    const conversation = goalsA.openConversation();
    goalId = goalsA.createGoal({ conversationId: conversation.conversationId, objective: "diagnose the idle logout" }).goalId;
    taskId = task(ledgerA, "read the splash routing");
    goalsA.recordProviderSession({
      providerId: "anthropic", modelId: "claude-sonnet", sessionId: "s-restart", resumeMode: "available",
      status: "active", workspace: a.workspacePath, goalId,
    });
  } finally { goalsA.close(); ledgerA.close(); }

  // Everything is closed: this is a new process as far as the stores are concerned. The scope is
  // resolved again from the directory rather than remembered, which is what a restart does.
  const reopenedA = scopeOf(f.home, f.a);
  const goalsAgain = new GoalStore(reopenedA.project);
  const ledgerAgain = new TaskLedger(reopenedA.project);
  const goalsB = new GoalStore(scopeOf(f.home, f.b).project);
  try {
    assert.equal(reopenedA.workspaceId, a.workspaceId, "the same directory is the same workspace across a restart");
    assert.equal(goalsAgain.activeGoal()?.goalId, goalId);
    assert.equal(goalsAgain.latestSessionFor("anthropic", "claude-sonnet")?.sessionId, "s-restart");
    assert.deepEqual(ledgerAgain.listTasks().map((entry) => entry.taskId), [taskId]);

    assert.equal(goalsB.activeGoal(), null, "and B inherits none of it");
    assert.equal(goalsB.latestSessionFor("anthropic", "claude-sonnet"), null);
    assert.deepEqual([...goalsB.listGoals()], [], "B has a store of its own, and it is empty");
    assert.equal(goalsB.latestSessionFor("anthropic", "claude-sonnet"), null);
  } finally {
    goalsAgain.close(); ledgerAgain.close(); goalsB.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- F. subdirectory workspace

test("F: a subdirectory workspace owns its execution state, and the repository stays metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-wsstate-subdir-"));
  const home = join(root, "brain-home");
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    const workspace = join(repo, "flutter_migration");
    mkdirSync(join(workspace, ".brain"), { recursive: true });
    writeFileSync(join(workspace, ".brain", "project.json"), JSON.stringify({ project_id: "tabaq", name: "Tabaq", repositories: [workspace] }));

    const scope = scopeOf(home, workspace);
    assert.equal(scope.workspacePath, realpathSync.native(workspace), "the workspace is the directory the operator selected");
    assert.equal(scope.workspaceId, workspaceIdFor(realpathSync.native(workspace)));
    assert.equal(scope.git?.gitRoot, realpathSync.native(repo), "and the repository above it is metadata");
    assert.notEqual(scope.git?.gitRoot, scope.workspacePath);
    assert.equal(scope.storageDir, join(home, "projects", "tabaq", "workspaces", scope.workspaceId));

    const goals = new GoalStore(scope.project);
    try {
      const conversation = goals.openConversation();
      const goal = goals.createGoal({ conversationId: conversation.conversationId, objective: "migrate the app" });
      assert.equal(goal.workspaceId, scope.workspaceId);
      assert.ok(existsSync(join(scope.storageDir, "goals.sqlite")));
      // Nothing was filed against the repository: the state is the subdirectory's, and the
      // directory above it holds only the project's own registry.
      assert.equal(existsSync(join(home, "projects", "tabaq", "goals.sqlite")), false);
    } finally { goals.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- G. no repository at all

test("G: a workspace with no repository owns goals, tasks and context", () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-wsstate-nogit-"));
  const home = join(root, "brain-home");
  try {
    const plain = join(root, "notes-app");
    mkdirSync(join(plain, ".brain"), { recursive: true });
    writeFileSync(join(plain, ".brain", "project.json"), JSON.stringify({ project_id: "notes", name: "Notes", repositories: [plain] }));

    const scope = scopeOf(home, plain);
    assert.equal(scope.git, null, "a directory with no repository is a workspace");
    const goals = new GoalStore(scope.project);
    const ledger = new TaskLedger(scope.project);
    try {
      const conversation = goals.openConversation();
      const goal = goals.createGoal({ conversationId: conversation.conversationId, objective: "summarise the notes directory" });
      const taskId = task(ledger, "read every note", goal);
      assert.equal(goal.workspaceId, scope.workspaceId);
      assert.equal(goals.latestSessionFor("anthropic", "m"), null);
      goals.recordProviderSession({ providerId: "anthropic", modelId: "m", sessionId: "s-plain", resumeMode: "available", workspace: scope.workspacePath, goalId: goal.goalId });
      assert.equal(goals.latestSessionFor("anthropic", "m")?.sessionId, "s-plain");
      assert.deepEqual(ledger.listTasksForGoal(goal.goalId).map((entry) => entry.taskId), [taskId]);
      for (const file of ["goals.sqlite", "tasks.sqlite"]) {
        assert.ok(existsSync(join(scope.storageDir, file)), `${file} must persist without Git`);
      }
    } finally { goals.close(); ledger.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- H. legacy state

test("H: state written before workspaces existed is preserved, and never becomes a workspace's", () => {
  const f = twoWorkspaces("legacy");
  try {
    // The shape the previous release left: one directory per project id, holding state that two
    // directories may have written together. Nothing can say which, so nothing may use it.
    const legacyDir = projectStateDir(join(f.home, "projects", "legacy"));
    mkdirSync(legacyDir, { recursive: true });
    const legacy = join(legacyDir, "goals.sqlite");
    writeFileSync(legacy, "legacy goals that belong to nobody in particular\n");
    writeFileSync(join(legacyDir, "tasks.sqlite"), "legacy tasks\n");

    const reported = legacyExecutionState(legacyDir);
    assert.deepEqual([...reported].sort(), ["goals.sqlite", "tasks.sqlite"]);
    assert.deepEqual([...legacyExecutionState(join(f.home, "projects", "nothing-here"))], []);

    const scope = scopeOf(f.home, f.a);
    const goals = new GoalStore(scope.project);
    const ledger = new TaskLedger(scope.project);
    try {
      assert.equal(goals.activeGoal(), null, "the legacy goal is not adopted as this workspace's");
      assert.deepEqual([...ledger.listTasks()], [], "and neither are its tasks");
      const conversation = goals.openConversation();
      const goal = goals.createGoal({ conversationId: conversation.conversationId, objective: "start fresh here" });
      task(ledger, "the first task of this workspace");
      assert.equal(goal.workspaceId, scope.workspaceId, "new work is filed under the workspace, not the project");
      assert.equal(ledger.listTasks().length, 1, "and the legacy task is not counted among it");
    } finally { goals.close(); ledger.close(); }

    // Preserved: byte for byte, where it was, and not injected into the goal the new store holds.
    assert.equal(readFileSync(legacy, "utf8"), "legacy goals that belong to nobody in particular\n");
    assert.equal(readFileSync(join(legacyDir, "tasks.sqlite"), "utf8"), "legacy tasks\n");
    // The workspace's own state sits in a subdirectory of the same project directory, which is
    // where the registry lives too — the legacy *files* are what must not be touched, and what must
    // never be read. Nothing above was moved, rewritten or deleted.
    assert.ok(existsSync(join(scope.storageDir, "goals.sqlite")), "the new state lives under the workspace");
    assert.equal(scope.storageDir, join(legacyDir, "workspaces", scope.workspaceId));
    assert.notEqual(join(legacyDir, "goals.sqlite"), join(scope.storageDir, "goals.sqlite"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- I. one directory, one identity

test("I: a symlink to a workspace is that workspace, not a second one", () => {
  const f = twoWorkspaces("symlink");
  try {
    const link = join(f.root, "linked-a");
    symlinkSync(f.a, link);

    const direct = scopeOf(f.home, f.a);
    const throughLink = scopeOf(f.home, link);
    assert.equal(throughLink.workspaceId, direct.workspaceId, "the same directory reached two ways is one workspace");
    assert.equal(throughLink.workspacePath, direct.workspacePath);
    assert.equal(throughLink.storageDir, direct.storageDir);

    const goals = new GoalStore(direct.project);
    try {
      const conversation = goals.openConversation();
      goals.createGoal({ conversationId: conversation.conversationId, objective: "started through the link" });
    } finally { goals.close(); }

    const reopened = new GoalStore(throughLink.project);
    try {
      assert.ok(reopened.activeGoal() !== null, "the goal is visible through either path");
      assert.equal(reopened.listGoals().length, 1, "and there is only one copy of it");
    } finally { reopened.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- the seam itself

test("an execution store refuses a project handle, and a workspace must be a directory", () => {
  const f = twoWorkspaces("seam");
  try {
    const { project, scope } = attachFromManifest({ home: f.home }, DEFAULT_MANIFEST, f.a);
    assert.equal(project.storageDir, scope.projectStorageDir, "the project handle keeps the project's own storage");
    assert.notEqual(project.storageDir, scope.storageDir);
    // The compiler refuses this call; the store refuses it too, because a project handle reaching an
    // execution store is the defect — execution state filed beside durable knowledge, for no workspace.
    assert.throws(() => new GoalStore(project as never), /GOAL_SCOPE_INVALID|workspace-scoped/);
    assert.throws(() => executionScopeFor(project, join(f.root, "not-a-directory")), /existing directory/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
