import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-tui", () => {
  const ANSI = /\[[0-9;]*m/g;
  const strip = (value) => value.replace(ANSI, "");
  const chars = (value) => [...strip(value)];
  const visibleWidth = (value) => chars(value).length;
  const truncateToWidth = (value, width) => {
    const plain = chars(value);
    if (plain.length <= width) return value;
    return `${plain.slice(0, Math.max(0, width - 1)).join("")}…`;
  };
  const wrapTextWithAnsi = (text, width) => {
    const out = [];
    for (const paragraph of strip(text).split("\n")) {
      let line = "";
      const flush = () => {
        out.push(line);
        line = "";
      };
      const pushWord = (word) => {
        if (!line) {
          line = word;
          return;
        }
        if (chars(line).length + 1 + chars(word).length <= width) line += ` ${word}`;
        else {
          flush();
          line = word;
        }
      };
      for (const word of paragraph.split(" ")) {
        let rest = word;
        if (chars(rest).length > width && !line) {
          const units = chars(rest);
          while (units.length > width) out.push(units.splice(0, width).join(""));
          line = units.join("");
        } else if (chars(rest).length > width) {
          flush();
          const units = chars(rest);
          while (units.length > width) out.push(units.splice(0, width).join(""));
          line = units.join("");
        } else pushWord(rest);
      }
      flush();
    }
    return out;
  };
  const RAW = {
    "ctrl+o": "",
    escape: "",
    up: "[A",
    down: "[B",
    pageUp: "[5~",
    pageDown: "[6~",
    home: "[H",
    end: "[F",
    tab: "	",
    enter: "\r",
  };
  const Key = {
    ctrl: (name) => `ctrl+${name}`,
    up: "up",
    down: "down",
    pageUp: "pageUp",
    pageDown: "pageDown",
    home: "home",
    end: "end",
    escape: "escape",
    tab: "tab",
    enter: "enter",
  };
  class ScrollView {
    constructor() {
      this.scrollTop = 0;
      this.viewportHeight = 0;
    }
    updateLayout(total, pageSize) {
      this.total = total;
      this.page = pageSize;
      this.viewportHeight = pageSize;
    }
    scrollTo(position) {
      this.scrollTop = Math.max(0, position);
    }
  }
  return {
    Key,
    matchesKey: (data, def) => data === RAW[def],
    ScrollView,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
  };
});

const { default: agentDetailStyle } = await import("./index.js");

const TITLE = "my-agent  (agent)";
const HEAD = ["status ● running", "elapsed 12s", "turns 4"];
const PROSE_TAIL = "second line of the same turn carrying tail token TAIL-XYZ-7";
const BODY = [
  "assistant: first line of the explanation",
  PROSE_TAIL,
  "third line still same turn",
  "tool: read",
  "tool: read",
  "tool: bash",
  "user: follow up question here",
  "error: something failed badly",
];

function frameLines(rows, footer, width = 110, title = TITLE) {
  const inner = width - 4;
  const body = [title, ...rows, footer].map((text) => `│ ${text.padEnd(inner).slice(0, inner)} │`);
  return [`┌${"─".repeat(width - 2)}┐`, ...body, `└${"─".repeat(width - 2)}┘`];
}

const fullFrame = () => frameLines([...HEAD, "", ...BODY], "esc close");
const flatText = (lines) => lines.join("\n").replace(/\s+/g, " ");
const theme = {
  fg: (_color, text) => text,
  bg: (_background, text) => text,
  bold: (text) => text,
};

function makeTui(rows = 30, cols = 80) {
  return {
    terminal: { columns: cols, rows },
    renders: 0,
    requestRender() {
      this.renders += 1;
    },
    showOverlay(component, options) {
      this.lastShown = { component, options };
      return "native-shown";
    },
  };
}

function install() {
  const handlers = new Map();
  const pi = { on: (event, handler) => handlers.set(event, handler) };
  agentDetailStyle(pi);
  return handlers;
}

function openOverlay(frame, rows = 30, cols = 80) {
  const handlers = install();
  const tui = makeTui(rows, cols);
  const widgets = new Map();
  handlers.get("session_start")({}, { hasUI: true, mode: "tui", ui: { setWidget: (id, factory) => widgets.set(id, factory) } });
  widgets.get("agent-detail-style-anchor")(tui, theme);
  const component = {
    inputSeen: [],
    mouseSeen: [],
    render(_width) {
      return frame;
    },
    scrollBy(delta) {
      this.scrolled = (this.scrolled ?? 0) + delta;
    },
    handleInput(data) {
      this.inputSeen.push(data);
      return "native-input";
    },
    handleMouse(event) {
      this.mouseSeen.push(event);
      return "native-mouse";
    },
  };
  const result = tui.showOverlay(component, { anchor: "center", width: "70%", minWidth: 52 });
  return { tui, component, result, handlers };
}

test("registers the widget for TUI sessions and cleans up on shutdown", () => {
  const handlers = install();
  expect(handlers.has("session_start")).toBe(true);
  expect(handlers.has("session_shutdown")).toBe(true);
  const widgets = new Map();
  handlers.get("session_start")({}, { hasUI: true, mode: "worker", ui: { setWidget: (id, factory) => widgets.set(id, factory) } });
  expect(widgets.size).toBe(0);
  const tui = makeTui();
  const original = tui.showOverlay;
  handlers.get("session_start")({}, { hasUI: true, mode: "tui", ui: { setWidget: (id, factory) => widgets.set(id, factory) } });
  widgets.get("agent-detail-style-anchor")(tui, theme);
  expect(tui.showOverlay).not.toBe(original);
  handlers.get("session_shutdown")({}, { mode: "tui" });
  expect(tui.showOverlay).toBe(original);
});

test("renders Transcript with Expand counts and preserves the prose tail", () => {
  const { tui, component, result } = openOverlay(fullFrame());
  expect(result).toBe("native-shown");
  expect(tui.lastShown.options.width).toBe("100%");
  const collapsed = flatText(component.render(76));
  expect(collapsed).toContain("Transcript");
  expect(collapsed).toContain("+2 lines · Expand");
  expect(collapsed).toContain("+3 lines · Expand");
  expect(collapsed).not.toContain("TAIL-XYZ-7");
  component.handleInput("");
  const open = flatText(component.render(76));
  expect(open).toContain("Collapse");
  expect(open).toContain(PROSE_TAIL);
  component.scrollBy(3);
  expect(flatText(component.render(76))).toContain("tool: bash");
});

test("expanding renders the full first line instead of the clipped fold label", () => {
  const first = "assistant: first line of a long explanation that keeps going past narrow widths with FIRST-LINE-TAIL";
  const frame = frameLines([...HEAD, "", first, ...BODY.slice(1)], "esc close");
  const { component } = openOverlay(frame);
  expect(flatText(component.render(76))).not.toContain("FIRST-LINE-TAIL");
  component.handleInput("\x0f");
  expect(flatText(component.render(76))).toContain("FIRST-LINE-TAIL");
  expect(flatText(component.render(76))).toContain(PROSE_TAIL);
});

test("scrolls the transcript body and keeps Escape closing natively", () => {
  const { component } = openOverlay(fullFrame());
  expect(flatText(component.render(76))).toContain("1–4 of 4");
  component.scrollBy(2);
  expect(flatText(component.render(76))).toContain("3–4 of 4");
  const escapeResult = component.handleInput("");
  expect(escapeResult).toBe("native-input");
  expect(component.inputSeen).toContain("");
});

test("toggles individual folds with mouse, Tab focus, and Enter", () => {
  const { component } = openOverlay(fullFrame());
  expect(flatText(component.render(76))).toContain("›");
  component.handleInput("\r");
  let rendered = flatText(component.render(76));
  expect(rendered).toContain("Collapse");
  expect(rendered).toContain("+3 lines · Expand");
  component.handleInput("\r");
  rendered = flatText(component.render(76));
  expect(rendered).toContain("+2 lines · Expand");
  let toggled = false;
  const lines = component.render(76);
  for (let y = 0; y < lines.length; y++) {
    const outcome = component.handleMouse({ y, button: "left", type: "click" });
    if (outcome?.handled === true && outcome?.render === true) {
      toggled = true;
      break;
    }
  }
  expect(toggled).toBe(true);
  expect(flatText(component.render(76))).toContain("Collapse");
});

test("marks capped native transcripts explicitly instead of faking expansion", () => {
  const paged = frameLines([...HEAD, "", ...BODY], "1-27/59  ↑↓/wheel  esc close");
  const { component } = openOverlay(paged);
  const rendered = flatText(component.render(76));
  expect(rendered).toContain("Native transcript capped by host");
  expect(rendered).toMatch(/showing \d+ of 59 rows/);
  expect(rendered).not.toContain("Click to show more");
  const huge = frameLines([...HEAD, "", ...BODY], "1-5/99999  ↑↓/wheel  esc close");
  const second = openOverlay(huge);
  expect(flatText(second.component.render(76))).toContain("of 99999 rows");
});

test("leaves unrecognized popups native and skips already-styled overlays", () => {
  const handlers = install();
  const tui = makeTui();
  const widgets = new Map();
  handlers.get("session_start")({}, { hasUI: true, mode: "tui", ui: { setWidget: (id, factory) => widgets.set(id, factory) } });
  widgets.get("agent-detail-style-anchor")(tui, theme);
  const menu = { render: () => [], scrollBy: () => {}, handleInput: () => "menu" };
  expect(tui.showOverlay(menu, { anchor: "center", width: "50%", minWidth: 52 })).toBe("native-shown");
  const styled = tui.showOverlay;
  const other = makeTui();
  other.showOverlay = styled;
  widgets.get("agent-detail-style-anchor")(other, theme);
  expect(other.showOverlay).toBe(styled);
  const legacy = new Function("return function showStyled(){ /* (agent) */ }")();
  const third = makeTui();
  third.showOverlay = legacy;
  widgets.get("agent-detail-style-anchor")(third, theme);
  expect(third.showOverlay).toBe(legacy);
});

test("matches the real baseline capture shape from before-agent-120-open", () => {
  const tail = "中文子代理修正 — retain these exact words.";
  const body = [
    "user: Fixture user prompt",
    "First user continuation",
    "Second user continuation",
    "assistant: The summary is only the first line.",
    "The actual answer continues for several lines.",
    tail,
    "tool: read",
    "tool: read",
    "tool: bash",
    "assistant: Detail 1 — scrolling sample",
    "assistant: Detail 14 — scrolling sample",
  ];
  const frame = frameLines(
    ["status ✓ finished", "elapsed 0s", "id st_readable_details_fixture", "", ...body],
    "1-27/59  ↑↓/wheel  esc close",
    120,
    "Readable details fixture  (agent)",
  );
  const { component } = openOverlay(frame);
  const collapsed = flatText(component.render(76));
  expect(collapsed).toContain("Transcript");
  expect(collapsed).toContain("Expand");
  expect(collapsed).not.toContain("retain these exact words");
  component.handleInput("");
  const open = flatText(component.render(120));
  expect(open).toContain(tail);
  expect(open).toContain("Native transcript capped by host");
});
