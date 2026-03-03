<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";

interface FeatureLike {
  geometry?: {
    x?: number;
    y?: number;
    spatialReference?: { wkid?: number };
  };
  attributes?: Record<string, unknown>;
}

interface BufferOverlayLike {
  center: {
    x: number;
    y: number;
    spatialReference?: { wkid?: number };
  };
  radiusMeters: number;
}

const props = defineProps<{
  features: FeatureLike[];
  bufferOverlay?: BufferOverlayLike | null;
}>();

const mapEl = ref<HTMLDivElement | null>(null);
let view: any = null;
let highlightLayer: any = null;
let bufferLayer: any = null;
let GraphicCtor: any = null;
let CircleCtor: any = null;

async function initMap(): Promise<void> {
  if (!mapEl.value) {
    return;
  }

  const [EsriMap, MapView, FeatureLayer, GraphicsLayer, Graphic, Circle] = await Promise.all([
    import("@arcgis/core/Map").then((m) => m.default),
    import("@arcgis/core/views/MapView").then((m) => m.default),
    import("@arcgis/core/layers/FeatureLayer").then((m) => m.default),
    import("@arcgis/core/layers/GraphicsLayer").then((m) => m.default),
    import("@arcgis/core/Graphic").then((m) => m.default),
    import("@arcgis/core/geometry/Circle").then((m) => m.default)
  ]);
  GraphicCtor = Graphic;
  CircleCtor = Circle;

  const parksLayer = new FeatureLayer({
    url: "https://www.geosceneonline.cn/server/rest/services/Hosted/%E7%A6%8F%E5%B7%9E%E5%B8%82%E5%85%AC%E5%9B%AD%E7%82%B9/FeatureServer/0",
    outFields: ["*"],
    popupTemplate: {
      title: "{名称}",
      content: "地址：{地址}<br/>区县：{区县}"
    }
  });

  highlightLayer = new GraphicsLayer();
  bufferLayer = new GraphicsLayer();

  const map = new EsriMap({
    basemap: "streets-vector",
    layers: [parksLayer, bufferLayer, highlightLayer]
  });

  view = new MapView({
    map,
    container: mapEl.value,
    center: {
      x: 13303000,
      y: 2996000,
      spatialReference: { wkid: 3857 }
    },
    zoom: 10,
    spatialReference: { wkid: 3857 }
  });

  void view.when(async () => {
    try {
      await parksLayer.load();
      if (parksLayer.fullExtent) {
        await view?.goTo(parksLayer.fullExtent.expand(1.2));
      }
    } catch (error) {
      console.error("Parks layer load failed:", error);
    }
  });

  watch(
    () => props.features,
    async (next) => {
      if (!highlightLayer || !view) {
        return;
      }

      highlightLayer.removeAll();
      if (!next.length) {
        return;
      }

      const graphics = next
        .filter((feature) => feature.geometry?.x !== undefined && feature.geometry?.y !== undefined)
        .map((feature) =>
          new GraphicCtor({
            geometry: {
              type: "point",
              x: Number(feature.geometry?.x),
              y: Number(feature.geometry?.y),
              spatialReference: feature.geometry?.spatialReference ?? { wkid: 3857 }
            },
            symbol: {
              type: "simple-marker",
              color: [255, 102, 0, 0.9],
              size: 10,
              outline: {
                color: [255, 255, 255, 1],
                width: 1.5
              }
            },
            attributes: feature.attributes
          })
        );

      highlightLayer.addMany(graphics);
      const extent = highlightLayer.graphics.length ? highlightLayer.graphics.toArray() : [];
      if (extent.length > 0) {
        await view.goTo(extent);
      }
    },
    { deep: true }
  );

  watch(
    () => props.bufferOverlay,
    async (next) => {
      if (!bufferLayer || !view || !GraphicCtor || !CircleCtor) {
        return;
      }

      bufferLayer.removeAll();
      if (!next) {
        return;
      }

      const circle = new CircleCtor({
        center: {
          x: next.center.x,
          y: next.center.y,
          spatialReference: next.center.spatialReference ?? { wkid: 3857 }
        },
        radius: next.radiusMeters,
        radiusUnit: "meters",
        geodesic: true,
        numberOfPoints: 120
      });

      const bufferGraphic = new GraphicCtor({
        geometry: circle,
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
      await view.goTo(circle.extent.expand(1.2));
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
});
</script>

<template>
  <div ref="mapEl" class="map-view"></div>
</template>
