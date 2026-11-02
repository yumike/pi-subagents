import { expect, it } from "vitest";
import { decideWorkflowCollision } from "../src/workflow/collisions.js";

it("points collision recovery to global settings and reload or restart", () => {
  const collision = decideWorkflowCollision({
    tools: [{ name: "Workflow", description: "Another orchestrator" }],
    ownDescription: "Our orchestrator",
    pinned: false,
  });

  expect(collision.kind).toBe("standDown");
  if (collision.kind !== "standDown") throw new Error("Expected workflow stand-down");
  expect(collision.message).toContain('Set `"workflowsEnabled": true` in your global subagents.json');
  expect(collision.message).toContain("reload the extension or restart pi");
  expect(collision.message).not.toContain(".pi/subagents.json");
});
