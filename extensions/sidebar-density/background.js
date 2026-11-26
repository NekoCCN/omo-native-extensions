import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createBackgroundData } from "./background-data.js";

const overlayWidth = 64;
const overlayMargin = { top: 1, right: 2, bottom: 1, left: 2 };
const bodyRows = 10;
const frameRows = 4;
const bodyStart = 2;
const inset = 2;
const loading = "Loading preview…";

function createBackgroundView(tui, theme, { readRows, preview, selection, close }) {
  let detail;
  let detailOffset = 0;
  let detailLimit = 0;
  let page = bodyRows;
  let hitKeys = [];
  let footerY = -1;
  let backWidth = 0;

  function selectedIndex(rows) {
    if (rows.length === 0) return -1;
    const index = rows.findIndex(({ key }) => key === selection.key);
    const next = index >= 0 ? index : Math.min(selection.index, rows.length - 1);
    selection.index = next;
    selection.key = rows[next].key;
    return next;
  }

  function loadPreview(opened) {
    const pending = [loading];
    opened.previewLines = pending;
    function showPreview(text) {
      if (detail !== opened || opened.previewLines !== pending) return;
      opened.previewLines = text ? text.split(/\r\n|\r|\n/u) : [];
      tui.requestRender();
    }
    void preview(opened.row).then(showPreview, () => showPreview("Preview unavailable."));
  }

  function activate(key) {
    const rows = readRows();
    const index = rows.findIndex((row) => row.key === key);
    if (index < 0) return;
    selection.key = key;
    selection.index = index;
    detailOffset = detailLimit = 0;
    detail = { row: rows[index], previewLines: [] };
    loadPreview(detail);
    tui.requestRender();
  }

  function back() {
    if (!detail) {
      close();
      return;
    }
    detail = undefined;
    tui.requestRender();
  }

  function scroll(delta) {
    if (detail) {
      const next = Math.max(0, Math.min(detailLimit, detailOffset + delta));
      if (next === detailOffset) return false;
      detailOffset = next;
      return true;
    }
    const rows = readRows();
    const index = selectedIndex(rows);
    if (index < 0) return false;
    const next = Math.max(0, Math.min(rows.length - 1, index + delta));
    selection.index = next;
    selection.key = rows[next].key;
    return next !== index;
  }

  return {
    invalidate() {},
    refresh() {
      if (detail) {
        const row = readRows().find(({ key }) => key === detail.row.key);
        if (!row) detail.previewLines = [];
        else if (row.role === "Shell" && row.state !== detail.row.state) {
          detail.row = row;
          loadPreview(detail);
        }
      }
      tui.requestRender();
    },
    dispose() { detail = undefined; },
    handleInput(data) {
      if (matchesKey(data, Key.escape)) {
        back();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (!detail) {
          const rows = readRows();
          const index = selectedIndex(rows);
          if (index >= 0) activate(rows[index].key);
        }
        return;
      }
      const motion = [
        [Key.up, -1], [Key.down, 1], [Key.pageUp, -page], [Key.pageDown, page],
        [Key.home, -Infinity], [Key.end, Infinity],
      ].find(([key]) => matchesKey(data, key));
      if (motion && scroll(motion[1])) tui.requestRender();
    },
    handleMouse(event) {
      if (event.type === "wheel" && Number.isFinite(event.wheelDelta)) {
        return { handled: true, render: scroll(event.wheelDelta) };
      }
      if (event.button !== "left") return;
      const backHit = event.y === footerY && event.x >= inset && event.x < inset + backWidth;
      const key = detail ? undefined : hitKeys[event.y - bodyStart];
      if (!backHit && key === undefined) return;
      if (event.type === "press") return { handled: true, focus: true };
      if (event.type !== "click") return;
      if (backHit) back();
      else activate(key);
      return { handled: true, render: true };
    },
    render(width) {
      const height = tui.terminal.rows - overlayMargin.top - overlayMargin.bottom;
      hitKeys = [];
      footerY = -1;
      if (width <= inset * 2 || height <= frameRows) {
        return [truncateToWidth(detail ? "Esc back" : "Esc close", width)];
      }
      page = Math.min(bodyRows, height - frameRows);
      const inner = width - inset * 2;
      const border = (text) => theme.fg("borderMuted", text);
      const line = (text, background = "toolPendingBg") => {
        // A clipped styled span may reset SGR; keep the surrounding panel background.
        const fitted = truncateToWidth(text, inner).replaceAll("\x1b[0m", "\x1b[22;39m");
        const fill = " ".repeat(inner - visibleWidth(fitted));
        return `${border("│")}${theme.bg(background, ` ${fitted}${fill} `)}${border("│")}`;
      };
      const rows = readRows();
      let offset;
      let total;
      let body;
      if (detail) {
        const row = rows.find(({ key }) => key === detail.row.key);
        const { title, role, id } = row ?? detail.row;
        const content = [
          title, row ? `${role} · ${row.state}` : `${role} · Task no longer listed`,
          `ID: ${id}`,
          ...(row ? row.details : []),
          ...(row && detail.previewLines.length ? ["", ...detail.previewLines] : []),
        ].flatMap((text) => wrapTextWithAnsi(text, inner));
        total = content.length;
        detailLimit = Math.max(0, total - page);
        offset = detailOffset = Math.min(detailOffset, detailLimit);
        body = content.slice(offset, offset + page).map((text) => line(text));
      } else {
        const index = selectedIndex(rows);
        total = rows.length;
        offset = Math.max(0, Math.min(index - Math.floor(page / 2), total - page));
        const shown = rows.slice(offset, offset + page);
        hitKeys = shown.map(({ key }) => key);
        body = shown.map(({ key, role, state, title }) => {
          const selected = key === selection.key;
          const prefix = selected ? theme.fg("accent", "› ") : "  ";
          const status = `${role.padEnd(8)}${state.padEnd(9)}`;
          const label = visibleWidth(status) + visibleWidth(prefix) + 8 <= inner
            ? `${theme.fg("muted", status)}${title}` : title;
          return line(prefix + label, selected ? "selectedBg" : "toolPendingBg");
        });
        if (body.length === 0) body.push(line(theme.fg("muted", "No background tasks")));
      }
      const action = detail ? "Esc back" : "Esc close";
      const range = total > page ? `${offset + 1}–${Math.min(offset + page, total)}/${total}` : "";
      const room = inner - (range ? visibleWidth(range) + 2 : 0);
      const choices = detail
        ? [`${action} · ↑↓ / PgUp / PgDn`, `${action} · ↑↓`, action]
        : total ? [`${action} · ↑↓ select · Enter / Click`, `${action} · ↑↓ · Enter`, action] : [action];
      const help = choices.find((label) => visibleWidth(label) <= room) ?? action;
      const gap = inner - visibleWidth(help) - visibleWidth(range);
      const footer = range && gap >= 2 ? `${help}${" ".repeat(gap)}${range}` : help;
      footerY = bodyStart + page;
      backWidth = Math.min(inner, visibleWidth(action));
      while (body.length < page) body.push(line(""));
      const rule = "─".repeat(width - 2);
      return [
        border(`╭${rule}╮`),
        line(theme.fg("accent", theme.bold(detail ? `Details · ${detail.row.title}` : "Background tasks")), "customMessageBg"),
        ...body,
        line(theme.fg("muted", footer), "customMessageBg"),
        border(`╰${rule}╯`),
      ];
    },
  };
}

export function createBackgroundTasks(pi) {
  const data = createBackgroundData(pi);
  const selection = { key: undefined, index: 0 };
  let popup;
  let ended = false;

  function open(ctx) {
    if (ended) return Promise.resolve();
    if (popup) return popup.finished;
    const retired = Promise.withResolvers();
    let handle;
    let dispose;
    function retire() {
      // The host's done() pops the top overlay, which might not be ours.
      handle?.hide();
      dispose?.();
      retired.resolve();
    }
    const custom = ctx.ui.custom((tui, theme) => {
      const view = createBackgroundView(tui, theme, {
        readRows: () => data.rows(ctx), preview: data.preview, selection, close: retire,
      });
      const stopRender = data.subscribe(view.refresh);
      dispose = () => {
        view.dispose();
        stopRender();
        dispose = undefined;
      };
      return view;
    }, {
      overlay: true,
      overlayOptions: { width: overlayWidth, margin: overlayMargin },
      onHandle(overlay) {
        if (ended) overlay.hide();
        else handle = overlay;
      },
    });
    const finished = Promise.race([custom, retired.promise]).finally(() => {
      dispose?.();
      popup = undefined;
    });
    popup = { finished, retire };
    return finished;
  }

  pi.on("session_shutdown", () => {
    ended = true;
    popup?.retire();
  });
  pi.registerCommand("background", {
    description: "Inspect background shell jobs and monitors",
    handler(_args, ctx) {
      if (ctx.hasUI && ctx.mode === "tui") return open(ctx);
    },
  });
  return { summary: data.summary, subscribe: data.subscribe, open };
}
