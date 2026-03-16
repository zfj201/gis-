import type { FilterExprNode, LayerDescriptor, SpatialQueryDSL } from "@gis/shared";

export type AnalysisGoal = "retrieve" | "summarize" | "compare" | "transform" | "overlay";

export type AnalysisFamily =
  | "attribute_retrieve"
  | "aggregate"
  | "buffer"
  | "nearest"
  | "relation"
  | "spatial_join"
  | "multi_ring"
  | "overlay";

export type AnalysisOperatorName =
  | "attribute_filter"
  | "sort"
  | "limit"
  | "distinct"
  | "aggregate_count"
  | "aggregate_group"
  | "buffer"
  | "spatial_predicate"
  | "nearest"
  | "spatial_join_count"
  | "multi_ring_stat"
  | "clip"
  | "intersect_overlay"
  | "erase"
  | "dissolve"
  | "union_overlay";

export type VisualMode = "highlight" | "buffer" | "derived_geometry" | "stats" | "none";
export type OutputMode = "features" | "stats" | "geometry" | "text";

export interface AnalysisDataRef {
  ref: string;
  layerKey?: string;
  role?: "primary" | "source" | "derived";
}

export interface AnalysisOperatorStep {
  op: AnalysisOperatorName;
  inputs: string[];
  params?: Record<string, unknown>;
  resultRef: string;
  visualize?: boolean;
}

export interface AnalysisOutputPolicy {
  mode: OutputMode;
  visualMode: VisualMode;
  returnGeometry: boolean;
  fields?: string[];
}

export interface AnalysisClarification {
  actionable: boolean;
  followUpQuestion: string | null;
  missingSlots: string[];
  reason?: string;
}

export interface AnalysisDslV2 {
  goal: AnalysisGoal;
  primaryLayer: string | null;
  sourceLayers: string[];
  analysisPipeline: AnalysisOperatorStep[];
  output: AnalysisOutputPolicy;
  clarification: AnalysisClarification;
}

export interface RuleProfile {
  analysisFamily: AnalysisFamily;
  goal: AnalysisGoal;
  lockedOperators: AnalysisOperatorName[];
  lockedOutputPolicy: AnalysisOutputPolicy;
  requiredSlots: string[];
  forbiddenMutations: string[];
  candidateLayers: Array<Pick<LayerDescriptor, "layerKey" | "name" | "geometryType">>;
  fieldHints: string[];
  clarificationTriggers: string[];
  actionable: boolean;
  followUpQuestion: string | null;
  analysisDsl: AnalysisDslV2;
  legacySeedDsl: SpatialQueryDSL | null;
  legacySeedFilterExpr?: FilterExprNode;
}

export interface OperatorDefinition {
  name: AnalysisOperatorName;
  family: AnalysisFamily | "shared";
  description: string;
  minInputs: number;
  outputMode: OutputMode;
  visualMode: VisualMode;
  requiresGeometrySource?: boolean;
  supportedLegacy: boolean;
}
