import { stripVTControlCharacters } from "node:util";

const fields = /^(status|elapsed|reason|category|runs|doing|turns|tokens|cost|id) *(.*)$/u;
const statusStart = /^status +[◦●‖✓✗-] (?:queued|running|resuming|ending|finished|failed|cancelled)\b/u;
const entry = /^(assistant|user|tool(?:\[error\])?|error)(?=[:\s])/u;
const toolName = /^tool: (.+)$/u;
const elided = /^(?:\s*\.\.\.\[elided|\(earlier output elided)/u;
const rangeFooter = /^(\d+)-(\d+)\/(\d+)  ↑↓\/wheel  esc close$/u;

export function readFrame(lines) {
  if (lines.length < 4) return;
  const plain = lines.map(stripVTControlCharacters);
  if (!/^┌─+┐$/u.test(plain[0]) || !/^└─+┘$/u.test(plain.at(-1)) ||
      !plain.slice(1, -1).every((line) => line.startsWith("│ ") && line.endsWith(" │"))) return;
  const [title, ...rows] = plain.slice(1, -1).map((line) => line.slice(2, -2).trimEnd());
  const footer = rows.pop().trim();
  const range = rangeFooter.exec(footer);
  if (!range && footer !== "esc close") return;
  return { title, rows, range };
}

export function isAgentFrame(frame) {
  return /  \(agent\)$/u.test(frame.title) ||
    (/…$/u.test(frame.title) && statusStart.test(frame.rows[0] ?? ""));
}

export function agentContent(frame) {
  const divider = frame.rows.indexOf("");
  if (divider < 1 || !statusStart.test(frame.rows[0]) ||
      !frame.rows.slice(0, divider).every((line) => fields.test(line))) return;
  const metadata = new Map(frame.rows.slice(0, divider).map((line) => {
    const [, key, value] = fields.exec(line);
    return [key, value.trimStart()];
  }));
  return { title: frame.title, metadata, blocks: [...transcriptBlocks(frame.rows.slice(divider + 1))] };
}

export function* transcriptBlocks(rows) {
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    if (toolName.test(rows[start])) {
      while (end < rows.length && toolName.test(rows[end])) end++;
      if (end - start > 1) {
        const counts = new Map();
        for (let i = start; i < end; i++) {
          const [, name] = toolName.exec(rows[i]);
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        const summary = [...counts].map(([name, count]) => count === 1 ? name : `${name} ×${count}`).join(" · ");
        yield { start, lines: rows.slice(start, end), preview: `Tools  ${summary}`, hidden: end - start };
      } else yield { lines: rows.slice(start, end) };
    } else if (entry.exec(rows[start])?.[1] === "assistant") {
      while (end < rows.length && !entry.test(rows[end]) && !elided.test(rows[end])) end++;
      const lines = rows.slice(start, end);
      yield lines.length > 2
        ? { start, lines, preview: lines[0], hidden: lines.length - 1 }
        : { lines };
    } else yield { lines: rows.slice(start, end) };
    start = end;
  }
}

export function rowLabel(text) {
  return entry.exec(text)?.[1];
}

export function capOf(frame) {
  if (!frame.range) return undefined;
  const total = Number(frame.range[3]);
  if (!Number.isSafeInteger(total)) return undefined;
  return { shown: frame.rows.length, total };
}

export function isSubagentOverlayTarget(options, component) {
  return options?.anchor === "center" && options.width === "70%" && options.minWidth === 52 &&
    typeof component?.scrollBy === "function" && typeof component.render === "function";
}

export function createFolds() {
  return { openAll: false, overrides: new Set(), hit: new Map(), focusId: undefined };
}

export function isOpen(folds, id) {
  return folds.openAll !== folds.overrides.has(id);
}

export function toggleFold(folds, id) {
  if (!folds.overrides.delete(id)) folds.overrides.add(id);
}

export function foldIdsOf(snapshot) {
  return snapshot.blocks.filter((block) => block.start !== undefined).map((block) => block.start);
}

export function cycleFocus(folds, ids) {
  if (ids.length === 0) {
    folds.focusId = undefined;
    return;
  }
  const current = folds.focusId === undefined ? -1 : ids.indexOf(folds.focusId);
  folds.focusId = ids[(current + 1 + ids.length) % ids.length];
}
