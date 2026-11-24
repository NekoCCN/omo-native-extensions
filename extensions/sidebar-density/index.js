import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { compactTools } from "./rows.js";

const layout = Symbol.for("@earendil-works/pi-tui/layout-node");
const viewport = Symbol.for("@earendil-works/pi-tui/viewport");
const markers = { pending: "○", in_progress: "▶", completed: "✓", abandoned: "×" };
const clean = (text) => stripVTControlCharacters(text).replace(/\s+/gu, " ").trim();

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

function attach(tui, theme, ctx) {
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
  let active = true;
  let leaf;
  let phases = [];
  const wrappedWidgets = new WeakSet();

  const visible = () => active && tui.layoutRoot === root && panel.render === paint &&
    Boolean(right.visible({ width: tui.terminal.columns, height: tui.terminal.rows }));
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
    const base = compactTools(renderPanel.call(panel, width), (text) =>
      theme.fg("accent", truncateToWidth(text, width)));
    const maxRows = Math.max(4, Math.min(18, Math.floor(tui.terminal.rows * 0.45)));
    return [...renderTodo(phases, theme, width, maxRows), ...base];
  };
  root[layout] = decorated;
  panel.render = paint;
  tui.requestRender(true);
  return {
    root,
    dispose() {
      active = false;
      if (root[layout] === decorated) root[layout] = describe;
      if (panel.render === paint) panel.render = renderPanel;
    },
  };
}

export default function sidebarDensity(pi) {
  let cleanup;
  pi.on("session_shutdown", () => cleanup?.());
  pi.on("session_start", (_event, ctx) => {
    cleanup?.();
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    ctx.ui.setWidget("local-sidebar-density-anchor", (tui, theme) => {
      let installed;
      let queued = false;
      let disposed = false;
      // The widget container clears and reuses its children on updates.
      // Attach lifetime follows the session, not the container's dispose pass.
      cleanup = () => {
        disposed = true;
        installed?.dispose();
      };
      return {
        render() {
          if (!disposed && !queued && (!installed || installed.root !== tui.layoutRoot)) {
            queued = true;
            queueMicrotask(() => {
              queued = false;
              if (disposed) return;
              installed?.dispose();
              installed = attach(tui, theme, ctx);
            });
          }
          return [];
        },
        invalidate() {},
      };
    });
  });
}
