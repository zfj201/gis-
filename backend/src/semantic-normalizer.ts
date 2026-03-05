import type { FilterExprNode, SpatialQueryDSL } from "@gis/shared";
import type { LayerDescriptor } from "@gis/shared";
import { UserFacingError } from "./errors.js";
import { layerRegistry } from "./layer-registry.js";

type FilterOperator = SpatialQueryDSL["attributeFilter"][number]["operator"];

const exactOperatorPattern = /(为|等于|就是|是|:|：)/;
const fuzzyOperatorPattern = /(包含|含有|相关|类似)/;
const greaterThanEqualPattern = /(大于等于|不少于|至少)/;
const greaterThanPattern = /(大于|高于|多于|以上|超过)/;
const lessThanEqualPattern = /(小于等于|不超过|至多)/;
const lessThanPattern = /(小于|低于|少于|以下)/;
const questionTailPattern =
  /(有多少个|有几个|多少个|几个|数量|总数|是多少|有哪些|有什么|都有哪些|都有什么|列表|清单|名录)$/;
const punctuationEndPattern = /[。！？!?，,\s]+$/g;
const valueNoiseSuffixPatterns = [
  /的道路街巷$/,
  /的门牌号码$/,
  /的公园$/,
  /的公园列表$/,
  /的公园清单$/,
  /的公园名录$/,
  /的房屋建筑$/,
  /的单元楼$/,
  /的宗地院落$/,
  /的有哪些$/,
  /的有什么$/,
  /有哪些$/,
  /有什么$/,
  /列表$/,
  /清单$/,
  /名录$/,
  /前[0-9一二三四五六七八九十百千万两]+(?:个|条|项)?$/
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimWrappingQuotes(value: string): string {
  return value.replace(/^[“"']+|[”"']+$/g, "");
}

function cleanValue(value: string): string {
  let next = trimWrappingQuotes(value)
    .replace(/[“”"']/g, "")
    .replace(punctuationEndPattern, "")
    .replace(questionTailPattern, "")
    .replace(punctuationEndPattern, "")
    .trim();
  next = next.replace(/前[0-9一二三四五六七八九十百千万两]+(?:个|条|项)?$/g, "").trim();
  next = next.replace(/^的+/, "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of valueNoiseSuffixPatterns) {
      const updated = next.replace(pattern, "").trim();
      if (updated !== next) {
        next = updated;
        changed = true;
      }
    }
  }
  next = next.replace(/[的]+$/g, "").trim();
  return next;
}

function cleanCollectionValue(value: string): string {
  let next = cleanValue(value);
  // Handle Chinese postpositions that are often attached to IN/NOT IN tails, e.g. "45854、45855中".
  next = next
    .replace(/(?:之)?中$/g, "")
    .replace(/里$/g, "")
    .replace(/内$/g, "")
    .trim();
  return next;
}

function buildFieldLookup(layer: LayerDescriptor): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const field of layer.fields.filter((item) => item.queryable)) {
    lookup.set(field.name.toLowerCase(), field.name);
    lookup.set(field.alias.toLowerCase(), field.name);
  }

  const fieldNames = new Set(layer.fields.map((item) => item.name.toLowerCase()));
  const addSynonym = (synonyms: string[], fieldName: string): void => {
    if (!fieldNames.has(fieldName.toLowerCase())) {
      return;
    }
    for (const key of synonyms) {
      lookup.set(key.toLowerCase(), fieldName);
    }
  };

  addSynonym(["面积", "占地面积", "面積", "area"], "SHAPE__Area");
  addSynonym(["长度", "周长", "边长", "length"], "SHAPE__Length");
  addSynonym(["objectid", "编号", "id"], "objectid");

  return lookup;
}

function resolveFieldName(rawField: string, layer: LayerDescriptor): string | null {
  const lookup = buildFieldLookup(layer);
  return lookup.get(rawField.trim().toLowerCase()) ?? null;
}

function parseOperatorToken(rawOperator: string): FilterOperator {
  const value = rawOperator.trim();
  if (!value) {
    return "=";
  }
  if (/(不为空|非空|is\s*not\s*null)/i.test(value)) {
    return "is not null";
  }
  if (/(为空|是空|is\s*null|null)/i.test(value)) {
    return "is null";
  }
  if (/(不等于|不为|不是|!=|<>)/i.test(value)) {
    return "!=";
  }
  if (/(not\s*in|不在|不属于)/i.test(value)) {
    return "not in";
  }
  if (/(between|介于|之间)/i.test(value)) {
    return "between";
  }
  if (/(?:\bin\b|属于)/i.test(value)) {
    return "in";
  }

  if (greaterThanEqualPattern.test(value) || value === ">=") {
    return ">=";
  }
  if (lessThanEqualPattern.test(value) || value === "<=") {
    return "<=";
  }
  if (greaterThanPattern.test(value) || value === ">") {
    return ">";
  }
  if (lessThanPattern.test(value) || value === "<") {
    return "<";
  }
  if (fuzzyOperatorPattern.test(value) || /like/i.test(value)) {
    return "like";
  }
  return "=";
}

function extractFieldCondition(
  question: string,
  layer: LayerDescriptor
): { field: string; operator: FilterOperator; value: string } | null {
  const queryableFields = layer.fields
    .filter((field) => field.queryable)
    .map((field) => field.name)
    .sort((a, b) => b.length - a.length);

  const lexicalFields = [
    ...queryableFields,
    "面积",
    "占地面积",
    "面積",
    "area",
    "长度",
    "周长",
    "边长",
    "length",
    "OBJECTID",
    "objectid",
    "编号",
    "id"
  ].sort((a, b) => b.length - a.length);

  const operatorAlternatives = [
    "不为空",
    "非空",
    "is not null",
    "为空",
    "是空",
    "is null",
    "不等于",
    "不为",
    "不是",
    "!=",
    "<>",
    "not in",
    "不在",
    "不属于",
    "between",
    "介于",
    "小于等于",
    "不超过",
    "至多",
    "大于等于",
    "不少于",
    "至少",
    "小于",
    "低于",
    "少于",
    "以下",
    "大于",
    "高于",
    "多于",
    "以上",
    "超过",
    "包含",
    "含有",
    "相关",
    "类似",
    "为",
    "等于",
    "就是",
    "是",
    ">=",
    "<=",
    ">",
    "<",
    "：",
    ":"
  ];

  for (const fieldToken of lexicalFields) {
    const escapedField = escapeRegex(fieldToken);
    const nullPattern = new RegExp(
      `${escapedField}\\s*(?:的)?\\s*(不为空|非空|is\\s*not\\s*null|为空|是空|is\\s*null)`,
      "i"
    );
    const nullMatch = question.match(nullPattern);
    if (nullMatch?.[1]) {
      const field = resolveFieldName(fieldToken, layer);
      if (!field) {
        continue;
      }
      return {
        field,
        operator: parseOperatorToken(nullMatch[1]),
        value: ""
      };
    }

    const operatorPart = operatorAlternatives.map((item) => escapeRegex(item)).join("|");
    const explicitPattern = new RegExp(
      `${escapedField}\\s*(?:的)?\\s*(${operatorPart})\\s*[“"']?([^，。！？!?]+)`,
      "i"
    );
    const explicitMatch = question.match(explicitPattern);
    if (explicitMatch?.[1] && explicitMatch[2]) {
      const field = resolveFieldName(fieldToken, layer);
      if (!field) {
        continue;
      }

      const operator = parseOperatorToken(explicitMatch[1]);
      const value = operator === "in" || operator === "not in"
        ? cleanCollectionValue(explicitMatch[2])
        : cleanValue(explicitMatch[2]);
      if (!value) {
        continue;
      }

      return {
        field,
        operator,
        value
      };
    }
  }

  return null;
}

type FlatFilter = SpatialQueryDSL["attributeFilter"][number];

function conditionToExpr(filter: FlatFilter): FilterExprNode {
  return {
    kind: "condition",
    field: filter.field,
    operator: filter.operator,
    value: filter.value
  };
}

function attributeFiltersToExpr(filters: SpatialQueryDSL["attributeFilter"]): FilterExprNode | null {
  if (filters.length === 0) {
    return null;
  }
  const children = filters.map((filter) => conditionToExpr(filter));
  if (children.length === 1) {
    return children[0];
  }
  return {
    kind: "group",
    logic: "and",
    children
  };
}

function flattenExprToAndFilters(expr: FilterExprNode | undefined): SpatialQueryDSL["attributeFilter"] {
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
  if (expr.logic !== "and") {
    return [];
  }
  const values: SpatialQueryDSL["attributeFilter"] = [];
  for (const child of expr.children) {
    if (child.kind !== "condition") {
      return [];
    }
    values.push({
      field: child.field,
      operator: child.operator,
      value: String(child.value ?? "")
    });
  }
  return values;
}

function normalizeExprNode(
  expr: FilterExprNode,
  layer: LayerDescriptor,
  allowedFields: Set<string>,
  options?: { dropXYFields?: boolean }
): FilterExprNode | null {
  if (expr.kind === "condition") {
    const resolvedField = resolveFieldName(expr.field, layer) ?? expr.field;
    if (!allowedFields.has(resolvedField)) {
      throw new UserFacingError(`字段 ${expr.field} 不存在于目标图层 ${layer.name}。`, {
        followUpQuestion: `字段 ${expr.field} 不存在于图层“${layer.name}”，请换一个字段名称后重试。`
      });
    }
    if (options?.dropXYFields && /^(x|y)$/i.test(resolvedField)) {
      return null;
    }
    const cleanedValue = cleanValue(String(expr.value ?? ""));
    if (expr.operator === "is null" || expr.operator === "is not null") {
      return {
        ...expr,
        field: resolvedField,
        value: ""
      };
    }
    if (expr.operator === "in" || expr.operator === "not in") {
      const normalizedCollection = cleanCollectionValue(String(expr.value ?? ""));
      if (!normalizedCollection) {
        return null;
      }
      return {
        ...expr,
        field: resolvedField,
        value: normalizedCollection
      };
    }
    if (!cleanedValue) {
      return null;
    }
    if (expr.operator === "like") {
      const normalizedLike = normalizeLikeValue(cleanedValue);
      if (!normalizedLike) {
        return null;
      }
      return {
        ...expr,
        field: resolvedField,
        value: normalizedLike
      };
    }
    return {
      ...expr,
      field: resolvedField,
      value: cleanedValue
    };
  }

  const children = expr.children
    .map((child) => normalizeExprNode(child, layer, allowedFields, options))
    .filter((item): item is FilterExprNode => Boolean(item));
  if (children.length === 0) {
    return null;
  }
  if (children.length === 1) {
    return children[0];
  }
  return {
    kind: "group",
    logic: expr.logic,
    children
  };
}

function shouldDropCountTailCondition(
  condition: Extract<FilterExprNode, { kind: "condition" }>,
  normalizedQuestion: string,
  nameLikeFields: Set<string>
): boolean {
  if (!nameLikeFields.has(condition.field)) {
    return false;
  }
  const normalizedValue = String(condition.value ?? "").replace(/%/g, "").replace(/\s+/g, "");
  if (!normalizedValue) {
    return true;
  }
  if (/(有多少个|有几个|多少个|几个|数量|总数)/.test(normalizedValue)) {
    return true;
  }
  if (normalizedQuestion.endsWith(normalizedValue) && /(有多少个|有几个|多少|几个)/.test(normalizedQuestion)) {
    return true;
  }
  return false;
}

function removeWeakQuestionTailExpr(
  expr: FilterExprNode | undefined,
  question: string,
  nameLikeFields: Set<string>
): FilterExprNode | undefined {
  if (!expr) {
    return expr;
  }
  const normalizedQuestion = question.replace(/\s+/g, "");

  const walk = (node: FilterExprNode): FilterExprNode | null => {
    if (node.kind === "condition") {
      if (shouldDropCountTailCondition(node, normalizedQuestion, nameLikeFields)) {
        return null;
      }
      return node;
    }
    const children = node.children.map((child) => walk(child)).filter((item): item is FilterExprNode => Boolean(item));
    if (children.length === 0) {
      return null;
    }
    if (children.length === 1) {
      return children[0];
    }
    return {
      ...node,
      children
    };
  };

  return walk(expr) ?? undefined;
}

function removeWeakQuestionTailFilters(
  dsl: SpatialQueryDSL,
  question: string,
  nameLikeFields: Set<string>
): SpatialQueryDSL {
  const isCountLike = dsl.intent === "count" || dsl.intent === "group_stat" || dsl.aggregation?.type === "count";
  if (!isCountLike) {
    return dsl;
  }

  const normalizedQuestion = question.replace(/\s+/g, "");
  const nextFilters = dsl.attributeFilter.filter((filter) => {
    if (!nameLikeFields.has(filter.field)) {
      return true;
    }
    const normalizedValue = String(filter.value ?? "").replace(/%/g, "").replace(/\s+/g, "");
    if (!normalizedValue) {
      return false;
    }

    if (/(有多少个|有几个|多少个|几个|数量|总数)/.test(normalizedValue)) {
      return false;
    }

    if (normalizedQuestion.endsWith(normalizedValue) && /(有多少个|有几个|多少|几个)/.test(normalizedQuestion)) {
      return false;
    }

    return true;
  });

  return {
    ...dsl,
    attributeFilter: nextFilters
  };
}

function normalizeLikeValue(value: string): string {
  const cleaned = cleanValue(value);
  if (!cleaned) {
    return "";
  }
  if (cleaned.includes("%")) {
    return cleaned;
  }
  return `%${cleaned}%`;
}

function hasCoordinateHint(question: string): boolean {
  return (
    /-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?/.test(question) ||
    /x\s*[:：]\s*-?\d+(?:\.\d+)?\s*[，,\s]+y\s*[:：]\s*-?\d+(?:\.\d+)?/i.test(question)
  );
}

function extractNearestTargetPart(question: string): string | null {
  const match = question.trim().match(/(.+?)\s*(?:最近的?|nearest)\s*(.+)/i);
  if (!match?.[2]) {
    return null;
  }
  return match[2].trim();
}

function normalizeNearestFiltersByQuestion(
  question: string,
  dsl: SpatialQueryDSL,
  layer: LayerDescriptor
): SpatialQueryDSL {
  if (dsl.intent !== "nearest") {
    return dsl;
  }

  const targetPart = extractNearestTargetPart(question) ?? question;
  const explicitTarget = extractFieldCondition(targetPart, layer);

  const filters = explicitTarget
    ? [
        {
          field: explicitTarget.field,
          operator: explicitTarget.operator,
          value: explicitTarget.value
        }
      ]
    : [];

  return {
    ...dsl,
    filterExpr: filters.length > 0 ? conditionToExpr(filters[0]) : undefined,
    attributeFilter: filters
  };
}

function applyOperatorHint(
  question: string,
  dsl: SpatialQueryDSL,
  layer: LayerDescriptor
): SpatialQueryDSL {
  const explicit = extractFieldCondition(question, layer);
  if (!explicit) {
    return dsl;
  }

  const withoutSameField = dsl.attributeFilter.filter((item) => item.field !== explicit.field);
  const nextFilters: SpatialQueryDSL["attributeFilter"] = [
    ...withoutSameField,
    {
      field: explicit.field,
      operator: explicit.operator,
      value: explicit.value
    }
  ];
  const nextExpr = attributeFiltersToExpr(nextFilters);
  return {
    ...dsl,
    filterExpr: nextExpr ?? undefined,
    attributeFilter: nextFilters
  };
}

function shouldForceExplicitOperator(operator: FilterOperator): boolean {
  return ["!=", "in", "not in", "between", "is null", "is not null"].includes(operator);
}

function canReplaceWithExplicitCondition(
  dsl: SpatialQueryDSL,
  explicit: { field: string; operator: FilterOperator; value: string } | null
): boolean {
  if (!explicit) {
    return false;
  }
  if (!dsl.filterExpr) {
    return true;
  }
  const flattened = flattenExprToAndFilters(dsl.filterExpr);
  if (flattened.length === 0) {
    return false;
  }
  return flattened.every((item) => item.field === explicit.field);
}

function normalizeFilterValues(
  dsl: SpatialQueryDSL,
  question: string,
  layer: LayerDescriptor
): SpatialQueryDSL {
  const nearestSafeDsl = normalizeNearestFiltersByQuestion(question, dsl, layer);
  const allowedFields = new Set(layer.fields.filter((field) => field.queryable).map((field) => field.name));
  const nameLikeFields = new Set(
    layer.fields
      .filter((field) => field.queryable && /(名称|名字|地址|门牌|标准名称|标准地址)/.test(field.name))
      .map((field) => field.name)
  );

  const isCoordinateBufferMode = Boolean(
    nearestSafeDsl.intent === "buffer_search" &&
      nearestSafeDsl.spatialFilter?.type === "buffer" &&
      nearestSafeDsl.spatialFilter?.center &&
      hasCoordinateHint(question)
  );
  const effectiveExpr = nearestSafeDsl.filterExpr ?? attributeFiltersToExpr(nearestSafeDsl.attributeFilter);
  const normalizedExpr = effectiveExpr
    ? normalizeExprNode(effectiveExpr, layer, allowedFields, {
        dropXYFields: isCoordinateBufferMode
      }) ?? undefined
    : undefined;

  const withFilters: SpatialQueryDSL = {
    ...nearestSafeDsl,
    filterExpr: normalizedExpr,
    attributeFilter: flattenExprToAndFilters(normalizedExpr)
  };

  const isCountLike =
    withFilters.intent === "count" || withFilters.intent === "group_stat" || withFilters.aggregation?.type === "count";
  const countCleanExpr = isCountLike
    ? removeWeakQuestionTailExpr(withFilters.filterExpr, question, nameLikeFields)
    : withFilters.filterExpr;
  const withCountCleanup: SpatialQueryDSL = {
    ...withFilters,
    filterExpr: countCleanExpr,
    attributeFilter: flattenExprToAndFilters(countCleanExpr)
  };
  const isSourceBufferMode = Boolean(
    withCountCleanup.intent === "buffer_search" &&
      withCountCleanup.spatialFilter?.sourceLayer &&
      (withCountCleanup.spatialFilter?.sourceFilterExpr || withCountCleanup.spatialFilter?.sourceAttributeFilter?.length)
  );
  const isSourceRelationMode = Boolean(
    withCountCleanup.spatialFilter?.type === "relation" &&
      withCountCleanup.spatialFilter?.sourceLayer &&
      (withCountCleanup.spatialFilter?.sourceFilterExpr || withCountCleanup.spatialFilter?.sourceAttributeFilter?.length)
  );
  const isMultiRingMode = Boolean(
    withCountCleanup.spatialFilter?.type === "buffer" &&
      Array.isArray(withCountCleanup.spatialFilter?.distances) &&
      withCountCleanup.spatialFilter.distances.length > 1
  );
  const isNearestMode = withCountCleanup.intent === "nearest";
  const hasFilterExpr = Boolean(withCountCleanup.filterExpr);
  const explicit = extractFieldCondition(question, layer);
  const shouldApplyForcedHint = Boolean(
    explicit && shouldForceExplicitOperator(explicit.operator) && canReplaceWithExplicitCondition(withCountCleanup, explicit)
  );
  const withOperatorHint = isSourceBufferMode || isSourceRelationMode || isCoordinateBufferMode || isNearestMode || isMultiRingMode
    ? withCountCleanup
    : (shouldApplyForcedHint || !hasFilterExpr)
      ? applyOperatorHint(question, withCountCleanup, layer)
      : withCountCleanup;

  const sourceLayerKey = withOperatorHint.spatialFilter?.sourceLayer;
  const sourceExpr = withOperatorHint.spatialFilter?.sourceFilterExpr ??
    attributeFiltersToExpr(withOperatorHint.spatialFilter?.sourceAttributeFilter ?? []);
  if (!sourceLayerKey || !sourceExpr) {
    return withOperatorHint;
  }

  const sourceLayer = layerRegistry.getLayer(sourceLayerKey);
  if (!sourceLayer) {
    throw new UserFacingError(`源图层 ${sourceLayerKey} 不存在。`);
  }

  const sourceAllowedFields = new Set(sourceLayer.fields.filter((field) => field.queryable).map((field) => field.name));
  const normalizedSourceExpr = normalizeExprNode(sourceExpr, sourceLayer, sourceAllowedFields) ?? undefined;
  const normalizedSourceFilters = flattenExprToAndFilters(normalizedSourceExpr);

  const effectiveTargetExpr = withOperatorHint.filterExpr ?? attributeFiltersToExpr(withOperatorHint.attributeFilter) ?? undefined;

  return {
    ...withOperatorHint,
    filterExpr: effectiveTargetExpr,
    attributeFilter: flattenExprToAndFilters(effectiveTargetExpr),
    spatialFilter: withOperatorHint.spatialFilter
      ? {
          ...withOperatorHint.spatialFilter,
          sourceFilterExpr: normalizedSourceExpr,
          sourceAttributeFilter: normalizedSourceFilters
        }
      : withOperatorHint.spatialFilter
  };
}

export function normalizeDslByQuestion(
  question: string,
  dsl: SpatialQueryDSL
): { dsl: SpatialQueryDSL; normalized: boolean } {
  const layer = layerRegistry.getLayer(dsl.targetLayer);
  if (!layer) {
    return { dsl, normalized: false };
  }

  const before = JSON.stringify(dsl);
  const nextDsl = normalizeFilterValues(dsl, question, layer);
  const after = JSON.stringify(nextDsl);
  return {
    dsl: nextDsl,
    normalized: before !== after
  };
}

export function classifyModelFailureReason(error: unknown): string {
  const message = (error as Error)?.message ?? "";
  const raw = typeof error === "string" ? error : JSON.stringify(error ?? "");
  const merged = `${message} ${raw}`;
  if (
    /schema/i.test(merged) ||
    /校验失败/.test(merged) ||
    /invalid_enum_value|zod|expected/i.test(merged)
  ) {
    return "schema_validation_failed";
  }
  if (/源图层字段.+不存在于|字段.+不存在于目标图层|UserFacingError/i.test(merged)) {
    return "consistency_check_failed";
  }
  if (/aborted/i.test(merged) || /timeout/i.test(merged)) {
    return "provider_timeout";
  }
  if (/API 请求失败:\s*401/.test(merged)) {
    return "provider_http_401";
  }
  if (/API 请求失败:\s*\d+/.test(merged)) {
    return "provider_http_error";
  }
  if (/json/i.test(merged)) {
    return "provider_non_json";
  }
  if (/一致|consistent|consistency/i.test(merged)) {
    return "consistency_check_failed";
  }
  return "provider_unknown_error";
}

export function buildModelFailureDetail(error: unknown): string {
  const text = (error as Error)?.message || (typeof error === "string" ? error : JSON.stringify(error ?? ""));
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function inferMatchPreference(question: string): FilterOperator | null {
  if (greaterThanEqualPattern.test(question)) {
    return ">=";
  }
  if (lessThanEqualPattern.test(question)) {
    return "<=";
  }
  if (greaterThanPattern.test(question)) {
    return ">";
  }
  if (lessThanPattern.test(question)) {
    return "<";
  }
  if (fuzzyOperatorPattern.test(question)) {
    return "like";
  }
  if (exactOperatorPattern.test(question)) {
    return "=";
  }
  return null;
}
