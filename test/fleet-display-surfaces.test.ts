import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import type { AgentActivity } from "../src/ui/agent-display.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const mounted: FleetList[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const fleet of mounted.splice(0)) fleet.dispose();
  vi.useRealTimers();
});

function record(cost = 0.0042): AgentRecord {
  return {
    id: "agent-1", type: "general-purpose", description: "spending agent", status: "running",
    toolUses: 1, startedAt: Date.now(), compactionCount: 0,
    lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
    session: { messages: [], subscribe: () => () => {} } as unknown as AgentRecord["session"],
  };
}

function mount(agent: AgentRecord, showCost?: boolean, activity = new Map<string, AgentActivity>()) {
  const manager = { listAgents: () => [agent] } as unknown as ConstructorParameters<typeof FleetList>[0];
  const fleet = new FleetList(manager, activity, showCost === undefined ? undefined : () => showCost);
  mounted.push(fleet);
  let factory: Parameters<FleetUICtx["setWidget"]>[1];
  fleet.setUICtx({
    setWidget: (_key, content) => { factory = content; },
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    notify: () => {},
    custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
  });
  return {
    fleet,
    render: () => {
      fleet.update();
      return factory?.({ terminal: { columns: 200, rows: 40 }, requestRender: () => {} }, theme).render(200).join("\n") ?? "";
    },
  };
}

describe("agent usage on surviving surfaces", () => {
  it("shows the record's cost beside its tokens, not stale activity totals", () => {
    const agent = record();
    const activity = new Map([[agent.id, {
      activeTools: new Map<string, string>(), toolUses: 1, responseText: "", turnCount: 1,
      lifetimeUsage: { input: 9, output: 9, cacheWrite: 0, cost: 0.9 },
    }]]);
    const output = mount(agent, true, activity).render();
    expect(output).toContain("1.2k tokens");
    expect(output).toContain("~$0.0042");
    expect(output).not.toContain("~$0.90");
  });

  it("shows no cost when disabled", () => {
    const output = mount(record(), false).render();
    expect(output).toContain("1.2k tokens");
    expect(output).not.toContain("$");
  });

  it("shows no cost for an unpriced model, even when enabled", () => {
    const output = mount(record(0), true).render();
    expect(output).toContain("1.2k tokens");
    expect(output).not.toContain("$");
  });

  it("keeps completed usage visible in the conversation viewer without a live tracker", () => {
    const agent = record();
    agent.status = "completed";
    agent.completedAt = Date.now();
    const tui = { terminal: { columns: 200, rows: 40 }, requestRender: () => {} } as unknown as ConstructorParameters<typeof ConversationViewer>[0];
    const viewer = new ConversationViewer(tui, agent.session!, agent, undefined, theme, () => {}, undefined, undefined, undefined, true);
    try {
      const output = viewer.render(200).join("\n");
      expect(output).toContain("spending agent");
      expect(output).toContain("1.2k token");
      expect(output).toContain("~$0.0042");
    } finally {
      viewer.dispose();
    }
  });

  it("shows stats for an agent nobody is tracking live", () => {
    const output = mount(record(), true).render();
    expect(output).toContain("1.2k tokens");
    expect(output).toContain("~$0.0042");
  });

  it("defaults to hiding cost", () => {
    expect(mount(record()).render()).not.toContain("$");
  });

  it("shows a resumed agent and its error outcome after the previous row aged out", () => {
    const agent = record();
    agent.status = "error";
    agent.completedAt = Date.now();
    const view = mount(agent);
    view.fleet.onAgentFinished(agent.id);
    expect(view.render()).toContain("spending agent");
    vi.advanceTimersByTime(31_000);
    expect(view.render()).not.toContain("spending agent");

    agent.status = "running";
    agent.completedAt = undefined;
    view.fleet.ensureTimer();
    expect(view.render()).toContain("spending agent");

    agent.status = "error";
    agent.completedAt = Date.now();
    view.fleet.onAgentFinished(agent.id);
    expect(view.render()).toContain("spending agent");
  });
});
