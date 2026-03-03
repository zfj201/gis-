<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import type { LayerDescriptor } from "@gis/shared";
import { highlightTheme } from "../config/highlightTheme";

interface FeatureLike {
  geometry?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

interface BufferOverlayLike {
  geometry: Record<string, unknown>;
  geometryType: string;
  radiusMeters: number;
}

interface FocusRequestLike {
  serviceId: string;
  nonce: number;
}

const props = defineProps<{
  features: FeatureLike[];
  bufferOverlay?: BufferOverlayLike | null;
  layers: LayerDescriptor[];
  focusRequest?: FocusRequestLike | null;
  responseNonce?: number;
}>();

const mapEl = ref<HTMLDivElement | null>(null);
let mapRef: any = null;
let view: any = null;
let highlightLayer: any = null;
let bufferLayer: any = null;
let FeatureLayerCtor: any = null;
let GraphicsLayerCtor: any = null;
let GraphicCtor: any = null;
let CircleCtor: any = null;
let ExtentCtor: any = null;
let geometryEngine: any = null;
let geometryJsonUtils: any = null;
const dataLayers = new Map<string, any>();
let hasInitialZoom = false;
let pendingFocusServiceId: string | null = null;

function createPopupTemplate(layer: LayerDescriptor): Record<string, unknown> {
  const title = `{${layer.displayField}}`;
  const content = layer.fields
    .filter((field) => field.queryable)
    .slice(0, 8)
    .map((field) => `${field.alias}：{${field.name}}`)
    .join("<br/>");
  return {
    title,
    content: content || `${layer.name}`
  };
}

function toGraphicGeometry(rawGeometry: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!rawGeometry) {
    return null;
  }

  const geometry = rawGeometry as {
    x?: number;
    y?: number;
    paths?: unknown;
    rings?: unknown;
    points?: unknown;
    spatialReference?: Record<string, unknown>;
  };

  if (typeof geometry.x === "number" && typeof geometry.y === "number") {
    return {
      type: "point",
      x: geometry.x,
      y: geometry.y,
      spatialReference: geometry.spatialReference ?? { wkid: 3857 }
    };
  }

  if (Array.isArray(geometry.paths)) {
    return {
      type: "polyline",
      paths: geometry.paths,
      spatialReference: geometry.spatialReference ?? { wkid: 3857 }
    };
  }

  if (Array.isArray(geometry.rings)) {
    return {
      type: "polygon",
      rings: geometry.rings,
      spatialReference: geometry.spatialReference ?? { wkid: 3857 }
    };
  }

  if (Array.isArray(geometry.points)) {
    return {
      type: "multipoint",
      points: geometry.points,
      spatialReference: geometry.spatialReference ?? { wkid: 3857 }
    };
  }

  return null;
}

function symbolForGeometryType(type: string): Record<string, unknown> {
  if (type === "polygon") {
    return {
      type: "simple-fill",
      color: [...highlightTheme.polygon.fillColor],
      outline: {
        color: [...highlightTheme.polygon.outlineColor],
        width: highlightTheme.polygon.outlineWidth
      }
    };
  }

  if (type === "polyline") {
    return {
      type: "simple-line",
      color: [...highlightTheme.polyline.color],
      width: highlightTheme.polyline.width
    };
  }

  return {
    type: "simple-marker",
    color: [...highlightTheme.point.color],
    size: highlightTheme.point.size,
    outline: {
      color: [...highlightTheme.point.outlineColor],
      width: highlightTheme.point.outlineWidth
    }
  };
}

async function syncFeatureLayers(nextLayers: LayerDescriptor[]): Promise<void> {
  if (!mapRef || !FeatureLayerCtor) {
    return;
  }

  const nextMap = new Map(nextLayers.map((layer) => [layer.layerKey, layer]));
  for (const [layerKey, layerInstance] of dataLayers.entries()) {
    if (!nextMap.has(layerKey)) {
      mapRef.remove(layerInstance);
      dataLayers.delete(layerKey);
    }
  }

  for (const layer of nextLayers) {
    let layerInstance = dataLayers.get(layer.layerKey);
    if (!layerInstance) {
      layerInstance = new FeatureLayerCtor({
        url: layer.url,
        outFields: ["*"],
        visible: layer.visibleByDefault,
        popupTemplate: createPopupTemplate(layer)
      });
      mapRef.add(layerInstance, 0);
      dataLayers.set(layer.layerKey, layerInstance);
    } else {
      layerInstance.visible = layer.visibleByDefault;
    }
  }

  if (!hasInitialZoom) {
    const firstVisible = Array.from(dataLayers.values()).find((layer) => layer.visible);
    if (firstVisible) {
      try {
        await firstVisible.load();
        if (firstVisible.fullExtent) {
          await view?.goTo(firstVisible.fullExtent.expand(1.15));
          hasInitialZoom = true;
        }
      } catch (error) {
        console.error("Layer initial extent load failed:", error);
      }
    }
  }
}

function toExtent(
  input:
    | {
        xmin?: number;
        ymin?: number;
        xmax?: number;
        ymax?: number;
        spatialReference?: Record<string, unknown>;
      }
    | null
    | undefined
): any | null {
  if (!input) {
    return null;
  }
  if (typeof input.xmin !== "number" || typeof input.ymin !== "number") {
    return null;
  }
  if (typeof input.xmax !== "number" || typeof input.ymax !== "number") {
    return null;
  }
  if (!ExtentCtor) {
    return {
      type: "extent",
      xmin: input.xmin,
      ymin: input.ymin,
      xmax: input.xmax,
      ymax: input.ymax,
      spatialReference: input.spatialReference
    };
  }
  return new ExtentCtor({
    xmin: input.xmin,
    ymin: input.ymin,
    xmax: input.xmax,
    ymax: input.ymax,
    spatialReference: input.spatialReference
  });
}

function mergeExtent(
  current: any | null,
  next: { xmin?: number; ymin?: number; xmax?: number; ymax?: number; spatialReference?: Record<string, unknown> } | null
): any | null {
  const nextExtent = toExtent(next);
  if (!nextExtent) {
    return current;
  }
  if (!current) {
    return nextExtent;
  }
  if (typeof current.union === "function") {
    try {
      return current.union(nextExtent);
    } catch {
      // fallback to manual merge when union is unavailable
    }
  }
  return {
    type: "extent",
    xmin: Math.min(current.xmin, nextExtent.xmin),
    ymin: Math.min(current.ymin, nextExtent.ymin),
    xmax: Math.max(current.xmax, nextExtent.xmax),
    ymax: Math.max(current.ymax, nextExtent.ymax),
    spatialReference: current.spatialReference ?? nextExtent.spatialReference
  };
}

async function goToServiceExtent(serviceId: string): Promise<void> {
  if (!view) {
    pendingFocusServiceId = serviceId;
    return;
  }

  const targetEntries = props.layers
    .filter((layer) => layer.serviceId === serviceId)
    .map((layer) => dataLayers.get(layer.layerKey))
    .filter(Boolean);
  if (!targetEntries.length) {
    return;
  }

  let mergedExtent: any | null = null;

  for (const targetLayer of targetEntries) {
    try {
      await targetLayer.load();
      if (targetLayer.fullExtent) {
        mergedExtent = mergeExtent(mergedExtent, targetLayer.fullExtent);
      }
    } catch (error) {
      console.error("Layer fullExtent load failed:", error);
    }

    try {
      const query = typeof targetLayer.createQuery === "function" ? targetLayer.createQuery() : { where: "1=1" };
      if (view?.spatialReference) {
        query.outSpatialReference = view.spatialReference;
      }
      const extentResult = await targetLayer.queryExtent(query);
      mergedExtent = mergeExtent(mergedExtent, extentResult?.extent ?? null);
    } catch (error) {
      console.error("Layer queryExtent failed:", error);
    }
  }

  if (!mergedExtent) {
    return;
  }

  try {
    const target = typeof mergedExtent.expand === "function" ? mergedExtent.expand(1.12) : mergedExtent;
    await view.goTo(target);
  } catch (error) {
    console.error("Service goTo failed:", error);
  }
}

async function initMap(): Promise<void> {
  if (!mapEl.value) {
    return;
  }

  const [EsriMap, MapView, FeatureLayer, GraphicsLayer, Graphic, Circle, Extent, geometryEngineModule, jsonUtils] =
    await Promise.all([
    import("@arcgis/core/Map").then((m) => m.default),
    import("@arcgis/core/views/MapView").then((m) => m.default),
    import("@arcgis/core/layers/FeatureLayer").then((m) => m.default),
    import("@arcgis/core/layers/GraphicsLayer").then((m) => m.default),
    import("@arcgis/core/Graphic").then((m) => m.default),
    import("@arcgis/core/geometry/Circle").then((m) => m.default),
    import("@arcgis/core/geometry/Extent").then((m) => m.default),
    import("@arcgis/core/geometry/geometryEngine"),
    import("@arcgis/core/geometry/support/jsonUtils")
  ]);

  FeatureLayerCtor = FeatureLayer;
  GraphicsLayerCtor = GraphicsLayer;
  GraphicCtor = Graphic;
  CircleCtor = Circle;
  ExtentCtor = Extent;
  geometryEngine = geometryEngineModule;
  geometryJsonUtils = jsonUtils;

  highlightLayer = new GraphicsLayerCtor();
  bufferLayer = new GraphicsLayerCtor();

  mapRef = new EsriMap({
    basemap: "streets-vector",
    layers: [bufferLayer, highlightLayer]
  });

  view = new MapView({
    map: mapRef,
    container: mapEl.value,
    center: {
      x: 13303000,
      y: 2996000,
      spatialReference: { wkid: 3857 }
    },
    zoom: 10,
    spatialReference: { wkid: 3857 }
  });

  await syncFeatureLayers(props.layers);
  if (pendingFocusServiceId) {
    const serviceId = pendingFocusServiceId;
    pendingFocusServiceId = null;
    await goToServiceExtent(serviceId);
  }

  watch(
    () => props.layers,
    async (next) => {
      await syncFeatureLayers(next);
    },
    { deep: true, immediate: true }
  );

  watch(
    () => props.focusRequest,
    async (next) => {
      if (!next?.serviceId) {
        return;
      }
      await goToServiceExtent(next.serviceId);
    },
    { deep: true, immediate: true }
  );

  watch(
    () => props.features,
    async (next) => {
      if (!highlightLayer || !view || !GraphicCtor) {
        return;
      }
      const nonce = props.responseNonce ?? 0;

      highlightLayer.removeAll();
      if (!next.length) {
        return;
      }

      const graphics = next
        .map((feature) => {
          const geometry = toGraphicGeometry(feature.geometry as Record<string, unknown> | undefined);
          if (!geometry) {
            return null;
          }

          return new GraphicCtor({
            geometry,
            symbol: symbolForGeometryType(String(geometry.type ?? "point")),
            attributes: feature.attributes
          });
        })
        .filter(Boolean);

      if (!graphics.length) {
        return;
      }

      highlightLayer.addMany(graphics);
      if (nonce !== (props.responseNonce ?? 0)) {
        return;
      }
      if (props.bufferOverlay) {
        return;
      }
      await view.goTo(highlightLayer.graphics.toArray());
    },
    { deep: true }
  );

  watch(
    () => props.bufferOverlay,
    async (next) => {
      if (!bufferLayer || !view || !GraphicCtor || !CircleCtor) {
        return;
      }
      const nonce = props.responseNonce ?? 0;

      bufferLayer.removeAll();
      if (!next) {
        return;
      }

      let bufferGeometry: any = null;
      if (next.geometryType === "esriGeometryPoint") {
        const raw = next.geometry as { x?: number; y?: number; spatialReference?: { wkid?: number } };
        if (typeof raw.x === "number" && typeof raw.y === "number") {
          bufferGeometry = new CircleCtor({
            center: {
              x: raw.x,
              y: raw.y,
              spatialReference: raw.spatialReference ?? { wkid: 3857 }
            },
            radius: next.radiusMeters,
            radiusUnit: "meters",
            geodesic: true,
            numberOfPoints: 120
          });
        }
      } else if (geometryJsonUtils && geometryEngine) {
        try {
          const sourceGeometry = geometryJsonUtils.fromJSON(next.geometry);
          const geodesicBufferFn =
            geometryEngine.geodesicBuffer ??
            geometryEngine.default?.geodesicBuffer ??
            geometryEngine.buffer ??
            geometryEngine.default?.buffer;
          if (typeof geodesicBufferFn === "function") {
            bufferGeometry = geodesicBufferFn(sourceGeometry, next.radiusMeters, "meters");
          }
        } catch (error) {
          console.error("Buffer geometry build failed:", error);
        }
      }

      if (!bufferGeometry) {
        return;
      }

      const bufferGraphic = new GraphicCtor({
        geometry: bufferGeometry,
        symbol: {
          type: "simple-fill",
          color: [255, 102, 0, 0.12],
          outline: {
            color: [255, 102, 0, 0.95],
            width: 2
          }
        }
      });

      bufferLayer.add(bufferGraphic);
      if (nonce !== (props.responseNonce ?? 0)) {
        return;
      }
      if (bufferGeometry.extent) {
        await view.goTo(bufferGeometry.extent.expand(1.2));
      }
    },
    { deep: true }
  );
}

onMounted(() => {
  void initMap();
});

onUnmounted(() => {
  if (view) {
    view.destroy();
    view = null;
  }
  mapRef = null;
});

defineExpose({
  focusService: goToServiceExtent
});
</script>

<template>
  <div ref="mapEl" class="map-view"></div>
</template>
