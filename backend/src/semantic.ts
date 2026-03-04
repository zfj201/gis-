import {
  type FilterExprNode,
  type LayerDescriptor,
  type ParseResponse,
  type SpatialQueryDSL,
  spatialQueryDslSchema
} from "@gis/shared";
import { config } from "./config.js";
import { buildCandidateLayerText, layerRegistry } from "./layer-registry.js";
import { parseTopLimitFromQuestion, stripTopLimitPhrase } from "./semantic-limit.js";
import { inferMatchPreference, normalizeDslByQuestion } from "./semantic-normalizer.js";
import { defaultOutputFields, findCountyField, findNameField, resolveTargetLayer } from "./semantic-routing.js";

const countyPattern =
  /(鼓楼区|仓山区|台江区|晋安区|马尾区|长乐区|闽侯县|连江县|罗源县|闽清县|永泰县|福清市|平潭县)/;

const coordinatePatterns = [
  /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/,
  /x\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*[，,\s]+y\s*[:：]\s*(-?\d+(?:\.\d+)?)/i
];

function parseRadiusMeters(question: string): number | undefined {
  const match = question.match(/(\d+(?:\.\d+)?)\s*(km|公里|千米|m|米)/i);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (Number.isNaN(value)) {
    return undefined;
  }

  if (unit === "km" || unit === "公里" || unit === "千米") {
    return Math.round(value * 1000);
  }
  return Math.round(value);
}

function parseCoordinate(question: string): { x: number; y: number } | undefined {
  for (const pattern of coordinatePatterns) {
    const match = question.match(pattern);
    if (match) {
      const x = Number(match[1]);
      const y = Number(match[2]);
      if (!Number.isNaN(x) && !Number.isNaN(y)) {
        return { x, y };
      }
    }
  }
  return undefined;
}

function geometryKindFromLayer(layer: LayerDescriptor): "point" | "line" | "polygon" | "unknown" {
  if (/point/i.test(layer.geometryType)) {
    return "point";
  }
  if (/polyline|line/i.test(layer.geometryType)) {
    return "line";
  }
  if (/polygon|area/i.test(layer.geometryType)) {
    return "polygon";
  }
  return "unknown";
}

function geometryHintFromText(text: string): "point" | "line" | "polygon" | null {
  if (/(点|点位|门牌|poi)/i.test(text)) {
    return "point";
  }
  if (/(线|道路|街巷|路)/i.test(text)) {
    return "line";
  }
  if (/(面|片区|地块|院落|宗地|区域)/i.test(text)) {
    return "polygon";
  }
  return null;
}

function chooseLayerByHint(
  text: string,
  hint: "point" | "line" | "polygon" | null
): { layer: LayerDescriptor | null; followUpQuestion: string | null } {
  const resolved = resolveTargetLayer(text);
  if (resolved.layer) {
    if (!hint || geometryKindFromLayer(resolved.layer) === hint) {
      return {
        layer: resolved.layer,
        followUpQuestion: resolved.followUpQuestion
      };
    }
  }

  const queryable = layerRegistry.listCatalog().layers.filter((item) => item.queryable);
  const hinted = hint ? queryable.filter((item) => geometryKindFromLayer(item) === hint) : queryable;
  if (hinted.length === 1) {
    return {
      layer: hinted[0],
      followUpQuestion: null
    };
  }
  if (hinted.length > 1) {
    return {
      layer: null,
      followUpQuestion: `识别到多个${hint === "point" ? "点" : hint === "line" ? "线" : "面"}图层：${buildCandidateLayerText(
        hinted.slice(0, 8)
      )}。请明确图层名称。`
    };
  }

  return {
    layer: null,
    followUpQuestion:
      resolved.followUpQuestion ??
      (hint
        ? `未找到可用${hint === "point" ? "点" : hint === "line" ? "线" : "面"}图层，请先添加对应图层。`
        : "未找到可用图层。")
  };
}

function inferIntent(question: string): SpatialQueryDSL["intent"] {
  if (
    /(按|按照|以|基于).*(区县|行政区划|县级政区|乡镇|维度).*(统计|分组|汇总)|各(区县|行政区划|乡镇).*(数量|个数|分布|多少)|各区县分别有多少|(?:区县|行政区划).*(维度|分组|分布|汇总)/.test(
      question
    )
  ) {
    return "group_stat";
  }
  if (/多少|几个|总数|数量/.test(question)) {
    return "count";
  }
  if (/(最近|nearest)/i.test(question)) {
    return "nearest";
  }
  if (/附近|周边|以内|内/.test(question)) {
    return "buffer_search";
  }
  return "search";
}

function parseNearestClause(
  question: string
): {
  sourcePart: string;
  targetPart: string;
} | null {
  const cleaned = question.trim();
  if (!cleaned) {
    return null;
  }

  const regex = /(.+?)\s*(?:最近的?|nearest)\s*(.+)/i;
  const match = cleaned.match(regex);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const sourcePart = match[1].trim();
  const targetPart = stripTopLimitPhrase(match[2].trim());

  if (!sourcePart || !targetPart) {
    return null;
  }

  return { sourcePart, targetPart };
}

function locationTypeFromHint(
  hint: "point" | "line" | "polygon" | null
): "point" | "road" | "subdistrict" | "county" | "unknown" {
  if (hint === "point") {
    return "point";
  }
  if (hint === "line") {
    return "road";
  }
  if (hint === "polygon") {
    return "subdistrict";
  }
  return "unknown";
}

function parseKeyword(question: string): string | undefined {
  const quoteMatch = question.match(/[“\"]([^\"”]+)[”\"]/);
  if (quoteMatch?.[1]) {
    return quoteMatch[1].trim();
  }

  const keywordMatch = question.match(/(?:名称|地址|标准名称|门牌号码).*?(?:是|为|包含)?\s*([\u4e00-\u9fa5a-zA-Z0-9]+)/);
  return keywordMatch?.[1]?.trim();
}

function buildFieldLookup(fields: string[]): Map<string, string> {
  const lookup = new Map<string, string>();
  const lowered = new Set(fields.map((field) => field.toLowerCase()));

  for (const field of fields) {
    lookup.set(field.toLowerCase(), field);
  }

  if (lowered.has("shape__area")) {
    for (const synonym of ["面积", "占地面积", "面積", "area"]) {
      lookup.set(synonym.toLowerCase(), "SHAPE__Area");
    }
  }

  if (lowered.has("shape__length")) {
    for (const synonym of ["长度", "周长", "边长", "length"]) {
      lookup.set(synonym.toLowerCase(), "SHAPE__Length");
    }
  }

  if (lowered.has("objectid")) {
    for (const synonym of ["objectid", "OBJECTID", "编号", "id"]) {
      lookup.set(synonym.toLowerCase(), "objectid");
    }
  }

  return lookup;
}

function parseOperatorByToken(token: string): SpatialQueryDSL["attributeFilter"][number]["operator"] {
  const value = token.trim();
  if (!value) {
    return "=";
  }
  if (/(大于等于|不少于|至少|>=)/i.test(value)) {
    return ">=";
  }
  if (/(小于等于|不超过|至多|<=)/i.test(value)) {
    return "<=";
  }
  if (/(大于|高于|多于|以上|超过|>)/i.test(value)) {
    return ">";
  }
  if (/(小于|低于|少于|以下|<)/i.test(value)) {
    return "<";
  }
  if (/(包含|含有|相关|like)/i.test(value)) {
    return "like";
  }
  return "=";
}

function extractExplicitFieldCondition(
  question: string,
  fields: string[]
): { field: string; value: string; operator: SpatialQueryDSL["attributeFilter"][number]["operator"] } | null {
  const fieldLookup = buildFieldLookup(fields);
  const lexicalFields = [...new Set([...fields, "面积", "占地面积", "面積", "area", "长度", "周长", "边长", "length", "OBJECTID", "objectid", "编号", "id"])].sort(
    (a, b) => b.length - a.length
  );

  for (const fieldToken of lexicalFields) {
    const field = fieldLookup.get(fieldToken.toLowerCase());
    if (!field) {
      continue;
    }
    const escaped = fieldToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = question.match(
      new RegExp(
        `${escaped}\\s*(?:的)?\\s*(小于等于|不超过|至多|大于等于|不少于|至少|小于|低于|少于|以下|大于|高于|多于|以上|超过|为|等于|就是|是|包含|含有|相关|类似|>=|<=|>|<|:|：)\\s*[“"']?([^，。！？!?]+)`,
        "i"
      )
    );
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const rawValue = match[2].trim();
    if (!rawValue) {
      continue;
    }

    const preference = parseOperatorByToken(match[1]) ?? inferMatchPreference(question);
    return {
      field,
      value: rawValue,
      operator: preference ?? "="
    };
  }

  return null;
}

type LogicConnector = "and" | "or";
type FlatCondition = SpatialQueryDSL["attributeFilter"][number];

interface ConditionExprParseResult {
  expr: FilterExprNode | null;
  flatConditions: FlatCondition[];
  warnings: string[];
}

function connectorToLogic(connector: string): LogicConnector {
  if (/(或|或者)/.test(connector)) {
    return "or";
  }
  return "and";
}

function hasConditionSignal(text: string): boolean {
  return /(小于等于|不超过|至多|大于等于|不少于|至少|小于|低于|少于|以下|大于|高于|多于|以上|超过|为|等于|就是|是|包含|含有|相关|类似|>=|<=|>|<|:|：)/i.test(
    text
  );
}

function splitLogicalSegments(text: string): { segments: string[]; connectors: LogicConnector[] } {
  const tokens = text
    .split(/(并且|或者|且|或|、|，|,|和|并)/)
    .map((item) => item.trim())
    .filter(Boolean);
  const segments: string[] = [];
  const connectors: LogicConnector[] = [];
  let pendingConnector: LogicConnector | null = null;

  for (const token of tokens) {
    if (/^(并且|或者|且|或|、|，|,|和|并)$/.test(token)) {
      pendingConnector = connectorToLogic(token);
      continue;
    }

    if (segments.length > 0) {
      connectors.push(pendingConnector ?? "and");
    }
    pendingConnector = null;
    segments.push(token);
  }

  return {
    segments,
    connectors
  };
}

function conditionToExpr(condition: FlatCondition): FilterExprNode {
  return {
    kind: "condition",
    field: condition.field,
    operator: condition.operator,
    value: condition.value
  };
}

function mergeExprByLogic(logic: LogicConnector, left: FilterExprNode, right: FilterExprNode): FilterExprNode {
  const mergedChildren: FilterExprNode[] = [];
  const pushNode = (node: FilterExprNode): void => {
    if (node.kind === "group" && node.logic === logic) {
      mergedChildren.push(...node.children);
      return;
    }
    mergedChildren.push(node);
  };
  pushNode(left);
  pushNode(right);
  if (mergedChildren.length === 1) {
    return mergedChildren[0];
  }
  return {
    kind: "group",
    logic,
    children: mergedChildren
  };
}

function buildExprWithAndPriority(nodes: FilterExprNode[], connectors: LogicConnector[]): FilterExprNode {
  if (nodes.length === 1) {
    return nodes[0];
  }

  const normalizedConnectors: LogicConnector[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    normalizedConnectors.push(connectors[i] ?? "and");
  }

  const orParts: FilterExprNode[] = [];
  let current = nodes[0];
  for (let i = 0; i < normalizedConnectors.length; i += 1) {
    const connector = normalizedConnectors[i];
    const next = nodes[i + 1];
    if (connector === "and") {
      current = mergeExprByLogic("and", current, next);
    } else {
      orParts.push(current);
      current = next;
    }
  }
  orParts.push(current);

  if (orParts.length === 1) {
    return orParts[0];
  }
  return {
    kind: "group",
    logic: "or",
    children: orParts
  };
}

function parseConditionExprByFields(questionText: string, fields: string[]): ConditionExprParseResult {
  const { segments, connectors } = splitLogicalSegments(questionText);
  const parsedConditions: FlatCondition[] = [];
  const parsedNodes: FilterExprNode[] = [];
  const parsedConnectors: LogicConnector[] = [];
  const warnings: string[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const condition = extractExplicitFieldCondition(segment, fields);
    if (!condition) {
      if (hasConditionSignal(segment)) {
        warnings.push(`未识别条件片段：${segment}`);
      }
      continue;
    }
    const filter: FlatCondition = {
      field: condition.field,
      operator: condition.operator,
      value: condition.value
    };
    if (parsedNodes.length > 0) {
      parsedConnectors.push(connectors[index - 1] ?? "and");
    }
    parsedConditions.push(filter);
    parsedNodes.push(conditionToExpr(filter));
  }

  if (parsedNodes.length === 0) {
    return {
      expr: null,
      flatConditions: [],
      warnings
    };
  }

  return {
    expr: buildExprWithAndPriority(parsedNodes, parsedConnectors),
    flatConditions: parsedConditions,
    warnings
  };
}

function appendConditionToExpr(
  currentExpr: FilterExprNode | undefined,
  condition: FlatCondition
): FilterExprNode {
  const conditionExpr = conditionToExpr(condition);
  if (!currentExpr) {
    return conditionExpr;
  }
  return mergeExprByLogic("and", currentExpr, conditionExpr);
}

function extractSourceFilters(questionPart: string, sourceLayer: LayerDescriptor): {
  sourceAttributeFilter: SpatialQueryDSL["attributeFilter"];
  sourceFilterExpr?: FilterExprNode;
  warnings: string[];
} {
  const fields = sourceLayer.fields.filter((field) => field.queryable).map((field) => field.name);
  const parsed = parseConditionExprByFields(questionPart, fields);
  if (parsed.expr) {
    return {
      sourceAttributeFilter: parsed.flatConditions,
      sourceFilterExpr: parsed.expr,
      warnings: parsed.warnings
    };
  }

  const quoteMatch = questionPart.match(/[“"]([^"”]+)[”"]/);
  const nameField = findNameField(sourceLayer);
  if (quoteMatch?.[1] && nameField) {
    const quoteFilter: FlatCondition = {
      field: nameField,
      operator: "=",
      value: quoteMatch[1].trim()
    };
    return {
      sourceAttributeFilter: [quoteFilter],
      sourceFilterExpr: conditionToExpr(quoteFilter),
      warnings: parsed.warnings
    };
  }

  return {
    sourceAttributeFilter: [],
    warnings: parsed.warnings
  };
}

function mergeWarnings(...warningGroups: Array<string[] | undefined>): string[] | undefined {
  const values = warningGroups
    .flat()
    .filter((item): item is string => Boolean(item && item.trim().length > 0));
  if (values.length === 0) {
    return undefined;
  }
  return Array.from(new Set(values));
}

function withWarnings(response: ParseResponse, warnings: string[] | undefined): ParseResponse {
  if (!warnings || warnings.length === 0) {
    return response;
  }
  return {
    ...response,
    semanticWarnings: warnings
  };
}

function parseTargetFilterExpr(
  questionText: string,
  layer: LayerDescriptor
): ConditionExprParseResult {
  const fields = layer.fields.filter((field) => field.queryable).map((field) => field.name);
  return parseConditionExprByFields(questionText, fields);
}

function ensureFilterCompatibility(
  dsl: SpatialQueryDSL,
  flatConditions: FlatCondition[]
): void {
  dsl.attributeFilter = flatConditions;
}

function parseCrossLayerBuffer(
  question: string
): {
  sourcePart: string;
  targetPart: string;
  radiusMeters: number;
} | null {
  const match = question.match(/(.+?)\s*(\d+(?:\.\d+)?)\s*(km|公里|千米|m|米)\s*(?:以内|内)\s*的?\s*(.+)/i);
  if (!match?.[1] || !match[4]) {
    return null;
  }
  const radius = parseRadiusMeters(`${match[2]}${match[3]}`);
  if (!radius || radius <= 0) {
    return null;
  }
  return {
    sourcePart: match[1].trim(),
    targetPart: match[4].trim(),
    radiusMeters: radius
  };
}

function createBaseDsl(layerKey: string, fields: string[]): SpatialQueryDSL {
  return {
    intent: "search",
    targetLayer: layerKey,
    attributeFilter: [],
    aggregation: null,
    limit: config.queryMaxFeatures,
    output: {
      fields,
      returnGeometry: true
    }
  };
}

export function parseQuestion(question: string): ParseResponse {
  const normalized = question.trim();
  const nearestClause = parseNearestClause(normalized);
  if (nearestClause) {
    const requestedLimit = parseTopLimitFromQuestion(normalized, config.nearestMaxK);
    const nearestLimit = requestedLimit ?? Math.max(1, config.nearestDefaultK);
    const sourceCoordinate = parseCoordinate(nearestClause.sourcePart) ?? parseCoordinate(normalized);
    const targetHint = geometryHintFromText(nearestClause.targetPart);
    const targetResolved = chooseLayerByHint(nearestClause.targetPart, targetHint);

    if (!targetResolved.layer) {
      const fallbackDsl = spatialQueryDslSchema.parse({
        intent: "nearest",
        targetLayer: (targetResolved.layer ?? layerRegistry.getDefaultLayer())?.layerKey ?? "fuzhou_parks",
        attributeFilter: [],
        aggregation: null,
        limit: nearestLimit,
        output: {
          fields: [],
          returnGeometry: true
        },
        spatialFilter: {
          type: "nearest"
        }
      });
      return {
        dsl: fallbackDsl,
        confidence: 0.55,
        followUpQuestion: targetResolved.followUpQuestion ?? "请明确要查询最近邻的目标图层。",
        parserSource: "rule"
      };
    }

    if (sourceCoordinate) {
      const nearestByCenterDsl = spatialQueryDslSchema.parse({
        intent: "nearest",
        targetLayer: targetResolved.layer.layerKey,
        attributeFilter: [],
        aggregation: null,
        limit: nearestLimit,
        output: {
          fields: defaultOutputFields(targetResolved.layer),
          returnGeometry: true
        },
        spatialFilter: {
          type: "nearest",
          center: {
            x: sourceCoordinate.x,
            y: sourceCoordinate.y,
            spatialReference: { wkid: 3857 }
          }
        },
        locationEntity: {
          rawText: `${sourceCoordinate.x},${sourceCoordinate.y}`,
          type: "point",
          resolution: "resolved"
        }
      });
      const normalizedResult = normalizeDslByQuestion(normalized, nearestByCenterDsl);
      return {
        dsl: normalizedResult.dsl,
        confidence: 0.9,
        followUpQuestion: null,
        parserSource: "rule",
        normalizedByRule: normalizedResult.normalized
      };
    }

    const sourceHint = geometryHintFromText(nearestClause.sourcePart);
    const sourceResolved = chooseLayerByHint(nearestClause.sourcePart, sourceHint);
    if (!sourceResolved.layer) {
      const fallbackDsl = spatialQueryDslSchema.parse({
        intent: "nearest",
        targetLayer: targetResolved.layer.layerKey,
        attributeFilter: [],
        aggregation: null,
        limit: nearestLimit,
        output: {
          fields: defaultOutputFields(targetResolved.layer),
          returnGeometry: true
        },
        spatialFilter: {
          type: "nearest"
        }
      });
      return {
        dsl: fallbackDsl,
        confidence: 0.6,
        followUpQuestion: sourceResolved.followUpQuestion ?? "请明确最近邻的源图层。",
        parserSource: "rule"
      };
    }

    const sourceFilterResult = extractSourceFilters(nearestClause.sourcePart, sourceResolved.layer);
    if (!sourceFilterResult.sourceAttributeFilter.length) {
      const noFilterDsl = spatialQueryDslSchema.parse({
        intent: "nearest",
        targetLayer: targetResolved.layer.layerKey,
        attributeFilter: [],
        aggregation: null,
        limit: nearestLimit,
        output: {
          fields: defaultOutputFields(targetResolved.layer),
          returnGeometry: true
        },
        spatialFilter: {
          type: "nearest",
          sourceLayer: sourceResolved.layer.layerKey,
          sourceAttributeFilter: []
        }
      });
      return withWarnings({
        dsl: noFilterDsl,
        confidence: 0.68,
        followUpQuestion: `请明确源要素条件（当前源图层：${sourceResolved.layer.name}），例如“OBJECTID为45854的${sourceResolved.layer.name}最近的${targetResolved.layer.name}”。`,
        parserSource: "rule"
      }, sourceFilterResult.warnings);
    }

    const nearestDsl = spatialQueryDslSchema.parse({
      intent: "nearest",
      targetLayer: targetResolved.layer.layerKey,
      attributeFilter: [],
      aggregation: null,
      limit: nearestLimit,
      output: {
        fields: defaultOutputFields(targetResolved.layer),
        returnGeometry: true
      },
      spatialFilter: {
        type: "nearest",
        sourceLayer: sourceResolved.layer.layerKey,
        sourceAttributeFilter: sourceFilterResult.sourceAttributeFilter,
        sourceFilterExpr: sourceFilterResult.sourceFilterExpr
      },
      locationEntity: {
        rawText: nearestClause.sourcePart,
        type: locationTypeFromHint(sourceHint),
        resolution: "resolved"
      }
    });
    const normalizedResult = normalizeDslByQuestion(normalized, nearestDsl);
    return withWarnings({
      dsl: normalizedResult.dsl,
      confidence: 0.88,
      followUpQuestion: null,
      parserSource: "rule",
      normalizedByRule: normalizedResult.normalized
    }, sourceFilterResult.warnings);
  }
  if (/(最近|nearest)/i.test(normalized)) {
    const targetResolved = resolveTargetLayer(normalized);
    const fallbackLayer = targetResolved.layer ?? layerRegistry.getDefaultLayer();
    const fallbackDsl = spatialQueryDslSchema.parse({
      intent: "nearest",
      targetLayer: fallbackLayer?.layerKey ?? "fuzhou_parks",
      attributeFilter: [],
      aggregation: null,
      limit: Math.max(1, config.nearestDefaultK),
      output: {
        fields: fallbackLayer ? defaultOutputFields(fallbackLayer) : [],
        returnGeometry: true
      },
      spatialFilter: {
        type: "nearest"
      }
    });
    return {
      dsl: fallbackDsl,
      confidence: 0.55,
      followUpQuestion:
        "最近邻查询需要明确源对象。请提供坐标，或按“OBJECTID为45854的宗地院落最近的道路街巷”这样的格式提问。",
      parserSource: "rule"
    };
  }

  const crossLayer = parseCrossLayerBuffer(normalized);
  if (crossLayer && !parseCoordinate(normalized)) {
    const sourceHint = geometryHintFromText(crossLayer.sourcePart);
    const targetHint = geometryHintFromText(crossLayer.targetPart);
    const sourceResolved = chooseLayerByHint(crossLayer.sourcePart, sourceHint);
    const targetResolved = chooseLayerByHint(crossLayer.targetPart, targetHint);

    if (!sourceResolved.layer || !targetResolved.layer) {
      const followUpQuestion =
        sourceResolved.followUpQuestion ??
        targetResolved.followUpQuestion ??
        "请明确源图层和目标图层后重试。";
      const fallbackDsl = spatialQueryDslSchema.parse({
        intent: "buffer_search",
        targetLayer: (targetResolved.layer ?? layerRegistry.getDefaultLayer())?.layerKey ?? "fuzhou_parks",
        attributeFilter: [],
        aggregation: null,
        limit: config.queryMaxFeatures,
        output: {
          fields: [],
          returnGeometry: true
        },
        spatialFilter: {
          type: "buffer",
          radius: crossLayer.radiusMeters,
          unit: "meter"
        }
      });
      return {
        dsl: fallbackDsl,
        confidence: 0.6,
        followUpQuestion,
        parserSource: "rule"
      };
    }

    const sourceFilterResult = extractSourceFilters(crossLayer.sourcePart, sourceResolved.layer);
    if (!sourceFilterResult.sourceAttributeFilter.length) {
      const noFilterDsl = spatialQueryDslSchema.parse({
        intent: "buffer_search",
        targetLayer: targetResolved.layer.layerKey,
        attributeFilter: [],
        aggregation: null,
        limit: config.queryMaxFeatures,
        output: {
          fields: defaultOutputFields(targetResolved.layer),
          returnGeometry: true
        },
        spatialFilter: {
          type: "buffer",
          radius: crossLayer.radiusMeters,
          unit: "meter",
          sourceLayer: sourceResolved.layer.layerKey,
          sourceAttributeFilter: []
        }
      });
      return withWarnings({
        dsl: noFilterDsl,
        confidence: 0.68,
        followUpQuestion: `请明确源要素条件（当前源图层：${sourceResolved.layer.name}），例如“标准名称为南二环的${sourceResolved.layer.name}${crossLayer.radiusMeters}米内的${targetResolved.layer.name}”。`,
        parserSource: "rule"
      }, sourceFilterResult.warnings);
    }

    const crossDsl = spatialQueryDslSchema.parse({
      intent: "buffer_search",
      targetLayer: targetResolved.layer.layerKey,
      attributeFilter: [],
      aggregation: null,
      limit: config.queryMaxFeatures,
      output: {
        fields: defaultOutputFields(targetResolved.layer),
        returnGeometry: true
      },
      spatialFilter: {
        type: "buffer",
        radius: crossLayer.radiusMeters,
        unit: "meter",
        sourceLayer: sourceResolved.layer.layerKey,
        sourceAttributeFilter: sourceFilterResult.sourceAttributeFilter,
        sourceFilterExpr: sourceFilterResult.sourceFilterExpr
      },
      locationEntity: {
        rawText: crossLayer.sourcePart,
        type:
          sourceHint === "line"
            ? "road"
            : sourceHint === "polygon"
              ? "subdistrict"
              : sourceHint === "point"
                ? "point"
                : "unknown",
        resolution: "resolved"
      }
    });
    const normalizedResult = normalizeDslByQuestion(normalized, crossDsl);
    return withWarnings({
      dsl: normalizedResult.dsl,
      confidence: 0.88,
      followUpQuestion: null,
      parserSource: "rule",
      normalizedByRule: normalizedResult.normalized
    }, sourceFilterResult.warnings);
  }

  const target = resolveTargetLayer(normalized);
  const fallbackLayer = target.layer ?? layerRegistry.getDefaultLayer();

  if (!fallbackLayer) {
    const noLayerDsl = spatialQueryDslSchema.parse({
      intent: "search",
      targetLayer: "fuzhou_parks",
      attributeFilter: [],
      aggregation: null,
      limit: 20,
      output: {
        fields: [],
        returnGeometry: false
      }
    });
    return {
      dsl: noLayerDsl,
      confidence: 0.4,
      followUpQuestion: "当前没有可查询图层，请先添加 FeatureServer 图层服务。",
      parserSource: "rule"
    };
  }

  const intent = inferIntent(normalized);
  const radiusMeters = parseRadiusMeters(normalized);
  const coordinate = parseCoordinate(normalized);
  const isCoordinateBufferQuery = Boolean(
    intent === "buffer_search" && coordinate && /(附近|周边|以内|内)/.test(normalized)
  );
  const limit =
    parseTopLimitFromQuestion(normalized, intent === "nearest" ? config.nearestMaxK : config.queryMaxFeatures) ??
    (intent === "nearest" ? Math.max(1, config.nearestDefaultK) : config.queryMaxFeatures);
  const county = normalized.match(countyPattern)?.[1];
  const keyword = parseKeyword(normalized);
  const countyField = findCountyField(fallbackLayer);
  const nameField = findNameField(fallbackLayer);
  const targetFilterResult = isCoordinateBufferQuery
    ? { expr: null, flatConditions: [], warnings: [] as string[] }
    : parseTargetFilterExpr(normalized, fallbackLayer);

  const dsl: SpatialQueryDSL = createBaseDsl(
    fallbackLayer.layerKey,
    defaultOutputFields(fallbackLayer)
  );

  dsl.intent = intent;
  dsl.limit = limit;

  let followUpQuestion: string | null = target.followUpQuestion;
  const semanticWarnings: string[] = [];

  if (county && countyField) {
    const countyCondition: FlatCondition = {
      field: countyField,
      operator: "=",
      value: county
    };
    dsl.filterExpr = appendConditionToExpr(dsl.filterExpr, countyCondition);
    dsl.attributeFilter.push(countyCondition);
  }

  if (targetFilterResult.expr) {
    dsl.filterExpr = dsl.filterExpr
      ? mergeExprByLogic("and", dsl.filterExpr, targetFilterResult.expr)
      : targetFilterResult.expr;
    ensureFilterCompatibility(dsl, [...dsl.attributeFilter, ...targetFilterResult.flatConditions]);
    semanticWarnings.push(...targetFilterResult.warnings);
  } else if (keyword && nameField && intent !== "count" && intent !== "group_stat") {
    const keywordCondition: FlatCondition = {
      field: nameField,
      operator: "like",
      value: `%${keyword}%`
    };
    dsl.attributeFilter.push(keywordCondition);
    dsl.filterExpr = appendConditionToExpr(dsl.filterExpr, keywordCondition);
  } else {
    semanticWarnings.push(...targetFilterResult.warnings);
  }

  if (intent === "count") {
    dsl.aggregation = { type: "count" };
    dsl.output.returnGeometry = false;
  }

  if (intent === "group_stat") {
    if (!countyField) {
      followUpQuestion = `图层“${fallbackLayer.name}”缺少可用于行政分组的字段，无法执行分组统计。`;
    } else {
      dsl.aggregation = { type: "group_count", groupBy: [countyField] };
      dsl.output.returnGeometry = false;
      dsl.sort = { by: countyField, order: "asc" };
    }
  }

  if (intent === "buffer_search") {
    const radius = radiusMeters ?? config.defaultRadiusMeters;

    if (config.maxRadiusMeters > 0 && radius > config.maxRadiusMeters) {
      followUpQuestion = `查询半径超过上限 ${config.maxRadiusMeters} 米，请缩小半径后重试。`;
    }

    dsl.spatialFilter = {
      type: "buffer",
      radius,
      unit: "meter",
      center: coordinate
        ? {
            x: coordinate.x,
            y: coordinate.y,
            spatialReference: { wkid: 3857 }
          }
        : undefined
    };

    if (!coordinate) {
      dsl.locationEntity = {
        rawText: normalized,
        type: "unknown",
        resolution: "missing_dependency"
      };
      followUpQuestion = "请提供坐标点（x,y）或开启地名 geocode 服务后再执行附近查询。";
    } else {
      dsl.locationEntity = {
        rawText: `${coordinate.x},${coordinate.y}`,
        type: "point",
        resolution: "resolved"
      };
    }
  }

  const parsed = spatialQueryDslSchema.parse(dsl);
  const normalizedResult = normalizeDslByQuestion(normalized, parsed);
  const mergedWarnings = mergeWarnings(semanticWarnings, normalizedResult.dsl.filterExpr ? [] : undefined);

  return withWarnings({
    dsl: normalizedResult.dsl,
    confidence: followUpQuestion ? 0.65 : 0.9,
    followUpQuestion,
    parserSource: "rule",
    normalizedByRule: normalizedResult.normalized
  }, mergedWarnings);
}
