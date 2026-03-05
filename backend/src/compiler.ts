import type { FilterExprNode, QueryPlan, SpatialQueryDSL } from "@gis/shared";
import { config } from "./config.js";
import { UserFacingError } from "./errors.js";
import { layerRegistry } from "./layer-registry.js";
import { defaultOutputFields } from "./semantic-routing.js";

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeLikeValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.includes("%")) {
    return trimmed;
  }
  return `%${trimmed}%`;
}

function splitListValues(rawValue: string): string[] {
  const normalizeToken = (token: string): string =>
    token
      .trim()
      .replace(/^[“"'`]+|[”"'`]+$/g, "")
      // Tolerate natural-language tails in collection filters, e.g. "45855中".
      .replace(/(?:之)?中$/g, "")
      .replace(/里$/g, "")
      .replace(/内$/g, "")
      .trim();

  return rawValue
    .trim()
    .replace(/^[（(]\s*/, "")
    .replace(/\s*[）)]$/, "")
    .split(/[，,、]/)
    .map((item) => normalizeToken(item))
    .filter(Boolean);
}

function isStringField(fieldType: string): boolean {
  return fieldType === "esriFieldTypeString";
}

function isNumericField(fieldType: string): boolean {
  return [
    "esriFieldTypeOID",
    "esriFieldTypeInteger",
    "esriFieldTypeSmallInteger",
    "esriFieldTypeDouble",
    "esriFieldTypeSingle"
  ].includes(fieldType);
}

function parseNumericValue(fieldName: string, rawValue: string): number {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new UserFacingError(`字段 ${fieldName} 需要数值类型条件值。`, {
      followUpQuestion: `字段 ${fieldName} 为数值字段，请输入有效数字后重试。`
    });
  }
  return value;
}

function parseNumericRangeValue(fieldName: string, rawValue: string): [number, number] {
  const compact = rawValue.replace(/\s+/g, "");
  const pairs = compact.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const first = pairs[0];
  const second = pairs[1];
  if (first !== undefined && second !== undefined) {
    const min = parseNumericValue(fieldName, first);
    const max = parseNumericValue(fieldName, second);
    return [Math.min(min, max), Math.max(min, max)];
  }
  const matched = compact.match(/(-?\d+(?:\.\d+)?).*(-?\d+(?:\.\d+)?)/);
  if (matched?.[1] && matched[2]) {
    const min = parseNumericValue(fieldName, matched[1]);
    const max = parseNumericValue(fieldName, matched[2]);
    return [Math.min(min, max), Math.max(min, max)];
  }
  throw new UserFacingError(`字段 ${fieldName} 的 between 条件需要两个数值边界。`, {
    followUpQuestion: `请按“${fieldName} 在 20,100 之间”或“${fieldName} 介于20到100之间”重试。`
  });
}

const MAX_FILTER_EXPR_DEPTH = 6;
const MAX_FILTER_EXPR_NODES = 20;

function attributeFiltersToExpr(dsl: SpatialQueryDSL): FilterExprNode | null {
  if (!dsl.attributeFilter.length) {
    return null;
  }
  const children: FilterExprNode[] = dsl.attributeFilter.map((filter) => ({
    kind: "condition",
    field: filter.field,
    operator: filter.operator,
    value: filter.value
  }));
  if (children.length === 1) {
    return children[0];
  }
  return {
    kind: "group",
    logic: "and",
    children
  };
}

function buildWhereConditionClause(
  condition: Extract<FilterExprNode, { kind: "condition" }>,
  fieldTypes: Map<string, string>
): string {
  const rawValue = String(condition.value ?? "").trim();
  const fieldType = fieldTypes.get(condition.field);
  if (!fieldType) {
    throw new UserFacingError(`字段 ${condition.field} 不存在或不可查询。`, {
      followUpQuestion: `字段 ${condition.field} 不存在于目标图层，请改用图层真实字段后重试。`
    });
  }

  if (condition.operator === "is null" || condition.operator === "is not null") {
    return `${condition.field} ${condition.operator.toUpperCase()}`;
  }

  if (!rawValue) {
    throw new UserFacingError(`字段 ${condition.field} 缺少条件值。`, {
      followUpQuestion: `请补充字段 ${condition.field} 的条件值后重试。`
    });
  }

  if (condition.operator === "like" && !isStringField(fieldType)) {
    throw new UserFacingError(`字段 ${condition.field} 不是文本字段，不能使用 LIKE。`);
  }

  if (["<", "<=", ">", ">="].includes(condition.operator)) {
    if (!isNumericField(fieldType)) {
      throw new UserFacingError(`字段 ${condition.field} 不是数值字段，不能使用 ${condition.operator}。`);
    }
    const numericValue = parseNumericValue(condition.field, rawValue);
    return `${condition.field} ${condition.operator} ${numericValue}`;
  }

  if (condition.operator === "between") {
    if (!isNumericField(fieldType)) {
      throw new UserFacingError(`字段 ${condition.field} 不是数值字段，不能使用 BETWEEN。`);
    }
    const [min, max] = parseNumericRangeValue(condition.field, rawValue);
    return `${condition.field} BETWEEN ${min} AND ${max}`;
  }

  if (condition.operator === "in" || condition.operator === "not in") {
    const values = splitListValues(rawValue);
    if (!values.length) {
      throw new UserFacingError(`字段 ${condition.field} 的 ${condition.operator.toUpperCase()} 条件为空。`);
    }
    const sqlValues = isNumericField(fieldType)
      ? values.map((item) => String(parseNumericValue(condition.field, item)))
      : values.map((item) => `'${escapeSql(item)}'`);
    return `${condition.field} ${condition.operator.toUpperCase()} (${sqlValues.join(", ")})`;
  }

  if (condition.operator === "=" || condition.operator === "!=") {
    const sqlOperator = condition.operator === "!=" ? "<>" : "=";
    if (isNumericField(fieldType)) {
      const numericValue = parseNumericValue(condition.field, rawValue);
      return `${condition.field} ${sqlOperator} ${numericValue}`;
    }
    return `${condition.field} ${sqlOperator} '${escapeSql(rawValue)}'`;
  }

  return `${condition.field} LIKE '${escapeSql(normalizeLikeValue(rawValue))}'`;
}

function buildWhereFromExpr(
  expr: FilterExprNode,
  fieldTypes: Map<string, string>,
  depth = 1,
  state = { nodes: 0 }
): string {
  if (depth > MAX_FILTER_EXPR_DEPTH) {
    throw new UserFacingError(`过滤条件嵌套层级过深（>${MAX_FILTER_EXPR_DEPTH}），请简化条件。`);
  }
  state.nodes += 1;
  if (state.nodes > MAX_FILTER_EXPR_NODES) {
    throw new UserFacingError(`过滤条件节点过多（>${MAX_FILTER_EXPR_NODES}），请减少条件数量。`);
  }

  if (expr.kind === "condition") {
    return buildWhereConditionClause(expr, fieldTypes);
  }

  const childClauses = expr.children.map((child) => buildWhereFromExpr(child, fieldTypes, depth + 1, state));
  if (childClauses.length === 0) {
    throw new UserFacingError("过滤条件组不能为空。");
  }
  if (childClauses.length === 1) {
    return childClauses[0];
  }
  const sqlLogic = expr.logic === "or" ? "OR" : "AND";
  return `(${childClauses.join(` ${sqlLogic} `)})`;
}

function buildWhere(dsl: SpatialQueryDSL, fieldTypes: Map<string, string>): string {
  const expr = dsl.filterExpr ?? attributeFiltersToExpr(dsl);
  if (!expr) {
    return "1=1";
  }
  return buildWhereFromExpr(expr, fieldTypes);
}

function relationToSpatialRel(
  relation: NonNullable<NonNullable<SpatialQueryDSL["spatialFilter"]>["relation"]> | undefined
): string {
  switch (relation) {
    case "contains":
      return "esriSpatialRelContains";
    case "within":
      return "esriSpatialRelWithin";
    case "disjoint":
      return "esriSpatialRelDisjoint";
    case "touches":
      return "esriSpatialRelTouches";
    case "overlaps":
      return "esriSpatialRelOverlaps";
    case "intersects":
    default:
      return "esriSpatialRelIntersects";
  }
}

function normalizeOutFields(
  dsl: SpatialQueryDSL,
  allowedFields: Set<string>,
  fallbackFields: string[],
  objectIdField: string,
  options?: { includeObjectId?: boolean }
): string {
  if (fallbackFields.length === 0) {
    throw new UserFacingError("目标图层缺少可输出字段，无法执行查询。");
  }

  const appendObjectIdField = (fields: string[]): string[] => {
    const deduped = Array.from(new Set(fields));
    if (options?.includeObjectId !== false && allowedFields.has(objectIdField) && !deduped.includes(objectIdField)) {
      deduped.push(objectIdField);
    }
    return deduped;
  };

  const requested = dsl.output.fields ?? [];
  if (requested.length === 0) {
    return appendObjectIdField(fallbackFields).join(",");
  }

  for (const field of requested) {
    if (!allowedFields.has(field)) {
      throw new UserFacingError(`输出字段 ${field} 不存在于目标图层。`);
    }
  }

  return appendObjectIdField(requested).join(",");
}

export function compileQueryPlan(dsl: SpatialQueryDSL): QueryPlan {
  const layer = layerRegistry.getLayer(dsl.targetLayer);
  if (!layer || !layer.queryable) {
    throw new UserFacingError(`目标图层 ${dsl.targetLayer} 不存在或不可查询。`, {
      followUpQuestion: "未找到可执行图层，请先在图层管理中确认图层已启用查询。"
    });
  }

  const queryableFields = layer.fields.filter((field) => field.queryable);
  const allowedFieldSet = new Set(queryableFields.map((field) => field.name));
  const fieldTypeMap = new Map(queryableFields.map((field) => [field.name, field.type]));
  const fallbackFields = defaultOutputFields(layer);
  const where = buildWhere(dsl, fieldTypeMap);
  const isDistinct = dsl.aggregation?.type === "distinct";
  const distinctField = dsl.aggregation?.groupBy?.[0];
  if (isDistinct && (!distinctField || !allowedFieldSet.has(distinctField))) {
    throw new UserFacingError("去重查询缺少有效字段。", {
      followUpQuestion: "请明确要去重的字段，例如“列出区县去重值”。"
    });
  }
  const outFields = isDistinct && distinctField
    ? normalizeOutFields(
      {
        ...dsl,
        output: {
          ...dsl.output,
          fields: [distinctField]
        }
      },
      allowedFieldSet,
      fallbackFields,
      layer.objectIdField,
      { includeObjectId: false }
    )
    : normalizeOutFields(dsl, allowedFieldSet, fallbackFields, layer.objectIdField);

  const plan: QueryPlan = {
    layer: layer.url,
    where,
    geometry: null,
    geometryType: null,
    spatialRel: null,
    distance: null,
    units: null,
    outFields,
    returnGeometry: dsl.output.returnGeometry
  };

  const orderByItems =
    dsl.orderBy?.map((item) => ({ field: item.field, direction: item.direction })) ??
    (dsl.sort?.by ? [{ field: dsl.sort.by, direction: dsl.sort.order }] : []);
  if (orderByItems.length > 0) {
    const clauses: string[] = [];
    for (const item of orderByItems) {
      if (!allowedFieldSet.has(item.field)) {
        throw new UserFacingError(`排序字段 ${item.field} 不存在于目标图层。`);
      }
      clauses.push(`${item.field} ${item.direction}`);
    }
    plan.orderByFields = clauses.join(", ");
  }

  if (dsl.intent === "count" || dsl.aggregation?.type === "count") {
    plan.returnCountOnly = true;
    plan.returnGeometry = false;
  }

  if (dsl.intent === "group_stat" || dsl.aggregation?.type === "group_count") {
    const groupField = dsl.aggregation?.groupBy?.[0];
    if (!groupField || !allowedFieldSet.has(groupField)) {
      throw new UserFacingError("分组统计缺少有效 groupBy 字段。");
    }

    plan.returnGeometry = false;
    plan.groupByFieldsForStatistics = groupField;
    plan.outStatistics = JSON.stringify([
      {
        statisticType: "count",
        onStatisticField: layer.objectIdField,
        outStatisticFieldName: "park_count"
      }
    ]);
  }

  if (isDistinct && distinctField) {
    plan.returnGeometry = false;
    plan.returnDistinctValues = true;
    if (!plan.orderByFields) {
      plan.orderByFields = `${distinctField} asc`;
    }
  }

  if (dsl.spatialFilter?.type === "buffer") {
    const center = dsl.spatialFilter.center;
    if (center) {
      const radius = dsl.spatialFilter.radius ?? config.defaultRadiusMeters;
      if (config.maxRadiusMeters > 0 && radius > config.maxRadiusMeters) {
        throw new Error(`查询半径超限，最大允许 ${config.maxRadiusMeters} 米`);
      }

      plan.geometry = {
        x: center.x,
        y: center.y,
        spatialReference: center.spatialReference ?? { wkid: 3857 }
      };
      plan.geometryType = "esriGeometryPoint";
      plan.spatialRel = "esriSpatialRelIntersects";
      plan.distance = radius;
      plan.units = "esriSRUnit_Meter";
    }
  }

  if (dsl.spatialFilter?.type === "relation") {
    const center = dsl.spatialFilter.center;
    if (center) {
      plan.geometry = {
        x: center.x,
        y: center.y,
        spatialReference: center.spatialReference ?? { wkid: 3857 }
      };
      plan.geometryType = "esriGeometryPoint";
      plan.spatialRel = relationToSpatialRel(dsl.spatialFilter.relation);
    }
  }

  return plan;
}
