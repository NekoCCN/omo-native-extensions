import { expect, test } from "bun:test";
import { compactTools } from "./rows.js";

test("the tool summary accounts for two more hidden calls while preserving the newest four", () => {
  const rows = ["CONTEXT  5%", "TOOLS  8 · +2 earlier", "a", "b", "c", "d", "e", "f", "", "MEMORY"];
  expect(compactTools(rows, (text) => text)).toEqual([
    "CONTEXT  5%", "TOOLS  8 · +4 earlier", "c", "d", "e", "f", "", "MEMORY",
  ]);
});

test("short tool lists do not lose rows", () => {
  const rows = ["TOOLS  2", "a", "b", "", "MEMORY"];
  expect(compactTools(rows, (text) => text)).toEqual(rows);
});
