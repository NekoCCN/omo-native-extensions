import { expect, test } from "bun:test";
import { parse } from "jsonc-parser";
import { selectPrimary, readRoute, setRouteField } from "./config.js";

test("changing the primary keeps the other rungs, per-model tuning and unrelated JSONC", () => {
  const source = `// User configuration
{
  "[native]": {
    // Side panel is independent of routing.
    "side_panel": {"enabled": true},
    "agents": {
      "worker": {
        "model": "one/primary",
        "models": [
          "one/primary",
          {"model": "two/alternate", "reasoning": "high"},
          "three/backup"
        ]
      }
    }
  }
}`;
  const result = selectPrimary(source, "agents", "worker", "two/alternate");
  expect(parse(result)["[native]"].agents.worker).toEqual({
    models: [{ model: "two/alternate", reasoning: "high" }, "one/primary", "three/backup"],
  });
  expect(result).toContain("// Side panel is independent of routing.");
  expect(parse(result)["[native]"].side_panel).toEqual({ enabled: true });
});

test("pins an unconfigured category without touching other layers or inventing fallbacks", () => {
  const source = '{ "[opencode]": {"categories": {"quick": {"model":"not/this"}}} }';
  const result = parse(selectPrimary(source, "categories", "quick", "one/new"));
  expect(result["[native]"].categories.quick).toEqual({ model: "one/new" });
  expect(result["[opencode]"].categories.quick.model).toBe("not/this");
});

test("does not try to repair malformed JSONC when writing a model", () => {
  expect(() => selectPrimary('{"broken":,}', "agents", "worker", "one/new")).toThrow();
});

test("an explicit effort overrides the selected chain entry without changing fallback effort", () => {
  const source = JSON.stringify({ "[native]": { agents: { worker: {
    models: [{ model: "one/primary", reasoning: "low" }, { model: "two/backup", reasoning: "medium" }],
  } } } });
  const result = parse(selectPrimary(source, "agents", "worker", "one/primary", "high"));
  expect(result["[native]"].agents.worker.models).toEqual([
    { model: "one/primary", reasoning: "high" },
    { model: "two/backup", reasoning: "medium" },
  ]);
});

test("an explicit effort applies to a single-model category", () => {
  const result = parse(selectPrimary("{}", "categories", "quick", "one/new", "minimal"));
  expect(result["[native]"].categories.quick).toEqual({ model: "one/new", reasoning: "minimal" });
});

test("a profile-only role cannot be promoted to a global route by the model picker", () => {
  const source = JSON.stringify({ profiles: { focused: { "[native]": {
    agents: { reviewer: { model: "one/primary" } },
  } } } });
  expect(() => selectPrimary(source, "agents", "reviewer", "two/new")).toThrow(/focused/u);
});

test.each([false, true])("writes an active profile's route in place (global role: %s)", (globalRole) => {
  const user = {
    ...(globalRole ? { "[native]": { agents: { reviewer: { model: "global/default" } } } } : {}),
    profiles: {
      focused: { "[native]": { agents: { reviewer: { model: "focused/old", prompt: "Keep role instructions" } } } },
      sibling: { "[native]": { agents: { reviewer: { model: "sibling/default" } } } },
    },
  };
  const result = parse(selectPrimary(JSON.stringify(user), "agents", "reviewer", "focused/new", "medium", "focused"));
  expect(result).toEqual({
    ...user,
    profiles: {
      ...user.profiles,
      focused: { "[native]": { agents: { reviewer: { model: "focused/new", reasoning: "medium", prompt: "Keep role instructions" } } } },
    },
  });
});

test.each([{}, { models: ["one/default"] }])("does not pin a default for the parent-model role (%j)", (role) => {
  const source = JSON.stringify({ "[native]": { agents: { "technical-lead": role } } });
  expect(() => selectPrimary(source, "agents", "technical-lead", "two/new")).toThrow(/父会话/u);
});

test("Thinking edits the active model's rung without changing model order, distribution or description", () => {
  const role = {
    models: ["one/fallback", { model: "two/active", reasoning: "low" }],
    models_distribution: "round_robin", description: "Read diagrams",
  };
  const source = JSON.stringify({ "[native]": { agents: { reader: role } } });
  const out = setRouteField(source, "agents", "reader", "reasoning", "high", undefined, "two/active");
  expect(parse(out)["[native]"].agents.reader).toEqual({
    ...role, models: ["one/fallback", { model: "two/active", reasoning: "high" }],
  });
});

test("editing the inherited role description does not create a model or effort", () => {
  const source = '{"[native]":{"agents":{"technical-lead":{"prompt":"Keep me"}}}}';
  const out = setRouteField(source, "agents", "technical-lead", "description", "Lead");
  expect(parse(out)["[native]"].agents["technical-lead"]).toEqual({ prompt: "Keep me", description: "Lead" });
});

test("reads the profile description while inheriting an unspecified route-level effort", () => {
  const source = JSON.stringify({
    "[native]": { categories: { quick: { description: "Global", reasoning: "low" } } },
    profiles: { herdr: { "[native]": { categories: { quick: { description: "Scoped" } } } } },
  });
  expect(readRoute(source, "categories", "quick", "herdr")).toEqual({ description: "Scoped", reasoning: "low" });
});

test("a new model does not inherit the old model's per-entry Thinking override", () => {
  const source = '{"[native]":{"agents":{"worker":{"models":[{"model":"one/old","reasoning":"high"}]}}}}';
  expect(parse(selectPrimary(source, "agents", "worker", "two/new"))["[native]"].agents.worker.models)
    .toEqual(["two/new", { model: "one/old", reasoning: "high" }]);
});

test("a profile with an inherited model chain can override Thinking without changing the global chain", () => {
  const models = [{ model: "one/model", reasoning: "low" }, "two/backup"];
  const user = {
    "[native]": { agents: { worker: { models } } },
    profiles: { herdr: { "[native]": { agents: { worker: { description: "Profile note" } } } } },
  };
  const out = setRouteField(JSON.stringify(user), "agents", "worker", "reasoning", "high", "herdr", "one/model");
  expect(parse(out)).toEqual({
    ...user,
    profiles: { herdr: { "[native]": { agents: { worker: {
      description: "Profile note", models: [{ model: "one/model", reasoning: "high" }, "two/backup"],
    } } } } },
  });
});
