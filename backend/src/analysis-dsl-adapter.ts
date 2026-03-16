import type { FilterExprNode, SpatialQueryDSL } from "@gis/shared";
import type {
  AnalysisDslV2,
  AnalysisOperatorStep,
  AnalysisOperatorName
} from "./analysis-dsl-v2.js";
import { defaultOutputFields } from "./semantic-routing.js";
import { layerRegistry } from "./layer-registry.js";

interface AdaptResult {
  dsl: SpatialQueryDSL | null;
  supported: boolean;
  followUpQuestion: string | null;
}

type OperatorParams = Record<string, unknown>;

function cloneFilterExpr(expr: FilterExprNode | undefined): FilterExprNode | undefined {
  if (!expr) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(expr)) as FilterExprNode;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item)).filter(Boolean);
}

function getStepParams(step: AnalysisOperatorStep): OperatorParams {
  return (step.params ?? {}) as OperatorParams;
}

function appendPipelineStep(
  pipeline: AnalysisOperatorStep[],
  step: AnalysisOperatorStep,
  trackAsCurrent = true
): string {
  pipeline.push(step);
  return trackAsCurrent ? step.resultRef : step.inputs[step.inputs.length - 1] ?? step.resultRef;
}

function createBaseDsl(primaryLayer: string | null): SpatialQueryDSL | null {
  if (!primaryLayer) {
    return null;
  }
  const layer = layerRegistry.getLayer(primaryLayer);
  if (!layer) {
    return null;
  }
  return {
    intent: "search",
    targetLayer: primaryLayer,
    attributeFilter: [],
    aggregation: null,
    limit: 20,
    output: {
      fields: defaultOutputFields(layer),
      returnGeometry: true
    }
  };
}

function assignOrderBy(dsl: SpatialQueryDSL, params: OperatorParams): void {
  const field = String(params.field ?? "").trim();
  if (!field) {
    return;
  }
  const direction = params.direction === "desc" ? "desc" : "asc";
  dsl.orderBy = [{ field, direction }];
  dsl.sort = {
    by: field,
    order: direction
  };
}

function applyOperatorToLegacyDsl(dsl: SpatialQueryDSL, step: AnalysisOperatorStep): void {
  const params = getStepParams(step);
  switch (step.op as AnalysisOperatorName) {
    case "attribute_filter":
      dsl.attributeFilter = Array.isArray(params.attributeFilter)
        ? (params.attributeFilter as SpatialQueryDSL["attributeFilter"])
        : dsl.attributeFilter;
      dsl.filterExpr = cloneFilterExpr(params.filterExpr as FilterExprNode | undefined);
      return;
    case "sort":
      assignOrderBy(dsl, params);
      return;
    case "limit":
      if (typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
        dsl.limit = Math.round(params.limit);
      }
      return;
    case "distinct": {
      const groupBy = asStringArray(params.groupBy);
      dsl.aggregation = {
        type: "distinct",
        groupBy
      };
      dsl.output.returnGeometry = false;
      dsl.output.fields = groupBy;
      if (groupBy[0] && !dsl.orderBy?.length) {
        assignOrderBy(dsl, { field: groupBy[0], direction: "asc" });
      }
      return;
    }
    case "aggregate_count":
      dsl.intent = "count";
      dsl.aggregation = { type: "count" };
      dsl.output.returnGeometry = false;
      return;
    case "aggregate_group": {
      const groupBy = asStringArray(params.groupBy);
      dsl.intent = "group_stat";
      dsl.aggregation = {
        type: "group_count",
        groupBy
      };
      dsl.output.returnGeometry = false;
      if (groupBy[0]) {
        assignOrderBy(dsl, { field: groupBy[0], direction: "asc" });
      }
      return;
    }
    case "buffer":
      dsl.intent = "buffer_search";
      dsl.spatialFilter = {
        type: "buffer",
        radius: typeof params.radius === "number" ? params.radius : undefined,
        distances: Array.isArray(params.distances)
          ? params.distances.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)
          : undefined,
        unit: params.unit === "kilometer" ? "kilometer" : "meter",
        ringOnly: params.ringOnly === undefined ? undefined : Boolean(params.ringOnly),
        center:
          params.center && typeof params.center === "object"
            ? (params.center as NonNullable<SpatialQueryDSL["spatialFilter"]>["center"])
            : undefined,
        sourceLayer: typeof params.sourceLayer === "string" ? params.sourceLayer : undefined,
        sourceAttributeFilter: Array.isArray(params.sourceAttributeFilter)
          ? (params.sourceAttributeFilter as NonNullable<SpatialQueryDSL["spatialFilter"]>["sourceAttributeFilter"])
          : undefined,
        sourceFilterExpr: cloneFilterExpr(params.sourceFilterExpr as FilterExprNode | undefined)
      };
      return;
    case "spatial_predicate":
      dsl.spatialFilter = {
        ...(dsl.spatialFilter ?? {}),
        type: "relation",
        relation:
          params.relation === "contains" ||
          params.relation === "within" ||
          params.relation === "disjoint" ||
          params.relation === "touches" ||
          params.relation === "overlaps"
            ? params.relation
            : "intersects",
        joinMode: params.joinMode === "count_by_source" ? "count_by_source" : undefined,
        center:
          params.center && typeof params.center === "object"
            ? (params.center as NonNullable<SpatialQueryDSL["spatialFilter"]>["center"])
            : dsl.spatialFilter?.center,
        sourceLayer:
          typeof params.sourceLayer === "string"
            ? params.sourceLayer
            : dsl.spatialFilter?.sourceLayer,
        sourceAttributeFilter: Array.isArray(params.sourceAttributeFilter)
          ? (params.sourceAttributeFilter as NonNullable<SpatialQueryDSL["spatialFilter"]>["sourceAttributeFilter"])
          : dsl.spatialFilter?.sourceAttributeFilter,
        sourceFilterExpr:
          cloneFilterExpr(params.sourceFilterExpr as FilterExprNode | undefined) ??
          dsl.spatialFilter?.sourceFilterExpr
      };
      return;
    case "nearest":
      dsl.intent = "nearest";
      dsl.spatialFilter = {
        type: "nearest",
        radius: typeof params.radius === "number" ? params.radius : undefined,
        unit: params.unit === "kilometer" ? "kilometer" : "meter",
        excludeSelf: params.excludeSelf === undefined ? undefined : Boolean(params.excludeSelf),
        center:
          params.center && typeof params.center === "object"
            ? (params.center as NonNullable<SpatialQueryDSL["spatialFilter"]>["center"])
            : undefined,
        sourceLayer: typeof params.sourceLayer === "string" ? params.sourceLayer : undefined,
        sourceAttributeFilter: Array.isArray(params.sourceAttributeFilter)
          ? (params.sourceAttributeFilter as NonNullable<SpatialQueryDSL["spatialFilter"]>["sourceAttributeFilter"])
          : undefined,
        sourceFilterExpr: cloneFilterExpr(params.sourceFilterExpr as FilterExprNode | undefined)
      };
      return;
    case "spatial_join_count":
      dsl.intent = "count";
      dsl.aggregation = { type: "count" };
      dsl.output.returnGeometry = false;
      dsl.spatialFilter = {
        type: "relation",
        relation:
          params.relation === "contains" ||
          params.relation === "within" ||
          params.relation === "disjoint" ||
          params.relation === "touches" ||
          params.relation === "overlaps"
            ? params.relation
            : "intersects",
        joinMode: "count_by_source",
        sourceLayer: typeof params.sourceLayer === "string" ? params.sourceLayer : undefined,
        sourceAttributeFilter: Array.isArray(params.sourceAttributeFilter)
          ? (params.sourceAttributeFilter as NonNullable<SpatialQueryDSL["spatialFilter"]>["sourceAttributeFilter"])
          : undefined,
        sourceFilterExpr: cloneFilterExpr(params.sourceFilterExpr as FilterExprNode | undefined)
      };
      return;
    case "multi_ring_stat":
      dsl.intent = "search";
      dsl.output.returnGeometry = false;
      dsl.spatialFilter = {
        type: "buffer",
        distances: Array.isArray(params.distances)
          ? params.distances.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)
          : undefined,
        ringOnly: params.ringOnly === undefined ? true : Boolean(params.ringOnly),
        unit: params.unit === "kilometer" ? "kilometer" : "meter",
        center:
          params.center && typeof params.center === "object"
            ? (params.center as NonNullable<SpatialQueryDSL["spatialFilter"]>["center"])
            : undefined,
        sourceLayer: typeof params.sourceLayer === "string" ? params.sourceLayer : undefined,
        sourceAttributeFilter: Array.isArray(params.sourceAttributeFilter)
          ? (params.sourceAttributeFilter as NonNullable<SpatialQueryDSL["spatialFilter"]>["sourceAttributeFilter"])
          : undefined,
        sourceFilterExpr: cloneFilterExpr(params.sourceFilterExpr as FilterExprNode | undefined)
      };
      if (Array.isArray(dsl.spatialFilter?.distances)) {
        dsl.limit = dsl.spatialFilter.distances.length;
      }
      return;
    default:
      return;
  }
}

export function adaptAnalysisDslV2ToLegacy(analysisDsl: AnalysisDslV2): AdaptResult {
  const unsupportedStep = analysisDsl.analysisPipeline.find((step) =>
    ["clip", "intersect_overlay", "erase", "dissolve", "union_overlay"].includes(step.op)
  );
  if (unsupportedStep) {
    return {
      dsl: null,
      supported: false,
      followUpQuestion:
        `已识别到 ${unsupportedStep.op} 叠加分析，但当前执行器尚未开放该算子。请先改问检索、统计、缓冲、最近邻或空间关系查询。`
    };
  }

  const dsl = createBaseDsl(analysisDsl.primaryLayer);
  if (!dsl) {
    return {
      dsl: null,
      supported: false,
      followUpQuestion: "当前无法确定主目标图层，请明确图层后重试。"
    };
  }

  for (const step of analysisDsl.analysisPipeline) {
    applyOperatorToLegacyDsl(dsl, step);
  }

  return {
    dsl,
    supported: true,
    followUpQuestion: analysisDsl.clarification.followUpQuestion
  };
}

export function liftLegacyDslToAnalysisDslV2(dsl: SpatialQueryDSL): AnalysisDslV2 {
  const pipeline: AnalysisOperatorStep[] = [];
  const baseRef = "primary";
  let currentRef = baseRef;

  if (dsl.attributeFilter.length > 0 || dsl.filterExpr) {
    currentRef = appendPipelineStep(pipeline, {
      op: "attribute_filter",
      inputs: [baseRef],
      params: {
        attributeFilter: dsl.attributeFilter,
        filterExpr: dsl.filterExpr
      },
      resultRef: "filtered",
      visualize: true
    });
  }

  if (dsl.spatialFilter?.type === "buffer" && Array.isArray(dsl.spatialFilter.distances) && dsl.spatialFilter.distances.length > 1) {
    currentRef = appendPipelineStep(pipeline, {
      op: "multi_ring_stat",
      inputs: [currentRef],
      params: {
        distances: dsl.spatialFilter.distances,
        ringOnly: dsl.spatialFilter.ringOnly ?? true,
        unit: dsl.spatialFilter.unit ?? "meter",
        center: dsl.spatialFilter.center,
        sourceLayer: dsl.spatialFilter.sourceLayer,
        sourceAttributeFilter: dsl.spatialFilter.sourceAttributeFilter,
        sourceFilterExpr: dsl.spatialFilter.sourceFilterExpr
      },
      resultRef: "multi_ring",
      visualize: true
    });
  } else if (dsl.intent === "nearest") {
    currentRef = appendPipelineStep(pipeline, {
      op: "nearest",
      inputs: [currentRef],
      params: {
        radius: dsl.spatialFilter?.radius,
        unit: dsl.spatialFilter?.unit ?? "meter",
        center: dsl.spatialFilter?.center,
        sourceLayer: dsl.spatialFilter?.sourceLayer,
        sourceAttributeFilter: dsl.spatialFilter?.sourceAttributeFilter,
        sourceFilterExpr: dsl.spatialFilter?.sourceFilterExpr,
        excludeSelf: dsl.spatialFilter?.excludeSelf
      },
      resultRef: "nearest",
      visualize: true
    });
  } else if (dsl.spatialFilter?.type === "buffer") {
    const bufferRef = appendPipelineStep(pipeline, {
      op: "buffer",
      inputs: [currentRef],
      params: {
        radius: dsl.spatialFilter.radius,
        unit: dsl.spatialFilter.unit ?? "meter",
        center: dsl.spatialFilter.center,
        sourceLayer: dsl.spatialFilter.sourceLayer,
        sourceAttributeFilter: dsl.spatialFilter.sourceAttributeFilter,
        sourceFilterExpr: dsl.spatialFilter.sourceFilterExpr,
        ringOnly: dsl.spatialFilter.ringOnly
      },
      resultRef: "buffer_zone",
      visualize: true
    });
    currentRef = appendPipelineStep(pipeline, {
      op: "spatial_predicate",
      inputs: [bufferRef, currentRef],
      params: {
        relation: "intersects",
        sourceLayer: dsl.spatialFilter.sourceLayer,
        sourceAttributeFilter: dsl.spatialFilter.sourceAttributeFilter,
        sourceFilterExpr: dsl.spatialFilter.sourceFilterExpr,
        center: dsl.spatialFilter.center
      },
      resultRef: "buffer_result",
      visualize: true
    });
  } else if (dsl.spatialFilter?.type === "relation" && dsl.spatialFilter.joinMode === "count_by_source") {
    currentRef = appendPipelineStep(pipeline, {
      op: "spatial_join_count",
      inputs: [dsl.spatialFilter.sourceLayer ?? "source", currentRef],
      params: {
        relation: dsl.spatialFilter.relation ?? "within",
        sourceLayer: dsl.spatialFilter.sourceLayer,
        sourceAttributeFilter: dsl.spatialFilter.sourceAttributeFilter,
        sourceFilterExpr: dsl.spatialFilter.sourceFilterExpr
      },
      resultRef: "join_count",
      visualize: false
    });
  } else if (dsl.spatialFilter?.type === "relation") {
    currentRef = appendPipelineStep(pipeline, {
      op: "spatial_predicate",
      inputs: [dsl.spatialFilter.sourceLayer ?? "source", currentRef],
      params: {
        relation: dsl.spatialFilter.relation ?? "intersects",
        sourceLayer: dsl.spatialFilter.sourceLayer,
        sourceAttributeFilter: dsl.spatialFilter.sourceAttributeFilter,
        sourceFilterExpr: dsl.spatialFilter.sourceFilterExpr,
        center: dsl.spatialFilter.center
      },
      resultRef: "relation_result",
      visualize: true
    });
  }

  if (dsl.aggregation?.type === "distinct") {
    currentRef = appendPipelineStep(pipeline, {
      op: "distinct",
      inputs: [currentRef],
      params: {
        groupBy: dsl.aggregation.groupBy ?? []
      },
      resultRef: "distinct_result",
      visualize: false
    });
  } else if (dsl.intent === "count" || dsl.aggregation?.type === "count") {
    currentRef = appendPipelineStep(pipeline, {
      op: "aggregate_count",
      inputs: [currentRef],
      resultRef: "count_result",
      visualize: false
    });
  } else if (dsl.intent === "group_stat" || dsl.aggregation?.type === "group_count") {
    currentRef = appendPipelineStep(pipeline, {
      op: "aggregate_group",
      inputs: [currentRef],
      params: {
        groupBy: dsl.aggregation?.groupBy ?? []
      },
      resultRef: "group_result",
      visualize: false
    });
  }

  if (dsl.orderBy?.length) {
    const first = dsl.orderBy[0];
    currentRef = appendPipelineStep(pipeline, {
      op: "sort",
      inputs: [currentRef],
      params: {
        field: first.field,
        direction: first.direction
      },
      resultRef: "sorted_result",
      visualize: true
    });
  }

  if (dsl.limit > 0) {
    currentRef = appendPipelineStep(pipeline, {
      op: "limit",
      inputs: [currentRef],
      params: {
        limit: dsl.limit
      },
      resultRef: "limited_result",
      visualize: true
    });
  }

  const goal =
    dsl.intent === "count" || dsl.intent === "group_stat"
      ? "summarize"
      : dsl.intent === "buffer_search" || dsl.intent === "nearest"
        ? "compare"
        : "retrieve";
  const sourceLayers = dsl.spatialFilter?.sourceLayer ? [dsl.spatialFilter.sourceLayer] : [];

  return {
    goal,
    primaryLayer: dsl.targetLayer,
    sourceLayers,
    analysisPipeline: pipeline,
    output: {
      mode: dsl.output.returnGeometry ? "features" : "stats",
      visualMode: dsl.output.returnGeometry ? "highlight" : "stats",
      returnGeometry: dsl.output.returnGeometry,
      fields: dsl.output.fields
    },
    clarification: {
      actionable: true,
      followUpQuestion: null,
      missingSlots: []
    }
  };
}
