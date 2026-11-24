import { expect, test } from "bun:test";
import planningGuide from "./index.js";

function promptResult({ trigger = "prompt", spawnedBy, sessionKind = "interactive" } = {}) {
  let result;
  planningGuide({
    sessionKind,
    on(name, handler) {
      if (name === "before_agent_start") {
        result = handler(
          { trigger, systemPrompt: "Existing system prompt" },
          { sessionManager: { getHeader: () => ({ spawnedBy }) } },
        );
      }
    },
  });
  return result;
}

test("a root prompt keeps its original instructions and receives additional guidance", () => {
  const { systemPrompt } = promptResult();
  expect(systemPrompt.startsWith("Existing system prompt\n")).toBe(true);
  expect(systemPrompt.trimEnd()).not.toBe("Existing system prompt");
});

test("a spawned task does not receive parent planning instructions", () => {
  expect(promptResult({ spawnedBy: { parentSessionId: "parent", taskId: "child" } })).toBeUndefined();
});

test("a worker attachment does not receive planning instructions", () => {
  expect(promptResult({ sessionKind: "worker" })).toBeUndefined();
});

test.each(["delivery", "extension"])("a %s turn does not receive planning instructions", (trigger) => {
  expect(promptResult({ trigger })).toBeUndefined();
});
