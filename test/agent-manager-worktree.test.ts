import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { cleanupWorktree, createWorktree, type WorktreeCleanupResult, type WorktreeInfo } from "../src/worktree.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp" } as ExtensionContext;
const session = { dispose: vi.fn() } as unknown as AgentSession;
const worktree: WorktreeInfo = {
  path: "/wt/recover",
  workPath: "/wt/recover",
  branch: "pi-agent-recover",
  baseSha: "abc",
};

function expectRecovery(text: string | undefined): void {
  expect(text).toContain("Worktree cleanup failed: git failed");
  expect(text).toContain("Worktree retained at `/wt/recover`");
  expect(text).toContain("Inspect and recover the work there before removing it");
  expect(text).not.toContain("Changes saved to branch");
  expect(text).not.toContain("git merge");
  expect(text).not.toContain("no changes");
}

describe("AgentManager — retained worktree recovery", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createWorktree).mockResolvedValue(worktree);
    vi.mocked(cleanupWorktree).mockResolvedValue({
      hasChanges: true,
      path: worktree.path,
      error: "git failed",
    });
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "task complete",
      session,
      aborted: false,
      steered: false,
      structuredJson: '{"answer":42}',
    });
  });

  afterEach(async () => {
    await manager?.dispose();
  });

  it.each([true, null, false])("exposes completed-task recovery with hasChanges=%s without failing the task", async (hasChanges) => {
    const cleanup: WorktreeCleanupResult = {
      hasChanges,
      path: worktree.path,
      branch: "saved-before-failure",
      error: "git failed",
    };
    vi.mocked(cleanupWorktree).mockResolvedValue(cleanup);
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const id = manager.spawn(pi, ctx, "general-purpose", "task", {
      description: "task", isolation: "worktree", isBackground: true,
    });
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("completed");
    expect(record.error).toBeUndefined();
    expect(record.result).toContain("task complete");
    expectRecovery(record.result);
    expect(record.result).toContain("Branch: `saved-before-failure`");
    expect(record.worktreeResult).toEqual(cleanup);
    expect(record.structuredJson).toBe('{"answer":42}');
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0][0].result).toBe(record.result);
    expect(record.resultConsumed).toBeFalsy();
  });

  it("keeps the agent rejection and exposes recovery in both error and result", async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error("agent rejected"));
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", "task", {
      description: "task", isolation: "worktree",
    });

    expect(record.status).toBe("error");
    expect(record.error).toContain("agent rejected");
    expectRecovery(record.error);
    expectRecovery(record.result);
    expect(record.worktreeResult).toEqual({ hasChanges: true, path: worktree.path, error: "git failed" });
    expect(onComplete).toHaveBeenCalledWith(record);
    expect(record.resultConsumed).toBe(true);
    expect(cleanupWorktree).toHaveBeenCalledOnce();
  });

  it("keeps a resolved provider failure distinct from cleanup failure", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "partial work",
      session,
      aborted: false,
      steered: false,
      failure: "provider failed",
    });
    manager = new AgentManager();
    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", "task", {
      description: "task", isolation: "worktree",
    });

    expect(record.status).toBe("error");
    expect(record.error).toContain("provider failed");
    expectRecovery(record.error);
    expect(record.result).toContain("partial work");
    expectRecovery(record.result);
  });

  it.each([true, false])("reports recovery after a stop during worktree creation (background: %s)", async (isBackground) => {
    let finishCopy!: (value: WorktreeInfo) => void;
    vi.mocked(createWorktree).mockImplementationOnce(() => new Promise(resolve => { finishCopy = resolve; }));
    vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: null, path: worktree.path, error: "git failed" });
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const id = manager.spawn(pi, ctx, "general-purpose", "task", {
      description: "task", isolation: "worktree", isBackground,
    });
    expect(manager.abort(id)).toBe(true);
    finishCopy(worktree);
    await manager.awaitStartup(id);
    const record = manager.getRecord(id)!;

    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
    expectRecovery(record.result);
    expect(record.worktreeResult?.hasChanges).toBeNull();
    expect(runAgent).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(record);
    expect(Boolean(record.resultConsumed)).toBe(!isBackground);
  });

  it("leaves successful branch reporting unchanged", async () => {
    vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: worktree.branch });
    manager = new AgentManager();
    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", "task", {
      description: "task", isolation: "worktree",
    });

    expect(record.status).toBe("completed");
    expect(record.result).toContain("Changes saved to branch `pi-agent-recover`");
    expect(record.result).not.toContain("Worktree cleanup failed");
    expect(record.error).toBeUndefined();
  });
});
