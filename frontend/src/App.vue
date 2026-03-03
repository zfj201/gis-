<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { LayerCatalogResponse, LayerDescriptor } from "@gis/shared";
import MapViewPanel from "./components/MapViewPanel.vue";

interface ChatResponse {
  dsl?: Record<string, unknown> | null;
  resolvedEntities?: Array<Record<string, unknown>>;
  queryPlan?: Record<string, unknown> | null;
  features?: Array<Record<string, unknown>>;
  summary?: string;
  followUpQuestion?: string | null;
  message?: string;
  error?: string;
  parserSource?: ParserSource;
  parserFailureReason?: string | null;
  parserFailureDetail?: string | null;
  normalizedByRule?: boolean;
  targetLayerName?: string;
}

interface QueryPlanLike {
  geometry?: Record<string, unknown> | null;
  distance?: number | null;
  units?: string | null;
  geometryType?: string | null;
}

interface FeatureItem {
  attributes?: Record<string, string | number | null | undefined>;
  geometry?: Record<string, unknown>;
}

interface BufferOverlay {
  geometry: Record<string, unknown>;
  geometryType: string;
  radiusMeters: number;
}

type ParserSource = "groq" | "openrouter" | "rule" | "rule_fallback";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  dsl?: Record<string, unknown>;
  queryPlan?: Record<string, unknown> | null;
  featureCount?: number;
  error?: string;
  parserSource?: ParserSource;
  parserFailureReason?: string | null;
  parserFailureDetail?: string | null;
  normalizedByRule?: boolean;
  targetLayerName?: string;
}

const question = ref("");
const layerServiceUrl = ref("");
const loading = ref(false);
const layerLoading = ref(false);
const layerPanelOpen = ref(false);
const expandedServices = ref<Record<string, boolean>>({});
const focusServiceRequest = ref<{ serviceId: string; nonce: number } | null>(null);
const serviceContextMenu = ref<{ serviceId: string; x: number; y: number } | null>(null);
const serviceContextMenuEl = ref<HTMLDivElement | null>(null);
const mapPanelRef = ref<{ focusService: (serviceId: string) => Promise<void> } | null>(null);
const backendStatus = ref<"unknown" | "up" | "down">("unknown");
const featuresForMap = ref<FeatureItem[]>([]);
const bufferOverlayForMap = ref<BufferOverlay | null>(null);
const mapResponseNonce = ref(0);
const layerCatalog = ref<LayerCatalogResponse>({
  services: [],
  layers: []
});
const layerError = ref("");
const chatMessages = ref<ChatMessage[]>([
  {
    id: 1,
    role: "assistant",
    text: "你好，我是空间查询助手。你可以问我：鼓楼区公园有多少个、列出仓山区前20个公园、某点500米内的公园。"
  }
]);
const chatStreamEl = ref<HTMLDivElement | null>(null);
let messageId = 2;
let focusServiceNonce = 1;

function toBufferOverlay(plan: Record<string, unknown> | null | undefined): BufferOverlay | null {
  if (!plan) {
    return null;
  }

  const queryPlan = plan as QueryPlanLike;
  if (!queryPlan.geometryType || !queryPlan.geometry || typeof queryPlan.distance !== "number" || queryPlan.distance <= 0) {
    return null;
  }

  const isMeterUnit = !queryPlan.units || queryPlan.units === "esriSRUnit_Meter";
  if (!isMeterUnit) {
    return null;
  }

  return {
    geometry: queryPlan.geometry,
    geometryType: queryPlan.geometryType,
    radiusMeters: queryPlan.distance
  };
}

function pushMessage(message: Omit<ChatMessage, "id">): void {
  chatMessages.value.push({
    id: messageId++,
    ...message
  });
}

function parserSourceLabel(source: ParserSource | undefined): string {
  if (source === "groq") {
    return "Groq 模型";
  }
  if (source === "openrouter") {
    return "OpenRouter Free";
  }
  if (source === "rule_fallback") {
    return "规则回退（模型失败）";
  }
  if (source === "rule") {
    return "规则解析";
  }
  return "未知";
}

function parserFailureReasonLabel(reason: string | null | undefined): string {
  if (!reason) {
    return "";
  }
  if (reason === "provider_http_401") {
    return "模型鉴权失败（401）";
  }
  if (reason === "provider_timeout") {
    return "模型超时回退";
  }
  if (reason === "provider_non_json") {
    return "模型返回非JSON";
  }
  if (reason === "schema_validation_failed") {
    return "模型Schema失败回退";
  }
  if (reason === "consistency_check_failed") {
    return "模型语义冲突回退";
  }
  if (reason === "provider_http_error") {
    return "模型HTTP错误";
  }
  return reason;
}

function layerNameByKey(layerKey: string | undefined): string | undefined {
  if (!layerKey) {
    return undefined;
  }
  return layerCatalog.value.layers.find((layer) => layer.layerKey === layerKey)?.name;
}

function targetLayerNameFromDsl(dsl: Record<string, unknown> | null | undefined): string | undefined {
  if (!dsl || typeof dsl !== "object") {
    return undefined;
  }
  const layerKey = String((dsl as { targetLayer?: string }).targetLayer ?? "");
  return layerNameByKey(layerKey) ?? (layerKey || undefined);
}

function isServiceExpanded(serviceId: string): boolean {
  return expandedServices.value[serviceId] ?? true;
}

function toggleServiceExpanded(serviceId: string): void {
  expandedServices.value[serviceId] = !isServiceExpanded(serviceId);
}

function serviceLayers(serviceId: string): LayerDescriptor[] {
  return layerCatalog.value.layers.filter((item) => item.serviceId === serviceId);
}

function isServiceVisible(serviceId: string): boolean {
  const layers = serviceLayers(serviceId);
  return layers.length > 0 && layers.every((layer) => layer.visibleByDefault);
}

function zoomToService(serviceId: string): void {
  void mapPanelRef.value?.focusService(serviceId);
  focusServiceRequest.value = {
    serviceId,
    nonce: focusServiceNonce++
  };
}

function clampContextMenuPosition(x: number, y: number): { x: number; y: number } {
  const menuWidth = 180;
  const menuHeight = 44;
  const safeX = Math.min(x, window.innerWidth - menuWidth - 8);
  const safeY = Math.min(y, window.innerHeight - menuHeight - 8);
  return {
    x: Math.max(8, safeX),
    y: Math.max(8, safeY)
  };
}

function openServiceContextMenu(serviceId: string, event: MouseEvent): void {
  const { x, y } = clampContextMenuPosition(event.clientX, event.clientY);
  serviceContextMenu.value = { serviceId, x, y };
}

function closeServiceContextMenu(): void {
  serviceContextMenu.value = null;
}

function zoomToServiceFromMenu(): void {
  if (!serviceContextMenu.value) {
    return;
  }
  zoomToService(serviceContextMenu.value.serviceId);
  closeServiceContextMenu();
}

function ensureServiceExpandedState(): void {
  for (const service of layerCatalog.value.services) {
    if (expandedServices.value[service.serviceId] === undefined) {
      expandedServices.value[service.serviceId] = true;
    }
  }
}

function handleGlobalPointerDown(event: PointerEvent): void {
  if (!serviceContextMenu.value) {
    return;
  }

  if (serviceContextMenuEl.value?.contains(event.target as Node)) {
    return;
  }
  closeServiceContextMenu();
}

function handleGlobalKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    closeServiceContextMenu();
  }
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (chatStreamEl.value) {
    chatStreamEl.value.scrollTop = chatStreamEl.value.scrollHeight;
  }
}

async function checkBackendHealth(): Promise<void> {
  try {
    const res = await fetch("/health");
    backendStatus.value = res.ok ? "up" : "down";
  } catch {
    backendStatus.value = "down";
  }
}

async function fetchLayerCatalog(): Promise<void> {
  try {
    const res = await fetch("/api/layers/catalog");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const catalog = (await res.json()) as LayerCatalogResponse;
    layerCatalog.value = catalog;
    ensureServiceExpandedState();
    layerError.value = "";
  } catch (error) {
    layerError.value = `图层目录加载失败：${(error as Error).message}`;
  }
}

async function registerLayerService(): Promise<void> {
  const serviceUrl = layerServiceUrl.value.trim();
  if (!serviceUrl) {
    layerError.value = "请输入 FeatureServer 服务地址。";
    return;
  }

  layerLoading.value = true;
  try {
    const res = await fetch("/api/layers/catalog/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ serviceUrl })
    });
    const payload = (await res.json()) as {
      message?: string;
      catalog?: LayerCatalogResponse;
    };
    if (!res.ok) {
      throw new Error(payload.message || `HTTP ${res.status}`);
    }

    if (payload.catalog) {
      layerCatalog.value = payload.catalog;
      ensureServiceExpandedState();
    } else {
      await fetchLayerCatalog();
    }
    layerServiceUrl.value = "";
    layerError.value = "";
  } catch (error) {
    layerError.value = `服务添加失败：${(error as Error).message}`;
  } finally {
    layerLoading.value = false;
  }
}

async function removeService(serviceId: string): Promise<void> {
  layerLoading.value = true;
  try {
    const res = await fetch(`/api/layers/catalog/service/${encodeURIComponent(serviceId)}`, {
      method: "DELETE"
    });
    const payload = (await res.json()) as {
      message?: string;
      catalog?: LayerCatalogResponse;
    };
    if (!res.ok) {
      throw new Error(payload.message || `HTTP ${res.status}`);
    }
    if (payload.catalog) {
      layerCatalog.value = payload.catalog;
      ensureServiceExpandedState();
    } else {
      await fetchLayerCatalog();
    }
    layerError.value = "";
  } catch (error) {
    layerError.value = `删除服务失败：${(error as Error).message}`;
  } finally {
    layerLoading.value = false;
  }
}

async function toggleLayerVisibility(layer: LayerDescriptor, checked: boolean): Promise<void> {
  const previous = layer.visibleByDefault;
  layer.visibleByDefault = checked;
  try {
    const res = await fetch(`/api/layers/catalog/layer/${encodeURIComponent(layer.layerKey)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ visibleByDefault: checked })
    });
    const payload = (await res.json()) as {
      message?: string;
      catalog?: LayerCatalogResponse;
    };
    if (!res.ok) {
      throw new Error(payload.message || `HTTP ${res.status}`);
    }
    if (payload.catalog) {
      layerCatalog.value = payload.catalog;
    }
    layerError.value = "";
  } catch (error) {
    layer.visibleByDefault = previous;
    layerError.value = `图层状态更新失败：${(error as Error).message}`;
  }
}

async function toggleServiceVisibility(serviceId: string, checked: boolean): Promise<void> {
  const layers = serviceLayers(serviceId);
  if (!layers.length) {
    return;
  }

  layerLoading.value = true;
  const previous = new Map(layers.map((layer) => [layer.layerKey, layer.visibleByDefault]));

  try {
    for (const layer of layers) {
      layer.visibleByDefault = checked;
      const res = await fetch(`/api/layers/catalog/layer/${encodeURIComponent(layer.layerKey)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ visibleByDefault: checked })
      });

      if (!res.ok) {
        const payload = (await res.json()) as { message?: string };
        throw new Error(payload.message || `HTTP ${res.status}`);
      }
    }
    await fetchLayerCatalog();
    layerError.value = "";
  } catch (error) {
    for (const layer of layers) {
      const oldValue = previous.get(layer.layerKey);
      if (typeof oldValue === "boolean") {
        layer.visibleByDefault = oldValue;
      }
    }
    layerError.value = `服务可见性更新失败：${(error as Error).message}`;
  } finally {
    layerLoading.value = false;
  }
}

async function runQuery(): Promise<void> {
  const text = question.value.trim();
  if (!text) {
    return;
  }

  pushMessage({
    role: "user",
    text
  });
  question.value = "";
  await scrollToBottom();

  loading.value = true;
  try {
    const res = await fetch("/api/chat/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ question: text })
    });

    const contentType = res.headers.get("content-type") ?? "";
    const bodyText = await res.text();

    if (!res.ok) {
      pushMessage({
        role: "assistant",
        text: "请求失败，请稍后重试。",
        error: bodyText || `HTTP ${res.status}`
      });
      return;
    }

    if (!contentType.includes("application/json")) {
      pushMessage({
        role: "assistant",
        text: "后端响应格式错误。",
        error: `后端返回了非 JSON 响应（${contentType || "unknown"}）`
      });
      return;
    }

    const parsed = JSON.parse(bodyText) as ChatResponse;
    mapResponseNonce.value += 1;
    bufferOverlayForMap.value = toBufferOverlay(parsed.queryPlan ?? null);
    featuresForMap.value = (parsed.features as FeatureItem[] | undefined) ?? [];
    const targetLayerName =
      parsed.targetLayerName ?? targetLayerNameFromDsl(parsed.dsl as Record<string, unknown> | null);

    pushMessage({
      role: "assistant",
      text: parsed.summary || parsed.followUpQuestion || parsed.message || "已处理请求。",
      dsl: (parsed.dsl as Record<string, unknown> | undefined) ?? undefined,
      queryPlan: parsed.queryPlan ?? null,
      featureCount: parsed.features?.length ?? 0,
      error: parsed.error,
      parserSource: parsed.parserSource,
      parserFailureReason: parsed.parserFailureReason ?? null,
      parserFailureDetail: parsed.parserFailureDetail ?? null,
      normalizedByRule: parsed.normalizedByRule ?? false,
      targetLayerName
    });
  } catch (error) {
    pushMessage({
      role: "assistant",
      text: "请求失败，请确认后端服务已启动。",
      error: `${(error as Error).message}。请确认后端服务已启动（默认 http://localhost:3300）`
    });
    mapResponseNonce.value += 1;
    featuresForMap.value = [];
    bufferOverlayForMap.value = null;
    backendStatus.value = "down";
  } finally {
    loading.value = false;
    await scrollToBottom();
  }
}

onMounted(() => {
  window.addEventListener("pointerdown", handleGlobalPointerDown);
  window.addEventListener("keydown", handleGlobalKeyDown);
  void checkBackendHealth();
  void fetchLayerCatalog();
  void scrollToBottom();
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", handleGlobalPointerDown);
  window.removeEventListener("keydown", handleGlobalKeyDown);
});
</script>

<template>
  <div class="layout">
    <aside class="panel">
      <header class="panel-header">
        <!-- <h1>空间语义解析器</h1> -->
        <p>对话输入空间问题，系统将解析 DSL、执行 ArcGIS 查询并高亮结果。</p>
      </header>

      <div v-if="backendStatus === 'down'" class="notice">
        后端未连接。请先启动：`npm run dev:backend`（默认端口 3300）。
      </div>

      <div ref="chatStreamEl" class="chat-stream">
        <div
          v-for="message in chatMessages"
          :key="message.id"
          class="msg-row"
          :class="message.role === 'user' ? 'msg-row-user' : 'msg-row-assistant'"
        >
          <div class="msg-bubble">
            <div class="msg-text">{{ message.text }}</div>

            <div v-if="message.error" class="msg-error">{{ message.error }}</div>
            <div v-if="message.featureCount && message.featureCount > 0" class="msg-meta">
              命中 {{ message.featureCount }} 条要素
            </div>
            <div v-if="message.role === 'assistant' && message.targetLayerName" class="msg-meta">
              目标图层：{{ message.targetLayerName }}
            </div>
            <div v-if="message.role === 'assistant' && message.parserSource" class="msg-meta">
              解析来源：{{ parserSourceLabel(message.parserSource) }}
            </div>
            <div
              v-if="message.role === 'assistant' && message.parserSource === 'rule_fallback' && message.parserFailureReason"
              class="msg-meta"
            >
              回退原因：{{ parserFailureReasonLabel(message.parserFailureReason) }}
            </div>
            <details
              v-if="message.role === 'assistant' && message.parserSource === 'rule_fallback' && message.parserFailureDetail"
              class="msg-details"
            >
              <summary>回退详情</summary>
              <pre>{{ message.parserFailureDetail }}</pre>
            </details>
            <div v-if="message.role === 'assistant' && message.normalizedByRule" class="msg-meta">
              语义对齐：已应用规则归一化
            </div>

            <details v-if="message.dsl" class="msg-details">
              <summary>结构化 DSL</summary>
              <pre>{{ JSON.stringify(message.dsl, null, 2) }}</pre>
            </details>

            <details v-if="message.queryPlan" class="msg-details">
              <summary>查询计划</summary>
              <pre>{{ JSON.stringify(message.queryPlan, null, 2) }}</pre>
            </details>
          </div>
        </div>
      </div>

      <div class="chat-input">
        <input
          v-model="question"
          type="text"
          placeholder="例如：鼓楼区公园有多少个"
          @keyup.enter="runQuery"
        />
        <button :disabled="loading" @click="runQuery">{{ loading ? "发送中" : "发送" }}</button>
      </div>
    </aside>

    <main class="map-wrap">
      <MapViewPanel
        ref="mapPanelRef"
        :features="featuresForMap"
        :buffer-overlay="bufferOverlayForMap"
        :layers="layerCatalog.layers"
        :focus-request="focusServiceRequest"
        :response-nonce="mapResponseNonce"
      />
      <div class="map-toolbox">
        <button class="layer-toggle-btn" @click="layerPanelOpen = !layerPanelOpen">
          {{ layerPanelOpen ? "收起图层" : "图层" }}
        </button>
      </div>

      <aside class="layer-drawer" :class="{ open: layerPanelOpen }">
        <div class="layer-manager">
        <div class="layer-manager-title">图层管理</div>
        <div class="layer-tip">提示：右键图层行可快速定位到图层视角。</div>
        <div class="layer-manager-form">
            <input
              v-model="layerServiceUrl"
              type="text"
              placeholder="输入 FeatureServer 地址"
              @keyup.enter="registerLayerService"
            />
            <button :disabled="layerLoading" @click="registerLayerService">
              {{ layerLoading ? "添加中" : "添加服务" }}
            </button>
          </div>
          <div v-if="layerError" class="layer-error">{{ layerError }}</div>

          <div class="layer-service-list">
            <div v-for="service in layerCatalog.services" :key="service.serviceId" class="layer-service-card">
              <div class="layer-service-head">
                <div class="service-head-left" @contextmenu.prevent="openServiceContextMenu(service.serviceId, $event)">
                  <button
                    class="expand-btn"
                    type="button"
                    :title="isServiceExpanded(service.serviceId) ? '收起' : '展开'"
                    @click="toggleServiceExpanded(service.serviceId)"
                  >
                    {{ isServiceExpanded(service.serviceId) ? "▾" : "▸" }}
                  </button>
                  <label class="service-visibility">
                    <input
                      type="checkbox"
                      :checked="isServiceVisible(service.serviceId)"
                      @change="
                        toggleServiceVisibility(
                          service.serviceId,
                          ($event.target as HTMLInputElement).checked
                        )
                      "
                    />
                    <strong>{{ service.name }}</strong>
                  </label>
                </div>
                <button class="danger-btn" :disabled="layerLoading" @click="removeService(service.serviceId)">
                  删除
                </button>
              </div>

              <div v-if="isServiceExpanded(service.serviceId)" class="service-body">
                <div class="layer-url">{{ service.serviceUrl }}</div>
                <div class="layer-list">
                  <div
                    v-for="layer in layerCatalog.layers.filter((item) => item.serviceId === service.serviceId)"
                    :key="layer.layerKey"
                    class="layer-item"
                  >
                    <label class="layer-item-visibility">
                      <input
                        type="checkbox"
                        :checked="layer.visibleByDefault"
                        @change="toggleLayerVisibility(layer, ($event.target as HTMLInputElement).checked)"
                      />
                      <span class="layer-name">{{ layer.name }}</span>
                    </label>
                    <small>{{ layer.queryable ? "可查询" : "仅展示" }}</small>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <div
        v-if="serviceContextMenu"
        ref="serviceContextMenuEl"
        class="service-context-menu"
        :style="{ left: `${serviceContextMenu.x}px`, top: `${serviceContextMenu.y}px` }"
        @contextmenu.prevent
      >
        <button type="button" class="service-context-item" @click="zoomToServiceFromMenu">
          移动视角（缩放至服务）
        </button>
      </div>
    </main>
  </div>
</template>
