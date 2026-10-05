/**
 * usage-reaches-session-stats.e2e.test.ts — the premise #193 rests on, checked
 * against the REAL pi runtime.
 *
 * Every unit test for usage reporting asserts that our tool results carry a
 * `usage` field. None of them can establish the thing that makes carrying it
 * worth doing: that pi picks it up. That happens entirely inside pi —
 * `createToolResultMessage` copies `AgentToolResult.usage` onto the persisted
 * message, and `getSessionStats()` folds `toolResult.usage` into the tokens and
 * cost the footer, the statusline and `/cost` read. Mock pi, and a release that
 * stopped doing either would leave the whole feature reporting into a void with
 * a green suite.
 *
 * So this drives a real `AgentSession` and reads its real `getSessionStats()`,
 * with the exact object `PendingUsagePool.drain()` produces — including the
 * `cacheRead` our own display total drops but this report must carry, and the
 * cost breakdown whose `total` pi reads with no guard at all.
 *
 * No network/LLM and no model turn: the message is appended through pi's own
 * `sessionManager.appendMessage`, because what is under test is the accounting,
 * not the streaming that would normally produce the message.
 *
 * This regression runs unconditionally to ensure reported child usage
 * contributes to parent token and cost totals.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingUsagePool } from "../../src/usage.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

// Real pi session construction; a cold first run under full-suite CPU
// contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

describe("subagent usage reaches the parent session's stats (real pi)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-usage-e2e-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  /** A real session, in memory, on a faux model. */
  async function realSession() {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      model,
      modelRegistry: backend.modelRegistry,
      modelRuntime: backend.modelRuntime,
      tools: [],
    } as Parameters<typeof createAgentSession>[0]);
    return session;
  }

  /** The tool result our `Agent` tool returns, as pi would persist it. */
  function toolResultCarrying(usage: ToolResultMessage["usage"]): ToolResultMessage {
    return {
      role: "toolResult" as const,
      toolCallId: "tc-1",
      toolName: "Agent",
      content: [{ type: "text" as const, text: "Agent completed." }],
      isError: false,
      timestamp: 1,
      usage,
    };
  }

  it("pi adds our reported tokens and cost to getSessionStats()", async () => {
    const session = await realSession();
    try {
      const before = session.getSessionStats();

      const pool = new PendingUsagePool();
      pool.add({ input: 1000, output: 400, cacheWrite: 100, cacheRead: 9000, cost: 0.0123 });
      pool.add({ input: 2000, output: 600, cacheWrite: 200, cacheRead: 18_000, cost: 0.0077 });
      const usage = pool.drain();

      session.sessionManager.appendMessage(toolResultCarrying(usage));
      const after = session.getSessionStats();

      // Exactly what we reported, on every component pi tracks — cacheRead
      // included, which is the one pi counts for its own messages and our own
      // display total leaves out.
      expect(after.tokens.input - before.tokens.input).toBe(3000);
      expect(after.tokens.output - before.tokens.output).toBe(1000);
      expect(after.tokens.cacheWrite - before.tokens.cacheWrite).toBe(300);
      expect(after.tokens.cacheRead - before.tokens.cacheRead).toBe(27_000);

      // The cost: the whole point of the feature for anyone watching a
      // statusline. `addUsageToTotals` reads `usage.cost.total` with no guard,
      // so an incomplete object would have thrown before reaching here.
      expect(after.cost - before.cost).toBeCloseTo(0.02, 10);
    } finally {
      session.dispose?.();
    }
  });

  it("leaves the context-window percentage alone", async () => {
    // Returned text consumes parent context; reported child usage must not.
    // Compare identical nonempty transcripts, differing only in reported usage.
    const session = await realSession();
    const baseline = await realSession();
    try {
      baseline.sessionManager.appendMessage(toolResultCarrying(undefined));
      const before = baseline.getSessionStats().contextUsage?.percent ?? null;
      expect(before).toBeGreaterThan(0);

      const pool = new PendingUsagePool();
      pool.add({ input: 150_000, output: 400, cacheWrite: 100, cost: 1.5 });
      session.sessionManager.appendMessage(toolResultCarrying(pool.drain()));

      expect(session.getSessionStats().contextUsage?.percent ?? null).toBe(before);
    } finally {
      session.dispose?.();
      baseline.dispose?.();
    }
  });

  it("counts nothing for a tool result that carries no usage", async () => {
    // The `reportUsage: false` shape, and every other tool in the session.
    const session = await realSession();
    try {
      const before = session.getSessionStats();
      session.sessionManager.appendMessage(toolResultCarrying(undefined));
      const after = session.getSessionStats();

      expect(after.tokens.input).toBe(before.tokens.input);
      expect(after.cost).toBe(before.cost);
    } finally {
      session.dispose?.();
    }
  });
});
