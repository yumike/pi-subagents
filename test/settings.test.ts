import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAndEmitLoaded, applySettings, loadSettings, type SettingsAppliers } from "../src/settings.js";

describe("read-only global settings", () => {
  let globalDir: string;
  let projectDir: string;
  let originalCwd: string;
  let originalAgentDirEnv: string | undefined;

  const globalFile = () => join(globalDir, "subagents.json");
  const projectFile = () => join(projectDir, ".pi", "subagents.json");

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "pi-settings-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-settings-project-"));
    originalCwd = process.cwd();
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeGlobal(obj: unknown) {
    writeFileSync(globalFile(), JSON.stringify(obj));
  }

  function writeProject(obj: unknown) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), JSON.stringify(obj));
  }

  it("preserves defaults when global settings are absent, ignoring project settings", () => {
    writeProject({ maxConcurrent: 1, workflowsEnabled: false });
    expect(loadSettings()).toEqual({});
    expect(existsSync(globalFile())).toBe(false);
    expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({
      maxConcurrent: 1, workflowsEnabled: false,
    });
  });

  it("loads only global settings without merging or modifying the project file", () => {
    writeGlobal({ maxConcurrent: 16, graceTurns: 10 });
    writeProject({ maxConcurrent: 1, defaultMaxTurns: 50 });
    const before = readFileSync(projectFile(), "utf-8");
    expect(loadSettings()).toEqual({ maxConcurrent: 16, graceTurns: 10 });
    expect(readFileSync(projectFile(), "utf-8")).toBe(before);
    expect(JSON.parse(readFileSync(globalFile(), "utf-8"))).toEqual({ maxConcurrent: 16, graceTurns: 10 });
  });

  it("ignores malformed project settings without a warning or deleting the file", () => {
    writeGlobal({ viewerMarkdown: "all" });
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), "not json {{{");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadSettings()).toEqual({ viewerMarkdown: "all" });
    expect(warn).not.toHaveBeenCalled();
    expect(readFileSync(projectFile(), "utf-8")).toBe("not json {{{");
  });

  it("warns for malformed global settings and preserves the file", () => {
    writeFileSync(globalFile(), "not valid json {{{");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadSettings()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`Ignoring malformed settings at ${globalFile()}`);
    expect(readFileSync(globalFile(), "utf-8")).toBe("not valid json {{{");
  });

  it("does not warn or create files when settings are absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadSettings()).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    expect(existsSync(globalFile())).toBe(false);
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
  });

  it.each([
    "backgroundByDefault", "schedulingEnabled", "scopeModels", "strictAgentFiles",
    "disableDefaultAgents", "fleetView", "rememberAgents", "outputTranscript",
    "worktreeIsolation", "workflowsEnabled", "reportUsage", "showCost",
  ])("loads %s booleans and drops other types", (key) => {
    for (const value of [true, false]) {
      writeGlobal({ [key]: value });
      expect(loadSettings()).toEqual({ [key]: value });
    }
    for (const value of ["on", 0, null]) {
      writeGlobal({ [key]: value });
      expect(loadSettings()).toEqual({});
    }
  });

  it.each(["off", "assistant", "all"])("loads viewerMarkdown %s", (viewerMarkdown) => {
    writeGlobal({ viewerMarkdown });
    expect(loadSettings()).toEqual({ viewerMarkdown });
  });

  it.each(["model", "direct", "off"])("loads agentMentions %s", (agentMentions) => {
    writeGlobal({ agentMentions });
    expect(loadSettings()).toEqual({ agentMentions });
  });

  it("retains legacy mention booleans and drops unknown modes and fields", () => {
    writeGlobal({ agentMentions: true });
    expect(loadSettings()).toEqual({ agentMentions: "model" });
    writeGlobal({ agentMentions: false });
    expect(loadSettings()).toEqual({ agentMentions: "off" });
    writeGlobal({ agentMentions: "on", viewerMarkdown: "markdown", widgetMode: "all", showModel: true, futureField: 1 });
    expect(loadSettings()).toEqual({});
  });

  describe("sanitizer", () => {
    it("drops maxConcurrent < 1", () => {
      writeGlobal({ maxConcurrent: 0, graceTurns: 5 });
      expect(loadSettings()).toEqual({ graceTurns: 5 });
    });

    it("drops negative maxConcurrent", () => {
      writeGlobal({ maxConcurrent: -3 });
      expect(loadSettings()).toEqual({});
    });

    it("drops non-integer maxConcurrent (floats, NaN, strings)", () => {
      writeGlobal({ maxConcurrent: 3.5 });
      expect(loadSettings().maxConcurrent).toBeUndefined();
      writeGlobal({ maxConcurrent: "four" });
      expect(loadSettings().maxConcurrent).toBeUndefined();
      writeGlobal({ maxConcurrent: null });
      expect(loadSettings().maxConcurrent).toBeUndefined();
    });

    // Unlike maxConcurrent above, 0 is the DEFAULT here and means unlimited —
    // dropping it would make the default unrepresentable in the file.
    it("keeps maxConcurrentForeground: 0 (explicit unlimited)", () => {
      writeGlobal({ maxConcurrentForeground: 0 });
      expect(loadSettings()).toEqual({ maxConcurrentForeground: 0 });
    });

    it("drops out-of-range or non-integer maxConcurrentForeground", () => {
      for (const bad of [-1, 1025, 1.5, "four", null]) {
        writeGlobal({ maxConcurrentForeground: bad });
        expect(loadSettings().maxConcurrentForeground).toBeUndefined();
      }
    });

    it("accepts defaultMaxTurns: 0 (explicit unlimited)", () => {
      writeGlobal({ defaultMaxTurns: 0 });
      expect(loadSettings()).toEqual({ defaultMaxTurns: 0 });
    });

    it("drops negative defaultMaxTurns", () => {
      writeGlobal({ defaultMaxTurns: -1 });
      expect(loadSettings()).toEqual({});
    });

    it("drops graceTurns < 1", () => {
      writeGlobal({ graceTurns: 0 });
      expect(loadSettings()).toEqual({});
    });

    it("keeps maxSubagentDepth 0 (nesting off) but drops negative, fractional, and over-ceiling values", () => {
      writeGlobal({ maxSubagentDepth: 0 });
      expect(loadSettings()).toEqual({ maxSubagentDepth: 0 });
      writeGlobal({ maxSubagentDepth: -1 });
      expect(loadSettings()).toEqual({});
      writeGlobal({ maxSubagentDepth: 1.5 });
      expect(loadSettings()).toEqual({});
      writeGlobal({ maxSubagentDepth: 17 });
      expect(loadSettings()).toEqual({});
    });

    it("accepts `none` and `false` as the disabled fallback, nothing else", () => {
      // Only the boolean needs an alias: it would otherwise be dropped, leaving
      // the PERMISSIVE default while the author believed strict was on. Every
      // string stays an agent name, so a mistaken "off" fails loudly at dispatch
      // instead of meaning one thing here and another in the resolver.
      for (const spelling of ["none", "NONE", " none ", false]) {
        writeGlobal({ fallbackSubagent: spelling });
        expect(loadSettings().fallbackSubagent?.toLowerCase()).toBe("none");
      }
      writeGlobal({ fallbackSubagent: "off" });
      expect(loadSettings()).toEqual({ fallbackSubagent: "off" });
    });

    it("drops values that aren't a string or `false`, without coercing them", () => {
      // String(["none"]) is "none" — coercing would silently enable strict mode.
      for (const junk of [["none"], null, 42, true, {}]) {
        writeGlobal({ fallbackSubagent: junk });
        expect(loadSettings()).toEqual({});
      }
    });

    it("keeps a named fallback agent and drops non-strings", () => {
      writeGlobal({ fallbackSubagent: "  my-router  " });
      expect(loadSettings()).toEqual({ fallbackSubagent: "my-router" });
      writeGlobal({ fallbackSubagent: 42 });
      expect(loadSettings()).toEqual({});
      writeGlobal({ fallbackSubagent: "   " });
      expect(loadSettings()).toEqual({});
    });

    it("drops invalid defaultJoinMode values", () => {
      writeGlobal({ defaultJoinMode: "invalid" });
      expect(loadSettings()).toEqual({});
      writeGlobal({ defaultJoinMode: 42 });
      expect(loadSettings()).toEqual({});
      writeGlobal({ defaultJoinMode: "" });
      expect(loadSettings()).toEqual({});
    });

    it("accepts all three valid join modes", () => {
      for (const mode of ["async", "group", "smart"] as const) {
        writeGlobal({ defaultJoinMode: mode });
        expect(loadSettings()).toEqual({ defaultJoinMode: mode });
      }
    });

    it("accepts scopeModels boolean (true and false)", () => {
      writeGlobal({ scopeModels: true });
      expect(loadSettings()).toEqual({ scopeModels: true });
      writeGlobal({ scopeModels: false });
      expect(loadSettings()).toEqual({ scopeModels: false });
    });

    it("accepts strictAgentFiles boolean (true and false)", () => {
      writeGlobal({ strictAgentFiles: true });
      expect(loadSettings()).toEqual({ strictAgentFiles: true });
      writeGlobal({ strictAgentFiles: false });
      expect(loadSettings()).toEqual({ strictAgentFiles: false });
    });

    it("drops non-boolean strictAgentFiles", () => {
      writeGlobal({ strictAgentFiles: "yes" });
      expect(loadSettings().strictAgentFiles).toBeUndefined();
      writeGlobal({ strictAgentFiles: 1 });
      expect(loadSettings().strictAgentFiles).toBeUndefined();
    });

    it("drops non-boolean scopeModels", () => {
      writeGlobal({ scopeModels: "yes" });
      expect(loadSettings().scopeModels).toBeUndefined();
      writeGlobal({ scopeModels: 1 });
      expect(loadSettings().scopeModels).toBeUndefined();
      writeGlobal({ scopeModels: null });
      expect(loadSettings().scopeModels).toBeUndefined();
    });

    it("accepts disableDefaultAgents boolean (true and false)", () => {
      writeGlobal({ disableDefaultAgents: true });
      expect(loadSettings()).toEqual({ disableDefaultAgents: true });
      writeGlobal({ disableDefaultAgents: false });
      expect(loadSettings()).toEqual({ disableDefaultAgents: false });
    });

    it("drops non-boolean disableDefaultAgents", () => {
      writeGlobal({ disableDefaultAgents: "yes" });
      expect(loadSettings().disableDefaultAgents).toBeUndefined();
      writeGlobal({ disableDefaultAgents: 1 });
      expect(loadSettings().disableDefaultAgents).toBeUndefined();
      writeGlobal({ disableDefaultAgents: null });
      expect(loadSettings().disableDefaultAgents).toBeUndefined();
    });

    it("accepts all valid toolDescriptionMode values", () => {
      for (const mode of ["full", "compact", "custom"] as const) {
        writeGlobal({ toolDescriptionMode: mode });
        expect(loadSettings()).toEqual({ toolDescriptionMode: mode });
      }
    });

    it("drops invalid toolDescriptionMode", () => {
      writeGlobal({ toolDescriptionMode: "tiny" });
      expect(loadSettings().toolDescriptionMode).toBeUndefined();
      writeGlobal({ toolDescriptionMode: true });
      expect(loadSettings().toolDescriptionMode).toBeUndefined();
      writeGlobal({ toolDescriptionMode: null });
      expect(loadSettings().toolDescriptionMode).toBeUndefined();
    });

    it("returns {} when the JSON root is not an object (array, string, null)", () => {
      writeFileSync(globalFile(), '["not", "an", "object"]');
      expect(loadSettings()).toEqual({});
      writeFileSync(globalFile(), '"just a string"');
      expect(loadSettings()).toEqual({});
      writeFileSync(globalFile(), "null");
      expect(loadSettings()).toEqual({});
    });

    it("keeps valid fields while dropping invalid siblings", () => {
      writeGlobal({
        maxConcurrent: 4, // ok
        defaultMaxTurns: -5, // dropped
        graceTurns: 3, // ok
        defaultJoinMode: "nope", // dropped
      });
      expect(loadSettings()).toEqual({ maxConcurrent: 4, graceTurns: 3 });
    });

    it("accepts values at the ceiling (maxConcurrent=1024, defaultMaxTurns=10000, graceTurns=1000)", () => {
      writeGlobal({ maxConcurrent: 1024, defaultMaxTurns: 10_000, graceTurns: 1_000 });
      expect(loadSettings()).toEqual({
        maxConcurrent: 1024,
        defaultMaxTurns: 10_000,
        graceTurns: 1_000,
      });
    });

    it("drops values above the ceiling", () => {
      writeGlobal({ maxConcurrent: 1025 });
      expect(loadSettings().maxConcurrent).toBeUndefined();
      writeGlobal({ defaultMaxTurns: 10_001 });
      expect(loadSettings().defaultMaxTurns).toBeUndefined();
      writeGlobal({ graceTurns: 1_001 });
      expect(loadSettings().graceTurns).toBeUndefined();
    });

    it("drops absurdly large values (e.g. 1e6)", () => {
      writeGlobal({ maxConcurrent: 1_000_000, defaultMaxTurns: 1_000_000, graceTurns: 1_000_000 });
      expect(loadSettings()).toEqual({});
    });
  });

  describe("applySettings", () => {
    let appliers: SettingsAppliers;

    beforeEach(() => {
      appliers = {
        setMaxConcurrent: vi.fn(),
        setMaxConcurrentForeground: vi.fn(),
        setDefaultMaxTurns: vi.fn(),
        setGraceTurns: vi.fn(),
        setDefaultJoinMode: vi.fn(),
        setBackgroundByDefault: vi.fn(),
        setSchedulingEnabled: vi.fn(),
        setScopeModels: vi.fn(),
        setStrictAgentFiles: vi.fn(),
        setDisableDefaultAgents: vi.fn(),
        setToolDescriptionMode: vi.fn(),
        setFleetView: vi.fn(),
        setAgentMentions: vi.fn(),
        setRememberAgents: vi.fn(),
        setViewerMarkdown: vi.fn(),
        setOutputTranscript: vi.fn(),
        setWorktreeIsolation: vi.fn(),
        setWorkflowsEnabled: vi.fn(),
        setMaxSubagentDepth: vi.fn(),
        setFallbackSubagent: vi.fn(),
        setReportUsage: vi.fn(),
        setShowCost: vi.fn(),
      };
    });

    // 0 is a real value here, so `if (s.x)` truthiness would silently skip it.
    it("applies maxConcurrentForeground, including an explicit 0", () => {
      applySettings({ maxConcurrentForeground: 3 }, appliers);
      expect(appliers.setMaxConcurrentForeground).toHaveBeenCalledWith(3);

      applySettings({ maxConcurrentForeground: 0 }, appliers);
      expect(appliers.setMaxConcurrentForeground).toHaveBeenCalledWith(0);

      vi.mocked(appliers.setMaxConcurrentForeground).mockClear();
      applySettings({}, appliers);
      expect(appliers.setMaxConcurrentForeground).not.toHaveBeenCalled();
    });

    it("applies reportUsage and showCost", () => {
      applySettings({ reportUsage: true, showCost: true }, appliers);
      expect(appliers.setReportUsage).toHaveBeenCalledWith(true);
      expect(appliers.setShowCost).toHaveBeenCalledWith(true);

      applySettings({ reportUsage: false, showCost: false }, appliers);
      expect(appliers.setReportUsage).toHaveBeenCalledWith(false);
      expect(appliers.setShowCost).toHaveBeenCalledWith(false);
    });

    it("does not apply removed widget settings", () => {
      const settings = { widgetMode: "all", showModel: true, showCost: true };
      applySettings(settings, appliers);
      expect(appliers.setShowCost).toHaveBeenCalledWith(true);
      for (const [name, apply] of Object.entries(appliers)) {
        if (name !== "setShowCost") expect(apply).not.toHaveBeenCalled();
      }
    });

    it("is a no-op on an empty settings object", () => {
      applySettings({}, appliers);
      expect(appliers.setReportUsage).not.toHaveBeenCalled();
      expect(appliers.setShowCost).not.toHaveBeenCalled();
      expect(appliers.setMaxConcurrent).not.toHaveBeenCalled();
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setGraceTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
      expect(appliers.setSchedulingEnabled).not.toHaveBeenCalled();
      expect(appliers.setScopeModels).not.toHaveBeenCalled();
      expect(appliers.setDisableDefaultAgents).not.toHaveBeenCalled();
      expect(appliers.setToolDescriptionMode).not.toHaveBeenCalled();
    });

    it("applies fallbackSubagent through to the registry", () => {
      // Without this, deleting the applySettings line for this field leaves the
      // whole suite green while `subagents.json` silently stops working.
      applySettings({ fallbackSubagent: "none" }, appliers);
      expect(appliers.setFallbackSubagent).toHaveBeenCalledWith("none");
    });

    it("applies only the fields that are present", () => {
      applySettings({ maxConcurrent: 4, graceTurns: 3, maxSubagentDepth: 1 }, appliers);
      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(4);
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(3);
      expect(appliers.setMaxSubagentDepth).toHaveBeenCalledWith(1);
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
      expect(appliers.setSchedulingEnabled).not.toHaveBeenCalled();
      expect(appliers.setScopeModels).not.toHaveBeenCalled();
    });

    it("applies all fields when all are present", () => {
      applySettings(
        {
          maxConcurrent: 8,
          defaultMaxTurns: 50,
          graceTurns: 7,
          defaultJoinMode: "group",
          schedulingEnabled: false,
          scopeModels: true,
          disableDefaultAgents: true,
          toolDescriptionMode: "compact",
          fleetView: false,
        },
        appliers,
      );
      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(8);
      expect(appliers.setDefaultMaxTurns).toHaveBeenCalledWith(50);
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(7);
      expect(appliers.setDefaultJoinMode).toHaveBeenCalledWith("group");
      expect(appliers.setSchedulingEnabled).toHaveBeenCalledWith(false);
      expect(appliers.setScopeModels).toHaveBeenCalledWith(true);
      expect(appliers.setStrictAgentFiles).not.toHaveBeenCalled();  // absent from this snapshot
      expect(appliers.setDisableDefaultAgents).toHaveBeenCalledWith(true);
      expect(appliers.setToolDescriptionMode).toHaveBeenCalledWith("compact");
      expect(appliers.setFleetView).toHaveBeenCalledWith(false);
    });

    it("applies strictAgentFiles; skips it when absent", () => {
      applySettings({ strictAgentFiles: true }, appliers);
      expect(appliers.setStrictAgentFiles).toHaveBeenCalledWith(true);
      applySettings({}, appliers);
      expect(appliers.setStrictAgentFiles).toHaveBeenCalledTimes(1);
    });

    it("applies viewerMarkdown; skips it when absent", () => {
      applySettings({ viewerMarkdown: "all" }, appliers);
      expect(appliers.setViewerMarkdown).toHaveBeenCalledWith("all");
      applySettings({}, appliers);
      expect(appliers.setViewerMarkdown).toHaveBeenCalledTimes(1); // absence is "use default"
    });

    it("applies fleetView (true and false); skips it when absent", () => {
      applySettings({ fleetView: true }, appliers);
      expect(appliers.setFleetView).toHaveBeenCalledWith(true);
      applySettings({}, appliers);
      expect(appliers.setFleetView).toHaveBeenCalledTimes(1); // absence is "use default"
    });

    it("applies agentMentions; skips it when absent", () => {
      applySettings({ agentMentions: "direct" }, appliers);
      expect(appliers.setAgentMentions).toHaveBeenCalledWith("direct");
      applySettings({}, appliers);
      expect(appliers.setAgentMentions).toHaveBeenCalledTimes(1); // absence is "use default"
    });

    it("applies rememberAgents; skips it when absent", () => {
      applySettings({ rememberAgents: false }, appliers);
      expect(appliers.setRememberAgents).toHaveBeenCalledWith(false);
      applySettings({}, appliers);
      expect(appliers.setRememberAgents).toHaveBeenCalledTimes(1); // absence is "use default"
    });

    it("applies scopeModels: false", () => {
      applySettings({ scopeModels: false }, appliers);
      expect(appliers.setScopeModels).toHaveBeenCalledWith(false);
    });

    it("applies disableDefaultAgents: false", () => {
      applySettings({ disableDefaultAgents: false }, appliers);
      expect(appliers.setDisableDefaultAgents).toHaveBeenCalledWith(false);
    });

    it("applies toolDescriptionMode", () => {
      applySettings({ toolDescriptionMode: "full" }, appliers);
      expect(appliers.setToolDescriptionMode).toHaveBeenCalledWith("full");
    });

    it("applies outputTranscript (both true and false)", () => {
      applySettings({ outputTranscript: false }, appliers);
      expect(appliers.setOutputTranscript).toHaveBeenCalledWith(false);
      applySettings({ outputTranscript: true }, appliers);
      expect(appliers.setOutputTranscript).toHaveBeenCalledWith(true);
    });

    it("applies worktreeIsolation (both true and false)", () => {
      applySettings({ worktreeIsolation: false }, appliers);
      expect(appliers.setWorktreeIsolation).toHaveBeenCalledWith(false);
      applySettings({ worktreeIsolation: true }, appliers);
      expect(appliers.setWorktreeIsolation).toHaveBeenCalledWith(true);
    });

    it("applies defaultMaxTurns: 0 as the explicit unlimited marker", () => {
      applySettings({ defaultMaxTurns: 0 }, appliers);
      expect(appliers.setDefaultMaxTurns).toHaveBeenCalledWith(0);
    });

    it("calls setBackgroundByDefault with either boolean", () => {
      applySettings({ backgroundByDefault: false }, appliers);
      expect(appliers.setBackgroundByDefault).toHaveBeenCalledWith(false);
      applySettings({ backgroundByDefault: true }, appliers);
      expect(appliers.setBackgroundByDefault).toHaveBeenCalledWith(true);
    });

    // Absence must leave the in-memory default (background) alone — calling
    // the applier with `undefined` would read as foreground at the spawn site.
    it("does not call setBackgroundByDefault when the field is absent", () => {
      applySettings({ maxConcurrent: 4 }, appliers);
      expect(appliers.setBackgroundByDefault).not.toHaveBeenCalled();
    });

    // Wiring tests for the master switch — ensures the schedulingEnabled
    // field flows from the parsed settings into the applier callback that
    // sets the in-memory flag in index.ts.
    it("calls setSchedulingEnabled(true) when schedulingEnabled is true", () => {
      applySettings({ schedulingEnabled: true }, appliers);
      expect(appliers.setSchedulingEnabled).toHaveBeenCalledWith(true);
    });

    it("calls setSchedulingEnabled(false) when schedulingEnabled is false", () => {
      applySettings({ schedulingEnabled: false }, appliers);
      expect(appliers.setSchedulingEnabled).toHaveBeenCalledWith(false);
    });

    // Absence preserves the in-memory default — the applier must NOT be
    // called, otherwise loading a settings file without the field would
    // overwrite the runtime default with `undefined`.
    it("does not call setSchedulingEnabled when the field is absent", () => {
      applySettings({ maxConcurrent: 4 }, appliers);
      expect(appliers.setSchedulingEnabled).not.toHaveBeenCalled();
    });
  });

  describe("applyAndEmitLoaded", () => {
    let appliers: SettingsAppliers;

    beforeEach(() => {
      appliers = {
        setMaxConcurrent: vi.fn(),
        setMaxConcurrentForeground: vi.fn(),
        setDefaultMaxTurns: vi.fn(),
        setGraceTurns: vi.fn(),
        setDefaultJoinMode: vi.fn(),
        setBackgroundByDefault: vi.fn(),
        setSchedulingEnabled: vi.fn(),
        setScopeModels: vi.fn(),
        setStrictAgentFiles: vi.fn(),
        setDisableDefaultAgents: vi.fn(),
        setToolDescriptionMode: vi.fn(),
        setFleetView: vi.fn(),
        setAgentMentions: vi.fn(),
        setRememberAgents: vi.fn(),
        setViewerMarkdown: vi.fn(),
        setOutputTranscript: vi.fn(),
        setWorktreeIsolation: vi.fn(),
        setWorkflowsEnabled: vi.fn(),
        setMaxSubagentDepth: vi.fn(),
        setFallbackSubagent: vi.fn(),
        setReportUsage: vi.fn(),
        setShowCost: vi.fn(),
      };
    });

    it("loads, sanitizes, applies, and emits global settings", () => {
      writeGlobal({ maxConcurrent: 16, graceTurns: 7, showCost: "invalid" });
      writeProject({ maxConcurrent: 2, graceTurns: 1 });
      const emit = vi.fn();

      const result = applyAndEmitLoaded(appliers, emit);

      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(16);
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(7);
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", {
        settings: { maxConcurrent: 16, graceTurns: 7 },
      });
      expect(result).toEqual({ maxConcurrent: 16, graceTurns: 7 });
    });

    it("still emits the event when the global file is missing (payload carries {})", () => {
      const emit = vi.fn();

      const result = applyAndEmitLoaded(appliers, emit);

      expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", { settings: {} });
      expect(result).toEqual({});
      // No setters fired — defaults preserved
      expect(appliers.setMaxConcurrent).not.toHaveBeenCalled();
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setGraceTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
    });
  });

});
