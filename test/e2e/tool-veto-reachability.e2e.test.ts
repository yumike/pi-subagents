import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAgent, runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";

vi.setConfig({ testTimeout: 30_000 });

describe("tool scope through Pi's real execution pipeline", () => {
  let cwd: string;
  let session: AgentSession | undefined;
  let runtime: ModelRuntime;
  let faux: ReturnType<typeof fauxProvider>;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-veto-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
    runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    faux = fauxProvider({ models: [{ id: "scope", contextWindow: 200_000 }] });
    runtime.registerNativeProvider(faux.provider);
  });

  afterEach(() => {
    session?.dispose();
    registerAgents(new Map());
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  async function run(activateDeferred = false) {
    const calls = join(cwd, "calls");
    writeFileSync(calls, "");
    const targets = join(cwd, "targets.mjs");
    writeFileSync(targets, `
      import { appendFileSync } from 'node:fs';
      export default function(pi) {
        pi.on('before_agent_start', () => {
          for (const [name, exposure, defaultActive] of [
            ['allowed_late', 'deferred'], ['blocked_late', 'deferred'],
            ['allowed_code', 'codemode'], ['blocked_code', 'codemode'],
            ['blocked_direct', 'direct'], ['permission_denied', 'deferred'],
            ['inactive_direct', 'direct', false]
          ]) pi.registerTool({ name, label: name, description: name, exposure, defaultActive,
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              appendFileSync(${JSON.stringify(calls)}, name + '\\n');
              return { content: [{ type: 'text', text: name }], details: undefined };
            }
          });
        });
        pi.on('before_agent_start', () => {
          if (${activateDeferred}) pi.setActiveTools([...pi.getActiveTools(), 'allowed_late']);
        });
        pi.on('tool_call', event => {
          if (event.toolName === 'permission_denied') return { block: true, reason: 'permission gate' };
        });
      }
    `);
    const bridge = join(cwd, "bridge.mjs");
    writeFileSync(bridge, `
      export default function(pi) {
        pi.registerTool({ name: 'bridge', label: 'bridge', description: 'Call nested tools',
          parameters: { type: 'object', properties: {} },
          execute: async (_id, _args, _signal, _update, ctx) => {
            const results = {};
            for (const name of ['allowed_late', 'blocked_late', 'allowed_code', 'blocked_code', 'permission_denied']) {
              try { results[name] = await ctx.executeTool(name, {}); }
              catch (error) { results[name] = String(error); }
            }
            return { content: [{ type: 'text', text: JSON.stringify(results) }], details: results };
          }
        });
      }
    `);
    registerAgents(new Map([["scope", {
      name: "scope", description: "scope", builtinToolNames: [],
      extensions: [targets, bridge], skills: false, persistSession: false,
      extSelectors: ["ext:bridge.mjs", "ext:targets.mjs/allowed_late", "ext:targets.mjs/allowed_code", "ext:targets.mjs/permission_denied", "ext:targets.mjs/inactive_direct"],
      systemPrompt: "Test tools.", promptMode: "replace", inheritContext: false, runInBackground: false, isolated: false,
    }]]));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bridge", {}), fauxToolCall("blocked_direct", {})]),
      fauxAssistantMessage("done"),
    ]);
    const ctx = { cwd, model: faux.getModel(), modelRegistry: new ModelRegistry(runtime), getSystemPrompt: () => "parent" } as ExtensionContext;
    const result = await runAgent(ctx, "scope", "go", {
      pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI,
      onSessionCreated: s => { session = s; },
    });
    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("done");
    return { calls, session: result.session };
  }

  it("blocks direct and nested out-of-scope late tools without replacing permission handlers", async () => {
    const { calls, session } = await run();
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["allowed_late", "allowed_code"]);
    const results = session.messages.filter(m => m.role === "toolResult");
    expect(results.find(m => m.toolName === "blocked_direct")?.isError).toBe(true);
    const bridge = results.find(m => m.toolName === "bridge");
    expect(JSON.stringify(bridge?.content)).toContain('not available to this subagent');
    expect(JSON.stringify(bridge?.content)).toContain("permission gate");

    faux.setResponses([fauxAssistantMessage(fauxToolCall("bridge", {})), fauxAssistantMessage("resumed")]);
    expect((await resumeAgent(session, "again")).text).toBe("resumed");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["allowed_late", "allowed_code", "allowed_late", "allowed_code"]);
  });

  it("does not promote allowed indirect or default-inactive tools into direct declarations", async () => {
    const { session } = await run();
    expect(session.getActiveToolNames()).toEqual(["bridge"]);
    expect(session.getAllTools().map(t => t.name)).toEqual(expect.arrayContaining(["allowed_late", "allowed_code", "inactive_direct"]));
  });

  it("retains an already activated in-scope deferred tool", async () => {
    const { session } = await run(true);
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["bridge", "allowed_late"]));
    expect(session.getActiveToolNames()).not.toContain("allowed_code");
    expect(session.getActiveToolNames()).not.toContain("inactive_direct");
  });
});
