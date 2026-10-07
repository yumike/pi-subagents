import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunOptions, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

vi.setConfig({ testTimeout: 30_000 });

describe("Pi built-in extensions in subagent sessions", () => {
  let cwd: string;
  let agentDir: string;
  let session: AgentSession | undefined;
  let runtime: ModelRuntime;
  let faux: ReturnType<typeof fauxProvider>;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-builtins-"));
    agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    faux = fauxProvider({ models: [{ id: "builtin-test", contextWindow: 200_000 }] });
    runtime.registerNativeProvider(faux.provider);
  });

  afterEach(async () => {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      session = undefined;
    }
    registerAgents(new Map());
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  async function run(config: Partial<AgentConfig> = {}, isolated = false, options: Pick<RunOptions, "cwd" | "configCwd" | "onToolActivity"> = {}) {
    registerAgents(new Map([["builtin-test", {
      name: "builtin-test", description: "builtin-test", builtinToolNames: ["read"],
      extensions: true, skills: false, persistSession: false,
      systemPrompt: "Test tools.", promptMode: "replace", inheritContext: false, runInBackground: false, isolated: false,
      ...config,
    }]]));
    const ctx = { cwd, model: faux.getModel(), modelRegistry: new ModelRegistry(runtime), getSystemPrompt: () => "parent" } as ExtensionContext;
    const result = await runAgent(ctx, "builtin-test", "go", {
      pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI,
      isolated, ...options, onSessionCreated: s => { session = s; },
    });
    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("done");
    return result.session;
  }

  function configureMcpServer() {
    const calls = join(cwd, "calls");
    writeFileSync(calls, "");
    const server = join(cwd, "server.mjs");
    writeFileSync(server, `
      import { createInterface } from 'node:readline';
      import { appendFileSync } from 'node:fs';
      const names = ['direct', 'deferred', 'scripted', 'hidden'];
      createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        let result;
        if (request.method === 'initialize') result = {
          protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: 'local-test', version: '1' }
        };
        else if (request.method === 'tools/list') result = { tools: names.map(name => ({
          name, description: name, inputSchema: { type: 'object', properties: {} }
        })) };
        else if (request.method === 'tools/call') {
          appendFileSync(${JSON.stringify(calls)}, request.params.name + '\\n');
          result = { content: [{ type: 'text', text: request.params.name + ' result' }] };
        } else result = {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      });
    `);
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { local: {
      command: process.execPath, args: [server], exposure: "direct",
      toolExposure: { deferred: "deferred", scripted: "codemode", hidden: "hidden" },
    } } }));
    return calls;
  }

  it("inherits native MCP, codemode and tool search without eagerly declaring deferred tools", async () => {
    const calls = configureMcpServer();
    const declarations: string[][] = [];
    faux.setResponses([
      (_context, _options, _state) => {
        declarations.push(session!.getActiveToolNames());
        return fauxAssistantMessage([
          fauxToolCall("mcp__local__direct", {}),
          fauxToolCall("codemode", { code: "const r = await tools.mcp__local__scripted({}); console.log(r);" }),
          fauxToolCall("tool_search", { query: "deferred", limit: 1 }),
        ]);
      },
      () => {
        declarations.push(session!.getActiveToolNames());
        return fauxAssistantMessage(fauxToolCall("mcp__local__deferred", {}));
      },
      fauxAssistantMessage("done"),
    ]);
    const s = await run();
    expect(s.extensionRunner.getExtensionPaths()).toEqual(expect.arrayContaining(["builtin:mcp", "builtin:codemode", "builtin:tool-search"]));
    expect(declarations[0]).toEqual(expect.arrayContaining(["codemode", "tool_search", "mcp__local__direct"]));
    expect(declarations[0]).not.toContain("mcp__local__deferred");
    expect(declarations[0]).not.toContain("mcp__local__scripted");
    expect(declarations[1]).toContain("mcp__local__deferred");
    expect(declarations[1]).not.toContain("mcp__local__scripted");
    expect(declarations[1]).not.toContain("mcp__local__hidden");
    const results = s.messages.filter(m => m.role === "toolResult");
    expect(results.filter(m => m.isError)).toEqual([]);
    expect(readFileSync(calls, "utf8").trim().split("\n").sort()).toEqual(["deferred", "direct", "scripted"]);
  });

  it("enforces ext:mcp narrowing inside native codemode and after tool search", async () => {
    const calls = configureMcpServer();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("codemode", { code: `
          for (const name of ['mcp__local__direct', 'mcp__local__deferred', 'mcp__local__scripted']) {
            try { text(await tools[name]({})); } catch (error) { text(String(error)); }
          }
        ` }),
        fauxToolCall("tool_search", { query: "deferred", limit: 1 }),
      ]),
      fauxAssistantMessage(fauxToolCall("mcp__local__deferred", {})),
      fauxAssistantMessage("done"),
    ]);
    const s = await run({ extSelectors: ["ext:mcp/mcp__local__scripted", "ext:codemode", "ext:tool-search"] });
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["scripted"]);
    const results = s.messages.filter(m => m.role === "toolResult");
    const script = results.find(m => m.toolName === "codemode");
    expect(script?.isError).toBe(false);
    expect(JSON.stringify(script?.content)).toContain("not available to this subagent");
    expect(results.find(m => m.toolName === "mcp__local__deferred")?.isError).toBe(true);
    expect(s.getActiveToolNames()).not.toContain("mcp__local__deferred");
  });

  it("lets installed replacements supersede the native built-ins", async () => {
    const replacement = join(cwd, "replacement.mjs");
    writeFileSync(replacement, `
      export default function(pi) {
        pi.registerCommand('mcp', { description: 'replacement', handler: async () => {} });
        for (const name of ['codemode', 'tool_search']) pi.registerTool({
          name, label: name, description: 'replacement', parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text', text: 'replacement result' }], details: undefined })
        });
      }
    `);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", {})), fauxAssistantMessage("done")]);
    const s = await run({ extensions: ["*", replacement] });
    expect(s.extensionRunner.getExtensionPaths().filter(p => p.startsWith("builtin:"))).toEqual([]);
    expect(s.messages.filter(m => m.role === "toolResult").map(m => m.content)).toEqual([
      [{ type: "text", text: "replacement result" }],
    ]);
  });

  it("uses native codemode when a conflicting replacement is disabled in Pi settings", async () => {
    const extensionDir = join(agentDir, "extensions");
    mkdirSync(extensionDir);
    const replacement = join(extensionDir, "replacement.js");
    writeFileSync(replacement, `
      export default function(pi) {
        pi.registerTool({ name: 'codemode', label: 'codemode', description: 'replacement',
          parameters: { type: 'object', properties: {} },
          execute: async () => { throw new Error('Replacement must not execute'); }
        });
      }
    `);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      extensions: [`-${replacement}`], defaultTools: ["+codemode"],
    }));
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: "text('native codemode result');" })),
      fauxAssistantMessage("done"),
    ]);

    const s = await run({ extensions: ["codemode"] });

    const result = s.messages.find(m => m.role === "toolResult" && m.toolName === "codemode");
    expect(result).toMatchObject({ isError: false });
    expect(JSON.stringify(result?.content)).toContain("native codemode result");
  });

  it("refuses native MCP across config roots without redirecting ordinary tools", async () => {
    const target = join(cwd, "target");
    const marker = join(cwd, "target-mcp-started");
    mkdirSync(join(target, ".pi"), { recursive: true });
    writeFileSync(join(target, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { forbidden: {
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      exposure: "direct",
    } } }));
    writeFileSync(join(target, "location.txt"), "target content");
    writeFileSync(join(cwd, "location.txt"), "parent content");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "extensions", "probe.js"), `
      export default function(pi) {
        pi.registerTool({ name: 'working_cwd', label: 'cwd', description: 'Report execution cwd',
          parameters: { type: 'object', properties: {} },
          execute: async (_id, _args, _signal, _update, ctx) => ({
            content: [{ type: 'text', text: ctx.cwd }], details: undefined
          })
        });
      }
    `);
    const warnings: string[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "location.txt" }), fauxToolCall("working_cwd", {})]),
      fauxAssistantMessage("done"),
    ]);
    const s = await run({}, false, {
      cwd: target, configCwd: cwd,
      onToolActivity: activity => { if (activity.toolName.startsWith("extension-error:")) warnings.push(activity.toolName); },
    });
    expect(existsSync(marker)).toBe(false);
    expect(s.extensionRunner.getExtensionPaths()).not.toContain("builtin:mcp");
    expect(s.extensionRunner.getExtensionPaths()).toEqual(expect.arrayContaining(["builtin:codemode", "builtin:tool-search"]));
    expect(warnings).toEqual([expect.stringMatching(/extension-error:.*native MCP.*separate config directory/i)]);
    const results = s.messages.filter(m => m.role === "toolResult");
    expect(results.filter(m => m.isError)).toEqual([]);
    expect(results.find(m => m.toolName === "read")?.content).toEqual([{ type: "text", text: "target content" }]);
    expect(results.find(m => m.toolName === "working_cwd")?.content).toEqual([{ type: "text", text: target }]);
  });

  it.each([
    { config: {}, isolated: true },
    { config: { extensions: false }, isolated: false },
    { config: { excludeExtensions: ["MCP"] }, isolated: false },
    { config: { extensions: ["codemode", "tool-search"] }, isolated: false },
  ])("does not warn about split-cwd MCP when already excluded: $config / isolated=$isolated", async ({ config, isolated }) => {
    const target = join(cwd, "target");
    mkdirSync(target);
    const warnings: string[] = [];
    faux.setResponses([fauxAssistantMessage("done")]);
    const s = await run(config, isolated, {
      cwd: target, configCwd: cwd,
      onToolActivity: activity => { if (activity.toolName.startsWith("extension-error:")) warnings.push(activity.toolName); },
    });
    expect(s.extensionRunner.getExtensionPaths()).not.toContain("builtin:mcp");
    expect(warnings).toEqual([]);
  });

  it("accepts a configured builtin MCP disable with a separate config directory", async () => {
    const target = join(cwd, "target");
    mkdirSync(target);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
    faux.setResponses([fauxAssistantMessage("done")]);
    const s = await run({}, false, { cwd: target, configCwd: cwd });
    expect(s.resourceLoader.getExtensions().errors).toEqual([]);
    expect(s.extensionRunner.getExtensionPaths()).not.toContain("builtin:mcp");
    expect(s.getActiveToolNames()).toEqual(["read"]);
  });

  it.each([
    { config: {}, isolated: false, settings: {}, paths: ["builtin:mcp", "builtin:codemode", "builtin:tool-search"], tools: ["read"] },
    { config: { extensions: ["MCP"] }, isolated: false, settings: {}, paths: ["builtin:mcp"], tools: ["read"] },
    { config: { extensions: ["codemode", "tool-search"], extSelectors: ["ext:tool-search/tool_search"] }, isolated: false, settings: { defaultTools: ["+codemode", "+tool_search"] }, paths: ["builtin:codemode", "builtin:tool-search"], tools: ["read", "tool_search"] },
    { config: { excludeExtensions: ["MCP", "codemode"] }, isolated: false, settings: {}, paths: ["builtin:tool-search"], tools: ["read"] },
    { config: { extensions: false }, isolated: false, settings: {}, paths: [], tools: ["read"] },
    { config: { extSelectors: ["ext:mcp"] }, isolated: true, settings: {}, paths: [], tools: ["read"] },
    { config: {}, isolated: false, settings: { extensions: ["-builtin:mcp", "-builtin:tool-search"] }, paths: ["builtin:codemode"], tools: ["read"] },
  ])("honors extension selection and Pi settings: $config / $settings / isolated=$isolated", async ({ config, isolated, settings, paths, tools }) => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
    faux.setResponses([fauxAssistantMessage("done")]);
    const s = await run(config, isolated);
    expect(s.extensionRunner.getExtensionPaths().filter(p => p.startsWith("builtin:")).sort()).toEqual([...paths].sort());
    expect(s.getActiveToolNames()).toEqual(tools);
  });
});
