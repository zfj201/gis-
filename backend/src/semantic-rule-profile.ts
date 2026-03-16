import type { LayerDescriptor, ParseResponse, SpatialQueryDSL } from "@gis/shared";
import type { AnalysisDslV2, AnalysisFamily, RuleProfile } from "./analysis-dsl-v2.js";
import { adaptAnalysisDslV2ToLegacy, liftLegacyDslToAnalysisDslV2 } from "./analysis-dsl-adapter.js";
import { areOperatorsLegacyCompatible, validateAnalysisDslOperators } from "./operator-registry.js";
import { parseQuestion as parseQuestionByRules } from "./semantic.js";
import { findCountyField, resolveTargetLayer } from "./semantic-routing.js";

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s_\-/:;,.，。、“”"'`()（）【】\[\]]+/g, "");
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function buildCandidateLayers(keys: string[]): Array<Pick<LayerDescriptor, "layerKey" | "name" | "geometryType">> {
  return unique(keys)
    .map((layerKey) => resolveTargetLayer(layerKey, layerKey).layer)
    .filter((layer): layer is LayerDescriptor => Boolean(layer))
    .map((layer) => ({
      layerKey: layer.layerKey,
      name: layer.name,
      geometryType: layer.geometryType
    }));
}

function pickFieldHints(layerKey: string | null): string[] {
  const layer = layerKey ? resolveTargetLayer(layerKey, layerKey).layer : null;
  if (!layer) {
    return [];
  }
  return layer.fields.filter((field) => field.queryable).slice(0, 8).map((field) => field.name);
}

function matchFieldByQuestion(layer: LayerDescriptor, question: string): string | null {
  const normalizedQuestion = normalizeText(question);
  const sortedFields = layer.fields
    .filter((field) => field.queryable)
    .map((field) => field.name)
    .sort((a, b) => b.length - a.length);

  for (const fieldName of sortedFields) {
    const normalizedField = normalizeText(fieldName);
    if (normalizedField && normalizedQuestion.includes(normalizedField)) {
      return fieldName;
    }
  }
  return null;
}

function extractGroupDimension(question: string): string {
  const direct = question.match(/(?:按|按照|以|基于)(.+?)(?:统计|分组|汇总)/);
  if (direct?.[1]) {
    return direct[1].replace(/数量|个数|多少|分别|道路街巷|公园|门牌号码/g, "").trim();
  }
  const dimension = question.match(/(.+?)维度/);
  if (dimension?.[1]) {
    return dimension[1].replace(/数量|个数|多少|分别/g, "").trim();
  }
  return "";
}

function shouldUseOverlayProfile(question: string): boolean {
  return /(裁剪|裁出|剪出|擦除|扣除|去除|融合|融并|溶解|联合|合并图层|交集|相交部分)/.test(question);
}

function buildOverlayProfile(question: string): RuleProfile {
  let lockedOp: AnalysisDslV2["analysisPipeline"][number]["op"] = "intersect_overlay";
  let reason = "需要明确两个几何输入对象后才能执行叠加分析。";
  if (/裁剪|裁出|剪出/.test(question)) {
    lockedOp = "clip";
    reason = "clip 需要目标图层和裁剪图层/几何。";
  } else if (/擦除|扣除|去除/.test(question)) {
    lockedOp = "erase";
    reason = "erase 需要目标图层和擦除图层/几何。";
  } else if (/融合|融并|溶解/.test(question)) {
    lockedOp = "dissolve";
    reason = "dissolve 需要目标图层，且通常还需要分组字段。";
  } else if (/联合|合并图层/.test(question)) {
    lockedOp = "union_overlay";
    reason = "union 需要至少两个图层输入。";
  }

  const analysisDsl: AnalysisDslV2 = {
    goal: "overlay",
    primaryLayer: null,
    sourceLayers: [],
    analysisPipeline: [
      {
        op: lockedOp,
        inputs: [],
        params: {},
        resultRef: "overlay_result",
        visualize: true
      }
    ],
    output: {
      mode: "geometry",
      visualMode: "derived_geometry",
      returnGeometry: true
    },
    clarification: {
      actionable: false,
      followUpQuestion: `已识别为 ${lockedOp} 叠加分析。${reason} 当前执行器尚未开放叠加算子，请先确认图层与规则后再接执行。`,
      missingSlots: ["primaryLayer", "sourceGeometry"],
      reason
    }
  };

  return {
    analysisFamily: "overlay",
    goal: "overlay",
    lockedOperators: [lockedOp],
    lockedOutputPolicy: analysisDsl.output,
    requiredSlots: ["primaryLayer", "sourceGeometry"],
    forbiddenMutations: ["analysisFamily", "analysisPipeline", "output.visualMode"],
    candidateLayers: [],
    fieldHints: [],
    clarificationTriggers: ["overlay_execution_not_ready"],
    actionable: false,
    followUpQuestion: analysisDsl.clarification.followUpQuestion,
    analysisDsl,
    legacySeedDsl: null
  };
}

function strengthenRuleDsl(question: string, parsed: ParseResponse): SpatialQueryDSL {
  const nextDsl = JSON.parse(JSON.stringify(parsed.dsl)) as SpatialQueryDSL;
  const targetLayer = resolveTargetLayer(question, nextDsl.targetLayer).layer;
  if (!targetLayer) {
    return nextDsl;
  }

  const dimension = extractGroupDimension(question);
  const matchedField =
    (dimension ? matchFieldByQuestion(targetLayer, dimension) : null) ??
    ((/按.+统计|按.+分组|按.+汇总/.test(question) || /维度/.test(question))
      ? matchFieldByQuestion(targetLayer, question)
      : null);
  if (matchedField) {
    nextDsl.intent = "group_stat";
    nextDsl.aggregation = {
      type: "group_count",
      groupBy: [matchedField]
    };
    nextDsl.output.returnGeometry = false;
    nextDsl.sort = {
      by: matchedField,
      order: "asc"
    };
    nextDsl.orderBy = [{
      field: matchedField,
      direction: "asc"
    }];
  } else if (nextDsl.intent === "group_stat" && (!nextDsl.aggregation?.groupBy || nextDsl.aggregation.groupBy.length === 0)) {
    const countyField = findCountyField(targetLayer);
    if (countyField) {
      nextDsl.aggregation = {
        type: "group_count",
        groupBy: [countyField]
      };
    }
  }

  return nextDsl;
}

function buildRequiredSlots(dsl: SpatialQueryDSL, followUpQuestion: string | null): string[] {
  const required: string[] = [];
  if (!dsl.targetLayer) {
    required.push("primaryLayer");
  }
  if (dsl.intent === "nearest" && !dsl.spatialFilter?.center && !dsl.spatialFilter?.sourceLayer) {
    required.push("nearestSource");
  }
  if (dsl.intent === "buffer_search" && !dsl.spatialFilter?.center && !dsl.spatialFilter?.sourceLayer) {
    required.push("bufferSource");
  }
  if (dsl.intent === "group_stat" && (!dsl.aggregation?.groupBy || dsl.aggregation.groupBy.length === 0)) {
    required.push("groupByField");
  }
  if (followUpQuestion) {
    required.push("clarification");
  }
  return unique(required);
}

function buildForbiddenMutations(dsl: SpatialQueryDSL): string[] {
  const forbidden = ["targetLayer", "intent", "output.returnGeometry"];
  if (dsl.aggregation?.type) {
    forbidden.push("aggregation.type");
  }
  if (dsl.aggregation?.groupBy?.length) {
    forbidden.push("aggregation.groupBy");
  }
  if (dsl.spatialFilter?.center) {
    forbidden.push("spatialFilter.center");
  }
  if (dsl.spatialFilter?.sourceLayer) {
    forbidden.push("spatialFilter.sourceLayer");
  }
  if (dsl.spatialFilter?.type) {
    forbidden.push("spatialFilter.type");
  }
  return forbidden;
}

function buildAutoFollowUpQuestion(requiredSlots: string[], operatorProblems: string[]): string | null {
  if (requiredSlots.includes("primaryLayer")) {
    return "请先明确要分析的目标图层，例如道路街巷、门牌号码、宗地院落或公园。";
  }
  if (requiredSlots.includes("bufferSource") || operatorProblems.some((item) => item.includes("buffer"))) {
    return "当前缓冲分析缺少几何来源，请补充中心坐标或来源要素条件，例如“标准名称等于南二环的道路街巷100米内的门牌号码”。";
  }
  if (requiredSlots.includes("nearestSource")) {
    return "当前最近邻分析缺少来源对象，请补充中心点或来源要素条件。";
  }
  if (requiredSlots.includes("groupByField")) {
    return "请说明要按哪个字段分组统计，例如按道路级别、行政区划或所在乡镇。";
  }
  return null;
}

export function buildRuleProfile(question: string): RuleProfile {
  if (shouldUseOverlayProfile(question)) {
    return buildOverlayProfile(question);
  }

  const ruleParsed = parseQuestionByRules(question);
  const strengthenedDsl = strengthenRuleDsl(question, ruleParsed);
  const analysisDsl = liftLegacyDslToAnalysisDslV2(strengthenedDsl);
  const candidateLayerKeys = [
    strengthenedDsl.targetLayer,
    ...(strengthenedDsl.spatialFilter?.sourceLayer ? [strengthenedDsl.spatialFilter.sourceLayer] : [])
  ].filter(Boolean);
  const lockedOperators = unique(analysisDsl.analysisPipeline.map((step) => step.op));
  const requiredSlots = buildRequiredSlots(strengthenedDsl, ruleParsed.followUpQuestion ?? null);
  const operatorProblems = validateAnalysisDslOperators(analysisDsl);
  const followUpQuestion =
    ruleParsed.followUpQuestion ??
    buildAutoFollowUpQuestion(requiredSlots, operatorProblems);
  const actionable =
    requiredSlots.filter((slot) => slot !== "clarification").length === 0 &&
    operatorProblems.length === 0 &&
    !followUpQuestion &&
    areOperatorsLegacyCompatible(lockedOperators);

  return {
    analysisFamily:
      lockedOperators.includes("nearest")
        ? "nearest"
        : lockedOperators.includes("multi_ring_stat")
          ? "multi_ring"
          : lockedOperators.includes("spatial_join_count")
            ? "spatial_join"
            : lockedOperators.includes("buffer")
              ? "buffer"
              : lockedOperators.includes("spatial_predicate")
                ? "relation"
                : lockedOperators.includes("aggregate_count") || lockedOperators.includes("aggregate_group") || lockedOperators.includes("distinct")
                  ? "aggregate"
                  : "attribute_retrieve",
    goal: analysisDsl.goal,
    lockedOperators,
    lockedOutputPolicy: analysisDsl.output,
    requiredSlots,
    forbiddenMutations: buildForbiddenMutations(strengthenedDsl),
    candidateLayers: buildCandidateLayers(candidateLayerKeys),
    fieldHints: pickFieldHints(strengthenedDsl.targetLayer),
    clarificationTriggers: unique([
      ...(followUpQuestion ? ["rule_follow_up"] : []),
      ...(operatorProblems.length > 0 ? ["operator_validation"] : [])
    ]),
    actionable,
    followUpQuestion,
    analysisDsl,
    legacySeedDsl: strengthenedDsl,
    legacySeedFilterExpr: strengthenedDsl.filterExpr
  };
}

export function buildRuleProfileFallbackResponse(profile: RuleProfile): ParseResponse | null {
  if (!profile.followUpQuestion) {
    return null;
  }

  if (profile.legacySeedDsl) {
    return {
      dsl: profile.legacySeedDsl,
      confidence: 0.7,
      followUpQuestion: profile.followUpQuestion,
      parserSource: "rule",
      semanticWarnings: ["规则骨架判定当前仍需澄清，已跳过模型补全。"]
    };
  }

  const adapted = adaptAnalysisDslV2ToLegacy(profile.analysisDsl);
  if (adapted.dsl) {
    return {
      dsl: adapted.dsl,
      confidence: 0.65,
      followUpQuestion: profile.followUpQuestion,
      parserSource: "rule",
      semanticWarnings: ["规则骨架已识别分析意图，但当前未进入可执行状态。"]
    };
  }

  return null;
}

export function validateRuleProfileConsistency(profile: RuleProfile, parsed: ParseResponse): string[] {
  const problems: string[] = [];
  if (!parsed.dsl) {
    return problems;
  }

  const normalizedProfileDsl = profile.legacySeedDsl;
  if (normalizedProfileDsl?.targetLayer && parsed.dsl.targetLayer !== normalizedProfileDsl.targetLayer) {
    problems.push("targetLayer 与规则骨架冲突");
  }
  if (normalizedProfileDsl?.intent && parsed.dsl.intent !== normalizedProfileDsl.intent) {
    problems.push("intent 与规则骨架冲突");
  }
  if ((normalizedProfileDsl?.aggregation?.type ?? null) !== (parsed.dsl.aggregation?.type ?? null)) {
    problems.push("aggregation.type 与规则骨架冲突");
  }
  if (normalizedProfileDsl?.output.returnGeometry !== parsed.dsl.output.returnGeometry) {
    problems.push("output.returnGeometry 与规则骨架冲突");
  }
  if ((normalizedProfileDsl?.spatialFilter?.type ?? null) !== (parsed.dsl.spatialFilter?.type ?? null)) {
    problems.push("spatialFilter.type 与规则骨架冲突");
  }
  if ((normalizedProfileDsl?.spatialFilter?.sourceLayer ?? null) !== (parsed.dsl.spatialFilter?.sourceLayer ?? null)) {
    problems.push("spatialFilter.sourceLayer 与规则骨架冲突");
  }
  if ((normalizedProfileDsl?.aggregation?.groupBy?.[0] ?? null) !== (parsed.dsl.aggregation?.groupBy?.[0] ?? null)) {
    if (normalizedProfileDsl?.aggregation?.groupBy?.length) {
      problems.push("aggregation.groupBy 与规则骨架冲突");
    }
  }

  const parsedOperators = unique(liftLegacyDslToAnalysisDslV2(parsed.dsl).analysisPipeline.map((step) => step.op));
  if (parsedOperators.join("|") !== profile.lockedOperators.join("|")) {
    problems.push("analysisPipeline 与规则骨架冲突");
  }

  return problems;
}
