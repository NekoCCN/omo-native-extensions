import { stripVTControlCharacters } from "node:util";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const summaryWidth = 24;
const detailWidth = 64;
const detailRows = 10;
const frameRows = 4;
const overlayMargin = { top: 1, right: 2, bottom: 1, left: 2 };
const terminalStrings = /(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])(?:[^\x07\x1b\x9c]|\x1b(?!\\))*(?:\x07|\x1b\\|\x9c|$)/gu;
const shellSyntax = /(?:^|\s)(?:env|export)(?=\s)|(?:^|\s)[a-z_]\w*\s*=|(?:^|\s)--?[a-z][\w-]*(?=\s|=|$)|:\/\/|\$[{(a-z_]|[|;<>`]/iu;
const credentialSyntax = /\b(?:authorization|[\w-]*(?:password|passwd|secret|token|credential)|api[-_ ]?key)\s*[:=]|\b(?:bearer|basic)\s+[a-z0-9_./+=~-]{8,}|\b(?:gh[porsu]_|github_pat_|sk-|xox[a-z]-|AKIA|AIza|eyJ)[a-z0-9_.-]{8,}|-----BEGIN .*PRIVATE KEY/iu;

function displayDescription(description) {
  if (typeof description !== "string") return "Unnamed task";
  const text = stripVTControlCharacters(description.replace(terminalStrings, ""))
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/\s+/gu, " ").trim();
  // Without an explicit label the native shell snapshot can carry the raw command.
  if (shellSyntax.test(text) || credentialSyntax.test(text)) return "Description hidden";
  return text || "Unnamed task";
}

function createDetails(tui, theme, readRows) {
  let offset = 0;
  let lastOffset = 0;
  const scroll = (delta) => {
    const next = Math.min(lastOffset, Math.max(0, offset + delta));
    if (next === offset) return false;
    offset = next;
    return true;
  };
  return {
    invalidate() {},
    scrollKey(data) {
      if (lastOffset === 0) return false;
      const delta = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : 0;
      if (!delta) return false;
      if (scroll(delta)) tui.requestRender();
      return true;
    },
    handleMouse(event) {
      if (event.type !== "wheel" || !Number.isFinite(event.wheelDelta) || lastOffset === 0) return;
      return { handled: true, render: scroll(event.wheelDelta) };
    },
    render(width) {
      const height = tui.terminal.rows - overlayMargin.top - overlayMargin.bottom;
      if (width <= 4 || height <= frameRows) {
        offset = lastOffset = 0;
        return [truncateToWidth("Background · Esc close", width)];
      }
      const rows = readRows();
      const page = Math.min(detailRows, height - frameRows);
      lastOffset = Math.max(0, rows.length - page);
      offset = Math.min(lastOffset, offset);
      const inner = width - 4;
      const border = (text) => theme.fg("borderMuted", text);
      const row = (text, background = "toolPendingBg") => {
        // A clipped styled span can reset all SGR attributes, including the card background.
        const fitted = truncateToWidth(text, inner).replaceAll("\x1b[0m", "\x1b[22;39m");
        const fill = " ".repeat(inner - visibleWidth(fitted));
        return `${border("│")}${theme.bg(background, ` ${fitted}${fill} `)}${border("│")}`;
      };
      const section = (text) => row(text, "customMessageBg");
      const shown = rows.slice(offset, offset + page);
      const lines = shown.map(({ role, state, title }) => {
        const tone = state === "Paused" ? "warning" : "success";
        return row(`${theme.fg("muted", role.padEnd(8))}${theme.fg(tone, state.padEnd(9))}${title}`);
      });
      if (lines.length === 0) lines.push(row(theme.fg("muted", "No active shell jobs or monitors")));
      while (lines.length < page) lines.push(row(""));
      const scrollHelp = tui.mode === "fullscreen" ? "↑↓ / Wheel · " : "↑↓ · ";
      const closeHelp = "Esc close";
      const help = lastOffset > 0 && visibleWidth(scrollHelp + closeHelp) <= inner
        ? scrollHelp + closeHelp : closeHelp;
      const range = lastOffset > 0 ? `${offset + 1}–${offset + shown.length}/${rows.length}` : "";
      const gap = inner - visibleWidth(help) - visibleWidth(range);
      const footer = range && gap >= 2 ? `${help}${" ".repeat(gap)}${range}` : help;
      const rule = "─".repeat(width - 2);
      return [
        border(`╭${rule}╮`),
        section(theme.fg("accent", theme.bold("Background tasks"))),
        ...lines,
        section(theme.fg("muted", footer)),
        border(`╰${rule}╯`),
      ];
    },
  };
}

export function createBackgroundTasks(pi) {
  const listeners = new Set();
  const snapshots = { Shell: [], Monitor: [] };
  let popup;
  let ended = false;
  const readRows = () => [...snapshots.Shell, ...snapshots.Monitor];
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  function update(role, items) {
    if (ended || !Array.isArray(items)) return;
    const next = items.filter((item) => typeof item?.id === "string").map(({ id, description, paused }) => ({
      id,
      role,
      state: role === "Shell" ? "Running" : paused === true ? "Paused" : "Watching",
      title: displayDescription(description),
    }));
    const prev = snapshots[role];
    if (prev.length === next.length && prev.every(({ id, state, title }, index) =>
      id === next[index].id && state === next[index].state && title === next[index].title)) return;
    snapshots[role] = next;
    for (const listener of listeners) listener();
  }
  // Native terminal binding publishes both snapshots during session_start, before
  // later extensions' lifecycle handlers can run. The runtime owns bus teardown.
  pi.events.on("wake_source_state", (event) => {
    if (event?.source === "terminal-background-sessions") update("Shell", event.items);
  });
  pi.events.on("terminal_monitor_state", (event) => update("Monitor", event?.monitors));
  pi.on("session_shutdown", () => {
    ended = true;
    popup?.retire();
    snapshots.Shell = [];
    snapshots.Monitor = [];
    listeners.clear();
  });

  return {
    summary() {
      const label = `BACKGROUND  ${snapshots.Shell.length}sh ${snapshots.Monitor.length}mon`;
      return label.length + 2 <= summaryWidth ? `${label} ›` : truncateToWidth(label, summaryWidth);
    },
    subscribe,
    open(ctx) {
      if (ended) return Promise.resolve();
      if (popup) return popup.finished;
      const retired = Promise.withResolvers();
      let handle;
      let dispose;
      const custom = ctx.ui.custom((tui, theme, _keybindings, done) => {
        const priorFocus = tui.getFocusedComponent();
        const details = createDetails(tui, theme, readRows);
        const stopRender = subscribe(() => tui.requestRender());
        const stopInput = ctx.ui.onTerminalInput((data) => {
          if (!handle?.getBounds() || tui.isOverlayFocused() || tui.getFocusedComponent() !== priorFocus) return;
          if (matchesKey(data, Key.escape)) {
            done();
            return { consume: true };
          }
          if (details.scrollKey(data)) return { consume: true };
        });
        dispose = () => {
          stopInput();
          stopRender();
          dispose = undefined;
        };
        return { ...details, dispose };
      }, {
        overlay: true,
        overlayOptions: { width: detailWidth, margin: overlayMargin, nonCapturing: true },
        onHandle(overlay) {
          if (ended) overlay.hide();
          else handle = overlay;
        },
      });
      const finished = Promise.race([custom, retired.promise]).finally(() => {
        dispose?.();
        popup = undefined;
      });
      popup = {
        finished,
        retire() {
          // The host's done() pops the top overlay; on teardown remove only ours.
          handle?.hide();
          dispose?.();
          retired.resolve();
        },
      };
      return finished;
    },
  };
}
