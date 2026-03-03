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
import { fetchLayerMeta } from "./arcgis.js";
import { isUserFacingError } from "./errors.js";
import { layerRegistry } from "./layer-registry.js";
import { summarizeResult } from "./narrator.js";
import { defaultOutputFields } from "./semantic-routing.js";
import { answerGeneralQuestion, isSpatialQuestion, parseQuestionSmart } from "./semantic-llm.js";
import { executeDsl } from "./spatial-executor.js";

const app = Fastify({ logger: true });

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
    const visualLimit = Math.min(Math.max(0, Number.isFinite(count) ? count : 0), 2000);
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
    limit: 2000,
    output: {
      fields: baseOutputFields,
      returnGeometry: true
    }
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

app.patch<{ Params: { layerKey: string }; Body: { visibleByDefault?: boolean; queryable?: boolean } }>(
  "/api/layers/catalog/layer/:layerKey",
  async (req, reply) => {
    const { visibleByDefault, queryable } = req.body ?? {};
    if (typeof visibleByDefault !== "boolean" && typeof queryable !== "boolean") {
      return reply.code(400).send({ message: "至少提供 visibleByDefault 或 queryable 的一个布尔值。" });
    }

    try {
      const layer = await layerRegistry.updateLayerFlags(req.params.layerKey, {
        visibleByDefault,
        queryable
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
    let features = ((payload.features as Array<Record<string, unknown>>) ?? []);

    if (typeof payload.count === "number" || result.data.intent === "group_stat") {
      const visualDsl = buildVisualizationDsl(result.data, payload);
      if (visualDsl) {
        const visualExecuted = await executeDsl(visualDsl);
        const visualPayload = visualExecuted.payload;
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

  if (!isSpatialQuestion(question)) {
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
      normalizedByRule: false
    };
  }

  const parsed = await parseQuestionSmart(question);
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
      normalizedByRule: parsed.normalizedByRule ?? false
    };
  }

  try {
    const targetLayer = layerRegistry.getLayer(parsed.dsl.targetLayer);
    const layerName = targetLayer?.name ?? "要素";
    const executed = await executeDsl(parsed.dsl);
    const plan = executed.plan;
    const payload = executed.payload;
    let features = ((payload.features as Array<Record<string, unknown>>) ?? []);

    if (typeof payload.count === "number" || parsed.dsl.intent === "group_stat") {
      const visualDsl = buildVisualizationDsl(parsed.dsl, payload);
      if (visualDsl) {
        const visualExecuted = await executeDsl(visualDsl);
        const visualPayload = visualExecuted.payload;
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
      parserSource: parsed.parserSource,
      parserFailureReason: parsed.parserFailureReason ?? null,
      parserFailureDetail: parsed.parserFailureDetail ?? null,
      normalizedByRule: parsed.normalizedByRule ?? false,
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
        normalizedByRule: parsed.normalizedByRule ?? false
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
