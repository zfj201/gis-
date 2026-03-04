import { z } from "zod";

export const intentSchema = z.enum([
  "search",
  "count",
  "group_stat",
  "nearest",
  "buffer_search"
]);

export const locationTypeSchema = z.enum([
  "point",
  "road",
  "subdistrict",
  "county",
  "unknown"
]);

export const operatorSchema = z.enum([
  "=",
  "like",
  ">",
  ">=",
  "<",
  "<="
]);

export const attributeFilterSchema = z.object({
  field: z.string().min(1),
  operator: operatorSchema,
  value: z.string().min(1)
});

export const spatialFilterSchema = z
  .object({
    type: z.enum(["buffer", "intersects", "nearest"]).optional(),
    radius: z.number().positive().optional(),
    unit: z.enum(["meter", "kilometer"]).optional(),
    ringOnly: z.boolean().optional(),
    sourceLayer: z.string().min(1).optional(),
    sourceAttributeFilter: z.array(attributeFilterSchema).optional(),
    center: z
      .object({
        x: z.number(),
        y: z.number(),
        spatialReference: z
          .object({
            wkid: z.number().int().positive().optional(),
            latestWkid: z.number().int().positive().optional()
          })
          .optional()
      })
      .optional()
  })
  .optional();

export const spatialQueryDslSchema = z.object({
  intent: intentSchema,
  targetLayer: z.string().default("fuzhou_parks"),
  locationEntity: z
    .object({
      rawText: z.string().optional(),
      type: locationTypeSchema,
      resolution: z.enum(["resolved", "needs_clarification", "missing_dependency"]).optional()
    })
    .optional(),
  spatialFilter: spatialFilterSchema,
  attributeFilter: z.array(attributeFilterSchema).default([]),
  aggregation: z
    .object({
      type: z.enum(["count", "group_count"]).optional(),
      groupBy: z.array(z.string()).optional()
    })
    .nullable()
    .optional(),
  sort: z
    .object({
      by: z.string(),
      order: z.enum(["asc", "desc"])
    })
    .optional(),
  limit: z.number().int().positive().max(500000).default(20),
  output: z.object({
    fields: z.array(z.string()).default([]),
    returnGeometry: z.boolean().default(true)
  })
});

export type SpatialQueryDSL = z.infer<typeof spatialQueryDslSchema>;
export type ParserSource = "gemini" | "groq" | "openrouter" | "rule" | "rule_fallback";

export interface ParseResponse {
  dsl: SpatialQueryDSL;
  confidence: number;
  followUpQuestion: string | null;
  parserSource: ParserSource;
  parserFailureReason?: string;
  parserFailureDetail?: string;
  normalizedByRule?: boolean;
}

export interface QueryPlan {
  layer: string;
  where: string;
  geometry: Record<string, unknown> | null;
  geometryType: string | null;
  spatialRel: string | null;
  distance: number | null;
  units: string | null;
  outFields: string;
  returnGeometry: boolean;
  orderByFields?: string;
  resultRecordCount?: number;
  resultOffset?: number;
  returnCountOnly?: boolean;
  groupByFieldsForStatistics?: string;
  outStatistics?: string;
  analysisType?: "nearest";
  nearestMeta?: {
    topK: number;
    sourceMode: "center" | "source_layer";
    sourceLayer?: string;
    sourceObjectId?: string;
    radiusUsedMeters: number;
    candidateCount: number;
  };
}

export interface ExecuteResponse {
  resolvedEntities: Array<Record<string, unknown>>;
  queryPlan: QueryPlan;
  features: Array<Record<string, unknown>>;
  summary: string;
  followUpQuestion: string | null;
  executionMeta?: {
    truncated: boolean;
    safetyCap: number;
    fetched: number;
    requestedLimit: number;
  };
  parserSource?: ParserSource;
  parserFailureReason?: string;
  parserFailureDetail?: string;
  normalizedByRule?: boolean;
}
