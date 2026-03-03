import {
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
import { parseQuestion as parseQuestionByRules } from "./semantic.js";
import { defaultOutputFields, findCountyField, resolveTargetLayer } from "./semantic-routing.js";

interface LlmSemanticOutput {
  actionable: boolean;
  confidence?: number;
  followUpQuestion?: string | null;
  dsl?: SpatialQueryDSL | null;
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

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

type SemanticOutputIssueKind = "schema" | "non_json" | "consistency";

interface SemanticCompletionResult {
  content: string;
  usedResponseFormat: boolean;
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

function hasSpatialSignal(question: string): boolean {
  return /(公园|区县|县|街道|附近|周边|坐标|经纬|公里|千米|米|统计|查询|查找|地图|点位|范围|最近|缓冲|地址|城市|poi|distance|buffer|门牌|道路|房屋|建筑|图层|多少|几个|总数|数量)/i.test(
    question
  );
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

function hasCountyText(question: string): boolean {
  return /(鼓楼区|仓山区|台江区|晋安区|马尾区|长乐区|闽侯县|连江县|罗源县|闽清县|永泰县|福清市|平潭县)/.test(
    question
  );
}

function hasCountyFilter(dsl: SpatialQueryDSL): boolean {
  return dsl.attributeFilter.some(
    (item) =>
      item.operator === "=" &&
      /(区县|行政区划|县级政区|城市|所在乡镇|乡级政区)/.test(item.field)
  );
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

function normalizeSpatialType(raw: unknown): "buffer" | "intersects" | "nearest" | undefined {
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
      const value = String((item as { value?: unknown }).value ?? "").trim();
      if (!field || !value) {
        return null;
      }
      return {
        field,
        operator: normalizeOperator((item as { operator?: unknown }).operator),
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

function normalizeLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.min(2000, Math.max(1, Math.round(parsed)));
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
    aggregation:
      dsl.aggregation && typeof dsl.aggregation === "object"
        ? (dsl.aggregation as SpatialQueryDSL["aggregation"])
        : null,
    limit: normalizeLimit(dsl.limit),
    output: {
      fields: Array.isArray(output?.fields)
        ? output!.fields.map((item) => String(item)).filter((item) => item.trim().length > 0)
        : [],
      returnGeometry: output?.returnGeometry === undefined ? true : Boolean(output.returnGeometry)
    }
  };

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
    normalized.spatialFilter = {
      type: normalizeSpatialType(spatialFilter.type),
      radius: Number.isNaN(radius) ? undefined : radius,
      unit: normalizeUnit(spatialFilter.unit),
      ringOnly:
        spatialFilter.ringOnly === undefined ? undefined : Boolean(spatialFilter.ringOnly),
      sourceLayer:
        spatialFilter.sourceLayer === undefined ? undefined : String(spatialFilter.sourceLayer),
      sourceAttributeFilter: normalizeFilterList(spatialFilter.sourceAttributeFilter),
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
      !dsl.spatialFilter?.sourceAttributeFilter?.length
    ) {
      return false;
    }
  }

  if (isCountIntentText(question)) {
    if (dsl.intent !== "count" && dsl.aggregation?.type !== "count") {
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

  const parsed = normalizeDslForSchemaAndParse(output.dsl);
  const parsedWithLegacy = normalizeDslForSchemaLegacy(parsed);
  if (isUnconstrainedSearch(parsedWithLegacy) && !hasSpatialSignal(question)) {
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
  const normalizedByRule = normalizeDslByQuestion(question, routed.dsl);
  return {
    dsl: normalizedByRule.dsl,
    confidence: clampConfidence(output.confidence),
    followUpQuestion: output.followUpQuestion ?? routed.followUpQuestion ?? null,
    parserSource,
    normalizedByRule: normalizedByRule.normalized
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

function isResponseFormatUnsupported(statusCode: number, responseText: string): boolean {
  if (![400, 404, 415, 422].includes(statusCode)) {
    return false;
  }
  return /(response_format|json_object|unsupported|not supported|invalid.*response_format)/i.test(responseText);
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
  preferJsonFormat: boolean
): Promise<SemanticCompletionResult> {
  let lastError: unknown = null;
  let useResponseFormat = preferJsonFormat;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), provider.timeoutMs);
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
        usedResponseFormat: useResponseFormat
      };
    } catch (error) {
      lastError = error;
      const message = (error as Error)?.message ?? "";
      const shouldRetry = attempt < maxAttempts && /aborted|timeout|429|5\d\d/i.test(message);
      console.warn("[semantic] provider attempt failed", {
        provider: provider.providerName,
        attempt,
        maxAttempts,
        shouldRetry,
        reason: message
      });
      if (!shouldRetry) {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("模型请求失败");
}

function parseSemanticOutputToDsl(
  question: string,
  parserSource: "groq" | "openrouter",
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

  if (!isModelResultConsistent(question, parsed)) {
    throw new SemanticOutputError("consistency", "模型输出与语义一致性规则冲突。", rawJson);
  }
  return parsed;
}

async function parseWithOpenAICompatible(
  question: string,
  provider: OpenAICompatibleConfig
): Promise<ParseResponse> {
  if (!provider.apiKey) {
    throw new Error(`${provider.providerName.toUpperCase()}_API_KEY 未配置`);
  }

  const catalog = layerRegistry.listCatalog();
  const queryableLayers = catalog.layers.filter((layer) => layer.queryable);
  const defaultLayerKey = layerRegistry.getDefaultLayer()?.layerKey ?? "fuzhou_parks";
  const semanticSystemPrompt = buildSemanticSystemPrompt(queryableLayers);
  const semanticFewShots = buildSemanticFewShots(defaultLayerKey, queryableLayers);
  const baseMessages = buildSemanticMessages(semanticSystemPrompt, semanticFewShots, question);
  const first = await requestSemanticCompletion(provider, baseMessages, true);

  try {
    return parseSemanticOutputToDsl(question, provider.parserSource, first.content);
  } catch (error) {
    if (!isRepairableSemanticError(error)) {
      throw error;
    }

    const repairPrompt = buildSemanticRepairPrompt(question, error);
    const repairMessages: OpenAIMessage[] = [
      ...baseMessages,
      {
        role: "assistant",
        content: first.content.slice(0, 2000)
      },
      {
        role: "user",
        content: repairPrompt
      }
    ];
    const second = await requestSemanticCompletion(
      provider,
      repairMessages,
      first.usedResponseFormat
    );

    try {
      return parseSemanticOutputToDsl(question, provider.parserSource, second.content);
    } catch (secondError) {
      if (!isRepairableSemanticError(secondError)) {
        throw secondError;
      }
      throw new Error(
        `模型二次修复失败: first=${error.kind}; second=${secondError.kind}; ${secondError.message}`
      );
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
      return await parseWithOpenAICompatible(question, {
        providerName: "groq",
        parserSource: "groq",
        apiKey: config.groqApiKey,
        baseUrl: config.groqBaseUrl,
        model: config.groqModel,
        timeoutMs: config.groqTimeoutMs
      });
    } catch (error) {
      const reason = classifyModelFailureReason(error);
      const detail = buildModelFailureDetail(error);
      console.warn("[semantic] Groq 解析失败，回退规则解析:", {
        provider: "groq",
        raw: (error as Error).message,
        normalizedReason: reason,
        detail
      });
      const fallback = withParserSource(parseQuestionByRules(question), "rule_fallback");
      return {
        ...fallback,
        parserFailureReason: reason,
        parserFailureDetail: detail
      };
    }
  }

  if (provider === "openrouter") {
    try {
      return await parseWithOpenAICompatible(question, {
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
      const reason = classifyModelFailureReason(error);
      const detail = buildModelFailureDetail(error);
      console.warn("[semantic] OpenRouter 解析失败，回退规则解析:", {
        provider: "openrouter",
        raw: (error as Error).message,
        normalizedReason: reason,
        detail
      });
      const fallback = withParserSource(parseQuestionByRules(question), "rule_fallback");
      return {
        ...fallback,
        parserFailureReason: reason,
        parserFailureDetail: detail
      };
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
