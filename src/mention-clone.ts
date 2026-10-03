/**
 * Let the parent model formulate a mentioned agent's task off-screen. The clone
 * keeps the active branch and live prompt, but can only call the registered
 * Agent handler, attributed to the parent session. Its background result is
 * delivered to the parent rather than to the discarded clone.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "./child-context.js";
import { agentMentionReminder } from "./mention.js";
import type { SubagentType } from "./types.js";

export interface MentionCloneOptions {
  /** The MAIN session's context — what the spawn is attributed to, and the
   * source of both the conversation and the live system prompt. */
  ctx: ExtensionContext;
  /** Agent type the handle resolved to. */
  type: SubagentType;
  /** What the user typed after the handle. */
  message: string;
  /** The registered `Agent` tool, reused so the spawn is an ordinary one. */
  agentTool: ToolDefinition;
}

export interface MentionCloneResult {
  /** True once the clone actually called `Agent`. */
  spawned: boolean;
  /** Why not, when it didn't. Absent on success. */
  error?: string;
}

/**
 * Fork the conversation, let the copy make the tool call, throw the copy away.
 * Never rejects: a clone that cannot run is reported so the caller can fall
 * back to starting the agent directly.
 */
export async function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult> {
  const { ctx, type, message, agentTool } = opts;

  let spawned = false;
  const cloneAgentTool: ToolDefinition = {
    ...agentTool,
    execute: (_cloneToolCallId, params, signal, onUpdate, cloneCtx) => {
      // One spawn per mention. The clone has a single tool and every reason to
      // stop after using it, but a model that decides to "also" launch a second
      // agent would do it where nobody can see and nobody asked.
      if (spawned) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: "Already started an agent for this mention. Stop here." }],
          details: undefined,
          isError: true,
        });
      }
      spawned = true;
      // No parent tool-call id exists. A foreground result would reach only
      // the discarded clone, so delivery must be through background completion.
      return agentTool.execute(
        undefined as never,
        { ...(params as Record<string, unknown>), run_in_background: true } as typeof params,
        signal,
        onUpdate,
        { ...ctx, tools: cloneCtx.tools, executeTool: cloneCtx.executeTool },
      );
    },
  };

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    // The registry facade has no public runtime accessor; reuse it to retain
    // providers registered only in the parent session.
    const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
    const sessionManager = SessionManager.inMemory(
      ctx.cwd, undefined, structuredClone(ctx.sessionManager.getBranch()),
    );
    const systemPrompt = ctx.getSystemPrompt();
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      appendSystemPromptOverride: () => [],
      extensionFactories: [(pi) => {
        // Force the live prompt verbatim, without appending discovered context.
        pi.on("before_agent_start", () => ({ systemPrompt }));
      }],
    });
    await runInChildSessionContext(() => loader.reload());
    const created = await runInChildSessionContext(() =>
      createAgentSession({
        cwd: ctx.cwd,
        sessionManager,
        model: ctx.model,
        thinkingLevel: ctx.thinkingLevel,
        modelRuntime: parentModelRuntime,
        resourceLoader: loader,
        // `noTools: "all"` would also strip this custom tool.
        tools: [cloneAgentTool.name],
        customTools: [cloneAgentTool],
      }),
    );
    session = created.session;
    await session.bindExtensions({});

    // User text first, reminder after — the order Claude Code's attachment
    // renderer produces, where the reminder trails the message it is about.
    await session.prompt(`${message}\n\n${agentMentionReminder(type)}`);
  } catch (err) {
    return { spawned, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.dispose?.();
  }

  return spawned
    ? { spawned: true }
    : { spawned: false, error: "the conversation clone did not start it" };
}
