import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { createBackgroundData } from "./background-data.js";

const monitorNotification = "senpi-monitor:notification";

function fixture(executeTool) {
  const bus = new EventEmitter();
  const lifecycle = new EventEmitter();
  const data = createBackgroundData({
    events: {
      on(name, listener) {
        bus.on(name, listener);
        return () => bus.off(name, listener);
      },
    },
    on: lifecycle.on.bind(lifecycle),
    executeTool,
  });

  return {
    data,
    bus,
    lifecycle,
    shell(items) {
      bus.emit("wake_source_state", { source: "terminal-background-sessions", activeCount: items.length, items });
    },
    monitors(monitors) {
      bus.emit("terminal_monitor_state", { activeCount: monitors.length, monitors });
    },
  };
}

const shell = (id, description = "Build") => ({ id, description, startedAtMs: 1000 });
const monitor = (paused = false) => ({
  id: "sh_1",
  description: "Watch build",
  command: "TOKEN=private-env-command",
  filter: "private-filter",
  paused,
  startedAtMs: 1100,
  persistent: false,
  deadlineMs: 8000,
  fireCount: paused ? 2 : 0,
  lastFiredAtMs: paused ? 1200 : undefined,
});
const ending = {
  id: "sh_1",
  description: "Watch build",
  startedAtMs: 1100,
  endedAtMs: 2000,
  reason: "exit",
  exitCode: 17,
  fireCount: 2,
};
const context = (branch) => ({ sessionManager: { getBranch: () => branch } });

test("updates by role and ID, collapses duplicate snapshots and keeps the selected key", () => {
  const { data, bus, shell: publishShell, monitors } = fixture();
  let changes = 0;
  const stop = data.subscribe(() => { changes += 1; });
  publishShell([shell("sh_1"), shell("sh_1"), shell("sh_2")]);
  monitors([monitor()]);
  const first = data.rows();
  const selection = first.find(({ role }) => role === "Monitor").key;
  expect(new Set(first.map(({ key }) => key)).size).toBe(3);
  expect(first.filter(({ id }) => id === "sh_1").map(({ role, state, title }) => [role, state, title]))
    .toEqual([["Shell", "Running", "Build"], ["Monitor", "Watching", "Watch build"]]);
  expect(data.summary()).toBe("BACKGROUND  2sh 1mon ›");

  bus.emit("wake_source_state", { source: "terminal-monitors", activeCount: 0, monitors: [] });
  monitors([monitor()]);
  expect(changes).toBe(2);
  publishShell([shell("sh_2"), shell("sh_1", "New title")]);
  monitors([monitor(true)]);
  expect(data.rows().find(({ key }) => key === selection)).toMatchObject({
    id: "sh_1", title: "Watch build", state: "Paused", details: ["Events fired: 2"],
  });
  expect(data.rows().find(({ key }) => key === first[0].key).title).toBe("New title");
  stop();
  monitors([]);
  expect(changes).toBe(4);
});

test("distinguishes a structured ending, disposal and a missing shell without inventing exit fields", () => {
  const { data, bus, shell: publishShell, monitors } = fixture();
  publishShell([shell("sh_1")]);
  monitors([monitor(), { ...monitor(), id: "watch_2" }]);
  const original = data.rows();
  bus.emit("terminal_monitor_ended", ending);
  bus.emit("terminal_monitor_ended", { ...ending, id: "watch_2", reason: "disposed", exitCode: null });
  monitors([]);
  publishShell([]);
  expect(data.rows()).toHaveLength(2);
  expect(data.rows().find(({ role }) => role === "Monitor")).toMatchObject({
    key: original.find(({ role }) => role === "Monitor").key,
    state: "Ended",
    details: ["Events fired: 2", "End reason: exit", "Exit code: 17"],
  });
  expect(data.rows().find(({ role }) => role === "Shell")).toMatchObject({
    key: original[0].key, state: "Unlisted", details: ["Exit status unavailable from background events."],
  });
  expect(data.summary()).toBe("BACKGROUND  0sh 0mon ›");
});

test("reads delivered monitor metadata only from the current branch and only for the matching ID", () => {
  const { data, lifecycle, monitors } = fixture();
  monitors([monitor(), { ...monitor(), id: "watch_2" }]);
  const entries = [
    {
      type: "custom_message", customType: monitorNotification, timestamp: "1970-01-01T00:00:01.200Z",
      content: "Do not show this raw output",
      details: { monitors: [{ id: "sh_1", description: "Other title", eventCount: 4, kinds: ["line"] }] },
    },
    {
      type: "custom_message", customType: monitorNotification, timestamp: "1970-01-01T00:00:01.300Z",
      details: { monitors: [
        { id: "sh_1", eventCount: 2, kinds: ["line", "summary"], humanInput: true },
        { id: "watch_2", eventCount: 1, kinds: ["line"] },
      ] },
    },
    {
      type: "message",
      message: { role: "user", content: "fake receipt", details: { monitors: [{ id: "sh_1", eventCount: 99 }] } },
    },
  ];
  let changes = 0;
  data.subscribe(() => { changes += 1; });
  lifecycle.emit("message_end", { message: { role: "user", content: entries[0].content } });
  lifecycle.emit("message_end", { message: { role: "custom", customType: monitorNotification, details: entries[1].details } });
  expect(changes).toBe(1);
  expect(data.rows(context(entries)).map(({ details }) => details)).toEqual([
    [
      "Events fired: 0", "Latest delivered batch: 2 events (line, summary)",
      "Recorded at: 1970-01-01T00:00:01.300Z", "Match body unavailable from structured notifications.",
    ],
    [
      "Events fired: 0", "Latest delivered batch: 1 event (line)",
      "Recorded at: 1970-01-01T00:00:01.300Z", "Match body unavailable from structured notifications.",
    ],
  ]);
  expect(data.rows(context([])).map(({ details }) => details)).toEqual([["Events fired: 0"], ["Events fired: 0"]]);
  monitors([{ ...monitor(), startedAtMs: 1400 }]);
  expect(data.rows(context(entries))[0].details).toEqual(["Events fired: 0"]);
});

test("requests only the selected shell's screen and redacts shell descriptions and screen lines", async () => {
  const calls = [];
  const { data, shell: publishShell } = fixture(async (...args) => {
    calls.push(args);
    return { content: [{
      type: "text",
      text: "status: exited_23 exit_code: 23\n\x1b[31mfinished\x1b[0m\nPATH=/private\nwrapped-secret\nAuthorization: Bearer example-secret\n",
    }] };
  });
  publishShell([shell("sh_1", "env TOKEN=private ./build --flag"), shell("sh_2", "\x1b]0;hidden\x07Build")]);
  const [selection, other] = data.rows();
  expect(selection.title).toBe("Description hidden");
  expect(other.title).toBe("Build");
  publishShell([shell("sh_2")]);
  expect(await data.preview(selection)).toBe(
    "Terminal screen snapshot\nstatus: exited_23 exit_code: 23\n[screen redacted]",
  );
  expect(calls).toEqual([["bash_output", { bash_id: "sh_1", view: "screen" }]]);
});

test("unavailable screens do not expose host errors or issue log fallbacks", async () => {
  const calls = [];
  const { data, shell: publishShell } = fixture(async (...args) => {
    calls.push(args);
    return { isError: true, content: [{ type: "text", text: "No terminal session found with id: sh_1" }] };
  });
  publishShell([shell("sh_1")]);
  const [selection] = data.rows();
  expect(await data.preview(selection)).toBe("Terminal screen snapshot unavailable.");
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toEqual({ bash_id: "sh_1", view: "screen" });
});

test.each(["running", "completed exit_code: 0", "killed"])("renders a clean %s screen as plain text", async (status) => {
  const { data, shell: publishShell, monitors } = fixture(async (tool, params) => {
    if (tool === "bash_output" && params.view === "screen") return {
      content: [{ type: "text", text: `status: ${status}\n\x1b[32mfirst\x1b[0m\n  second\n` }],
    };
    throw new Error("Unexpected tool or view");
  });
  publishShell([shell("sh_1")]);
  monitors([monitor()]);
  const [selectedShell, selectedMonitor] = data.rows();
  expect(await data.preview(selectedShell)).toBe(`Terminal screen snapshot\nstatus: ${status}\nfirst\n  second`);
  expect(await data.preview(selectedMonitor)).toBeUndefined();
});

test("a recently unlisted shell does not report a transitional running screen as its outcome", async () => {
  const { data, shell: publishShell } = fixture(async () => ({
    content: [{ type: "text", text: "status: running\nstale screen" }],
  }));
  publishShell([shell("sh_1")]);
  publishShell([]);
  const [recent] = data.rows();
  expect(recent.state).toBe("Unlisted");
  expect(await data.preview(recent)).toBe("Terminal screen snapshot unavailable.");
});

test("keeps only recent endings and retires all resident subscriptions at shutdown", async () => {
  const calls = [];
  const { data, bus, lifecycle, shell: publishShell } = fixture(async (...args) => { calls.push(args); });
  for (let id = 1; id <= 40; id += 1) {
    publishShell([shell(`sh_${id}`)]);
    publishShell([]);
  }
  const rows = data.rows();
  expect(rows[0].id).toBe("sh_40");
  expect(rows.length).toBeLessThan(40);
  expect(rows.some(({ id }) => id === "sh_1")).toBe(false);
  expect(data.summary()).toBe("BACKGROUND  0sh 0mon ›");
  expect(await data.preview({ key: "Shell:sh_1" })).toBeUndefined();
  lifecycle.emit("session_shutdown");
  expect(bus.eventNames()).toEqual([]);
  publishShell([shell("sh_41")]);
  expect(data.rows()).toEqual([]);
  expect(await data.preview(rows[0])).toBeUndefined();
  expect(calls).toEqual([]);
});
