/**
 * Agent tool wiring for `resume` + `run_in_background` (#214).
 *
 * The manager-level mechanics live in agent-manager.test.ts; what this file
 * pins down is what the TOOL hands the manager, which is where a detached
 * resume can quietly diverge from a detached spawn.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/output-file.js", async () => {
  const actual = await vi.importActual<typeof import("../src/output-file.js")>("../src/output-file.js");
  return {
    ...actual,
    createOutputFilePath: vi.fn(() => "/tmp/fake-subagent.output"),
    writeInitialEntry: vi.fn(),
    ensureOutputFile: vi.fn(),
    streamToOutputFile: vi.fn(() => vi.fn()),
  };
});

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ensureOutputFile, streamToOutputFile, writeInitialEntry } from "../src/output-file.js";
import { type AgentActivity, buildInvocationTags } from "../src/ui/agent-display.js";
import { FleetList } from "../src/ui/fleet-list.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const emitted: { event: string; payload: any }[] = [];
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn((event: string, payload: any) => { emitted.push({ event, payload }); }),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, emitted };
}

function makeCtx(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "session-1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

/** Flatten a tool result's content blocks to plain text. */
function resultText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("\n");
  return String(content ?? result?.text ?? JSON.stringify(result));
}

/** Pull the agent id out of a background spawn/resume tool result. */
function agentIdOf(result: any): string {
  const id = /Agent ID: (\S+)/.exec(resultText(result))?.[1];
  if (!id) throw new Error(`no agent id in result: ${JSON.stringify(result)}`);
  return id;
}

describe("Agent tool — background resume wiring", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;
  /** The session the spawned agent ends up holding — prior turns already in it. */
  let session: any;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-bg-resume-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-bg-resume-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    process.chdir(cwd);

    session = {
      messages: [
        { role: "user", content: "first task" },
        { role: "assistant", content: [{ type: "text", text: "first answer" }] },
        { role: "user", content: "tool result" },
      ],
      subscribe: vi.fn(() => vi.fn()),
      steer: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      await Promise.resolve();
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed answer" } as any);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  /** Spawn a background agent and let it settle, so it holds a resumable session. */
  async function spawnSettled(tools: Map<string, any>, ctx: any, type = "general-purpose", maxTurns?: number) {
    const res = await tools.get("Agent").execute(
      "spawn-call",
      { prompt: "first task", description: "First task", subagent_type: type, run_in_background: true, max_turns: maxTurns },
      undefined,
      undefined,
      ctx,
    );
    const id = agentIdOf(res);
    await new Promise((r) => setTimeout(r, 0));
    return id;
  }

  // A background spawn deliberately omits the tool-call signal — that signal
  // aborts when the parent turn is interrupted (user Esc), which must not reach
  // an agent the caller has already detached from. A detached resume that
  // forwarded it would die on Esc while background spawns from the same turn
  // kept running.
  it("does not tie the detached run to the tool-call signal", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx);

    let runSignal: AbortSignal | undefined;
    vi.mocked(resumeAgent).mockImplementation((_s: any, _p: any, opts: any) => {
      runSignal = opts.signal;
      return new Promise(() => {}); // never settles — the run is still in flight
    });

    const toolAbort = new AbortController();
    await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: id, run_in_background: true },
      toolAbort.signal,
      undefined,
      ctx,
    );

    expect(runSignal).toBeDefined();
    expect(runSignal!.aborted).toBe(false);

    // The parent turn is interrupted. The detached run must survive it.
    toolAbort.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(runSignal!.aborted).toBe(false);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  // The transcript path is deterministic per agent+session, so the resume lands
  // on the file the previous run wrote. writeInitialEntry truncates it.
  it("appends to the agent's existing transcript instead of truncating it", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx);

    vi.mocked(writeInitialEntry).mockClear();
    vi.mocked(streamToOutputFile).mockClear();

    await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: id, run_in_background: true },
      undefined,
      undefined,
      ctx,
    );

    // Never truncate; ensure the file exists without disturbing its contents.
    expect(writeInitialEntry).not.toHaveBeenCalled();
    expect(ensureOutputFile).toHaveBeenCalled();

    // Streaming is anchored past the turns the session already carries, so the
    // prior conversation is not re-emitted behind the resumed run.
    expect(streamToOutputFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamToOutputFile).mock.calls[0][4]).toBe(3);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  // Resume ignores subagent_type — the record keeps the type it was spawned
  // with — so a "created" event carrying the caller's type would re-register the
  // agent under the wrong one in cross-extension mirrors keyed by id.
  it("reports the record's own type, not the caller's ignored subagent_type", async () => {
    writeFileSync(join(agentDir, "agents", "explorer.md"), `---\ndescription: Explorer agent\n---\n\nExplore.`);
    const { pi, tools, lifecycle, emitted } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx, "general-purpose");

    emitted.length = 0;
    const res = await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Different description", subagent_type: "explorer", resume: id, run_in_background: true },
      undefined,
      undefined,
      ctx,
    );

    const created = emitted.find(e => e.event === "subagents:created");
    expect(created).toBeDefined();
    expect(created!.payload.type).toBe("general-purpose");
    expect(created!.payload.id).toBe(id);
    expect(resultText(res)).toContain("Type: general-purpose");

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  // Detaching hands control back while the record is still running, so nothing
  // stops the model from resuming the same agent again. The second resume must
  // be refused with a message it can act on — not started, and not reported as
  // a generic failure.
  it("refuses a second background resume while the first run is in flight", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx);

    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    vi.mocked(resumeAgent).mockClear();

    const params = { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: id, run_in_background: true };
    await tools.get("Agent").execute("resume-1", params, undefined, undefined, ctx);
    const second = await tools.get("Agent").execute("resume-2", params, undefined, undefined, ctx);

    expect(resumeAgent).toHaveBeenCalledTimes(1);
    const text = resultText(second);
    expect(text).toContain("still running");
    expect(text).toContain("steer_subagent");

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("accepts an unlimited zero budget in the Agent schema", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const params = { subagent_type: "general-purpose", prompt: "Continue", description: "Continue", resume: "existing", max_turns: 0 };
    expect(Value.Check(tools.get("Agent").parameters, params)).toBe(true);
    expect(Value.Check(tools.get("Agent").parameters, { ...params, max_turns: -1 })).toBe(false);
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  describe.each([false, true])("fresh spawn budgets (background=%s)", (background) => {
    it.each([
      { frontmatter: undefined, explicit: 0, stored: 0, expected: 0 },
      { frontmatter: 0, explicit: 4, stored: 0, expected: 0 },
      { frontmatter: undefined, explicit: 7, stored: 7, expected: 7 },
      { frontmatter: undefined, explicit: undefined, stored: undefined, expected: 23 },
    ])("retains $frontmatter / $explicit through spawn and later resume", async ({ frontmatter, explicit, stored, expected }) => {
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultMaxTurns: 23 }));
      const path = join(agentDir, "agents", "actual.md");
      writeFileSync(path, `---\ndescription: Actual\n${frontmatter === undefined ? "" : `max_turns: ${frontmatter}\n`}---\nWork.`);
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      const ctx = makeCtx(cwd);
      const spawn = vi.spyOn(AgentManager.prototype, "spawn");

      try {
        const result = await tools.get("Agent").execute("spawn", {
          subagent_type: "actual", prompt: "First task", description: "First task", max_turns: explicit, run_in_background: background,
        }, undefined, undefined, ctx);
        const manager = spawn.mock.contexts[0] as AgentManager;
        const record = manager.getRecord(result.details.agentId)!;
        await record.promise;

        expect(runAgent).toHaveBeenCalledWith(ctx, "actual", "First task", expect.objectContaining({ maxTurns: expected }));
        expect(record.invocation?.maxTurns).toBe(stored);
        const budgetTags = stored === undefined || stored === 0 ? [] : [`max turns: ${stored}`];
        expect(buildInvocationTags(record.invocation).tags.filter(tag => tag.startsWith("max turns:"))).toEqual(budgetTags);
        expect((result.details.tags ?? []).filter((tag: string) => tag.startsWith("max turns:"))).toEqual(budgetTags);
        if (!background) expect(result.details.maxTurns).toBe(expected === 0 ? undefined : expected);

        writeFileSync(path, "---\ndescription: Actual\n---\nWork.");
        await tools.get("Agent").execute("resume", {
          resume: record.id, subagent_type: "actual", prompt: "Continue", description: "Continue", run_in_background: background,
        }, undefined, undefined, ctx);
        await record.promise;

        expect(resumeAgent).toHaveBeenCalledWith(session, "Continue", expect.objectContaining({ maxTurns: stored }));
        expect(record.invocation?.maxTurns).toBe(stored);
      } finally {
        await lifecycle.get("session_shutdown")?.({}, ctx);
      }
    });
  });

  describe.each([false, true])("resume budgets (background=%s)", (background) => {
    it.each([
      { frontmatter: 7, explicit: 4, stored: 11, expected: 7 },
      { frontmatter: 7, explicit: 0, stored: 11, expected: 7 },
      { frontmatter: 0, explicit: 4, stored: 11, expected: 0 },
      { frontmatter: undefined, explicit: 4, stored: 11, expected: 4 },
      { frontmatter: undefined, explicit: 0, stored: 11, expected: 0 },
      { frontmatter: undefined, explicit: undefined, stored: 11, expected: 11 },
      { frontmatter: undefined, explicit: undefined, stored: undefined, expected: undefined },
    ])("actual type precedence: $frontmatter / $explicit / $stored", async ({ frontmatter, explicit, stored, expected }) => {
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultMaxTurns: 23 }));
      const actualPath = join(agentDir, "agents", "actual.md");
      writeFileSync(actualPath, "---\ndescription: Actual\n---\nWork.");
      writeFileSync(join(agentDir, "agents", "ignored.md"), `---\ndescription: Ignored\nmax_turns: 97\nrun_in_background: ${!background}\n---\nOther.`);
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      const ctx = makeCtx(cwd);
      const id = await spawnSettled(tools, ctx, "actual", stored);
      writeFileSync(actualPath, `---\ndescription: Actual\n${frontmatter === undefined ? "" : `max_turns: ${frontmatter}\n`}---\nWork.`);
      const resume = vi.spyOn(AgentManager.prototype, "resume");
      const fleetTimer = vi.spyOn(FleetList.prototype, "ensureTimer");
      vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options) => {
        options?.onTurnEnd?.(3);
        return { text: "continued", aborted: false, steered: false };
      });

      const result = await tools.get("Agent").execute("resume", {
        resume: id, subagent_type: "ignored", prompt: "Continue", description: "Continue", max_turns: explicit, run_in_background: background,
      }, undefined, undefined, ctx);

      expect(resume).toHaveBeenCalledWith(id, "Continue", undefined, expect.objectContaining({ maxTurns: expected, onTurnEnd: expect.any(Function) }));
      expect(result.details.subagentType).toBe("actual");
      if (background) {
        expect(resultText(result)).toContain("resumed in background");
        const activity = (fleetTimer.mock.contexts[0] as unknown as { agentActivity: Map<string, AgentActivity> }).agentActivity;
        expect(activity.get(id)).toMatchObject({ turnCount: 3, maxTurns: expected === 0 ? undefined : expected ?? 23 });
      } else {
        expect(result.details).toMatchObject({ turnCount: 3, maxTurns: expected === 0 ? undefined : expected ?? 23 });
      }
      await lifecycle.get("session_shutdown")?.({}, ctx);
    });
  });

  it.each([undefined, 0, 5])("live mentions reload the actual type and retain its stored budget (%s)", async (frontmatter) => {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultMaxTurns: 23 }));
    const path = join(agentDir, "agents", "actual.md");
    writeFileSync(path, "---\ndescription: Actual\n---\nWork.");
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    ctx.mode = "tui";
    const id = await spawnSettled(tools, ctx, "actual", 11);
    writeFileSync(path, `---\ndescription: Actual\n${frontmatter === undefined ? "" : `max_turns: ${frontmatter}\n`}---\nWork.`);
    const resume = vi.spyOn(AgentManager.prototype, "resume");

    const result = await lifecycle.get("input")({ source: "interactive", text: "@actual Continue" }, ctx);

    expect(result).toEqual({ action: "handled" });
    expect(resume).toHaveBeenCalledWith(id, "Continue", undefined, expect.objectContaining({ isBackground: true, maxTurns: frontmatter ?? 11, onTurnEnd: expect.any(Function) }));
    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it.each([false, true])("tracks inline progress and cleans up on completion/error (%s)", async (fails) => {
    const { pi, tools, lifecycle, emitted } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const fleetTimer = vi.spyOn(FleetList.prototype, "ensureTimer");
    const id = await spawnSettled(tools, ctx);
    const activity = (fleetTimer.mock.contexts[0] as unknown as { agentActivity: Map<string, AgentActivity> }).agentActivity;
    fleetTimer.mockClear();
    const fleetFinished = vi.spyOn(FleetList.prototype, "onAgentFinished");
    const onUpdate = vi.fn();
    emitted.length = 0;
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options) => {
      expect(activity.get(id)).toMatchObject({ turnCount: 1, maxTurns: 8, session, toolUses: 0 });
      options?.onTurnEnd?.(4);
      options?.onToolActivity?.({ type: "start", toolName: "read" });
      expect(activity.get(id)?.activeTools.size).toBe(1);
      options?.onToolActivity?.({ type: "end", toolName: "read" });
      expect(activity.get(id)).toMatchObject({ turnCount: 4, maxTurns: 8, session, toolUses: 1 });
      expect(activity.get(id)?.activeTools.size).toBe(0);
      if (fails) throw new Error("provider failed");
      return { text: "inline answer", aborted: false, steered: false };
    });

    const result = await tools.get("Agent").execute("resume", {
      resume: id, subagent_type: "general-purpose", prompt: "Continue", description: "Continue", max_turns: 8, run_in_background: false,
    }, undefined, onUpdate, ctx);

    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ turnCount: 1, maxTurns: 8, toolUses: 0, status: "running" }) }));
    expect(resultText(result)).toContain(fails ? "provider failed" : "inline answer");
    expect(result.details).toMatchObject({ turnCount: 4, maxTurns: 8, toolUses: 1, status: fails ? "error" : "completed" });
    expect(fleetTimer).toHaveBeenCalled();
    expect(fleetFinished).toHaveBeenCalledWith(id);
    expect(activity.has(id)).toBe(false);
    expect(emitted.filter(e => e.event === "subagents:completed" || e.event === "subagents:failed")).toEqual([]);
    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it.each([
    { status: "steered", note: " (wrapped up at the turn limit — everything the agent produced is above; the task may be unfinished)" },
    { status: "aborted", note: " (aborted at the turn limit — everything the agent produced is above; the task is unfinished)" },
    { status: "stopped", note: " (STOPPED BY THE USER — everything the agent produced is above; the task is unfinished)" },
    { status: "completed", note: "" },
  ])("returns the inline $status outcome to the model after its output", async ({ status, note }) => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx);
    const toolAbort = new AbortController();
    vi.mocked(resumeAgent).mockImplementation(async () => {
      if (status === "stopped") toolAbort.abort();
      return { text: " \ninline answer\n ", aborted: status === "aborted", steered: status === "steered" };
    });

    try {
      const result = await tools.get("Agent").execute("resume", {
        resume: id, subagent_type: "general-purpose", prompt: "Continue", description: "Continue", run_in_background: false,
      }, toolAbort.signal, undefined, ctx);

      expect(resultText(result)).toBe(`inline answer${note}`);
      expect(result.details.status).toBe(status);
    } finally {
      await lifecycle.get("session_shutdown")?.({}, ctx);
    }
  });

  it("cleans up inline activity even when manager.resume rejects", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx);
    const fleetTimer = vi.spyOn(FleetList.prototype, "ensureTimer");
    const fleetFinished = vi.spyOn(FleetList.prototype, "onAgentFinished");
    vi.spyOn(AgentManager.prototype, "resume").mockRejectedValueOnce(new Error("resume failed"));

    await expect(tools.get("Agent").execute("resume", {
      resume: id, subagent_type: "general-purpose", prompt: "Continue", description: "Continue", run_in_background: false,
    }, undefined, undefined, ctx)).rejects.toThrow("resume failed");

    const activity = (fleetTimer.mock.contexts[0] as unknown as { agentActivity: Map<string, AgentActivity> }).agentActivity;
    expect(activity.has(id)).toBe(false);
    expect(fleetFinished).toHaveBeenCalledWith(id);
    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  // Resume follows the same default as a fresh spawn — background — so
  // foreground is now the explicit case rather than the implicit one.
  it("still resumes in the foreground when run_in_background is false", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    const id = await spawnSettled(tools, ctx);

    vi.mocked(resumeAgent).mockResolvedValue({ text: "inline answer" } as any);
    const res = await tools.get("Agent").execute(
      "resume-call",
      { prompt: "keep going", description: "Keep going", subagent_type: "general-purpose", resume: id, run_in_background: false },
      undefined,
      undefined,
      ctx,
    );

    // Foreground resume returns the answer inline — no background handoff text.
    expect(resultText(res)).toContain("inline answer");
    expect(resultText(res)).not.toContain("You will be notified");

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
