import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunOptions, resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

vi.setConfig({ testTimeout: 30_000 });

describe("Pi built-in extensions in subagent sessions", () => {
  let cwd: string;
  let agentDir: string;
  let session: AgentSession | undefined;
  let runtime: ModelRuntime;
  let faux: ReturnType<typeof fauxProvider>;
  let originalArgv: string[];

  beforeEach(async () => {
    originalArgv = process.argv;
    process.argv = [process.execPath, "pi"];
    cwd = mkdtempSync(join(tmpdir(), "subagents-builtins-"));
    agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    faux = fauxProvider({ models: [{ id: "builtin-test", contextWindow: 200_000 }] });
    runtime.registerNativeProvider(faux.provider);
  });

  afterEach(async () => {
    process.argv = originalArgv;
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      session = undefined;
    }
    registerAgents(new Map());
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  async function run(config: Partial<AgentConfig> = {}, isolated?: boolean, options: Pick<RunOptions, "cwd" | "configCwd" | "onToolActivity" | "nested"> & { projectTrusted?: boolean } = {}) {
    const { projectTrusted = true, ...runOptions } = options;
    registerAgents(new Map([["builtin-test", {
      name: "builtin-test", description: "builtin-test", builtinToolNames: ["read"],
      extensions: true, skills: false, persistSession: false,
      systemPrompt: "Test tools.", promptMode: "replace", inheritContext: false, runInBackground: false,
      ...config,
    }]]));
    const ctx = { cwd, model: faux.getModel(), modelRegistry: new ModelRegistry(runtime), getSystemPrompt: () => "parent", isProjectTrusted: () => projectTrusted } as ExtensionContext;
    const result = await runAgent(ctx, "builtin-test", "go", {
      pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI,
      isolated, ...runOptions, onSessionCreated: s => { session = s; },
    });
    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("done");
    return result.session;
  }

  function configureMcpServer(configDir = agentDir, name = "local") {
    mkdirSync(configDir, { recursive: true });
    const calls = join(configDir, `${name}-calls`);
    writeFileSync(calls, "");
    writeFileSync(`${calls}.startup`, "");
    const server = join(configDir, `${name}-server.mjs`);
    writeFileSync(server, `
      import { createInterface } from 'node:readline';
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(`${calls}.startup`)}, 'STARTUP\\n');
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
    writeFileSync(join(configDir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: {
      command: process.execPath, args: [server], exposure: "direct",
      toolExposure: { deferred: "deferred", scripted: "codemode", hidden: "hidden" },
    } } }));
    return calls;
  }

  function writeProbe(directory: string, name: string) {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${name}.js`);
    writeFileSync(path, `
      import { appendFileSync } from 'node:fs';
      export default function(pi) {
        appendFileSync(${JSON.stringify(`${path}.factory`)}, 'FACTORY\\n');
        pi.registerTool({ name: ${JSON.stringify(name)}, label: 'probe', description: 'Report execution cwd',
          parameters: { type: 'object', properties: {} },
          execute: async (_id, _args, _signal, _update, ctx) => ({
            content: [{ type: 'text', text: ctx.cwd }], details: undefined
          })
        });
      }
    `);
    return path;
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

  it.each([
    { file: true, option: undefined, nested: false, effective: true },
    { file: true, option: false, nested: false, effective: true },
    { file: false, option: true, nested: false, effective: false },
    { file: false, option: true, nested: true, effective: true },
    { file: true, option: false, nested: true, effective: false },
  ])("resolves file isolated=$file, option=$option, nested=$nested for native extensions", async ({ file, option, nested, effective }) => {
    const calls = configureMcpServer();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["+codemode", "+tool_search"] }));
    faux.setResponses(effective ? [fauxAssistantMessage("done")] : [
      fauxAssistantMessage([
        fauxToolCall("codemode", { code: "text('native result');" }),
        fauxToolCall("mcp__local__direct", {}),
      ]),
      fauxAssistantMessage("done"),
    ]);

    const s = await run({ isolated: file }, option, { nested });

    expect(s.extensionRunner.getExtensionPaths().filter(path => path.startsWith("builtin:")).sort()).toEqual(
      effective ? [] : ["builtin:codemode", "builtin:mcp", "builtin:tool-search"],
    );
    if (effective) {
      expect(s.getAllTools().map(tool => tool.name)).toEqual(["read"]);
      expect(s.getActiveToolNames()).toEqual(["read"]);
      expect(readFileSync(calls, "utf8")).toBe("");
    } else {
      expect(s.getActiveToolNames()).toEqual(expect.arrayContaining(["codemode", "tool_search", "mcp__local__direct"]));
      const results = s.messages.filter(message => message.role === "toolResult");
      expect(results.filter(result => result.isError)).toEqual([]);
      expect(JSON.stringify(results.find(result => result.toolName === "codemode")?.content)).toContain("native result");
      expect(readFileSync(calls, "utf8")).toBe("direct\n");
    }
  });

  it("enforces ext:builtin:mcp narrowing inside native codemode and after tool search", async () => {
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
    const s = await run({ extSelectors: ["ext:builtin:mcp/mcp__local__scripted", "ext:builtin:codemode", "ext:builtin:tool-search"] });
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

    const s = await run({ extensions: ["builtin:codemode"] });

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
    { config: { excludeExtensions: ["BUILTIN:MCP"] }, isolated: false },
    { config: { extensions: ["builtin:codemode", "builtin:tool-search"] }, isolated: false },
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

  it("warns when builtin:mcp is explicitly selected with a separate config directory", async () => {
    const target = join(cwd, "target");
    mkdirSync(target);
    const warnings: string[] = [];
    faux.setResponses([fauxAssistantMessage("done")]);
    const s = await run({ extensions: ["builtin:mcp"] }, false, {
      cwd: target, configCwd: cwd,
      onToolActivity: activity => { if (activity.toolName.startsWith("extension-error:")) warnings.push(activity.toolName); },
    });
    expect(s.extensionRunner.getExtensionPaths()).not.toContain("builtin:mcp");
    expect(warnings).toContainEqual(expect.stringMatching(/native MCP.*separate config directory/i));
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
    { config: { extensions: ["BUILTIN:MCP"] }, isolated: false, settings: {}, paths: ["builtin:mcp"], tools: ["read"] },
    { config: { extensions: ["builtin:codemode", "builtin:tool-search"], extSelectors: ["ext:builtin:tool-search/tool_search"] }, isolated: false, settings: { defaultTools: ["+codemode", "+tool_search"] }, paths: ["builtin:codemode", "builtin:tool-search"], tools: ["read", "tool_search"] },
    { config: { excludeExtensions: ["BUILTIN:MCP", "builtin:codemode"] }, isolated: false, settings: {}, paths: ["builtin:tool-search"], tools: ["read"] },
    { config: { extensions: ["mcp", "codemode", "tool-search"] }, isolated: false, settings: {}, paths: [], tools: ["read"] },
    { config: { extensions: false }, isolated: false, settings: {}, paths: [], tools: ["read"] },
    { config: { extSelectors: ["ext:builtin:mcp"] }, isolated: true, settings: {}, paths: [], tools: ["read"] },
    { config: {}, isolated: false, settings: { extensions: ["-builtin:mcp", "-builtin:tool-search"] }, paths: ["builtin:codemode"], tools: ["read"] },
  ])("honors extension selection and Pi settings: $config / $settings / isolated=$isolated", async ({ config, isolated, settings, paths, tools }) => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
    faux.setResponses([fauxAssistantMessage("done")]);
    const s = await run(config, isolated);
    expect(s.extensionRunner.getExtensionPaths().filter(p => p.startsWith("builtin:")).sort()).toEqual([...paths].sort());
    expect(s.getActiveToolNames()).toEqual(tools);
  });

  it.each([true, false])("inherits parent project trust=%s for settings and native defaultTools", async projectTrusted => {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "codemode"] }));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read", "tool_search"] }));
    faux.setResponses([fauxAssistantMessage("done")]);

    const s = await run({}, false, { projectTrusted });

    expect(s.settingsManager.isProjectTrusted()).toBe(projectTrusted);
    expect(s.settingsManager.getDefaultTools()).toEqual(["read", projectTrusted ? "tool_search" : "codemode"]);
    expect(s.getActiveToolNames()).toEqual(["read", projectTrusted ? "tool_search" : "codemode"]);
    expect(s.extensionRunner.getExtensionPaths()).toEqual(expect.arrayContaining(["builtin:codemode", "builtin:tool-search"]));
  });

  it.each([
    { projectTrusted: true, configured: false },
    { projectTrusted: false, configured: false },
    { projectTrusted: true, configured: true },
    { projectTrusted: false, configured: true },
  ])("gates project extension factories, not global resources: trust=$projectTrusted configured=$configured", async ({ projectTrusted, configured }) => {
    const global = writeProbe(join(agentDir, "extensions"), "global_probe");
    const globalConfigured = writeProbe(join(cwd, "global-configured"), "global_configured");
    const project = writeProbe(join(cwd, configured ? "project-configured" : ".pi/extensions"), "project_probe");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [globalConfigured] }));
    if (configured) writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: [project] }));
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("global_probe", {}), fauxToolCall("global_configured", {}),
        ...(projectTrusted ? [fauxToolCall("project_probe", {})] : []),
      ]),
      fauxAssistantMessage("done"),
    ]);

    const s = await run({}, false, { projectTrusted });

    expect(readFileSync(`${global}.factory`, "utf8")).toBe("FACTORY\n");
    expect(readFileSync(`${globalConfigured}.factory`, "utf8")).toBe("FACTORY\n");
    expect(existsSync(`${project}.factory`)).toBe(projectTrusted);
    expect(s.extensionRunner.getExtensionPaths().includes(project)).toBe(projectTrusted);
    expect(s.getAllTools().some(tool => tool.name === "project_probe")).toBe(projectTrusted);
    const results = s.messages.filter(message => message.role === "toolResult");
    expect(results).toHaveLength(projectTrusted ? 3 : 2);
    expect(results.every(result => !result.isError)).toBe(true);
  });

  it.each([true, false])("gates project MCP process startup while retaining global MCP with trust=%s", async projectTrusted => {
    const globalCalls = configureMcpServer();
    const projectCalls = configureMcpServer(join(cwd, ".pi"), "project");
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("mcp__local__direct", {}),
        ...(projectTrusted ? [fauxToolCall("mcp__project__direct", {})] : []),
      ]),
      fauxAssistantMessage("done"),
    ]);

    const s = await run({}, false, { projectTrusted });

    expect(readFileSync(`${globalCalls}.startup`, "utf8")).toBe("STARTUP\n");
    expect(readFileSync(globalCalls, "utf8")).toBe("direct\n");
    expect(readFileSync(`${projectCalls}.startup`, "utf8")).toBe(projectTrusted ? "STARTUP\n" : "");
    expect(readFileSync(projectCalls, "utf8")).toBe(projectTrusted ? "direct\n" : "");
    expect(s.getAllTools().some(tool => tool.name === "mcp__project__direct")).toBe(projectTrusted);
    expect(s.messages.filter(message => message.role === "toolResult" && message.isError)).toEqual([]);
  });

  it.each(["-ne", "--no-extensions"])("%s suppresses discovery, settings extensions and native name filters", async flag => {
    process.argv.push(flag);
    const global = writeProbe(join(agentDir, "extensions"), "global_probe");
    const project = writeProbe(join(cwd, ".pi", "extensions"), "project_probe");
    const globalConfigured = writeProbe(join(cwd, "global-configured"), "global_configured");
    const projectConfigured = writeProbe(join(cwd, "project-configured"), "project_configured");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [globalConfigured, "+builtin:mcp"], defaultTools: ["+codemode", "+tool_search"] }));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: [projectConfigured, "+builtin:codemode"] }));
    const globalCalls = configureMcpServer();
    const projectCalls = configureMcpServer(join(cwd, ".pi"), "project");
    faux.setResponses([fauxAssistantMessage("done")]);

    const s = await run({ extensions: ["*", "builtin:mcp", "builtin:codemode", "builtin:tool-search"] });

    for (const path of [global, project, globalConfigured, projectConfigured]) expect(existsSync(`${path}.factory`)).toBe(false);
    expect(s.extensionRunner.getExtensionPaths().filter(path => path.startsWith("builtin:"))).toEqual([]);
    expect(s.getAllTools().filter(tool => ["codemode", "tool_search"].includes(tool.name) || tool.name.startsWith("mcp__"))).toEqual([]);
    expect(s.getActiveToolNames()).toEqual(["read"]);
    for (const calls of [globalCalls, projectCalls]) {
      expect(readFileSync(`${calls}.startup`, "utf8")).toBe("");
      expect(readFileSync(calls, "utf8")).toBe("");
    }
  });

  it.each(["-ne", "--no-extensions"])("%s retains explicit agent paths and real nested/late scope after resume", async flag => {
    process.argv.push(flag);
    const extension = join(cwd, "explicit.js");
    const calls = join(cwd, "explicit-calls");
    writeFileSync(calls, "");
    writeFileSync(extension, `
      import { appendFileSync } from 'node:fs';
      export default function(pi) {
        appendFileSync(${JSON.stringify(`${extension}.factory`)}, 'FACTORY\\n');
        pi.on('before_agent_start', () => {
          for (const name of ['late_allowed', 'late_denied', 'late_blocked']) pi.registerTool({
            name, label: name, description: name, exposure: 'codemode',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              appendFileSync(${JSON.stringify(calls)}, name + '\\n');
              return { content: [{ type: 'text', text: name }], details: undefined };
            }
          });
        });
        pi.registerTool({ name: 'bridge', label: 'bridge', description: 'Call late tools',
          parameters: { type: 'object', properties: {} }, reachesTools: () => 'all',
          execute: async (_id, _args, _signal, _update, ctx) => {
            const results = [];
            for (const name of ['late_allowed', 'late_denied', 'late_blocked']) {
              try { results.push(await ctx.executeTool(name, {})); }
              catch (error) { results.push(String(error)); }
            }
            return { content: [{ type: 'text', text: JSON.stringify(results) }], details: undefined };
          }
        });
      }
    `);
    const responses = () => [
      fauxAssistantMessage(fauxToolCall("bridge", {})),
      fauxAssistantMessage(fauxToolCall("late_denied", {})),
      fauxAssistantMessage("done"),
    ];
    faux.setResponses(responses());

    // Explicit filesystem paths are an SDK trust exception, not project discovery.
    const s = await run({
      extensions: [extension],
      extSelectors: ["ext:explicit/bridge", "ext:explicit/late_allowed", "ext:explicit/late_blocked"],
      disallowedTools: ["late_blocked"],
    }, false, { projectTrusted: false });
    const firstRunLength = s.messages.length;
    faux.setResponses(responses());
    const resumed = await resumeAgent(s, "continue", { type: "builtin-test" });

    expect(resumed.failure).toBeUndefined();
    expect(resumed.text).toBe("done");
    expect(readFileSync(`${extension}.factory`, "utf8")).toBe("FACTORY\n");
    expect(readFileSync(calls, "utf8")).toBe("late_allowed\nlate_allowed\n");
    expect(s.extensionRunner.getExtensionPaths()).toContain(extension);
    expect(s.extensionRunner.getExtensionPaths()).not.toContain("builtin:codemode");
    expect(s.getAllTools().map(tool => tool.name)).toEqual(expect.arrayContaining(["bridge", "late_allowed", "late_denied"]));
    expect(s.getAllTools().map(tool => tool.name)).not.toContain("late_blocked");
    expect(s.getActiveToolNames()).toEqual(["read", "bridge"]);
    for (const messages of [s.messages.slice(0, firstRunLength), s.messages.slice(firstRunLength)]) {
      const results = messages.filter(message => message.role === "toolResult");
      const bridge = results.find(result => result.toolName === "bridge");
      expect(bridge?.isError).toBe(false);
      expect(JSON.stringify(bridge?.content)).toContain("late_allowed");
      expect(JSON.stringify(bridge?.content)).toContain("late_denied");
      expect(JSON.stringify(bridge?.content)).toContain("not available to this subagent");
      expect(results.find(result => result.toolName === "late_denied")?.isError).toBe(true);
    }
  });

  it.each([
    { name: "default", extensions: true, settings: [] },
    { name: "wildcard", extensions: ["*"], settings: [] },
    { name: "native name filter", extensions: ["BUILTIN:MCP"], settings: [] },
    { name: "settings enable", extensions: true, settings: ["+builtin:mcp"] },
  ])("--no-mcp overrides $name without starting either MCP config", async ({ extensions, settings }) => {
    process.argv.push("--no-mcp");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: settings, defaultTools: ["+codemode", "+tool_search"] }));
    const globalCalls = configureMcpServer();
    const projectCalls = configureMcpServer(join(cwd, ".pi"), "project");
    faux.setResponses([fauxAssistantMessage("done")]);

    const s = await run({ extensions });

    expect(s.extensionRunner.getExtensionPaths()).not.toContain("builtin:mcp");
    expect(s.getAllTools().some(tool => tool.name.startsWith("mcp__"))).toBe(false);
    if (extensions === true || (Array.isArray(extensions) && extensions.includes("*"))) {
      expect(s.extensionRunner.getExtensionPaths()).toEqual(expect.arrayContaining(["builtin:codemode", "builtin:tool-search"]));
      expect(s.getActiveToolNames()).toEqual(["read", "codemode", "tool_search"]);
    }
    for (const calls of [globalCalls, projectCalls]) {
      expect(readFileSync(`${calls}.startup`, "utf8")).toBe("");
      expect(readFileSync(calls, "utf8")).toBe("");
    }
  });

  it("--no-mcp retains third-party mcp.js and unrelated project discovery", async () => {
    process.argv.push("--no-mcp");
    const external = writeProbe(join(agentDir, "extensions"), "mcp");
    const project = writeProbe(join(cwd, ".pi", "extensions"), "unrelated");
    const calls = configureMcpServer();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("mcp", {}), fauxToolCall("unrelated", {})]),
      fauxAssistantMessage("done"),
    ]);

    const s = await run();

    expect(readFileSync(`${external}.factory`, "utf8")).toBe("FACTORY\n");
    expect(readFileSync(`${project}.factory`, "utf8")).toBe("FACTORY\n");
    expect(readFileSync(`${calls}.startup`, "utf8")).toBe("");
    expect(s.extensionRunner.getExtensionPaths()).toEqual(expect.arrayContaining([external, project, "builtin:codemode", "builtin:tool-search"]));
    expect(s.extensionRunner.getExtensionPaths()).not.toContain("builtin:mcp");
    const results = s.messages.filter(message => message.role === "toolResult");
    expect(results).toHaveLength(2);
    expect(results.every(result => !result.isError)).toBe(true);
  });

  it.each([
    ["--", "-ne"], ["--", "--no-extensions"], ["--", "--no-mcp"],
    ["--system-prompt", "-ne"], ["--system-prompt", "--no-extensions"], ["--system-prompt", "--no-mcp"],
  ])("does not treat consumed or positional values as switches: %s %s", async (prefix, value) => {
    process.argv.push(prefix, value);
    const global = writeProbe(join(agentDir, "extensions"), "global_probe");
    const project = writeProbe(join(cwd, ".pi", "extensions"), "project_probe");
    const calls = configureMcpServer();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__local__direct", {})), fauxAssistantMessage("done")]);

    const s = await run();

    expect(readFileSync(`${global}.factory`, "utf8")).toBe("FACTORY\n");
    expect(readFileSync(`${project}.factory`, "utf8")).toBe("FACTORY\n");
    expect(readFileSync(`${calls}.startup`, "utf8")).toBe("STARTUP\n");
    expect(readFileSync(calls, "utf8")).toBe("direct\n");
    expect(s.extensionRunner.getExtensionPaths()).toEqual(expect.arrayContaining(["builtin:mcp", "builtin:codemode", "builtin:tool-search"]));
    expect(s.messages.filter(message => message.role === "toolResult" && message.isError)).toEqual([]);
  });

  it.each([false, true])("does not copy parent -e sources into a child, noExtensions=%s", async noExtensions => {
    const parentOnly = writeProbe(join(cwd, "parent-only"), "parent_only");
    const global = writeProbe(join(agentDir, "extensions"), "global_probe");
    process.argv.push("-e", parentOnly, "--extension", "builtin:codemode");
    if (noExtensions) process.argv.push("-ne");
    faux.setResponses([fauxAssistantMessage("done")]);

    const s = await run();

    expect(existsSync(`${parentOnly}.factory`)).toBe(false);
    expect(s.extensionRunner.getExtensionPaths()).not.toContain(parentOnly);
    expect(s.getAllTools().some(tool => tool.name === "parent_only")).toBe(false);
    expect(existsSync(`${global}.factory`)).toBe(!noExtensions);
    expect(s.extensionRunner.getExtensionPaths().includes("builtin:codemode")).toBe(!noExtensions);
  });

  it.each([true, false])("split roots inherit parent config trust=%s but never start target MCP", async projectTrusted => {
    const target = join(cwd, "target");
    const global = writeProbe(join(agentDir, "extensions"), "global_cwd");
    const parent = writeProbe(join(cwd, ".pi", "extensions"), "parent_probe");
    const targetProbe = writeProbe(join(target, ".pi", "extensions"), "target_probe");
    const globalCalls = configureMcpServer();
    const parentCalls = configureMcpServer(join(cwd, ".pi"), "parent");
    const targetCalls = configureMcpServer(join(target, ".pi"), "target");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "codemode"] }));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read", "tool_search"] }));
    writeFileSync(join(target, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["+codemode", "+tool_search"], extensions: ["+builtin:mcp"] }));
    writeFileSync(join(cwd, "location.txt"), "parent content");
    writeFileSync(join(target, "location.txt"), "target content");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "location.txt" }), fauxToolCall("global_cwd", {})]),
      fauxAssistantMessage("done"),
    ]);

    const s = await run({}, false, { cwd: target, configCwd: cwd, projectTrusted });

    expect(s.settingsManager.isProjectTrusted()).toBe(projectTrusted);
    expect(s.settingsManager.getDefaultTools()).toEqual(["read", projectTrusted ? "tool_search" : "codemode"]);
    expect(readFileSync(`${global}.factory`, "utf8")).toBe("FACTORY\n");
    expect(existsSync(`${parent}.factory`)).toBe(projectTrusted);
    expect(existsSync(`${targetProbe}.factory`)).toBe(false);
    expect(s.extensionRunner.getExtensionPaths()).not.toContain("builtin:mcp");
    for (const calls of [globalCalls, parentCalls, targetCalls]) expect(readFileSync(`${calls}.startup`, "utf8")).toBe("");
    const results = s.messages.filter(message => message.role === "toolResult");
    expect(results.filter(result => result.isError)).toEqual([]);
    expect(results.find(result => result.toolName === "read")?.content).toEqual([{ type: "text", text: "target content" }]);
    expect(results.find(result => result.toolName === "global_cwd")?.content).toEqual([{ type: "text", text: target }]);
  });

  it.each(["-ne", "--no-extensions", "--no-mcp"])("%s suppresses the split-root native MCP warning", async flag => {
    process.argv.push(flag);
    const target = join(cwd, "target");
    mkdirSync(target);
    const warnings: string[] = [];
    faux.setResponses([fauxAssistantMessage("done")]);

    const s = await run({}, false, {
      cwd: target, configCwd: cwd,
      onToolActivity: activity => { if (activity.toolName.startsWith("extension-error:")) warnings.push(activity.toolName); },
    });

    expect(s.extensionRunner.getExtensionPaths()).not.toContain("builtin:mcp");
    expect(warnings).toEqual([]);
  });

  it.each([true, false])("worktree-shaped config/execution cwd inherits parent trust=%s", async projectTrusted => {
    const worktree = join(cwd, ".worktrees", "child");
    const project = writeProbe(join(worktree, ".pi", "extensions"), "worktree_probe");
    const global = writeProbe(join(agentDir, "extensions"), "global_cwd");
    const calls = configureMcpServer(join(worktree, ".pi"), "worktree");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "codemode"] }));
    writeFileSync(join(worktree, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read", "tool_search"] }));
    writeFileSync(join(worktree, "location.txt"), "worktree content");
    const warnings: string[] = [];
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("read", { path: "location.txt" }), fauxToolCall("global_cwd", {}),
        ...(projectTrusted ? [fauxToolCall("mcp__worktree__direct", {})] : []),
      ]),
      fauxAssistantMessage("done"),
    ]);

    const s = await run({}, false, {
      cwd: worktree, configCwd: worktree, projectTrusted,
      onToolActivity: activity => { if (activity.toolName.startsWith("extension-error:")) warnings.push(activity.toolName); },
    });

    expect(s.settingsManager.isProjectTrusted()).toBe(projectTrusted);
    expect(s.settingsManager.getDefaultTools()).toEqual(["read", projectTrusted ? "tool_search" : "codemode"]);
    expect(readFileSync(`${global}.factory`, "utf8")).toBe("FACTORY\n");
    expect(existsSync(`${project}.factory`)).toBe(projectTrusted);
    expect(readFileSync(`${calls}.startup`, "utf8")).toBe(projectTrusted ? "STARTUP\n" : "");
    expect(readFileSync(calls, "utf8")).toBe(projectTrusted ? "direct\n" : "");
    expect(s.extensionRunner.getExtensionPaths()).toContain("builtin:mcp");
    expect(warnings).toEqual([]);
    const results = s.messages.filter(message => message.role === "toolResult");
    expect(results.filter(result => result.isError)).toEqual([]);
    expect(results.find(result => result.toolName === "read")?.content).toEqual([{ type: "text", text: "worktree content" }]);
    expect(results.find(result => result.toolName === "global_cwd")?.content).toEqual([{ type: "text", text: worktree }]);
  });
});
