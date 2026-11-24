import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree } from "jsonc-parser";

function parseConfig(source) {
  const errors = [];
  const root = parseTree(source, errors, { allowTrailingComma: true });
  if (errors.length || root?.type !== "object") {
    throw new SyntaxError("OMO 配置不是有效的 JSONC 对象；未写入。");
  }
  return root;
}

function routePaths(section, name, prefix = []) {
  return ["[native]", "[senpi]", undefined]
    .map((layer) => [...prefix, ...(layer ? [layer] : []), section, name]);
}

function configuredPath(root, section, name, profile) {
  return routePaths(section, name, profile ? ["profiles", profile] : [])
    .find((path) => findNodeAtLocation(root, path));
}

export function readRoute(source, section, name, profile, primary) {
  const root = parseConfig(source);
  const global = configuredPath(root, section, name);
  const scoped = profile ? configuredPath(root, section, name, profile) : undefined;
  const value = (path) => path ? getNodeValue(findNodeAtLocation(root, path)) : undefined;
  const route = { ...value(global), ...value(scoped) };
  const rung = Array.isArray(route.models)
    ? route.models.find((entry) => entry?.model === primary)
    : undefined;
  return { description: route.description, reasoning: rung?.reasoning ?? route.reasoning };
}

function routeEditor(source, section, name, profile) {
  const root = parseConfig(source);
  const scoped = profile ? configuredPath(root, section, name, profile) : undefined;
  const global = configuredPath(root, section, name);
  const path = scoped ?? global ?? ["[native]", section, name];
  if (section === "agents" && !scoped && !findNodeAtLocation(root, path) &&
      !findNodeAtLocation(root, ["agents", name]) &&
      !findNodeAtLocation(root, ["[senpi]", "agents", name])) {
    const profiles = findNodeAtLocation(root, ["profiles"]);
    for (const property of profiles?.children ?? []) {
      const other = property.children?.[0]?.value;
      if (typeof other === "string" && ["[native]", "[senpi]", undefined].some((layer) =>
        findNodeAtLocation(root, ["profiles", other, ...(layer ? [layer] : []), "agents", name]))) {
        throw new TypeError(`${name} 只在 ${other} 配置档中定义；不会写入全局路由。`);
      }
    }
  }
  for (let depth = 1; depth <= path.length; depth++) {
    const node = findNodeAtLocation(root, path.slice(0, depth));
    if (node && node.type !== "object") {
      throw new TypeError(`${path.slice(0, depth).join(".")} 不是对象；未写入。`);
    }
  }

  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" };
  const set = (key, value, options = {}) => {
    source = applyEdits(source, modify(source, [...path, ...key], value, { formattingOptions, ...options }));
  };
  return {
    node: (key) => findNodeAtLocation(root, [...path, ...key]),
    inheritedNode: (key) => scoped && global ? findNodeAtLocation(root, [...global, ...key]) : undefined,
    set,
    source: () => source,
  };
}

function protectInheritedModel(section, name) {
  if (section === "agents" && name === "technical-lead") {
    throw new TypeError("technical-lead 跟随父会话模型；不能在菜单里设置固定模型或 Thinking。");
  }
}

const modelId = (entry) => typeof entry === "string" ? entry : entry?.model;

export function setRouteField(source, section, name, field, value, profile, primary) {
  if (field === "reasoning") protectInheritedModel(section, name);
  const edit = routeEditor(source, section, name, profile);
  if (field === "reasoning") {
    const localChain = edit.node(["models"]);
    const chain = localChain ?? edit.inheritedNode(["models"]);
    if (chain && chain.type !== "array") throw new TypeError(`${name}.models 不是数组；未写入。`);
    const entries = chain && getNodeValue(chain);
    const index = Array.isArray(entries) ? entries.findIndex((entry) => modelId(entry) === primary) : -1;
    if (index >= 0) {
      const entry = entries[index];
      if (!localChain) {
        // A per-model override wins over a route-level Thinking value.
        if (typeof entry !== "string" && entry.reasoning !== undefined) {
          entries[index] = { ...entry, reasoning: value };
          edit.set(["models"], entries);
        } else {
          edit.set(["reasoning"], value);
        }
      } else if (typeof entry === "string") {
        edit.set(["models", index], { model: entry, reasoning: value });
      } else {
        edit.set(["models", index, "reasoning"], value);
      }
      return edit.source();
    }
  }
  if (field !== "description" && field !== "reasoning") throw new TypeError(`未知字段：${field}`);
  edit.set([field], value);
  return edit.source();
}

export function selectPrimary(source, section, name, model, reasoning, profile) {
  protectInheritedModel(section, name);
  const edit = routeEditor(source, section, name, profile);
  const { set } = edit;
  const localChain = edit.node(["models"]);
  const chain = localChain ?? edit.inheritedNode(["models"]);
  const configured = edit.node(["model"]);
  if (chain && chain.type !== "array") {
    throw new TypeError(`${name}.models 不是数组；未写入。`);
  }
  if (chain?.children?.length) {
    const entries = getNodeValue(chain);
    if (!localChain) set(["models"], entries);
    const matching = entries.findIndex((entry) => modelId(entry) === model);
    const existing = entries[matching];
    if (matching > 0) set(["models", matching], undefined);
    if (matching !== 0) set(["models", 0], existing ?? model, { isArrayInsertion: true });
    if (reasoning !== undefined) {
      if (typeof existing === "object" && existing !== null) {
        set(["models", 0, "reasoning"], reasoning);
      } else {
        set(["models", 0], { model, reasoning });
      }
    }
    const previous = configured && getNodeValue(configured);
    if (typeof previous === "string" && previous !== model && !entries.some((entry) => modelId(entry) === previous)) {
      set(["models", -1], previous, { isArrayInsertion: true });
    }
    if (configured) set(["model"], undefined);
  } else {
    set(["model"], model);
    if (reasoning !== undefined) set(["reasoning"], reasoning);
  }
  if ((edit.node(["models_distribution"]) ?? edit.inheritedNode(["models_distribution"]))?.value === "round_robin") {
    set(["models_distribution"], "sequential");
  }
  return edit.source();
}
