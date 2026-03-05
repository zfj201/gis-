import type { SpatialQueryDSL } from "@gis/shared";

function pickFeatureLabel(attributes: Record<string, unknown> | undefined): string {
  if (!attributes) {
    return "未命名要素";
  }

  const preferredKeys = [
    "名称",
    "标准名称",
    "门牌号码",
    "标准地址",
    "道路街巷",
    "地址",
    "区县"
  ];

  for (const key of preferredKeys) {
    const value = attributes[key];
    if (value !== null && value !== undefined) {
      const text = String(value).trim();
      if (text) {
        return text;
      }
    }
  }

  for (const value of Object.values(attributes)) {
    if (value === null || value === undefined) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      return text;
    }
  }

  return "未命名要素";
}

export function summarizeResult(
  dsl: SpatialQueryDSL,
  payload: Record<string, unknown>,
  layerName = "要素"
): string {
  if (dsl.intent === "count" || dsl.aggregation?.type === "count") {
    const count = Number(payload.count ?? 0);
    return `共检索到 ${count} 个${layerName}。`;
  }

  if (dsl.intent === "group_stat" || dsl.aggregation?.type === "group_count") {
    const groupField = dsl.aggregation?.groupBy?.[0] ?? "分组字段";
    const features = ((payload.features as Array<{ attributes?: Record<string, unknown> }>) ?? []).slice(0, 6);
    if (features.length === 0) {
      return "未检索到分组统计结果。";
    }

    const parts = features.map((item) => {
      const district = String(item.attributes?.[groupField] ?? `未知${groupField}`);
      const count = Number(item.attributes?.park_count ?? 0);
      return `${district} ${count} 个`;
    });

    return `按${groupField}统计：${parts.join("，")}。`;
  }

  if (dsl.aggregation?.type === "distinct") {
    const distinctField = dsl.aggregation.groupBy?.[0] ?? "字段";
    const features = (payload.features as Array<{ attributes?: Record<string, unknown> }>) ?? [];
    if (features.length === 0) {
      return `未检索到${layerName}的${distinctField}去重值。`;
    }
    const values = features
      .map((item) => item.attributes?.[distinctField])
      .filter((item) => item !== undefined && item !== null)
      .map((item) => String(item).trim())
      .filter(Boolean);
    const uniqueValues = Array.from(new Set(values));
    const preview = uniqueValues.slice(0, 6);
    return `共检索到 ${uniqueValues.length} 个${distinctField}去重值，示例：${preview.join("、")}。`;
  }

  if (dsl.intent === "nearest") {
    const features = (payload.features as Array<{ attributes?: Record<string, unknown> }>) ?? [];
    if (features.length === 0) {
      return `未检索到符合条件的${layerName}。`;
    }
    const nearest = features[0];
    const nearestLabel = pickFeatureLabel(nearest.attributes);
    const nearestDistance = Number(nearest.attributes?._nearest_distance_m ?? NaN);
    const distanceText = Number.isFinite(nearestDistance) ? `，最近距离约 ${nearestDistance.toFixed(2)} 米` : "";
    return `共检索到 ${features.length} 个${layerName}${distanceText}，最近要素：${nearestLabel}。`;
  }

  const features = (payload.features as Array<{ attributes?: Record<string, unknown> }>) ?? [];
  if (features.length === 0) {
    return `未检索到符合条件的${layerName}。`;
  }

  const names = features
    .slice(0, 5)
    .map((feature) => pickFeatureLabel(feature.attributes));

  return `共检索到 ${features.length} 个${layerName}，示例：${names.join("、")}。`;
}
