import type { LayerDescriptor } from "@gis/shared";
import { buildCandidateLayerText, layerRegistry } from "./layer-registry.js";

export interface TargetLayerResolution {
  layer: LayerDescriptor | null;
  followUpQuestion: string | null;
  candidateLayers: LayerDescriptor[];
}

const countyFieldCandidates = ["区县", "行政区划", "县级政区", "城市", "所在乡镇", "乡级政区"];
const nameFieldCandidates = ["名称", "标准名称", "门牌号码", "楼号", "地址", "标准地址"];

function containsKeyword(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[_\-\s/\\|:;()（）【】\[\]]+/g, "");
}

function splitLayerTokens(raw: string): string[] {
  const base = raw.trim();
  if (!base) {
    return [];
  }
  const tokens = new Set<string>();
  const coarse = base
    .split(/[_\-\s,/\\|:;()（）【】\[\]]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const token of coarse) {
    if (token.length >= 2) {
      tokens.add(token);
    }
  }
  const zhMatches = base.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const token of zhMatches) {
    tokens.add(token);
  }
  const enMatches = base.match(/[a-zA-Z][a-zA-Z0-9]{2,}/g) ?? [];
  for (const token of enMatches) {
    tokens.add(token);
  }
  return Array.from(tokens);
}

function scoreLayerByQuestion(layer: LayerDescriptor, question: string): number {
  const lowerQuestion = question.toLowerCase();
  const normalizedQuestion = normalizeForMatch(question);
  let score = 0;

  if (lowerQuestion.includes(layer.name.toLowerCase())) {
    score += 8;
  }
  if (normalizeForMatch(layer.name) && normalizedQuestion.includes(normalizeForMatch(layer.name))) {
    score += 4;
  }
  for (const token of splitLayerTokens(layer.name)) {
    if (normalizeForMatch(token) && normalizedQuestion.includes(normalizeForMatch(token))) {
      score += 2;
      break;
    }
  }
  for (const token of layer.semanticProfile?.tokens ?? []) {
    if (!token.trim()) {
      continue;
    }
    if (normalizedQuestion.includes(normalizeForMatch(token))) {
      score += 2.6;
      break;
    }
  }

  for (const alias of layer.aliases) {
    if (alias && lowerQuestion.includes(alias.toLowerCase())) {
      score += 5;
    }
    if (alias && normalizeForMatch(alias) && normalizedQuestion.includes(normalizeForMatch(alias))) {
      score += 3;
    }
    for (const token of splitLayerTokens(alias)) {
      if (normalizeForMatch(token) && normalizedQuestion.includes(normalizeForMatch(token))) {
        score += 1.8;
        break;
      }
    }
  }

  if (containsKeyword(question, /公园/) && /公园/.test(layer.name)) {
    score += 8;
  }
  if (containsKeyword(question, /道路|街巷|路/) && /道路|街巷|路/.test(layer.name)) {
    score += 6;
  }
  if (containsKeyword(question, /门牌|地址|牌匾/) && /门牌|地址/.test(layer.name)) {
    score += 6;
  }
  if (containsKeyword(question, /房屋|建筑/) && /房屋|建筑/.test(layer.name)) {
    score += 6;
  }
  if (containsKeyword(question, /单元楼|楼/) && /单元楼|楼/.test(layer.name)) {
    score += 5;
  }
  if (containsKeyword(question, /宗地|院落/) && /宗地|院落/.test(layer.name)) {
    score += 5;
  }

  return score;
}

export function findFieldByCandidates(layer: LayerDescriptor, candidates: string[]): string | null {
  const names = new Set(layer.fields.map((field) => field.name));
  for (const candidate of candidates) {
    if (names.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function findCountyField(layer: LayerDescriptor): string | null {
  return findFieldByCandidates(layer, countyFieldCandidates);
}

export function findNameField(layer: LayerDescriptor): string | null {
  return (
    findFieldByCandidates(layer, nameFieldCandidates) ??
    layer.fields.find((field) => field.type === "esriFieldTypeString")?.name ??
    null
  );
}

export function defaultOutputFields(layer: LayerDescriptor): string[] {
  const values: string[] = [];
  const pushIf = (fieldName: string | null | undefined): void => {
    if (!fieldName) {
      return;
    }
    if (!values.includes(fieldName)) {
      values.push(fieldName);
    }
  };

  pushIf(layer.objectIdField);
  pushIf(layer.displayField);

  for (const candidate of ["地址", "标准地址", "区县", "行政区划"]) {
    pushIf(findFieldByCandidates(layer, [candidate]));
  }

  if (values.length < 4) {
    const moreFields = layer.fields
      .filter((field) => field.queryable && field.type === "esriFieldTypeString")
      .map((field) => field.name);
    for (const fieldName of moreFields) {
      pushIf(fieldName);
      if (values.length >= 4) {
        break;
      }
    }
  }

  return values.slice(0, 6);
}

export function resolveTargetLayer(
  question: string,
  requestedLayerKey?: string | null
): TargetLayerResolution {
  const catalog = layerRegistry.listCatalog();
  const queryableLayers = catalog.layers.filter((layer) => layer.queryable);

  if (queryableLayers.length === 0) {
    return {
      layer: null,
      followUpQuestion: "当前没有可查询图层，请先在图层管理中添加 FeatureLayer 服务。",
      candidateLayers: []
    };
  }

  if (requestedLayerKey) {
    const explicit = layerRegistry.getLayer(requestedLayerKey);
    if (explicit?.queryable) {
      return { layer: explicit, followUpQuestion: null, candidateLayers: [explicit] };
    }

    return {
      layer: null,
      followUpQuestion: `未找到目标图层 ${requestedLayerKey}。可选图层：${buildCandidateLayerText(queryableLayers.slice(0, 8))}`,
      candidateLayers: queryableLayers
    };
  }

  const scored = queryableLayers
    .map((layer) => ({ layer, score: scoreLayerByQuestion(layer, question) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    if (queryableLayers.length === 1) {
      return { layer: queryableLayers[0], followUpQuestion: null, candidateLayers: [queryableLayers[0]] };
    }
    return {
      layer: null,
      followUpQuestion: `请先指定目标图层。可选图层：${buildCandidateLayerText(queryableLayers.slice(0, 8))}`,
      candidateLayers: queryableLayers
    };
  }

  const topScore = scored[0].score;
  const topLayers = scored.filter((item) => item.score === topScore).map((item) => item.layer);

  if (topLayers.length > 1) {
    return {
      layer: null,
      followUpQuestion: `识别到多个候选图层：${buildCandidateLayerText(topLayers)}。请明确要查询哪一个图层。`,
      candidateLayers: topLayers
    };
  }

  const selected = topLayers[0];
  const multiLayerConnector = /和|以及|与|、/.test(question);
  const multiMention = scored.length >= 2;
  if (multiLayerConnector && multiMention) {
    return {
      layer: null,
      followUpQuestion: "当前版本一次只支持一个图层查询。请把问题拆分为单图层查询后再试。",
      candidateLayers: scored.slice(0, 4).map((item) => item.layer)
    };
  }

  return {
    layer: selected,
    followUpQuestion: null,
    candidateLayers: [selected]
  };
}
