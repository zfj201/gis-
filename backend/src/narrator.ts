import type { SpatialQueryDSL } from "@gis/shared";

export function summarizeResult(
  dsl: SpatialQueryDSL,
  payload: Record<string, unknown>
): string {
  if (dsl.intent === "count" || dsl.aggregation?.type === "count") {
    const count = Number(payload.count ?? 0);
    return `共检索到 ${count} 个公园。`;
  }

  if (dsl.intent === "group_stat" || dsl.aggregation?.type === "group_count") {
    const features = ((payload.features as Array<{ attributes?: Record<string, unknown> }>) ?? []).slice(0, 6);
    if (features.length === 0) {
      return "未检索到分组统计结果。";
    }

    const parts = features.map((item) => {
      const district = String(item.attributes?.区县 ?? "未知区县");
      const count = Number(item.attributes?.park_count ?? 0);
      return `${district} ${count} 个`;
    });

    return `按区县统计：${parts.join("，")}。`;
  }

  const features = (payload.features as Array<{ attributes?: Record<string, unknown> }>) ?? [];
  if (features.length === 0) {
    return "未检索到符合条件的公园。";
  }

  const names = features
    .slice(0, 5)
    .map((feature) => String(feature.attributes?.名称 ?? "未命名公园"));

  return `共检索到 ${features.length} 个公园，示例：${names.join("、")}。`;
}
