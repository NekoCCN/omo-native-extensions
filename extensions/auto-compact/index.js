import { randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { preview, setLimit } from "./config.js";

const tokens = (value) => new Intl.NumberFormat("en-US").format(value);
const limitLabel = (count, window) => `${(100 * count / window).toFixed(1)}% · ${tokens(count)} tokens`;

function choose(ui, config, model, window, used) {
  const current = preview(config, model, window);
  const options = [...new Set([40, 50, 60, 70, current.baseline].filter((p) => p <= current.baseline))]
    .map((percent) => ({ label: `${percent}%`, percent }));
  options.push({ label: "自定义", custom: true }, { label: "移除本模型覆盖" });
  return ui.custom((tui, theme, _keys, done) => {
    let selected = options.length - 1;
    return {
      render(width) {
        const option = options[selected];
        const candidate = option.custom ? current : preview(
          setLimit({ compaction: config }, model, window, option.percent).compaction ?? {}, model, window,
        );
        const size = Math.max(1, Math.min(width - 9, 36));
        const count = Math.min(size, Math.max(0, Math.floor(size * (used ?? 0) / window)));
        const bar = theme.fg("accent", "━".repeat(count)) + theme.fg("dim", "─".repeat(size - count));
        return [
          theme.bold(theme.fg("accent", "Auto-Compact  /  提前压缩")),
          theme.fg("muted", model),
          "",
          `用量  ${bar}  ${used == null ? "未知" : `${(100 * used / window).toFixed(1)}%`}`,
          `窗口  ${tokens(window)} tokens  ·  引擎自适应基准 ${current.baseline}%`,
          `当前  ${limitLabel(current.limit, window)}  ·  ${current.override == null ? "继承默认预留" : "模型覆盖"}`,
          theme.fg("accent", `预览  ${option.custom ? `40–${current.baseline}% 可输入` : limitLabel(candidate.limit, window)}`),
          "",
          ...options.map(({ label, percent }, i) => {
            const text = `${i === selected ? "›" : " "}  ${label}${percent === undefined ? "" : `  ·  ${tokens(Math.floor(window * percent / 100))} tokens`}`;
            return i === selected ? theme.fg("accent", text) : text;
          }),
          "",
          theme.fg("muted", "引擎可能更早压缩；增大预留也会影响响应和摘要预算。"),
          theme.fg("dim", "↑↓ 预览  ·  Enter 选择  ·  Esc 取消"),
        ].map((line) => truncateToWidth(line, width));
      },
      handleInput(data) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(undefined);
        if (matchesKey(data, Key.enter)) return done(options[selected]);
        if (matchesKey(data, Key.up)) selected = (selected + options.length - 1) % options.length;
        if (matchesKey(data, Key.down)) selected = (selected + 1) % options.length;
        tui.requestRender();
      },
    };
  });
}

export default function autoCompact(pi) {
  pi.registerCommand("auto-compact", {
    description: "查看上下文用量并调整当前模型的提前压缩线",
    async handler(_args, ctx) {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      const usage = ctx.getContextUsage();
      const window = usage?.contextWindow ?? ctx.model?.contextWindow;
      if (!ctx.model || !Number.isSafeInteger(window) || window <= 0) {
        ctx.ui.notify("当前模型没有已知的上下文窗口。", "warning");
        return;
      }
      const model = `${ctx.model.provider}/${ctx.model.id}`;
      const path = join(getAgentDir(), "settings.json");
      try {
        const source = await readFile(path, "utf8");
        const global = JSON.parse(source.replace(/^\uFEFF/u, ""));
        const config = global.compaction ?? {};
        const option = await choose(ctx.ui, config, model, window, usage?.tokens);
        if (!option) return;
        let percent = option.percent;
        if (option.custom) {
          const max = preview(config, model, window).baseline;
          const value = await ctx.ui.input(`提前压缩线 · 输入 40–${max} 的整数`);
          if (value === undefined) return;
          percent = /^\d+$/u.test(value.trim()) ? Number(value) : NaN;
        }
        const next = setLimit(global, model, window, percent);
        if (next === global || JSON.stringify(next) === JSON.stringify(global)) return;
        const result = preview(next.compaction ?? {}, model, window);
        if (!await ctx.ui.confirm(`保存 ${model} 的提前压缩设置？`,
          `预留边界：${limitLabel(result.limit, window)}。引擎可能更早触发；预留也影响响应和摘要预算。只写用户设置；项目设置可覆盖。`)) return;
        const tmp = `${path}.${randomUUID()}.tmp`;
        const { mode } = await stat(path);
        try {
          await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode });
          if (await readFile(path, "utf8") !== source) throw new Error("设置已被其他操作修改，请重新打开菜单。");
          await rename(tmp, path);
        } finally {
          await unlink(tmp).catch((error) => { if (error.code !== "ENOENT") throw error; });
        }
        ctx.ui.notify("已保存当前模型的提前压缩设置；空闲重载后用于后续轮次。没有执行压缩。", "info");
      } catch (error) {
        ctx.ui.notify(`无法保存提前压缩设置：${error.message}`, "error");
      }
    },
  });
}
