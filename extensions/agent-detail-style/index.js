import { stripVTControlCharacters } from "node:util";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const fields = /^(status|elapsed|reason|category|runs|doing|turns|tokens|cost|id) *(.*)$/u;
const statusStart = /^status +[◦●‖✓✗-] (?:queued|running|resuming|ending|finished|failed|cancelled)\b/u;
const entry = /^(assistant|user|tool(?:\[error\])?|error)(?=[:\s])/u;
const toolName = /^tool: (.+)$/u;

function readFrame(lines) {
  if (lines.length < 4) return;
  const plain = lines.map(stripVTControlCharacters);
  if (!/^┌─+┐$/u.test(plain[0]) || !/^└─+┘$/u.test(plain.at(-1)) ||
      !plain.slice(1, -1).every((line) => line.startsWith("│ ") && line.endsWith(" │"))) return;
  const [title, ...rows] = plain.slice(1, -1).map((line) => line.slice(2, -2).trimEnd());
  const footer = rows.pop().trim();
  const range = /^(\d+)-(\d+)\/(\d+)  ↑↓\/wheel  esc close$/u.exec(footer);
  if (!range && footer !== "esc close") return;
  return { title, rows, range };
}

function isAgentFrame(frame) {
  return /  \(agent\)$/u.test(frame.title) ||
    (/…$/u.test(frame.title) && statusStart.test(frame.rows[0] ?? ""));
}

function agentContent(frame, metadata) {
  const first = Number(frame.range?.[1] ?? 1);
  if (first > 1) return frame.rows.slice(Math.max(0, metadata.count - first + 1));
  const divider = frame.rows.indexOf("");
  if (divider < 1 || !statusStart.test(frame.rows[0]) ||
      !frame.rows.slice(0, divider).every((line) => fields.test(line))) return frame.rows;
  metadata.count = divider + 1;
  metadata.fields = new Map(frame.rows.slice(0, divider).map((line) => {
    const [, key, value] = fields.exec(line);
    return [key, value.trimStart()];
  }));
  return frame.rows.slice(metadata.count);
}

function* transcriptBlocks(rows) {
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    if (toolName.test(rows[start])) {
      while (end < rows.length && toolName.test(rows[end])) end++;
      if (end - start > 1) {
        const counts = new Map();
        for (let i = start; i < end; i++) {
          const [, name] = toolName.exec(rows[i]);
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        const summary = [...counts].map(([name, count]) => count === 1 ? name : `${name} ×${count}`).join(" · ");
        yield { start, lines: rows.slice(start, end), preview: `Tools  ${summary}`, hidden: end - start };
      } else yield { lines: rows.slice(start, end) };
    } else if (entry.exec(rows[start])?.[1] === "assistant") {
      while (end < rows.length && !entry.test(rows[end]) &&
        !/^(?:\s*\.\.\.\[elided|\(earlier output elided)/u.test(rows[end])) end++;
      const lines = rows.slice(start, end);
      yield lines.length > 2
        ? { start, lines, preview: lines[0], hidden: lines.length - 1 }
        : { lines };
    } else yield { lines: rows.slice(start, end) };
    start = end;
  }
}

function drawAgent(frame, metadata, folds, width, theme) {
  const inner = width - 4;
  const border = (text) => theme.fg("borderMuted", text);
  const row = (text, background = "toolPendingBg") => {
    // Clipping a styled label can emit a full reset; keep the card background.
    const fitted = truncateToWidth(text, inner).replaceAll("\x1b[0m", "\x1b[22;39m");
    const pad = " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
    return `${border("│")}${theme.bg(background, ` ${fitted}${pad} `)}${border("│")}`;
  };
  const split = (left, right) => {
    const room = inner - visibleWidth(right);
    if (room < 8) return truncateToWidth(left, inner);
    const label = truncateToWidth(left, room - 2);
    return `${label}${" ".repeat(room - visibleWidth(label))}${right}`;
  };

  const output = agentContent(frame, metadata);
  const status = metadata.fields.get("status") ?? "";
  const mark = status.slice(0, 1);
  const tone = mark === "✗" ? "error" : mark === "✓" ? "success" : mark === "●" ? "accent" : "muted";
  const statusName = status.replace(/ \(.+\)$/u, "");
  const badge = theme.fg(tone, theme.bold([statusName, metadata.fields.get("elapsed")].filter(Boolean).join("  ")));
  const title = theme.fg("accent", theme.bold(frame.title.replace(/  \(agent\)$/u, "")));
  const details = [
    metadata.fields.get("category"),
    metadata.fields.get("turns") && `${metadata.fields.get("turns")} turns`,
    metadata.fields.get("tokens") && `${metadata.fields.get("tokens")} tokens`,
    metadata.fields.get("cost"),
    metadata.fields.get("runs"),
    metadata.fields.get("id"),
  ].filter(Boolean).join("  ·  ");
  const activity = metadata.fields.get("doing") ?? metadata.fields.get("reason");
  const logRow = (text) => {
    const label = entry.exec(text)?.[1];
    if (!label) return row(text === "(no transcript recorded for this task)" ? theme.fg("muted", text) : text);
    const color = label.includes("error") ? "error" : label === "assistant" ? "accent" : "muted";
    return row(theme.fg(color, label) + text.slice(label.length));
  };
  const position = frame.range
    ? `${Math.max(1, Number(frame.range[1]) - metadata.count)}–${Math.max(1, Number(frame.range[2]) - metadata.count)} of ${Math.max(1, Number(frame.range[3]) - metadata.count)}`
    : "";
  const lines = [
    border(`╭${"─".repeat(width - 2)}╮`),
    row(split(title, badge), "customMessageBg"),
    ...(details ? [row(theme.fg("muted", details))] : []),
    ...(activity ? [row(`${theme.fg("muted", "Activity")}  ${activity}`)] : []),
    row(split(theme.fg("muted", "Transcript"), theme.fg("dim", position))),
  ];
  const bodyEnd = lines.length + (frame.range ? frame.rows.length : output.length);
  const base = Number(frame.range?.[1] ?? 1) + frame.rows.length - output.length;
  for (const block of transcriptBlocks(output)) {
    if (block.start === undefined) {
      lines.push(...block.lines.map(logRow));
      continue;
    }
    const id = base + block.start;
    const open = folds.openAll !== folds.overrides.has(id);
    folds.hit.set(lines.length, id);
    const count = open ? "Collapse" : `+${block.hidden} ${block.hidden === 1 ? "line" : "lines"} · Expand`;
    lines.push(row(split(
      theme.fg("accent", `${open ? "▾" : "▸"} `) + (open ? block.lines[0] : block.preview),
      theme.fg("muted", count),
    )));
    if (open) lines.push(...block.lines.slice(1).map(logRow));
  }
  // OMO positions the overlay from its rendered height. Reserve the native
  // page's row budget even when folding removes rows from this view.
  while (lines.length < bodyEnd) lines.push(row(""));
  const hints = [frame.range && "↑↓ / Wheel", folds.hit.size > 0 && "Click a fold / Ctrl+O"].filter(Boolean).join(" · ");
  lines.push(
    row(split(theme.fg("dim", hints), theme.fg("muted", "Esc close")), "customMessageBg"),
    border(`╰${"─".repeat(width - 2)}╯`),
  );
  return lines;
}

function styleAgentOverlay(tui, theme) {
  const show = tui.showOverlay;
  if (typeof show !== "function" || typeof theme?.fg !== "function" ||
      typeof theme.bg !== "function" || typeof theme.bold !== "function") return;
  function showStyled(component, options) {
    // Recognize the native details overlay, not menus or other extension popups.
    if (options?.anchor === "center" && options.width === "70%" && options.minWidth === 52 &&
        typeof component?.scrollBy === "function" && typeof component.render === "function") {
      const render = component.render;
      const cols = tui.terminal.columns;
      if (cols < 52) return show.call(this, component, options);
      const preview = readFrame(render.call(component, Math.min(cols, Math.max(52, Math.floor(cols * 0.7)))));
      if (!preview || !isAgentFrame(preview)) return show.call(this, component, options);
      const metadata = { count: 0, fields: new Map() };
      const folds = { openAll: false, overrides: new Set(), hit: new Map(), active: false };
      const input = component.handleInput;
      const mouse = component.handleMouse;
      if (Reflect.set(component, "render", function (width) {
        const lines = render.call(this, width);
        const frame = width >= 48 && readFrame(lines);
        folds.hit.clear();
        folds.active = Boolean(frame);
        return frame ? drawAgent(frame, metadata, folds, width, theme) : lines;
      })) {
        Reflect.set(component, "handleInput", function (data) {
          if (!folds.active || !matchesKey(data, Key.ctrl("o"))) return input?.call(this, data);
          folds.openAll = !folds.openAll;
          folds.overrides.clear();
          tui.requestRender();
        });
        Reflect.set(component, "handleMouse", function (event) {
          const id = folds.hit.get(event.y);
          if (id === undefined || event.button !== "left") return mouse?.call(this, event);
          if (event.type === "press") return { handled: true };
          if (event.type !== "click") return mouse?.call(this, event);
          if (!folds.overrides.delete(id)) folds.overrides.add(id);
          return { handled: true, render: true };
        });
        options = { ...options, width: "86%", anchor: "top-center", row: "12%" };
      }
    }
    return show.call(this, component, options);
  }
  if (!Reflect.set(tui, "showOverlay", showStyled)) return;
  return () => { if (tui.showOverlay === showStyled) Reflect.set(tui, "showOverlay", show); };
}

export default function agentDetailStyle(pi) {
  let host;
  let cleanup;
  pi.on("session_shutdown", () => {
    cleanup?.();
    cleanup = host = undefined;
  });
  pi.on("session_start", (_, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    ctx.ui.setWidget("agent-detail-style-anchor", (tui, theme) => {
      if (host !== tui) {
        cleanup?.();
        cleanup = styleAgentOverlay(tui, theme);
        host = tui;
      }
      return { render: () => [] };
    });
  });
}
