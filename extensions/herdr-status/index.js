export default function herdrTheme(pi) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID || !process.env.HERDR_SOCKET_PATH) return;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    // A theme instance changes this TUI without persisting the theme globally.
    const theme = ctx.ui.getTheme("sakura-nocturne");
    if (theme) ctx.ui.setTheme(theme);
  });
}
