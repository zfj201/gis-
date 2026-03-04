import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  type ExecuteResponse,
  type ParseResponse,
  spatialQueryDslSchema,
  type SpatialQueryDSL
} from "@gis/shared";
import { config } from "./config.js";
import { fetchLayerMeta, queryArcgisLayer } from "./arcgis.js";
import { isUserFacingError } from "./errors.js";
import { layerRegistry } from "./layer-registry.js";
import { summarizeResult } from "./narrator.js";
import { defaultOutputFields } from "./semantic-routing.js";
import { answerGeneralQuestion, isSpatialQuestion, parseQuestionSmart } from "./semantic-llm.js";
import { executeDsl } from "./spatial-executor.js";

const app = Fastify({ logger: true });

const MAX_EXPORT_PAGE_SIZE = 5000;
const SELECTED_IN_CLAUSE_CHUNK = 800;

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
      Math.max(1, config.queryMaxFeatures)
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
    limit: Math.max(1, config.queryMaxFeatures),
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
    const executed = await executeDsl(result.data);
    const plan = executed.plan;
    const payload = executed.payload;
    let executionMeta = executed.executionMeta;
    let features = ((payload.features as Array<Record<string, unknown>>) ?? []);

    if (typeof payload.count === "number" || result.data.intent === "group_stat") {
      const visualDsl = buildVisualizationDsl(result.data, payload);
      if (visualDsl) {
        const visualExecuted = await executeDsl(visualDsl);
        const visualPayload = visualExecuted.payload;
        executionMeta = visualExecuted.executionMeta ?? executionMeta;
        features = ((visualPayload.features as Array<Record<string, unknown>>) ?? []);
      } else {
        features = [];
      }
    }

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
      semanticWarnings: null
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
      semanticWarnings: parsed.semanticWarnings ?? null
    };
  }

  try {
    const targetLayer = layerRegistry.getLayer(parsed.dsl.targetLayer);
    const layerName = targetLayer?.name ?? "要素";
    const executed = await executeDsl(parsed.dsl);
    const plan = executed.plan;
    const payload = executed.payload;
    let executionMeta = executed.executionMeta;
    let features = ((payload.features as Array<Record<string, unknown>>) ?? []);

    if (typeof payload.count === "number" || parsed.dsl.intent === "group_stat") {
      const visualDsl = buildVisualizationDsl(parsed.dsl, payload);
      if (visualDsl) {
        const visualExecuted = await executeDsl(visualDsl);
        const visualPayload = visualExecuted.payload;
        executionMeta = visualExecuted.executionMeta ?? executionMeta;
        features = ((visualPayload.features as Array<Record<string, unknown>>) ?? []);
      } else {
        features = [];
      }
    }

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
        semanticWarnings: parsed.semanticWarnings ?? null
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

app.listen({ port: config.port, host: config.host }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
