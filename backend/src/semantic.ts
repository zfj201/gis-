import {
  type LayerDescriptor,
  type ParseResponse,
  type SpatialQueryDSL,
  spatialQueryDslSchema
} from "@gis/shared";
import { config } from "./config.js";
import { buildCandidateLayerText, layerRegistry } from "./layer-registry.js";
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

function parseTopLimit(question: string, cap: number): number | undefined {
  const topMatch = question.match(/前\s*(\d+)\s*(个|条|家|所)?/);
  if (!topMatch) {
    return undefined;
  }

  const limit = Number(topMatch[1]);
  if (Number.isNaN(limit) || limit < 1) {
    return undefined;
  }

  return Math.min(limit, Math.max(1, cap));
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
  const targetPart = match[2]
    .replace(/^前\s*\d+\s*(个|条|家|所)?\s*/i, "")
    .replace(/\s*前\s*\d+\s*(个|条|家|所)?$/i, "")
    .trim();

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
  if (/(大于|高于|多于|以上|>)/i.test(value)) {
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
        `${escaped}\\s*(?:的)?\\s*(小于等于|不超过|至多|大于等于|不少于|至少|小于|低于|少于|以下|大于|高于|多于|以上|为|等于|就是|是|包含|含有|相关|类似|>=|<=|>|<|:|：)\\s*[“"']?([^，。！？!?]+)`,
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

function extractSourceFilters(questionPart: string, sourceLayer: LayerDescriptor): SpatialQueryDSL["attributeFilter"] {
  const fields = sourceLayer.fields.filter((field) => field.queryable).map((field) => field.name);
  const explicit = extractExplicitFieldCondition(questionPart, fields);
  if (explicit) {
    return [
      {
        field: explicit.field,
        operator: explicit.operator,
        value: explicit.value
      }
    ];
  }

  const quoteMatch = questionPart.match(/[“"]([^"”]+)[”"]/);
  const nameField = findNameField(sourceLayer);
  if (quoteMatch?.[1] && nameField) {
    return [
      {
        field: nameField,
        operator: "=",
        value: quoteMatch[1].trim()
      }
    ];
  }

  return [];
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
    const requestedLimit = parseTopLimit(normalized, config.nearestMaxK);
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

    const sourceFilters = extractSourceFilters(nearestClause.sourcePart, sourceResolved.layer);
    if (!sourceFilters.length) {
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
      return {
        dsl: noFilterDsl,
        confidence: 0.68,
        followUpQuestion: `请明确源要素条件（当前源图层：${sourceResolved.layer.name}），例如“OBJECTID为45854的${sourceResolved.layer.name}最近的${targetResolved.layer.name}”。`,
        parserSource: "rule"
      };
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
        sourceAttributeFilter: sourceFilters
      },
      locationEntity: {
        rawText: nearestClause.sourcePart,
        type: locationTypeFromHint(sourceHint),
        resolution: "resolved"
      }
    });
    const normalizedResult = normalizeDslByQuestion(normalized, nearestDsl);
    return {
      dsl: normalizedResult.dsl,
      confidence: 0.88,
      followUpQuestion: null,
      parserSource: "rule",
      normalizedByRule: normalizedResult.normalized
    };
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

    const sourceFilters = extractSourceFilters(crossLayer.sourcePart, sourceResolved.layer);
    if (!sourceFilters.length) {
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
      return {
        dsl: noFilterDsl,
        confidence: 0.68,
        followUpQuestion: `请明确源要素条件（当前源图层：${sourceResolved.layer.name}），例如“标准名称为南二环的${sourceResolved.layer.name}${crossLayer.radiusMeters}米内的${targetResolved.layer.name}”。`,
        parserSource: "rule"
      };
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
        sourceAttributeFilter: sourceFilters
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
    return {
      dsl: normalizedResult.dsl,
      confidence: 0.88,
      followUpQuestion: null,
      parserSource: "rule",
      normalizedByRule: normalizedResult.normalized
    };
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
    parseTopLimit(normalized, intent === "nearest" ? config.nearestMaxK : config.queryMaxFeatures) ??
    (intent === "nearest" ? Math.max(1, config.nearestDefaultK) : config.queryMaxFeatures);
  const county = normalized.match(countyPattern)?.[1];
  const keyword = parseKeyword(normalized);
  const countyField = findCountyField(fallbackLayer);
  const nameField = findNameField(fallbackLayer);
  const explicitCondition = isCoordinateBufferQuery
    ? null
    : extractExplicitFieldCondition(
        normalized,
        fallbackLayer.fields.filter((field) => field.queryable).map((field) => field.name)
      );

  const dsl: SpatialQueryDSL = createBaseDsl(
    fallbackLayer.layerKey,
    defaultOutputFields(fallbackLayer)
  );

  dsl.intent = intent;
  dsl.limit = limit;

  let followUpQuestion: string | null = target.followUpQuestion;

  if (county && countyField) {
    dsl.attributeFilter.push({
      field: countyField,
      operator: "=",
      value: county
    });
  }

  if (explicitCondition) {
    dsl.attributeFilter.push({
      field: explicitCondition.field,
      operator: explicitCondition.operator,
      value: explicitCondition.value
    });
  } else if (keyword && nameField && intent !== "count" && intent !== "group_stat") {
    dsl.attributeFilter.push({
      field: nameField,
      operator: "like",
      value: `%${keyword}%`
    });
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

  return {
    dsl: normalizedResult.dsl,
    confidence: followUpQuestion ? 0.65 : 0.9,
    followUpQuestion,
    parserSource: "rule",
    normalizedByRule: normalizedResult.normalized
  };
}
