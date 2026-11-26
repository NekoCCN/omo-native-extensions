import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

// Production resolves this virtual module from the host, not the package manifest.
const keys = {
  up: "\x1b[A", down: "\x1b[B", escape: "\x1b", enter: "\r",
  pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F",
};
const nativeTui = process.env.BACKGROUND_TEST_PI_TUI;
const tuiExports = nativeTui ? await import(nativeTui) : {
  Key: keys,
  matchesKey: (data, key) => data === key,
  truncateToWidth: (text, width) => Bun.stringWidth(text) <= width
    ? text : `${Bun.sliceAnsi(text, 0, Math.max(0, width - 1))}…`,
  visibleWidth: Bun.stringWidth,
  wrapTextWithAnsi: (text, width) => Bun.wrapAnsi(text, width, { hard: true }).split("\n"),
};
mock.module("@earendil-works/pi-tui", () => tuiExports);

const fixtureData = new WeakMap();
const { createBackgroundData } = await import("./background-data.js");
mock.module("./background-data.js", () => ({
  // Keep the real provider for its own tests when running the entire suite.
  createBackgroundData: (pi) => fixtureData.get(pi) ?? createBackgroundData(pi),
}));
const { createBackgroundTasks } = await import("./background.js");

const wake = "wake_source_state";
function session(data) {
  const events = new EventEmitter();
  const commands = new Map();
  const pi = {
    events: { on(name, listener) {
      events.on(name, listener);
      return () => events.off(name, listener);
    } },
    on: events.on.bind(events),
    registerCommand: commands.set.bind(commands),
  };
  if (data) fixtureData.set(pi, data);
  return { bg: createBackgroundTasks(pi), events, commands, end: () => events.emit("session_shutdown") };
}

const job = (id, title, details = []) => ({ key: `shell:${id}`, id, title, details, role: "Shell", state: "Running" });

function source(initialRows, preview = async () => undefined) {
  const listeners = new Set();
  let rows = initialRows;
  const current = session({
    rows: () => rows, preview,
    summary: () => `BACKGROUND  ${rows.length}sh 0mon ›`,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    ...current, listeners,
    change(nextRows) {
      rows = nextRows;
      for (const listener of listeners) listener();
    },
  };
}

function host({ width = 48, rows = 12 } = {}) {
  const editor = { draft: "未提交 draft", handleInput: mock() };
  const stack = [];
  let focus = editor;
  let redraws = 0;
  const tui = { terminal: { columns: width + 4, rows }, requestRender: () => { redraws += 1; } };
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
  const hide = (entry) => {
    const index = stack.indexOf(entry);
    if (index === -1) return;
    stack.splice(index, 1);
    if (focus === entry) focus = stack.at(-1) ?? editor;
  };
  const ui = {
    custom(factory, { overlay, overlayOptions, onHandle }) {
      expect(overlay).toBe(true);
      const { promise, resolve } = Promise.withResolvers();
      const entry = factory(tui, theme, undefined, () => {
        hide(stack.at(-1));
        entry.dispose?.();
        resolve();
      });
      queueMicrotask(() => {
        stack.push(entry);
        if (!overlayOptions.nonCapturing) focus = entry;
        onHandle({ hide: () => hide(entry) });
      });
      return promise;
    },
  };
  return {
    ctx: { ui, mode: "tui", hasUI: true },
    editor, stack,
    frame: () => stack.find((entry) => entry.render)?.render(tui.terminal.columns - 4) ?? [],
    text() { return this.frame().join("\n"); },
    type: (data) => focus.handleInput?.(data),
    mouse: (event) => focus.handleMouse?.(event),
    resize: (size) => Object.assign(tui.terminal, size),
    focusOtherOverlay() {
      focus = { handleInput: mock() };
      stack.push(focus);
      return focus;
    },
    redraws: () => redraws,
  };
}

test("the open list redraws from the background bus without exposing raw metadata", async () => {
  const current = session();
  const shells = (items) => current.events.emit(wake, { source: "terminal-background-sessions", items });
  const monitors = (monitors) => current.events.emit("terminal_monitor_state", { monitors });
  const watch = { id: "watch-1", description: "Watch test log", command: "PRIVATE_COMMAND", filter: "PRIVATE_FILTER" };
  shells([
    { id: "sh-1", description: "\x1b[31m编译\x1b[0m\nassets\x00", output: "PRIVATE_JOB_OUTPUT" },
    { id: "sh-2", description: "BUILD_MARKER=private-value curl --user build:sample-secret" },
  ]);
  monitors([watch]);
  current.events.emit(wake, { source: "subagents", items: [{ id: "other", description: "Ignore" }] });
  const summary = current.bg.summary();
  expect(summary).toMatch(/^BACKGROUND\s+2sh 1mon ›$/u);
  expect(Bun.stringWidth(summary)).toBeLessThanOrEqual(24);
  const popup = host({ width: 45 });
  const closed = current.bg.open(popup.ctx);
  await Promise.resolve();
  expect(popup.text()).toMatch(/Monitor\s+Watching\s+Watch test log/u);
  const redraws = popup.redraws();
  monitors([{ ...watch, paused: true }]);
  const after = popup.text();
  expect(popup.redraws()).toBeGreaterThan(redraws);
  expect(after).toMatch(/Monitor\s+Paused\s+Watch test log/u);
  expect(after).toMatch(/Shell\s+Running\s+编译 assets/u);
  expect(after).not.toMatch(/PRIVATE_|private-value|sample-secret|\x1b|\x00/u);
  shells([]);
  expect(popup.text()).toMatch(/Shell\s+Unlisted\s+编译 assets/u);
  expect(popup.text()).not.toMatch(/Shell\s+Running/u);
  expect(current.bg.summary()).toMatch(/^BACKGROUND\s+0sh 1mon/u);
  current.end();
  await closed;
});

test("/background and the sidebar share one focused overlay and Esc preserves the draft", async () => {
  const current = source([job("a", "Alpha"), job("b", "Beta", ["Beta evidence"])]);
  const popup = host();
  const command = current.commands.get("background");
  expect(command?.handler).toBeFunction();
  const closed = command.handler("", popup.ctx);
  expect(current.bg.open(popup.ctx)).toBe(closed);
  await Promise.resolve();
  expect(popup.stack).toHaveLength(1);
  expect(popup.text()).toMatch(/›.*Alpha/u);
  popup.type(keys.down);
  popup.type(keys.enter);
  expect(popup.text()).toContain("Beta evidence");
  popup.type("\t");
  popup.type("编");
  expect(popup.editor.handleInput).not.toHaveBeenCalled();
  current.change([job("b", "Beta"), job("a", "Alpha")]);
  popup.type(keys.escape);
  expect(popup.text()).toMatch(/›.*Beta/u);
  popup.type(keys.escape);
  await closed;
  expect(popup.stack).toHaveLength(0);
  expect(popup.editor.draft).toBe("未提交 draft");
  for (const key of ["\t", "编", keys.down]) popup.type(key);
  expect(popup.editor.handleInput.mock.calls).toEqual([["\t"], ["编"], [keys.down]]);
});

test("empty and long lists share a rounded frame; click opens the visible row and its preview after resize", async () => {
  const preview = mock(async ({ id }) => `Preview of ${id}`);
  const current = source([], preview);
  const popup = host({ width: 32 });
  const closed = current.bg.open(popup.ctx);
  await Promise.resolve();
  const empty = popup.frame();
  expect(empty.join("\n")).toContain("No background tasks");
  popup.type(keys.enter);
  expect(preview).not.toHaveBeenCalled();
  current.change(Array.from({ length: 12 }, (_, i) => job(`job-${i + 1}`, `编译 ${i + 1}`, [`Evidence ${i + 1}`])));
  expect(popup.text()).not.toContain("编译 12");
  expect(popup.mouse({ type: "wheel", wheelDelta: 20 })).toEqual({ handled: true, render: true });
  const last = popup.frame();
  expect([last[0], last[1], last.at(-1)]).toEqual([empty[0], empty[1], empty.at(-1)]);
  expect([last[0], last.at(-1)]).toEqual([`╭${"─".repeat(30)}╮`, `╰${"─".repeat(30)}╯`]);
  expect(last.map((line) => Bun.stringWidth(line))).toEqual(empty.map(() => 32));
  popup.resize({ columns: 60, rows: 9 });
  const resized = popup.frame();
  const y = resized.findIndex((line) => line.includes("编译 12"));
  expect(resized.map((line) => Bun.stringWidth(line))).toEqual(Array(7).fill(56));
  expect(popup.mouse({ type: "click", button: "left", x: 2, y })).toMatchObject({ handled: true });
  expect(popup.text()).toContain("ID: job-12");
  await Promise.resolve();
  popup.type(keys.end);
  expect(popup.text()).toMatch(/Evidence 12[\s\S]*Preview of job-12/u);
  const back = popup.frame().findIndex((line) => line.includes("Esc back"));
  popup.mouse({ type: "click", button: "left", x: 2, y: back });
  expect(popup.text()).toMatch(/›.*编译 12/u);
  popup.type(keys.escape);
  await closed;
});

test("detail supports paging and discards preview results after switching or closing", async () => {
  const alpha = Promise.withResolvers();
  const beta = Promise.withResolvers();
  const preview = mock(({ id }) => (id === "a" ? alpha.promise : beta.promise));
  const current = source([job("a", "Alpha"), job("b", "Beta", Array.from({ length: 24 }, (_, i) => `Detail ${i + 1}`))], preview);
  const popup = host();
  const closed = current.bg.open(popup.ctx);
  await Promise.resolve();
  expect(preview).not.toHaveBeenCalled();
  popup.type(keys.enter);
  expect(popup.text()).toContain("Loading preview");
  popup.type(keys.escape);
  popup.type(keys.down);
  popup.type(keys.enter);
  const before = popup.frame();
  expect(before.join("\n")).toMatch(/Detail 1\b/u);
  expect(before.join("\n")).not.toContain("Detail 24");
  alpha.resolve("STALE ALPHA");
  await alpha.promise;
  popup.type(keys.pageDown);
  const paged = popup.frame();
  expect(paged.join("\n")).not.toMatch(/Detail 1\b/u);
  expect([paged[0], paged[1], paged.at(-1)]).toEqual([before[0], before[1], before.at(-1)]);
  popup.type(keys.end);
  expect(popup.text()).toContain("Detail 24");
  expect(popup.text()).not.toContain("STALE ALPHA");
  popup.type(keys.home);
  expect(popup.text()).toMatch(/Detail 1\b/u);
  popup.type(keys.escape);
  popup.type(keys.escape);
  await closed;
  const redraws = popup.redraws();
  beta.resolve("STALE BETA");
  await beta.promise;
  expect(popup.redraws()).toBe(redraws);
  expect(current.listeners.size).toBe(0);
});

test("an open shell detail discards a running preview when the shell leaves the active list", async () => {
  const running = Promise.withResolvers();
  const shell = job("a", "Alpha");
  const preview = mock(({ state }) => state === "Running" ? running.promise
    : Promise.resolve("Terminal screen snapshot\nstatus: exited_7 exit_code: 7"));
  const current = source([shell], preview);
  const popup = host();
  const closed = current.bg.open(popup.ctx);
  await Promise.resolve();
  popup.type(keys.enter);
  current.change([shell, { ...job("b", "Other"), role: "Monitor", state: "Watching" }]);
  expect(preview).toHaveBeenCalledTimes(1);

  const recent = { ...shell, state: "Unlisted" };
  current.change([recent]);
  await Promise.resolve();
  running.resolve("Terminal screen snapshot\nstatus: running");
  await running.promise;

  expect(popup.text()).toContain("status: exited_7 exit_code: 7");
  expect(popup.text()).not.toContain("status: running");
  popup.type(keys.escape);
  popup.type(keys.escape);
  await closed;
});

test("shutdown removes only its overlay, including a handle delivered after shutdown", async () => {
  const current = source([job("a", "Alpha")]);
  const popup = host();
  const closed = current.bg.open(popup.ctx);
  await Promise.resolve();
  const other = popup.focusOtherOverlay();
  popup.type(keys.escape);
  expect(other.handleInput).toHaveBeenCalledWith(keys.escape);
  current.end();
  await closed;
  await current.bg.open(popup.ctx);
  expect(popup.stack).toEqual([other]);
  expect(current.listeners.size).toBe(0);
  const reloaded = source([job("b", "Beta")]);
  const late = reloaded.bg.open(popup.ctx);
  reloaded.end();
  await late;
  expect(popup.stack).toEqual([other]);
  expect(reloaded.listeners.size).toBe(0);
});
