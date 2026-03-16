import type { AnalysisDslV2, AnalysisOperatorName, OperatorDefinition } from "./analysis-dsl-v2.js";

const operatorDefinitions: Record<AnalysisOperatorName, OperatorDefinition> = {
  attribute_filter: {
    name: "attribute_filter",
    family: "shared",
    description: "Attribute filtering on the primary layer.",
    minInputs: 1,
    outputMode: "features",
    visualMode: "highlight",
    supportedLegacy: true
  },
  sort: {
    name: "sort",
    family: "shared",
    description: "Ordering result features.",
    minInputs: 1,
    outputMode: "features",
    visualMode: "highlight",
    supportedLegacy: true
  },
  limit: {
    name: "limit",
    family: "shared",
    description: "Limiting result features.",
    minInputs: 1,
    outputMode: "features",
    visualMode: "highlight",
    supportedLegacy: true
  },
  distinct: {
    name: "distinct",
    family: "aggregate",
    description: "Distinct projection on a target field.",
    minInputs: 1,
    outputMode: "stats",
    visualMode: "stats",
    supportedLegacy: true
  },
  aggregate_count: {
    name: "aggregate_count",
    family: "aggregate",
    description: "Count matched features.",
    minInputs: 1,
    outputMode: "stats",
    visualMode: "stats",
    supportedLegacy: true
  },
  aggregate_group: {
    name: "aggregate_group",
    family: "aggregate",
    description: "Group and count matched features.",
    minInputs: 1,
    outputMode: "stats",
    visualMode: "stats",
    supportedLegacy: true
  },
  buffer: {
    name: "buffer",
    family: "buffer",
    description: "Buffer from center or source geometry.",
    minInputs: 1,
    outputMode: "geometry",
    visualMode: "buffer",
    requiresGeometrySource: true,
    supportedLegacy: true
  },
  spatial_predicate: {
    name: "spatial_predicate",
    family: "relation",
    description: "Apply spatial relationship on buffered or source geometry.",
    minInputs: 2,
    outputMode: "features",
    visualMode: "highlight",
    requiresGeometrySource: true,
    supportedLegacy: true
  },
  nearest: {
    name: "nearest",
    family: "nearest",
    description: "Nearest search from center or source geometry.",
    minInputs: 1,
    outputMode: "features",
    visualMode: "highlight",
    requiresGeometrySource: true,
    supportedLegacy: true
  },
  spatial_join_count: {
    name: "spatial_join_count",
    family: "spatial_join",
    description: "Count target features per source feature.",
    minInputs: 2,
    outputMode: "stats",
    visualMode: "stats",
    requiresGeometrySource: true,
    supportedLegacy: true
  },
  multi_ring_stat: {
    name: "multi_ring_stat",
    family: "multi_ring",
    description: "Multi-ring buffer statistics.",
    minInputs: 1,
    outputMode: "stats",
    visualMode: "buffer",
    requiresGeometrySource: true,
    supportedLegacy: true
  },
  clip: {
    name: "clip",
    family: "overlay",
    description: "Clip target geometry by source geometry.",
    minInputs: 2,
    outputMode: "geometry",
    visualMode: "derived_geometry",
    requiresGeometrySource: true,
    supportedLegacy: false
  },
  intersect_overlay: {
    name: "intersect_overlay",
    family: "overlay",
    description: "Overlay intersection across layers.",
    minInputs: 2,
    outputMode: "geometry",
    visualMode: "derived_geometry",
    requiresGeometrySource: true,
    supportedLegacy: false
  },
  erase: {
    name: "erase",
    family: "overlay",
    description: "Erase source geometry from target geometry.",
    minInputs: 2,
    outputMode: "geometry",
    visualMode: "derived_geometry",
    requiresGeometrySource: true,
    supportedLegacy: false
  },
  dissolve: {
    name: "dissolve",
    family: "overlay",
    description: "Dissolve geometries by grouping field.",
    minInputs: 1,
    outputMode: "geometry",
    visualMode: "derived_geometry",
    supportedLegacy: false
  },
  union_overlay: {
    name: "union_overlay",
    family: "overlay",
    description: "Union multiple layer geometries.",
    minInputs: 2,
    outputMode: "geometry",
    visualMode: "derived_geometry",
    requiresGeometrySource: true,
    supportedLegacy: false
  }
};

export function listOperatorDefinitions(): OperatorDefinition[] {
  return Object.values(operatorDefinitions);
}

export function getOperatorDefinition(name: AnalysisOperatorName): OperatorDefinition {
  return operatorDefinitions[name];
}

export function areOperatorsLegacyCompatible(operators: AnalysisOperatorName[]): boolean {
  return operators.every((operatorName) => operatorDefinitions[operatorName]?.supportedLegacy);
}

export function validateAnalysisDslOperators(analysisDsl: AnalysisDslV2): string[] {
  const problems: string[] = [];
  const knownRefs = new Set<string>(["primary", ...analysisDsl.sourceLayers]);

  for (const step of analysisDsl.analysisPipeline) {
    const definition = operatorDefinitions[step.op];
    if (!definition) {
      problems.push(`未注册算子: ${step.op}`);
      continue;
    }

    if (step.inputs.length < definition.minInputs) {
      problems.push(`${step.op} 输入数量不足`);
    }

    for (const input of step.inputs) {
      if (!knownRefs.has(input)) {
        problems.push(`${step.op} 引用了未定义的输入: ${input}`);
      }
    }

    const params = (step.params ?? {}) as Record<string, unknown>;
    const hasDerivedGeometryInput = step.inputs.some((input) => input !== "primary" && knownRefs.has(input));
    const hasExplicitGeometrySource =
      Boolean(params.center && typeof params.center === "object") ||
      (typeof params.sourceLayer === "string" && params.sourceLayer.trim().length > 0);
    if (definition.requiresGeometrySource && !hasDerivedGeometryInput && !hasExplicitGeometrySource) {
      problems.push(`${step.op} 缺少合法的几何来源`);
    }

    if ((step.op === "aggregate_group" || step.op === "distinct") && !hasNonEmptyStringArray(params.groupBy)) {
      problems.push(`${step.op} 缺少 groupBy`);
    }
    if (step.op === "sort" && typeof params.field !== "string") {
      problems.push("sort 缺少排序字段");
    }
    if (step.op === "limit" && !isPositiveFiniteNumber(params.limit)) {
      problems.push("limit 缺少正整数上限");
    }
    if (step.op === "buffer") {
      const hasRadius = isPositiveFiniteNumber(params.radius);
      const hasDistances =
        Array.isArray(params.distances) &&
        params.distances.some((item) => isPositiveFiniteNumber(item));
      if (!hasRadius && !hasDistances && !hasExplicitGeometrySource && !hasDerivedGeometryInput) {
        problems.push("buffer 缺少半径或几何来源");
      }
    }

    knownRefs.add(step.resultRef);
  }

  return Array.from(new Set(problems));
}

function isPositiveFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim().length > 0);
}
