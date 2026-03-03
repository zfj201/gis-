import {
  type ParseResponse,
  type ParserSource,
  type SpatialQueryDSL,
  spatialQueryDslSchema
} from "@gis/shared";
import { config } from "./config.js";
import {
  GENERAL_CHAT_SYSTEM_PROMPT,
  SEMANTIC_FEW_SHOTS,
  SEMANTIC_SYSTEM_PROMPT
} from "./prompts/semantic.js";
import { parseQuestion as parseQuestionByRules } from "./semantic.js";

interface LlmSemanticOutput {
  actionable: boolean;
  confidence?: number;
  followUpQuestion?: string | null;
  dsl?: SpatialQueryDSL;
}

interface OpenAICompatibleConfig {
  providerName: "groq" | "openrouter";
  parserSource: "groq" | "openrouter";
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
}

export interface GeneralChatResponse {
  summary: string;
  parserSource: ParserSource;
}

function hasSpatialSignal(question: string): boolean {
  return /(公园|区县|县|街道|附近|周边|坐标|经纬|公里|千米|米|统计|查询|查找|地图|点位|范围|最近|缓冲|地址|城市|poi|distance|buffer)/i.test(
    question
  );
}

function hasCoordinateText(question: string): boolean {
  return (
    /-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?/.test(question) ||
    /x\s*[:：]\s*-?\d+(?:\.\d+)?\s*[，,\s]+y\s*[:：]\s*-?\d+(?:\.\d+)?/i.test(question)
  );
}

function isBufferIntentText(question: string): boolean {
  return /(附近|周边|以内|内)/.test(question);
}

function isCountIntentText(question: string): boolean {
  return /(多少|几个|总数|数量)/.test(question);
}

function hasCountyText(question: string): boolean {
  return /(鼓楼区|仓山区|台江区|晋安区|马尾区|长乐区|闽侯县|连江县|罗源县|闽清县|永泰县|福清市|平潭县)/.test(
    question
  );
}

function hasCountyFilter(dsl: SpatialQueryDSL): boolean {
  return dsl.attributeFilter.some((item) => item.field === "区县" && item.operator === "=");
}

function isModelResultConsistent(question: string, parsed: ParseResponse): boolean {
  const dsl = parsed.dsl;

  // Explicit coordinate + buffer language must yield executable buffer query.
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

  // Count language should not degrade to plain search.
  if (isCountIntentText(question)) {
    if (dsl.intent !== "count" && dsl.aggregation?.type !== "count") {
      return false;
    }
  }

  // County text should keep county filter.
  if (hasCountyText(question) && !hasCountyFilter(dsl)) {
    return false;
  }

  return true;
}

function parseRequestedTopLimit(question: string): number | undefined {
  const topMatch = question.match(/前\s*(\d+)\s*(个|条|家|所)?/);
  if (!topMatch) {
    return undefined;
  }

  const limit = Number(topMatch[1]);
  if (Number.isNaN(limit) || limit < 1) {
    return undefined;
  }

  return Math.min(limit, 2000);
}

function normalizeLimitByQuestion(question: string, dsl: SpatialQueryDSL): SpatialQueryDSL {
  if (!["search", "buffer_search", "nearest"].includes(dsl.intent)) {
    return dsl;
  }

  const requestedLimit = parseRequestedTopLimit(question);
  return {
    ...dsl,
    limit: requestedLimit ?? 2000
  };
}

function isUnconstrainedSearch(dsl: SpatialQueryDSL): boolean {
  const noSpatial = !dsl.spatialFilter || !dsl.spatialFilter.type;
  const noAttribute = !dsl.attributeFilter || dsl.attributeFilter.length === 0;
  const noAggregation = !dsl.aggregation;
  const noSort = !dsl.sort;
  return dsl.intent === "search" && noSpatial && noAttribute && noAggregation && noSort;
}

function createDefaultDsl(): SpatialQueryDSL {
  return {
    intent: "search",
    targetLayer: "fuzhou_parks",
    attributeFilter: [],
    aggregation: null,
    limit: 20,
    output: {
      fields: ["fid", "名称", "地址", "区县"],
      returnGeometry: true
    }
  };
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

function normalizeModelOutput(
  question: string,
  output: LlmSemanticOutput,
  parserSource: "groq" | "openrouter"
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

  const parsed = spatialQueryDslSchema.parse(output.dsl);

  // Safety gate: avoid executing broad table scan for non-spatial chit-chat.
  if (isUnconstrainedSearch(parsed) && !hasSpatialSignal(question)) {
    return {
      dsl: createDefaultDsl(),
      confidence: 0.4,
      followUpQuestion:
        "我目前专注空间问题。你可以这样问：鼓楼区公园有多少个、仓山区前20个公园、某点500米内的公园。",
      parserSource
    };
  }

  const normalizedDsl = normalizeLimitByQuestion(question, parsed);

  return {
    dsl: normalizedDsl,
    confidence: clampConfidence(output.confidence),
    followUpQuestion: output.followUpQuestion ?? null,
    parserSource
  };
}

function withParserSource(parsed: ParseResponse, parserSource: ParserSource): ParseResponse {
  return {
    ...parsed,
    parserSource
  };
}

function providerToSource(provider: string): ParserSource {
  if (provider === "groq" || provider === "openrouter") {
    return provider;
  }
  return "rule";
}

async function parseWithOpenAICompatible(
  question: string,
  provider: OpenAICompatibleConfig
): Promise<ParseResponse> {
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
        temperature: 0,
        messages: [
          { role: "system", content: SEMANTIC_SYSTEM_PROMPT },
          ...SEMANTIC_FEW_SHOTS,
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

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`${provider.providerName} 返回内容为空`);
    }

    const rawJson = extractJsonString(content);
    const modelOutput = JSON.parse(rawJson) as LlmSemanticOutput;
    return normalizeModelOutput(question, modelOutput, provider.parserSource);
  } finally {
    clearTimeout(timeoutId);
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

export function isSpatialQuestion(question: string): boolean {
  return hasSpatialSignal(question.trim());
}

export async function parseQuestionSmart(question: string): Promise<ParseResponse> {
  if (!isSpatialQuestion(question)) {
    return {
      dsl: createDefaultDsl(),
      confidence: 0.4,
      followUpQuestion:
        "这条消息更像普通对话，不会执行空间检索。你可以继续提空间问题，例如“鼓楼区公园有多少个”。",
      parserSource: "rule"
    };
  }

  const provider = config.llmProvider.trim().toLowerCase();
  if (provider === "rule") {
    return withParserSource(parseQuestionByRules(question), "rule");
  }

  if (provider === "groq") {
    try {
      const modelParsed = await parseWithOpenAICompatible(question, {
        providerName: "groq",
        parserSource: "groq",
        apiKey: config.groqApiKey,
        baseUrl: config.groqBaseUrl,
        model: config.groqModel,
        timeoutMs: config.groqTimeoutMs
      });

      if (!isModelResultConsistent(question, modelParsed)) {
        return withParserSource(parseQuestionByRules(question), "rule_fallback");
      }
      return modelParsed;
    } catch (error) {
      console.warn("[semantic] Groq 解析失败，回退规则解析:", (error as Error).message);
      return withParserSource(parseQuestionByRules(question), "rule_fallback");
    }
  }

  if (provider === "openrouter") {
    try {
      const modelParsed = await parseWithOpenAICompatible(question, {
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

      if (!isModelResultConsistent(question, modelParsed)) {
        return withParserSource(parseQuestionByRules(question), "rule_fallback");
      }
      return modelParsed;
    } catch (error) {
      console.warn("[semantic] OpenRouter 解析失败，回退规则解析:", (error as Error).message);
      return withParserSource(parseQuestionByRules(question), "rule_fallback");
    }
  }

  console.warn(`[semantic] 未识别的 LLM_PROVIDER=${provider}，已回退规则解析`);
  return withParserSource(parseQuestionByRules(question), "rule");
}

export async function answerGeneralQuestion(question: string): Promise<GeneralChatResponse> {
  const provider = config.llmProvider.trim().toLowerCase();
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
