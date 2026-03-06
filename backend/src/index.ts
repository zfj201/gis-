import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  type ExecuteResponse,
  type ParseResponse,
  type QueryPlan,
  spatialQueryDslSchema,
  type SpatialQueryDSL
} from "@gis/shared";
import { config } from "./config.js";
import { fetchLayerMeta, queryArcgisLayer } from "./arcgis.js";
import { isUserFacingError } from "./errors.js";
import { layerRegistry } from "./layer-registry.js";
import { summarizeResult } from "./narrator.js";
import { defaultOutputFields } from "./semantic-routing.js";
import {
  answerGeneralQuestion,
  answerGeneralQuestionStream,
  isSpatialQuestion,
  parseQuestionSmart,
  summarizeSpatialResultStream
} from "./semantic-llm.js";
import { executeDsl } from "./spatial-executor.js";

const app = Fastify({ logger: true });

const MAX_EXPORT_PAGE_SIZE = 5000;
const SELECTED_IN_CLAUSE_CHUNK = 800;
type StreamDoneStatus = "completed" | "aborted" | "error";
type ResponseExecutionMeta = {
  truncated: boolean;
  safetyCap: number;
  fetched: number;
  requestedLimit: number;
  mapDisplayLimit?: number;
  mapDisplayTotal?: number;
  mapDisplayTruncated?: boolean;
};

function mapHighlightLimit(): number {
  const raw = Number(config.mapHighlightMaxFeatures);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 2000;
  }
  return Math.max(1, Math.floor(raw));
}

function applyMapHighlightCap(
  features: Array<Record<string, unknown>>,
  executionMeta: Record<string, unknown> | undefined,
  totalHint?: number | null
): {
  features: Array<Record<string, unknown>>;
  executionMeta: ResponseExecutionMeta | undefined;
} {
  const limit = mapHighlightLimit();
  const source = Array.isArray(features) ? features : [];
  const totalFromHint =
    typeof totalHint === "number" && Number.isFinite(totalHint)
      ? Math.max(0, Math.floor(totalHint))
      : null;
  const cappedByLength = source.length > limit;
  const cappedFeatures = cappedByLength ? source.slice(0, limit) : source;
  const total = totalFromHint ?? source.length;
  const mapDisplayTruncated = cappedByLength || (totalFromHint !== null && totalFromHint > cappedFeatures.length);

  if (!executionMeta && !mapDisplayTruncated) {
    return {
      features: cappedFeatures,
      executionMeta: undefined
    };
  }

  const normalizeNumber = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return parsed;
  };

  const baseFetched = normalizeNumber((executionMeta as { fetched?: unknown } | undefined)?.fetched, source.length);
  const baseSafetyCap = normalizeNumber(
    (executionMeta as { safetyCap?: unknown } | undefined)?.safetyCap,
    Math.max(limit, baseFetched)
  );
  const baseRequestedLimit = normalizeNumber(
    (executionMeta as { requestedLimit?: unknown } | undefined)?.requestedLimit,
    Math.max(total, baseFetched)
  );

  return {
    features: cappedFeatures,
    executionMeta: {
      truncated: Boolean((executionMeta as { truncated?: unknown } | undefined)?.truncated),
      safetyCap: baseSafetyCap,
      fetched: baseFetched,
      requestedLimit: baseRequestedLimit,
      mapDisplayLimit: limit,
      mapDisplayTotal: total,
      mapDisplayTruncated
    }
  };
}

function buildVisualizationDsl(
  dsl: SpatialQueryDSL,
  payload: Record<string, unknown>
): SpatialQueryDSL | null {
  if (dsl.intent !== "count" && dsl.intent !== "group_stat") {
    return dsl;
  }

  const targetLayer = layerRegistry.getLayer(dsl.targetLayer);
  if (!targetLayer) {
    return null;
  }

  const baseOutputFields = defaultOutputFields(targetLayer);

  if (dsl.intent === "count" || dsl.aggregation?.type === "count") {
    const count = Number(payload.count ?? 0);
    const visualLimit = Math.min(
      Math.max(0, Number.isFinite(count) ? count : 0),
      Math.max(1, config.queryMaxFeatures),
      mapHighlightLimit()
    );
    if (visualLimit <= 0) {
      return null;
    }

    return {
      ...dsl,
      targetLayer: targetLayer.layerKey,
      intent: "search",
      aggregation: null,
      limit: visualLimit,
      output: {
        fields: baseOutputFields,
        returnGeometry: true
      }
    };
  }

  return {
    ...dsl,
    targetLayer: targetLayer.layerKey,
    intent: "search",
    aggregation: null,
    limit: Math.min(Math.max(1, config.queryMaxFeatures), mapHighlightLimit()),
    output: {
      fields: baseOutputFields,
      returnGeometry: true
    }
  };
}

function escapeSqlValue(value: string): string {
  return value.replace(/'/g, "''");
}

function isNumericFieldType(fieldType: string | undefined): boolean {
  if (!fieldType) {
    return true;
  }
  return [
    "esriFieldTypeOID",
    "esriFieldTypeInteger",
    "esriFieldTypeSmallInteger",
    "esriFieldTypeDouble",
    "esriFieldTypeSingle"
  ].includes(fieldType);
}

function parseSelectedObjectIds(
  rawValues: unknown,
  numericObjectId: boolean
): Array<number | string> {
  if (!Array.isArray(rawValues)) {
    return [];
  }

  const result: Array<number | string> = [];
  const seen = new Set<string>();
  for (const item of rawValues) {
    const text = String(item ?? "").trim();
    if (!text) {
      continue;
    }
    if (numericObjectId) {
      const value = Number(text);
      if (!Number.isFinite(value)) {
        continue;
      }
      const key = String(value);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(value);
      continue;
    }
    if (seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function buildSelectedWhere(
  objectIdField: string,
  values: Array<number | string>,
  numericObjectId: boolean
): string {
  if (values.length === 0) {
    return "1=0";
  }

  const clauses: string[] = [];
  for (let i = 0; i < values.length; i += SELECTED_IN_CLAUSE_CHUNK) {
    const chunk = values.slice(i, i + SELECTED_IN_CLAUSE_CHUNK);
    if (numericObjectId) {
      const raw = chunk.map((value) => Number(value)).join(",");
      clauses.push(`${objectIdField} IN (${raw})`);
    } else {
      const raw = chunk.map((value) => `'${escapeSqlValue(String(value))}'`).join(",");
      clauses.push(`${objectIdField} IN (${raw})`);
    }
  }
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

function pickFeatureLabel(attributes: Record<string, unknown> | undefined): string {
  if (!attributes) {
    return "未命名要素";
  }

  const preferredKeys = ["名称", "标准名称", "门牌号码", "标准地址", "道路街巷", "地址", "区县"];
  for (const key of preferredKeys) {
    const raw = attributes[key];
    if (raw === null || raw === undefined) {
      continue;
    }
    const text = String(raw).trim();
    if (text) {
      return text;
    }
  }

  for (const raw of Object.values(attributes)) {
    if (raw === null || raw === undefined) {
      continue;
    }
    const text = String(raw).trim();
    if (text) {
      return text;
    }
  }

  return "未命名要素";
}

function createSseWriter(reply: { raw: NodeJS.WritableStream & { writableEnded?: boolean; writable?: boolean } }) {
  let ended = false;

  const write = (chunk: string): boolean => {
    if (ended || reply.raw.writableEnded || reply.raw.writable === false) {
      return false;
    }
    reply.raw.write(chunk);
    return true;
  };

  const send = (event: string, payload: Record<string, unknown>): boolean => {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    return write(data);
  };

  const end = (status: StreamDoneStatus): void => {
    if (ended || reply.raw.writableEnded) {
      return;
    }
    send("done", { status });
    reply.raw.end();
    ended = true;
  };

  return {
    send,
    end,
    isEnded: () => ended || reply.raw.writableEnded || reply.raw.writable === false
  };
}

async function executeSpatialChatDsl(dsl: SpatialQueryDSL): Promise<{
  plan: QueryPlan;
  payload: Record<string, unknown>;
  features: Array<Record<string, unknown>>;
  executionMeta: ResponseExecutionMeta | undefined;
  layerName: string;
}> {
  const targetLayer = layerRegistry.getLayer(dsl.targetLayer);
  const layerName = targetLayer?.name ?? "要素";
  const executed = await executeDsl(dsl);
  const plan = executed.plan;
  const payload = executed.payload;
  let executionMeta = executed.executionMeta;
  let features = ((payload.features as Array<Record<string, unknown>>) ?? []);

  if (typeof payload.count === "number" || dsl.intent === "group_stat") {
    const visualDsl = buildVisualizationDsl(dsl, payload);
    if (visualDsl) {
      const visualExecuted = await executeDsl(visualDsl);
      const visualPayload = visualExecuted.payload;
      executionMeta = visualExecuted.executionMeta ?? executionMeta;
      features = ((visualPayload.features as Array<Record<string, unknown>>) ?? []);
    } else {
      features = [];
    }
  }

  const mapCapped = applyMapHighlightCap(
    features,
    executionMeta as Record<string, unknown> | undefined,
    typeof payload.count === "number" ? Number(payload.count) : null
  );

  return {
    plan,
    payload,
    features: mapCapped.features,
    executionMeta: mapCapped.executionMeta,
    layerName
  };
}

await app.register(cors, {
  origin: true
});

await layerRegistry.init();

app.get("/health", async () => ({ ok: true, ts: new Date().toISOString() }));

app.get("/api/layers/catalog", async () => {
  return layerRegistry.listCatalog();
});

app.post<{ Body: { serviceUrl: string } }>("/api/layers/catalog/register", async (req, reply) => {
  const serviceUrl = String(req.body?.serviceUrl ?? "").trim();
  if (!serviceUrl) {
    return reply.code(400).send({ message: "serviceUrl 不能为空" });
  }

  try {
    const result = await layerRegistry.registerService(serviceUrl);
    return {
      service: result.service,
      layers: result.layers,
      catalog: layerRegistry.listCatalog()
    };
  } catch (error) {
    if (isUserFacingError(error)) {
      return reply.code(error.statusCode).send({
        message: error.message,
        followUpQuestion: error.followUpQuestion ?? null,
        details: error.details ?? null
      });
    }
    req.log.error(error);
    return reply.code(500).send({ message: "图层服务注册失败", error: (error as Error).message });
  }
});

app.delete<{ Params: { serviceId: string } }>(
  "/api/layers/catalog/service/:serviceId",
  async (req, reply) => {
    try {
      await layerRegistry.removeService(req.params.serviceId);
      return {
        ok: true,
        catalog: layerRegistry.listCatalog()
      };
    } catch (error) {
      if (isUserFacingError(error)) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      req.log.error(error);
      return reply.code(500).send({ message: "删除服务失败", error: (error as Error).message });
    }
  }
);

app.patch<{
  Params: { layerKey: string };
  Body: { visibleByDefault?: boolean; queryable?: boolean; pointRenderMode?: "default" | "heatmap" };
}>(
  "/api/layers/catalog/layer/:layerKey",
  async (req, reply) => {
    const { visibleByDefault, queryable, pointRenderMode } = req.body ?? {};
    if (
      typeof visibleByDefault !== "boolean" &&
      typeof queryable !== "boolean" &&
      pointRenderMode !== "default" &&
      pointRenderMode !== "heatmap"
    ) {
      return reply.code(400).send({
        message: "至少提供 visibleByDefault、queryable 或 pointRenderMode（default|heatmap）之一。"
      });
    }

    try {
      const layer = await layerRegistry.updateLayerFlags(req.params.layerKey, {
        visibleByDefault,
        queryable,
        pointRenderMode
      });
      return {
        layer,
        catalog: layerRegistry.listCatalog()
      };
    } catch (error) {
      if (isUserFacingError(error)) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      req.log.error(error);
      return reply.code(500).send({ message: "图层状态更新失败", error: (error as Error).message });
    }
  }
);

app.get<{ Querystring: { layerKey?: string } }>("/api/layers/meta", async (req, reply) => {
  const layer = layerRegistry.getLayer(req.query.layerKey);
  if (!layer) {
    return reply.code(404).send({ message: "图层不存在" });
  }

  try {
    const meta = await fetchLayerMeta(layer.url);
    return {
      layerKey: layer.layerKey,
      layer: layer.url,
      meta
    };
  } catch (error) {
    if (isUserFacingError(error)) {
      return reply.code(error.statusCode).send({ message: error.message });
    }
    req.log.error(error);
    return reply.code(500).send({ message: "图层元数据请求失败", error: (error as Error).message });
  }
});

app.post<{
  Body: {
    layerKey: string;
    mode?: "selected" | "all";
    selectedObjectIds?: Array<number | string>;
    cursor?: number;
    pageSize?: number;
  };
}>("/api/layers/export/features-page", async (req, reply) => {
  const startedAt = Date.now();
  const layerKey = String(req.body?.layerKey ?? "").trim();
  if (!layerKey) {
    return reply.code(400).send({ message: "layerKey 不能为空。" });
  }

  const layer = layerRegistry.getLayer(layerKey);
  if (!layer || !layer.queryable) {
    return reply.code(404).send({ message: `图层 ${layerKey} 不存在或不可查询。` });
  }

  const mode = req.body?.mode === "selected" ? "selected" : "all";
  const cursor = Math.max(0, Math.floor(Number(req.body?.cursor ?? 0) || 0));
  const requestedPageSize = Number(req.body?.pageSize ?? config.exportPageSize);
  const pageSize = Math.max(
    1,
    Math.min(Number.isFinite(requestedPageSize) ? Math.floor(requestedPageSize) : config.exportPageSize, MAX_EXPORT_PAGE_SIZE)
  );
  const maxExportFeatures = Math.max(1, config.exportMaxFeatures);

  const objectIdField = layer.objectIdField;
  const objectIdFieldType = layer.fields.find((field) => field.name === objectIdField)?.type;
  const numericObjectId = isNumericFieldType(objectIdFieldType);
  const selectedObjectIds = parseSelectedObjectIds(req.body?.selectedObjectIds, numericObjectId);
  const where =
    mode === "selected"
      ? buildSelectedWhere(objectIdField, selectedObjectIds, numericObjectId)
      : "1=1";

  try {
    const countPayload = await queryArcgisLayer(layer.url, {
      f: "pjson",
      where,
      returnCountOnly: "true"
    });
    const totalMatched = Number(countPayload.count ?? 0);

    if (totalMatched > maxExportFeatures) {
      return reply.code(400).send({
        message: `导出数量 ${totalMatched} 超过上限 ${maxExportFeatures}。请缩小条件或提高 EXPORT_MAX_FEATURES。`,
        totalMatched,
        maxExportFeatures
      });
    }

    if (totalMatched <= 0 || cursor >= totalMatched) {
      return {
        layerKey: layer.layerKey,
        layerName: layer.name,
        objectIdField,
        geometryType: layer.geometryType,
        fields: layer.fields,
        cursor,
        nextCursor: cursor,
        hasMore: false,
        totalMatched,
        fetched: 0,
        maxExportFeatures,
        features: []
      };
    }

    const pagePayload = await queryArcgisLayer(layer.url, {
      f: "pjson",
      where,
      outFields: "*",
      returnGeometry: "true",
      outSR: "3857",
      orderByFields: `${objectIdField} asc`,
      resultOffset: String(cursor),
      resultRecordCount: String(pageSize)
    });
    const features = Array.isArray(pagePayload.features)
      ? (pagePayload.features as Array<Record<string, unknown>>)
      : [];
    const fetched = features.length;
    const nextCursor = cursor + fetched;
    const hasMore = nextCursor < totalMatched;

    req.log.info({
      layerKey: layer.layerKey,
      mode,
      totalMatched,
      fetched,
      cursor,
      nextCursor,
      durationMs: Date.now() - startedAt
    }, "[export] features-page");

    return {
      layerKey: layer.layerKey,
      layerName: layer.name,
      objectIdField,
      geometryType: layer.geometryType,
      fields: layer.fields,
      cursor,
      nextCursor,
      hasMore,
      totalMatched,
      fetched,
      maxExportFeatures,
      features
    };
  } catch (error) {
    req.log.error(error);
    return reply.code(500).send({ message: "导出分页查询失败", error: (error as Error).message });
  }
});

app.post<{ Body: { question: string } }>("/api/semantic/parse", async (req, reply) => {
  const question = String(req.body?.question ?? "").trim();
  if (!question) {
    return reply.code(400).send({ message: "question 不能为空" });
  }

  const parsed: ParseResponse = await parseQuestionSmart(question);
  return parsed;
});

app.post<{ Body: { dsl: SpatialQueryDSL } }>("/api/spatial/execute", async (req, reply) => {
  const result = spatialQueryDslSchema.safeParse(req.body?.dsl);
  if (!result.success) {
    return reply.code(400).send({ message: "dsl 校验失败", issues: result.error.issues });
  }

  try {
    const targetLayer = layerRegistry.getLayer(result.data.targetLayer);
    const layerName = targetLayer?.name ?? "要素";
    const { plan, payload, executionMeta, features } = await executeSpatialChatDsl(result.data);

    const response: ExecuteResponse & { targetLayerName: string } = {
      resolvedEntities: [],
      queryPlan: plan,
      features,
      summary: summarizeResult(result.data, payload, layerName),
      followUpQuestion: null,
      executionMeta,
      parserSource: "rule",
      targetLayerName: layerName
    };

    return response;
  } catch (error) {
    if (isUserFacingError(error)) {
      return reply.code(error.statusCode).send({
        message: error.message,
        followUpQuestion: error.followUpQuestion ?? null,
        details: error.details ?? null
      });
    }
    req.log.error(error);
    return reply.code(500).send({ message: "空间查询执行失败", error: (error as Error).message });
  }
});

app.post<{ Body: { question: string } }>("/api/chat/query", async (req, reply) => {
  const question = String(req.body?.question ?? "").trim();
  if (!question) {
    return reply.code(400).send({ message: "question 不能为空" });
  }

  if (!(await isSpatialQuestion(question))) {
    const general = await answerGeneralQuestion(question);
    return {
      dsl: null,
      resolvedEntities: [],
      queryPlan: null,
      features: [],
      summary: general.summary,
      followUpQuestion: null,
      parserSource: general.parserSource,
      parserFailureReason: null,
      parserFailureDetail: null,
      normalizedByRule: false,
      semanticWarnings: null,
      semanticMeta: {
        retrievalHits: 0,
        modelAttempts: 0,
        repaired: false,
        decisionPath: "general_chat"
      }
    };
  }

  const parsed = await parseQuestionSmart(question, { assumeSpatial: true });
  if (parsed.followUpQuestion) {
    return {
      dsl: parsed.dsl,
      resolvedEntities: [],
      queryPlan: null,
      features: [],
      summary: parsed.followUpQuestion,
      followUpQuestion: parsed.followUpQuestion,
      parserSource: parsed.parserSource,
      parserFailureReason: parsed.parserFailureReason ?? null,
      parserFailureDetail: parsed.parserFailureDetail ?? null,
      normalizedByRule: parsed.normalizedByRule ?? false,
      semanticWarnings: parsed.semanticWarnings ?? null,
      semanticMeta: parsed.semanticMeta ?? null
    };
  }

  try {
    const { plan, payload, executionMeta, features, layerName } = await executeSpatialChatDsl(parsed.dsl);

    return {
      dsl: parsed.dsl,
      resolvedEntities: [],
      queryPlan: plan,
      features,
      summary: summarizeResult(parsed.dsl, payload, layerName),
      followUpQuestion: parsed.followUpQuestion,
      executionMeta,
      parserSource: parsed.parserSource,
      parserFailureReason: parsed.parserFailureReason ?? null,
      parserFailureDetail: parsed.parserFailureDetail ?? null,
      normalizedByRule: parsed.normalizedByRule ?? false,
      semanticWarnings: parsed.semanticWarnings ?? null,
      semanticMeta: parsed.semanticMeta ?? null,
      targetLayerName: layerName
    };
  } catch (error) {
    if (isUserFacingError(error)) {
      return {
        dsl: parsed.dsl,
        resolvedEntities: [],
        queryPlan: null,
        features: [],
        summary: error.followUpQuestion ?? error.message,
        followUpQuestion: error.followUpQuestion ?? error.message,
        parserSource: parsed.parserSource,
        parserFailureReason: parsed.parserFailureReason ?? null,
        parserFailureDetail: parsed.parserFailureDetail ?? null,
        normalizedByRule: parsed.normalizedByRule ?? false,
        semanticWarnings: parsed.semanticWarnings ?? null,
        semanticMeta: parsed.semanticMeta ?? null
      };
    }
    req.log.error(error);
    return reply.code(500).send({
      message: "对话查询失败",
      error: (error as Error).message,
      dsl: parsed.dsl,
      parserSource: parsed.parserSource
    });
  }
});

app.post<{ Body: { question: string } }>("/api/chat/query/stream", async (req, reply) => {
  const question = String(req.body?.question ?? "").trim();
  if (!question) {
    return reply.code(400).send({ message: "question 不能为空" });
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  (reply.raw as { flushHeaders?: () => void }).flushHeaders?.();

  const writer = createSseWriter(reply);
  const clientAbort = new AbortController();
  const onClientAbort = () => {
    if (writer.isEnded()) {
      return;
    }
    clientAbort.abort();
    writer.end("aborted");
  };
  req.raw.on("aborted", onClientAbort);
  reply.raw.on("close", onClientAbort);

  const finish = (status: StreamDoneStatus): void => {
    req.raw.off("aborted", onClientAbort);
    reply.raw.off("close", onClientAbort);
    writer.end(status);
  };

  try {
    if (!(await isSpatialQuestion(question))) {
      if (writer.isEnded()) {
        return;
      }
      writer.send("stage", { stage: "general_chat_generating", message: "正在生成回复" });
      let streamed = "";
      const general = await answerGeneralQuestionStream(question, {
        signal: clientAbort.signal,
        onDelta: (text) => {
          streamed += text;
          writer.send("delta", { text });
        }
      });

      if (!streamed.trim() && general.summary.trim()) {
        streamed = general.summary;
        writer.send("delta", { text: general.summary });
      }

      writer.send("final", {
        dsl: null,
        resolvedEntities: [],
        queryPlan: null,
        features: [],
        summary: general.summary,
        followUpQuestion: null,
        parserSource: general.parserSource,
        parserFailureReason: null,
        parserFailureDetail: null,
        normalizedByRule: false,
        semanticWarnings: null,
        semanticMeta: {
          retrievalHits: 0,
          modelAttempts: 0,
          repaired: false,
          decisionPath: "general_chat"
        },
        summarySource: general.parserSource === "rule_fallback" ? "rule_fallback" : "llm_stream"
      });
      finish(clientAbort.signal.aborted ? "aborted" : "completed");
      return;
    }

    writer.send("stage", { stage: "semantic_parsing", message: "语义解析中" });
    const parsed = await parseQuestionSmart(question, { assumeSpatial: true });
    if (clientAbort.signal.aborted || writer.isEnded()) {
      finish("aborted");
      return;
    }

    if (parsed.followUpQuestion) {
      writer.send("final", {
        dsl: parsed.dsl,
        resolvedEntities: [],
        queryPlan: null,
        features: [],
        summary: parsed.followUpQuestion,
        followUpQuestion: parsed.followUpQuestion,
        parserSource: parsed.parserSource,
        parserFailureReason: parsed.parserFailureReason ?? null,
        parserFailureDetail: parsed.parserFailureDetail ?? null,
        normalizedByRule: parsed.normalizedByRule ?? false,
        semanticWarnings: parsed.semanticWarnings ?? null,
        semanticMeta: parsed.semanticMeta ?? null,
        summarySource: "follow_up"
      });
      finish("completed");
      return;
    }

    writer.send("stage", { stage: "spatial_executing", message: "空间执行中" });
    const { plan, payload, executionMeta, features, layerName } = await executeSpatialChatDsl(parsed.dsl);
    if (clientAbort.signal.aborted || writer.isEnded()) {
      finish("aborted");
      return;
    }

    writer.send("stage", { stage: "summary_generating", message: "摘要生成中" });
    let streamed = "";
    let summary = summarizeResult(parsed.dsl, payload, layerName);
    let summarySource = "narrator";
    try {
      const streamedSummary = await summarizeSpatialResultStream(
        {
          question,
          layerName,
          intent: parsed.dsl.intent,
          featureCount: features.length,
          count: typeof payload.count === "number" ? Number(payload.count) : null,
          analysisType: typeof plan.analysisType === "string" ? plan.analysisType : null,
          sampleLabels: features
            .slice(0, 5)
            .map((feature) => pickFeatureLabel(feature.attributes as Record<string, unknown> | undefined))
        },
        {
          signal: clientAbort.signal,
          onDelta: (text) => {
            streamed += text;
            writer.send("delta", { text });
          }
        }
      );
      summary = streamedSummary.summary;
      summarySource = "llm_stream";
    } catch (error) {
      if (clientAbort.signal.aborted) {
        finish("aborted");
        return;
      }
      req.log.warn(
        { reason: (error as Error).message },
        "[chat-stream] spatial summary stream failed, fallback to narrator"
      );
      summary = summarizeResult(parsed.dsl, payload, layerName);
      summarySource = "narrator_fallback";
      if (!streamed.trim() && summary.trim()) {
        streamed = summary;
        writer.send("delta", { text: summary });
      }
      writer.send("error", { message: "流式摘要失败，已回退规则摘要。" });
    }

    if (!streamed.trim() && summary.trim()) {
      writer.send("delta", { text: summary });
    }

    writer.send("final", {
      dsl: parsed.dsl,
      resolvedEntities: [],
      queryPlan: plan,
      features,
      summary,
      followUpQuestion: parsed.followUpQuestion,
      executionMeta,
      parserSource: parsed.parserSource,
      parserFailureReason: parsed.parserFailureReason ?? null,
      parserFailureDetail: parsed.parserFailureDetail ?? null,
      normalizedByRule: parsed.normalizedByRule ?? false,
      semanticWarnings: parsed.semanticWarnings ?? null,
      semanticMeta: parsed.semanticMeta ?? null,
      targetLayerName: layerName,
      summarySource
    });

    finish(clientAbort.signal.aborted ? "aborted" : "completed");
  } catch (error) {
    if (clientAbort.signal.aborted || writer.isEnded()) {
      finish("aborted");
      return;
    }
    req.log.error(error);
    writer.send("error", {
      message: (error as Error).message || "流式查询失败"
    });
    finish("error");
  }
});

app.listen({ port: config.port, host: config.host }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
