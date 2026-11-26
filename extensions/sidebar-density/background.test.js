import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

// Production resolves this virtual module from the host, not the package manifest.
const nativeTui = process.env.BACKGROUND_TEST_PI_TUI;
const tuiExports = nativeTui ? await import(nativeTui) : {
  Key: { up: "\x1b[A", down: "\x1b[B", escape: "\x1b" },
  matchesKey: (data, key) => data === key,
  truncateToWidth: (text, width) => Bun.stringWidth(text) <= width
    ? text : `${Bun.sliceAnsi(text, 0, Math.max(0, width - 1))}…`,
  visibleWidth: Bun.stringWidth,
};
mock.module("@earendil-works/pi-tui", () => tuiExports);
const { createBackgroundTasks } = await import("./background.js");

const wake = "wake_source_state";
const monitorState = "terminal_monitor_state";
const startedAtMs = 1000;
const shell = (id, description) => ({ id, description, startedAtMs });
const monitor = (id, description, paused = false) => ({ id, description, paused, startedAtMs });

function session() {
  const events = new EventEmitter();
  const lifecycle = new EventEmitter();
  const bg = createBackgroundTasks({ events, on: lifecycle.on.bind(lifecycle) });
  return {
    bg,
    events,
    end: () => lifecycle.emit("session_shutdown"),
    shells: (items) => events.emit(wake, {
      source: "terminal-background-sessions", activeCount: items.length, items,
    }),
    monitors: (monitors) => events.emit(monitorState, { activeCount: monitors.length, monitors }),
  };
}

function openPopup(bg, { width = 48, rows = 12 } = {}) {
  const editor = {};
  let focus = editor;
  let component;
  let onInput;
  let shown = false;
  let redraws = 0;
  const tui = {
    terminal: { columns: width + 4, rows },
    requestRender: () => { redraws += 1; },
    getFocusedComponent: () => focus,
    isOverlayFocused: () => focus !== editor,
  };
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
  const ui = {
    onTerminalInput(listener) {
      onInput = listener;
      return () => { onInput = undefined; };
    },
    custom(factory, options) {
      return new Promise((resolve) => {
        component = factory(tui, theme, undefined, () => {
          shown = false;
          component.dispose();
          resolve();
        });
        shown = options.overlay;
        if (!options.overlayOptions.nonCapturing) focus = component;
        options.onHandle({
          getBounds: () => shown ? { row: 1, col: 2, width, height: rows - 2 } : undefined,
          hide: () => { shown = false; },
        });
      });
    },
  };
  const closed = bg.open({ ui });
  return {
    closed,
    frame: () => shown ? component.render(width) : [],
    type: (data) => onInput?.(data),
    mouse: (event) => component.handleMouse(event),
    keepsEditorFocus: () => focus === editor,
    focusOtherOverlay: () => { focus = {}; },
    redraws: () => redraws,
  };
}

test("early snapshots count shell jobs and monitors separately from other wake sources", () => {
  const current = session();
  current.shells([shell("sh-1", "Compile"), shell("sh-2", "Check")]);
  current.monitors([monitor("watch-1", "Wait for results", true)]);
  for (const source of ["terminal-monitors", "subagents"]) {
    current.events.emit(wake, { source, activeCount: 7, items: [shell("other", "Ignore")] });
  }

  const summary = current.bg.summary();
  expect(summary).toMatch(/^BACKGROUND\s+2sh 1mon ›$/u);
  expect(Bun.stringWidth(summary)).toBeLessThanOrEqual(24);
  expect(session().bg.summary()).toMatch(/^BACKGROUND\s+0sh 0mon/u);
});

test("zero snapshots clear just their source, and unsubscribe stops delivery", () => {
  const current = session();
  current.shells([shell("sh-1", "Compile")]);
  current.monitors([monitor("watch-1", "Wait for results")]);
  const seen = [];
  const stop = current.bg.subscribe(() => seen.push(current.bg.summary().match(/\d+/gu)));

  current.shells([]);
  stop();
  current.monitors([]);

  expect(seen).toEqual([["0", "1"]]);
  expect(current.bg.summary()).toMatch(/^BACKGROUND\s+0sh 0mon/u);
  expect(openPopup(current.bg).frame().join("\n")).toMatch(/No active shell jobs or monitors/u);
});

test("the popup redraws for monitor pause changes and renders only cleaned display metadata", () => {
  const current = session();
  current.shells([
    { ...shell("sh-1", "\x1b[31m编译\x1b[0m\nassets\x00"), output: "PRIVATE_JOB_OUTPUT" },
    shell("sh-2", "BUILD_MARKER=private-value curl --user build:sample-secret"),
  ]);
  current.monitors([{ ...monitor("watch-1", "Watch test log"), command: "PRIVATE_COMMAND", filter: "PRIVATE_FILTER" }]);
  const popup = openPopup(current.bg, { width: 45 });
  const before = popup.frame().join("\n");
  const redraws = popup.redraws();

  current.monitors([monitor("watch-1", "Watch test log", true)]);
  const after = popup.frame().join("\n");

  expect(popup.redraws()).toBeGreaterThan(redraws);
  expect(before).toMatch(/Monitor\s+Watching\s+Watch test log/u);
  expect(after).toMatch(/Monitor\s+Paused\s+Watch test log/u);
  expect(after).toMatch(/Shell\s+Running\s+编译 assets/u);
  expect(after).not.toMatch(/PRIVATE_|private-value|sample-secret|\x1b|\x00/u);
});

test("scrolling changes only the list inside a rounded viewport and keeps normal typing available", async () => {
  const current = session();
  current.shells(Array.from({ length: 12 }, (_, index) => shell(`job-${index}`, `Job ${index + 1}`)));
  const popup = openPopup(current.bg, { width: 32 });
  const first = popup.frame();

  expect(popup.keepsEditorFocus()).toBe(true);
  expect(popup.type("x")).toBeUndefined();
  expect(popup.type("\x1b[B")).toEqual({ consume: true });
  expect(popup.mouse({ type: "wheel", wheelDelta: 20 })).toEqual({ handled: true, render: true });
  const last = popup.frame();

  expect(first[0]).toMatch(/^╭─+╮$/u);
  expect(first.at(-1)).toMatch(/^╰─+╯$/u);
  expect(first.join("\n")).not.toContain("Job 12");
  expect(last.join("\n")).toContain("Job 12");
  expect(last.slice(0, 2)).toEqual(first.slice(0, 2));
  expect(last.at(-1)).toBe(first.at(-1));
  expect(last.map((line) => Bun.stringWidth(line))).toEqual(first.map(() => 32));

  expect(popup.type("\x1b")).toEqual({ consume: true });
  await popup.closed;
  expect(popup.frame()).toEqual([]);
  expect(popup.type("\x1b")).toBeUndefined();
});

test("another overlay keeps its keys, and a retired session cannot reopen its task list", async () => {
  const current = session();
  current.shells([shell("sh-1", "Compile")]);
  const popup = openPopup(current.bg);
  popup.frame();
  popup.focusOtherOverlay();

  expect(popup.type("\x1b")).toBeUndefined();
  current.end();
  current.shells([shell("sh-2", "Late snapshot")]);
  await popup.closed;

  expect(popup.frame()).toEqual([]);
  expect(current.bg.summary()).toMatch(/^BACKGROUND\s+0sh 0mon/u);
  expect(popup.type("\x1b[B")).toBeUndefined();
});
