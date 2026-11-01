import type { AgentActivityOutcome, AgentBeforeSettleEventResult, AgentSession, CustomMessageEntryDraft, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { type RunResult, resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic;
let shutdown: (() => Promise<void>) | undefined;
type Message = Omit<CustomMessageEntryDraft, "type">;
type CoreMessage = Message | { role: "user"; content: string };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  hermetic.restore();
  vi.useRealTimers();
});

async function boot(options: { join?: string; maxConcurrent?: number; sessionStart?: boolean } = {}) {
  hermetic = hermeticDir({ settings: {
    schedulingEnabled: false, outputTranscript: false,
    defaultJoinMode: options.join ?? "async", maxConcurrent: options.maxConcurrent ?? 10,
  } });
  const b = makePi();
  let busy = false;
  let requests = 0;
  const followUps: CoreMessage[] = [];
  const delivered: CoreMessage[] = [];
  const parentCtx = ctx({ isIdle: () => !busy });
  const busHandlers = new Map<string, Set<(data: unknown) => void>>();
  const bus = {
    emit: vi.fn((event: string, data: unknown) => {
      for (const h of [...(busHandlers.get(event) ?? [])]) h(data);
    }),
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      const handlers = busHandlers.get(event) ?? new Set();
      handlers.add(handler);
      busHandlers.set(event, handlers);
      return () => handlers.delete(handler);
    }),
  };
  b.pi.events = bus;
  b.pi.sendMessage.mockImplementation((message: Message, options: { deliverAs?: string; triggerTurn?: boolean } = {}) => {
    if (busy && options.deliverAs === "followUp") followUps.push(message);
    else {
      delivered.push(message);
      if (options.triggerTurn) requests++;
    }
  });
  b.pi.sendUserMessage = vi.fn((content: string) => {
    followUps.push({ role: "user", content });
  });
  subagentsExtension(b.pi);
  if (options.sessionStart !== false) await b.lifecycle.get("session_start")({}, parentCtx);
  shutdown = () => b.lifecycle.get("session_shutdown")();

  const beforeSettle = async (outcome: AgentActivityOutcome = "completed", canContinue = false, entries: SessionBoundaryDraft[] = []) => {
    const boundary: AgentBeforeSettleEventResult | undefined = await b.lifecycle.get("agent_before_settle")?.({
      type: "agent_before_settle", entries, continue: false,
      context: { canContinue }, outcome,
    }, parentCtx);
    for (const entry of boundary?.entries ?? []) {
      if (entry.type === "custom_message") delivered.push(entry);
    }
    if (boundary?.continue) requests++;
    return boundary;
  };

  return {
    ...b, bus, parentCtx, followUps, delivered, beforeSettle,
    requests: () => requests,
    notifications: () => delivered.filter((m): m is Message => "customType" in m && m.customType === "subagent-notification"),
    setBusy: (value: boolean) => { busy = value; },
    async start() {
      busy = true;
      requests++;
      await b.lifecycle.get("before_agent_start")?.({ type: "before_agent_start" }, parentCtx);
      await b.lifecycle.get("agent_start")?.({ type: "agent_start" }, parentCtx);
    },
    async endLowLevel() {
      await b.lifecycle.get("agent_end")?.({ type: "agent_end", messages: [] }, parentCtx);
    },
    async finish(outcome: AgentActivityOutcome = "completed", canContinue = false) {
      await b.lifecycle.get("agent_end")?.({ type: "agent_end", messages: [] }, parentCtx);
      // Core drains follow-ups BEFORE settlement. Abort retains that queue for the next prompt.
      if (outcome !== "aborted") {
        while (followUps.length) {
          delivered.push(followUps.shift()!);
          requests++;
        }
        const boundary = await beforeSettle(outcome, canContinue);
        if (boundary?.continue) {
          // A boundary continuation does not re-enter before_agent_start.
          await b.lifecycle.get("agent_start")?.({ type: "agent_start" }, parentCtx);
          await b.lifecycle.get("agent_end")?.({ type: "agent_end", messages: [] }, parentCtx);
          await beforeSettle();
        }
      }
      busy = false;
      await b.lifecycle.get("agent_settled")?.({ type: "agent_settled", aborted: outcome === "aborted" }, parentCtx);
    },
    async spawn(name = "audit") {
      const result = await b.tools.get("Agent").execute("spawn", {
        subagent_type: "general-purpose", prompt: "go", description: name, name, run_in_background: true,
      }, undefined, undefined, parentCtx);
      return result.details.agentId as string;
    },
    resume: (id: string, background = true) => b.tools.get("Agent").execute("resume", {
      subagent_type: "general-purpose", prompt: "again", description: "resume", resume: id, run_in_background: background,
    }, undefined, undefined, parentCtx),
    consume: (agent_id: string) => b.tools.get("get_subagent_result").execute("read", { agent_id }, undefined, undefined, parentCtx),
    async consumeRpc(agentId: string) {
      let reply: unknown;
      bus.on("subagents:rpc:consume:reply:consume", data => { reply = data; });
      bus.emit("subagents:rpc:consume", { requestId: "consume", agentId });
      await flush();
      return reply;
    },
    async stopRpc(agentId: string) {
      let reply: unknown;
      bus.on("subagents:rpc:stop:reply:stop", data => { reply = data; });
      bus.emit("subagents:rpc:stop", { requestId: "stop", agentId });
      await flush();
      return reply;
    },
  };
}

function pendingRun() {
  let complete!: (result: RunResult) => void;
  vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  return async (responseText = "AUDIT_RESULT") => {
    complete({ responseText, session: { messages: [], dispose: vi.fn() } as unknown as AgentSession, aborted: false, steered: false });
    await flush();
  };
}

function pendingResume() {
  let complete!: (result: Awaited<ReturnType<typeof resumeAgent>>) => void;
  vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  return async (text = "RESUMED_RESULT") => {
    complete({ text, aborted: false, steered: false });
    await flush();
  };
}

describe("deferred background completion notifications", () => {
  it("does not queue a redundant model turn when a busy parent consumes after the hold", async () => {
    const complete = pendingRun();
    const b = await boot();
    await b.start();
    const id = await b.spawn();
    await complete();
    await vi.advanceTimersByTimeAsync(250);
    await b.consume(id);
    await b.finish();

    expect(b.requests()).toBe(1);
    expect(b.delivered).toEqual([]);
  });

  it("does not revive an old group when a queued resume is stopped before starting", async () => {
    const completeA = pendingRun();
    const completeB = pendingRun();
    const completeBlocker = pendingRun();
    const b = await boot({ join: "smart", maxConcurrent: 1 });
    await b.start();
    const idA = await b.spawn("a");
    const idB = await b.spawn("b");
    await vi.advanceTimersByTimeAsync(100);
    await completeA("OLD_GROUP_RESULT");
    await b.consume(idA);
    await b.spawn("blocker");
    await completeB("OTHER_GROUP_RESULT");
    await b.consume(idB);
    await b.resume(idA);
    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
    expect(await b.stopRpc(idA)).toEqual(expect.objectContaining({ success: true }));
    await vi.advanceTimersByTimeAsync(300);
    await b.finish();

    expect(b.requests()).toBe(1);
    expect(b.notifications()).toEqual([]);
    await completeBlocker();
  });

  it.each(["id", "name", "rpc"])('suppresses a result consumed by %s after the hold', async how => {
    const complete = pendingRun();
    const b = await boot();
    await b.start();
    const id = await b.spawn("named-audit");
    await complete();
    await vi.advanceTimersByTimeAsync(250);
    if (how === "rpc") expect(await b.consumeRpc(id)).toEqual({ success: true });
    else expect(textOf(await b.consume(how === "id" ? id : "named-audit"))).toContain("AUDIT_RESULT");
    await b.finish();
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toEqual([]);
  });

  it.each(["id", "name", "rpc"])('suppresses a result consumed by %s before 200ms', async how => {
    const complete = pendingRun();
    const b = await boot();
    const id = await b.spawn("named-audit");
    await complete();
    await vi.advanceTimersByTimeAsync(199);
    const timersBefore = vi.getTimerCount();
    if (how === "rpc") expect(await b.consumeRpc(id)).toEqual({ success: true });
    else await b.consume(how === "id" ? id : "named-audit");
    expect(vi.getTimerCount()).toBe(timersBefore - 1);
    await vi.advanceTimersByTimeAsync(201);
    expect(b.requests()).toBe(0);
    expect(b.notifications()).toEqual([]);
  });

  it("wakes an idle parent exactly once for an unread completion after 200ms", async () => {
    const complete = pendingRun();
    const b = await boot();
    await b.spawn();
    await complete();
    await vi.advanceTimersByTimeAsync(199);
    expect(b.delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toHaveLength(1);
    expect(b.notifications()[0].content).toContain("<result>AUDIT_RESULT</result>");
    expect(b.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ display: true }), { deliverAs: "followUp", triggerTurn: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.requests()).toBe(1);
  });

  it("continues a busy parent with unread context even when initial canContinue is false", async () => {
    const complete = pendingRun();
    const b = await boot();
    await b.start();
    await b.spawn();
    await complete();
    await vi.advanceTimersByTimeAsync(250);
    expect(b.followUps).toEqual([]);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    const boundary = await b.beforeSettle("completed", false);
    expect(boundary).toEqual({ entries: [expect.objectContaining({ type: "custom_message", content: expect.stringContaining("AUDIT_RESULT") })], continue: true });
    expect(b.requests()).toBe(2);
    expect(await b.beforeSettle()).toBeUndefined();
    expect(b.notifications()).toHaveLength(1);
  });

  it("preserves boundary drafts contributed by earlier extensions", async () => {
    const complete = pendingRun();
    const b = await boot();
    await b.start();
    await b.spawn();
    await complete();
    await vi.advanceTimersByTimeAsync(250);
    const earlier: CustomMessageEntryDraft = {
      type: "custom_message", customType: "another-extension", content: "PRIOR_CONTEXT", display: false,
    };
    const boundary = await b.beforeSettle("completed", true, [earlier]);
    expect(boundary?.entries).toHaveLength(2);
    expect(boundary?.entries?.[0]).toBe(earlier);
    expect(b.notifications()).toHaveLength(1);
    expect(boundary?.continue).toBe(true);
  });

  it("rechecks idle after manual compaction without an agent settlement event", async () => {
    const complete = pendingRun();
    const b = await boot();
    b.setBusy(true);
    await b.spawn();
    await complete();
    await vi.advanceTimersByTimeAsync(250);
    expect(b.notifications()).toEqual([]);
    b.setBusy(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.requests()).toBe(1);
  });

  it("preserves genuine queued user follow-ups when suppressing a consumed completion", async () => {
    const complete = pendingRun();
    const b = await boot();
    await b.start();
    const id = await b.spawn();
    await complete();
    await vi.advanceTimersByTimeAsync(250);
    b.pi.sendUserMessage("Also check authentication");
    await b.consume(id);
    await b.finish();
    expect(b.requests()).toBe(2);
    expect(b.delivered).toEqual([{ role: "user", content: "Also check authentication" }]);
  });

  it("does not wake during preparation before agent_start or a retry gap after agent_end", async () => {
    const complete = pendingRun();
    const b = await boot();
    b.setBusy(true);
    await b.spawn();
    await complete();
    await vi.advanceTimersByTimeAsync(250);
    expect(b.followUps).toEqual([]);
    await b.start();
    await b.endLowLevel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.followUps).toEqual([]);
    expect(b.notifications()).toEqual([]);
    await b.finish();
    expect(b.requests()).toBe(2);
    expect(b.notifications()).toHaveLength(1);
  });

  it("does not latch busy after before_agent_start preparation throws without settlement", async () => {
    const complete = pendingRun();
    const b = await boot();
    b.setBusy(true);
    await b.lifecycle.get("before_agent_start")({}, b.parentCtx);
    b.setBusy(false);
    await b.spawn();
    await complete();
    await vi.advanceTimersByTimeAsync(200);
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toHaveLength(1);
  });

  it("initializes context for direct tool calls without session_start", async () => {
    const complete = pendingRun();
    const b = await boot({ sessionStart: false });
    await b.spawn();
    await complete();
    await vi.advanceTimersByTimeAsync(200);
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toHaveLength(1);
  });

  it.each([100, 250])("retains a completion on Escape at %dms without restarting; next activity delivers it", async time => {
    const complete = pendingRun();
    const b = await boot();
    await b.start();
    await b.spawn();
    await complete();
    await vi.advanceTimersByTimeAsync(time);
    b.pi.sendUserMessage("A legitimate follow-up");
    await b.finish("aborted");
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toEqual([]);
    expect(b.followUps).toEqual([{ role: "user", content: "A legitimate follow-up" }]);
    await b.start();
    await b.finish();
    expect(b.requests()).toBe(4);
    expect(b.notifications()).toHaveLength(1);
    expect(b.delivered).toContainEqual({ role: "user", content: "A legitimate follow-up" });
  });

  it("does not revive an aborted held result consumed before the next activity", async () => {
    const complete = pendingRun();
    const b = await boot();
    await b.start();
    const id = await b.spawn();
    await complete();
    await b.finish("aborted");
    await b.consume(id);
    await vi.advanceTimersByTimeAsync(250);
    await b.start();
    await b.finish();
    expect(b.requests()).toBe(2);
    expect(b.notifications()).toEqual([]);
  });

  it.each([100, 250])("does not auto-loop after exhausted provider errors at %dms", async time => {
    const complete = pendingRun();
    const b = await boot();
    await b.start();
    const id = await b.spawn();
    await complete();
    await vi.advanceTimersByTimeAsync(time);
    await b.finish("error");
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toEqual([]);
    await b.consume(id);
    await b.start();
    await b.finish();
    expect(b.requests()).toBe(2);
    expect(b.notifications()).toEqual([]);
  });

  it("flushes a completion that becomes ready after the last boundary, at settled", async () => {
    const complete = pendingRun();
    const b = await boot();
    await b.start();
    await b.spawn();
    await complete();
    expect(await b.beforeSettle()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    b.setBusy(false);
    await b.lifecycle.get("agent_settled")({ aborted: false }, b.parentCtx);
    expect(b.requests()).toBe(2);
    expect(b.notifications()).toHaveLength(1);
  });

  it.each(["smart", "group"])('filters consumed members of a %s group at commit', async join => {
    const completeA = pendingRun();
    const completeB = pendingRun();
    const b = await boot({ join });
    await b.start();
    const idA = await b.spawn("a");
    await b.spawn("b");
    await vi.advanceTimersByTimeAsync(100);
    await completeA("CONSUMED_A");
    await completeB("UNREAD_B");
    await vi.advanceTimersByTimeAsync(250);
    await b.consume(idA);
    await b.finish();
    expect(b.requests()).toBe(2);
    expect(b.notifications()).toHaveLength(1);
    expect(b.notifications()[0].content).toContain("Background agent group completed: 1 agent(s) finished");
    expect(b.notifications()[0].content).toContain("UNREAD_B");
    expect(b.notifications()[0].content).not.toContain("CONSUMED_A");
    expect(b.notifications()[0].details).toEqual(expect.objectContaining({ description: "b", resultPreview: "UNREAD_B" }));
  });

  it("filters partial groups and still notifies for unread stragglers", async () => {
    const completeA = pendingRun();
    const completeB = pendingRun();
    const completeC = pendingRun();
    const b = await boot({ join: "smart" });
    await b.start();
    const idA = await b.spawn("a");
    await b.spawn("b");
    await b.spawn("c");
    await vi.advanceTimersByTimeAsync(100);
    await completeA("CONSUMED_A");
    await completeB("PARTIAL_B");
    await vi.advanceTimersByTimeAsync(30_250);
    await b.consume(idA);
    await b.finish();
    expect(b.notifications()).toHaveLength(1);
    expect(b.notifications()[0].content).toContain("partial — others still running");
    expect(b.notifications()[0].content).toContain("PARTIAL_B");
    expect(b.notifications()[0].content).not.toContain("CONSUMED_A");
    await completeC("STRAGGLER_C");
    await vi.advanceTimersByTimeAsync(200);
    expect(b.notifications()).toHaveLength(2);
    expect(b.notifications()[1].content).toContain("STRAGGLER_C");
  });

  it.each([false, true].flatMap(background => [false, true].map(partial => ({ background, partial }))))("invalidates an old group (partial=$partial) on a background=$background resume", async ({ background, partial }) => {
    const completeA = pendingRun();
    const completeB = pendingRun();
    const b = await boot({ join: "smart" });
    await b.start();
    const idA = await b.spawn("a");
    const idB = await b.spawn("b");
    await vi.advanceTimersByTimeAsync(100);
    await completeA("OLD_A");
    if (partial) await vi.advanceTimersByTimeAsync(30_000);
    else {
      await completeB("OLD_B");
      await b.consume(idB);
    }
    const completeAgain = pendingResume();
    const resuming = b.resume(idA, background);
    await flush();
    await completeAgain("NEW_A");
    const result = await resuming;
    if (!background) expect(textOf(result)).toContain("NEW_A");
    await vi.advanceTimersByTimeAsync(400);
    await b.finish();
    expect(b.notifications().map(n => n.content).join("\n")).not.toContain("OLD_A");
    if (background) {
      expect(b.notifications()).toHaveLength(1);
      expect(b.notifications()[0].content).toContain("NEW_A");
    } else expect(b.notifications()).toEqual([]);
    if (partial) {
      await completeB("STRAGGLER_B");
      await vi.advanceTimersByTimeAsync(200);
      expect(b.notifications().at(-1)?.content).toContain("STRAGGLER_B");
    }
  });

  it("does not let an old debounce batch notify for a foreground resume", async () => {
    const complete = pendingRun();
    const b = await boot({ join: "smart" });
    await b.start();
    const id = await b.spawn();
    await complete("OLD_BEFORE_BATCH");
    const completeAgain = pendingResume();
    const resuming = b.resume(id, false);
    await flush();
    await completeAgain("INLINE_RESUME");
    expect(textOf(await resuming)).toContain("INLINE_RESUME");
    await vi.advanceTimersByTimeAsync(400);
    await b.finish();
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toEqual([]);
  });

  it("suppresses a resumed background completion consumed after its own hold", async () => {
    const complete = pendingRun();
    const b = await boot();
    await b.start();
    const id = await b.spawn();
    await complete();
    await b.consume(id);
    const completeAgain = pendingResume();
    await b.resume(id);
    await completeAgain();
    await vi.advanceTimersByTimeAsync(250);
    await b.consume(id);
    await b.finish();
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toEqual([]);
  });

  it.each(["held", "ready", "group-waiting", "running"])('disposes %s work on shutdown and cannot notify a replacement session', async state => {
    const completeA = pendingRun();
    const completeB = pendingRun();
    const b = await boot({ join: state === "group-waiting" ? "smart" : "async" });
    await b.start();
    await b.spawn("a");
    if (state === "group-waiting") {
      await b.spawn("b");
      await vi.advanceTimersByTimeAsync(100);
    }
    if (state !== "running") await completeA();
    if (state === "ready") await vi.advanceTimersByTimeAsync(250);
    await shutdown?.();
    shutdown = undefined;
    if (state === "running") await completeA();
    if (state === "group-waiting") await completeB();
    expect(vi.getTimerCount()).toBe(0);
    b.setBusy(false);
    await vi.advanceTimersByTimeAsync(31_000);
    await b.lifecycle.get("agent_settled")({ aborted: false }, ctx({ isIdle: () => true, sessionManager: { getSessionId: () => "replacement" } }));
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toEqual([]);
  });

  it("does not consume a running agent or silence its later completion", async () => {
    const complete = pendingRun();
    const b = await boot();
    const id = await b.spawn();
    expect(textOf(await b.consume(id))).toContain("Agent is still running");
    expect(await b.consumeRpc(id)).toEqual({ success: false, error: "Agent not found or still running" });
    await complete();
    await vi.advanceTimersByTimeAsync(200);
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toHaveLength(1);
  });

  it("accepts a named handle over RPC after the hold", async () => {
    const complete = pendingRun();
    const b = await boot();
    await b.start();
    await b.spawn("named-audit");
    await complete();
    await vi.advanceTimersByTimeAsync(250);
    expect(await b.consumeRpc("named-audit")).toEqual({ success: true });
    await b.finish();
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toEqual([]);
  });

  it("lets a genuinely new completion wake an idle parent after Escape", async () => {
    const completeOld = pendingRun();
    const completeNew = pendingRun();
    const b = await boot();
    await b.start();
    await b.spawn("old");
    await completeOld("OLD_HELD");
    await vi.advanceTimersByTimeAsync(250);
    await b.finish("aborted");
    await b.spawn("new");
    await completeNew("NEW_COMPLETION");
    await vi.advanceTimersByTimeAsync(200);
    expect(b.requests()).toBe(2);
    expect(b.notifications()).toHaveLength(1);
    expect(b.notifications()[0].content).toContain("NEW_COMPLETION");
    expect(b.notifications()[0].content).not.toContain("OLD_HELD");
  });

  it("keeps an unread notification eligible if a session switch is cancelled before shutdown", async () => {
    const complete = pendingRun();
    const b = await boot();
    await b.spawn();
    await complete();
    await b.lifecycle.get("session_before_switch")({}, b.parentCtx);
    await vi.advanceTimersByTimeAsync(200);
    expect(b.requests()).toBe(1);
    expect(b.notifications()).toHaveLength(1);
  });
});
