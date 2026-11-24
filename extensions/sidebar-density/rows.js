import { stripVTControlCharacters } from "node:util";

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
