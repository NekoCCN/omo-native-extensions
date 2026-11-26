import { stripVTControlCharacters } from "node:util";
import { Container, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createBackgroundTasks } from "./background.js";
import { backgroundUrl, isAgentHeading, isAgentRow, renderPanelRows } from "./rows.js";

const layout = Symbol.for("@earendil-works/pi-tui/layout-node");
const viewport = Symbol.for("@earendil-works/pi-tui/viewport");
const markers = { pending: "○", in_progress: "▶", completed: "✓", abandoned: "×" };
const clean = (text) => stripVTControlCharacters(text).replace(/\s+/gu, " ").trim();
// The native DAG renderer indents each node by two spaces; run headers and
// tracking/count summaries are not indented.
const dagChildRow = /^ {2}[▶◌◔⊟✓✗⊘⏸○](?:\uFE0F)? /u;

function renderTodo(phases, theme, width, maxRows) {
  const total = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  if (!total) return [];
  const finished = phases.reduce((sum, phase) => sum + phase.tasks.filter(({ status }) =>
    status === "completed" || status === "abandoned").length, 0);
  const heading = theme.fg("accent", truncateToWidth(`TODO  ${finished}/${total} closed`, width));
  const active = phases.findIndex(({ tasks }) => tasks.some(({ status }) => status === "in_progress"));
  const ordered = active > 0 ? [...phases.slice(active), ...phases.slice(0, active)] : phases;
  const lines = ordered.flatMap(({ name, tasks }) => [
    theme.fg("muted", truncateToWidth(clean(name), width)),
    ...tasks.flatMap(({ content, status }) => wrapTextWithAnsi(`${markers[status] ?? "○"} ${clean(content)}`, width)
      .map((line) => status === "in_progress" ? theme.fg("accent", line)
        : status === "completed" || status === "abandoned" ? theme.fg("dim", line) : line)),
  ]);
  if (lines.length + 1 <= maxRows) return [heading, ...lines, ""];
  return [heading, ...lines.slice(0, maxRows - 2), theme.fg("muted", "… /todo 查看全部"), ""];
}

function attach(tui, theme, { ctx, bg }) {
  const root = tui.layoutRoot;
  const describe = root?.[layout];
  if (tui[viewport] !== true || typeof describe !== "function") return;
  const node = describe.call(root);
  // The shipped side panel is a two-entry hstack: native transcript and a
  // right column whose visibility is decided dynamically by its own predicate.
  const [left, right] = node.entries ?? [];
  if (node.type !== "hstack" || node.entries.length !== 2 || !left?.minSize ||
      right?.grow !== 0 || right.shrink !== 0 || typeof right.visible !== "function" ||
      typeof right.component?.render !== "function") return;
  const panel = right.component;
  const renderPanel = panel.render;
  const previousOpenUrl = tui.openUrl;
  let active = true;
  let leaf;
  let phases = [];
  let agentsPainted = false;
  const wrappedWidgets = new WeakSet();

  const visible = () => active && tui.layoutRoot === root && panel.render === paint &&
    Boolean(right.visible({ width: tui.terminal.columns, height: tui.terminal.rows }));
  function openUrl(url) {
    if (url !== backgroundUrl) return previousOpenUrl?.call(this, url);
    if (visible()) {
      return bg.open(ctx).catch((error) => {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      });
    }
  }
  function hideNativeTodo(component, seen) {
    if (!component || seen.has(component)) return;
    seen.add(component);
    if (typeof component.updateDisplay === "function" && component.completionKeys instanceof Set &&
        Array.isArray(component.model?.rows) && typeof component.render === "function") {
      if (!wrappedWidgets.has(component)) {
        wrappedWidgets.add(component);
        const render = component.render;
        component.render = (width) => visible() && phases.some(({ tasks }) => tasks.length)
          ? [] : render.call(component, width);
      }
      return;
    }
    for (const child of component.children ?? []) hideNativeTodo(child, seen);
    const layoutNode = component[layout]?.();
    for (const entry of layoutNode?.entries ?? []) hideNativeTodo(entry.component, seen);
  }

  const decorated = function () {
    const nextLeaf = ctx.sessionManager.getLeafId();
    if (leaf !== nextLeaf) {
      leaf = nextLeaf;
      const entry = ctx.sessionManager.getBranch().findLast((item) =>
        (item.type === "custom" && item.customType === "senpi.todo-state" && Array.isArray(item.data?.phases)) ||
        (item.type === "message" && item.message?.role === "toolResult" &&
          item.message.toolName === "todo" && Array.isArray(item.message.details?.phases)));
      phases = entry?.data?.phases ?? entry?.message?.details?.phases ?? [];
    }
    if (visible()) hideNativeTodo(left.component, new Set());
    return describe.call(root);
  };
  const paint = function (width) {
    const maxRows = Math.max(4, Math.min(18, Math.floor(tui.terminal.rows * 0.45)));
    const todo = renderTodo(phases, theme, width, maxRows);
    const rows = renderPanelRows(renderPanel.call(panel, width), {
      width, todo, background: bg.summary(),
      paint: (text) => theme.fg("accent", truncateToWidth(text, width)),
    });
    const heading = rows.findIndex((line, index) => index >= todo.length + 2 && isAgentHeading(line));
    const next = heading >= 0 && heading + 1 < tui.terminal.rows && isAgentRow(rows[heading + 1] ?? "");
    if (agentsPainted !== next) {
      agentsPainted = next;
      // The left column may have already painted this frame.
      queueMicrotask(() => { if (active) tui.requestRender(); });
    }
    return rows;
  };
  root[layout] = decorated;
  panel.render = paint;
  tui.openUrl = openUrl;
  const unsubscribe = bg.subscribe(() => { if (visible()) tui.requestRender(); });
  tui.requestRender(true);
  return {
    root,
    showsAgents: () => visible() && agentsPainted,
    dispose() {
      active = false;
      unsubscribe();
      if (tui.openUrl === openUrl) tui.openUrl = previousOpenUrl;
      if (root[layout] === decorated) root[layout] = describe;
      if (panel.render === paint) panel.render = renderPanel;
    },
  };
}

export default function sidebarDensity(pi) {
  const bg = createBackgroundTasks(pi);
  let cleanup;
  pi.on("session_shutdown", () => cleanup?.());
  pi.on("session_start", (_event, ctx) => {
    cleanup?.();
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const ui = ctx.ui;
    const setWidget = ui.setWidget;
    let installed;
    let disposed = false;
    const widgetContents = new Map();
    function setTaskWidget(key, content, options) {
      if (key !== "omo-task" && key !== "omo-dag") return setWidget.call(this, key, content, options);
      widgetContents.set(key, { content, options });
      if (options?.placement !== "belowEditor" || options.actions?.length || !Array.isArray(content)) {
        return setWidget.call(this, key, content, options);
      }
      return setWidget.call(this, key, (tui, theme) => {
        const build = (lines) => {
          const box = new Container();
          for (const line of lines.slice(0, 10)) box.addChild(new Text(line, 1, 0));
          if (lines.length > 10) box.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
          return box;
        };
        const widget = new Container();
        const full = build(content);
        const summarized = key === "omo-dag"
          ? build(content.filter((line) => !dagChildRow.test(stripVTControlCharacters(line))))
          : undefined;
        widget.render = (width) => !disposed && installed?.showsAgents()
          ? summarized?.render(width) ?? []
          : full.render(width);
        return widget;
      }, options);
    }
    ui.setWidget = setTaskWidget;
    cleanup = () => {
      disposed = true;
      installed?.dispose();
      if (ui.setWidget === setTaskWidget) {
        ui.setWidget = setWidget;
        for (const [key, { content, options }] of widgetContents) setWidget.call(ui, key, content, options);
      }
    };
    ui.setWidget("local-sidebar-density-anchor", (tui, theme) => {
      let queued = false;
      return {
        render() {
          if (!disposed && !queued && (!installed || installed.root !== tui.layoutRoot)) {
            queued = true;
            queueMicrotask(() => {
              queued = false;
              if (disposed) return;
              installed?.dispose();
              installed = attach(tui, theme, { ctx, bg });
            });
          }
          return [];
        },
        invalidate() {},
      };
    });
  });
}
