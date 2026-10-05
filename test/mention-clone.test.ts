/**
 * mention-clone.test.ts — the off-screen conversation clone that starts a
 * mentioned agent.
 *
 * Everything here guards one property: the clone is a throwaway, but the agent
 * it starts must be indistinguishable from one the main model launched. That
 * breaks in quiet ways — a spawn attributed to the fork's session id files its
 * transcript in the wrong place, a tool-call id the real session never issued
 * puts a dangling `<tool-use-id>` in the completion notification. Neither
 * surfaces as an error, so each is pinned below.
 *
 * The other half is the fallback contract: `runMentionClone` never rejects,
 * because the caller starts the agent directly on `spawned: false` and a
 * rejection would instead lose the mention entirely.
 */
import { type DefaultResourceLoaderOptions } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: vi.mock's factory is lifted above the imports, so it cannot close
// over ordinary top-level consts.
const { createAgentSession, inMemory } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  inMemory: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession,
    DefaultResourceLoader: class {
      constructor(public options: DefaultResourceLoaderOptions) {}
      reload = vi.fn(async () => {});
    },
    SessionManager: { ...actual.SessionManager, inMemory },
  };
});

import { agentMentionReminder } from "../src/mention.js";
import { runMentionClone } from "../src/mention-clone.js";

/** Raw active-branch entries, handed to Pi rather than projected in this fixture. */
const BRANCH = [
  { type: "message", id: "user-1", parentId: null, timestamp: "2026-10-04T00:00:00Z",
    message: { role: "user", content: "hi", timestamp: 1 } },
  { type: "thinking_level_change", id: "leaf-1", parentId: "user-1", timestamp: "2026-10-04T00:00:01Z",
    thinkingLevel: "off" },
];

beforeEach(() => {
  createAgentSession.mockReset();
  inMemory.mockReset();
  inMemory.mockImplementation((_cwd, _options, entries) => ({ getBranch: () => entries }));
});

afterEach(() => vi.restoreAllMocks());

/** The main session's context — the one the spawn must be attributed to. */
function mainCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/repo",
    model: { id: "main-model" },
    thinkingLevel: "high",
    modelRegistry: { runtime: { kind: "runtime" } },
    getSystemPrompt: vi.fn(() => "the live system prompt"),
    sessionManager: {
      getBranch: vi.fn(() => BRANCH),
      getSessionId: vi.fn(() => "parent-session"),
      getLeafId: vi.fn(() => "leaf-1"),
    },
    ...overrides,
  } as any;
}

/** The registered Agent tool, whose handler the clone is supposed to reuse. */
function agentTool() {
  return {
    name: "Agent",
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "Agent ID: a1" }], details: {} })),
  } as any;
}

/**
 * Pi's own tool-visibility rule, reproduced from `sdk.js` + `agent-session.js`:
 * an allowlist is derived once (`tools`, or the empty list when `noTools:
 * "all"`), and EVERY tool — built-in, extension and custom alike — is dropped
 * from the registry unless the allowlist names it. So `noTools: "all"` does not
 * mean "no built-ins, keep my custom tool": it means the clone is handed
 * nothing, answers in prose, and the mention falls back to a direct start.
 */
function visibleTools(opts: any): any[] {
  const allowed = opts.tools ?? (opts.noTools === "all" ? [] : undefined);
  const allowedSet = allowed ? new Set<string>(allowed) : undefined;
  const excluded = new Set<string>(opts.excludeTools ?? []);
  return (opts.customTools ?? []).filter(
    (tool: any) => (!allowedSet || allowedSet.has(tool.name)) && !excluded.has(tool.name),
  );
}

/**
 * Stand in for `createAgentSession`. `turn` receives the clone's single custom
 * tool and plays the part of the model deciding what to do with it — and only
 * the tools Pi would really expose reach it, so a clone built with an allowlist
 * that hides its own tool prompts a model with nothing to call.
 */
function cloneSession(turn?: (tool: any) => Promise<void> | void) {
  const session = {
    agent: { state: { messages: [] as unknown[] } },
    bindExtensions: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    dispose: vi.fn(),
  } as any;
  createAgentSession.mockImplementation(async (opts: any) => {
    const tools = visibleTools(opts);
    session.bindExtensions.mockImplementation(async () => {
      for (const factory of opts.resourceLoader.options.extensionFactories) {
        factory({ on: (event: string, handler: () => unknown) => {
          if (event === "before_agent_start") session.promptHook = handler;
        } });
      }
    });
    session.prompt.mockImplementation(async () => {
      session.livePrompt = session.promptHook?.().systemPrompt;
      // No tool, no tool call: the model can only answer in prose.
      if (tools.length === 0) return;
      await turn?.(tools[0]);
    });
    session.createdWith = opts;
    return { session };
  });
  return session;
}

// Pi1 adds these capabilities as non-enumerable properties, not spreadable fields.
const cloneToolContext = Object.defineProperties({
  cwd: "/fork",
  tools: [{ name: "Agent" }],
  executeTool: vi.fn(),
}, {
  tools: { enumerable: false },
  executeTool: { enumerable: false },
});

/** What the model does when it plays along: one Agent call. */
const callsAgent = (params: Record<string, unknown> = { subagent_type: "Explore", prompt: "go" }) =>
  async (tool: any) => {
    await tool.execute("clone-tool-call-1", params, undefined, undefined, cloneToolContext);
  };

const opts = (over: Record<string, unknown> = {}) => ({
  ctx: mainCtx(),
  type: "Explore",
  message: "find the flaky test",
  agentTool: agentTool(),
  ...over,
}) as any;

describe("cloning the conversation", () => {
  it("carries the conversation's own messages, not a rendering of them", async () => {
    // The whole point: the copy reasons over what the main model can see.
    const session = cloneSession(callsAgent());

    await runMentionClone(opts());

    expect(inMemory).toHaveBeenCalledWith("/repo", undefined, BRANCH);
    const seeded = inMemory.mock.calls[0][2];
    expect(seeded).not.toBe(BRANCH);
    expect(seeded[0].message).not.toBe(BRANCH[0].message);
    expect(session.createdWith.sessionManager.getBranch()).toEqual(BRANCH);
    // A seeded manager owns history; copying it into agent state would duplicate it.
    expect(session.agent.state.messages).toEqual([]);
  });

  it("takes the conversation from memory, never from the session file", async () => {
    // Use in-memory history: a mention can arrive before the first conversation message is persisted.
    const o = opts();
    cloneSession(callsAgent());

    await runMentionClone(o);

    expect(o.ctx.sessionManager.getBranch).toHaveBeenCalledWith();
    expect(createAgentSession.mock.calls[0][0].sessionManager).toBe(inMemory.mock.results[0].value);
  });

  it("restores messages when the older factory ignores the branch", async () => {
    const manager = { getBranch: vi.fn(() => [] as unknown[]) };
    inMemory.mockReturnValue(manager);
    const session = cloneSession(callsAgent());
    // Session construction can append setup entries. Detect support BEFORE it does.
    const create = createAgentSession.getMockImplementation()!;
    createAgentSession.mockImplementation(async (options) => {
      manager.getBranch.mockReturnValue([{ type: "model_change" }]);
      return create(options);
    });

    expect(await runMentionClone(opts())).toEqual({ spawned: true });
    expect(session.agent.state.messages).toEqual([BRANCH[0].message]);
  });

  it("thinks at the level the session is really on", async () => {
    cloneSession(callsAgent());

    await runMentionClone(opts());

    expect(createAgentSession.mock.calls[0][0].thinkingLevel).toBe("high");
  });

  it("omits the thinking-level override when the parent exposes none", async () => {
    // Without a parent level, leave thinking-level resolution to Pi.
    const o = opts({ ctx: mainCtx({ thinkingLevel: undefined }) });
    cloneSession(callsAgent());

    await runMentionClone(o);

    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("thinkingLevel");
  });

  it("clones a conversation that has not started yet", async () => {
    // First input of a fresh session. There is no history to carry, which is an
    // answer and not a failure — the copy still runs on the main model and
    // system prompt, and still makes the call.
    const o = opts();
    o.ctx.sessionManager.getBranch.mockReturnValue([]);
    const session = cloneSession(callsAgent());

    const result = await runMentionClone(o);

    expect(result).toEqual({ spawned: true });
    expect(inMemory).toHaveBeenCalledWith("/repo", undefined, []);
    expect(session.agent.state.messages).toEqual([]);
    expect(session.livePrompt).toBe("the live system prompt");
  });

  it("carries the live system prompt rather than the one it rebuilt", async () => {
    // createAgentSession derives a prompt from cwd and agentDir. Close, but not
    // what the user's model is working under — extensions add to it per turn.
    const session = cloneSession(callsAgent());

    await runMentionClone(opts());

    expect(session.livePrompt).toBe("the live system prompt");
  });

  it("inherits the parent's model, thinking level and providers", async () => {
    cloneSession(callsAgent());

    await runMentionClone(opts());

    const built = createAgentSession.mock.calls[0][0];
    expect(built.model).toEqual({ id: "main-model" });
    expect(built.thinkingLevel).toBe("high");
    expect(built.modelRuntime).toEqual({ kind: "runtime" });
  });

  it("gives the clone the Agent tool and nothing else", async () => {
    // It runs where nobody is watching. A full toolset would let an invisible
    // turn read, write or run things on the user's behalf.
    cloneSession(callsAgent());

    await runMentionClone(opts());

    const built = createAgentSession.mock.calls[0][0];
    expect(built.customTools).toHaveLength(1);
    expect(built.customTools[0].name).toBe("Agent");
    expect(visibleTools(built).map((tool: any) => tool.name)).toEqual(["Agent"]);
  });

  it("names its own tool in the allowlist, or Pi hands it nothing", async () => {
    // `noTools: "all"` reads like "no built-ins, keep my custom tool" and is
    // not: it sets an EMPTY allowlist, which strips the custom tool from the
    // registry too (agent-session.js `isAllowedTool`). The clone then has
    // nothing to call, every mention falls through to the direct start, and the
    // user sees "Started @x directly — the conversation clone did not start it"
    // on every single one. Naming the tool is what makes it reachable.
    cloneSession(callsAgent());

    const result = await runMentionClone(opts());

    const built = createAgentSession.mock.calls[0][0];
    expect(built.tools).toEqual(["Agent"]);
    expect(built.noTools).toBeUndefined();
    expect(result).toEqual({ spawned: true });
  });

  it("prompts it with the message, then the reminder", async () => {
    const session = cloneSession(callsAgent());

    await runMentionClone(opts());

    expect(session.prompt).toHaveBeenCalledWith(
      `find the flaky test\n\n${agentMentionReminder("Explore")}`,
    );
  });
});

describe("attributing the spawn to the real session", () => {
  it("runs the real Agent handler with the MAIN context, not the fork's", async () => {
    // The handler reads cwd, model and sessionManager.getSessionId() off this
    // to place the .output transcript and rootSessionId. The clone's own
    // context would file both under a session that is about to be discarded.
    const tool = agentTool();
    const o = opts({ agentTool: tool });
    cloneSession(callsAgent());

    await runMentionClone(o);

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(tool.execute.mock.calls[0][4]).toMatchObject({
      cwd: o.ctx.cwd,
      model: o.ctx.model,
      modelRegistry: o.ctx.modelRegistry,
      sessionManager: o.ctx.sessionManager,
    });
    expect(tool.execute.mock.calls[0][4].sessionManager.getSessionId()).toBe("parent-session");
    expect(tool.execute.mock.calls[0][4].tools).toBe(cloneToolContext.tools);
    expect(tool.execute.mock.calls[0][4].executeTool).toBe(cloneToolContext.executeTool);
  });

  it("passes no tool-call id, since the real session issued none", async () => {
    // Left on the record it becomes a <tool-use-id> in the completion
    // notification pointing at a call the main conversation never made.
    const tool = agentTool();
    cloneSession(callsAgent());

    await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute.mock.calls[0][0]).toBeUndefined();
  });

  it("forwards the parameters the clone chose", async () => {
    const tool = agentTool();
    cloneSession(callsAgent({ subagent_type: "Plan", prompt: "sketch the migration" }));

    await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute.mock.calls[0][1]).toEqual({
      subagent_type: "Plan",
      prompt: "sketch the migration",
      run_in_background: true,
    });
  });

  it("forces the spawn into the background — a foreground result goes nowhere", async () => {
    // `run_in_background` defaults to false, and a foreground agent returns its
    // answer as the TOOL RESULT: AgentManager marks the record `resultConsumed`
    // precisely so the completion notification is skipped as redundant. Here
    // that tool result lands in the throwaway clone, which is disposed moments
    // later — so the agent runs to completion, shows up in the widget and the
    // fleet, and its answer reaches nobody. The main conversation is not part
    // of the clone's turn, so background delivery is the only way back.
    const tool = agentTool();
    cloneSession(callsAgent({ subagent_type: "Explore", prompt: "go" }));

    await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute.mock.calls[0][1]).toMatchObject({ run_in_background: true });
  });

  it("overrides a clone that explicitly asked for a foreground run", async () => {
    // Nothing tells the clone's model that its own turn is discarded, so an
    // explicit `false` is a reasonable thing for it to emit. It must not decide
    // this one.
    const tool = agentTool();
    cloneSession(callsAgent({ subagent_type: "Explore", prompt: "go", run_in_background: false }));

    await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute.mock.calls[0][1]).toMatchObject({ run_in_background: true });
  });

  it("refuses a second spawn from the same mention", async () => {
    // One handle, one agent. A clone that decides to also launch something else
    // would do it unseen and unasked.
    const tool = agentTool();
    cloneSession(async (t) => {
      await callsAgent()(t);
      await callsAgent()(t);
    });

    const result = await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ spawned: true });
  });

  it("tells the clone why the second call was refused", async () => {
    const captured: any[] = [];
    cloneSession(async (t) => {
      await callsAgent()(t);
      captured.push(await t.execute("c2", { subagent_type: "Explore", prompt: "again" }, undefined, undefined, {}));
    });

    await runMentionClone(opts());

    expect(captured[0].isError).toBe(true);
    expect(captured[0].content[0].text).toContain("Already started an agent");
  });
});

describe("when the clone cannot deliver", () => {
  it("reports a turn that never called the tool", async () => {
    // The model answering in prose is a real outcome, and a silent one — the
    // caller needs it to fall back rather than leave the mention unanswered.
    cloneSession();

    const result = await runMentionClone(opts());

    expect(result.spawned).toBe(false);
    expect(result.error).toContain("did not start it");
  });

  it("returns a thrown error rather than rejecting", async () => {
    // The caller's fallback runs off the resolved value. A rejection here would
    // land in an unhandled promise and lose the mention.
    createAgentSession.mockRejectedValue(new Error("no provider configured"));

    await expect(runMentionClone(opts())).resolves.toEqual({
      spawned: false,
      error: "no provider configured",
    });
  });

  it("keeps a spawn that already happened when the turn then fails", async () => {
    // The agent is running. Reporting spawned:false would start a second one.
    cloneSession(async (tool) => {
      await callsAgent()(tool);
      throw new Error("turn aborted");
    });

    const result = await runMentionClone(opts());

    expect(result).toEqual({ spawned: true, error: "turn aborted" });
  });

  it("disposes the clone even when the turn throws", async () => {
    const session = cloneSession(() => {
      throw new Error("turn aborted");
    });

    await runMentionClone(opts());

    expect(session.dispose).toHaveBeenCalled();
  });
});
