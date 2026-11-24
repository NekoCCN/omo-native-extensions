import { expect, test } from "bun:test";
import { preview, setLimit } from "./config.js";

test.each([[16000, 45], [32000, 50], [64000, 55], [128000, 60], [512000, 70], [922000, 80]])(
  "matches the engine baseline on a %i-token window",
  (window, percent) => {
    expect(preview({ reserveTokens: 1000 }, "test/model", window).baseline).toBe(percent);
  },
);

test("a model's selected percent becomes a reserve without changing other settings", () => {
  const source = {
    compaction: { keepRecentTokens: 24000, modelOverrides: {
      "test/model": { keepRecentTokens: 20000 }, "other/model": { reserveTokens: 1000 },
    } },
    other: true,
  };
  const out = setLimit(source, "test/model", 922000, 70);
  expect(out).toEqual({
    ...source,
    compaction: { ...source.compaction, modelOverrides: {
      ...source.compaction.modelOverrides,
      "test/model": { keepRecentTokens: 20000, reserveTokens: 276600 },
    } },
  });
  expect(preview(out.compaction, "test/model", 922000).trigger).toBe(645400);
});

test("reset removes only the selected model's reserve", () => {
  const source = { compaction: { reserveTokens: 20000, modelOverrides: {
    "test/model": { reserveTokens: 300000, keepRecentTokens: 20000 },
    "other/model": { reserveTokens: 70000 },
  } } };
  expect(setLimit(source, "test/model", 922000).compaction).toEqual({
    reserveTokens: 20000,
    modelOverrides: { "test/model": { keepRecentTokens: 20000 }, "other/model": { reserveTokens: 70000 } },
  });
});

test("does not offer a threshold later than the engine baseline", () => {
  expect(() => setLimit({}, "test/model", 922000, 85)).toThrow(RangeError);
});

test("preview accounts for reserve scaling and the earlier trigger", () => {
  expect(preview({}, "test/model", 922000)).toMatchObject({ baseline: 80, reserve: 36880, trigger: 737600 });
});
