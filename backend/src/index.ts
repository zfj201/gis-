import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  type ExecuteResponse,
  type ParseResponse,
  spatialQueryDslSchema,
  type SpatialQueryDSL
} from "@gis/shared";
import { compileQueryPlan } from "./compiler.js";
import { config } from "./config.js";
import { executeArcgisQuery, fetchLayerMeta } from "./arcgis.js";
import { summarizeResult } from "./narrator.js";
import { answerGeneralQuestion, isSpatialQuestion, parseQuestionSmart } from "./semantic-llm.js";

const app = Fastify({ logger: true });

function buildVisualizationDsl(
  dsl: SpatialQueryDSL,
  payload: Record<string, unknown>
): SpatialQueryDSL | null {
  if (dsl.intent !== "count" && dsl.intent !== "group_stat") {
    return dsl;
  }

  if (dsl.intent === "count" || dsl.aggregation?.type === "count") {
    const count = Number(payload.count ?? 0);
    const visualLimit = Math.min(Math.max(0, Number.isFinite(count) ? count : 0), 2000);
    if (visualLimit <= 0) {
      return null;
    }

    return {
      ...dsl,
      intent: "search",
      aggregation: null,
      limit: visualLimit,
      output: {
        fields: ["fid", "名称", "地址", "区县"],
        returnGeometry: true
      }
    };
  }

  return {
    ...dsl,
    intent: "search",
    aggregation: null,
    limit: 2000,
    output: {
      fields: ["fid", "名称", "地址", "区县"],
      returnGeometry: true
    }
  };
}

await app.register(cors, {
  origin: true
});

app.get("/health", async () => ({ ok: true, ts: new Date().toISOString() }));

app.get("/api/layers/meta", async () => {
  const meta = await fetchLayerMeta(config.parksLayerUrl);
  return {
    layer: config.parksLayerUrl,
    meta
  };
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
    const plan = compileQueryPlan(result.data);
    const payload = await executeArcgisQuery(plan);
    let features = ((payload.features as Array<Record<string, unknown>>) ?? []);

    if (typeof payload.count === "number" || result.data.intent === "group_stat") {
      const visualDsl = buildVisualizationDsl(result.data, payload);
      if (visualDsl) {
        const visualPlan = compileQueryPlan(visualDsl);
        const visualPayload = await executeArcgisQuery(visualPlan);
        features = ((visualPayload.features as Array<Record<string, unknown>>) ?? []);
      } else {
        features = [];
      }
    }

    const response: ExecuteResponse = {
      resolvedEntities: [],
      queryPlan: plan,
      features,
      summary: summarizeResult(result.data, payload),
      followUpQuestion: null,
      parserSource: "rule"
    };

    return response;
  } catch (error) {
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
      parserSource: general.parserSource
    };
  }

  const parsed = await parseQuestionSmart(question);
  if (parsed.followUpQuestion && !parsed.dsl.spatialFilter?.center) {
    return {
      dsl: parsed.dsl,
      resolvedEntities: [],
      queryPlan: null,
      features: [],
      summary: parsed.followUpQuestion,
      followUpQuestion: parsed.followUpQuestion,
      parserSource: parsed.parserSource
    };
  }

  try {
    const plan = compileQueryPlan(parsed.dsl);
    const payload = await executeArcgisQuery(plan);
    let features = ((payload.features as Array<Record<string, unknown>>) ?? []);

    if (typeof payload.count === "number" || parsed.dsl.intent === "group_stat") {
      const visualDsl = buildVisualizationDsl(parsed.dsl, payload);
      if (visualDsl) {
        const visualPlan = compileQueryPlan(visualDsl);
        const visualPayload = await executeArcgisQuery(visualPlan);
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
      summary: summarizeResult(parsed.dsl, payload),
      followUpQuestion: parsed.followUpQuestion,
      parserSource: parsed.parserSource
    };
  } catch (error) {
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
