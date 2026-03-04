import type { LayerDescriptor, SpatialQueryDSL } from "@gis/shared";
import type { PromptMessage } from "./prompts/semantic.js";
import {
  getSemanticFailureHints,
  retrieveSemanticExamples,
  type RetrievedSemanticExample
} from "./semantic-retrieval.js";

interface SemanticContextBuildOptions {
  question: string;
  layers: LayerDescriptor[];
  defaultLayerKey: string;
}

export interface SemanticPromptContext {
  retrievalHits: number;
  retrievalFewShots: PromptMessage[];
  retrievalSystemHint: string;
}

function pickLayerByRegex(layers: LayerDescriptor[], pattern: RegExp): LayerDescriptor | null {
  return layers.find((layer) => pattern.test(layer.name)) ?? null;
}

function mapUnknownLayerKey(
  currentLayerKeys: Set<string>,
  layers: LayerDescriptor[],
  rawKey: string,
  question: string,
  defaultLayerKey: string
): string {
  if (currentLayerKeys.has(rawKey)) {
    return rawKey;
  }
  if (/park|公园/i.test(rawKey) || /公园/.test(question)) {
    return pickLayerByRegex(layers, /公园/)?.layerKey ?? defaultLayerKey;
  }
  if (/road|line|polyline|道路|街巷|路/i.test(rawKey) || /道路|街巷|路/.test(question)) {
    return pickLayerByRegex(layers, /道路|街巷|路/)?.layerKey ?? defaultLayerKey;
  }
  if (/门牌|地址|door|address/i.test(rawKey) || /门牌|地址/.test(question)) {
    return pickLayerByRegex(layers, /门牌|地址/)?.layerKey ?? defaultLayerKey;
  }
  if (/宗地|院落|parcel|polygon/i.test(rawKey) || /宗地|院落|地块/.test(question)) {
    return pickLayerByRegex(layers, /宗地|院落|地块/)?.layerKey ?? defaultLayerKey;
  }
  return defaultLayerKey;
}

function remapDslLayerKeys(
  dsl: SpatialQueryDSL,
  layers: LayerDescriptor[],
  question: string,
  defaultLayerKey: string
): SpatialQueryDSL {
  const keys = new Set(layers.map((layer) => layer.layerKey));
  const targetLayer = mapUnknownLayerKey(keys, layers, dsl.targetLayer, question, defaultLayerKey);
  let sourceLayer = dsl.spatialFilter?.sourceLayer;
  if (sourceLayer) {
    sourceLayer = mapUnknownLayerKey(keys, layers, sourceLayer, question, targetLayer);
  }
  return {
    ...dsl,
    targetLayer,
    spatialFilter: dsl.spatialFilter
      ? {
          ...dsl.spatialFilter,
          sourceLayer
        }
      : dsl.spatialFilter
  };
}

function toFewShotMessages(
  examples: RetrievedSemanticExample[],
  layers: LayerDescriptor[],
  defaultLayerKey: string
): PromptMessage[] {
  const messages: PromptMessage[] = [];
  for (const example of examples) {
    const mappedDsl = remapDslLayerKeys(example.dsl, layers, example.question, defaultLayerKey);
    const assistant = {
      actionable: true,
      confidence: Number(Math.max(0.78, Math.min(0.98, example.qualityScore)).toFixed(2)),
      followUpQuestion: null,
      dsl: mappedDsl
    };
    messages.push({
      role: "user",
      content: example.question
    });
    messages.push({
      role: "assistant",
      content: JSON.stringify(assistant)
    });
  }
  return messages;
}

function buildRetrievalSystemHint(
  examples: RetrievedSemanticExample[],
  failureHints: string[]
): string {
  const lines: string[] = [];
  if (examples.length > 0) {
    lines.push("【动态检索样例】");
    lines.push("以下是与当前问题相似的历史高质量样例，优先保持语义一致：");
    for (const [index, item] of examples.entries()) {
      const tags = item.tags.slice(0, 5).join(",") || "none";
      lines.push(
        `${index + 1}. Q=${item.question} | intent=${item.dsl.intent} | targetLayer=${item.dsl.targetLayer} | tags=${tags}`
      );
    }
  }
  if (failureHints.length > 0) {
    lines.push("【近期失败约束】");
    for (const hint of failureHints) {
      lines.push(`- ${hint}`);
    }
  }
  return lines.join("\n").trim();
}

export async function buildSemanticPromptContext(
  options: SemanticContextBuildOptions
): Promise<SemanticPromptContext> {
  const retrieved = await retrieveSemanticExamples({
    question: options.question,
    layers: options.layers
  });
  const failureHints = await getSemanticFailureHints(3);
  const retrievalFewShots = toFewShotMessages(
    retrieved.hits,
    options.layers,
    options.defaultLayerKey
  );
  const retrievalSystemHint = buildRetrievalSystemHint(retrieved.hits, failureHints);
  return {
    retrievalHits: retrieved.hits.length,
    retrievalFewShots,
    retrievalSystemHint
  };
}

