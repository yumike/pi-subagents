import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { AgentManager } from "../src/agent-manager.js";
import { GroupJoinManager } from "../src/group-join.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { AgentWidget } from "../src/ui/agent-widget.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";

describe("session_shutdown resource disposal", () => {
  let env: ReturnType<typeof hermeticDir>;
  let boot: ReturnType<typeof makePi>;
  let context: ReturnType<typeof ctx>;
  let widgetDispose: MockInstance<AgentWidget["dispose"]>;
  let groupDispose: MockInstance<GroupJoinManager["dispose"]>;
  let registerGroup: MockInstance<GroupJoinManager["registerGroup"]>;

  beforeEach(async () => {
    vi.useFakeTimers();
    env = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false } });
    boot = makePi();
    context = ctx({ hasUI: true });
    context.ui.onTerminalInput = vi.fn(() => vi.fn());
    widgetDispose = vi.spyOn(AgentWidget.prototype, "dispose");
    groupDispose = vi.spyOn(GroupJoinManager.prototype, "dispose");
    registerGroup = vi.spyOn(GroupJoinManager.prototype, "registerGroup");
    subagentsExtension(boot.pi);
    await boot.lifecycle.get("session_start")({}, context);
  });

  afterEach(async () => {
    try {
      await boot.lifecycle.get("session_shutdown")({}, context);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
      env.restore();
    }
  });

  async function spawnBatch(count: number): Promise<AgentRecord[]> {
    const records: AgentRecord[] = Array.from({ length: count }, (_, i) => ({
      id: `agent-${i}`,
      type: "general-purpose",
      description: `Task ${i}`,
      status: "running",
      startedAt: Date.now(),
      toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: true,
    }));
    const spawn = vi.spyOn(AgentManager.prototype, "spawn");
    vi.spyOn(AgentManager.prototype, "getRecord").mockImplementation(id => records.find(record => record.id === id));
    vi.spyOn(AgentManager.prototype, "listAgents").mockReturnValue(records);
    for (const record of records) {
      spawn.mockReturnValueOnce(record.id);
      await boot.tools.get("Agent").execute(record.id, {
        subagent_type: record.type,
        description: record.description,
        prompt: "Work",
        run_in_background: true,
      }, undefined, undefined, context);
    }
    return records;
  }

  it("disposes live widget and group timers, including repeated shutdown", async () => {
    const records = await spawnBatch(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(registerGroup).toHaveBeenCalledTimes(1);
    const group = registerGroup.mock.contexts[0] as GroupJoinManager;
    records[0].status = "completed";
    records[0].completedAt = Date.now();
    expect(group.onAgentComplete(records[0])).toBe("held");
    expect(group.isGrouped(records[0].id)).toBe(true);

    await boot.lifecycle.get("session_shutdown")({}, context);

    expect(widgetDispose).toHaveBeenCalledTimes(1);
    expect(groupDispose).toHaveBeenCalledTimes(1);
    expect(group.isGrouped(records[0].id)).toBe(false);
    expect(context.ui.setWidget).toHaveBeenCalledWith("agents", undefined);
    expect(context.ui.setStatus).toHaveBeenCalledWith("subagents", undefined);
    expect(vi.getTimerCount()).toBe(0);

    await boot.lifecycle.get("session_shutdown")({}, context);

    expect(widgetDispose).toHaveBeenCalledTimes(2);
    expect(groupDispose).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_200);
    expect(boot.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps resources on a possibly vetoed switch, then disposes them on shutdown", async () => {
    const records = await spawnBatch(2);
    await vi.advanceTimersByTimeAsync(100);
    const group = registerGroup.mock.contexts[0] as GroupJoinManager;

    await boot.lifecycle.get("session_before_switch")({}, context);

    expect(widgetDispose).not.toHaveBeenCalled();
    expect(groupDispose).not.toHaveBeenCalled();
    expect(group.isGrouped(records[0].id)).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await boot.lifecycle.get("session_shutdown")({}, context);

    expect(widgetDispose).toHaveBeenCalledTimes(1);
    expect(groupDispose).toHaveBeenCalledTimes(1);
    expect(group.isGrouped(records[0].id)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 2])("cancels a pending %i-agent batch before it can recreate groups or nudges", async count => {
    const records = await spawnBatch(count);
    await vi.advanceTimersByTimeAsync(99);
    for (const record of records) {
      record.status = "completed";
      record.completedAt = Date.now();
    }
    expect(registerGroup).not.toHaveBeenCalled();

    await boot.lifecycle.get("session_shutdown")({}, context);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_300);
    expect(registerGroup).not.toHaveBeenCalled();
    expect(boot.pi.sendMessage).not.toHaveBeenCalled();
  });
});
