import type { AgentBeforeSettleEvent, BoundaryResult, CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";

export type CompletionMessage = Omit<CustomMessageEntryDraft, "type">;

const IDLE_RECHECK_MS = 200;

interface PendingCompletion {
  build: () => CompletionMessage | undefined;
  timer?: ReturnType<typeof setTimeout>;
  ready: boolean;
  paused: boolean;
}

/** Keep cancellable ownership until an idle send or a supported continuation boundary. */
export class CompletionOutbox {
  private pending = new Map<string, PendingCompletion>();
  private disposed = false;
  private idleCheck?: ReturnType<typeof setTimeout>;

  constructor(private isIdle: () => boolean, private send: (message: CompletionMessage) => void) {}

  schedule(key: string, build: PendingCompletion["build"], holdMs: number): void {
    if (this.disposed) return;
    this.cancel(key);
    const pending: PendingCompletion = { build, ready: false, paused: false };
    this.pending.set(key, pending);
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      pending.ready = true;
      if (pending.paused && !pending.build()) this.pending.delete(key);
      this.flushIdle();
    }, holdMs);
  }

  cancel(key: string): void {
    const pending = this.pending.get(key);
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    this.pending.delete(key);
  }

  start(): void {
    for (const pending of this.pending.values()) pending.paused = false;
  }

  beforeSettle(event: AgentBeforeSettleEvent): BoundaryResult | undefined {
    if (event.outcome !== "completed") {
      this.pause();
      return;
    }
    const entries = this.takeReady().map(message => ({ type: "custom_message" as const, ...message }));
    if (entries.length) return { entries: [...event.entries, ...entries], continue: true };
  }

  settled(aborted: boolean): void {
    if (aborted) {
      // Escape must not restart the parent via a timer that is still in its hold.
      this.pause();
      return;
    }
    this.flushIdle();
  }

  private pause(): void {
    for (const [key, pending] of this.pending) {
      if (!pending.build()) this.cancel(key);
      else pending.paused = true;
    }
  }

  private takeReady(): CompletionMessage[] {
    const messages: CompletionMessage[] = [];
    for (const [key, pending] of this.pending) {
      if (!pending.ready) continue;
      const message = pending.build();
      if (!message) this.pending.delete(key);
      else if (!pending.paused) {
        this.pending.delete(key);
        messages.push(message);
      }
    }
    return messages;
  }

  private retryIdle(): void {
    if (this.idleCheck !== undefined) return;
    // Manual compaction can finish without an agent settlement event.
    this.idleCheck = setTimeout(() => {
      this.idleCheck = undefined;
      this.flushIdle();
    }, IDLE_RECHECK_MS);
    this.idleCheck.unref();
  }

  private flushIdle(): void {
    if (this.disposed || ![...this.pending.values()].some(pending => pending.ready && !pending.paused)) return;
    if (!this.isIdle()) {
      this.retryIdle();
      return;
    }
    // Sending one message may synchronously start parent activity.
    for (const [key, pending] of this.pending) {
      if (!this.isIdle()) {
        this.retryIdle();
        break;
      }
      if (!pending.ready || pending.paused) continue;
      this.pending.delete(key);
      try {
        const message = pending.build();
        if (message) this.send(message);
      } catch { /* ignore stale completion side-effect errors */ }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleCheck !== undefined) clearTimeout(this.idleCheck);
    this.idleCheck = undefined;
    for (const key of this.pending.keys()) this.cancel(key);
  }
}
