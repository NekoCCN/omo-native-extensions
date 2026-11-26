import { expect, test } from "bun:test";
import { compactTools, renderPanelRows } from "./rows.js";

const paint = (text) => text;

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

test("agent overflow retains the newest live link after eight terminal rows byte for byte", () => {
  const agents = ["✓", "✓", "✗", "-", "✗", "-", "✓", "✓", "●"]
    .map((marker, id) => `\x1b]8;;omo-panel:agent/id%2F${id}\x07\x1b[36m${marker} task ${id}\x1b[39m  \x1b]8;;\x07`);
  const tail = ["", "FILES  1", "\x1b]8;;omo-panel:file/src\x07+ src\x1b]8;;\x07", "", "MEMORY"];
  const rows = ["CONTEXT  5%", "", "\x1b[36mAGENTS  1 running · 8 done\x1b[39m", ...agents, ...tail];

  const rendered = renderPanelRows(rows, { width: 42, background: "BACKGROUND  0", paint });

  expect(rendered.slice(2)).toEqual([
    "CONTEXT  5%", "", "AGENTS  9 · +1 more", agents[8], ...agents.slice(1, 8), ...tail,
  ]);
});

test("unlinked agent markers stop at the next section and fit a compact overflow count", () => {
  const agents = ["◦ one", "● two", "‖ three", "✓ four", "✗ five", "- six", "✓ seven", "- eight", "● nine"];
  const tail = ["TOOLS  1", "- tool"];
  const rows = ["AGENTS  3 ru…", ...agents, ...tail];

  const rendered = renderPanelRows(rows, { width: 12, background: "BACKGROUND", paint });

  expect(rendered.slice(2)).toEqual([
    "AGENTS  9 +1", "◦ one", "● two", "‖ three", "● nine",
    "✗ five", "- six", "✓ seven", "- eight", ...tail,
  ]);
});

test("an eight-agent section retains the native order without overflow", () => {
  const rows = ["AGENTS  2 running · 6 done", "✓ one", "● two", "- three", "✗ four", "✓ five",
    "✓ six", "- seven", "◦ eight", "", "MEMORY"];

  const rendered = renderPanelRows(rows, { width: 42, background: "BACKGROUND  0", paint });

  expect(rendered.slice(2)).toEqual(rows);
});

test("an empty background summary links the first row even when there is no AGENTS section", () => {
  const rows = ["CONTEXT  5%", "", "TOOLS  1", "- tool"];

  const rendered = renderPanelRows(rows, { width: 24, background: "BACKGROUND  0", paint });

  expect(rendered).toEqual([
    "\x1b]8;;omo-sidebar-density:background/current\x07BACKGROUND  0\x1b]8;;\x07", "", ...rows,
  ]);
});
