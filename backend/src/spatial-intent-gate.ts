import type { LayerDescriptor } from "@gis/shared";

export type SpatialGateDecision = "spatial" | "non_spatial" | "uncertain";

export interface SpatialIntentGateResult {
  score: number;
  decision: SpatialGateDecision;
  reasons: string[];
  matchedSignals: string[];
}

const LOW_THRESHOLD = 2;
const HIGH_THRESHOLD = 5;
const MAX_MATCHED_SIGNALS = 12;

const spatialActionSignals: Array<{ pattern: RegExp; score: number; reason: string }> = [
  {
    pattern: /-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?|x\s*[:：]\s*-?\d+(?:\.\d+)?\s*[，,\s]+y\s*[:：]\s*-?\d+(?:\.\d+)?/i,
    score: 3.5,
    reason: "坐标格式命中"
  },
  {
    pattern: /(附近|周边|缓冲|最近|nearest|相交|intersects|范围|半径|距离)/i,
    score: 2.2,
    reason: "空间关系词命中"
  },
  {
    pattern: /(\d+(?:\.\d+)?\s*(km|公里|千米|m|米))/i,
    score: 1.6,
    reason: "距离单位命中"
  },
  {
    pattern: /(查询|检索|查找|筛选|列出|显示|统计|分组|汇总|多少|几个|数量|总数)/i,
    score: 1.2,
    reason: "空间查询动作词命中"
  },
  {
    pattern: /(去重|不重复|唯一值|distinct|升序|降序|排序|between|not\s*in|\bin\s*\(|不在|介于|为空|非空)/i,
    score: 1.8,
    reason: "属性分析词命中"
  },
  {
    pattern: /(公园|道路|街巷|门牌|地址|宗地|院落|地块|房屋|建筑|单元楼|图层|要素)/i,
    score: 2.8,
    reason: "空间实体词命中"
  },
  {
    pattern: /(鼓楼区|仓山区|台江区|晋安区|马尾区|长乐区|闽侯县|连江县|罗源县|闽清县|永泰县|福清市|平潭)/,
    score: 1.6,
    reason: "行政区实体命中"
  }
];

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function geometryHintWords(layer: LayerDescriptor): string[] {
  const g = String(layer.geometryType ?? "").toLowerCase();
  if (/point/.test(g)) {
    return ["点", "点位", "门牌", "poi"];
  }
  if (/polyline|line/.test(g)) {
    return ["线", "道路", "街巷", "路"];
  }
  if (/polygon|area/.test(g)) {
    return ["面", "院落", "宗地", "地块", "区域", "片区"];
  }
  return [];
}

function isSemanticFieldToken(token: string): boolean {
  return /(objectid|fid|shape__area|shape__length|面积|长度|周长|名称|标准名称|地址|标准地址|门牌|区县|行政|城市|乡镇|编号)/i.test(
    token
  );
}

function shouldUseToken(token: string): boolean {
  const text = token.trim();
  if (!text) {
    return false;
  }
  if (text.length < 2) {
    return false;
  }
  if (/^\d+$/.test(text)) {
    return false;
  }
  return true;
}

function addWeightedSignal(
  matchedWeights: Map<string, number>,
  signalKey: string,
  weight: number
): number {
  const prev = matchedWeights.get(signalKey) ?? 0;
  if (weight <= prev) {
    return 0;
  }
  matchedWeights.set(signalKey, weight);
  return weight - prev;
}

export function evaluateSpatialIntentGate(
  question: string,
  layers: LayerDescriptor[]
): SpatialIntentGateResult {
  const compactQuestion = normalizeText(question);
  let score = 0;
  const reasons: string[] = [];
  const matchedSignals: string[] = [];
  const matchedWeights = new Map<string, number>();

  const pushReason = (text: string): void => {
    if (!reasons.includes(text)) {
      reasons.push(text);
    }
  };

  const pushSignal = (signal: string): void => {
    if (matchedSignals.length >= MAX_MATCHED_SIGNALS) {
      return;
    }
    if (!matchedSignals.includes(signal)) {
      matchedSignals.push(signal);
    }
  };

  for (const action of spatialActionSignals) {
    if (!action.pattern.test(question)) {
      continue;
    }
    const delta = addWeightedSignal(matchedWeights, `action:${action.reason}`, action.score);
    if (delta > 0) {
      score += delta;
      pushReason(action.reason);
      pushSignal(action.reason);
    }
  }

  const queryableLayers = layers.filter((layer) => layer.queryable);
  for (const layer of queryableLayers) {
    const layerName = layer.name.trim();
    if (shouldUseToken(layerName) && compactQuestion.includes(normalizeText(layerName))) {
      const delta = addWeightedSignal(matchedWeights, `layer:${layerName}`, 2.8);
      if (delta > 0) {
        score += delta;
        pushReason(`命中图层名 ${layerName}`);
        pushSignal(`图层:${layerName}`);
      }
    }

    for (const alias of layer.aliases) {
      if (!shouldUseToken(alias)) {
        continue;
      }
      if (!compactQuestion.includes(normalizeText(alias))) {
        continue;
      }
      const delta = addWeightedSignal(matchedWeights, `alias:${alias}`, 1.8);
      if (delta > 0) {
        score += delta;
        pushReason(`命中图层别名 ${alias}`);
        pushSignal(`别名:${alias}`);
      }
    }

    const geometryHints = geometryHintWords(layer);
    for (const hint of geometryHints) {
      if (!compactQuestion.includes(normalizeText(hint))) {
        continue;
      }
      const delta = addWeightedSignal(matchedWeights, `geometry:${hint}`, 0.9);
      if (delta > 0) {
        score += delta;
        pushReason(`命中几何语义 ${hint}`);
        pushSignal(`几何:${hint}`);
      }
      break;
    }

    const semanticBoostFields = new Set<string>([
      layer.objectIdField.toLowerCase(),
      layer.displayField.toLowerCase()
    ]);

    for (const field of layer.fields) {
      if (!field.queryable) {
        continue;
      }
      const name = field.name.trim();
      const alias = field.alias.trim();
      const candidates = [name, alias].filter(shouldUseToken);
      if (candidates.length === 0) {
        continue;
      }
      const matched = candidates.find((token) => compactQuestion.includes(normalizeText(token)));
      if (!matched) {
        continue;
      }
      const isSemantic =
        semanticBoostFields.has(name.toLowerCase()) ||
        semanticBoostFields.has(alias.toLowerCase()) ||
        isSemanticFieldToken(name) ||
        isSemanticFieldToken(alias);
      const weight = isSemantic ? 2 : 0.7;
      const delta = addWeightedSignal(matchedWeights, `field:${name}`, weight);
      if (delta > 0) {
        score += delta;
        pushReason(`命中字段 ${name}`);
        pushSignal(`字段:${name}`);
      }
    }
  }

  const roundedScore = Math.round(score * 10) / 10;
  const decision: SpatialGateDecision =
    roundedScore >= HIGH_THRESHOLD
      ? "spatial"
      : roundedScore <= LOW_THRESHOLD
        ? "non_spatial"
        : "uncertain";

  return {
    score: roundedScore,
    decision,
    reasons,
    matchedSignals
  };
}
