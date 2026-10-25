/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows `main` + each running/queued subagent as a navigable list. Pressing ↓ (or
 * ←) at an empty prompt activates the list; ↑/↓ move the selection (filled ● marker),
 * Enter opens the selected agent's live conversation overlay, Esc returns to the prompt.
 * A viewer stays open through completion; unsuccessful runs linger for 30 seconds.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import { isKeyRelease, Key, matchesKey, type ScrollViewScrollbar, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { extractText } from "../context.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import { type AgentActivity, describeActivity, formatCost, type Theme } from "./agent-display.js";
import { ConversationViewer, getConversationOverlayOptions } from "./conversation-viewer.js";

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
const ERROR_LINGER_MS = 30_000;
const WORKFLOW_LINGER_MS = 4000;

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/**
 * A workflow run, as the fleet list needs to see it.
 *
 * Narrow on purpose: the list knows nothing about `WorkflowTask`, the runtime
 * or the dialog, so it stays as testable as it was when it only held agents.
 * The extension maps its tasks into this shape and injects an opener.
 */
export interface FleetWorkflow {
  id: string;
  /** The `meta.name` of the run, or its id when the script named nothing. */
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  /** Set once the run settles, which is what freezes its clock. */
  completedAt?: number;
  tokens: number;
}

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type FleetEntry = MainEntry | WorkflowEntry | AgentEntry;

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  private selectedKey = "main";
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  /** Injected by the extension; absent until workflows are wired (or at all). */
  private workflowSource: (() => readonly FleetWorkflow[]) | undefined;
  private openWorkflow: ((id: string) => Promise<void> | void) | undefined;
  /**
   * Set while the workflow inspector is up.
   *
   * It does the two jobs `viewerClose` does for an agent's overlay — keep the
   * list out of the dialog's keys, and remember which row to come back to —
   * minus the close handle, because that overlay belongs to the extension.
   */
  private viewingWorkflowId: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * The user's `viewerMarkdown` setting, for a conversation overlay opened
     * from here. Read live rather than captured, because the viewer's `m` key
     * changes it while the overlay is up. Omitted → the viewer's own default.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m` in that overlay, so the key means the same
     * thing here as it does from `/agents` — one setting, not one per entry
     * point. Omitted → `m` still cycles, viewer-locally.
     */
    private onViewerMarkdown?: (mode: ViewerMarkdownMode) => void,
    private scrollbarMode: () => ScrollViewScrollbar = () => "auto",
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (this.ui && this.enabled && !this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable even when the successful run leaves the panel.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    // No handle to close the workflow inspector with, but the list is going
    // away — leaving the id set would keep it swallowing input forever.
    this.viewingWorkflowId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when nothing remains. */
  update(): void {
    if (!this.ui) return;
    // A run with no agents of its own left in the list is still worth a row —
    // it is the thing the user opens to see what its children did. Read off the
    // roster for the same reason activation does: two counts of "is there
    // anything here" drifted apart once before.
    const hasRows = this.enabled && this.roster().length > 1;

    if (!hasRows) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.select(0);
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Roster ----

  /**
   * Pending agents stay visible before a session exists. Successful runs leave
   * immediately unless viewed; other outcomes linger so failures are noticeable.
   * `listAgents()` is newest-first, so re-sort for stable launch order.
   */
  private agentRecords(): AgentRecord[] {
    const now = Date.now();
    return this.manager.listAgents()
      .filter(a => isTopLevelAgent(a) && (
        a.status === "running" || a.status === "queued"
        || a.id === this.viewingAgentId
        || (a.status !== "completed" && a.completedAt != null && now - a.completedAt < ERROR_LINGER_MS)
      ))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Wire workflow runs into the list.
   *
   * Injected rather than constructed here because the fleet list predates
   * workflows and must keep working without them — a session with the feature
   * switched off never calls this, and the roster is agents-only exactly as
   * before.
   */
  setWorkflowSource(
    source: () => readonly FleetWorkflow[],
    open: (id: string) => Promise<void> | void,
  ): void {
    this.workflowSource = source;
    this.openWorkflow = open;
  }

  /** Live runs, plus recently settled ones. */
  private workflows(): FleetWorkflow[] {
    if (!this.workflowSource) return [];
    const now = Date.now();
    return [...this.workflowSource()]
      .filter(run =>
        run.status === "running"
        || run.status === "paused"
        || (run.completedAt != null && now - run.completedAt < WORKFLOW_LINGER_MS)
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Runs sit above the agents rather than interleaved by start time: a run owns
   * most of the agents under it, so listing the container first is what makes
   * the list read as a hierarchy rather than a shuffle.
   */
  private roster(): FleetEntry[] {
    return [
      { kind: "main" },
      ...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })),
      ...this.agentRecords().map(record => ({ kind: "agent" as const, record })),
    ];
  }

  private entryKey(entry: FleetEntry): string {
    return entry.kind === "agent" ? `agent:${entry.record.id}`
      : entry.kind === "workflow" ? `workflow:${entry.workflow.id}` : "main";
  }

  private select(index: number): void {
    const entry = this.roster()[index];
    this.selectedIndex = entry ? index : 0;
    this.selectedKey = entry ? this.entryKey(entry) : "main";
  }

  private clampSelection(): void {
    const index = this.roster().findIndex(entry => this.entryKey(entry) === this.selectedKey);
    this.selectedIndex = Math.max(0, index);
    // Never open a different agent just because the selected row disappeared.
    if (index < 0) this.selectedKey = "main";
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input. Checked before the focus
    // test below, which would otherwise read the dialog holding the keyboard as
    // "the user left the list" and reset the selection out from under it.
    if (this.viewerClose || this.viewingWorkflowId) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    this.clampSelection();

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      // Gated on the roster, not the agents: a session whose only row is a
      // workflow run still has somewhere to go, and requiring an agent would
      // render the row but refuse to move into it.
      if (isActivator && this.roster().length > 1 && this.ui.getEditorText() === "") {
        this.active = true;
        this.select(0);
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      this.select(Math.min(max, this.selectedIndex + 1));
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex === 0) { this.deactivate(); return { consume: true }; }
      this.select(this.selectedIndex - 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * Custom prompt editors need not inherit Editor; recognize their text methods.
   * Focus is TUI-private, so unknown focus keeps keyboard activation available.
   */
  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    if (focused == null) return true;
    const editor = focused as { getText?: unknown; setText?: unknown };
    return typeof editor.getText === "function" && typeof editor.setText === "function";
  }

  private deactivate(): void {
    this.active = false;
    this.select(0);
    this.update();
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    if (entry.kind === "workflow") {
      // The extension owns this overlay and closes it, so there is no
      // `viewerClose` to hold — but the list still has to know one is up, and
      // still has to put the cursor back on the run when it comes down.
      this.viewingWorkflowId = entry.workflow.id;
      void Promise.resolve(this.openWorkflow?.(entry.workflow.id)).then(
        () => this.clearViewer(),
        () => this.clearViewer(),
      );
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.agentActivity.get(record.id);
    this.viewingAgentId = record.id;
    let overlayOptions = getConversationOverlayOptions({ mode: "regular" });

    void this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        overlayOptions = getConversationOverlayOptions(tui);
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (this.manager.abort(record.id)) this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => this.manager.steer(record.id, message),
          this.showCost(),
          this.viewerMarkdown,
          this.onViewerMarkdown,
          this.scrollbarMode(),
        );
      },
      {
        overlay: true,
        overlayOptions: () => overlayOptions,
      },
    ).then(() => this.clearViewer(), () => this.clearViewer());
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Re-resolve by identity: other rows can disappear while the viewer is open.
    const viewed = this.viewingAgentId ?? this.viewingWorkflowId;
    if (viewed !== undefined) {
      const idx = this.roster().findIndex(e =>
        e.kind === "agent" ? e.record.id === viewed
        : e.kind === "workflow" ? e.workflow.id === viewed
        : false,
      );
      if (idx >= 0) this.select(idx);
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.viewingWorkflowId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const rows = this.roster().slice(1) as (WorkflowEntry | AgentEntry)[];
    if (rows.length === 0) return [];
    this.clampSelection();
    const sel = this.selectedIndex;

    const hint = this.active
      ? "↑↓ select · enter view · esc back"
      : "esc to interrupt · ← for agents · ↓ to manage";
    const lines: string[] = [];
    lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
    lines.push("");
    lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width));

    // Window the rows so the selected one stays visible.
    const visible = Math.min(MAX_AGENT_ROWS, rows.length);
    const selRow = Math.max(0, sel - 1);
    const start = selRow < visible ? 0 : selRow - visible + 1;
    const hiddenBelow = rows.length - (start + visible);

    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let a = start; a < start + visible; a++) {
      const row = rows[a];
      lines.push(
        row.kind === "workflow" ?
          this.renderWorkflowRow(a + 1, sel, row.workflow, width, theme)
        : this.renderAgentRow(a + 1, sel, row.record, width, theme),
      );
    }
    if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
    // Pi stacks below-editor widgets directly against its footer.
    lines.push("");

    return lines;
  }

  private bullet(rosterIndex: number, sel: number, theme: Theme): string {
    return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  /**
   * A run's row. Shaped like an agent's — bullet, kind, name, stats flush right
   * — so the two read as one list, with the agent count where an agent has its
   * description and the same elapsed/token tail.
   */
  private renderWorkflowRow(
    rosterIndex: number,
    sel: number,
    workflow: FleetWorkflow,
    width: number,
    theme: Theme,
  ): string {
    const selected = rosterIndex === sel;
    const kind = theme.fg(selected ? "text" : "muted", "workflow");
    const name = selected ? theme.fg("text", workflow.name) : workflow.name;
    const left = `  ${this.bullet(rosterIndex, sel, theme)} ${kind}  ${name}`;
    // Frozen once the run settles, exactly as an agent's clock is.
    const elapsed = (workflow.completedAt ?? Date.now()) - workflow.startedAt;
    const agents = `${workflow.doneCount}/${workflow.totalCount} agent${workflow.totalCount === 1 ? "" : "s"}`;
    const stats = `${agents} · ${formatFleetElapsed(elapsed)} · ${formatFleetTokens(workflow.tokens)}`;
    return rightAlign(left, selected ? theme.fg("text", stats) : theme.fg("dim", stats), width);
  }

  private renderAgentRow(rosterIndex: number, sel: number, record: AgentRecord, width: number, theme: Theme): string {
    // The selected row renders in the theme's primary text color so it reads as
    // one selection (#230). A configured badge survives — Claude Code's FleetView
    // keeps the agent color on the selected row too and only bolds it — which also
    // keeps the row's width fixed as the selection moves.
    const selected = rosterIndex === sel;
    const name = renderAgentName(record.type, theme, selected
      ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
      : { fallbackColor: "muted" });
    // Only the record includes nested spend and survives activity cleanup.
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
    const cost = this.showCost() ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
    const stats = `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}${cost ? ` · ${cost}` : ""}`;
    const right = selected ? theme.fg("text", stats) : theme.fg("dim", stats);
    const activity = this.agentActivity.get(record.id);
    let responseText = activity?.responseText ?? "";
    if (record.status === "running" && !activity?.activeTools.size && !responseText.trim()) {
      const messages = record.session?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== "assistant") continue;
        const text = extractText(message.content);
        if (text.trim()) { responseText = text; break; }
      }
    }
    const status = record.status === "running"
      ? activity?.activeTools.size || responseText.trim()
        ? describeActivity(activity?.activeTools ?? new Map(), responseText) : ""
      : record.status === "steered" ? "turn limit"
      : record.status === "error" && record.error ? `error: ${record.error}` : record.status;
    const prefix = `  ${this.bullet(rosterIndex, sel, theme)} ${name}  `;
    const available = Math.max(0, width - visibleWidth(prefix) - visibleWidth(right) - 1);
    const description = stripTerminalSequences(record.description ?? record.type).replace(/\s+/g, " ");
    const activityText = stripTerminalSequences(status).replace(/\s+/g, " ");
    const descriptionWidth = Math.max(0, available - (activityText ? Math.min(visibleWidth(activityText) + 3, Math.ceil(available / 2)) : 0));
    const label = truncateToWidth(description, descriptionWidth);
    const statusWidth = Math.max(0, available - visibleWidth(label) - 3);
    const statusColor = selected ? "text" : record.status === "error" || record.status === "aborted" ? "error"
      : record.status === "steered" || record.status === "stopped" ? "warning" : "dim";
    const left = prefix + (selected ? theme.fg("text", label) : label)
      + (activityText ? theme.fg(statusColor, ` · ${truncateToWidth(activityText, statusWidth)}`) : "");
    return rightAlign(left, right, width);
  }
}
