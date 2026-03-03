export const config = {
  port: Number(process.env.PORT ?? 3300),
  host: process.env.HOST ?? "0.0.0.0",
  parksLayerUrl:
    process.env.ARCGIS_PARKS_LAYER_URL ??
    "https://www.geosceneonline.cn/server/rest/services/Hosted/%E7%A6%8F%E5%B7%9E%E5%B8%82%E5%85%AC%E5%9B%AD%E7%82%B9/FeatureServer/0",
  maxRadiusMeters: Number(process.env.MAX_RADIUS_METERS ?? 0),
  defaultRadiusMeters: Number(process.env.DEFAULT_RADIUS_METERS ?? 5000),
  llmProvider: process.env.LLM_PROVIDER ?? "rule",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqBaseUrl: process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
  groqModel: process.env.GROQ_MODEL ?? "llama-3.1-8b-instant",
  groqTimeoutMs: Number(process.env.GROQ_TIMEOUT_MS ?? 12000),
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  openrouterModel: process.env.OPENROUTER_MODEL ?? "openrouter/free",
  openrouterTimeoutMs: Number(process.env.OPENROUTER_TIMEOUT_MS ?? 12000),
  openrouterSiteUrl: process.env.OPENROUTER_SITE_URL ?? "",
  openrouterAppName: process.env.OPENROUTER_APP_NAME ?? "gis-semantic-query"
} as const;

export const allowedFields = new Set(["fid", "objectid", "名称", "地址", "城市", "区县"]);
export const allowedFilterFields = new Set(["名称", "地址", "城市", "区县"]);
