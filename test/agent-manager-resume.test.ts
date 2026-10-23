import { getEventListeners } from "node:events";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

type ResumeOptions = NonNullable<Parameters<AgentManager["resume"]>[3]>;
type ResumeResult = Awaited<ReturnType<typeof resumeAgent>>;
type RunResult = Awaited<ReturnType<typeof runAgent>>;

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp" } satisfies Pick<ExtensionContext, "cwd"> as ExtensionContext;
const partial: ResumeResult = { text: "partial answer", aborted: false, steered: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let manager: AgentManager;
let session: AgentSession;
let spawned: RunResult;
const onComplete = vi.fn();
const onUsage = vi.fn();
const onCompact = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  session = { dispose: vi.fn() } satisfies Pick<AgentSession, "dispose"> as AgentSession;
  spawned = { responseText: "previous answer", session, aborted: false, steered: false };
  vi.mocked(runAgent).mockResolvedValue(spawned);
  manager = new AgentManager(onComplete, 1, undefined, onCompact, onUsage);
});

afterEach(async () => {
  await manager.dispose();
  vi.restoreAllMocks();
});

async function seed(maxTurns?: number) {
  const { record } = await manager.spawnAndWait(pi, ctx, "resume-specialist", "initial", {
    description: "resumable",
    invocation: maxTurns === undefined ? undefined : { maxTurns },
  });
  onComplete.mockClear();
  return record;
}

function start(record: AgentRecord, isBackground: boolean, signal?: AbortSignal, options: ResumeOptions = {}) {
  const result = deferred<ResumeResult>();
  vi.mocked(resumeAgent).mockReturnValueOnce(result.promise);
  const pending = manager.resume(record.id, "continue", signal, { ...options, isBackground });
  const runnerOptions = vi.mocked(resumeAgent).mock.calls.at(-1)![2];
  return {
    ...result,
    runnerOptions,
    pending,
    done: isBackground ? record.promise! : pending,
  };
}

describe.each([false, true])("resume (background=%s)", (isBackground) => {
  it.each(["running", "queued"] as const)("refuses a %s record without replacing its controller", async (status) => {
    const record = await seed();
    record.status = status;
    const before = { ...record };

    expect(await manager.resume(record.id, "again", undefined, { isBackground })).toBeUndefined();

    expect(resumeAgent).not.toHaveBeenCalled();
    expect(record).toEqual(before);
    expect(record.abortController).toBe(before.abortController);
    expect(record.promise).toBe(before.promise);
  });

  it.each([
    { stored: 7, requested: 2, expected: 2 },
    { stored: 7, requested: 0, expected: 0 },
    { stored: 7, requested: undefined, expected: 7 },
    { stored: undefined, requested: undefined, expected: undefined },
  ])("forwards type, callbacks and budget $requested over $stored", async ({ stored, requested, expected }) => {
    const record = await seed(stored);
    const previousController = record.abortController!;
    previousController.abort();
    const parent = new AbortController();
    const onTurnEnd = vi.fn();
    const onToolActivity = vi.fn();
    const onAssistantUsage = vi.fn();
    const onCompaction = vi.fn();
    const run = start(record, isBackground, parent.signal, {
      maxTurns: requested, onTurnEnd, onToolActivity, onAssistantUsage, onCompaction,
    });
    expect(resumeAgent).toHaveBeenLastCalledWith(session, "continue", run.runnerOptions);
    expect(run.runnerOptions.type).toBe(record.type);
    expect(run.runnerOptions.maxTurns).toBe(expected);
    expect(run.runnerOptions.onTurnEnd).toBe(onTurnEnd);
    expect(record.abortController).not.toBe(previousController);
    expect(run.runnerOptions.signal).toBe(record.abortController!.signal);
    expect(run.runnerOptions.signal).not.toBe(parent.signal);
    expect(run.runnerOptions.signal!.aborted).toBe(false);
    expect(record.result).toBeUndefined();
    expect(record.completedAt).toBeUndefined();

    run.runnerOptions.onTurnEnd?.(3);
    run.runnerOptions.onToolActivity?.({ type: "start", toolName: "read" });
    run.runnerOptions.onToolActivity?.({ type: "end", toolName: "read" });
    const usage = { input: 2, output: 3, cacheWrite: 4, cost: 0 };
    const compaction = { reason: "threshold", tokensBefore: 90 } as const;
    run.runnerOptions.onAssistantUsage?.(usage);
    run.runnerOptions.onCompaction?.(compaction);
    expect(onTurnEnd).toHaveBeenCalledExactlyOnceWith(3);
    expect(onToolActivity).toHaveBeenCalledTimes(2);
    expect(onToolActivity).toHaveBeenLastCalledWith({ type: "end", toolName: "read" });
    expect(record.toolUses).toBe(1);
    expect(record.lifetimeUsage).toMatchObject(usage);
    expect(onAssistantUsage).toHaveBeenCalledExactlyOnceWith(usage);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(record, usage);
    expect(record.compactionCount).toBe(1);
    expect(onCompaction).toHaveBeenCalledExactlyOnceWith(compaction);
    expect(onCompact).toHaveBeenCalledExactlyOnceWith(record, compaction);
    if (isBackground) {
      expect(await run.pending).toBe(record);
      expect(record.status).toBe("running");
    }
    expect(onComplete).not.toHaveBeenCalled();
    run.resolve(partial);
    await run.done;
    expect(onComplete).toHaveBeenCalledTimes(isBackground ? 1 : 0);
    if (isBackground) expect(onComplete).toHaveBeenCalledWith(record);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });

  it.each([
    { name: "completed", aborted: false, steered: false, failure: undefined, stopped: false, status: "completed" },
    { name: "soft limit", aborted: false, steered: true, failure: undefined, stopped: false, status: "steered" },
    { name: "failure", aborted: false, steered: false, failure: "provider failed", stopped: false, status: "error" },
    { name: "failure beats steering", aborted: false, steered: true, failure: "provider failed", stopped: false, status: "error" },
    { name: "hard limit", aborted: true, steered: false, failure: undefined, stopped: false, status: "aborted" },
    { name: "hard limit beats failure and steering", aborted: true, steered: true, failure: "provider failed", stopped: false, status: "aborted" },
    { name: "stop beats completion", aborted: false, steered: false, failure: undefined, stopped: true, status: "stopped" },
    { name: "stop beats hard limit, failure and steering", aborted: true, steered: true, failure: "provider failed", stopped: true, status: "stopped" },
  ])("retains partial text: $name", async ({ aborted, steered, failure, stopped, status }) => {
    const record = await seed();
    const run = start(record, isBackground);
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    if (stopped) {
      expect(manager.abort(record.id)).toBe(true);
      expect(record.completedAt).toBe(1234);
    }
    now.mockReturnValue(5678);
    run.resolve({ ...partial, aborted, steered, failure });
    await run.done;
    expect(record.status).toBe(status);
    expect(record.result).toBe(partial.text);
    expect(record.error).toBe(status === "error" ? failure : undefined);
    expect(record.completedAt).toBe(stopped ? 1234 : 5678);
    expect(onComplete).toHaveBeenCalledTimes(isBackground ? 1 : 0);
  });

  it.each([false, true])("handles rejection without undoing a stop (stopped=%s)", async (stopped) => {
    const record = await seed();
    const parent = new AbortController();
    const run = start(record, isBackground, parent.signal);
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    if (stopped) manager.abort(record.id);
    now.mockReturnValue(5678);
    run.reject(new Error("resume rejected"));
    await run.done;
    expect(record.status).toBe(stopped ? "stopped" : "error");
    expect(record.completedAt).toBe(stopped ? 1234 : 5678);
    if (!stopped) expect(record.error).toBe("resume rejected");
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    expect(onComplete).toHaveBeenCalledTimes(isBackground ? 1 : 0);
  });

  it.each(["manager", "parent", "pre-aborted"] as const)("routes %s abort to the fresh runner signal", async (source) => {
    const record = await seed();
    const previousController = record.abortController!;
    const parent = new AbortController();
    if (source === "pre-aborted") parent.abort();
    const run = start(record, isBackground, parent.signal);
    expect(run.runnerOptions.signal).toBe(record.abortController!.signal);
    expect(record.abortController).not.toBe(previousController);
    if (source === "manager") expect(manager.abort(record.id)).toBe(true);
    if (source === "parent") parent.abort();
    expect(run.runnerOptions.signal!.aborted).toBe(true);
    expect(previousController.signal.aborted).toBe(false);
    expect(record.status).toBe("stopped");
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    run.resolve(partial);
    await run.done;
    expect(record.status).toBe("stopped");
    expect(record.result).toBe(partial.text);
  });

  it.each(["resolve", "reject"] as const)("detaches a settled parent's listener after %s before the next resume", async (settlement) => {
    const record = await seed();
    const parent = new AbortController();
    const first = start(record, isBackground, parent.signal);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
    if (settlement === "resolve") first.resolve(partial);
    else first.reject(new Error("first failed"));
    await first.done;
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    const second = start(record, isBackground);
    parent.abort();
    expect(second.runnerOptions.signal!.aborted).toBe(false);
    expect(record.status).toBe("running");
    second.resolve(partial);
    await second.done;
    expect(record.status).toBe("completed");
  });

  it("does not retain a queued spawn's parent listener across a later resume", async () => {
    const blocker = deferred<RunResult>();
    const queued = deferred<RunResult>();
    vi.mocked(runAgent).mockReturnValueOnce(blocker.promise).mockReturnValueOnce(queued.promise);
    const blockerId = manager.spawn(pi, ctx, "resume-specialist", "block", { description: "block", isBackground: true });
    const parent = new AbortController();
    const id = manager.spawn(pi, ctx, "resume-specialist", "queued", {
      description: "queued", isBackground: true, signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("queued");
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
    blocker.resolve(spawned);
    await manager.getRecord(blockerId)!.promise;
    await record.startGate;
    expect(record.status).toBe("running");
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
    queued.resolve(spawned);
    await record.promise;
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    const resumed = start(record, isBackground);
    parent.abort();
    expect(record.status).toBe("running");
    expect(resumed.runnerOptions.signal!.aborted).toBe(false);
    resumed.resolve(partial);
    await resumed.done;
    expect(record.status).toBe("completed");
  });
});

describe("background resume queue and parent-listener ownership", () => {
  it.each(["resolve", "reject", "stop"] as const)("holds exactly one slot until %s settles, then drains and notifies once", async (settlement) => {
    const first = await seed();
    const second = await seed();
    const third = await seed();
    const active = start(first, true);
    const next = deferred<ResumeResult>();
    const last = deferred<ResumeResult>();
    vi.mocked(resumeAgent).mockReturnValueOnce(next.promise).mockReturnValueOnce(last.promise);
    const onStarted = vi.fn();
    expect(await manager.resume(second.id, "next", undefined, { isBackground: true, onStarted })).toBe(second);
    await manager.resume(third.id, "last", undefined, { isBackground: true });
    expect(second.status).toBe("queued");
    expect(third.status).toBe("queued");
    expect(onStarted).not.toHaveBeenCalled();
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    if (settlement === "stop") {
      manager.abort(first.id);
      expect(second.status).toBe("queued");
      expect(onComplete).not.toHaveBeenCalled();
    }
    if (settlement === "reject") active.reject(new Error("failed"));
    else active.resolve(partial);
    await active.done;
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(first);
    expect(first.resultConsumed).toBe(false);
    expect(second.status).toBe("running");
    expect(third.status).toBe("queued");
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(resumeAgent).toHaveBeenCalledTimes(2);
    next.resolve(partial);
    await second.promise;
    expect(third.status).toBe("running");
    expect(onComplete).toHaveBeenCalledTimes(2);
    last.resolve(partial);
    await third.promise;
    expect(onComplete).toHaveBeenCalledTimes(3);
    expect(manager.hasRunning()).toBe(false);
  });

  it.each(["abort", "abortAll", "removeRecord", "dispose"] as const)("detaches queued spawn listeners on %s", async (operation) => {
    const blocker = deferred<RunResult>();
    vi.mocked(runAgent).mockReturnValueOnce(blocker.promise);
    const blockerId = manager.spawn(pi, ctx, "resume-specialist", "block", { description: "block", isBackground: true });
    const blockerRecord = manager.getRecord(blockerId)!;
    const parent = new AbortController();
    const id = manager.spawn(pi, ctx, "resume-specialist", "queue", {
      description: "queue", isBackground: true, signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
    if (operation === "abort") manager.abort(id);
    if (operation === "abortAll") expect(manager.abortAll()).toBe(2);
    if (operation === "removeRecord") {
      record.status = "error";
      manager.clearCompleted();
      expect(manager.getRecord(id)).toBeUndefined();
    }
    if (operation === "dispose") await manager.dispose();
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    blocker.resolve(spawned);
    await blockerRecord.promise;
    await record.startGate;
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("detaches running resume listeners on abortAll and dispose (background=%s)", async (isBackground) => {
    const record = await seed();
    const parent = new AbortController();
    const first = start(record, isBackground, parent.signal);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(1);
    expect(manager.abortAll()).toBe(1);
    expect(first.runnerOptions.signal!.aborted).toBe(true);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    first.resolve(partial);
    await first.done;
    const secondParent = new AbortController();
    const second = start(record, isBackground, secondParent.signal);
    expect(getEventListeners(secondParent.signal, "abort")).toHaveLength(1);
    await manager.dispose();
    expect(getEventListeners(secondParent.signal, "abort")).toHaveLength(0);
    second.resolve(partial);
    await second.done;
  });
});
