import { stripVTControlCharacters } from "node:util";

const agentLimit = 8;
const osc8 = "\x1b]8;;";
// The native row wrapper emits a BEL-terminated OSC 8 link around the whole row.
const agentLink = /^\x1b\]8;;(omo-panel:agent\/(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+)\x07(.*?)\x1b\]8;;\x07$/u;
export const backgroundUrl = "omo-sidebar-density:background/current";

export function nativeAgentActions(rows) {
  const actions = [];
  for (const row of rows) {
    const link = agentLink.exec(row);
    if (link) actions.push({ url: link[1], label: stripVTControlCharacters(link[2]).trim() });
  }
  return actions;
}

export function isAgentHeading(row) {
  return /^AGENTS(?:\s|…|$)/u.test(stripVTControlCharacters(row));
}

export function isAgentRow(row) {
  if (row.startsWith(osc8)) return row.startsWith(`${osc8}omo-panel:agent/`);
  // Native status glyphs identify unlinked rows when panel clickability is off.
  return /^[◦●‖✓✗-](?:\s|…|$)/u.test(stripVTControlCharacters(row));
}

export function compactTools(rows, paint) {
  for (const [index, row] of rows.entries()) {
    const match = /^TOOLS {2}(\d+)(?: · \+(\d+) earlier)?\s*$/u.exec(stripVTControlCharacters(row));
    if (!match) continue;
    const total = Number(match[1]);
    const shown = total - Number(match[2] ?? 0);
    if (shown <= 4 || shown > 6 || index + shown >= rows.length) return rows;
    return [
      ...rows.slice(0, index),
      paint(`TOOLS  ${total} · +${total - 4} earlier`),
      ...rows.slice(index + 1 + shown - 4),
    ];
  }
  return rows;
}

export function renderPanelRows(rows, { width, background, paint, todo = [] }) {
  const base = compactTools(rows, paint);
  const heading = base.findIndex(isAgentHeading);
  const prefix = [`${osc8}${backgroundUrl}\x07${paint(background)}${osc8}\x07`, "", ...todo];
  if (heading < 0) return [...prefix, ...base];

  let end = heading + 1;
  while (end < base.length && isAgentRow(base[end])) end++;
  const total = end - heading - 1;
  if (total <= agentLimit) return [...prefix, ...base];

  const active = [];
  const terminal = [];
  for (const row of base.slice(heading + 1, end)) {
    const group = /^[●◦‖]/u.test(stripVTControlCharacters(row)) ? active : terminal;
    group.push(row);
  }
  const shown = active.slice(0, agentLimit);
  // Native rows are ordered by startedAt; take the newest terminal rows without reversing them.
  if (shown.length < agentLimit) shown.push(...terminal.slice(-(agentLimit - shown.length)));

  const count = `AGENTS  ${total}`;
  const compact = `${count} +${total - agentLimit}`;
  const label = [`${count} · +${total - agentLimit} more`, compact, count]
    .find((candidate) => candidate.length <= width);
  return [
    ...prefix, ...base.slice(0, heading), label ? paint(label) : base[heading],
    ...shown, ...base.slice(end),
  ];
}
