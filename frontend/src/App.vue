<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { LayerCatalogResponse, LayerDescriptor } from "@gis/shared";
import MapViewPanel from "./components/MapViewPanel.vue";
import { downloadShapefileFromEsriFeatures } from "./utils/shapefileExport";

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
  semanticWarnings?: string[] | null;
  targetLayerName?: string;
  executionMeta?: {
    truncated?: boolean;
    safetyCap?: number;
    fetched?: number;
    requestedLimit?: number;
  };
  semanticMeta?: {
    retrievalHits?: number;
    modelAttempts?: number;
    repaired?: boolean;
    decisionPath?: string;
  } | null;
}

interface QueryPlanLike {
  geometry?: Record<string, unknown> | null;
  distance?: number | null;
  units?: string | null;
  geometryType?: string | null;
  analysisType?: "nearest" | "spatial_relation" | "spatial_join_count" | "multi_ring_stat" | string;
  nearestMeta?: {
    topK?: number;
    radiusUsedMeters?: number;
    candidateCount?: number;
    sourceMode?: "center" | "source_layer" | string;
  };
  relationMeta?: {
    relation?: string;
    sourceLayer?: string;
    sourceCount?: number;
  };
  joinMeta?: {
    relation?: string;
    sourceLayer?: string;
    sourceEvaluated?: number;
    sourceTruncated?: boolean;
  };
  multiRingMeta?: {
    radiiMeters?: number[];
    ringOnly?: boolean;
    sourceMode?: "center" | "source_layer" | string;
  };
}

interface FeatureItem {
  attributes?: Record<string, string | number | null | undefined>;
  geometry?: Record<string, unknown>;
}

interface SelectionChangePayload {
  layerKey: string;
  selectedObjectIds: Array<string | number>;
}

interface ExportFeaturesPageResponse {
  message?: string;
  layerKey?: string;
  layerName?: string;
  objectIdField?: string;
  geometryType?: string;
  fields?: Array<Record<string, unknown>>;
  cursor?: number;
  nextCursor?: number;
  hasMore?: boolean;
  totalMatched?: number;
  fetched?: number;
  maxExportFeatures?: number;
  features?: FeatureItem[];
}

interface BufferOverlay {
  geometry: Record<string, unknown>;
  geometryType: string;
  radiusMeters: number;
}

type ParserSource = "gemini" | "groq" | "openrouter" | "rule" | "rule_fallback";

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
  semanticWarnings?: string[] | null;
  targetLayerName?: string;
  executionMeta?: {
    truncated: boolean;
    safetyCap: number;
    fetched: number;
    requestedLimit: number;
  };
  nearestMeta?: {
    topK: number;
    radiusUsedMeters: number;
    candidateCount: number;
    sourceMode: string;
  } | null;
  analysisMetaLines?: string[] | null;
  semanticMeta?: {
    retrievalHits: number;
    modelAttempts: number;
    repaired: boolean;
    decisionPath: string;
  } | null;
}

const question = ref("");
const layerServiceUrl = ref("");
const loading = ref(false);
const layerLoading = ref(false);
const layerPanelOpen = ref(false);
const expandedServices = ref<Record<string, boolean>>({});
const focusServiceRequest = ref<{ serviceId: string; nonce: number } | null>(null);
const layerContextMenu = ref<{ layerKey: string; x: number; y: number } | null>(null);
const layerContextMenuEl = ref<HTMLDivElement | null>(null);
const manualSelectedIdsByLayer = ref<Record<string, string[]>>({});
const querySelectedIdsByLayer = ref<Record<string, string[]>>({});
const exportingLayerKey = ref<string | null>(null);
const exportingProgress = ref<{ layerKey: string; fetched: number; total: number } | null>(null);
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
    text: "你好，我是空间查询助手。你可以问我：鼓楼区公园有多少个、标准名称为南二环的道路街巷相交的门牌号码、x:13303000,y:2996000 500米、1公里、2公里内公园数量对比。"
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
  if (queryPlan.analysisType === "nearest") {
    return null;
  }
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

function nearestMetaFromPlan(plan: Record<string, unknown> | null | undefined): ChatMessage["nearestMeta"] {
  if (!plan) {
    return null;
  }
  const queryPlan = plan as QueryPlanLike;
  if (queryPlan.analysisType !== "nearest" || !queryPlan.nearestMeta) {
    return null;
  }
  return {
    topK: Number(queryPlan.nearestMeta.topK ?? 0),
    radiusUsedMeters: Number(queryPlan.nearestMeta.radiusUsedMeters ?? 0),
    candidateCount: Number(queryPlan.nearestMeta.candidateCount ?? 0),
    sourceMode: String(queryPlan.nearestMeta.sourceMode ?? "")
  };
}

function relationLabel(relation: string | undefined): string {
  if (relation === "intersects") {
    return "相交";
  }
  if (relation === "contains") {
    return "包含";
  }
  if (relation === "within") {
    return "被包含";
  }
  if (relation === "disjoint") {
    return "相离";
  }
  if (relation === "touches") {
    return "接触";
  }
  if (relation === "overlaps") {
    return "重叠";
  }
  return relation ?? "unknown";
}

function analysisMetaLinesFromPlan(plan: Record<string, unknown> | null | undefined): string[] | null {
  if (!plan) {
    return null;
  }
  const queryPlan = plan as QueryPlanLike;
  if (queryPlan.analysisType === "nearest") {
    return null;
  }
  if (queryPlan.analysisType === "spatial_relation" && queryPlan.relationMeta) {
    return [
      `空间关系：${relationLabel(queryPlan.relationMeta.relation)} · 源图层 ${
        queryPlan.relationMeta.sourceLayer ?? "-"
      } · 源要素 ${Number(queryPlan.relationMeta.sourceCount ?? 0)}`
    ];
  }
  if (queryPlan.analysisType === "spatial_join_count" && queryPlan.joinMeta) {
    const truncated = queryPlan.joinMeta.sourceTruncated ? "（已截断）" : "";
    return [
      `空间 Join：${relationLabel(queryPlan.joinMeta.relation)} · 源图层 ${
        queryPlan.joinMeta.sourceLayer ?? "-"
      } · 评估 ${Number(queryPlan.joinMeta.sourceEvaluated ?? 0)}${truncated}`
    ];
  }
  if (queryPlan.analysisType === "multi_ring_stat" && queryPlan.multiRingMeta) {
    const radii = Array.isArray(queryPlan.multiRingMeta.radiiMeters)
      ? queryPlan.multiRingMeta.radiiMeters.map((value) => Number(value)).join("/")
      : "";
    const ringMode = queryPlan.multiRingMeta.ringOnly ? "环带增量" : "累计";
    return [
      `多环缓冲：${radii || "-"}m · ${ringMode} · 来源 ${String(queryPlan.multiRingMeta.sourceMode ?? "-")}`
    ];
  }
  return null;
}

function pushMessage(message: Omit<ChatMessage, "id">): void {
  chatMessages.value.push({
    id: messageId++,
    ...message
  });
}

function parserSourceLabel(source: ParserSource | undefined): string {
  if (source === "gemini") {
    return "Gemini 模型";
  }
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

function featureCountText(message: ChatMessage): string {
  const count = message.featureCount ?? 0;
  if (count <= 0) {
    return "";
  }
  const executionMeta = message.executionMeta;
  if (executionMeta?.truncated) {
    return `命中 ${count} 条要素（已触发安全阈值 ${executionMeta.safetyCap}，结果已截断）`;
  }
  return `命中 ${count} 条要素`;
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

function openLayerContextMenu(layerKey: string, event: MouseEvent): void {
  const { x, y } = clampContextMenuPosition(event.clientX, event.clientY);
  layerContextMenu.value = { layerKey, x, y };
}

function closeLayerContextMenu(): void {
  layerContextMenu.value = null;
}

function normalizeObjectId(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function selectedCountByLayer(layerKey: string): number {
  const manual = manualSelectedIdsByLayer.value[layerKey] ?? [];
  const query = querySelectedIdsByLayer.value[layerKey] ?? [];
  return new Set([...manual, ...query]).size;
}

function isPointLayer(layer: LayerDescriptor): boolean {
  return /point/i.test(layer.geometryType);
}

async function togglePointRenderMode(
  layer: LayerDescriptor,
  nextMode: "default" | "heatmap"
): Promise<void> {
  const previous = layer.pointRenderMode ?? "default";
  layer.pointRenderMode = nextMode;
  try {
    const res = await fetch(`/api/layers/catalog/layer/${encodeURIComponent(layer.layerKey)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ pointRenderMode: nextMode })
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
    layer.pointRenderMode = previous;
    layerError.value = `图层渲染模式更新失败：${(error as Error).message}`;
  }
}

function effectiveSelectedObjectIds(layerKey: string): string[] {
  const manual = manualSelectedIdsByLayer.value[layerKey] ?? [];
  const query = querySelectedIdsByLayer.value[layerKey] ?? [];
  return Array.from(new Set([...manual, ...query]));
}

function buildExportFileName(layerName: string): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const safeName = layerName.replace(/[\\/:*?"<>|]+/g, "_").trim() || "layer_export";
  return `${safeName}_${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function updateQuerySelectedObjectIds(layerKey: string | undefined, features: FeatureItem[]): void {
  if (!layerKey) {
    return;
  }
  const layer = layerCatalog.value.layers.find((item) => item.layerKey === layerKey);
  if (!layer) {
    return;
  }

  const selected = features
    .map((feature) => normalizeObjectId(feature.attributes?.[layer.objectIdField]))
    .filter((item): item is string => Boolean(item));
  querySelectedIdsByLayer.value[layerKey] = Array.from(new Set(selected));
}

function handleSelectionChange(payload: SelectionChangePayload): void {
  const ids = Array.from(new Set(payload.selectedObjectIds.map((item) => String(item))));
  if (ids.length === 0) {
    delete manualSelectedIdsByLayer.value[payload.layerKey];
    return;
  }
  manualSelectedIdsByLayer.value[payload.layerKey] = ids;
}

async function exportLayerAsShapefile(layerKey: string): Promise<void> {
  const layer = layerCatalog.value.layers.find((item) => item.layerKey === layerKey);
  if (!layer) {
    layerError.value = `导出失败：未找到图层 ${layerKey}`;
    return;
  }
  if (exportingLayerKey.value) {
    return;
  }

  const selectedObjectIds = effectiveSelectedObjectIds(layerKey);
  const mode: "selected" | "all" = selectedObjectIds.length > 0 ? "selected" : "all";
  exportingLayerKey.value = layerKey;
  exportingProgress.value = { layerKey, fetched: 0, total: 0 };
  layerError.value = "";

  try {
    let cursor = 0;
    let hasMore = true;
    let totalMatched = 0;
    const allFeatures: FeatureItem[] = [];
    while (hasMore) {
      const res = await fetch("/api/layers/export/features-page", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          layerKey,
          mode,
          selectedObjectIds: mode === "selected" ? selectedObjectIds : undefined,
          cursor,
          pageSize: 1000
        })
      });
      const payload = (await res.json()) as ExportFeaturesPageResponse;
      if (!res.ok) {
        throw new Error(payload.message || `HTTP ${res.status}`);
      }

      const pageFeatures = Array.isArray(payload.features) ? payload.features : [];
      allFeatures.push(...pageFeatures);
      totalMatched = Number(payload.totalMatched ?? allFeatures.length);
      exportingProgress.value = {
        layerKey,
        fetched: allFeatures.length,
        total: totalMatched
      };
      hasMore = Boolean(payload.hasMore);
      cursor = Number(payload.nextCursor ?? cursor + pageFeatures.length);
    }

    if (allFeatures.length === 0) {
      layerError.value = `图层“${layer.name}”没有可导出的要素。`;
      closeLayerContextMenu();
      return;
    }

    await downloadShapefileFromEsriFeatures({
      features: allFeatures,
      fileNameBase: buildExportFileName(layer.name),
      encoding: "UTF-8"
    });
    closeLayerContextMenu();
  } catch (error) {
    layerError.value = `导出失败：${(error as Error).message}`;
  } finally {
    exportingLayerKey.value = null;
    exportingProgress.value = null;
  }
}

function ensureServiceExpandedState(): void {
  for (const service of layerCatalog.value.services) {
    if (expandedServices.value[service.serviceId] === undefined) {
      expandedServices.value[service.serviceId] = true;
    }
  }
}

function handleGlobalPointerDown(event: PointerEvent): void {
  if (!layerContextMenu.value) {
    return;
  }

  if (layerContextMenuEl.value?.contains(event.target as Node)) {
    return;
  }
  closeLayerContextMenu();
}

function handleGlobalKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    closeLayerContextMenu();
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
    querySelectedIdsByLayer.value = {};
    const targetLayerKey = String((parsed.dsl as { targetLayer?: unknown } | null)?.targetLayer ?? "").trim() || undefined;
    if (targetLayerKey) {
      updateQuerySelectedObjectIds(targetLayerKey, featuresForMap.value);
    }
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
      semanticWarnings: parsed.semanticWarnings ?? null,
      targetLayerName,
      executionMeta: parsed.executionMeta
        ? {
            truncated: Boolean(parsed.executionMeta.truncated),
            safetyCap: Number(parsed.executionMeta.safetyCap ?? 0),
            fetched: Number(parsed.executionMeta.fetched ?? 0),
            requestedLimit: Number(parsed.executionMeta.requestedLimit ?? 0)
          }
        : undefined,
      nearestMeta: nearestMetaFromPlan(parsed.queryPlan ?? null),
      analysisMetaLines: analysisMetaLinesFromPlan(parsed.queryPlan ?? null),
      semanticMeta: parsed.semanticMeta
        ? {
            retrievalHits: Number(parsed.semanticMeta.retrievalHits ?? 0),
            modelAttempts: Number(parsed.semanticMeta.modelAttempts ?? 0),
            repaired: Boolean(parsed.semanticMeta.repaired),
            decisionPath: String(parsed.semanticMeta.decisionPath ?? "")
          }
        : null
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
    querySelectedIdsByLayer.value = {};
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
              {{ featureCountText(message) }}
            </div>
            <div v-if="message.role === 'assistant' && message.nearestMeta" class="msg-meta">
              最近邻 Top{{ message.nearestMeta.topK }} · 候选 {{ message.nearestMeta.candidateCount }} · 使用半径
              {{ message.nearestMeta.radiusUsedMeters }}m
            </div>
            <div
              v-for="(line, idx) in message.analysisMetaLines || []"
              :key="`analysis-${message.id}-${idx}`"
              class="msg-meta"
            >
              {{ line }}
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
            <div v-if="message.role === 'assistant' && message.semanticMeta" class="msg-meta">
              链路：{{ message.semanticMeta.decisionPath || "unknown" }} · 检索样例
              {{ message.semanticMeta.retrievalHits }} · 模型尝试 {{ message.semanticMeta.modelAttempts }}
              <span v-if="message.semanticMeta.repaired">· 已修复</span>
            </div>
            <details
              v-if="message.role === 'assistant' && message.semanticWarnings && message.semanticWarnings.length > 0"
              class="msg-details"
            >
              <summary>解析告警</summary>
              <pre>{{ message.semanticWarnings.join("\n") }}</pre>
            </details>

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
        @selection-change="handleSelectionChange"
      />
      <div class="map-toolbox">
        <button class="layer-toggle-btn" @click="layerPanelOpen = !layerPanelOpen">
          {{ layerPanelOpen ? "收起图层" : "图层" }}
        </button>
      </div>

      <aside class="layer-drawer" :class="{ open: layerPanelOpen }">
        <div class="layer-manager">
        <div class="layer-manager-title">图层管理</div>
        <div class="layer-tip">提示：服务头部图标可移动视角，右键图层可导出 Shapefile。</div>
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
                <div class="service-head-left">
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
                <div class="service-actions">
                  <button
                    class="icon-btn"
                    type="button"
                    :title="`移动视角到 ${service.name}`"
                    @click="zoomToService(service.serviceId)"
                  >
                    ⌖
                  </button>
                  <button class="danger-btn" :disabled="layerLoading" @click="removeService(service.serviceId)">
                    删除
                  </button>
                </div>
              </div>

              <div v-if="isServiceExpanded(service.serviceId)" class="service-body">
                <div class="layer-url">{{ service.serviceUrl }}</div>
                <div class="layer-list">
                  <div
                    v-for="layer in layerCatalog.layers.filter((item) => item.serviceId === service.serviceId)"
                    :key="layer.layerKey"
                    class="layer-item"
                    @contextmenu.prevent="openLayerContextMenu(layer.layerKey, $event)"
                  >
                    <div class="layer-item-main">
                      <label class="layer-item-visibility">
                        <input
                          type="checkbox"
                          :checked="layer.visibleByDefault"
                          @change="toggleLayerVisibility(layer, ($event.target as HTMLInputElement).checked)"
                        />
                        <span class="layer-name">{{ layer.name }}</span>
                      </label>
                      <small>
                        {{ layer.queryable ? "可查询" : "仅展示" }}
                        <template v-if="selectedCountByLayer(layer.layerKey) > 0">
                          · 已选 {{ selectedCountByLayer(layer.layerKey) }}
                        </template>
                      </small>
                    </div>
                    <label v-if="isPointLayer(layer)" class="heatmap-switch">
                      <input
                        type="checkbox"
                        :checked="(layer.pointRenderMode ?? 'default') === 'heatmap'"
                        @change="
                          togglePointRenderMode(
                            layer,
                            ($event.target as HTMLInputElement).checked ? 'heatmap' : 'default'
                          )
                        "
                      />
                      热力图
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="exportingProgress" class="layer-progress">
            导出中... ({{ exportingProgress.fetched }}/{{ exportingProgress.total || "?" }})
          </div>
        </div>
      </aside>

      <div
        v-if="layerContextMenu"
        ref="layerContextMenuEl"
        class="service-context-menu"
        :style="{ left: `${layerContextMenu.x}px`, top: `${layerContextMenu.y}px` }"
        @contextmenu.prevent
      >
        <button
          type="button"
          class="service-context-item"
          :disabled="Boolean(exportingLayerKey)"
          @click="layerContextMenu && exportLayerAsShapefile(layerContextMenu.layerKey)"
        >
          {{ exportingLayerKey ? "导出中..." : "导出 Shapefile" }}
        </button>
      </div>
    </main>
  </div>
</template>
