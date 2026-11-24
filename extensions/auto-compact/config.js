export function preview(settings, model, window) {
  // Senpi 2026.11.19-5: the adaptive threshold and the reserve limit are separate.
  const baseline = window <= 16_000 ? 45 : window <= 32_000 ? 50 : window <= 64_000 ? 55
    : window <= 128_000 ? 60 : window <= 512_000 ? 70 : 80;
  const override = settings.modelOverrides?.[model]?.reserveTokens;
  const valid = (value) => Number.isSafeInteger(value) && value > 0;
  const configured = valid(override) ? override : valid(settings.reserveTokens) ? settings.reserveTokens : 16_384;
  const reserve = settings.reserveScalingEnabled === false ? configured
    : Math.max(configured, Math.min(Math.floor(window * 0.04), 49_152));
  const limit = Math.max(0, window - reserve);
  const trigger = settings.enabled === false ? limit : Math.min(limit, Math.floor(window * baseline / 100));
  return { baseline, override, reserve, limit, trigger };
}

export function setLimit(settings, model, window, percent) {
  if (!Number.isSafeInteger(window) || window <= 0) throw new RangeError("模型窗口未知。");
  const original = settings.compaction ?? {};
  const modelOverrides = { ...original.modelOverrides };
  const entry = { ...modelOverrides[model] };
  if (percent === undefined) {
    if (!Object.hasOwn(entry, "reserveTokens")) return settings;
    delete entry.reserveTokens;
  } else {
    const max = preview(original, model, window).baseline;
    if (!Number.isInteger(percent) || percent < 40 || percent > max) {
      throw new RangeError(`输入 40 至 ${max} 的整数百分比。`);
    }
    entry.reserveTokens = window - Math.floor(window * percent / 100);
  }
  if (Object.keys(entry).length) modelOverrides[model] = entry;
  else delete modelOverrides[model];
  const compaction = { ...original };
  if (Object.keys(modelOverrides).length) compaction.modelOverrides = modelOverrides;
  else delete compaction.modelOverrides;
  const updated = { ...settings };
  if (Object.keys(compaction).length) updated.compaction = compaction;
  else delete updated.compaction;
  return updated;
}
