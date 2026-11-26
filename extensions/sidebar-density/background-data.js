import { stripVTControlCharacters } from "node:util";

const recentLimit = 20;
const branchLookback = 128;
const lineLimit = 240;
const screenLimit = 64 * 1024;
const screenLabel = "Terminal screen snapshot";
const screenUnavailable = `${screenLabel} unavailable.`;
const monitorNotification = "senpi-monitor:notification";
const terminalId = /^[a-z][a-z0-9_-]{0,95}$/iu;
const terminalStrings = /(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])(?:[^\x07\x1b\x9c]|\x1b(?!\\))*(?:\x07|\x1b\\|\x9c|$)/gu;
const shellSyntax = /(?:^|\s)(?:env|export|printenv)(?=\s|$)|(?:^|[\s'"])[a-z_]\w*\s*=|(?:^|\s)--?[a-z][\w-]*(?=\s|=|$)|:\/\/|\$[{(a-z_]|[|;<>`]/iu;
const credentialSyntax = /\b(?:authorization|[\w-]*(?:password|passwd|secret|token|credential)|api[-_ ]?key)\s*[:=]|\b(?:bearer|basic)\s+[a-z0-9_./+=~-]{8,}|\b(?:gh[porsu]_|github_pat_|sk-|xox[a-z]-|AKIA|AIza|eyJ)[a-z0-9_.-]{8,}|-----BEGIN .*PRIVATE KEY/iu;
const hostScreenStatus = /^status: (?:running|completed|exited(?:_-?\d+)?|killed|timed_out|signal_[A-Za-z0-9]+)(?: exit_code: -?\d+)?$/u;

function stripTerminal(text) {
  return stripVTControlCharacters(text.replace(terminalStrings, ""))
    .replace(/[\p{Bidi_Control}\p{Cf}]/gu, "");
}

function plainLine(text) {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trimEnd();
}

function displayDescription(description) {
  if (typeof description !== "string") return "Unnamed task";
  if (description.length > screenLimit) return "Description hidden";
  const text = plainLine(stripTerminal(description)).replace(/\s+/gu, " ").trim();
  // Without a label the native shell snapshot can carry the raw command.
  if (shellSyntax.test(text) || credentialSyntax.test(text)) return "Description hidden";
  return text.slice(0, lineLimit) || "Unnamed task";
}

function backgroundRow(role, item, state) {
  const { id } = item;
  const details = [];
  if (role === "Monitor" && Number.isSafeInteger(item.fireCount) && item.fireCount >= 0) {
    details.push(`Events fired: ${item.fireCount}`);
  }
  return {
    key: `${role}:${id}`, id, role, state, title: displayDescription(item.description), details,
    startedAtMs: item.startedAtMs,
  };
}

function deliveredBatches(ctx, monitorStarts) {
  const latest = new Map();
  if (monitorStarts.size === 0) return latest;
  const entries = ctx?.sessionManager?.getBranch?.() ?? [];
  for (const entry of entries.slice(-branchLookback).reverse()) {
    if (entry.type !== "custom_message" || entry.customType !== monitorNotification) continue;
    if (!Array.isArray(entry.details?.monitors)) continue;
    const deliveredAt = Date.parse(entry.timestamp);
    for (const item of entry.details.monitors) {
      const { id, eventCount, kinds } = item ?? {};
      const startedAt = monitorStarts.get(id);
      if (!(deliveredAt >= startedAt) || latest.has(id) || !Number.isSafeInteger(eventCount) || eventCount < 1) continue;
      // The notifier attributes counts/kinds, not the monitor's individual match lines.
      const known = ["line", "summary"].filter((kind) => Array.isArray(kinds) && kinds.includes(kind));
      const kindLabel = known.length ? ` (${known.join(", ")})` : "";
      latest.set(id, [
        `Latest delivered batch: ${eventCount} ${eventCount === 1 ? "event" : "events"}${kindLabel}`,
        `Recorded at: ${new Date(deliveredAt).toISOString()}`,
        "Match body unavailable from structured notifications.",
      ]);
    }
    if (latest.size === monitorStarts.size) break;
  }
  return latest;
}

function screenPreview(result, isActive) {
  if (result?.isError || !Array.isArray(result?.content)) return screenUnavailable;
  const block = result.content.find((entry) => entry?.type === "text" && typeof entry.text === "string");
  if (!block || block.text.length > screenLimit) return screenUnavailable;
  const [status, ...grid] = stripTerminal(block.text).split(/\r\n|\r|\n/u).map(plainLine);
  if (!hostScreenStatus.test(status) || (!isActive && status === "status: running")) {
    return screenUnavailable;
  }
  // Physical screen rows can wrap a credential over multiple lines. Withhold the
  // whole grid on detection rather than displaying an unmarked continuation.
  const lines = grid.some((line) => shellSyntax.test(line) || credentialSyntax.test(line))
    ? ["[screen redacted]"] : grid.slice(0, 30).map((line) => line.slice(0, lineLimit));
  return [screenLabel, status, ...lines].join("\n").trimEnd();
}

export function createBackgroundData(pi) {
  const listeners = new Set();
  const active = { Shell: new Map(), Monitor: new Map() };
  const recent = new Map();
  let retired = false;

  function notify() {
    for (const listener of listeners) listener();
  }

  function remember(row) {
    recent.delete(row.key);
    recent.set(row.key, row);
    if (recent.size > recentLimit) recent.delete(recent.keys().next().value);
  }

  function replaceSnapshot(role, items) {
    if (retired || !Array.isArray(items)) return;
    const next = new Map();
    for (const item of items) {
      if (typeof item?.id !== "string" || !terminalId.test(item.id)) continue;
      const state = role === "Shell" ? "Running" : item.paused === true ? "Paused" : "Watching";
      const row = backgroundRow(role, item, state);
      next.set(row.key, row);
      recent.delete(row.key);
    }
    const previous = active[role];
    if (role === "Shell") {
      for (const [key, row] of previous) {
        if (!next.has(key)) remember({
          ...row, state: "Unlisted", details: ["Exit status unavailable from background events."],
        });
      }
    }
    if (JSON.stringify([...previous.values()]) === JSON.stringify([...next.values()])) return;
    active[role] = next;
    notify();
  }

  function endMonitor(event) {
    if (retired || typeof event?.id !== "string" || !terminalId.test(event.id)) return;
    const key = `Monitor:${event.id}`;
    switch (event.reason) {
      case "disposed":
        if (active.Monitor.delete(key)) notify();
        return;
      case "exit":
      case "timeout":
      case "killed":
        break;
      default:
        return;
    }
    const row = backgroundRow("Monitor", event, "Ended");
    row.details.push(`End reason: ${event.reason}`);
    if (Number.isSafeInteger(event.exitCode)) row.details.push(`Exit code: ${event.exitCode}`);
    if (!active.Monitor.delete(key) && JSON.stringify(recent.get(key)) === JSON.stringify(row)) return;
    remember(row);
    notify();
  }

  const unsubscribe = [
    pi.events.on("wake_source_state", (event) => {
      if (event?.source === "terminal-background-sessions") replaceSnapshot("Shell", event.items);
    }),
    pi.events.on("terminal_monitor_state", (event) => replaceSnapshot("Monitor", event?.monitors)),
    pi.events.on("terminal_monitor_ended", endMonitor),
  ];
  pi.on("message_end", ({ message }) => {
    if (!retired && message?.role === "custom" && message.customType === monitorNotification) notify();
  });
  pi.on("session_shutdown", () => {
    retired = true;
    for (const stop of unsubscribe) stop?.();
    active.Shell.clear();
    active.Monitor.clear();
    recent.clear();
    listeners.clear();
  });

  return {
    rows(ctx) {
      const rows = [...active.Shell.values(), ...active.Monitor.values(), ...[...recent.values()].reverse()];
      const monitors = rows.filter(({ role }) => role === "Monitor");
      const latest = deliveredBatches(ctx, new Map(monitors.map(({ id, startedAtMs }) => [id, startedAtMs])));
      return rows.map(({ startedAtMs: _startedAtMs, ...row }) => {
        const batch = row.role === "Monitor" ? latest.get(row.id) : undefined;
        return { ...row, details: [...row.details, ...(batch ?? [])] };
      });
    },
    summary() {
      const label = `BACKGROUND  ${active.Shell.size}sh ${active.Monitor.size}mon`;
      return label.length + 2 <= 24 ? `${label} ›` : label.slice(0, 24);
    },
    subscribe(listener) {
      if (!retired) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async preview(row) {
      const current = active.Shell.get(row?.key) ?? recent.get(row?.key);
      if (current?.role !== "Shell") return undefined;
      try {
        const result = await pi.executeTool("bash_output", { bash_id: current.id, view: "screen" });
        return retired ? undefined : screenPreview(result, active.Shell.has(current.key));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return retired ? undefined : screenUnavailable;
      }
    },
  };
}
