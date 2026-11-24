/**
 * @typedef {{trigger: "prompt" | "delivery" | "extension", systemPrompt: string}} PromptStart
 * @typedef {{sessionManager: {getHeader(): {spawnedBy?: object} | undefined}}} PromptContext
 * @typedef {(event: PromptStart, ctx: PromptContext) => {systemPrompt: string, systemPromptCache: "stable"} | undefined} PromptHandler
 * @typedef {{sessionKind: "interactive" | "worker", on(name: "before_agent_start", handler: PromptHandler, options: {previewSafe: true}): void}} PlanningHost
 */

const guidance = [
  "## OMO planning checkpoint",
  "Stop scoping when you know the outcome, owner, and proof; for bugs, reproduce or trace the cause. Plan before editing if a consequential decision is open, callers rely on the behavior, or changes need coordination. When the evidence favors one approach, proceed without another approval.",
  "Default to mass-ulw for execution; only clear mechanical local edits bypass it. A reply alone is not execution. Save a lightweight plan before a DAG; run one native workflow per phase for real handoffs, not standalone parallel task batches or invented nodes.",
  "Continue authorized work, revise only what new evidence changes, and stop once the acceptance checks pass. Full Ultrawork requires explicit invocation; follow any active workflow. Use Superpowers for implementation methods, not planning.",
].join("\n");

/** @param {PlanningHost} pi */
export default function planningGuide(pi) {
  if (pi.sessionKind === "worker") return;
  pi.on("before_agent_start", (event, ctx) => {
    if (event.trigger !== "prompt" || ctx.sessionManager.getHeader()?.spawnedBy) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
      systemPromptCache: "stable",
    };
  }, { previewSafe: true });
}
