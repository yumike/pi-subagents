/**
 * workflow-dialog-open-agent.test.ts — the inspector's `c` key, end to end.
 *
 * `workflow-dialog.test.ts` proves the key raises the action and the footer
 * advertises it; this proves the half only the real extension can: that a
 * child's manager record id actually reaches the row (runtime → host →
 * progress entry), that `c` opens THAT record's conversation as a second
 * overlay, and that the dialog hides itself underneath rather than leaving its
 * frame peeking around the viewer.
 *
 * Without the id on the row there is nothing to open, so the run's agents were
 * the one part of the fleet with no way to read what they did.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSession, type ExtensionAPI, type ExtensionUIContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions, TuiMode } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunner from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunner>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

let sessionMessages: AgentSession["messages"] = [];

/** Enough of a pi session for the manager to keep, and the viewer to render. */
const fakeSession = () => ({
  dispose: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  messages: sessionMessages,
  getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
});

/** One overlay the extension asked `ui.custom` for, held open like a real one. */
interface OpenOverlay {
  options: NonNullable<Parameters<ExtensionUIContext["custom"]>[1]>;
  initialOverlayOptions: OverlayOptions | undefined;
  resolvedOverlayOptions: OverlayOptions | undefined;
  instance: Component & { dispose?(): void };
  /** Resolve the overlay's promise, as closing it does. */
  close(): void;
}

/**
 * A ctx whose `ui.custom` keeps overlays OPEN.
 *
 * The other workflow tests close each overlay the moment it is built, which is
 * enough to assert on wiring. Here the dialog has to stay up while a second
 * overlay opens on top of it, because that stacking is the thing under test.
 */
function overlayCtx(mode: TuiMode = "regular") {
  const overlays: OpenOverlay[] = [];
  const hidden: boolean[] = [];
  let entryTaken = false;
  let inputHandler: Parameters<ExtensionUIContext["onTerminalInput"]>[0] | undefined;
  const context = ctx({
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      getEditorText: () => "",
      onTerminalInput: (handler: Parameters<ExtensionUIContext["onTerminalInput"]>[0]) => {
        inputHandler = handler;
        return () => { inputHandler = undefined; };
      },
      select: vi.fn(async (title: string, options: string[]) => {
        if (title !== "Agents" || entryTaken) return undefined;
        entryTaken = true;
        return options.find(option => /^Workflows \(\d+\)$/.test(option));
      }),
      custom: vi.fn(async (factory: (...args: unknown[]) => unknown, options?: OpenOverlay["options"]) => {
        // `terminal` included: the conversation viewer sizes itself off it, so
        // a bare `requestRender` stub would throw on the second overlay.
        const tui = { mode, requestRender: () => {}, terminal: { columns: 120, rows: 40 } };
        const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
        const initialOverlayOptions = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
        return await new Promise(resolve => {
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            instance.dispose?.();
            resolve(undefined);
          };
          const instance = factory(tui, theme, undefined, close) as OpenOverlay["instance"];
          const resolvedOverlayOptions = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
          overlays.push({ options: options ?? {}, initialOverlayOptions, resolvedOverlayOptions, instance, close });
          options?.onHandle?.({ setHidden: (value: boolean) => hidden.push(value) } as OverlayHandle);
        });
      }),
    },
  });
  return { context, overlays, hidden, press: (data: string) => inputHandler?.(data) };
}

describe("the inspector opens a workflow agent's conversation", () => {
  let hermetic: Hermetic;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { workflowsEnabled: true } });
    sessionMessages = [];
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      const session = fakeSession();
      opts.onSessionCreated?.(session as any);
      return { responseText: "child done", session: session as any, aborted: false, steered: false };
    });
  });
  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    vi.mocked(runAgent).mockReset();
    hermetic.restore();
  });

  /** Boot the extension and start a one-agent run in the background. */
  async function bootWithChild() {
    const booted = makePi();
    subagentsExtension(booted.pi);
    shutdown = () => booted.lifecycle.get("session_shutdown")({}, ctx());
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");
    await booted.tools.get("SubagentWorkflow").execute(
      "tc-0",
      {
        script:
          'export const meta = { name: "wf", description: "d" };\n' +
          'return await agent("read the routes", { label: "child" });\n',
      },
      undefined,
      undefined,
      ctx({ cwd: hermetic.dir }),
    );
    return { ...booted, command };
  }

  it.each<{ mode: TuiMode; expected: OverlayOptions }>([
    { mode: "regular", expected: { anchor: "center", width: "90%", maxHeight: "70%" } },
    { mode: "fullscreen", expected: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
  ])("carries the child's record id onto the row and opens its conversation on c in $mode", async ({ mode, expected }) => {
    const { command, pi } = await bootWithChild();
    const getSettings = vi.mocked(pi.getSettings as ExtensionAPI["getSettings"]);
    getSettings.mockReturnValue({ tuiMode: mode === "regular" ? "fullscreen" : "regular" });
    const ui = overlayCtx(mode);

    // Not awaited: the dialog overlay stays open, which is the point.
    void command.handler("", ui.context);
    await vi.waitFor(() => expect(ui.overlays).toHaveLength(1));
    const dialog = ui.overlays[0].instance;

    // The footer is live, so waiting on it is waiting for the id to travel
    // host → runtime → progress entry → row. Until it lands there is nothing
    // to open and the key is correctly not advertised.
    await vi.waitFor(() => expect(dialog.render?.(120).at(-1)).toContain("c convo"));

    dialog.handleInput?.("c");
    await vi.waitFor(() => expect(ui.overlays).toHaveLength(2));

    // A second overlay, on the viewer's own terms — not the dialog reused.
    expect(ui.overlays[1].options.overlay).toBe(true);
    expect(ui.overlays[1].instance.constructor.name).toBe("ConversationViewer");
    expect(typeof ui.overlays[1].options.overlayOptions).toBe("function");
    expect(ui.overlays[1].initialOverlayOptions).toEqual({ anchor: "center", width: "90%", maxHeight: "70%" });
    expect(ui.overlays[1].resolvedOverlayOptions).toEqual(expected);
    expect(ui.overlays[0].resolvedOverlayOptions).toEqual({ anchor: "center", width: "90%", maxHeight: "70%" });
    // ...with the dialog hidden underneath it: the two frames size themselves
    // to different content, so the taller one's edges would show around the
    // shorter.
    expect(ui.hidden).toEqual([true]);

    ui.overlays[1].close();
    // And back, so closing the conversation returns to the run it was opened
    // from rather than to an empty screen.
    await vi.waitFor(() => expect(ui.hidden).toEqual([true, false]));

    ui.overlays[0].close();
  });

  it.each([
    { setting: "always", atRest: true, afterScroll: true },
    { setting: "hidden", atRest: false, afterScroll: false },
    { setting: "auto", atRest: false, afterScroll: true },
    { setting: "not-a-mode", atRest: false, afterScroll: true },
    { setting: undefined, atRest: false, afterScroll: true },
  ])("normalizes the main session's live fullscreenScrollbar $setting, ignoring disk settings", async ({ setting, atRest, afterScroll }) => {
    sessionMessages = [{ role: "user", content: Array.from({ length: 100 }, (_, i) => `row-${i}`).join("\n"), timestamp: 0 }];
    const diskSettings = JSON.stringify({ fullscreenScrollbar: setting === "hidden" ? "always" : "hidden", tuiMode: "regular" });
    writeFileSync(join(hermetic.dir, ".pi", "settings.json"), diskSettings);
    writeFileSync(join(getAgentDir(), "settings.json"), diskSettings);
    const { command, pi } = await bootWithChild();
    const getSettings = vi.mocked(pi.getSettings as ExtensionAPI["getSettings"]);
    expect(getSettings).not.toHaveBeenCalled();
    getSettings.mockReturnValue({ fullscreenScrollbar: setting, tuiMode: "regular" } as ReturnType<ExtensionAPI["getSettings"]>);
    const ui = overlayCtx("fullscreen");
    try {
      void command.handler("", ui.context);
      await vi.waitFor(() => expect(ui.overlays).toHaveLength(1));
      const dialog = ui.overlays[0].instance;
      await vi.waitFor(() => expect(dialog.render(120).at(-1)).toContain("c convo"));
      expect(getSettings).not.toHaveBeenCalled();
      dialog.handleInput?.("c");
      await vi.waitFor(() => expect(ui.overlays).toHaveLength(2));

      const viewer = ui.overlays[1].instance;
      const hasRail = () => viewer.render(120).some(line => /[┃│█]$/.test(line));
      expect(hasRail()).toBe(atRest);
      viewer.handleInput?.("\x1b[A");
      expect(hasRail()).toBe(afterScroll);
      expect(getSettings).toHaveBeenCalledTimes(1);
      expect(ui.hidden).toEqual([true]);
      ui.overlays[1].close();
      await vi.waitFor(() => expect(ui.hidden).toEqual([true, false]));
    } finally {
      for (const overlay of [...ui.overlays].reverse()) overlay.close();
    }
  });

  it("wires the fleet to the same live settings getter and refreshes it between opens", async () => {
    sessionMessages = [{ role: "user", content: Array.from({ length: 100 }, (_, i) => `row-${i}`).join("\n"), timestamp: 0 }];
    const booted = makePi();
    const getSettings = vi.mocked(booted.pi.getSettings as ExtensionAPI["getSettings"]);
    getSettings.mockReturnValue({ fullscreenScrollbar: "hidden", tuiMode: "regular" });
    subagentsExtension(booted.pi);
    shutdown = () => booted.lifecycle.get("session_shutdown")({}, ctx());
    expect(getSettings).not.toHaveBeenCalled();
    const ui = overlayCtx("fullscreen");
    await booted.lifecycle.get("tool_execution_start")({}, ui.context);
    await booted.tools.get("Agent").execute("tc-fleet", {
      prompt: "read the routes", description: "fleet child", subagent_type: "general-purpose", run_in_background: false,
    }, undefined, undefined, ui.context);
    try {
      expect(getSettings).not.toHaveBeenCalled();
      expect(ui.press("\x1b[B")).toEqual({ consume: true });
      expect(ui.press("\x1b[B")).toEqual({ consume: true });
      for (const [index, setting] of (["always", "hidden", "auto"] as const).entries()) {
        getSettings.mockReturnValue({ fullscreenScrollbar: setting });
        expect(ui.press("\r")).toEqual({ consume: true });
        await vi.waitFor(() => expect(ui.overlays).toHaveLength(index + 1));
        const overlay = ui.overlays[index];
        expect(overlay.resolvedOverlayOptions).toEqual({ anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
        const hasRail = () => overlay.instance.render(120).some(line => /[┃│█]$/.test(line));
        expect(hasRail()).toBe(setting === "always");
        for (const key of ["\x1b[B", "\r", "\x1b"]) expect(ui.press(key)).toBeUndefined();
        overlay.instance.handleInput?.("\x1b[A");
        expect(hasRail()).toBe(setting !== "hidden");
        overlay.close();
        await Promise.resolve();
        await Promise.resolve();
      }
      expect(getSettings).toHaveBeenCalledTimes(3);
    } finally {
      for (const overlay of [...ui.overlays].reverse()) overlay.close();
    }
  });
});
