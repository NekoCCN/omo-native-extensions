import { Key, matchesKey, ScrollView, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

const STYLE_MARK = "__agentDetailStyleStyled";
const RENDER_MARK = "__agentDetailStyleRendered";

function hasCompatibleAdapter(tui) {
  const show = tui.showOverlay;
  if (typeof show !== "function") return false;
  if (show[STYLE_MARK] === true) return true;
  try {
    const source = Function.prototype.toString.call(show);
    if (source.includes("showStyled") && source.includes("(agent)")) return true;
  } catch {
    return false;
  }
  return false;
}

function matches(data, key) {
  try {
    return matchesKey(data, key);
  } catch {
    return false;
  }
}

function drawAgent({ title: agentTitle, metadata, blocks, cap, lineClipped }, folds, viewport, width, height, theme) {
  const inner = width - 4;
  const border = (text) => theme.fg("borderMuted", text);
  const pad = (text, background = "toolPendingBg") => {
    const fill = " ".repeat(Math.max(0, inner - visibleWidth(text)));
    return `${border("│")}${theme.bg(background, ` ${text}${fill} `)}${border("│")}`;
  };
  const row = (text, background = "toolPendingBg") => {
    // Clipping a styled label can emit a full reset; keep the card background.
    const fitted = truncateToWidth(text, inner).replaceAll("\x1b[0m", "\x1b[22;39m");
    return pad(fitted, background);
  };
  const wrapLines = (text, background = "toolPendingBg") => {
    const body = text === "(no transcript recorded for this task)" ? theme.fg("muted", text) : text;
    return wrapTextWithAnsi(body, inner).map((line) => pad(line, background));
  };
  const split = (left, right) => {
    const room = inner - visibleWidth(right);
    if (room < 8) return truncateToWidth(left, inner);
    const label = truncateToWidth(left, room - 2);
    return `${label}${" ".repeat(room - visibleWidth(label))}${right}`;
  };

  const status = metadata.get("status") ?? "";
  const mark = status.slice(0, 1);
  const tone = mark === "✗" ? "error" : mark === "✓" ? "success" : mark === "●" ? "accent" : "muted";
  const statusName = status.replace(/ \(.+\)$/u, "");
  const badge = theme.fg(tone, theme.bold([statusName, metadata.get("elapsed")].filter(Boolean).join("  ")));
  const title = theme.fg("accent", theme.bold(agentTitle.replace(/  \(agent\)$/u, "")));
  const details = [
    metadata.get("category"),
    metadata.get("turns") && `${metadata.get("turns")} turns`,
    metadata.get("tokens") && `${metadata.get("tokens")} tokens`,
    metadata.get("cost"),
    metadata.get("runs"),
    metadata.get("id"),
  ].filter(Boolean).join("  ·  ");
  const activity = metadata.get("doing") ?? metadata.get("reason");
  const logRow = (text) => {
    const label = rowLabel(text);
    if (!label) return wrapLines(text);
    const color = label.includes("error") ? "error" : label === "assistant" ? "accent" : label === "user" ? "success" : "muted";
    return wrapLines(theme.bold(theme.fg(color, label)) + text.slice(label.length));
  };
  const lines = [
    border(`╭${"─".repeat(width - 2)}╮`),
    row(split(title, badge), "customMessageBg"),
    ...(details ? [row(theme.fg("muted", details))] : []),
    ...(activity ? [row(`${theme.fg("muted", "Activity")}  ${activity}`)] : []),
  ];
  const foldable = foldIdsOf({ blocks });
  if (folds.focusId !== undefined && !foldable.includes(folds.focusId)) folds.focusId = undefined;
  if (folds.focusId === undefined && foldable.length > 0) folds.focusId = foldable[0];
  const flat = [];
  const slots = new Map();
  let collapsedHeight = 0;
  for (const block of blocks) {
    collapsedHeight += block.start === undefined ? block.lines.length : 1;
    if (block.start === undefined) {
      for (const text of block.lines) flat.push(...logRow(text));
      continue;
    }
    const id = block.start;
    const open = isOpen(folds, id);
    const focused = folds.focusId === id;
    slots.set(flat.length, id);
    const count = open ? "Collapse" : `+${block.hidden} ${block.hidden === 1 ? "line" : "lines"} · Expand`;
    const inlineFirst = open && visibleWidth(block.lines[0]) + visibleWidth(count) + 4 <= inner;
    const summary = inlineFirst ? block.lines[0]
      : open ? (rowLabel(block.preview) ?? block.preview) : block.preview;
    flat.push(row(split(
      theme.bold(theme.fg("accent", `${focused ? "›" : open ? "▾" : "▸"} `)) + summary,
      theme.fg("muted", count),
    )));
    if (open) for (const text of block.lines.slice(inlineFirst ? 1 : 0)) flat.push(...logRow(text));
  }
  // Header and footer do not scroll. Only the projected transcript uses the remaining rows.
  const pageSize = Math.min(Math.max(1, collapsedHeight), Math.max(1, height - lines.length - 3));
  viewport.updateLayout(flat.length, pageSize);
  const start = Math.min(viewport.scrollTop, Math.max(0, flat.length - 1));
  const end = Math.min(flat.length, start + pageSize);
  const scrollable = flat.length > pageSize;
  const position = flat.length ? `${flat.length === 0 ? 0 : start + 1}–${end} of ${flat.length}` : "";
  lines.push(row(split(theme.bold(theme.fg("accent", "Transcript")), theme.fg("dim", position))));
  folds.hit.clear();
  for (let i = start; i < end; i++) {
    if (slots.has(i)) folds.hit.set(lines.length, slots.get(i));
    lines.push(flat[i]);
  }
  const notice = [
    ...(cap ? wrapLines(theme.fg("muted",
      `Native transcript capped by host: showing ${cap.shown} of ${cap.total} rows. Older rows are unavailable from the overlay.`)) : []),
    ...(lineClipped ? wrapLines(theme.fg("muted", "Some lines exceed the native preview capture width.")) : []),
  ];
  for (let i = end - start + notice.length; i < pageSize; i++) lines.push(row(""));
  lines.push(...notice);
  const hints = [scrollable && "↑↓ / Wheel / PgUp / PgDn", slots.size > 0 && "Click a fold / Tab · Enter / Ctrl+O"].filter(Boolean).join(" · ");
  lines.push(
    row(split(theme.fg("dim", hints), theme.fg("muted", "Esc close")), "customMessageBg"),
    border(`╰${"─".repeat(width - 2)}╯`),
  );
  return lines;
}

function captureAgent(tui, render, component, width) {
  const page = readFrame(render.call(component, width));
  if (!page || !isAgentFrame(page)) return;
  const total = page.range ? Number(page.range[3]) : page.rows.length;
  const clipped = (frame, columns) => [frame.title, ...frame.rows].some(
    (row) => row.endsWith("…") && visibleWidth(row) >= columns - 5);
  const toSnapshot = (frame, columns) => {
    const snapshot = agentContent(frame);
    if (!snapshot) return;
    return { ...snapshot, cap: capOf(frame), lineClipped: clipped(frame, columns) };
  };
  if ((!page.range && !clipped(page, width)) || !Number.isSafeInteger(total) || total > 30_000) {
    return toSnapshot(page, width);
  }
  // The native modal exposes rendered rows, not its data. Snapshot all rows
  // at a wider virtual size when needed, before wrapping them in our viewport.
  const terminal = tui.terminal;
  const viewport = Object.create(terminal, { rows: { value: Math.ceil((total + 4) / 0.72) } });
  if (!Reflect.set(tui, "terminal", viewport)) return toSnapshot(page, width);
  try {
    let columns = width;
    let frame = page;
    const limit = Math.max(width, Math.min(65_536, Math.floor(2_000_000 / (total + 1))));
    do {
      const next = readFrame(render.call(component, columns));
      if (!next || !isAgentFrame(next)) break;
      frame = next;
      if (!clipped(frame, columns) || columns >= limit) return toSnapshot(frame, columns);
      columns = Math.min(columns * 2, limit);
    } while (true);
    return toSnapshot(page, width);
  } finally {
    Reflect.set(tui, "terminal", terminal);
  }
}

function styleAgentOverlay(tui, theme) {
  const show = tui.showOverlay;
  if (typeof show !== "function" || typeof theme?.fg !== "function" ||
      typeof theme.bg !== "function" || typeof theme.bold !== "function") return;
  if (hasCompatibleAdapter(tui)) return;
  function showStyled(component, options) {
    // Recognize the native details overlay, not menus or other extension popups.
    if (!isSubagentOverlayTarget(options, component)) return show.call(this, component, options);
    if (component.render[RENDER_MARK] === true) return show.call(this, component, options);
    const render = component.render;
    const cols = tui.terminal.columns;
    if (cols < 52 || tui.terminal.rows < 12 || typeof ScrollView !== "function" ||
        typeof ScrollView.prototype.updateLayout !== "function") return show.call(this, component, options);
    let capturedWidth = cols - 4;
    let snapshot = captureAgent(tui, render, component, capturedWidth);
    if (!snapshot) return show.call(this, component, options);
    const folds = createFolds();
    const viewport = new ScrollView({ render: () => [], invalidate() {} }, { overscroll: "contain" });
    const input = component.handleInput;
    const mouse = component.handleMouse;
    const scroll = (position) => {
      viewport.scrollTo(position, { disableFollow: true });
      tui.requestRender();
    };
    const toggleFocused = () => {
      const ids = foldIdsOf(snapshot);
      const target = folds.focusId ?? ids.find((id) => [...folds.hit.values()].includes(id)) ?? ids[0];
      if (target === undefined) return false;
      folds.focusId = target;
      toggleFold(folds, target);
      return true;
    };
    if (Reflect.set(component, "render", function (width) {
      if (width !== capturedWidth) {
        snapshot = captureAgent(tui, render, component, width) ?? snapshot;
        capturedWidth = width;
      }
      return drawAgent(snapshot, folds, viewport, width, tui.terminal.rows - 2, theme);
    })) {
      component.render[RENDER_MARK] = true;
      Reflect.set(component, "scrollBy", (delta) => scroll(viewport.scrollTop + delta));
      Reflect.set(component, "handleInput", function (data) {
        if (matches(data, Key.ctrl("o"))) {
          folds.openAll = !folds.openAll;
          folds.overrides.clear();
          tui.requestRender();
        } else if (matches(data, Key.escape)) {
          return input?.call(this, data);
        } else if (data === "\t" || matches(data, Key.tab)) {
          cycleFocus(folds, foldIdsOf(snapshot));
          tui.requestRender();
        } else if (data === "\r" || matches(data, Key.enter)) {
          if (toggleFocused()) tui.requestRender();
          else return input?.call(this, data);
        } else if (matches(data, Key.up) || data === "k") scroll(viewport.scrollTop - 1);
        else if (matches(data, Key.down) || data === "j") scroll(viewport.scrollTop + 1);
        else if (matches(data, Key.pageUp)) scroll(viewport.scrollTop - viewport.viewportHeight);
        else if (matches(data, Key.pageDown)) scroll(viewport.scrollTop + viewport.viewportHeight);
        else if (matches(data, Key.home)) scroll(0);
        else if (matches(data, Key.end)) scroll(Number.MAX_SAFE_INTEGER);
        else return input?.call(this, data);
      });
      Reflect.set(component, "handleMouse", function (event) {
        const id = folds.hit.get(event.y);
        if (id === undefined || event.button !== "left") return mouse?.call(this, event);
        if (event.type === "press") return { handled: true };
        if (event.type !== "click") return mouse?.call(this, event);
        folds.focusId = id;
        toggleFold(folds, id);
        return { handled: true, render: true };
      });
      options = { ...options, width: "100%", maxHeight: "100%", margin: { top: 1, right: 2, bottom: 1, left: 2 }, anchor: "top-center" };
    }
    return show.call(this, component, options);
  }
  showStyled[STYLE_MARK] = true;
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
      return { render: () => [], invalidate() {} };
    });
  });
}
