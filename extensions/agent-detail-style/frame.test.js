import { expect, test } from "bun:test";
import {
  agentContent,
  capOf,
  createFolds,
  cycleFocus,
  foldIdsOf,
  isAgentFrame,
  isOpen,
  isSubagentOverlayTarget,
  readFrame,
  rowLabel,
  toggleFold,
} from "./frame.js";

const TITLE = "my-agent  (agent)";
const HEAD = ["status ● running", "elapsed 12s", "turns 4"];
const PROSE_FIRST = "assistant: first line of a long explanation that keeps going past narrow widths";
const PROSE_TAIL = "second line of the same turn carrying tail token TAIL-XYZ-7";
const BODY = [
  PROSE_FIRST,
  PROSE_TAIL,
  "third line still same turn",
  "tool: read",
  "tool: read",
  "tool: bash",
  "user: follow up question here",
  "error: something failed badly",
];

function frameLines(rows, footer, width = 110, title = TITLE) {
  const inner = width - 4;
  const body = [title, ...rows, footer].map((text) => `│ ${text.padEnd(inner).slice(0, inner)} │`);
  return [`┌${"─".repeat(width - 2)}┐`, ...body, `└${"─".repeat(width - 2)}┘`];
}

function mustSnapshot(lines) {
  const frame = readFrame(lines);
  expect(frame).toBeDefined();
  const snapshot = agentContent(frame);
  expect(snapshot).toBeDefined();
  return snapshot;
}

test("parses the native agent frame into metadata and foldable blocks", () => {
  const snapshot = mustSnapshot(frameLines([...HEAD, "", ...BODY], "esc close"));
  expect(snapshot.metadata.get("status")).toBe("● running");
  expect(snapshot.blocks.length).toBe(4);
  const [prose, tools] = snapshot.blocks;
  expect(prose.start).toBe(0);
  expect(prose.hidden).toBe(2);
  expect(prose.preview).toBe(PROSE_FIRST);
  expect(tools.preview).toBe("Tools  read ×2 · bash");
  expect(tools.hidden).toBe(3);
});

test("rejects non-agent popups and malformed frames", () => {
  expect(readFrame(["short"])).toBeUndefined();
  const menu = frameLines(["pick one", "", "aaa", "bbb"], "esc close", 64, "menu");
  const parsed = readFrame(menu);
  expect(parsed).toBeDefined();
  expect(isAgentFrame(parsed)).toBe(false);
  expect(agentContent({ title: "x (agent)", rows: ["nope", "", "user: hi"] })).toBeUndefined();
});

test("keeps a paged native footer as an explicit range", () => {
  const frame = readFrame(frameLines([...HEAD, "", ...BODY], "1-27/59  ↑↓/wheel  esc close"));
  expect(frame?.range?.[3]).toBe("59");
  const snapshot = agentContent(frame);
  expect(snapshot).toBeDefined();
  const cap = capOf(frame);
  expect(cap?.total).toBe(59);
  expect(capOf({ range: undefined })).toBeUndefined();
});

test("folds toggle independently and Tab cycles focused folds", () => {
  const snapshot = mustSnapshot(frameLines([...HEAD, "", ...BODY], "esc close"));
  const ids = foldIdsOf(snapshot);
  expect(ids).toEqual([0, 3]);
  const folds = createFolds();
  expect(folds.focusId).toBeUndefined();
  for (const id of ids) expect(isOpen(folds, id)).toBe(false);
  toggleFold(folds, ids[0]);
  expect(isOpen(folds, ids[0])).toBe(true);
  expect(isOpen(folds, ids[1])).toBe(false);
  cycleFocus(folds, ids);
  expect(folds.focusId).toBe(ids[0]);
  cycleFocus(folds, ids);
  expect(folds.focusId).toBe(ids[1]);
  folds.openAll = true;
  expect(isOpen(folds, ids[1])).toBe(true);
});

test("labels plain, user, and error rows for themed rendering", () => {
  expect(rowLabel("assistant: hello")).toBe("assistant");
  expect(rowLabel("tool[error]: boom")).toBe("tool[error]");
  expect(rowLabel("error: bad")).toBe("error");
  expect(rowLabel("just prose")).toBeUndefined();
});

test("gates only the real native details overlay shape", () => {
  const component = { scrollBy() {}, render: () => [] };
  expect(isSubagentOverlayTarget({ anchor: "center", width: "70%", minWidth: 52 }, component)).toBe(true);
  expect(isSubagentOverlayTarget({ anchor: "center", width: "50%", minWidth: 52 }, component)).toBe(false);
  expect(isSubagentOverlayTarget({ anchor: "center", width: "70%", minWidth: 52 }, {})).toBe(false);
  expect(isSubagentOverlayTarget(undefined, component)).toBe(false);
});
