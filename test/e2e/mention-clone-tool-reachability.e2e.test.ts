import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ExtensionContext, type ExtensionToolContext, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMentionClone } from "../../src/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

describe("mention cloning against real Pi", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  let parent: SessionManager;
  let requests: TranscriptContext[];
  let spawnedContext: ExtensionToolContext | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-mention-clone-"));
    parent = SessionManager.inMemory(cwd);
    requests = [];
    spawnedContext = undefined;
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    faux.setResponses([
      (context) => {
        requests.push(structuredClone(context));
        return fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "Explore", prompt: "Investigate the earlier task" }));
      },
      fauxAssistantMessage("Started."),
    ]);
  });

  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  async function delegate() {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const ctx = {
      cwd,
      model,
      thinkingLevel: "off",
      getSystemPrompt: () => "Live parent instructions",
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: parent,
    } as unknown as ExtensionContext;
    const agentTool: ToolDefinition = {
      name: "Agent",
      label: "Agent",
      description: "Start an agent",
      parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }),
      execute: async (_id, _params, _signal, _onUpdate, toolContext) => {
        spawnedContext = toolContext;
        return { content: [{ type: "text", text: "Agent ID: child" }], details: undefined };
      },
    };
    return runMentionClone({ ctx, type: "Explore", message: "Investigate it", agentTool });
  }

  it("uses the live parent prompt and history with only the Agent tool", async () => {
    parent.appendMessage({
      role: "system", content: "Stale parent instructions", timestamp: 1,
      toolsAdded: [{ name: "write", description: "Write a file", parameters: Type.Object({}) }],
    });
    parent.appendMessage({ role: "user", content: "Earlier task", timestamp: 2 });
    parent.appendMessage(fauxAssistantMessage("Earlier answer"));
    const originalEntries = structuredClone(parent.getEntries());

    expect(await delegate()).toEqual({ spawned: true });

    expect(requests).toHaveLength(1);
    expect(getCurrentSystemPrompt(requests[0].messages)).toBe("Live parent instructions");
    expect(getCurrentTools(requests[0].messages).map(tool => tool.name)).toEqual(["Agent"]);
    expect(JSON.stringify(requests[0].messages)).toContain("Earlier task");
    expect(JSON.stringify(requests[0].messages)).toContain("Earlier answer");
    expect(spawnedContext?.sessionManager).toBe(parent);
    expect(spawnedContext?.tools.map(tool => tool.name)).toEqual(["Agent"]);
    expect(structuredClone(parent.getEntries())).toEqual(originalEntries);
  });

  it("preserves compaction and edits on the active branch without abandoned messages", async () => {
    parent.appendMessage({ role: "user", content: "Obsolete task", timestamp: 1 });
    const retained = parent.appendMessage({ role: "user", content: "Unedited task", timestamp: 2 });
    parent.appendCompaction("Earlier work summary", retained, 10_000);
    parent.appendContextEdit(retained, { content: "Edited task" });
    const active = parent.appendMessage({ role: "user", content: "Active branch task", timestamp: 3 });
    parent.appendMessage({ role: "user", content: "Abandoned branch", timestamp: 4 });
    parent.branch(active);
    const originalEntries = structuredClone(parent.getEntries());
    const originalLeaf = parent.getLeafId();

    expect(await delegate()).toEqual({ spawned: true });

    const transcript = JSON.stringify(requests[0].messages);
    expect(transcript).toContain("Earlier work summary");
    expect(transcript).toContain("Edited task");
    expect(transcript).toContain("Active branch task");
    expect(transcript).not.toContain("Obsolete task");
    expect(transcript).not.toContain("Unedited task");
    expect(transcript).not.toContain("Abandoned branch");
    expect(parent.getEntries()).toEqual(originalEntries);
    expect(parent.getLeafId()).toBe(originalLeaf);
  });
});
