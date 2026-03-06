import {
  type FilterExprNode,
  type LayerDescriptor,
  type ParseResponse,
  type ParserSource,
  type SpatialQueryDSL,
  spatialQueryDslSchema
} from "@gis/shared";
import { config } from "./config.js";
import { layerRegistry } from "./layer-registry.js";
import {
  buildSemanticFewShots,
  buildSemanticSystemPrompt,
  GENERAL_CHAT_SYSTEM_PROMPT
} from "./prompts/semantic.js";
import {
  buildModelFailureDetail,
  classifyModelFailureReason,
  normalizeDslByQuestion
} from "./semantic-normalizer.js";
import { parseTopLimitFromQuestion } from "./semantic-limit.js";
import { parseQuestion as parseQuestionByRules } from "./semantic.js";
import { defaultOutputFields, findCountyField, resolveTargetLayer } from "./semantic-routing.js";
import {
  evaluateSpatialIntentGate,
  type SpatialGateDecision
} from "./spatial-intent-gate.js";
import { buildSemanticPromptContext } from "./semantic-context-builder.js";
import { appendSemanticFailureRecord } from "./semantic-retrieval.js";
import { rankSemanticCandidates, type SemanticCandidateLabel } from "./semantic-candidate-ranker.js";

interface LlmSemanticOutput {
  actionable: boolean;
  confidence?: number;
  followUpQuestion?: string | null;
  dsl?: SpatialQueryDSL | null;
}

interface OpenAICompatibleConfig {
  providerName: "gemini" | "groq" | "openrouter";
  parserSource: "gemini" | "groq" | "openrouter";
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxAttempts?: number;
  extraHeaders?: Record<string, string>;
}

export interface GeneralChatResponse {
  summary: string;
  parserSource: ParserSource;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface SpatialIntentClassificationOutput {
  isSpatial: boolean;
  confidence?: number;
  reason?: string;
}

interface SpatialIntentDecision {
  isSpatial: boolean;
  gateScore: number;
  gateDecision: SpatialGateDecision;
  gateReason: string;
}

type SemanticOutputIssueKind = "schema" | "non_json" | "consistency";

interface SemanticCompletionResult {
  content: string;
  usedResponseFormat: boolean;
  attemptsUsed: number;
}

interface SemanticMetaPayload {
  retrievalHits: number;
  modelAttempts: number;
  repaired: boolean;
  decisionPath: string;
  gateDecision?: SpatialGateDecision;
  candidateCount?: number;
  chosenCandidate?: "model" | "rule" | "repaired_model";
  candidateScore?: number;
}

class SemanticOutputError extends Error {
  kind: SemanticOutputIssueKind;
  rawOutput: string;

  constructor(kind: SemanticOutputIssueKind, message: string, rawOutput: string) {
    super(message);
    this.name = "SemanticOutputError";
    this.kind = kind;
    this.rawOutput = rawOutput;
  }
}

function hasCoordinateText(question: string): boolean {
  return (
    /-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?/.test(question) ||
    /x\s*[:：]\s*-?\d+(?:\.\d+)?\s*[，,\s]+y\s*[:：]\s*-?\d+(?:\.\d+)?/i.test(question)
  );
}

function hasSourceBufferText(question: string): boolean {
  return /(.+?)\s*\d+(?:\.\d+)?\s*(km|公里|千米|m|米)\s*(?:以内|内)\s*的?\s*(.+)/i.test(question);
}

function isBufferIntentText(question: string): boolean {
  return /(附近|周边|以内|内)/.test(question);
}

function isCountIntentText(question: string): boolean {
  return /(多少|几个|总数|数量)/.test(question);
}

function isGroupStatIntentText(question: string): boolean {
  return /(按|按照|以|基于).*(区县|行政区划|县级政区|乡镇|维度).*(统计|分组|汇总)|各(区县|行政区划|乡镇).*(数量|个数|分布|多少)|各区县分别有多少|(?:区县|行政区划).*(维度|分组|分布|汇总)/.test(
    question
  );
}

function hasCountyText(question: string): boolean {
  return /(鼓楼区|仓山区|台江区|晋安区|马尾区|长乐区|闽侯县|连江县|罗源县|闽清县|永泰县|福清市|平潭县)/.test(
    question
  );
}

function hasCountyDimensionText(question: string): boolean {
  return /(区县|行政区划|县级政区|乡镇|街道).*(维度|分组|分布|汇总|统计)|按.*(区县|行政区划|县级政区|乡镇|街道)/.test(
    question
  );
}

function exprContainsCountyEquality(expr: FilterExprNode | undefined): boolean {
  if (!expr) {
    return false;
  }
  if (expr.kind === "condition") {
    return (
      expr.operator === "=" &&
      /(区县|行政区划|县级政区|城市|所在乡镇|乡级政区)/.test(expr.field)
    );
  }
  return expr.children.some((child) => exprContainsCountyEquality(child));
}

function hasCountyFilter(dsl: SpatialQueryDSL): boolean {
  return dsl.attributeFilter.some(
    (item) =>
      item.operator === "=" &&
      /(区县|行政区划|县级政区|城市|所在乡镇|乡级政区)/.test(item.field)
  ) || exprContainsCountyEquality(dsl.filterExpr);
}

function isSpatialRelationText(question: string): boolean {
  return /(相交|相离|接触|重叠|被.+包含|包含.+的)/.test(question);
}

function isSpatialJoinCountText(question: string): boolean {
  return /每个.+内.+(有多少|数量|个数|多少)/.test(question);
}

function isMultiRingText(question: string): boolean {
  const distanceTokens = question.match(/(\d+(?:\.\d+)?)\s*(km|公里|千米|m|米)/gi) ?? [];
  return distanceTokens.length >= 2 && /(数量|统计|对比|分别)/.test(question);
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

function normalizeLimitByQuestion(question: string, dsl: SpatialQueryDSL): SpatialQueryDSL {
  if (!["search", "buffer_search", "nearest"].includes(dsl.intent)) {
    return dsl;
  }

  if (dsl.intent === "nearest") {
    const requestedNearest = parseTopLimitFromQuestion(question, config.nearestMaxK);
    return {
      ...dsl,
      limit: requestedNearest ?? Math.max(1, config.nearestDefaultK)
    };
  }

  const requestedLimit = parseTopLimitFromQuestion(question, config.queryMaxFeatures);
  return {
    ...dsl,
    limit: requestedLimit ?? config.queryMaxFeatures
  };
}

function isUnconstrainedSearch(dsl: SpatialQueryDSL): boolean {
  const noSpatial = !dsl.spatialFilter || !dsl.spatialFilter.type;
  const noAttribute = (!dsl.attributeFilter || dsl.attributeFilter.length === 0) && !dsl.filterExpr;
  const noAggregation = !dsl.aggregation;
  const noSort = !dsl.sort && (!dsl.orderBy || dsl.orderBy.length === 0);
  return dsl.intent === "search" && noSpatial && noAttribute && noAggregation && noSort;
}

function createDefaultDsl(): SpatialQueryDSL {
  const layer = layerRegistry.getDefaultLayer();
  if (!layer) {
    return {
      intent: "search",
      targetLayer: "fuzhou_parks",
      attributeFilter: [],
      aggregation: null,
      limit: 20,
      output: {
        fields: [],
        returnGeometry: true
      }
    };
  }

  return {
    intent: "search",
    targetLayer: layer.layerKey,
    attributeFilter: [],
    aggregation: null,
    limit: 20,
    output: {
      fields: defaultOutputFields(layer),
      returnGeometry: true
    }
  };
}

function createNonSpatialParseResponse(): ParseResponse {
  return {
    dsl: createDefaultDsl(),
    confidence: 0.4,
    followUpQuestion:
      "这条消息更像普通对话，不会执行空间检索。你可以继续提空间问题，例如“鼓楼区公园有多少个”。",
    parserSource: "rule"
  };
}

function getQueryableLayers() {
  return layerRegistry.listCatalog().layers.filter((layer) => layer.queryable);
}

function computeSpatialGate(question: string) {
  const layers = getQueryableLayers();
  return evaluateSpatialIntentGate(question, layers);
}

function clampConfidence(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.75;
  }
  return Math.max(0, Math.min(1, value));
}

function extractJsonString(raw: string): string {
  const markdownMatch = raw.match(/```json\s*([\s\S]*?)\s*```/i);
  if (markdownMatch?.[1]) {
    return markdownMatch[1].trim();
  }

  const objectStart = raw.indexOf("{");
  const objectEnd = raw.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return raw.slice(objectStart, objectEnd + 1);
  }

  return raw.trim();
}

function normalizeLocationType(raw: unknown): "point" | "road" | "subdistrict" | "county" | "unknown" {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return "unknown";
  }
  if (value === "point" || value === "poi") {
    return "point";
  }
  if (value === "road" || value === "line" || value === "polyline") {
    return "road";
  }
  if (value === "subdistrict" || value === "polygon" || value === "area") {
    return "subdistrict";
  }
  if (value === "county") {
    return "county";
  }
  return "unknown";
}

function normalizeIntent(raw: unknown): SpatialQueryDSL["intent"] {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "count") {
    return "count";
  }
  if (value === "group_stat" || value === "group" || value === "group_count" || value === "groupstat") {
    return "group_stat";
  }
  if (value === "nearest") {
    return "nearest";
  }
  if (value === "buffer_search" || value === "buffer" || value === "nearby") {
    return "buffer_search";
  }
  return "search";
}

function normalizeSpatialType(raw: unknown): "buffer" | "intersects" | "nearest" | "relation" | undefined {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "buffer" || value === "nearby") {
    return "buffer";
  }
  if (value === "intersects" || value === "intersect") {
    return "intersects";
  }
  if (value === "nearest") {
    return "nearest";
  }
  if (value === "relation" || value === "spatial_relation") {
    return "relation";
  }
  return undefined;
}

function normalizeSpatialRelation(
  raw: unknown
): "intersects" | "contains" | "within" | "disjoint" | "touches" | "overlaps" | undefined {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (["intersects", "intersect", "相交"].includes(value)) {
    return "intersects";
  }
  if (["contains", "contain", "包含"].includes(value)) {
    return "contains";
  }
  if (["within", "inside", "被包含"].includes(value)) {
    return "within";
  }
  if (["disjoint", "separate", "相离"].includes(value)) {
    return "disjoint";
  }
  if (["touches", "touch", "接触"].includes(value)) {
    return "touches";
  }
  if (["overlaps", "overlap", "重叠"].includes(value)) {
    return "overlaps";
  }
  return undefined;
}

function normalizeUnit(raw: unknown): "meter" | "kilometer" | undefined {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "kilometer" || value === "km" || value === "公里" || value === "千米") {
    return "kilometer";
  }
  if (value === "meter" || value === "m" || value === "米") {
    return "meter";
  }
  return undefined;
}

function normalizeOperator(raw: unknown): SpatialQueryDSL["attributeFilter"][number]["operator"] {
  const value = String(raw ?? "").trim().toLowerCase();
  if (["!=", "<>", "ne", "not_equal", "notequal", "not equals"].includes(value)) {
    return "!=";
  }
  if (["in", "within_list"].includes(value)) {
    return "in";
  }
  if (["not in", "not_in", "nin"].includes(value)) {
    return "not in";
  }
  if (["between", "range"].includes(value)) {
    return "between";
  }
  if (["is null", "null", "isnull"].includes(value)) {
    return "is null";
  }
  if (["is not null", "not null", "isnotnull"].includes(value)) {
    return "is not null";
  }
  if (["gte", ">=", "atleast", "min"].includes(value)) {
    return ">=";
  }
  if (["lte", "<=", "atmost", "max"].includes(value)) {
    return "<=";
  }
  if (value === ">" || value === "gt") {
    return ">";
  }
  if (value === "<" || value === "lt") {
    return "<";
  }
  if (value === "like" || value === "contains" || value === "contain") {
    return "like";
  }
  return "=";
}

function operatorNeedsValue(operator: SpatialQueryDSL["attributeFilter"][number]["operator"]): boolean {
  return operator !== "is null" && operator !== "is not null";
}

function normalizeOrderBy(raw: unknown): SpatialQueryDSL["orderBy"] {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const items = raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const field = String((item as { field?: unknown }).field ?? "").trim();
      const rawDirection = String((item as { direction?: unknown }).direction ?? "").trim().toLowerCase();
      if (!field) {
        return null;
      }
      return {
        field,
        direction: rawDirection === "desc" ? "desc" : "asc"
      } as const;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function normalizeFilterList(
  raw: unknown
): Array<{ field: string; operator: SpatialQueryDSL["attributeFilter"][number]["operator"]; value: string }> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const field = String((item as { field?: unknown }).field ?? "").trim();
      const operator = normalizeOperator((item as { operator?: unknown }).operator);
      const value = String((item as { value?: unknown }).value ?? "").trim();
      if (!field) {
        return null;
      }
      if (operatorNeedsValue(operator) && !value) {
        return null;
      }
      return {
        field,
        operator,
        value
      };
    })
    .filter(
      (
        item
      ): item is {
        field: string;
        operator: SpatialQueryDSL["attributeFilter"][number]["operator"];
        value: string;
      } => Boolean(item)
    );
}

function normalizeFilterExpr(raw: unknown): FilterExprNode | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const node = raw as Record<string, unknown>;
  const kind = String(node.kind ?? "").trim().toLowerCase();
  if (!kind) {
    return undefined;
  }
  if (kind === "condition") {
    const field = String(node.field ?? "").trim();
    const operator = normalizeOperator(node.operator);
    const value = String(node.value ?? "").trim();
    if (!field) {
      return undefined;
    }
    if (operatorNeedsValue(operator) && !value) {
      return undefined;
    }
    return {
      kind: "condition",
      field,
      operator,
      value
    };
  }
  if (kind === "group") {
    const logicRaw = String(node.logic ?? "").trim().toLowerCase();
    const logic: "and" | "or" = logicRaw === "or" ? "or" : "and";
    const childrenRaw = Array.isArray(node.children) ? node.children : [];
    const children = childrenRaw
      .map((child) => normalizeFilterExpr(child))
      .filter((child): child is FilterExprNode => Boolean(child));
    if (!children.length) {
      return undefined;
    }
    return {
      kind: "group",
      logic,
      children
    };
  }
  return undefined;
}

function normalizeLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.min(config.queryMaxFeatures, Math.max(1, Math.round(parsed)));
}

function normalizeDslForSchema(rawDsl: unknown): SpatialQueryDSL {
  if (!rawDsl || typeof rawDsl !== "object") {
    throw new Error("模型 dsl 缺失或不是对象");
  }

  const dsl = rawDsl as Record<string, unknown>;
  const locationEntity = dsl.locationEntity as Record<string, unknown> | undefined;
  const spatialFilter = dsl.spatialFilter as Record<string, unknown> | undefined;
  const output = dsl.output as Record<string, unknown> | undefined;

  const normalized: SpatialQueryDSL = {
    intent: normalizeIntent(dsl.intent),
    targetLayer: String(dsl.targetLayer ?? ""),
    attributeFilter: normalizeFilterList(dsl.attributeFilter),
    filterExpr: normalizeFilterExpr(dsl.filterExpr),
    aggregation:
      dsl.aggregation && typeof dsl.aggregation === "object"
        ? (dsl.aggregation as SpatialQueryDSL["aggregation"])
        : null,
    orderBy: normalizeOrderBy(dsl.orderBy),
    limit: normalizeLimit(dsl.limit),
    output: {
      fields: Array.isArray(output?.fields)
        ? output!.fields.map((item) => String(item)).filter((item) => item.trim().length > 0)
        : [],
      returnGeometry: output?.returnGeometry === undefined ? true : Boolean(output.returnGeometry)
    }
  };

  if (!normalized.orderBy && dsl.sort && typeof dsl.sort === "object") {
    const by = String((dsl.sort as { by?: unknown }).by ?? "").trim();
    const orderRaw = String((dsl.sort as { order?: unknown }).order ?? "").trim().toLowerCase();
    if (by) {
      normalized.orderBy = [{
        field: by,
        direction: orderRaw === "desc" ? "desc" : "asc"
      }];
    }
  }

  if (locationEntity && typeof locationEntity === "object") {
    normalized.locationEntity = {
      rawText:
        locationEntity.rawText === undefined ? undefined : String(locationEntity.rawText),
      type: normalizeLocationType(locationEntity.type),
      resolution:
        locationEntity.resolution === "resolved" ||
        locationEntity.resolution === "needs_clarification" ||
        locationEntity.resolution === "missing_dependency"
          ? locationEntity.resolution
          : undefined
    };
  }

  if (spatialFilter && typeof spatialFilter === "object") {
    const radius = Number(spatialFilter.radius);
    const distances = Array.isArray(spatialFilter.distances)
      ? spatialFilter.distances
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0)
      : undefined;
    normalized.spatialFilter = {
      type: normalizeSpatialType(spatialFilter.type),
      relation: normalizeSpatialRelation(spatialFilter.relation),
      joinMode:
        spatialFilter.joinMode === "count_by_source" ? "count_by_source" : undefined,
      radius: Number.isNaN(radius) ? undefined : radius,
      distances: distances && distances.length > 0 ? distances : undefined,
      unit: normalizeUnit(spatialFilter.unit),
      ringOnly:
        spatialFilter.ringOnly === undefined ? undefined : Boolean(spatialFilter.ringOnly),
      excludeSelf:
        spatialFilter.excludeSelf === undefined ? undefined : Boolean(spatialFilter.excludeSelf),
      sourceLayer:
        spatialFilter.sourceLayer === undefined ? undefined : String(spatialFilter.sourceLayer),
      sourceAttributeFilter: normalizeFilterList(spatialFilter.sourceAttributeFilter),
      sourceFilterExpr: normalizeFilterExpr(spatialFilter.sourceFilterExpr),
      center:
        spatialFilter.center && typeof spatialFilter.center === "object"
          ? (spatialFilter.center as any)
          : undefined
    };
  }

  return normalized;
}

function normalizeDslForSchemaAndParse(dsl: unknown): SpatialQueryDSL {
  const normalized = normalizeDslForSchema(dsl);
  return spatialQueryDslSchema.parse(normalized);
}

function normalizeDslForSchemaLegacy(dsl: SpatialQueryDSL): SpatialQueryDSL {
  if (!dsl.locationEntity) {
    return dsl;
  }
  return {
    ...dsl,
    locationEntity: {
      ...dsl.locationEntity,
      type: normalizeLocationType(dsl.locationEntity.type)
    }
  };
}

function applyLayerRouting(question: string, dsl: SpatialQueryDSL): ParseResponse {
  const resolved = resolveTargetLayer(question, dsl.targetLayer);
  if (!resolved.layer) {
    return {
      dsl: createDefaultDsl(),
      confidence: 0.6,
      followUpQuestion:
        resolved.followUpQuestion ?? "无法识别目标图层，请指定图层后重试。",
      parserSource: "rule"
    };
  }

  const fixedDsl: SpatialQueryDSL = {
    ...dsl,
    targetLayer: resolved.layer.layerKey,
    output: {
      ...dsl.output,
      fields: dsl.output.fields.length ? dsl.output.fields : defaultOutputFields(resolved.layer)
    }
  };

  if (
    (fixedDsl.intent === "group_stat" || fixedDsl.aggregation?.type === "group_count") &&
    (!fixedDsl.aggregation?.groupBy || fixedDsl.aggregation.groupBy.length === 0)
  ) {
    const groupField = findCountyField(resolved.layer);
    if (groupField) {
      fixedDsl.aggregation = {
        type: "group_count",
        groupBy: [groupField]
      };
      fixedDsl.orderBy = [{
        field: groupField,
        direction: "asc"
      }];
      fixedDsl.sort = {
        by: groupField,
        order: "asc"
      };
    }
  }

  return {
    dsl: fixedDsl,
    confidence: 0.9,
    followUpQuestion: resolved.followUpQuestion,
    parserSource: "rule"
  };
}

function isModelResultConsistent(question: string, parsed: ParseResponse): boolean {
  const dsl = parsed.dsl;

  if (hasCoordinateText(question) && isBufferIntentText(question)) {
    if (
      dsl.intent !== "buffer_search" ||
      dsl.spatialFilter?.type !== "buffer" ||
      !dsl.spatialFilter?.center ||
      parsed.followUpQuestion
    ) {
      return false;
    }
  }

  if (hasSourceBufferText(question) && !hasCoordinateText(question)) {
    if (
      dsl.intent !== "buffer_search" ||
      dsl.spatialFilter?.type !== "buffer" ||
      !dsl.spatialFilter?.sourceLayer ||
      !(dsl.spatialFilter?.sourceFilterExpr || dsl.spatialFilter?.sourceAttributeFilter?.length)
    ) {
      return false;
    }
  }

  if (isGroupStatIntentText(question)) {
    const isGroupIntent =
      dsl.intent === "group_stat" ||
      dsl.aggregation?.type === "group_count" ||
      (Array.isArray(dsl.aggregation?.groupBy) && dsl.aggregation.groupBy.length > 0);
    if (!isGroupIntent) {
      return false;
    }
  }

  if (isCountIntentText(question) && !isGroupStatIntentText(question)) {
    if (dsl.intent !== "count" && dsl.aggregation?.type !== "count") {
      return false;
    }
  }

  if (/(最近|nearest)/i.test(question) && dsl.intent !== "nearest") {
    return false;
  }
  if (dsl.intent === "nearest") {
    const hasCenter = Boolean(dsl.spatialFilter?.center);
    const hasSource = Boolean(
      dsl.spatialFilter?.sourceLayer &&
      (dsl.spatialFilter?.sourceFilterExpr || dsl.spatialFilter?.sourceAttributeFilter?.length)
    );
    if (!hasCenter && !hasSource) {
      return false;
    }
  }

  if (
    /(或|或者)/.test(question) &&
    !exprContainsOr(dsl.filterExpr) &&
    !exprContainsOr(dsl.spatialFilter?.sourceFilterExpr)
  ) {
    return false;
  }

  if (isSpatialRelationText(question)) {
    if (dsl.spatialFilter?.type !== "relation") {
      return false;
    }
    if (!dsl.spatialFilter?.relation) {
      return false;
    }
  }

  if (isSpatialJoinCountText(question)) {
    if (dsl.spatialFilter?.joinMode !== "count_by_source") {
      return false;
    }
  }

  if (isMultiRingText(question)) {
    if (dsl.spatialFilter?.type !== "buffer" || !dsl.spatialFilter?.distances || dsl.spatialFilter.distances.length < 2) {
      return false;
    }
  }

  if (hasCountyText(question) && !hasCountyFilter(dsl)) {
    return false;
  }

  return true;
}

function normalizeModelOutput(
  question: string,
  output: LlmSemanticOutput,
  parserSource: "gemini" | "groq" | "openrouter"
): ParseResponse {
  if (!output.actionable) {
    return {
      dsl: createDefaultDsl(),
      confidence: clampConfidence(output.confidence),
      followUpQuestion:
        output.followUpQuestion ??
        "我是空间查询助手。请告诉我空间问题，例如“鼓楼区公园有多少个”或“13303000,2996000 500米内的公园”。",
      parserSource
    };
  }

  if (!output.dsl) {
    throw new Error("LLM 返回 actionable=true 但缺少 dsl");
  }

  const parsed = normalizeDslForSchemaAndParse(output.dsl);
  const parsedWithLegacy = normalizeDslForSchemaLegacy(parsed);
  const gate = computeSpatialGate(question);
  if (isUnconstrainedSearch(parsedWithLegacy) && gate.decision === "non_spatial") {
    return {
      dsl: createDefaultDsl(),
      confidence: 0.4,
      followUpQuestion:
        "我目前专注空间问题。你可以这样问：鼓楼区公园有多少个、仓山区前20个公园、某点500米内的公园。",
      parserSource
    };
  }

  const normalizedDsl = normalizeLimitByQuestion(question, parsedWithLegacy);
  const routed = applyLayerRouting(question, normalizedDsl);
  let alignedDsl = routed.dsl;
  if (isGroupStatIntentText(question)) {
    alignedDsl = {
      ...alignedDsl,
      intent: "group_stat",
      aggregation:
        alignedDsl.aggregation?.type === "group_count"
          ? alignedDsl.aggregation
          : {
              type: "group_count",
              groupBy: alignedDsl.aggregation?.groupBy ?? []
            },
      output: {
        ...alignedDsl.output,
        returnGeometry: false
      }
    };
  }

  if (isGroupStatIntentText(question) && hasCountyDimensionText(question)) {
    const targetLayer = layerRegistry.getLayer(alignedDsl.targetLayer);
    if (targetLayer) {
      const countyField = findCountyField(targetLayer);
      if (countyField) {
        alignedDsl = {
          ...alignedDsl,
          aggregation: {
            type: "group_count",
            groupBy: [countyField]
          },
          orderBy: [{
            field: countyField,
            direction: "asc"
          }],
          sort: {
            by: countyField,
            order: "asc"
          }
        };
      }
    }
  }

  const normalizedByRule = normalizeDslByQuestion(question, alignedDsl);
  return {
    dsl: normalizedByRule.dsl,
    confidence: clampConfidence(output.confidence),
    followUpQuestion: output.followUpQuestion ?? routed.followUpQuestion ?? null,
    parserSource,
    normalizedByRule: normalizedByRule.normalized
  };
}

function normalizeSpatialClassifierOutput(raw: string): SpatialIntentClassificationOutput {
  const jsonText = extractJsonString(raw);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  const rawSpatial = parsed.isSpatial;
  let isSpatial = false;
  if (typeof rawSpatial === "boolean") {
    isSpatial = rawSpatial;
  } else {
    const normalized = String(rawSpatial ?? "")
      .trim()
      .toLowerCase();
    isSpatial = ["true", "yes", "spatial", "1", "是"].includes(normalized);
  }
  const confidenceRaw = Number(parsed.confidence ?? 0.6);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.6;
  const reason = String(parsed.reason ?? "").trim();
  return {
    isSpatial,
    confidence,
    reason
  };
}

function buildSpatialClassifierMessages(question: string): OpenAIMessage[] {
  const layers = getQueryableLayers();
  const layerHints = layers
    .slice(0, 12)
    .map((layer) => {
      const fields = layer.fields
        .filter((field) => field.queryable)
        .slice(0, 6)
        .map((field) => field.name)
        .join(",");
      return `${layer.name}[${layer.layerKey}](${fields})`;
    })
    .join("; ");

  const system = [
    "你是空间问题分类器。",
    "任务：判断用户问题是否属于可执行的 GIS 空间查询。",
    "只输出 JSON：{\"isSpatial\": boolean, \"confidence\": number, \"reason\": string}",
    "当问题是普通寒暄/生活问答/与图层无关对话时，isSpatial=false。",
    "当问题涉及图层要素、字段过滤、统计、最近邻、缓冲、空间关系时，isSpatial=true。",
    `可查询图层参考：${layerHints || "暂无图层"}`
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: question }
  ];
}

async function classifySpatialIntentWithProvider(
  question: string,
  provider: OpenAICompatibleConfig,
  deadlineAt: number
): Promise<{ result: SpatialIntentClassificationOutput; parserSource: ParserSource }> {
  const messages = buildSpatialClassifierMessages(question);
  const completion = await requestSemanticCompletion(provider, messages, true, deadlineAt);
  const result = normalizeSpatialClassifierOutput(completion.content);
  return {
    result,
    parserSource: provider.parserSource
  };
}

async function classifySpatialIntentByModel(question: string): Promise<SpatialIntentClassificationOutput> {
  const provider = config.llmProvider.trim().toLowerCase();
  const deadlineAt = Date.now() + 18_000;

  if (provider === "gemini") {
    try {
      const classified = await classifySpatialIntentWithProvider(
        question,
        {
          providerName: "gemini",
          parserSource: "gemini",
          apiKey: config.geminiApiKey,
          baseUrl: config.geminiBaseUrl,
          model: config.geminiModel,
          timeoutMs: Math.min(config.geminiTimeoutMs, 9000),
          maxAttempts: 2
        },
        deadlineAt
      );
      return classified.result;
    } catch (geminiError) {
      console.warn("[semantic-gate] Gemini 二判失败，尝试 OpenRouter", {
        raw: (geminiError as Error).message
      });
      const candidates = buildModelCandidates(config.openrouterModel, config.openrouterFallbackModels);
      let lastError: unknown = geminiError;
      for (const model of candidates) {
        try {
          const classified = await classifySpatialIntentWithProvider(
            question,
            {
              providerName: "openrouter",
              parserSource: "openrouter",
              apiKey: config.openrouterApiKey,
              baseUrl: config.openrouterBaseUrl,
              model,
              timeoutMs: Math.min(config.openrouterTimeoutMs, 9000),
              maxAttempts: 1,
              extraHeaders: {
                ...(config.openrouterSiteUrl ? { "HTTP-Referer": config.openrouterSiteUrl } : {}),
                "X-Title": config.openrouterAppName
              }
            },
            deadlineAt
          );
          return classified.result;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    }
  }

  if (provider === "openrouter") {
    const candidates = buildModelCandidates(config.openrouterModel, config.openrouterFallbackModels);
    let lastError: unknown = null;
    for (const model of candidates) {
      try {
        const classified = await classifySpatialIntentWithProvider(
          question,
          {
            providerName: "openrouter",
            parserSource: "openrouter",
            apiKey: config.openrouterApiKey,
            baseUrl: config.openrouterBaseUrl,
            model,
            timeoutMs: Math.min(config.openrouterTimeoutMs, 9000),
            maxAttempts: 1,
            extraHeaders: {
              ...(config.openrouterSiteUrl ? { "HTTP-Referer": config.openrouterSiteUrl } : {}),
              "X-Title": config.openrouterAppName
            }
          },
          deadlineAt
        );
        return classified.result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OpenRouter 二判失败");
  }

  if (provider === "groq") {
    const classified = await classifySpatialIntentWithProvider(
      question,
      {
        providerName: "groq",
        parserSource: "groq",
        apiKey: config.groqApiKey,
        baseUrl: config.groqBaseUrl,
        model: config.groqModel,
        timeoutMs: Math.min(config.groqTimeoutMs, 9000),
        maxAttempts: 2
      },
      deadlineAt
    );
    return classified.result;
  }

  throw new Error(`LLM_PROVIDER=${provider} 不支持模型二判`);
}

async function detectSpatialIntentDecision(question: string): Promise<SpatialIntentDecision> {
  const gate = computeSpatialGate(question);
  const gateReason = gate.reasons.slice(0, 4).join(" | ") || "无命中信号";
  if (gate.decision === "spatial") {
    return {
      isSpatial: true,
      gateScore: gate.score,
      gateDecision: gate.decision,
      gateReason
    };
  }
  if (gate.decision === "non_spatial") {
    return {
      isSpatial: false,
      gateScore: gate.score,
      gateDecision: gate.decision,
      gateReason
    };
  }

  try {
    const secondPass = await classifySpatialIntentByModel(question);
    return {
      isSpatial: secondPass.isSpatial,
      gateScore: gate.score,
      gateDecision: gate.decision,
      gateReason: `${gateReason}; 模型二判=${secondPass.isSpatial ? "spatial" : "non_spatial"}${
        secondPass.reason ? `(${secondPass.reason})` : ""
      }`
    };
  } catch (error) {
    console.warn("[semantic-gate] 模型二判失败，默认按空间问题处理", {
      gateScore: gate.score,
      gateDecision: gate.decision,
      reason: (error as Error).message
    });
    return {
      isSpatial: true,
      gateScore: gate.score,
      gateDecision: gate.decision,
      gateReason: `${gateReason}; 模型二判失败默认空间`
    };
  }
}

function withParserSource(parsed: ParseResponse, parserSource: ParserSource): ParseResponse {
  return {
    ...parsed,
    parserSource
  };
}

function withSemanticMeta(parsed: ParseResponse, meta: Partial<SemanticMetaPayload>): ParseResponse {
  const prev = parsed.semanticMeta ?? {
    retrievalHits: 0,
    modelAttempts: 0,
    repaired: false,
    decisionPath: "unknown"
  };
  return {
    ...parsed,
    semanticMeta: {
      retrievalHits: typeof meta.retrievalHits === "number" ? meta.retrievalHits : prev.retrievalHits,
      modelAttempts: typeof meta.modelAttempts === "number" ? meta.modelAttempts : prev.modelAttempts,
      repaired: typeof meta.repaired === "boolean" ? meta.repaired : prev.repaired,
      decisionPath: meta.decisionPath ?? prev.decisionPath,
      gateDecision: meta.gateDecision ?? prev.gateDecision,
      candidateCount:
        typeof meta.candidateCount === "number" ? meta.candidateCount : prev.candidateCount,
      chosenCandidate: meta.chosenCandidate ?? prev.chosenCandidate,
      candidateScore:
        typeof meta.candidateScore === "number" ? meta.candidateScore : prev.candidateScore
    }
  };
}

function providerToSource(provider: string): ParserSource {
  if (provider === "gemini" || provider === "groq" || provider === "openrouter") {
    return provider;
  }
  return "rule";
}

function isResponseFormatUnsupported(statusCode: number, responseText: string): boolean {
  if (![400, 404, 415, 422].includes(statusCode)) {
    return false;
  }
  return /(response_format|json_object|unsupported|not supported|invalid.*response_format)/i.test(responseText);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function calcRetryDelayMs(message: string, attempt: number): number {
  const base = Math.min(12_000, 1_200 * 2 ** (attempt - 1));
  if (/free-models-per-min|per-minute|retry-after/i.test(message)) {
    return Math.max(base, 10_000);
  }
  if (/429|rate limit/i.test(message)) {
    return Math.max(base, 6_000);
  }
  if (/402/i.test(message)) {
    return Math.max(base, 4_000);
  }
  return base;
}

function isRepairableSemanticError(error: unknown): error is SemanticOutputError {
  return (
    error instanceof SemanticOutputError &&
    (error.kind === "schema" || error.kind === "non_json" || error.kind === "consistency")
  );
}

function buildSemanticRepairPrompt(question: string, issue: SemanticOutputError): string {
  const outputPreview = issue.rawOutput.slice(0, 1600);
  return [
    "你上一条输出不合规，请修正。",
    "要求：只返回 JSON 对象，不要解释，不要 markdown。",
    "顶层键必须是：actionable, confidence, followUpQuestion, dsl。",
    "修正原因：" + issue.message,
    "原问题：" + question,
    "上一条输出（截断）：" + outputPreview
  ].join("\n");
}

function buildSemanticMessages(
  semanticSystemPrompt: string,
  semanticFewShots: OpenAIMessage[],
  question: string
): OpenAIMessage[] {
  return [{ role: "system", content: semanticSystemPrompt }, ...semanticFewShots, { role: "user", content: question }];
}

async function requestSemanticCompletion(
  provider: OpenAICompatibleConfig,
  messages: OpenAIMessage[],
  preferJsonFormat: boolean,
  deadlineAt: number
): Promise<SemanticCompletionResult> {
  let lastError: unknown = null;
  let useResponseFormat = preferJsonFormat;
  const maxAttempts = Math.max(1, provider.maxAttempts ?? 4);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 1_500) {
      throw new Error(`${provider.providerName} 请求超出总时限`);
    }
    const controller = new AbortController();
    const attemptTimeoutMs = Math.max(1_000, Math.min(provider.timeoutMs, remainingMs - 250));
    const timeoutId = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const requestBody: Record<string, unknown> = {
        model: provider.model,
        temperature: 0,
        messages
      };
      if (useResponseFormat) {
        requestBody.response_format = { type: "json_object" };
      }

      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
          ...(provider.extraHeaders ?? {})
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        if (useResponseFormat && isResponseFormatUnsupported(response.status, body)) {
          useResponseFormat = false;
          console.warn("[semantic] provider does not support response_format=json_object, retry without it", {
            provider: provider.providerName,
            status: response.status
          });
          continue;
        }
        throw new Error(`${provider.providerName} API 请求失败: ${response.status} ${body}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(`${provider.providerName} 返回内容为空`);
      }

      return {
        content,
        usedResponseFormat: useResponseFormat,
        attemptsUsed: attempt
      };
    } catch (error) {
      lastError = error;
      const message = (error as Error)?.message ?? "";
      const hasFastFailHttpCode = /\b(401|403|429)\b/.test(message);
      const shouldRetry =
        attempt < maxAttempts &&
        !hasFastFailHttpCode &&
        /aborted|timeout|402|5\d\d|rate limit/i.test(message);
      const retryDelayMs = shouldRetry ? calcRetryDelayMs(message, attempt) : 0;
      console.warn("[semantic] provider attempt failed", {
        provider: provider.providerName,
        attempt,
        maxAttempts,
        attemptTimeoutMs,
        remainingMs,
        shouldRetry,
        retryDelayMs,
        reason: message
      });
      if (!shouldRetry) {
        throw error;
      }
      const safeDelayMs = Math.max(0, Math.min(retryDelayMs, deadlineAt - Date.now() - 250));
      if (safeDelayMs <= 0) {
        throw error;
      }
      await sleep(safeDelayMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("模型请求失败");
}

function parseSemanticOutputToDsl(
  question: string,
  parserSource: "gemini" | "groq" | "openrouter",
  rawContent: string
): ParseResponse {
  const rawJson = extractJsonString(rawContent);
  let modelOutput: LlmSemanticOutput;
  try {
    modelOutput = JSON.parse(rawJson) as LlmSemanticOutput;
  } catch (error) {
    throw new SemanticOutputError(
      "non_json",
      `模型输出不是合法 JSON：${(error as Error).message}`,
      rawContent
    );
  }

  let parsed: ParseResponse;
  try {
    parsed = normalizeModelOutput(question, modelOutput, parserSource);
  } catch (error) {
    throw new SemanticOutputError("schema", `模型输出 Schema 校验失败：${(error as Error).message}`, rawJson);
  }

  if (!isModelResultConsistent(question, parsed) && config.semanticConsistencyStrict) {
    throw new SemanticOutputError("consistency", "模型输出与语义一致性规则冲突。", rawJson);
  }
  if (!isModelResultConsistent(question, parsed) && !config.semanticConsistencyStrict) {
    parsed = {
      ...parsed,
      semanticWarnings: [...(parsed.semanticWarnings ?? []), "模型输出与语义一致性规则存在偏差，已按宽松模式继续执行。"]
    };
  }
  return parsed;
}

function buildLowConfidenceFollowUp(bestScore: number): string {
  return `当前语义解析置信度较低（score=${bestScore.toFixed(1)}），为避免误查，请补充更明确的图层、字段或条件。`;
}

function applyCandidateRanking(
  question: string,
  queryableLayers: LayerDescriptor[],
  modelParsed: ParseResponse,
  modelLabel: SemanticCandidateLabel,
  contextMeta: {
    retrievalHits: number;
    modelAttempts: number;
    repaired: boolean;
    decisionPath: string;
    gateDecision: SpatialGateDecision;
  }
): ParseResponse {
  const ruleParsed = withParserSource(parseQuestionByRules(question), "rule");
  const ranked = rankSemanticCandidates(
    question,
    [
      { label: modelLabel, parsed: modelParsed },
      { label: "rule", parsed: ruleParsed }
    ],
    queryableLayers
  );
  const best = ranked[0];
  const rankedMeta = {
    retrievalHits: contextMeta.retrievalHits,
    modelAttempts: contextMeta.modelAttempts,
    repaired: contextMeta.repaired,
    decisionPath: contextMeta.decisionPath,
    candidateCount: ranked.length,
    chosenCandidate: best.label,
    candidateScore: best.score,
    gateDecision: contextMeta.gateDecision
  } as const;

  const bestWithMeta = withSemanticMeta(best.parsed, rankedMeta);
  if (best.score >= 75) {
    return bestWithMeta;
  }

  return withSemanticMeta(
    {
      ...bestWithMeta,
      followUpQuestion: bestWithMeta.followUpQuestion ?? buildLowConfidenceFollowUp(best.score),
      semanticWarnings: Array.from(
        new Set([
          ...(bestWithMeta.semanticWarnings ?? []),
          `候选评分偏低(${best.score.toFixed(1)})，已进入澄清流程`
        ])
      )
    },
    rankedMeta
  );
}

async function parseWithOpenAICompatible(
  question: string,
  provider: OpenAICompatibleConfig,
  options?: { deadlineAt?: number }
): Promise<ParseResponse> {
  if (!provider.apiKey) {
    throw new Error(`${provider.providerName.toUpperCase()}_API_KEY 未配置`);
  }

  const catalog = layerRegistry.listCatalog();
  const queryableLayers = catalog.layers.filter((layer) => layer.queryable);
  const defaultLayerKey = layerRegistry.getDefaultLayer()?.layerKey ?? "fuzhou_parks";
  const context = await buildSemanticPromptContext({
    question,
    layers: queryableLayers,
    defaultLayerKey
  });
  const semanticSystemPrompt = [
    buildSemanticSystemPrompt(queryableLayers),
    context.retrievalSystemHint
  ]
    .filter((item) => item && item.trim().length > 0)
    .join("\n\n");
  const baseFewShots = buildSemanticFewShots(defaultLayerKey, queryableLayers);
  const semanticFewShots = [...context.retrievalFewShots, ...baseFewShots].slice(0, 24);
  const baseMessages = buildSemanticMessages(semanticSystemPrompt, semanticFewShots, question);
  const deadlineAt = options?.deadlineAt ?? Date.now() + 55_000;
  const maxRepairRetry = Math.max(0, config.semanticModelRepairMaxRetry);
  const gateDecision = computeSpatialGate(question).decision;
  let modelAttempts = 0;
  let repaired = false;
  const first = await requestSemanticCompletion(provider, baseMessages, true, deadlineAt);
  modelAttempts += first.attemptsUsed;

  try {
    const parsed = parseSemanticOutputToDsl(question, provider.parserSource, first.content);
    return applyCandidateRanking(question, queryableLayers, parsed, "model", {
      retrievalHits: context.retrievalHits,
      modelAttempts,
      repaired,
      decisionPath: provider.parserSource,
      gateDecision
    });
  } catch (error) {
    if (!isRepairableSemanticError(error)) {
      throw error;
    }

    let previousIssue: SemanticOutputError = error;
    let previousContent = first.content;
    for (let retry = 1; retry <= maxRepairRetry; retry += 1) {
      repaired = true;
      const repairPrompt = buildSemanticRepairPrompt(question, previousIssue);
      const repairMessages: OpenAIMessage[] = [
        ...baseMessages,
        {
          role: "assistant",
          content: previousContent.slice(0, 2000)
        },
        {
          role: "user",
          content: repairPrompt
        }
      ];
      const repairedCompletion = await requestSemanticCompletion(
        provider,
        repairMessages,
        first.usedResponseFormat,
        deadlineAt
      );
      modelAttempts += repairedCompletion.attemptsUsed;
      previousContent = repairedCompletion.content;

      try {
        const parsed = parseSemanticOutputToDsl(question, provider.parserSource, repairedCompletion.content);
        return applyCandidateRanking(question, queryableLayers, parsed, "repaired_model", {
          retrievalHits: context.retrievalHits,
          modelAttempts,
          repaired,
          decisionPath: `${provider.parserSource}:repair`,
          gateDecision
        });
      } catch (repairError) {
        if (!isRepairableSemanticError(repairError)) {
          throw repairError;
        }
        previousIssue = repairError;
      }
    }

    throw new Error(
      `模型修复失败: first=${error.kind}; last=${previousIssue.kind}; ${previousIssue.message}`
    );
  }
}

function buildModelCandidates(primary: string, fallbackModels: string[]): string[] {
  const models = [primary, ...fallbackModels].map((item) => item.trim()).filter(Boolean);
  const deduped = Array.from(new Set(models));
  if (deduped.length > 1) {
    deduped.push(deduped[0]);
  }
  return deduped;
}

async function parseWithOpenRouterCandidates(question: string): Promise<ParseResponse> {
  const modelCandidates = buildModelCandidates(config.openrouterModel, config.openrouterFallbackModels);
  const deadlineAt = Date.now() + Math.max(45_000, Math.min(90_000, config.openrouterTimeoutMs + 20_000));
  let lastError: unknown = null;

  for (let index = 0; index < modelCandidates.length; index += 1) {
    const model = modelCandidates[index];
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 1_500) {
      lastError = new Error("openrouter 总时限已耗尽");
      break;
    }
    try {
      const parsed = await parseWithOpenAICompatible(question, {
        providerName: "openrouter",
        parserSource: "openrouter",
        apiKey: config.openrouterApiKey,
        baseUrl: config.openrouterBaseUrl,
        model,
        timeoutMs: Math.max(3_000, Math.min(config.openrouterTimeoutMs, remainingMs - 250)),
        maxAttempts: 2,
        extraHeaders: {
          ...(config.openrouterSiteUrl ? { "HTTP-Referer": config.openrouterSiteUrl } : {}),
          "X-Title": config.openrouterAppName
        }
      }, {
        deadlineAt
      });
      return withSemanticMeta(parsed, {
        decisionPath: `${parsed.semanticMeta?.decisionPath ?? "openrouter"}:${model}`
      });
    } catch (error) {
      lastError = error;
      const reason = classifyModelFailureReason(error);
      const isRetryable =
        reason === "provider_http_error" ||
        reason === "provider_timeout" ||
        reason === "provider_unknown_error";
      const hasNext = index < modelCandidates.length - 1;
      console.warn("[semantic] OpenRouter model candidate failed", {
        model,
        index: index + 1,
        total: modelCandidates.length,
        reason,
        raw: (error as Error).message,
        fallbackToNextModel: isRetryable && hasNext
      });
      if (!(isRetryable && hasNext)) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("OpenRouter 所有候选模型均失败");
}

async function parseWithGeminiThenOpenRouter(question: string): Promise<ParseResponse> {
  try {
    const geminiParsed = await parseWithOpenAICompatible(question, {
      providerName: "gemini",
      parserSource: "gemini",
      apiKey: config.geminiApiKey,
      baseUrl: config.geminiBaseUrl,
      model: config.geminiModel,
      timeoutMs: config.geminiTimeoutMs,
      maxAttempts: 3
    });
    return withSemanticMeta(geminiParsed, {
      decisionPath: geminiParsed.semanticMeta?.decisionPath ?? "gemini"
    });
  } catch (geminiError) {
    const geminiReason = classifyModelFailureReason(geminiError);
    const geminiDetail = buildModelFailureDetail(geminiError);
    console.warn("[semantic] Gemini 解析失败，尝试回退 OpenRouter:", {
      provider: "gemini",
      raw: (geminiError as Error).message,
      normalizedReason: geminiReason,
      detail: geminiDetail
    });

    try {
      const openrouterParsed = await parseWithOpenRouterCandidates(question);
      return withSemanticMeta(openrouterParsed, {
        decisionPath: `gemini->${openrouterParsed.semanticMeta?.decisionPath ?? "openrouter"}`
      });
    } catch (openrouterError) {
      const openrouterReason = classifyModelFailureReason(openrouterError);
      const openrouterDetail = buildModelFailureDetail(openrouterError);
      const chainedError = new Error(
        `gemini_failed(${geminiReason}): ${geminiDetail}; openrouter_failed(${openrouterReason}): ${openrouterDetail}`
      );
      throw chainedError;
    }
  }
}

async function chatWithOpenAICompatible(
  question: string,
  provider: OpenAICompatibleConfig
): Promise<GeneralChatResponse> {
  if (!provider.apiKey) {
    throw new Error(`${provider.providerName.toUpperCase()}_API_KEY 未配置`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), provider.timeoutMs);

  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
        ...(provider.extraHeaders ?? {})
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.5,
        messages: [
          { role: "system", content: GENERAL_CHAT_SYSTEM_PROMPT },
          { role: "user", content: question }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${provider.providerName} API 请求失败: ${response.status} ${body}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error(`${provider.providerName} 返回内容为空`);
    }

    return {
      summary: content,
      parserSource: provider.parserSource
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function isSpatialQuestion(question: string): Promise<boolean> {
  const decision = await detectSpatialIntentDecision(question.trim());
  console.info("[semantic-gate] decision", {
    gateScore: decision.gateScore,
    gateDecision: decision.gateDecision,
    gateReason: decision.gateReason,
    isFallback: false
  });
  return decision.isSpatial;
}

export async function parseQuestionSmart(
  question: string,
  options?: { assumeSpatial?: boolean }
): Promise<ParseResponse> {
  const gateFallbackDecision = computeSpatialGate(question).decision;
  if (!options?.assumeSpatial) {
    const gateDecision = await detectSpatialIntentDecision(question);
    console.info("[semantic-gate] decision", {
      gateScore: gateDecision.gateScore,
      gateDecision: gateDecision.gateDecision,
      gateReason: gateDecision.gateReason,
      isFallback: false
    });
    if (!gateDecision.isSpatial) {
      return withSemanticMeta(createNonSpatialParseResponse(), {
        retrievalHits: 0,
        modelAttempts: 0,
        repaired: false,
        decisionPath: "gate_non_spatial",
        gateDecision: gateDecision.gateDecision
      });
    }
  }

  const provider = config.llmProvider.trim().toLowerCase();
  if (provider === "rule") {
    return withSemanticMeta(withParserSource(parseQuestionByRules(question), "rule"), {
      retrievalHits: 0,
      modelAttempts: 0,
      repaired: false,
      decisionPath: "rule_direct",
      gateDecision: gateFallbackDecision
    });
  }

  if (provider === "gemini") {
    try {
      const parsed = await parseWithGeminiThenOpenRouter(question);
      return withSemanticMeta(parsed, {
        decisionPath: parsed.semanticMeta?.decisionPath ?? "gemini",
        gateDecision: parsed.semanticMeta?.gateDecision ?? gateFallbackDecision
      });
    } catch (error) {
      const reason = classifyModelFailureReason(error);
      const detail = buildModelFailureDetail(error);
      console.warn("[semantic] Gemini + OpenRouter 均失败，回退规则解析:", {
        provider: "gemini",
        raw: (error as Error).message,
        normalizedReason: reason,
        detail,
        isFallback: true
      });
      const fallback = withParserSource(parseQuestionByRules(question), "rule_fallback");
      await appendSemanticFailureRecord({
        question,
        parserFailureReason: reason,
        parserFailureDetail: detail,
        parserSource: "rule_fallback",
        providerChain: "gemini->openrouter",
        dsl: fallback.dsl
      });
      return {
        ...withSemanticMeta(fallback, {
          retrievalHits: 0,
          modelAttempts: 0,
          repaired: false,
          decisionPath: "gemini->openrouter->rule_fallback",
          gateDecision: gateFallbackDecision
        }),
        parserFailureReason: reason,
        parserFailureDetail: detail
      };
    }
  }

  if (provider === "groq") {
    try {
      const parsed = await parseWithOpenAICompatible(question, {
        providerName: "groq",
        parserSource: "groq",
        apiKey: config.groqApiKey,
        baseUrl: config.groqBaseUrl,
        model: config.groqModel,
        timeoutMs: config.groqTimeoutMs,
        maxAttempts: 3
      });
      return withSemanticMeta(parsed, {
        decisionPath: parsed.semanticMeta?.decisionPath ?? "groq",
        gateDecision: parsed.semanticMeta?.gateDecision ?? gateFallbackDecision
      });
    } catch (error) {
      const reason = classifyModelFailureReason(error);
      const detail = buildModelFailureDetail(error);
      console.warn("[semantic] Groq 解析失败，回退规则解析:", {
        provider: "groq",
        raw: (error as Error).message,
        normalizedReason: reason,
        detail,
        isFallback: true
      });
      const fallback = withParserSource(parseQuestionByRules(question), "rule_fallback");
      await appendSemanticFailureRecord({
        question,
        parserFailureReason: reason,
        parserFailureDetail: detail,
        parserSource: "rule_fallback",
        providerChain: "groq",
        dsl: fallback.dsl
      });
      return {
        ...withSemanticMeta(fallback, {
          retrievalHits: 0,
          modelAttempts: 0,
          repaired: false,
          decisionPath: "groq->rule_fallback",
          gateDecision: gateFallbackDecision
        }),
        parserFailureReason: reason,
        parserFailureDetail: detail
      };
    }
  }

  if (provider === "openrouter") {
    try {
      const parsed = await parseWithOpenRouterCandidates(question);
      return withSemanticMeta(parsed, {
        decisionPath: parsed.semanticMeta?.decisionPath ?? "openrouter",
        gateDecision: parsed.semanticMeta?.gateDecision ?? gateFallbackDecision
      });
    } catch (error) {
      const reason = classifyModelFailureReason(error);
      const detail = buildModelFailureDetail(error);
      console.warn("[semantic] OpenRouter 解析失败，回退规则解析:", {
        provider: "openrouter",
        raw: (error as Error).message,
        normalizedReason: reason,
        detail,
        isFallback: true
      });
      const fallback = withParserSource(parseQuestionByRules(question), "rule_fallback");
      await appendSemanticFailureRecord({
        question,
        parserFailureReason: reason,
        parserFailureDetail: detail,
        parserSource: "rule_fallback",
        providerChain: "openrouter",
        dsl: fallback.dsl
      });
      return {
        ...withSemanticMeta(fallback, {
          retrievalHits: 0,
          modelAttempts: 0,
          repaired: false,
          decisionPath: "openrouter->rule_fallback",
          gateDecision: gateFallbackDecision
        }),
        parserFailureReason: reason,
        parserFailureDetail: detail
      };
    }
  }

  console.warn(`[semantic] 未识别的 LLM_PROVIDER=${provider}，已回退规则解析`);
  return withSemanticMeta(withParserSource(parseQuestionByRules(question), "rule"), {
    retrievalHits: 0,
    modelAttempts: 0,
    repaired: false,
    decisionPath: "unknown_provider->rule",
    gateDecision: gateFallbackDecision
  });
}

export async function answerGeneralQuestion(question: string): Promise<GeneralChatResponse> {
  const provider = config.llmProvider.trim().toLowerCase();
  if (provider === "gemini") {
    try {
      return await chatWithOpenAICompatible(question, {
        providerName: "gemini",
        parserSource: "gemini",
        apiKey: config.geminiApiKey,
        baseUrl: config.geminiBaseUrl,
        model: config.geminiModel,
        timeoutMs: config.geminiTimeoutMs,
        maxAttempts: 3
      });
    } catch (geminiError) {
      console.warn("[chat] Gemini 对话失败，尝试 OpenRouter:", (geminiError as Error).message);
      try {
        return await chatWithOpenAICompatible(question, {
          providerName: "openrouter",
          parserSource: "openrouter",
          apiKey: config.openrouterApiKey,
          baseUrl: config.openrouterBaseUrl,
          model: config.openrouterModel,
          timeoutMs: config.openrouterTimeoutMs,
          extraHeaders: {
            ...(config.openrouterSiteUrl ? { "HTTP-Referer": config.openrouterSiteUrl } : {}),
            "X-Title": config.openrouterAppName
          }
        });
      } catch (openrouterError) {
        console.warn("[chat] OpenRouter 对话失败，回退默认回复:", (openrouterError as Error).message);
        return {
          summary: "你好，我是空间查询助手。你也可以直接问我空间问题，例如“鼓楼区公园有多少个”。",
          parserSource: "rule_fallback"
        };
      }
    }
  }

  if (provider === "groq") {
    try {
      return await chatWithOpenAICompatible(question, {
        providerName: "groq",
        parserSource: "groq",
        apiKey: config.groqApiKey,
        baseUrl: config.groqBaseUrl,
        model: config.groqModel,
        timeoutMs: config.groqTimeoutMs
      });
    } catch (error) {
      console.warn("[chat] Groq 对话失败，回退默认回复:", (error as Error).message);
      return {
        summary: "你好，我是空间查询助手。你也可以直接问我空间问题，例如“鼓楼区公园有多少个”。",
        parserSource: "rule_fallback"
      };
    }
  }

  if (provider === "openrouter") {
    try {
      return await chatWithOpenAICompatible(question, {
        providerName: "openrouter",
        parserSource: "openrouter",
        apiKey: config.openrouterApiKey,
        baseUrl: config.openrouterBaseUrl,
        model: config.openrouterModel,
        timeoutMs: config.openrouterTimeoutMs,
        extraHeaders: {
          ...(config.openrouterSiteUrl ? { "HTTP-Referer": config.openrouterSiteUrl } : {}),
          "X-Title": config.openrouterAppName
        }
      });
    } catch (error) {
      console.warn("[chat] OpenRouter 对话失败，回退默认回复:", (error as Error).message);
      return {
        summary: "你好，我是空间查询助手。你也可以直接问我空间问题，例如“鼓楼区公园有多少个”。",
        parserSource: "rule_fallback"
      };
    }
  }

  return {
    summary: "你好，我是空间查询助手。你也可以直接问我空间问题，例如“鼓楼区公园有多少个”。",
    parserSource: providerToSource(provider)
  };
}
