import type { Usage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionHandler,
  SessionBeforeSwitchEvent,
  SessionBeforeSwitchResult,
  SessionShutdownEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runner from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import type { AgentInvocation, AgentRecord } from "../src/types.js";
import type { LifetimeUsage } from "../src/usage.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof runner>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

type ToolContext = Parameters<ToolDefinition["execute"]>[4];
type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
type UsageEvent = Pick<AgentRecord, "id" | "type" | "description" | "parentAgentId" | "workflowId"> &
  Pick<AgentInvocation, "thinking" | "requestedThinking"> & { model?: string; depth: number; usage: Usage };
type ChildRunner = NonNullable<AgentSession["extensionRunner"]>;
type SessionFixture = Pick<AgentSession, "dispose" | "messages"> &
  Partial<Pick<AgentSession, "model" | "thinkingLevel">> & {
    extensionRunner?: Pick<ChildRunner, "hasHandlers"> & {
      emit: (event: SessionShutdownEvent) => ReturnType<ChildRunner["emit"]>;
    };
  };

const MODEL: NonNullable<AgentSession["model"]> = {
  provider: "anthropic",
  id: "usage-test-model",
  name: "Usage test model",
  api: "anthropic-messages",
  baseUrl: "https://example.invalid",
  input: ["text"],
  reasoning: true,
  contextWindow: 8192,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const FULL_DELTA: LifetimeUsage = { input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 };
const FULL_USAGE: Usage = {
  input: 100, output: 50, cacheWrite: 10, cacheRead: 900, totalTokens: 1060,
  cost: { ...ZERO_COST, total: 0.0123 },
};
const FRESH_DELTA: LifetimeUsage = { input: 7, output: 3, cacheWrite: 0, cost: 0.002 };
const FRESH_USAGE: Usage = {
  input: 7, output: 3, cacheWrite: 0, cacheRead: 0, totalTokens: 10,
  cost: { ...ZERO_COST, total: 0.002 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function childSession(overrides: Partial<SessionFixture> = {}): AgentSession {
  // Only the session surface the real manager and extension read is stubbed.
  return { dispose: vi.fn(), messages: [], ...overrides } as AgentSession;
}

function runSpending(...messages: LifetimeUsage[]) {
  vi.mocked(runner.runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    // The real runner creates its session after the manager's onSpawned hook.
    await Promise.resolve();
    const session = childSession();
    options.onSessionCreated?.(session);
    for (const usage of messages) options.onAssistantUsage?.(usage);
    return { responseText: "done", session, aborted: false, steered: false };
  });
}

describe("subagent usage and disposal events", () => {
  let hermetic: Hermetic;
  let active: ReturnType<typeof boot> | undefined;
  let releases: (() => void)[];
  let calls: Promise<unknown>[];

  function gate() {
    const wait = deferred<void>();
    releases.push(() => wait.resolve());
    return wait;
  }

  function boot(settings: Record<string, unknown> = {}, agentFiles?: Record<string, string>) {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false, ...settings }, agentFiles });
    const harness = makePi();
    const pi: ExtensionAPI = harness.pi;
    const context: ToolContext = ctx();
    subagentsExtension(pi);
    const emit = vi.mocked(pi.events.emit);
    const events = (name: string): unknown[] => emit.mock.calls.filter(([event]) => event === name).map(([, payload]) => payload);
    const tools: Map<string, ToolDefinition> = harness.tools;
    const shutdownHandler: ExtensionHandler<SessionShutdownEvent> = harness.lifecycle.get("session_shutdown");
    const beforeSwitch: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult> =
      harness.lifecycle.get("session_before_switch");
    const result = {
      pi, context, emit, events,
      usageEvents: () => events("subagents:usage") as UsageEvent[],
      beforeSwitch: () => beforeSwitch({ type: "session_before_switch", reason: "new" }, context),
      shutdown: () => Promise.resolve(shutdownHandler({ type: "session_shutdown", reason: "quit" }, context)),
      call(name: string, params: Record<string, unknown>, id = "tc-1"): Promise<ToolResult> {
        const promise = tools.get(name)!.execute(id, params, undefined, undefined, context);
        calls.push(promise);
        return promise;
      },
      spawn(params: Record<string, unknown> = {}, id = "tc-1"): Promise<ToolResult> {
        return result.call("Agent", {
          prompt: "go", description: "spend", subagent_type: "general-purpose", run_in_background: false, ...params,
        }, id);
      },
    };
    active = result;
    return result;
  }

  beforeEach(() => {
    releases = [];
    calls = [];
    active = undefined;
    vi.mocked(runner.runAgent).mockReset();
    vi.mocked(runner.resumeAgent).mockReset();
  });

  afterEach(async () => {
    try {
      for (const release of releases) release();
      await Promise.allSettled(calls);
      await flush();
      await active?.shutdown();
      await flush();
    } finally {
      registerAgents(new Map());
      hermetic?.restore();
    }
  });

  it("emits complete per-message usage live, with the session's model and clamped thinking, with reporting off", async () => {
    const b = boot();
    const ready = deferred<runner.RunOptions>();
    const finish = gate();
    vi.mocked(runner.runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await Promise.resolve();
      const session = childSession({ model: MODEL, thinkingLevel: "low" });
      options.onSessionCreated?.(session);
      ready.resolve(options);
      await finish.promise;
      return { responseText: "done", session, aborted: false, steered: false };
    });
    let settled = false;
    const running = b.spawn({ thinking: "minimal" }).then(result => { settled = true; return result; });
    const options = await ready.promise;
    const record = options.nestedRuntime!.manager.getRecord(options.agentId!);
    expect(record).toBeDefined();
    const identity = {
      id: record!.id, type: "general-purpose", description: "spend", depth: 1,
      model: "anthropic/usage-test-model", thinking: "low", requestedThinking: "minimal",
    };

    options.onAssistantUsage?.(FULL_DELTA);
    expect(b.usageEvents()).toStrictEqual([{ ...identity, usage: FULL_USAGE }]);
    options.onAssistantUsage?.(FRESH_DELTA);
    expect(b.usageEvents()).toStrictEqual([
      { ...identity, usage: FULL_USAGE }, { ...identity, usage: FRESH_USAGE },
    ]);
    expect(record!.lifetimeUsage).toMatchObject({ input: 107, output: 53, cacheWrite: 10, cacheRead: 900 });
    expect(settled).toBe(false);
    expect(b.events("subagents:completed")).toEqual([]);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    finish.resolve();
    const result = await running;
    expect(result.details).toMatchObject({ agentId: record!.id });
    expect(result.usage).toBeUndefined();
    expect(b.usageEvents()).toHaveLength(2);
    expect(b.events("subagents:completed")).toHaveLength(1);
  });

  it("omits every unknown optional key and leaves the enabled reporting pool intact and single-use", async () => {
    const b = boot({ reportUsage: true, showCost: false });
    runSpending(FULL_DELTA);
    const result = await b.spawn();
    const id = vi.mocked(runner.runAgent).mock.calls[0][3].agentId;

    expect(b.usageEvents()).toStrictEqual([{
      id, type: "general-purpose", description: "spend", depth: 1, usage: FULL_USAGE,
    }]);
    expect(result.usage).toStrictEqual(FULL_USAGE);
    runSpending();
    expect((await b.spawn({}, "tc-2")).usage).toBeUndefined();
    expect((await b.call("get_subagent_result", { agent_id: id }, "tc-3")).usage).toBeUndefined();
    expect(b.usageEvents()).toHaveLength(1);
  });

  it("suppresses only all-zero messages, not unpriced, cache-only or cost-only usage", async () => {
    const b = boot({ reportUsage: false, showCost: true });
    runSpending(
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 },
      { input: 0, output: 0, cacheWrite: 0 },
      { input: 2, output: 1, cacheWrite: 0 },
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 9, cost: 0 },
      { input: 0, output: 0, cacheWrite: 4, cost: 0 },
      { input: 0, output: 0, cacheWrite: 0, cost: 0.001 },
    );
    const result = await b.spawn();

    expect(b.usageEvents().map(event => event.usage)).toStrictEqual([
      { input: 2, output: 1, cacheWrite: 0, cacheRead: 0, totalTokens: 3, cost: ZERO_COST },
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 9, totalTokens: 9, cost: ZERO_COST },
      { input: 0, output: 0, cacheWrite: 4, cacheRead: 0, totalTokens: 4, cost: ZERO_COST },
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, totalTokens: 0, cost: { ...ZERO_COST, total: 0.001 } },
    ]);
    expect(result.usage).toBeUndefined();
  });

  it("keeps the caller's requested level when frontmatter wins and the session clamps again", async () => {
    const b = boot({}, { pinned: "---\ndescription: Pinned thinking\nthinking: low\n---\nDo the task.\n" });
    vi.mocked(runner.runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await Promise.resolve();
      const session = childSession({ model: MODEL, thinkingLevel: "off" });
      options.onSessionCreated?.(session);
      options.onAssistantUsage?.(FRESH_DELTA);
      return { responseText: "done", session, aborted: false, steered: false };
    });
    await b.spawn({ subagent_type: "pinned", thinking: "high" });
    const options = vi.mocked(runner.runAgent).mock.calls[0][3];

    expect(options.thinkingLevel).toBe("low");
    expect(b.usageEvents()).toStrictEqual([{
      id: options.agentId, type: "pinned", description: "spend", depth: 1,
      model: "anthropic/usage-test-model", thinking: "off", requestedThinking: "high", usage: FRESH_USAGE,
    }]);
  });

  it("attributes nested messages to their actual owners, without re-emitting ancestor rollups", async () => {
    const b = boot({ reportUsage: true, maxSubagentDepth: 3 });
    vi.mocked(runner.runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await Promise.resolve();
      const session = childSession();
      options.onSessionCreated?.(session);
      const runtime = options.nestedRuntime!;
      options.onAssistantUsage?.({ input: 10 * runtime.depth, output: runtime.depth, cacheWrite: 0 });
      if (runtime.depth < 3) {
        const [agent] = createNestedSubagentTools({
          ...runtime, pi: b.pi, maxSubagentDepth: 3, allowedSubagents: "all", configCwd: b.context.cwd,
        });
        await agent.execute(`nested-${runtime.depth}`, {
          prompt: "sub", description: `depth ${runtime.depth + 1}`, subagent_type: "general-purpose",
        }, undefined, undefined, b.context);
      }
      return { responseText: "done", session, aborted: false, steered: false };
    });
    const result = await b.spawn();
    const ids = vi.mocked(runner.runAgent).mock.calls.map(call => call[3].agentId);
    expect(ids).toHaveLength(3);

    expect(b.usageEvents()).toStrictEqual([
      {
        id: ids[0], type: "general-purpose", description: "spend", depth: 1,
        usage: { input: 10, output: 1, cacheWrite: 0, cacheRead: 0, totalTokens: 11, cost: ZERO_COST },
      },
      {
        id: ids[1], type: "general-purpose", description: "depth 2", depth: 2, parentAgentId: ids[0],
        usage: { input: 20, output: 2, cacheWrite: 0, cacheRead: 0, totalTokens: 22, cost: ZERO_COST },
      },
      {
        id: ids[2], type: "general-purpose", description: "depth 3", depth: 3, parentAgentId: ids[1],
        usage: { input: 30, output: 3, cacheWrite: 0, cacheRead: 0, totalTokens: 33, cost: ZERO_COST },
      },
    ]);
    const total: Usage = { input: 60, output: 6, cacheWrite: 0, cacheRead: 0, totalTokens: 66, cost: ZERO_COST };
    expect(result.usage).toStrictEqual(total);
    expect(b.events("subagents:started")).toHaveLength(1);
    expect(b.events("subagents:completed")).toEqual([expect.objectContaining({ id: ids[0], usage: total })]);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("reports a real workflow child's ownership and depth live, even though its lifecycle is hidden", async () => {
    const b = boot({ reportUsage: true });
    const ready = deferred<runner.RunOptions>();
    const finish = gate();
    vi.mocked(runner.runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await Promise.resolve();
      const session = childSession({ model: MODEL, thinkingLevel: "low" });
      options.onSessionCreated?.(session);
      ready.resolve(options);
      await finish.promise;
      return { responseText: "workflow answer", session, aborted: false, steered: false };
    });
    const started = await b.call("SubagentWorkflow", {
      script: 'export const meta = { name: "usage", description: "Usage attribution" };\n' +
        'return await agent("go", { label: "workflow step", effort: "minimal" });',
    });
    const { taskId } = started.details as { taskId: string };
    expect(taskId).toMatch(/^wf_/);
    const options = await ready.promise;
    options.onAssistantUsage?.(FRESH_DELTA);

    expect(b.usageEvents()).toStrictEqual([{
      id: options.agentId, type: "general-purpose", description: "workflow step", depth: 1, workflowId: taskId,
      model: "anthropic/usage-test-model", thinking: "low", requestedThinking: "minimal", usage: FRESH_USAGE,
    }]);
    expect(b.events("subagents:started")).toEqual([]);
    expect(b.events("subagents:completed")).toEqual([]);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    expect((await b.call("get_subagent_result", { agent_id: "absent" }, "tc-drain")).usage).toStrictEqual(FRESH_USAGE);

    finish.resolve();
    await vi.waitFor(() => expect(b.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification", details: expect.objectContaining({ id: taskId, status: "completed" }),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    ), { timeout: 10_000 });
    expect(b.events("subagents:completed")).toEqual([]);
    expect(b.usageEvents()).toHaveLength(1);
    expect((await b.call("get_subagent_result", { agent_id: "absent" }, "tc-empty")).usage).toBeUndefined();
  }, 15_000);

  it.each([false, true])("emits only fresh usage on resume (background=%s), preserving identity and pool accounting", async background => {
    const b = boot({ reportUsage: true });
    const session = childSession({ model: MODEL, thinkingLevel: "low" });
    vi.mocked(runner.runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await Promise.resolve();
      options.onSessionCreated?.(session);
      options.onAssistantUsage?.(FULL_DELTA);
      return { responseText: "done", session, aborted: false, steered: false };
    });
    expect((await b.spawn({ thinking: "low" })).usage).toStrictEqual(FULL_USAGE);
    const id = vi.mocked(runner.runAgent).mock.calls[0][3].agentId!;
    const identity = {
      id, type: "general-purpose", description: "spend", depth: 1,
      model: "anthropic/usage-test-model", thinking: "low",
    };
    expect(b.usageEvents()).toStrictEqual([{ ...identity, usage: FULL_USAGE }]);
    const ready = deferred<Parameters<typeof runner.resumeAgent>[2]>();
    const finish = gate();
    vi.mocked(runner.resumeAgent).mockImplementation(async (_session, _prompt, options) => {
      ready.resolve(options);
      await finish.promise;
      return { text: "resumed", aborted: false, steered: false };
    });
    const resumed = b.spawn({ resume: id, subagent_type: "Explore", description: "ignored", run_in_background: background }, "tc-resume");
    const options = await ready.promise;
    if (background) expect((await resumed).usage).toBeUndefined();
    expect(vi.mocked(runner.resumeAgent).mock.calls[0][0]).toBe(session);

    options.onAssistantUsage?.(FRESH_DELTA);
    expect(b.usageEvents()).toStrictEqual([
      { ...identity, usage: FULL_USAGE }, { ...identity, usage: FRESH_USAGE },
    ]);
    finish.resolve();
    const result = await resumed;
    await flush();
    const fetched = await b.call("get_subagent_result", { agent_id: id }, "tc-fetch");
    expect([result.usage, fetched.usage].filter(usage => usage !== undefined)).toStrictEqual([FRESH_USAGE]);
    expect((await b.call("get_subagent_result", { agent_id: id }, "tc-empty")).usage).toBeUndefined();
    expect(b.usageEvents()).toHaveLength(2);
  });

  it("waits for deferred child shutdown and final usage before emitting disposed", async () => {
    const b = boot();
    const releaseShutdown = gate();
    const shutdownStarted = deferred<void>();
    const finish = gate();
    const aborted = vi.fn();
    let options!: runner.RunOptions;
    const dispose = vi.fn();
    const emitShutdown = vi.fn(async () => {
      shutdownStarted.resolve();
      await releaseShutdown.promise;
      options.onAssistantUsage?.(FRESH_DELTA);
      finish.resolve();
      await flush();
      return undefined;
    });
    const session = childSession({
      dispose,
      extensionRunner: { hasHandlers: event => event === "session_shutdown", emit: emitShutdown },
    });
    vi.mocked(runner.runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      options = opts;
      await Promise.resolve();
      opts.onSessionCreated?.(session);
      opts.signal?.addEventListener("abort", aborted, { once: true });
      opts.onAssistantUsage?.(FULL_DELTA);
      await finish.promise;
      return { responseText: "stopped", session, aborted: false, steered: false };
    });
    await b.spawn({ run_in_background: true });
    let settled = false;
    const shutdown = b.shutdown().then(() => { settled = true; });
    await shutdownStarted.promise;
    await flush();

    expect(aborted).toHaveBeenCalledOnce();
    expect(emitShutdown).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(settled).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(b.events("subagents:disposed")).toEqual([]);
    expect(b.usageEvents().map(event => event.usage)).toStrictEqual([FULL_USAGE]);

    releaseShutdown.resolve();
    await shutdown;
    expect(dispose).toHaveBeenCalledOnce();
    expect(b.usageEvents().map(event => event.usage)).toStrictEqual([FULL_USAGE, FRESH_USAGE]);
    expect(b.events("subagents:disposed")).toStrictEqual([{}]);
    expect(b.emit.mock.calls.at(-1)).toStrictEqual(["subagents:disposed", {}]);
    const finalUsageIndex = b.emit.mock.calls.map(([name]) => name).lastIndexOf("subagents:usage");
    expect(b.emit.mock.invocationCallOrder[finalUsageIndex]).toBeLessThan(dispose.mock.invocationCallOrder[0]);
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(b.emit.mock.invocationCallOrder.at(-1)!);
  });

  it("emits an empty disposed payload even when no agents ever ran", async () => {
    const b = boot();
    expect(b.events("subagents:disposed")).toEqual([]);
    await b.shutdown();
    expect(b.events("subagents:disposed")).toStrictEqual([{}]);
    expect(b.usageEvents()).toEqual([]);
    expect(b.emit.mock.calls.at(-1)).toStrictEqual(["subagents:disposed", {}]);
    expect(runner.runAgent).not.toHaveBeenCalled();
  });

  it("does not announce disposal on a switch that another extension can cancel", async () => {
    const b = boot();
    const ready = deferred<runner.RunOptions>();
    const finish = gate();
    const dispose = vi.fn();
    vi.mocked(runner.runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await Promise.resolve();
      const session = childSession({ dispose });
      options.onSessionCreated?.(session);
      ready.resolve(options);
      await finish.promise;
      return { responseText: "done", session, aborted: false, steered: false };
    });
    await b.spawn({ run_in_background: true });
    const options = await ready.promise;

    // A later hook vetoes the switch: no session_shutdown follows this hook.
    await b.beforeSwitch();
    expect(b.events("subagents:disposed")).toEqual([]);
    expect(dispose).not.toHaveBeenCalled();
    expect(options.signal?.aborted).toBe(false);
    options.onAssistantUsage?.(FRESH_DELTA);
    expect(b.usageEvents()).toStrictEqual([{
      id: options.agentId, type: "general-purpose", description: "spend", depth: 1, usage: FRESH_USAGE,
    }]);

    finish.resolve();
    await b.call("get_subagent_result", { agent_id: options.agentId, wait: true }, "tc-result");
    await b.shutdown();
    expect(dispose).toHaveBeenCalledOnce();
    expect(b.events("subagents:disposed")).toStrictEqual([{}]);
  });
});
