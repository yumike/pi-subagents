// The baseline fixture normalizes only the temporary agent-directory path.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDefaultsDisabled } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { setWorktreeIsolationEnabled } from "../src/worktree.js";

const baseline = JSON.parse(readFileSync(
  new URL("./fixtures/compact-description-8ac259d.json", import.meta.url), "utf8",
)) as {
  customAgents: Record<string, string>;
  cases: {
    custom: boolean;
    worktreeIsolation: boolean;
    description: string;
    parameters: unknown;
    workflowDescriptionSha256: string;
  }[];
  workflowParameters: unknown;
};

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    handlers,
  };
}

describe("compact Agent description", () => {
  let tmpDir: string;
  let hermeticAgentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  function setup(settings?: Record<string, unknown>, beforeInstantiate?: () => void) {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-"));
    // Isolate global settings (getAgentDir / ~/.pi) so the dev's real
    // subagents.json cannot leak into the default assertions.
    hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
    process.env.HOME = hermeticAgentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    if (settings) {
      writeFileSync(join(hermeticAgentDir, "subagents.json"), JSON.stringify(settings));
    }
    beforeInstantiate?.();
    process.chdir(tmpDir);

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    };
    return tools;
  }

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    // applySettings only applies keys that are PRESENT, so a subagents.json
    // without `worktreeIsolation` leaves the module singleton wherever the
    // previous test left it. Reset it so each setup()'s settings decide, and
    // so the "default" assertions below really test the default.
    setWorktreeIsolationEnabled(true);
    setDefaultsDisabled(false);
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(hermeticAgentDir, { recursive: true, force: true });
  });

  const normalize = (text: string) => text.split(hermeticAgentDir).join("<agentDir>");

  function writeAgents() {
    mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
    for (const [name, content] of Object.entries(baseline.customAgents)) {
      writeFileSync(join(tmpDir, ".pi", "agents", name + ".md"), content);
    }
  }

  it.each(baseline.cases)(
    "matches base compact bytes and schema (custom=$custom, worktree=$worktreeIsolation)",
    (expected) => {
      const tools = setup({ worktreeIsolation: expected.worktreeIsolation },
        expected.custom ? writeAgents : undefined);
      const agent = tools.get("Agent");
      expect(normalize(agent.description)).toBe(expected.description);
      expect(normalize(JSON.stringify(agent.parameters))).toBe(JSON.stringify(expected.parameters));
      const workflow = tools.get("SubagentWorkflow");
      expect(createHash("sha256").update(workflow.description).digest("hex"))
        .toBe(expected.workflowDescriptionSha256);
      expect(JSON.stringify(workflow.parameters)).toBe(JSON.stringify(baseline.workflowParameters));
    },
  );

  it.each(["full", "compact", "custom", "tiny", true, null])(
    "ignores obsolete mode %j even with both custom description files",
    (toolDescriptionMode) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const content = "IGNORED CUSTOM {{typeList}} {{compactTypeList}} {{agentDir}} {{scheduleGuideline}} {{isolationGuideline}} {{unknown}}";
      try {
        const tools = setup({ toolDescriptionMode }, () => {
          writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), content);
          writeFileSync(join(hermeticAgentDir, "agent-tool-description.md"), content);
        });
        expect(normalize(tools.get("Agent").description)).toBe(baseline.cases[0].description);
        expect(normalize(JSON.stringify(tools.get("Agent").parameters)))
          .toBe(JSON.stringify(baseline.cases[0].parameters));
        expect(warn).not.toHaveBeenCalled();
        for (const dir of [join(tmpDir, ".pi"), hermeticAgentDir]) {
          expect(readFileSync(join(dir, "agent-tool-description.md"), "utf8")).toBe(content);
        }
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("ignores a global custom file without a project override or mode setting", () => {
    const tools = setup(undefined, () => {
      writeFileSync(join(hermeticAgentDir, "agent-tool-description.md"), "GLOBAL CUSTOM");
    });
    expect(normalize(tools.get("Agent").description)).toBe(baseline.cases[0].description);
    expect(readFileSync(join(hermeticAgentDir, "agent-tool-description.md"), "utf8"))
      .toBe("GLOBAL CUSTOM");
  });

  it("does not try reading invalid custom description paths", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = setup({ toolDescriptionMode: "custom" }, () => {
        mkdirSync(join(tmpDir, ".pi", "agent-tool-description.md"));
        mkdirSync(join(hermeticAgentDir, "agent-tool-description.md"));
      });
      expect(normalize(tools.get("Agent").description)).toBe(baseline.cases[0].description);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps workflow descriptions full, model-labelled, and dollar-pattern literal", () => {
    const tools = setup(undefined, writeAgents);
    const workflow: string = tools.get("SubagentWorkflow").description;
    expect(workflow).toContain("- Explore: Custom scout! More detail must survive in workflows. (scout) (Tools: read, grep)");
    expect(workflow).toContain("- literal: Literal $& costs. Later $` and $' and $$ and {{agentDir}} stay literal. (Tools: none)");
    expect(workflow).not.toContain("- disabled:");
    expect(workflow).not.toContain("{{typeList}}");
    const agent: string = tools.get("Agent").description;
    expect(agent).toContain("- Explore: Custom scout! (Tools: read, grep)");
    expect(agent).not.toContain("More detail must survive");
    expect(agent).not.toContain("- disabled:");
    expect(agent).not.toContain("(scout)");
  });

  it("keeps custom agents when default agents are disabled", () => {
    const tools = setup({ disableDefaultAgents: true }, writeAgents);
    for (const name of ["Agent", "SubagentWorkflow"]) {
      expect(tools.get(name).description).toContain("- literal:");
      expect(tools.get(name).description).not.toContain("- general-purpose:");
      expect(tools.get(name).description).not.toContain("- disabled:");
    }
    expect(tools.get("Agent").parameters.properties.subagent_type.description)
      .toContain("Available types: Explore, literal.");
  });

  it("keeps every load-bearing contract in the description or schema", () => {
    const tool = setup().get("Agent");
    const visible = tool.description + "\n" + JSON.stringify(tool.parameters);
    for (const contract of [
      "run_in_background", "resume", "steer_subagent", "worktree", ".pi/agents/",
      "self-contained", "model", "thinking", "inherit_context",
    ]) expect(visible).toContain(contract);
  });

  it("every strategy parameter carries a real explanation", () => {
    const props = setup().get("Agent").parameters.properties;
    for (const name of ["run_in_background", "model", "thinking", "inherit_context"]) {
      expect(props[name].description.length).toBeGreaterThan(40);
    }
    expect(props.model.description).toMatch(/task's complexity, required capabilities, and cost\/latency trade-offs.*not merely the parent's model/);
    expect(props.thinking.description).toMatch(/independently of the parent's effort: lower for bounded mechanical work, higher for difficult analysis or verification/);
  });

  describe("schedulingEnabled gates the schedule parameter", () => {
    const props = (tools: Map<string, any>) =>
      Object.keys(tools.get("Agent").parameters?.properties ?? {});

    it("advertises `schedule` by default", () => {
      expect(props(setup())).toContain("schedule");
    });

    it("removes `schedule` from the tool schema when scheduling is disabled", () => {
      const names = props(setup({ schedulingEnabled: false }));
      expect(names).not.toContain("schedule");
      // The rest of the parameter surface is untouched — this gates one field,
      // not the tool.
      expect(names).toEqual(expect.arrayContaining(["prompt", "description", "subagent_type"]));
    });
  });

  // Undeclared isolation requests are silently downgraded, so stale prose
  // could make the model report a worktree branch that was never created.
  describe("worktreeIsolation gates the isolation parameter and its prose", () => {
    const props = (tools: Map<string, any>) =>
      Object.keys(tools.get("Agent").parameters?.properties ?? {});

    it("advertises `isolation` in schema and prose by default", () => {
      const tools = setup();
      expect(props(tools)).toContain("isolation");
      expect(tools.get("Agent").description).toContain('isolation: "worktree"');
    });

    it("drops both when worktree isolation is disabled", () => {
      const tools = setup({ worktreeIsolation: false });
      const names = props(tools);
      expect(names).not.toContain("isolation");
      expect(tools.get("Agent").description).not.toContain("isolation");
      // One field, not the tool — and the neighbouring gate is unaffected.
      expect(names).toEqual(expect.arrayContaining(["prompt", "description", "subagent_type", "schedule"]));
    });
  });

  // The tool description is the only thing the orchestrator LLM knows about an
  // agent's capabilities before spawning it. `tools: none` and an `ext:`-only
  // `tools:` both parse to zero built-ins (custom-agents.ts parseToolsField),
  // and test/fixtures/.pi/agents/tools-none.md pins that the *runtime* really
  // does drop every built-in. So the description must not claim otherwise —
  // an agent advertised as having `bash` that cannot run `bash` gets routed
  // work it can only fail at.
  describe("tool scope suffix reflects the real built-in set", () => {
    function withAgent(name: string, frontmatter: string, settings?: Record<string, unknown>) {
      const extra = frontmatter ? `${frontmatter}\n` : "";
      return setup(settings, () => {
        mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
        writeFileSync(
          join(tmpDir, ".pi", "agents", `${name}.md`),
          `---\ndescription: ${name} agent.\n${extra}---\n\nBody.\n`,
        );
      });
    }

    it("`tools: none` never claims the full built-in set", () => {
      const tools = withAgent("quiet", "tools: none");
      const desc: string = tools.get("Agent").description;
      expect(desc).not.toContain("- quiet: quiet agent. (Tools: *)");
    });

    it.each(["extensions: false", "isolated: true"])("`tools: none` with %s says none", (restriction) => {
      const tools = withAgent("silent", `tools: none\n${restriction}`);
      expect(tools.get("Agent").description).toContain("- silent: silent agent. (Tools: none)");
    });

    it("`tools: none` with extensions loaded is not described as having no tools", () => {
      // Zero built-ins is not zero tools: test/fixtures/.pi/agents/tools-none.md
      // pins that such an agent still surfaces alpha_read, alpha_write, beta_tool.
      // Saying "none" understates it and routes work away from the only agent
      // that could do it — the mirror of the bug this suffix used to have.
      const tools = withAgent("probe", 'tools: none\nextensions: "./ext-alpha.mjs"');
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- probe: probe agent. (Tools: no built-ins, extension tools only)");
      expect(desc).not.toContain("- probe: probe agent. (Tools: *)");
      expect(desc).not.toContain("- probe: probe agent. (Tools: none)");
    });

    it("an ext:-only `tools:` is described by what it actually has", () => {
      const tools = withAgent("extonly", 'tools: "ext:probe.mjs"');
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- extonly: extonly agent. (Tools: no built-ins, extension tools only)");
      expect(desc).not.toContain("- extonly: extonly agent. (Tools: *)");
    });

    it("an omitted `tools:` still renders as * — absent means all built-ins", () => {
      // Guards the fix from over-correcting: undefined (inherit everything,
      // as the shipped defaults do) is not the same as [] (explicitly zero).
      const tools = withAgent("broad", "");
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- broad: broad agent. (Tools: *)");
    });

    it("a narrowed `tools:` still lists the names it actually has", () => {
      const tools = withAgent("narrow", "tools: read, grep");
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- narrow: narrow agent. (Tools: read, grep)");
    });
  });
});
