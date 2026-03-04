import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(backendRoot, "..");

function parseHosts(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 3300),
  host: process.env.HOST ?? "0.0.0.0",
  defaultParksLayerUrl:
    process.env.ARCGIS_PARKS_LAYER_URL ??
    "https://www.geosceneonline.cn/server/rest/services/Hosted/%E7%A6%8F%E5%B7%9E%E5%B8%82%E5%85%AC%E5%9B%AD%E7%82%B9/FeatureServer/0",
  maxRadiusMeters: Number(process.env.MAX_RADIUS_METERS ?? 0),
  defaultRadiusMeters: Number(process.env.DEFAULT_RADIUS_METERS ?? 5000),
  llmProvider: process.env.LLM_PROVIDER ?? "rule",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiBaseUrl:
    process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
  geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS ?? 12000),
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqBaseUrl: process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
  groqModel: process.env.GROQ_MODEL ?? "llama-3.1-8b-instant",
  groqTimeoutMs: Number(process.env.GROQ_TIMEOUT_MS ?? 12000),
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  openrouterModel: process.env.OPENROUTER_MODEL ?? "openrouter/free",
  openrouterFallbackModels: parseCsv(process.env.OPENROUTER_FALLBACK_MODELS ?? "qwen/qwen3-4b:free"),
  openrouterTimeoutMs: Number(process.env.OPENROUTER_TIMEOUT_MS ?? 12000),
  openrouterSiteUrl: process.env.OPENROUTER_SITE_URL ?? "",
  openrouterAppName: process.env.OPENROUTER_APP_NAME ?? "gis-semantic-query",
  queryMaxFeatures: Number(process.env.QUERY_MAX_FEATURES ?? 500000),
  queryPageSize: Number(process.env.QUERY_PAGE_SIZE ?? 2000),
  queryMaxPages: Number(process.env.QUERY_MAX_PAGES ?? 2000),
  nearestDefaultK: Number(process.env.NEAREST_DEFAULT_K ?? 1),
  nearestMaxK: Number(process.env.NEAREST_MAX_K ?? 100),
  nearestInitialRadiusMeters: Number(process.env.NEAREST_INITIAL_RADIUS_METERS ?? 500),
  nearestMaxRadiusMeters: Number(process.env.NEAREST_MAX_RADIUS_METERS ?? 100000),
  nearestRadiusGrowthFactor: Number(process.env.NEAREST_RADIUS_GROWTH_FACTOR ?? 2),
  nearestCandidateCap: Number(process.env.NEAREST_CANDIDATE_CAP ?? 50000),
  exportMaxFeatures: Number(process.env.EXPORT_MAX_FEATURES ?? 200000),
  exportPageSize: Number(process.env.EXPORT_PAGE_SIZE ?? 1000),
  layerRegistryPath: path.resolve(
    workspaceRoot,
    process.env.LAYER_REGISTRY_PATH ?? "backend/data/layer-registry.json"
  ),
  layerMetaTimeoutMs: Number(process.env.LAYER_META_TIMEOUT_MS ?? 8000),
  allowedLayerHosts: parseHosts(
    process.env.ALLOWED_LAYER_HOSTS ?? "www.geosceneonline.cn,geosceneonline.cn"
  ),
  maxRegisteredServices: Number(process.env.MAX_REGISTERED_SERVICES ?? 20)
} as const;
