import type { QueryPlan } from "@gis/shared";

export async function fetchLayerMeta(layerUrl: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${layerUrl}?f=pjson`);
  if (!res.ok) {
    throw new Error(`图层元数据请求失败: ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function executeArcgisQuery(plan: QueryPlan): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  params.set("f", "pjson");
  params.set("where", plan.where);
  params.set("outFields", plan.outFields);
  params.set("returnGeometry", String(plan.returnGeometry));
  params.set("outSR", "3857");

  if (plan.resultRecordCount) {
    params.set("resultRecordCount", String(plan.resultRecordCount));
  }

  if (typeof plan.resultOffset === "number" && plan.resultOffset >= 0) {
    params.set("resultOffset", String(plan.resultOffset));
  }

  if (plan.orderByFields) {
    params.set("orderByFields", plan.orderByFields);
  }

  if (plan.returnCountOnly) {
    params.set("returnCountOnly", "true");
  }

  if (plan.returnDistinctValues) {
    params.set("returnDistinctValues", "true");
  }

  if (plan.groupByFieldsForStatistics && plan.outStatistics) {
    params.set("groupByFieldsForStatistics", plan.groupByFieldsForStatistics);
    params.set("outStatistics", plan.outStatistics);
  }

  if (plan.geometry && plan.geometryType && plan.spatialRel) {
    params.set("geometry", JSON.stringify(plan.geometry));
    params.set("geometryType", plan.geometryType);
    params.set("spatialRel", plan.spatialRel);
    params.set("inSR", "3857");

    if (plan.distance) {
      params.set("distance", String(plan.distance));
    }

    if (plan.units) {
      params.set("units", plan.units);
    }
  }

  return queryArcgisLayer(plan.layer, params);
}

export async function queryArcgisLayer(
  layerUrl: string,
  params: URLSearchParams | Record<string, string>
): Promise<Record<string, unknown>> {
  const resolvedParams = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const queryUrl = `${layerUrl}/query`;
  const res = await fetch(queryUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    },
    body: resolvedParams.toString()
  });
  if (!res.ok) {
    throw new Error(`ArcGIS 查询失败: ${res.status}`);
  }

  const payload = (await res.json()) as Record<string, unknown>;
  if ((payload as { error?: unknown }).error) {
    throw new Error(`ArcGIS 查询错误: ${JSON.stringify((payload as { error: unknown }).error)}`);
  }

  return payload;
}
