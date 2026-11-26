import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const margin = { top: 1, right: 2, bottom: 1, left: 2 };

function createMenu(tui, theme, { choices, title, guidance, finish }) {
  const muted = (text) => theme.fg("muted", text);
  const search = new Input({ prompt: "⌕ ", placeholder: "Search actions", placeholderStyle: muted });
  const frameRows = guidance ? 6 : 5;
  let results = choices;
  let selected = 0;
  let page = 10;
  search.onEscape = () => finish();

  return {
    get focused() { return search.focused; },
    set focused(value) { search.focused = value; },
    invalidate() {},
    handleInput(data) {
      if (matchesKey(data, Key.escape)) return finish();
      if (matchesKey(data, Key.enter) || data === "\n") {
        const action = results[selected];
        if (action) finish(action);
        return;
      }
      const motion = [
        [Key.up, -1], [Key.down, 1], [Key.pageUp, -page], [Key.pageDown, page],
      ].find(([key]) => matchesKey(data, key));
      if (motion && results.length) {
        selected = Math.max(0, Math.min(results.length - 1, selected + motion[1]));
      } else {
        const previous = search.getValue();
        search.handleInput(data);
        const query = search.getValue();
        if (query !== previous) {
          const words = query.trim().toLowerCase().split(/\s+/u);
          results = choices.filter(({ label }) => words.every((word) => label.toLowerCase().includes(word)));
          selected = 0;
        }
      }
      tui.requestRender();
    },
    render(width) {
      const height = tui.terminal.rows - margin.top - margin.bottom;
      if (width < 6 || height <= frameRows) return [truncateToWidth("/actions · Esc close", width)];
      page = Math.min(10, height - frameRows, choices.length);
      const start = Math.max(0, Math.min(selected - Math.floor(page / 2), results.length - page));
      const body = results.slice(start, start + page);
      const inner = width - 4;
      const border = (text) => theme.fg("borderMuted", text);
      const framed = (text, bg) => {
        const pad = " ".repeat(Math.max(0, inner - visibleWidth(text)));
        return `${border("│")}${theme.bg(bg, ` ${text}${pad} `)}${border("│")}`;
      };
      const line = (text, bg = "toolPendingBg") => framed(
        truncateToWidth(text, inner).replaceAll("\x1b[0m", "\x1b[22;39m"), bg,
      );
      const rule = "─".repeat(width - 2);
      const count = results.length > page ? ` · ${selected + 1}/${results.length}` : "";
      const expandedHelp = `↑↓ Select · Enter Open · Esc Close${count}`;
      const help = visibleWidth(expandedHelp) <= inner ? expandedHelp : `↑↓ · Enter · Esc${count}`;
      return [
        border(`╭${rule}╮`),
        line(theme.fg("accent", theme.bold(title)), "customMessageBg"),
        framed(search.render(inner)[0], "toolPendingBg"),
        ...Array.from({ length: page }, (_, index) => {
          const choice = body[index];
          if (!choice) return line(index === 0 ? muted("No matching actions") : "");
          return start + index === selected
            ? line(`${theme.fg("accent", "› ")}${choice.label}`, "selectedBg")
            : line(`  ${choice.label}`);
        }),
        ...(guidance ? [line(muted(guidance), "customMessageBg")] : []),
        line(muted(help), "customMessageBg"),
        border(`╰${rule}╯`),
      ];
    },
  };
}

export function registerSidebarActions(pi, { bg, agents }) {
  let retire;
  pi.on("session_shutdown", () => {
    retire?.();
    retire = undefined;
  });
  pi.registerCommand("actions", {
    description: "Search sidebar actions: Background tasks and native Agent details",
    async handler(_args, ctx) {
      if (!ctx.hasUI || ctx.mode !== "tui" || retire) return;
      const entries = agents();
      const choices = [
        { label: "Background tasks", run: () => bg.open(ctx) },
        ...entries.map(({ label, run }) => ({ label: `Agent · ${label}`, run })),
      ];
      const choice = Promise.withResolvers();
      let handle;
      let closed = false;
      function finish(action) {
        if (closed) return;
        closed = true;
        // Hide this overlay, not whichever overlay is currently on top.
        handle?.hide();
        choice.resolve(action);
      }
      retire = finish;
      let action;
      try {
        const custom = ctx.ui.custom((tui, theme) => createMenu(tui, theme, {
          choices,
          title: `Sidebar actions${entries.length ? ` · ${entries.length} Agents` : ""}`,
          guidance: entries.length ? "" : "See /tasks · No Agent links",
          finish,
        }), {
          overlay: true,
          overlayOptions: { width: 68, margin },
          onHandle(overlay) {
            if (closed) overlay.hide();
            else handle = overlay;
          },
        });
        action = await Promise.race([custom, choice.promise]);
      } finally {
        if (retire === finish) retire = undefined;
      }
      if (closed) await action?.run();
    },
  });
}
