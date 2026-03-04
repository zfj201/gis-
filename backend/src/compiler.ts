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
  const fieldType = fieldTypes.get(condition.field);
  if (!fieldType) {
    throw new UserFacingError(`字段 ${condition.field} 不存在或不可查询。`, {
      followUpQuestion: `字段 ${condition.field} 不存在于目标图层，请改用图层真实字段后重试。`
    });
  }

  if (condition.operator === "like" && !isStringField(fieldType)) {
    throw new UserFacingError(`字段 ${condition.field} 不是文本字段，不能使用 LIKE。`);
  }

  if (["<", "<=", ">", ">="].includes(condition.operator)) {
    if (!isNumericField(fieldType)) {
      throw new UserFacingError(`字段 ${condition.field} 不是数值字段，不能使用 ${condition.operator}。`);
    }
    const numericValue = parseNumericValue(condition.field, condition.value);
    return `${condition.field} ${condition.operator} ${numericValue}`;
  }

  if (condition.operator === "=") {
    if (isNumericField(fieldType)) {
      const numericValue = parseNumericValue(condition.field, condition.value);
      return `${condition.field} = ${numericValue}`;
    }
    return `${condition.field} = '${escapeSql(condition.value)}'`;
  }

  return `${condition.field} LIKE '${escapeSql(normalizeLikeValue(condition.value))}'`;
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

function normalizeOutFields(
  dsl: SpatialQueryDSL,
  allowedFields: Set<string>,
  fallbackFields: string[],
  objectIdField: string
): string {
  if (fallbackFields.length === 0) {
    throw new UserFacingError("目标图层缺少可输出字段，无法执行查询。");
  }

  const appendObjectIdField = (fields: string[]): string[] => {
    const deduped = Array.from(new Set(fields));
    if (allowedFields.has(objectIdField) && !deduped.includes(objectIdField)) {
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
  const outFields = normalizeOutFields(dsl, allowedFieldSet, fallbackFields, layer.objectIdField);

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

  if (dsl.sort?.by) {
    if (!allowedFieldSet.has(dsl.sort.by)) {
      throw new UserFacingError(`排序字段 ${dsl.sort.by} 不存在于目标图层。`);
    }
    plan.orderByFields = `${dsl.sort.by} ${dsl.sort.order}`;
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

  return plan;
}
