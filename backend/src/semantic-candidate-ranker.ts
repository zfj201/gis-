import type { FilterExprNode, LayerDescriptor, ParseResponse, SpatialQueryDSL } from "@gis/shared";

export type SemanticCandidateLabel = "model" | "rule" | "repaired_model";

export interface SemanticCandidateInput {
  label: SemanticCandidateLabel;
  parsed: ParseResponse;
}

export interface RankedSemanticCandidate {
  label: SemanticCandidateLabel;
  parsed: ParseResponse;
  score: number;
  reasons: string[];
}

interface FlatCondition {
  field: string;
  operator: SpatialQueryDSL["attributeFilter"][number]["operator"];
  value: string;
}

function flattenExpr(expr: FilterExprNode | undefined): FlatCondition[] {
  if (!expr) {
    return [];
  }
  if (expr.kind === "condition") {
    return [{
      field: expr.field,
      operator: expr.operator,
      value: String(expr.value ?? "")
    }];
  }
  return expr.children.flatMap((child) => flattenExpr(child));
}

function flattenDslConditions(dsl: SpatialQueryDSL): FlatCondition[] {
  const target = dsl.filterExpr
    ? flattenExpr(dsl.filterExpr)
    : dsl.attributeFilter.map((item) => ({
      field: item.field,
      operator: item.operator,
      value: String(item.value ?? "")
    }));
  const source = dsl.spatialFilter?.sourceFilterExpr
    ? flattenExpr(dsl.spatialFilter.sourceFilterExpr)
    : (dsl.spatialFilter?.sourceAttributeFilter ?? []).map((item) => ({
      field: item.field,
      operator: item.operator,
      value: String(item.value ?? "")
    }));
  return [...target, ...source];
}

function isNumericFieldType(fieldType: string): boolean {
  return [
    "esriFieldTypeOID",
    "esriFieldTypeInteger",
    "esriFieldTypeSmallInteger",
    "esriFieldTypeDouble",
    "esriFieldTypeSingle"
  ].includes(fieldType);
}

function scoreFieldLegality(dsl: SpatialQueryDSL, layers: LayerDescriptor[]): { score: number; reason: string } {
  const targetLayer = layers.find((layer) => layer.layerKey === dsl.targetLayer);
  if (!targetLayer) {
    return { score: 0, reason: "目标图层不存在" };
  }
  const targetFields = new Set(targetLayer.fields.filter((field) => field.queryable).map((field) => field.name));
  const sourceLayer = dsl.spatialFilter?.sourceLayer
    ? layers.find((layer) => layer.layerKey === dsl.spatialFilter?.sourceLayer)
    : undefined;
  const sourceFields = new Set(sourceLayer?.fields.filter((field) => field.queryable).map((field) => field.name) ?? []);

  const targetConds = dsl.filterExpr
    ? flattenExpr(dsl.filterExpr)
    : dsl.attributeFilter.map((item) => ({ field: item.field, operator: item.operator, value: item.value }));
  const sourceConds = dsl.spatialFilter?.sourceFilterExpr
    ? flattenExpr(dsl.spatialFilter.sourceFilterExpr)
    : (dsl.spatialFilter?.sourceAttributeFilter ?? []).map((item) => ({ field: item.field, operator: item.operator, value: item.value }));
  const all = [...targetConds.map((item) => ({ ...item, isSource: false })), ...sourceConds.map((item) => ({ ...item, isSource: true }))];
  if (all.length === 0) {
    return { score: 26, reason: "无字段过滤，字段合法性默认高" };
  }
  let valid = 0;
  for (const item of all) {
    const ok = item.isSource ? sourceFields.has(item.field) : targetFields.has(item.field);
    if (ok) {
      valid += 1;
    }
  }
  const ratio = valid / all.length;
  return {
    score: Math.round(30 * ratio),
    reason: `字段合法 ${valid}/${all.length}`
  };
}

function scoreTypeAndOperator(dsl: SpatialQueryDSL, layers: LayerDescriptor[]): { score: number; reason: string } {
  const byLayer = new Map<string, Map<string, string>>();
  for (const layer of layers) {
    byLayer.set(layer.layerKey, new Map(layer.fields.map((field) => [field.name, field.type])));
  }

  const targetKey = dsl.targetLayer;
  const sourceKey = dsl.spatialFilter?.sourceLayer;
  const targetConds = dsl.filterExpr
    ? flattenExpr(dsl.filterExpr)
    : dsl.attributeFilter.map((item) => ({ field: item.field, operator: item.operator, value: item.value }));
  const sourceConds = dsl.spatialFilter?.sourceFilterExpr
    ? flattenExpr(dsl.spatialFilter.sourceFilterExpr)
    : (dsl.spatialFilter?.sourceAttributeFilter ?? []).map((item) => ({ field: item.field, operator: item.operator, value: item.value }));

  const all = [...targetConds.map((item) => ({ ...item, layerKey: targetKey })), ...sourceConds.map((item) => ({ ...item, layerKey: sourceKey ?? "" }))];
  if (all.length === 0) {
    return { score: 16, reason: "无类型约束条件，类型匹配默认高" };
  }

  let valid = 0;
  for (const cond of all) {
    const type = byLayer.get(cond.layerKey)?.get(cond.field);
    if (!type) {
      continue;
    }
    const numeric = isNumericFieldType(type);
    if (["<", "<=", ">", ">=", "between"].includes(cond.operator)) {
      if (numeric) {
        valid += 1;
      }
      continue;
    }
    if (cond.operator === "like") {
      if (!numeric) {
        valid += 1;
      }
      continue;
    }
    if (cond.operator === "in" || cond.operator === "not in") {
      valid += 1;
      continue;
    }
    valid += 1;
  }
  const ratio = valid / all.length;
  return {
    score: Math.round(20 * ratio),
    reason: `类型操作符匹配 ${valid}/${all.length}`
  };
}

function scoreValueShape(dsl: SpatialQueryDSL, layers: LayerDescriptor[]): { score: number; reason: string } {
  const fieldTypeMap = new Map<string, string>();
  for (const layer of layers) {
    for (const field of layer.fields) {
      fieldTypeMap.set(`${layer.layerKey}:${field.name}`, field.type);
    }
  }
  const conditions = flattenDslConditions(dsl);
  if (conditions.length === 0) {
    return { score: 18, reason: "无值条件，值形态默认高" };
  }

  let valid = 0;
  for (const cond of conditions) {
    const targetType = fieldTypeMap.get(`${dsl.targetLayer}:${cond.field}`);
    const sourceType = dsl.spatialFilter?.sourceLayer
      ? fieldTypeMap.get(`${dsl.spatialFilter.sourceLayer}:${cond.field}`)
      : undefined;
    const type = targetType ?? sourceType ?? "";
    if (!isNumericFieldType(type)) {
      valid += 1;
      continue;
    }
    if (cond.operator === "in" || cond.operator === "not in") {
      const items = cond.value
        .split(/[，,、]/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length > 0 && items.every((item) => Number.isFinite(Number(item)))) {
        valid += 1;
      }
      continue;
    }
    if (cond.operator === "between") {
      const nums = cond.value.match(/-?\d+(?:\.\d+)?/g) ?? [];
      if (nums.length >= 2) {
        valid += 1;
      }
      continue;
    }
    if (cond.operator === "is null" || cond.operator === "is not null") {
      valid += 1;
      continue;
    }
    if (Number.isFinite(Number(cond.value))) {
      valid += 1;
    }
  }
  const ratio = valid / conditions.length;
  return {
    score: Math.round(20 * ratio),
    reason: `值形态匹配 ${valid}/${conditions.length}`
  };
}

function exprContainsOr(expr: FilterExprNode | undefined): boolean {
  if (!expr) {
    return false;
  }
  if (expr.kind === "group") {
    if (expr.logic === "or") {
      return true;
    }
    return expr.children.some((child) => exprContainsOr(child));
  }
  return false;
}

function scoreSemanticCoverage(question: string, dsl: SpatialQueryDSL): { score: number; reason: string } {
  let score = 8;
  const reasons: string[] = [];
  if (/(或|或者)/.test(question)) {
    if (exprContainsOr(dsl.filterExpr) || exprContainsOr(dsl.spatialFilter?.sourceFilterExpr)) {
      score += 4;
      reasons.push("OR 语义保留");
    } else {
      score -= 5;
      reasons.push("缺少 OR 语义");
    }
  }
  if (/(最近|nearest)/i.test(question)) {
    if (dsl.intent === "nearest") {
      score += 4;
      reasons.push("最近邻语义匹配");
    } else {
      score -= 4;
    }
  }
  if (/(附近|周边|米内|公里内|千米内)/.test(question)) {
    if (dsl.intent === "buffer_search" || dsl.intent === "nearest") {
      score += 4;
      reasons.push("距离语义匹配");
    } else {
      score -= 3;
    }
  }
  if (/(相交|相离|接触|重叠|包含|被包含)/.test(question)) {
    if (dsl.spatialFilter?.type === "relation") {
      score += 4;
      reasons.push("关系语义匹配");
    } else {
      score -= 4;
    }
  }
  if (/(多少|几个|数量|总数)/.test(question)) {
    if (dsl.intent === "count" || dsl.intent === "group_stat" || dsl.aggregation?.type === "count" || dsl.aggregation?.type === "group_count") {
      score += 4;
      reasons.push("统计语义匹配");
    } else {
      score -= 4;
    }
  }
  return {
    score: Math.max(0, Math.min(20, score)),
    reason: reasons.join("，") || "基础语义匹配"
  };
}

function scoreLayerConsistency(question: string, dsl: SpatialQueryDSL, layers: LayerDescriptor[]): { score: number; reason: string } {
  const targetLayer = layers.find((layer) => layer.layerKey === dsl.targetLayer);
  if (!targetLayer) {
    return { score: 0, reason: "目标图层未命中" };
  }
  const questionText = question.toLowerCase().replace(/\s+/g, "");
  const candidates = [targetLayer.name, ...targetLayer.aliases, ...(targetLayer.semanticProfile?.tokens ?? [])]
    .map((item) => item.toLowerCase().replace(/\s+/g, ""))
    .filter((item) => item.length >= 2);
  const hit = candidates.some((token) => questionText.includes(token));
  return {
    score: hit ? 10 : 6,
    reason: hit ? "图层匹配命中" : "图层匹配弱命中"
  };
}

export function rankSemanticCandidates(
  question: string,
  candidates: SemanticCandidateInput[],
  layers: LayerDescriptor[]
): RankedSemanticCandidate[] {
  const ranked: RankedSemanticCandidate[] = [];
  for (const candidate of candidates) {
    const dsl = candidate.parsed.dsl;
    const fieldLegality = scoreFieldLegality(dsl, layers);
    const typeOperator = scoreTypeAndOperator(dsl, layers);
    const valueShape = scoreValueShape(dsl, layers);
    const semanticCoverage = scoreSemanticCoverage(question, dsl);
    const layerConsistency = scoreLayerConsistency(question, dsl, layers);
    const score = Math.max(
      0,
      Math.min(
        100,
        fieldLegality.score +
          typeOperator.score +
          valueShape.score +
          semanticCoverage.score +
          layerConsistency.score
      )
    );
    ranked.push({
      ...candidate,
      score,
      reasons: [
        `字段合法性:${fieldLegality.score}(${fieldLegality.reason})`,
        `类型匹配:${typeOperator.score}(${typeOperator.reason})`,
        `值形态:${valueShape.score}(${valueShape.reason})`,
        `语义覆盖:${semanticCoverage.score}(${semanticCoverage.reason})`,
        `图层一致:${layerConsistency.score}(${layerConsistency.reason})`
      ]
    });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

