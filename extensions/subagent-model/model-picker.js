import { stripVTControlCharacters } from "node:util";
import { Input, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function pickRouteAction(ui, route, details, followsParent) {
  const choices = [
    { id: "model", label: "改模型", enabled: !followsParent },
    { id: "reasoning", label: "只改 Thinking", enabled: !followsParent && !!route.primary },
    { id: "description", label: "改描述", enabled: true },
  ];
  return ui.custom((tui, theme, _keybindings, done) => {
    let selected = choices.findIndex(({ enabled }) => enabled);
    let offset = 0;
    let maxOffset = 0;
    const description = stripVTControlCharacters(details.description ?? "").trim();
    return {
      render(width) {
        const rows = wrapTextWithAnsi(
          description || "未配置描述（内置默认描述不由 doctor 提供）",
          Math.max(1, width - 2),
        );
        const shown = Math.max(1, Math.min(8, tui.terminal.rows - 12));
        maxOffset = Math.max(0, rows.length - shown);
        offset = Math.min(offset, maxOffset);
        return [
          theme.fg("accent", `${route.section === "agents" ? "角色" : "分类"} · ${route.name}`),
          `模型：${followsParent ? "跟随父会话" : route.primary ?? "未解析"}`,
          `Thinking：${followsParent ? "不固定" : details.reasoning ?? "使用默认值"}`,
          theme.fg("muted", `配置描述${maxOffset ? ` · ${offset + 1}/${rows.length}` : ""}`),
          ...rows.slice(offset, offset + shown).map((line) => `  ${line}`),
          "",
          ...choices.map(({ id, label, enabled }, index) => {
            const text = `${index + 1}. ${label}${enabled ? "" : id === "reasoning" && !followsParent ? "（模型未解析）" : "（跟随父会话）"}`;
            return index === selected ? theme.fg("accent", `→ ${text}`) : `  ${text}`;
          }),
          theme.fg("dim", "↑↓ / 1–3 选择 · Enter 确认 · PgUp/PgDn 翻描述 · Esc 返回"),
        ].map((line) => truncateToWidth(line, width));
      },
      handleInput(data) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(undefined);
        if (matchesKey(data, Key.enter)) return done(choices[selected].id);
        const direct = choices[Number(data) - 1];
        if (direct?.enabled) return done(direct.id);
        if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - 1);
        if (matchesKey(data, Key.pageDown)) offset = Math.min(maxOffset, offset + 1);
        const step = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : 0;
        if (step) {
          for (let i = selected + step; i >= 0 && i < choices.length; i += step) {
            if (choices[i].enabled) { selected = i; break; }
          }
        }
        tui.requestRender();
      },
    };
  });
}

export function pickModel(ui, models, routeName, initialQuery) {
  return ui.custom((tui, theme, _keybindings, done) => {
    const input = new Input();
    input.setValue(initialQuery);
    let selected = 0;
    let matches = [];
    function filter() {
      const terms = input.getValue().trim().toLowerCase().split(/\s+/u);
      matches = models.filter((id) => terms.every((term) => id.toLowerCase().includes(term)));
      selected = 0;
    }
    filter();
    return {
      invalidate() { input.invalidate(); },
      render(width) {
        const count = Math.max(1, Math.min(8, tui.terminal.rows - 8));
        const start = Math.max(0, Math.min(selected - Math.floor(count / 2), matches.length - count));
        const rows = matches.slice(start, start + count).map((id, i) => i + start === selected
          ? theme.fg("accent", `→ ${id}`)
          : `  ${id}`);
        return [
          `选择模型 · ${routeName} · ${matches.length}/${models.length}`,
          ...input.render(width),
          ...(rows.length ? rows : ["没有匹配的模型"]),
          "输入即筛选 · ↑↓ 移动 · Enter 选择 · Esc 返回",
        ].map((line) => truncateToWidth(line, width));
      },
      handleInput(data) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(undefined);
        if (matchesKey(data, Key.enter)) {
          if (matches[selected] !== undefined) done(matches[selected]);
          return;
        }
        if (matchesKey(data, Key.up)) {
          selected = Math.max(0, selected - 1);
        } else if (matchesKey(data, Key.down)) {
          selected = Math.max(0, Math.min(matches.length - 1, selected + 1));
        } else {
          const previous = input.getValue();
          input.handleInput(data);
          if (input.getValue() !== previous) filter();
        }
        tui.requestRender();
      },
    };
  });
}
