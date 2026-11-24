import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { readRoute, selectPrimary, setRouteField } from "./config.js";
import { pickModel, pickRouteAction } from "./model-picker.js";

const exec = promisify(execFile);

async function readRoutes(cwd) {
  const { stdout } = await exec("omo", ["doctor", "--models", "--json"], {
    cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  return ["agents", "categories"].flatMap((section) =>
    report[section].map(({ name, primary, status }) =>
      ({ section, name, primary, status, profile: report.configProfile })),
  );
}

async function readUserConfig() {
  const directory = join(homedir(), ".omo");
  for (const filename of ["omo.jsonc", "omo.json"]) {
    const path = join(directory, filename);
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) throw new TypeError(`${path} 不是普通文件；未写入。`);
      return { path, source: await readFile(path, "utf8"), mode: stat.mode & 0o777, exists: true };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { path: join(directory, "omo.jsonc"), source: "{}\n", mode: 0o600, exists: false };
}

async function saveConfig(config, source) {
  await mkdir(dirname(config.path), { recursive: true });
  const tmp = `${config.path}.subagent-model-${randomUUID()}.tmp`;
  await writeFile(tmp, source, { flag: "wx", mode: config.mode });
  try {
    const live = await readUserConfig();
    if (live.path !== config.path || live.exists !== config.exists || live.source !== config.source) {
      throw new Error("配置在菜单打开期间已变更；请重新打开菜单再保存。");
    }
    await rename(tmp, config.path);
  } catch (error) {
    await unlink(tmp);
    throw error;
  }
}

export default function subagentModel(pi) {
  let active = true;
  pi.on("session_shutdown", () => { active = false; });
  pi.registerCommand("subagent-model", {
    description: "查看和编辑 OMO 子代理或任务分类的模型、Thinking 和描述",
    async handler(args, ctx) {
      if (!ctx.hasUI) return;
      let saved = false;
      try {
        const routes = (await readRoutes(ctx.cwd)).filter(({ status }) => status !== "disabled");
        const inherits = ({ section, name }) => section === "agents" && name === "technical-lead";
        const labels = routes.map(({ section, name, primary }) =>
          `${section === "agents" ? "角色" : "分类"} · ${name}  →  ${inherits({ section, name }) ? "跟随父会话" : primary ?? "未解析"}`,
        );
        const config = await readUserConfig();
        let route, details, action;
        while (!action) {
          const selected = await ctx.ui.select("子代理配置 · 选择角色或分类", labels);
          route = routes[labels.indexOf(selected)];
          if (!route) return;
          details = readRoute(config.source, route.section, route.name, route.profile, route.primary);
          action = await pickRouteAction(ctx.ui, route, details, inherits(route));
        }
        const { section, name, primary, profile } = route;
        let source, model, change;
        if (action === "description") {
          const description = await ctx.ui.editor(`编辑描述 · ${name}（留空清除自定义描述）`, details.description ?? "");
          if (description === undefined) return;
          source = setRouteField(config.source, section, name, "description", description.trim() || undefined, profile);
          change = "描述";
        } else {
          const models = new Map((await ctx.modelRegistry.getAvailable()).map((model) => [`${model.provider}/${model.id}`, model]));
          if (action === "model") {
            if (!models.size) {
              ctx.ui.notify("当前没有可选模型；请先配置或登录模型提供方。", "warning");
              return;
            }
            model = await pickModel(ctx.ui, [...models.keys()].sort(), name, args.trim());
            if (model === undefined || model === primary) return;
            source = selectPrimary(config.source, section, name, model, undefined, profile);
            change = `模型：${primary ?? "未解析"} → ${model}（已有轮询链会改为顺序首选）`;
          } else {
            const current = models.get(primary);
            if (!current) {
              ctx.ui.notify("当前模型不可用，无法核对它支持的 Thinking 档位。", "warning");
              return;
            }
            const levels = getSupportedThinkingLevels(current);
            const effort = await ctx.ui.select(`只改 Thinking · ${primary}`, levels.length ? levels : ["off"]);
            if (effort === undefined || effort === details.reasoning) return;
            source = setRouteField(config.source, section, name, "reasoning", effort, profile, primary);
            change = `Thinking：${details.reasoning ?? "默认"} → ${effort}`;
          }
        }
        if (source === config.source) return;
        if (!await ctx.ui.confirm(`保存 ${name} 的${change}？`,
          `${config.path}\n当前配置档：${profile || "默认"}。已有配置档定义时只改该定义，否则改全局定义；项目覆盖优先。`)) return;
        await saveConfig(config, source);
        saved = true;
        const resolved = model && (await readRoutes(ctx.cwd)).find((entry) => entry.section === section && entry.name === name);
        // Saving can hot-reload the extension while the diagnostic process is running.
        if (!active) return;
        if (model && resolved?.primary !== model) {
          ctx.ui.notify(`已保存，但当前目录解析为 ${resolved?.primary ?? "未解析"}；请检查项目覆盖或模型排除设置。`, "warning");
          return;
        }
        ctx.ui.notify(`已保存 ${name} · ${change}。用于后续派工；需要时会在空闲后自动重载。`, "info");
      } catch (error) {
        if (!active) return;
        ctx.ui.notify(`${saved ? "配置已保存，但无法核对路由" : "未保存子代理配置"}：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
