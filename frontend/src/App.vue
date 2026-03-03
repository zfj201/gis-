<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import MapViewPanel from "./components/MapViewPanel.vue";

interface ChatResponse {
  dsl?: Record<string, unknown>;
  resolvedEntities?: Array<Record<string, unknown>>;
  queryPlan?: Record<string, unknown> | null;
  features?: Array<Record<string, unknown>>;
  summary?: string;
  followUpQuestion?: string | null;
  message?: string;
  error?: string;
  parserSource?: ParserSource;
}

interface QueryPlanLike {
  geometry?: {
    x?: number;
    y?: number;
    spatialReference?: { wkid?: number };
  } | null;
  distance?: number | null;
  units?: string | null;
  geometryType?: string | null;
}

interface FeatureItem {
  attributes?: Record<string, string | number | null | undefined>;
  geometry?: {
    x?: number;
    y?: number;
    spatialReference?: { wkid?: number };
  };
}

interface BufferOverlay {
  center: {
    x: number;
    y: number;
    spatialReference?: { wkid?: number };
  };
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
}

const question = ref("");
const loading = ref(false);
const backendStatus = ref<"unknown" | "up" | "down">("unknown");
const featuresForMap = ref<FeatureItem[]>([]);
const bufferOverlayForMap = ref<BufferOverlay | null>(null);
const chatMessages = ref<ChatMessage[]>([
  {
    id: 1,
    role: "assistant",
    text: "你好，我是空间查询助手。你可以问我：鼓楼区公园有多少个、列出仓山区前20个公园、某点500米内的公园。"
  }
]);
const chatStreamEl = ref<HTMLDivElement | null>(null);
let messageId = 2;

function toBufferOverlay(plan: Record<string, unknown> | null | undefined): BufferOverlay | null {
  if (!plan) {
    return null;
  }

  const queryPlan = plan as QueryPlanLike;
  if (queryPlan.geometryType !== "esriGeometryPoint") {
    return null;
  }
  if (!queryPlan.geometry || typeof queryPlan.distance !== "number" || queryPlan.distance <= 0) {
    return null;
  }

  const { x, y, spatialReference } = queryPlan.geometry;
  if (typeof x !== "number" || typeof y !== "number") {
    return null;
  }

  const isMeterUnit = !queryPlan.units || queryPlan.units === "esriSRUnit_Meter";
  if (!isMeterUnit) {
    return null;
  }

  return {
    center: { x, y, spatialReference },
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
    featuresForMap.value = (parsed.features as FeatureItem[] | undefined) ?? [];
    bufferOverlayForMap.value = toBufferOverlay(parsed.queryPlan ?? null);

    pushMessage({
      role: "assistant",
      text: parsed.summary || parsed.followUpQuestion || parsed.message || "已处理请求。",
      dsl: parsed.dsl,
      queryPlan: parsed.queryPlan ?? null,
      featureCount: parsed.features?.length ?? 0,
      error: parsed.error,
      parserSource: parsed.parserSource
    });
  } catch (error) {
    pushMessage({
      role: "assistant",
      text: "请求失败，请确认后端服务已启动。",
      error: `${(error as Error).message}。请确认后端服务已启动（默认 http://localhost:3300）`
    });
    featuresForMap.value = [];
    bufferOverlayForMap.value = null;
    backendStatus.value = "down";
  } finally {
    loading.value = false;
    await scrollToBottom();
  }
}

onMounted(() => {
  void checkBackendHealth();
  void scrollToBottom();
});
</script>

<template>
  <div class="layout">
    <aside class="panel">
      <header class="panel-header">
        <h1>空间语义解析器</h1>
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
            <!-- <div class="msg-role">{{ message.role === "user" ? "你" : "助手" }}</div> -->
            <div class="msg-text">{{ message.text }}</div>

            <div v-if="message.error" class="msg-error">{{ message.error }}</div>
            <div v-if="message.featureCount && message.featureCount > 0" class="msg-meta">
              命中 {{ message.featureCount }} 条要素
            </div>

            <div v-if="message.role === 'assistant' && message.parserSource" class="msg-meta">
              解析来源：{{ parserSourceLabel(message.parserSource) }}
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
      <MapViewPanel :features="featuresForMap" :buffer-overlay="bufferOverlayForMap" />
    </main>
  </div>
</template>
