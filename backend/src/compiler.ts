import type { QueryPlan, SpatialQueryDSL } from "@gis/shared";
import { allowedFields, allowedFilterFields, config } from "./config.js";

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function buildWhere(dsl: SpatialQueryDSL): string {
  if (!dsl.attributeFilter.length) {
    return "1=1";
  }

  const clauses = dsl.attributeFilter
    .filter((filter) => allowedFilterFields.has(filter.field))
    .map((filter) => {
      if (filter.operator === "=") {
        return `${filter.field} = '${escapeSql(filter.value)}'`;
      }

      return `${filter.field} LIKE '${escapeSql(filter.value)}'`;
    });

  return clauses.length ? clauses.join(" AND ") : "1=1";
}

function normalizeOutFields(dsl: SpatialQueryDSL): string {
  const fields = dsl.output.fields.filter((field) => allowedFields.has(field));
  if (fields.length === 0) {
    return "fid,名称,地址,区县";
  }
  return fields.join(",");
}

export function compileQueryPlan(dsl: SpatialQueryDSL): QueryPlan {
  const where = buildWhere(dsl);
  const outFields = normalizeOutFields(dsl);

  const plan: QueryPlan = {
    layer: config.parksLayerUrl,
    where,
    geometry: null,
    geometryType: null,
    spatialRel: null,
    distance: null,
    units: null,
    outFields,
    returnGeometry: dsl.output.returnGeometry,
    resultRecordCount: dsl.limit
  };

  if (dsl.sort?.by && ["名称", "区县"].includes(dsl.sort.by)) {
    plan.orderByFields = `${dsl.sort.by} ${dsl.sort.order}`;
  }

  if (dsl.intent === "count" || dsl.aggregation?.type === "count") {
    plan.returnCountOnly = true;
    plan.returnGeometry = false;
  }

  if (dsl.intent === "group_stat" || dsl.aggregation?.type === "group_count") {
    plan.returnGeometry = false;
    plan.groupByFieldsForStatistics = "区县";
    plan.outStatistics = JSON.stringify([
      {
        statisticType: "count",
        onStatisticField: "fid",
        outStatisticFieldName: "park_count"
      }
    ]);
  }

  if (dsl.spatialFilter?.type === "buffer") {
    const center = dsl.spatialFilter.center;
    if (center) {
      const radius = dsl.spatialFilter.radius ?? config.defaultRadiusMeters;
      if (config.maxRadiusMeters > 0 && radius > config.maxRadiusMeters) {
        throw new Error(`查询半径超限，最大允许 ${config.maxRadiusMeters} 米`);
      }

      plan.geometry = {
        x: center.x,
        y: center.y,
        spatialReference: center.spatialReference ?? { wkid: 3857 }
      };
      plan.geometryType = "esriGeometryPoint";
      plan.spatialRel = "esriSpatialRelIntersects";
      plan.distance = radius;
      plan.units = "esriSRUnit_Meter";
    }
  }

  return plan;
}
