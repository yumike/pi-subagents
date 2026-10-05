/** Real-session regression: the invisible mention turn sees only Agent and the parent's live context. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type ExtensionContext, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMentionClone } from "../../src/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

describe("mention clone tool reachability against real pi-mono", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-mention-clone-"));
    writeFileSync(join(cwd, "AGENTS.md"), "Discovered context must not duplicate live instructions");
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  // Omitting history, seeding all entries, changing the prompt, hiding Agent, or
  // forwarding the clone's attribution instead of the parent's must break this turn.
  it("starts Agent with the live prompt and active history", async () => {
    const parent = SessionManager.inMemory(cwd);
    parent.appendMessage({ role: "user", content: "OBSOLETE-CONTENT", timestamp: 1 });
    const retained = parent.appendMessage({ role: "user", content: "KEPT-AFTER-COMPACTION", timestamp: 2 });
    parent.appendCompaction("COMPACTION-SUMMARY", retained, 1000);
    const branchPoint = parent.getLeafId()!;
    parent.appendMessage({ role: "user", content: "ABANDONED-CONTENT", timestamp: 3 });
    parent.branchWithSummary(branchPoint, "BRANCH-SUMMARY");
    // Valid persistable data that structuredClone cannot copy.
    parent.appendCustomEntry("mention-test", { toJSON() { return { marker: "CUSTOM" }; } });
    const active = parent.appendMessage({ role: "user", content: "RETAINED-ACTIVE-CONTENT", timestamp: 4 });
    parent.appendMessage({ role: "user", content: "AFTER-ACTIVE-LEAF", timestamp: 5 });
    parent.branch(active);
    const originalLeaf = parent.getLeafId();
    // Snapshot persisted data, which legitimately includes objects with toJSON methods.
    const snapshot = JSON.stringify({ header: parent.getHeader(), entries: parent.getEntries() });
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const ctx = {
      cwd,
      model,
      thinkingLevel: "high",
      getSystemPrompt: () => "Live parent instructions",
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: parent,
    } as unknown as ExtensionContext;
    const requests: Context[] = [];
    faux.setResponses([
      request => {
        requests.push({ ...request, messages: structuredClone(request.messages) });
        return fauxAssistantMessage(fauxToolCall("Agent", { prompt: "go" }));
      },
      fauxAssistantMessage("started"),
    ]);
    const executions: ExtensionContext[] = [];
    const agentTool: ToolDefinition = {
      name: "Agent",
      label: "Agent",
      description: "Start an agent",
      parameters: Type.Object({ prompt: Type.String(), run_in_background: Type.Optional(Type.Boolean()) }),
      execute: async (_id, _params, _signal, _onUpdate, toolCtx) => {
        executions.push(toolCtx);
        return { content: [{ type: "text", text: "started" }], details: undefined };
      },
    };

    const result = await runMentionClone({ ctx, type: "Explore", message: "go", agentTool });

    expect(result).toEqual({ spawned: true });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.systemPrompt).toBe("Live parent instructions");
    expect(request.tools?.map(tool => tool.name)).toEqual(["Agent"]);
    expect(executions).toHaveLength(1);
    const toolCtx = executions[0];
    expect(toolCtx.cwd).toBe(cwd);
    expect(toolCtx.model).toBe(model);
    expect(toolCtx.sessionManager.getSessionId()).toBe(parent.getSessionId());
    const text = JSON.stringify(request.messages);
    for (const included of ["COMPACTION-SUMMARY", "BRANCH-SUMMARY", "KEPT-AFTER-COMPACTION", "RETAINED-ACTIVE-CONTENT"]) {
      expect(text).toContain(included);
    }
    for (const excluded of ["OBSOLETE-CONTENT", "ABANDONED-CONTENT", "AFTER-ACTIVE-LEAF"]) {
      expect(text).not.toContain(excluded);
    }
    expect(parent.getLeafId()).toBe(originalLeaf);
    expect(JSON.stringify({ header: parent.getHeader(), entries: parent.getEntries() })).toBe(snapshot);
  });
});
