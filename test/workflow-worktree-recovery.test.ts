import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { runWorkflow, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { cleanupWorktree, createWorktree, type WorktreeInfo } from "../src/worktree.js";
import { ctx } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

const worktree: WorktreeInfo = {
  path: "/wt/recover",
  workPath: "/wt/recover",
  branch: "pi-agent-recover",
  baseSha: "abc",
};
const session = { dispose: vi.fn() } as unknown as AgentSession;
const request: WorkflowSpawnRequest = {
  agentId: "wf-agent-0",
  index: 0,
  prompt: "private task prompt",
  label: "impl",
  agentType: "general-purpose",
  isolation: "worktree",
};

const outcome = {
  responseText: "private task output",
  session,
  aborted: false,
  steered: false,
  structuredJson: '{"answer":42}',
};

describe("workflow worktree recovery diagnostics", () => {
  let manager: AgentManager;
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const pi = { sendMessage } as unknown as ExtensionAPI;
  const host = () => createWorkflowHost({ pi, ctx: ctx(), manager, workflowId: "wf-recovery" });

  beforeEach(() => {
    vi.resetAllMocks();
    registerAgents(new Map());
    manager = new AgentManager();
    vi.mocked(createWorktree).mockResolvedValue({ ...worktree });
    vi.mocked(cleanupWorktree).mockResolvedValue({
      hasChanges: null,
      path: worktree.path,
      error: "git status failed",
    });
    vi.mocked(runAgent).mockResolvedValue(outcome);
  });

  afterEach(async () => { await manager.dispose(); });

  function expectRecovery(): void {
    expect(sendMessage).toHaveBeenCalledOnce();
    const [message, options] = sendMessage.mock.calls[0];
    expect(message.customType).toBe("subagent-worktree-recovery");
    expect(message.display).toBe(true);
    expect(message.content).toContain("Worktree cleanup failed: git status failed");
    expect(message.content).toContain("Worktree retained at `/wt/recover`");
    expect(message.content).toContain("Inspect and recover");
    expect(JSON.stringify(message)).not.toContain("private task");
    expect(options).toEqual({ deliverAs: "followUp", triggerTurn: false });
  }

  it("keeps the structured workflow result intact while sending parent-visible recovery context", async () => {
    const result = await runWorkflow({
      script: `export const meta = { name: "recovery", description: "structured recovery" };
        return await agent("private task prompt", {
          isolation: "worktree",
          schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] }
        });`,
      host: host(),
    });

    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ answer: 42 });
    expect(manager.listAgents()[0].status).toBe("completed");
    expect(manager.listAgents()[0].structuredJson).toBe(outcome.structuredJson);
    expectRecovery();
  });

  it.each(["stopped", "aborted"] as const)("reports recovery without changing a %s child's outcome", async status => {
    vi.mocked(runAgent).mockImplementationOnce(async () => {
      if (status === "stopped") manager.abort(manager.listAgents()[0].id);
      return { ...outcome, aborted: status === "aborted" };
    });

    const result = await host().spawnAgent(request);

    expect(result).toEqual({
      ok: false,
      ...(status === "stopped" ? { skipped: true } : {}),
      error: status === "stopped" ? "Stopped." : "Agent aborted.",
    });
    expect(manager.listAgents()[0].status).toBe(status);
    expectRecovery();
  });

  it("reports a cleanup failure after a stop during creation, before the child ever runs", async () => {
    vi.mocked(createWorktree).mockImplementationOnce(async () => {
      manager.abort(manager.listAgents()[0].id);
      return { ...worktree };
    });

    expect(await host().spawnAgent(request)).toEqual({ ok: false, skipped: true, error: "Stopped." });
    expect(runAgent).not.toHaveBeenCalled();
    expectRecovery();
  });

  it.each([false, true])("does not send a recovery diagnostic after successful cleanup (changes: %s)", async hasChanges => {
    vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges, ...(hasChanges ? { branch: worktree.branch } : {}) });

    const result = await host().spawnAgent(request);

    expect(result).toEqual({ ok: true, text: outcome.structuredJson });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not repeat an old cleanup diagnostic when the child is resumed", async () => {
    const workflowHost = host();
    await workflowHost.spawnAgent(request);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "continued", aborted: false, steered: false });

    expect((await workflowHost.resumeAgent!(request.agentId, "continue")).ok).toBe(true);

    expect(cleanupWorktree).toHaveBeenCalledOnce();
    expectRecovery();
  });

  it("does not turn a diagnostic-delivery failure into a task failure", async () => {
    sendMessage.mockImplementationOnce(() => { throw new Error("notification unavailable"); });

    expect(await host().spawnAgent(request)).toEqual({ ok: true, text: outcome.structuredJson });
    expect(manager.listAgents()[0].status).toBe("completed");
  });
});
