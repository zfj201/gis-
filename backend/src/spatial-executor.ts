import type { FilterExprNode, LayerDescriptor, QueryPlan, SpatialQueryDSL } from "@gis/shared";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import DistanceOp from "jsts/org/locationtech/jts/operation/distance/DistanceOp.js";
import { compileQueryPlan } from "./compiler.js";
import { config } from "./config.js";
import { UserFacingError } from "./errors.js";
import { executeArcgisQuery } from "./arcgis.js";
import { layerRegistry } from "./layer-registry.js";
import { normalizeDistancesMeters, normalizeRadiusMeters } from "./spatial-distance.js";

interface ArcgisFeatureLike {
  geometry?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

interface ArcgisPayloadLike {
  features?: ArcgisFeatureLike[];
  exceededTransferLimit?: boolean;
}

export interface ExecutionMeta {
  truncated: boolean;
  safetyCap: number;
  fetched: number;
  requestedLimit: number;
}

export interface DslExecutionResult {
  plan: QueryPlan;
  payload: Record<string, unknown>;
  executionMeta?: ExecutionMeta;
}

function normalizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function shouldUsePagination(plan: QueryPlan): boolean {
  if (plan.returnCountOnly) {
    return false;
  }
  if (plan.groupByFieldsForStatistics || plan.outStatistics) {
    return false;
  }
  if (plan.returnDistinctValues) {
    return false;
  }
  return true;
}

async function queryCountForPlan(plan: QueryPlan): Promise<number | null> {
  try {
    const countPayload = await executeArcgisQuery({
      ...plan,
      returnCountOnly: true,
      returnGeometry: false,
      resultRecordCount: undefined,
      resultOffset: undefined,
      orderByFields: undefined
    });
    const count = Number(countPayload.count ?? NaN);
    if (!Number.isFinite(count) || count < 0) {
      return null;
    }
    return Math.floor(count);
  } catch (error) {
    console.warn("[spatial-executor] count preflight failed, fallback to streaming", {
      reason: (error as Error).message
    });
    return null;
  }
}

async function executePlanWithPagination(
  plan: QueryPlan,
  requestedLimit: number,
  context: string
): Promise<{ payload: Record<string, unknown>; executionMeta: ExecutionMeta }> {
  const startedAt = Date.now();
  const safetyCap = normalizePositiveInt(config.queryMaxFeatures, 500000);
  const pageSize = normalizePositiveInt(config.queryPageSize, 2000);
  const maxPages = normalizePositiveInt(config.queryMaxPages, 2000);
  const normalizedRequested = normalizePositiveInt(requestedLimit, safetyCap);
  const cappedRequested = Math.min(normalizedRequested, safetyCap);
  const shouldCount = normalizedRequested >= safetyCap;
  const totalMatched = shouldCount ? await queryCountForPlan(plan) : null;
  const effectiveLimit = Math.min(cappedRequested, totalMatched ?? cappedRequested);

  if (effectiveLimit <= 0) {
    return {
      payload: { features: [] },
      executionMeta: {
        truncated: false,
        safetyCap,
        fetched: 0,
        requestedLimit: normalizedRequested
      }
    };
  }

  const features: ArcgisFeatureLike[] = [];
  let offset = 0;
  let pageNo = 0;
  let lastExceededTransferLimit = false;

  while (features.length < effectiveLimit) {
    if (pageNo >= maxPages) {
      console.warn("[spatial-executor] page cap reached", {
        context,
        maxPages,
        fetchedTotal: features.length
      });
      break;
    }

    const remaining = effectiveLimit - features.length;
    const batchSize = Math.max(1, Math.min(pageSize, remaining));
    const batchPlan: QueryPlan = {
      ...plan,
      resultOffset: offset,
      resultRecordCount: batchSize,
      returnCountOnly: false
    };
    const payload = (await executeArcgisQuery(batchPlan)) as ArcgisPayloadLike;
    const batch = Array.isArray(payload.features) ? payload.features : [];
    features.push(...batch);

    const exceededTransferLimit = Boolean(payload.exceededTransferLimit);
    lastExceededTransferLimit = exceededTransferLimit;
    pageNo += 1;
    offset += batch.length;

    console.info("[spatial-executor] paged query batch", {
      context,
      pageNo,
      offset,
      batchSize,
      fetchedTotal: features.length,
      requestedLimit: normalizedRequested,
      safetyCap,
      exceededTransferLimit
    });

    if (batch.length === 0) {
      break;
    }
    if (batch.length < batchSize && !exceededTransferLimit) {
      break;
    }
  }

  const fetched = features.length;
  const truncatedBySafetyCap =
    normalizedRequested >= safetyCap &&
    ((totalMatched !== null && totalMatched > fetched) ||
      (totalMatched === null && fetched >= safetyCap && lastExceededTransferLimit));

  console.info("[spatial-executor] paged query finished", {
    context,
    fetchedTotal: fetched,
    requestedLimit: normalizedRequested,
    safetyCap,
    truncated: truncatedBySafetyCap,
    durationMs: Date.now() - startedAt
  });

  return {
    payload: {
      features,
      exceededTransferLimit: truncatedBySafetyCap
    },
    executionMeta: {
      truncated: truncatedBySafetyCap,
      safetyCap,
      fetched,
      requestedLimit: normalizedRequested
    }
  };
}

function ringSignedArea(ring: unknown[]): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const current = ring[i] as [number, number];
    const next = ring[i + 1] as [number, number];
    if (!Array.isArray(current) || !Array.isArray(next)) {
      continue;
    }
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function ensureClosedRing(ring: unknown[]): number[][] {
  const coords = ring.filter(Array.isArray).map((item) => [Number(item[0]), Number(item[1])]);
  if (coords.length < 3) {
    return [];
  }
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    coords.push([first[0], first[1]]);
  }
  return coords;
}

function pointInRing(point: [number, number], ring: number[][]): boolean {
  let inside = false;
  const x = point[0];
  const y = point[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function esriPolygonToGeoJson(rings: unknown[]): Record<string, unknown> | null {
  const normalizedRings = rings
    .map((ring) => (Array.isArray(ring) ? ensureClosedRing(ring) : []))
    .filter((ring) => ring.length >= 4);
  if (normalizedRings.length === 0) {
    return null;
  }

  const outers: number[][][] = [];
  const holes: number[][][] = [];
  for (const ring of normalizedRings) {
    const signed = ringSignedArea(ring);
    if (signed <= 0) {
      outers.push(ring);
    } else {
      holes.push(ring);
    }
  }

  const resolvedOuters = outers.length > 0 ? outers : normalizedRings;
  const polygons = resolvedOuters.map((outer) => [outer]);
  for (const hole of holes) {
    const anchor = hole[0] as [number, number];
    const idx = resolvedOuters.findIndex((outer) => pointInRing(anchor, outer));
    if (idx >= 0) {
      polygons[idx].push(hole);
    } else {
      polygons.push([hole]);
    }
  }

  if (polygons.length === 1) {
    return {
      type: "Polygon",
      coordinates: polygons[0]
    };
  }
  return {
    type: "MultiPolygon",
    coordinates: polygons.map((polygon) => [polygon[0], ...polygon.slice(1)])
  };
}

function esriGeometryToGeoJson(geometry: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!geometry) {
    return null;
  }

  const point = geometry as { x?: unknown; y?: unknown };
  if (typeof point.x === "number" && typeof point.y === "number") {
    return { type: "Point", coordinates: [point.x, point.y] };
  }

  const multipoint = geometry as { points?: unknown };
  if (Array.isArray(multipoint.points)) {
    const points = multipoint.points
      .filter(Array.isArray)
      .map((item) => [Number(item[0]), Number(item[1])]);
    if (!points.length) {
      return null;
    }
    return { type: "MultiPoint", coordinates: points };
  }

  const polyline = geometry as { paths?: unknown };
  if (Array.isArray(polyline.paths)) {
    const paths = polyline.paths
      .filter(Array.isArray)
      .map((path) =>
        path
          .filter(Array.isArray)
          .map((item) => [Number(item[0]), Number(item[1])])
          .filter((item) => Number.isFinite(item[0]) && Number.isFinite(item[1]))
      )
      .filter((path) => path.length >= 2);
    if (!paths.length) {
      return null;
    }
    if (paths.length === 1) {
      return { type: "LineString", coordinates: paths[0] };
    }
    return { type: "MultiLineString", coordinates: paths };
  }

  const polygon = geometry as { rings?: unknown };
  if (Array.isArray(polygon.rings)) {
    return esriPolygonToGeoJson(polygon.rings);
  }

  return null;
}

function collectGeometryCoordinates(
  geometry: Record<string, unknown> | undefined,
  points: Array<[number, number]>
): void {
  if (!geometry) {
    return;
  }
  if (typeof geometry.x === "number" && typeof geometry.y === "number") {
    points.push([geometry.x, geometry.y]);
    return;
  }
  const paths = geometry.paths;
  if (Array.isArray(paths)) {
    for (const path of paths) {
      if (!Array.isArray(path)) {
        continue;
      }
      for (const point of path) {
        if (Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number") {
          points.push([point[0], point[1]]);
        }
      }
    }
    return;
  }
  const rings = geometry.rings;
  if (Array.isArray(rings)) {
    for (const ring of rings) {
      if (!Array.isArray(ring)) {
        continue;
      }
      for (const point of ring) {
        if (Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number") {
          points.push([point[0], point[1]]);
        }
      }
    }
    return;
  }
  const multipoint = geometry.points;
  if (Array.isArray(multipoint)) {
    for (const point of multipoint) {
      if (Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number") {
        points.push([point[0], point[1]]);
      }
    }
  }
}

function centerPointFromGeometry(
  geometry: Record<string, unknown>,
  geometryType: string
): { geometry: Record<string, unknown>; geometryType: "esriGeometryPoint" } {
  if (geometryType === "esriGeometryPoint" && typeof geometry.x === "number" && typeof geometry.y === "number") {
    return {
      geometry: {
        x: geometry.x,
        y: geometry.y,
        spatialReference: geometry.spatialReference ?? { wkid: 3857 }
      },
      geometryType: "esriGeometryPoint"
    };
  }

  const points: Array<[number, number]> = [];
  collectGeometryCoordinates(geometry, points);
  if (points.length === 0) {
    throw new UserFacingError("源要素几何无效，无法计算最近邻。");
  }

  let minX = points[0][0];
  let maxX = points[0][0];
  let minY = points[0][1];
  let maxY = points[0][1];
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  return {
    geometry: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      spatialReference: (geometry as { spatialReference?: Record<string, unknown> }).spatialReference ?? { wkid: 3857 }
    },
    geometryType: "esriGeometryPoint"
  };
}

function normalizeNearestLimit(raw: number | undefined): number {
  const maxK = normalizePositiveInt(config.nearestMaxK, 100);
  const defaultK = normalizePositiveInt(config.nearestDefaultK, 1);
  if (!Number.isFinite(raw ?? NaN)) {
    return Math.min(defaultK, maxK);
  }
  return Math.max(1, Math.min(maxK, Math.floor(raw as number)));
}

function buildNearestSourceWhereFollowUp(sourceLayerName: string, targetLayerName: string): string {
  return `请明确源要素条件（当前源图层：${sourceLayerName}），例如“OBJECTID为45854的${sourceLayerName}最近的${targetLayerName}”。`;
}

function sourceFeatureName(feature: ArcgisFeatureLike, displayField: string): string {
  const value = feature.attributes?.[displayField];
  if (value === null || value === undefined) {
    return "未命名要素";
  }
  return String(value);
}

function mergePointGeometries(features: ArcgisFeatureLike[]): { geometry: Record<string, unknown>; geometryType: string } {
  const points: Array<[number, number]> = [];
  let spatialReference: Record<string, unknown> | undefined;

  for (const item of features) {
    const geometry = item.geometry as
      | {
          x?: number;
          y?: number;
          spatialReference?: Record<string, unknown>;
        }
      | undefined;
    if (!geometry || typeof geometry.x !== "number" || typeof geometry.y !== "number") {
      continue;
    }
    points.push([geometry.x, geometry.y]);
    if (!spatialReference && geometry.spatialReference) {
      spatialReference = geometry.spatialReference;
    }
  }

  if (points.length === 0) {
    throw new UserFacingError("源点要素缺少有效坐标，无法执行缓冲分析。");
  }

  if (points.length === 1) {
    return {
      geometry: {
        x: points[0][0],
        y: points[0][1],
        spatialReference: spatialReference ?? { wkid: 3857 }
      },
      geometryType: "esriGeometryPoint"
    };
  }

  return {
    geometry: {
      points,
      spatialReference: spatialReference ?? { wkid: 3857 }
    },
    geometryType: "esriGeometryMultipoint"
  };
}

function mergePolylineGeometries(features: ArcgisFeatureLike[]): { geometry: Record<string, unknown>; geometryType: string } {
  const paths: unknown[] = [];
  let spatialReference: Record<string, unknown> | undefined;

  for (const item of features) {
    const geometry = item.geometry as
      | {
          paths?: unknown[];
          spatialReference?: Record<string, unknown>;
        }
      | undefined;
    if (!geometry || !Array.isArray(geometry.paths)) {
      continue;
    }
    paths.push(...geometry.paths);
    if (!spatialReference && geometry.spatialReference) {
      spatialReference = geometry.spatialReference;
    }
  }

  if (paths.length === 0) {
    throw new UserFacingError("源线要素缺少有效路径，无法执行缓冲分析。");
  }

  return {
    geometry: {
      paths,
      spatialReference: spatialReference ?? { wkid: 3857 }
    },
    geometryType: "esriGeometryPolyline"
  };
}

function mergePolygonGeometries(features: ArcgisFeatureLike[]): { geometry: Record<string, unknown>; geometryType: string } {
  const rings: unknown[] = [];
  let spatialReference: Record<string, unknown> | undefined;

  for (const item of features) {
    const geometry = item.geometry as
      | {
          rings?: unknown[];
          spatialReference?: Record<string, unknown>;
        }
      | undefined;
    if (!geometry || !Array.isArray(geometry.rings)) {
      continue;
    }
    rings.push(...geometry.rings);
    if (!spatialReference && geometry.spatialReference) {
      spatialReference = geometry.spatialReference;
    }
  }

  if (rings.length === 0) {
    throw new UserFacingError("源面要素缺少有效环信息，无法执行缓冲分析。");
  }

  return {
    geometry: {
      rings,
      spatialReference: spatialReference ?? { wkid: 3857 }
    },
    geometryType: "esriGeometryPolygon"
  };
}

function mergeSourceGeometry(
  sourceLayerGeometryType: string,
  sourceFeatures: ArcgisFeatureLike[]
): { geometry: Record<string, unknown>; geometryType: string } {
  if (/point/i.test(sourceLayerGeometryType)) {
    return mergePointGeometries(sourceFeatures);
  }
  if (/polyline|line/i.test(sourceLayerGeometryType)) {
    return mergePolylineGeometries(sourceFeatures);
  }
  if (/polygon|area/i.test(sourceLayerGeometryType)) {
    return mergePolygonGeometries(sourceFeatures);
  }

  throw new UserFacingError(`暂不支持源图层几何类型 ${sourceLayerGeometryType} 的缓冲分析。`);
}

type SpatialRelationType = NonNullable<NonNullable<SpatialQueryDSL["spatialFilter"]>["relation"]>;

function normalizeRelationType(
  relation: SpatialRelationType | undefined
): SpatialRelationType {
  return relation ?? "intersects";
}

function relationToSpatialRel(relation: SpatialRelationType): string {
  switch (relation) {
    case "contains":
      return "esriSpatialRelContains";
    case "within":
      return "esriSpatialRelWithin";
    case "disjoint":
      return "esriSpatialRelDisjoint";
    case "touches":
      return "esriSpatialRelTouches";
    case "overlaps":
      return "esriSpatialRelOverlaps";
    case "intersects":
    default:
      return "esriSpatialRelIntersects";
  }
}

function toEsriGeometryType(layerGeometryType: string): string {
  if (/point/i.test(layerGeometryType)) {
    return "esriGeometryPoint";
  }
  if (/polyline|line/i.test(layerGeometryType)) {
    return "esriGeometryPolyline";
  }
  if (/polygon|area/i.test(layerGeometryType)) {
    return "esriGeometryPolygon";
  }
  return layerGeometryType;
}

async function querySourceFeatures(
  sourceLayer: LayerDescriptor,
  sourceFilters: SpatialQueryDSL["attributeFilter"],
  sourceFilterExpr: FilterExprNode | undefined,
  options?: { limit?: number; allowEmptyFilter?: boolean; extraFields?: string[]; context?: string }
): Promise<ArcgisFeatureLike[]> {
  if (!options?.allowEmptyFilter && !sourceFilterExpr && sourceFilters.length === 0) {
    throw new UserFacingError(`请先指定源图层“${sourceLayer.name}”中的目标要素条件。`, {
      followUpQuestion: `请补充源要素条件后重试（当前源图层：${sourceLayer.name}）。`
    });
  }

  const fields = Array.from(
    new Set([sourceLayer.objectIdField, sourceLayer.displayField, ...(options?.extraFields ?? [])].filter(Boolean))
  );

  const sourceDsl: SpatialQueryDSL = {
    intent: "search",
    targetLayer: sourceLayer.layerKey,
    attributeFilter: sourceFilters,
    filterExpr: sourceFilterExpr,
    aggregation: null,
    limit: options?.limit ?? config.queryMaxFeatures,
    output: {
      fields,
      returnGeometry: true
    }
  };

  const sourcePlan = compileQueryPlan(sourceDsl);
  const sourceExecution = await executePlanWithPagination(
    sourcePlan,
    sourceDsl.limit,
    options?.context ?? "source-features"
  );
  const sourceFeatures = ((sourceExecution.payload.features as ArcgisFeatureLike[]) ?? []).filter((item) =>
    Boolean(item.geometry)
  );
  return sourceFeatures;
}

function isSourceBufferMode(dsl: SpatialQueryDSL): boolean {
  return Boolean(
    dsl.spatialFilter?.type === "buffer" &&
      dsl.spatialFilter.sourceLayer &&
      (dsl.spatialFilter.sourceFilterExpr || dsl.spatialFilter.sourceAttributeFilter?.length)
  );
}

function isSourceRelationMode(dsl: SpatialQueryDSL): boolean {
  return Boolean(
    dsl.spatialFilter?.type === "relation" &&
      dsl.spatialFilter?.sourceLayer &&
      (dsl.spatialFilter?.sourceFilterExpr || dsl.spatialFilter?.sourceAttributeFilter?.length)
  );
}

function isSpatialJoinCountMode(dsl: SpatialQueryDSL): boolean {
  return Boolean(
    dsl.spatialFilter?.type === "relation" &&
      dsl.spatialFilter?.joinMode === "count_by_source" &&
      dsl.spatialFilter?.sourceLayer
  );
}

function isMultiRingBufferMode(dsl: SpatialQueryDSL): boolean {
  return Boolean(
    dsl.spatialFilter?.type === "buffer" &&
      Array.isArray(dsl.spatialFilter?.distances) &&
      dsl.spatialFilter.distances.length > 1
  );
}

async function executeSourceBufferDsl(dsl: SpatialQueryDSL): Promise<DslExecutionResult> {
  const startedAt = Date.now();
  const sourceLayerKey = dsl.spatialFilter?.sourceLayer;
  if (!sourceLayerKey) {
    throw new UserFacingError("缺少源图层信息，无法执行线/面缓冲查询。");
  }

  const sourceLayer = layerRegistry.getLayer(sourceLayerKey);
  if (!sourceLayer || !sourceLayer.queryable) {
    throw new UserFacingError(`源图层 ${sourceLayerKey} 不存在或不可查询。`);
  }

  const sourceFilters = dsl.spatialFilter?.sourceAttributeFilter ?? [];
  const sourceFilterExpr = dsl.spatialFilter?.sourceFilterExpr;
  if (!sourceFilterExpr && sourceFilters.length === 0) {
    throw new UserFacingError(`请先指定源图层“${sourceLayer.name}”中的目标要素条件。`, {
      followUpQuestion: `请补充源要素条件，例如“标准名称为南二环的道路街巷100米内的门牌号码”。`
    });
  }

  const sourceDsl: SpatialQueryDSL = {
    intent: "search",
    targetLayer: sourceLayer.layerKey,
    attributeFilter: sourceFilters,
    filterExpr: sourceFilterExpr,
    aggregation: null,
    limit: config.queryMaxFeatures,
    output: {
      fields: [sourceLayer.objectIdField, sourceLayer.displayField],
      returnGeometry: true
    }
  };

  const sourcePlan = compileQueryPlan(sourceDsl);
  const sourceFeatures: ArcgisFeatureLike[] = [];
  const sourceBatchSize = normalizePositiveInt(config.queryPageSize, 2000);
  const sourceCap = normalizePositiveInt(config.queryMaxFeatures, 500000);
  const maxPages = normalizePositiveInt(config.queryMaxPages, 2000);
  let sourceOffset = 0;
  let pageNo = 0;
  const seenBatchSignatures = new Set<string>();

  while (sourceFeatures.length < sourceCap) {
    if (pageNo >= maxPages) {
      console.warn("[spatial-executor] source-buffer pagination reached safeguard page cap", {
        sourceLayer: sourceLayer.layerKey,
        sourceFeatureCount: sourceFeatures.length,
        maxPages
      });
      break;
    }

    const remaining = sourceCap - sourceFeatures.length;
    const sourceBatchPlan: QueryPlan = {
      ...sourcePlan,
      resultRecordCount: Math.max(1, Math.min(sourceBatchSize, remaining)),
      resultOffset: sourceOffset
    };
    const sourcePayload = (await executeArcgisQuery(sourceBatchPlan)) as ArcgisPayloadLike;
    const batch = (sourcePayload.features ?? []).filter((item) => item.geometry);
    sourceFeatures.push(...batch);

    const signature = batch
      .slice(0, 5)
      .map((item) => String(item.attributes?.[sourceLayer.objectIdField] ?? ""))
      .join("|");
    if (signature && seenBatchSignatures.has(signature)) {
      console.warn("[spatial-executor] source-buffer pagination duplicated page, stop fetching", {
        sourceLayer: sourceLayer.layerKey,
        sourceOffset,
        pageNo,
        signature
      });
      break;
    }
    if (signature) {
      seenBatchSignatures.add(signature);
    }

    const exceeded = Boolean(sourcePayload.exceededTransferLimit);
    if (batch.length === 0 || (!exceeded && batch.length < (sourceBatchPlan.resultRecordCount ?? sourceBatchSize))) {
      break;
    }

    sourceOffset += batch.length;
    pageNo += 1;
  }

  if (sourceFeatures.length === 0) {
    throw new UserFacingError(`未找到用于缓冲的源要素（图层：${sourceLayer.name}）。`, {
      followUpQuestion: `请检查源要素名称或条件后重试（当前源图层：${sourceLayer.name}）。`
    });
  }

  const merged = mergeSourceGeometry(sourceLayer.geometryType, sourceFeatures);

  // 统一换算为米，避免 kilometer 被误按 meter 执行。
  const radius = normalizeRadiusMeters(dsl.spatialFilter?.radius, dsl.spatialFilter?.unit) ?? config.defaultRadiusMeters;
  if (config.maxRadiusMeters > 0 && radius > config.maxRadiusMeters) {
    throw new UserFacingError(`查询半径超过上限 ${config.maxRadiusMeters} 米，请缩小半径后重试。`);
  }

  const targetDsl: SpatialQueryDSL = {
    ...dsl,
    spatialFilter: undefined
  };
  const targetPlan = compileQueryPlan(targetDsl);
  targetPlan.geometry = merged.geometry;
  targetPlan.geometryType = merged.geometryType;
  targetPlan.spatialRel = "esriSpatialRelIntersects";
  targetPlan.distance = radius;
  targetPlan.units = "esriSRUnit_Meter";

  const targetExecution = await executePlanWithPagination(targetPlan, dsl.limit, "source-buffer-target");
  console.info("[spatial-executor] source-buffer executed", {
    sourceLayer: sourceLayer.layerKey,
    sourceFeatureCount: sourceFeatures.length,
    mergeGeometryType: merged.geometryType,
    executionDurationMs: Date.now() - startedAt,
    sourcePreview: sourceFeatures.slice(0, 3).map((feature) => sourceFeatureName(feature, sourceLayer.displayField))
  });
  return {
    plan: targetPlan,
    payload: targetExecution.payload,
    executionMeta: targetExecution.executionMeta
  };
}

async function executeSourceRelationDsl(dsl: SpatialQueryDSL): Promise<DslExecutionResult> {
  const sourceLayerKey = dsl.spatialFilter?.sourceLayer;
  if (!sourceLayerKey) {
    throw new UserFacingError("缺少源图层信息，无法执行空间关系查询。");
  }
  const sourceLayer = layerRegistry.getLayer(sourceLayerKey);
  if (!sourceLayer || !sourceLayer.queryable) {
    throw new UserFacingError(`源图层 ${sourceLayerKey} 不存在或不可查询。`);
  }

  const sourceFilters = dsl.spatialFilter?.sourceAttributeFilter ?? [];
  const sourceFilterExpr = dsl.spatialFilter?.sourceFilterExpr;
  const sourceFeatures = await querySourceFeatures(sourceLayer, sourceFilters, sourceFilterExpr, {
    context: "source-relation-source"
  });

  if (sourceFeatures.length === 0) {
    throw new UserFacingError(`未找到用于空间关系分析的源要素（图层：${sourceLayer.name}）。`, {
      followUpQuestion: `请检查源要素条件后重试（当前源图层：${sourceLayer.name}）。`
    });
  }

  const merged = mergeSourceGeometry(sourceLayer.geometryType, sourceFeatures);
  const relation = normalizeRelationType(dsl.spatialFilter?.relation);
  const targetDsl: SpatialQueryDSL = {
    ...dsl,
    spatialFilter: undefined
  };
  const targetPlan = compileQueryPlan(targetDsl);
  targetPlan.geometry = merged.geometry;
  targetPlan.geometryType = merged.geometryType;
  targetPlan.spatialRel = relationToSpatialRel(relation);
  targetPlan.distance = null;
  targetPlan.units = null;
  targetPlan.analysisType = "spatial_relation";
  targetPlan.relationMeta = {
    relation,
    sourceLayer: sourceLayer.layerKey,
    sourceCount: sourceFeatures.length
  };

  if (!shouldUsePagination(targetPlan)) {
    try {
      const payload = await executeArcgisQuery(targetPlan);
      return {
        plan: targetPlan,
        payload,
        executionMeta: {
          truncated: false,
          safetyCap: config.queryMaxFeatures,
          fetched: Array.isArray(payload.features) ? payload.features.length : Number(payload.count ?? 0),
          requestedLimit: dsl.limit
        }
      };
    } catch (error) {
      const message = (error as Error).message ?? "";
      if (relation === "disjoint" && /Unsupported spatial relationship/i.test(message)) {
        throw new UserFacingError("当前服务暂不支持“相离(disjoint)”空间关系查询。", {
          followUpQuestion: "请改用相交/包含/被包含/接触/重叠等关系后重试。"
        });
      }
      throw error;
    }
  }

  try {
    const targetExecution = await executePlanWithPagination(targetPlan, dsl.limit, "source-relation-target");
    return {
      plan: targetPlan,
      payload: targetExecution.payload,
      executionMeta: targetExecution.executionMeta
    };
  } catch (error) {
    const message = (error as Error).message ?? "";
    if (relation === "disjoint" && /Unsupported spatial relationship/i.test(message)) {
      throw new UserFacingError("当前服务暂不支持“相离(disjoint)”空间关系查询。", {
        followUpQuestion: "请改用相交/包含/被包含/接触/重叠等关系后重试。"
      });
    }
    throw error;
  }
}

async function executeSpatialJoinCountDsl(dsl: SpatialQueryDSL): Promise<DslExecutionResult> {
  const sourceLayerKey = dsl.spatialFilter?.sourceLayer;
  if (!sourceLayerKey) {
    throw new UserFacingError("缺少源图层信息，无法执行空间 Join 计数。");
  }
  const sourceLayer = layerRegistry.getLayer(sourceLayerKey);
  if (!sourceLayer || !sourceLayer.queryable) {
    throw new UserFacingError(`源图层 ${sourceLayerKey} 不存在或不可查询。`);
  }

  const sourceFilters = dsl.spatialFilter?.sourceAttributeFilter ?? [];
  const sourceFilterExpr = dsl.spatialFilter?.sourceFilterExpr;
  const sourceCap = Math.max(1, Math.min(200, dsl.limit || 200));
  const sourceFeatures = await querySourceFeatures(sourceLayer, sourceFilters, sourceFilterExpr, {
    limit: sourceCap,
    allowEmptyFilter: true,
    context: "spatial-join-source"
  });

  if (sourceFeatures.length === 0) {
    throw new UserFacingError(`源图层 ${sourceLayer.name} 没有可用于统计的要素。`);
  }

  const relation = normalizeRelationType(dsl.spatialFilter?.relation ?? "within");
  const targetDsl: SpatialQueryDSL = {
    ...dsl,
    intent: "count",
    aggregation: { type: "count" },
    spatialFilter: undefined,
    sort: undefined,
    orderBy: undefined,
    output: {
      ...dsl.output,
      returnGeometry: false
    }
  };
  const targetCountPlan = compileQueryPlan(targetDsl);
  const results: ArcgisFeatureLike[] = [];

  for (const sourceFeature of sourceFeatures) {
    if (!sourceFeature.geometry) {
      continue;
    }
    const countPlan: QueryPlan = {
      ...targetCountPlan,
      geometry: sourceFeature.geometry,
      geometryType: toEsriGeometryType(sourceLayer.geometryType),
      spatialRel: relationToSpatialRel(relation),
      distance: null,
      units: null
    };
    const payload = await executeArcgisQuery(countPlan);
    const count = Number(payload.count ?? 0);
    const sourceObjectId = sourceFeature.attributes?.[sourceLayer.objectIdField];
    const sourceName = sourceFeatureName(sourceFeature, sourceLayer.displayField);
    results.push({
      geometry: sourceFeature.geometry,
      attributes: {
        _source_objectid: sourceObjectId ?? null,
        _source_name: sourceName,
        _join_count: Number.isFinite(count) ? count : 0
      }
    });
  }

  results.sort((a, b) => {
    const aCount = Number(a.attributes?._join_count ?? 0);
    const bCount = Number(b.attributes?._join_count ?? 0);
    if (aCount !== bCount) {
      return bCount - aCount;
    }
    const aId = String(a.attributes?._source_objectid ?? "");
    const bId = String(b.attributes?._source_objectid ?? "");
    return aId.localeCompare(bId);
  });

  const queryPlan: QueryPlan = {
    ...targetCountPlan,
    analysisType: "spatial_join_count",
    relationMeta: {
      relation,
      sourceLayer: sourceLayer.layerKey,
      sourceCount: sourceFeatures.length
    },
    joinMeta: {
      relation,
      sourceLayer: sourceLayer.layerKey,
      sourceEvaluated: sourceFeatures.length,
      sourceTruncated: dsl.limit > sourceCap
    }
  };

  return {
    plan: queryPlan,
    payload: {
      features: results,
      joinStats: results.map((item) => item.attributes ?? {})
    },
    executionMeta: {
      truncated: dsl.limit > sourceCap,
      safetyCap: sourceCap,
      fetched: results.length,
      requestedLimit: dsl.limit
    }
  };
}

async function executeMultiRingBufferDsl(dsl: SpatialQueryDSL): Promise<DslExecutionResult> {
  const radii = Array.from(
    new Set(
      normalizeDistancesMeters(dsl.spatialFilter?.distances, dsl.spatialFilter?.unit)
    )
  ).sort((a, b) => a - b);

  if (radii.length < 2) {
    throw new UserFacingError("多环缓冲至少需要两个半径值。");
  }

  let sourceGeometry: Record<string, unknown> | null = null;
  let sourceGeometryType = "esriGeometryPoint";
  let sourceMode: "center" | "source_layer" = "center";

  if (dsl.spatialFilter?.center) {
    sourceGeometry = {
      x: dsl.spatialFilter.center.x,
      y: dsl.spatialFilter.center.y,
      spatialReference: dsl.spatialFilter.center.spatialReference ?? { wkid: 3857 }
    };
    sourceGeometryType = "esriGeometryPoint";
  } else if (dsl.spatialFilter?.sourceLayer) {
    const sourceLayer = layerRegistry.getLayer(dsl.spatialFilter.sourceLayer);
    if (!sourceLayer || !sourceLayer.queryable) {
      throw new UserFacingError(`源图层 ${dsl.spatialFilter.sourceLayer} 不存在或不可查询。`);
    }
    const sourceFilters = dsl.spatialFilter.sourceAttributeFilter ?? [];
    const sourceFilterExpr = dsl.spatialFilter.sourceFilterExpr;
    const sourceFeatures = await querySourceFeatures(sourceLayer, sourceFilters, sourceFilterExpr, {
      context: "multi-ring-source"
    });
    if (sourceFeatures.length === 0) {
      throw new UserFacingError(`未找到用于多环缓冲统计的源要素（图层：${sourceLayer.name}）。`);
    }
    const merged = mergeSourceGeometry(sourceLayer.geometryType, sourceFeatures);
    sourceGeometry = merged.geometry;
    sourceGeometryType = merged.geometryType;
    sourceMode = "source_layer";
  }

  if (!sourceGeometry) {
    throw new UserFacingError("多环缓冲统计缺少源位置。", {
      followUpQuestion: "请提供坐标，或指定源要素条件后重试。"
    });
  }

  const baseCountDsl: SpatialQueryDSL = {
    ...dsl,
    intent: "count",
    aggregation: { type: "count" },
    spatialFilter: undefined,
    sort: undefined,
    orderBy: undefined,
    output: {
      ...dsl.output,
      returnGeometry: false
    }
  };
  const basePlan = compileQueryPlan(baseCountDsl);
  const ringOnly = dsl.spatialFilter?.ringOnly ?? true;
  let previousCumulative = 0;
  const ringStats: Array<Record<string, unknown>> = [];

  for (const radius of radii) {
    const countPlan: QueryPlan = {
      ...basePlan,
      geometry: sourceGeometry,
      geometryType: sourceGeometryType,
      spatialRel: "esriSpatialRelIntersects",
      distance: radius,
      units: "esriSRUnit_Meter"
    };
    const payload = await executeArcgisQuery(countPlan);
    const cumulative = Number(payload.count ?? 0);
    const ringCount = Math.max(0, cumulative - previousCumulative);
    previousCumulative = cumulative;
    ringStats.push({
      radius_m: radius,
      cumulative_count: cumulative,
      ring_count: ringOnly ? ringCount : cumulative
    });
  }

  const queryPlan: QueryPlan = {
    ...basePlan,
    geometry: sourceGeometry,
    geometryType: sourceGeometryType,
    spatialRel: "esriSpatialRelIntersects",
    units: "esriSRUnit_Meter",
    analysisType: "multi_ring_stat",
    multiRingMeta: {
      radiiMeters: radii,
      ringOnly,
      sourceMode
    }
  };

  return {
    plan: queryPlan,
    payload: {
      features: ringStats.map((attributes) => ({ attributes })),
      multiRingStats: ringStats
    },
    executionMeta: {
      truncated: false,
      safetyCap: radii.length,
      fetched: ringStats.length,
      requestedLimit: radii.length
    }
  };
}

interface NearestSourceResolution {
  sourceMode: "center" | "source_layer";
  sourceLayer?: string;
  sourceObjectId?: string;
  geometry: Record<string, unknown>;
  geometryType: string;
  centerGeometry: Record<string, unknown>;
}

async function resolveNearestSource(dsl: SpatialQueryDSL): Promise<NearestSourceResolution> {
  if (dsl.spatialFilter?.center) {
    return {
      sourceMode: "center",
      geometry: {
        x: dsl.spatialFilter.center.x,
        y: dsl.spatialFilter.center.y,
        spatialReference: dsl.spatialFilter.center.spatialReference ?? { wkid: 3857 }
      },
      geometryType: "esriGeometryPoint",
      centerGeometry: {
        x: dsl.spatialFilter.center.x,
        y: dsl.spatialFilter.center.y,
        spatialReference: dsl.spatialFilter.center.spatialReference ?? { wkid: 3857 }
      }
    };
  }

  const sourceLayerKey = dsl.spatialFilter?.sourceLayer;
  if (!sourceLayerKey) {
    const targetLayerName = layerRegistry.getLayer(dsl.targetLayer)?.name ?? "目标图层";
    throw new UserFacingError("最近邻查询缺少源要素。", {
      followUpQuestion: `请提供坐标点，或指定源要素条件后重试（例如“OBJECTID为45854的宗地院落最近的${targetLayerName}”）。`
    });
  }

  const sourceLayer = layerRegistry.getLayer(sourceLayerKey);
  if (!sourceLayer || !sourceLayer.queryable) {
    throw new UserFacingError(`源图层 ${sourceLayerKey} 不存在或不可查询。`);
  }

  const sourceFilters = dsl.spatialFilter?.sourceAttributeFilter ?? [];
  const sourceFilterExpr = dsl.spatialFilter?.sourceFilterExpr;
  if (!sourceFilterExpr && !sourceFilters.length) {
    const targetLayerName = layerRegistry.getLayer(dsl.targetLayer)?.name ?? "目标图层";
    throw new UserFacingError("最近邻查询缺少源要素条件。", {
      followUpQuestion: buildNearestSourceWhereFollowUp(sourceLayer.name, targetLayerName)
    });
  }

  const sourceDsl: SpatialQueryDSL = {
    intent: "search",
    targetLayer: sourceLayer.layerKey,
    attributeFilter: sourceFilters,
    filterExpr: sourceFilterExpr,
    aggregation: null,
    limit: 2,
    output: {
      fields: [sourceLayer.objectIdField, sourceLayer.displayField],
      returnGeometry: true
    }
  };
  const sourcePlan = compileQueryPlan(sourceDsl);
  sourcePlan.resultRecordCount = 2;
  sourcePlan.resultOffset = 0;
  const sourcePayload = (await executeArcgisQuery(sourcePlan)) as ArcgisPayloadLike;
  const sourceFeatures = (sourcePayload.features ?? []).filter((item) => Boolean(item.geometry));

  if (sourceFeatures.length === 0) {
    throw new UserFacingError(`未找到最近邻源要素（图层：${sourceLayer.name}）。`, {
      followUpQuestion: `请检查源要素条件后重试（当前源图层：${sourceLayer.name}）。`
    });
  }
  if (sourceFeatures.length > 1) {
    throw new UserFacingError(`源要素命中 ${sourceFeatures.length} 条，不符合单源最近邻模式。`, {
      followUpQuestion: `请补充更精确的源要素条件（当前源图层：${sourceLayer.name}）。`
    });
  }

  const sourceFeature = sourceFeatures[0];
  const sourceGeometry = sourceFeature.geometry as Record<string, unknown>;
  const mergedGeometryType = sourceLayer.geometryType;
  const center = centerPointFromGeometry(sourceGeometry, mergedGeometryType);
  const sourceObjectIdRaw = sourceFeature.attributes?.[sourceLayer.objectIdField];

  return {
    sourceMode: "source_layer",
    sourceLayer: sourceLayer.layerKey,
    sourceObjectId: sourceObjectIdRaw === undefined || sourceObjectIdRaw === null ? undefined : String(sourceObjectIdRaw),
    geometry: sourceGeometry,
    geometryType: mergedGeometryType,
    centerGeometry: center.geometry
  };
}

function toJtsGeometry(geometry: Record<string, unknown> | undefined): unknown {
  const geoJson = esriGeometryToGeoJson(geometry);
  if (!geoJson) {
    return null;
  }
  const reader = new GeoJSONReader(new GeometryFactory());
  return reader.read(geoJson as never);
}

function computeNearestDistanceMeters(
  sourceGeometry: Record<string, unknown>,
  targetGeometry: Record<string, unknown> | undefined
): number | null {
  try {
    const sourceJts = toJtsGeometry(sourceGeometry);
    const targetJts = toJtsGeometry(targetGeometry);
    if (!sourceJts || !targetJts) {
      return null;
    }
    const distance = DistanceOp.distance(sourceJts as never, targetJts as never);
    if (!Number.isFinite(distance)) {
      return null;
    }
    return distance;
  } catch {
    return null;
  }
}

function isSameFeature(
  feature: ArcgisFeatureLike,
  objectIdField: string,
  sourceObjectId: string | undefined
): boolean {
  if (!sourceObjectId) {
    return false;
  }
  const candidateId = feature.attributes?.[objectIdField];
  if (candidateId === null || candidateId === undefined) {
    return false;
  }
  return String(candidateId) === sourceObjectId;
}

async function executeNearestDsl(dsl: SpatialQueryDSL): Promise<DslExecutionResult> {
  const source = await resolveNearestSource(dsl);
  const targetLayer = layerRegistry.getLayer(dsl.targetLayer);
  if (!targetLayer) {
    throw new UserFacingError(`目标图层 ${dsl.targetLayer} 不存在。`);
  }

  const topK = normalizeNearestLimit(dsl.limit);
  const requestedLimit = dsl.limit > config.nearestMaxK ? config.nearestMaxK : topK;
  const requestedWithin = normalizeRadiusMeters(dsl.spatialFilter?.radius, dsl.spatialFilter?.unit);
  const initialRadius = Math.max(
    10,
    normalizePositiveInt(Math.min(requestedWithin ?? config.nearestInitialRadiusMeters, config.nearestInitialRadiusMeters), 500)
  );
  const configuredMaxRadius = Math.max(initialRadius, normalizePositiveInt(config.nearestMaxRadiusMeters, 100000));
  const maxRadius = requestedWithin ? Math.min(configuredMaxRadius, Math.max(initialRadius, Math.round(requestedWithin))) : configuredMaxRadius;
  const growthFactor = Math.max(1.1, Number(config.nearestRadiusGrowthFactor) || 2);
  const candidateCap = normalizePositiveInt(config.nearestCandidateCap, 50000);
  const excludeSelf = dsl.spatialFilter?.excludeSelf !== false;

  const targetDsl: SpatialQueryDSL = {
    ...dsl,
    intent: "search",
    aggregation: null,
    sort: undefined,
    spatialFilter: undefined,
    output: {
      ...dsl.output,
      returnGeometry: true
    }
  };
  const targetPlan = compileQueryPlan(targetDsl);
  let radius = initialRadius;
  let usedRadius = initialRadius;
  let candidates: ArcgisFeatureLike[] = [];
  let executionMeta: ExecutionMeta | undefined;

  while (radius <= maxRadius) {
    const radiusPlan: QueryPlan = {
      ...targetPlan,
      geometry: source.centerGeometry,
      geometryType: "esriGeometryPoint",
      spatialRel: "esriSpatialRelIntersects",
      distance: radius,
      units: "esriSRUnit_Meter"
    };
    const paged = await executePlanWithPagination(radiusPlan, candidateCap, "nearest-candidate");
    executionMeta = paged.executionMeta;
    const batch = ((paged.payload.features as ArcgisFeatureLike[]) ?? []).filter((item) => Boolean(item.geometry));
    const filtered = batch.filter((item) => {
      if (source.sourceMode !== "source_layer") {
        return true;
      }
      if (!excludeSelf) {
        return true;
      }
      if (dsl.targetLayer !== source.sourceLayer) {
        return true;
      }
      return !isSameFeature(item, targetLayer.objectIdField, source.sourceObjectId);
    });
    candidates = filtered;
    usedRadius = radius;
    if (filtered.length >= topK) {
      break;
    }
    if (radius >= maxRadius) {
      break;
    }
    radius = Math.min(maxRadius, Math.ceil(radius * growthFactor));
  }

  if (candidates.length === 0) {
    throw new UserFacingError("未找到最近要素。", {
      followUpQuestion: "在当前范围内未找到最近要素，请扩大范围或调整筛选条件后重试。"
    });
  }

  const ranked = candidates
    .map((feature) => {
      const distance = computeNearestDistanceMeters(source.geometry, feature.geometry);
      if (distance === null) {
        return null;
      }
      return { feature, distance };
    })
    .filter((item): item is { feature: ArcgisFeatureLike; distance: number } => Boolean(item))
    .sort((a, b) => {
      if (a.distance !== b.distance) {
        return a.distance - b.distance;
      }
      const aId = String(a.feature.attributes?.[targetLayer.objectIdField] ?? "");
      const bId = String(b.feature.attributes?.[targetLayer.objectIdField] ?? "");
      return aId.localeCompare(bId);
    });

  const nearestFeatures = ranked.slice(0, topK).map((item, index) => ({
    ...item.feature,
    attributes: {
      ...(item.feature.attributes ?? {}),
      _nearest_distance_m: Number(item.distance.toFixed(3)),
      _nearest_rank: index + 1
    }
  }));

  if (nearestFeatures.length === 0) {
    throw new UserFacingError("最近邻距离计算失败，未得到可用结果。");
  }

  const queryPlan: QueryPlan = {
    ...targetPlan,
    geometry: source.centerGeometry,
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
    distance: usedRadius,
    units: "esriSRUnit_Meter",
    analysisType: "nearest",
    nearestMeta: {
      topK: requestedLimit,
      sourceMode: source.sourceMode,
      sourceLayer: source.sourceLayer,
      sourceObjectId: source.sourceObjectId,
      radiusUsedMeters: usedRadius,
      candidateCount: ranked.length
    }
  };

  return {
    plan: queryPlan,
    payload: {
      features: nearestFeatures
    },
    executionMeta:
      executionMeta ??
      ({
        truncated: false,
        safetyCap: candidateCap,
        fetched: nearestFeatures.length,
        requestedLimit
      } satisfies ExecutionMeta)
  };
}

export async function executeDsl(dsl: SpatialQueryDSL): Promise<DslExecutionResult> {
  if (isSpatialJoinCountMode(dsl)) {
    return executeSpatialJoinCountDsl(dsl);
  }

  if (isMultiRingBufferMode(dsl)) {
    return executeMultiRingBufferDsl(dsl);
  }

  if (dsl.intent === "nearest") {
    return executeNearestDsl(dsl);
  }

  if (isSourceRelationMode(dsl)) {
    return executeSourceRelationDsl(dsl);
  }

  if (isSourceBufferMode(dsl)) {
    return executeSourceBufferDsl(dsl);
  }

  const plan = compileQueryPlan(dsl);
  if (shouldUsePagination(plan)) {
    const paged = await executePlanWithPagination(plan, dsl.limit, "direct");
    return {
      plan,
      payload: paged.payload,
      executionMeta: paged.executionMeta
    };
  }

  const payload = await executeArcgisQuery(plan);
  return {
    plan,
    payload
  };
}
