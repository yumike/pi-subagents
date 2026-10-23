import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx, makePi } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

const request: WorkflowSpawnRequest = {
  agentId: "wf-agent-0",
  index: 0,
  prompt: "inspect the files",
  label: "inspect",
  agentType: "specialist",
};

describe("workflow agent-file isolated precedence", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as unknown as AgentSession,
      aborted: false,
      steered: false,
    });
    registerAgents(new Map());
    manager = new AgentManager();
  });

  afterEach(async () => {
    await manager.dispose();
    registerAgents(new Map());
  });

  it.each([true, false, undefined])("forwards isolated=%s without defaulting an unset field", async (isolated) => {
    registerAgents(new Map([["specialist", {
      ...DEFAULT_AGENTS.get("Explore")!,
      name: "specialist",
      ...(isolated !== undefined ? { isolated } : {}),
    }]]));
    const { pi } = makePi();
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager, workflowId: "wf-isolated" });

    const result = await host.spawnAgent(request);

    expect(result.ok).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent).mock.calls[0]![3]?.isolated).toBe(isolated);
  });
});
