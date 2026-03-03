import type { QueryPlan, SpatialQueryDSL } from "@gis/shared";
import { compileQueryPlan } from "./compiler.js";
import { config } from "./config.js";
import { UserFacingError } from "./errors.js";
import { executeArcgisQuery } from "./arcgis.js";
import { layerRegistry } from "./layer-registry.js";

interface ArcgisFeatureLike {
  geometry?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

interface ArcgisPayloadLike {
  features?: ArcgisFeatureLike[];
  exceededTransferLimit?: boolean;
}

export interface DslExecutionResult {
  plan: QueryPlan;
  payload: Record<string, unknown>;
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

function isSourceBufferMode(dsl: SpatialQueryDSL): boolean {
  return Boolean(
    dsl.spatialFilter?.type === "buffer" &&
      dsl.spatialFilter.sourceLayer &&
      dsl.spatialFilter.sourceAttributeFilter?.length
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
  if (sourceFilters.length === 0) {
    throw new UserFacingError(`请先指定源图层“${sourceLayer.name}”中的目标要素条件。`, {
      followUpQuestion: `请补充源要素条件，例如“标准名称为南二环的道路街巷100米内的门牌号码”。`
    });
  }

  const sourceDsl: SpatialQueryDSL = {
    intent: "search",
    targetLayer: sourceLayer.layerKey,
    attributeFilter: sourceFilters,
    aggregation: null,
    limit: 2000,
    output: {
      fields: [sourceLayer.objectIdField, sourceLayer.displayField],
      returnGeometry: true
    }
  };

  const sourcePlan = compileQueryPlan(sourceDsl);
  const sourceFeatures: ArcgisFeatureLike[] = [];
  const sourceBatchSize = 2000;
  let sourceOffset = 0;
  let pageNo = 0;
  const seenBatchSignatures = new Set<string>();

  while (true) {
    const sourceBatchPlan: QueryPlan = {
      ...sourcePlan,
      resultRecordCount: sourceBatchSize,
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
    if (!exceeded) {
      break;
    }
    if (batch.length === 0) {
      break;
    }

    sourceOffset += batch.length;
    pageNo += 1;
    if (pageNo > 2000) {
      console.warn("[spatial-executor] source-buffer pagination reached safeguard page cap", {
        sourceLayer: sourceLayer.layerKey,
        sourceFeatureCount: sourceFeatures.length
      });
      break;
    }
  }

  if (sourceFeatures.length === 0) {
    throw new UserFacingError(`未找到用于缓冲的源要素（图层：${sourceLayer.name}）。`, {
      followUpQuestion: `请检查源要素名称或条件后重试（当前源图层：${sourceLayer.name}）。`
    });
  }

  const merged = mergeSourceGeometry(sourceLayer.geometryType, sourceFeatures);

  const radius = dsl.spatialFilter?.radius ?? config.defaultRadiusMeters;
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

  const payload = await executeArcgisQuery(targetPlan);
  console.info("[spatial-executor] source-buffer executed", {
    sourceLayer: sourceLayer.layerKey,
    sourceFeatureCount: sourceFeatures.length,
    mergeGeometryType: merged.geometryType,
    executionDurationMs: Date.now() - startedAt,
    sourcePreview: sourceFeatures.slice(0, 3).map((feature) => sourceFeatureName(feature, sourceLayer.displayField))
  });
  return {
    plan: targetPlan,
    payload
  };
}

export async function executeDsl(dsl: SpatialQueryDSL): Promise<DslExecutionResult> {
  if (isSourceBufferMode(dsl)) {
    return executeSourceBufferDsl(dsl);
  }

  const plan = compileQueryPlan(dsl);
  const payload = await executeArcgisQuery(plan);
  return {
    plan,
    payload
  };
}
