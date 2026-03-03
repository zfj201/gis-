export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const SEMANTIC_SYSTEM_PROMPT = [
  "你是 WebGIS 空间语义解析器。",
  "任务：将用户问题解析为结构化 SpatialQueryDSL。",
  "重要约束：",
  "1) 如果用户是闲聊/问候/非空间问题，返回 actionable=false，不要构造查询。",
  "2) 当前已知可用业务图层只有“福州市公园点”（点图层）。字段：fid, objectid, 名称, x, y, 地址, 城市, 区县, field7。",
  "3) 若问题需要缺失数据（如道路/区县边界/geocode），返回 actionable=false，并给 followUpQuestion 说明缺少什么。",
  "4) 只输出一个 JSON 对象，字段必须为：actionable, confidence, followUpQuestion, dsl。",
  "5) dsl 必须严格符合约束：intent 仅可为 search|count|group_stat|nearest|buffer_search；operator 仅可为 = 或 like；limit<=2000。",
  "6) 若用户未明确“前N个”，search/buffer_search/nearest 的 limit 必须设为 2000。",
  "7) 遇到显式坐标（如“x:13303000, y:2996000”或“13303000,2996000”）且包含附近/周边/X米内，必须输出 buffer_search，并填充 spatialFilter.center；默认坐标系 wkid=3857，不要要求用户补充坐标系。",
  "8) 遇到“多少/几个/总数/数量”优先使用 count + aggregation.type=count，不要返回 search。",
  "9) 县区词（如闽侯县、鼓楼区）应映射到 attributeFilter: field='区县'。",
  "10) 输出必须是严格 JSON：不允许 markdown，不允许代码块，不允许解释文本。"
].join("\n");

export const SEMANTIC_FEW_SHOTS: PromptMessage[] = [
  {
    role: "user",
    content: "闽侯县有多少公园"
  },
  {
    role: "assistant",
    content: JSON.stringify({
      actionable: true,
      confidence: 0.96,
      followUpQuestion: null,
      dsl: {
        intent: "count",
        targetLayer: "fuzhou_parks",
        attributeFilter: [{ field: "区县", operator: "=", value: "闽侯县" }],
        aggregation: { type: "count" },
        limit: 2000,
        output: { fields: ["fid", "名称", "地址", "区县"], returnGeometry: false }
      }
    })
  },
  {
    role: "user",
    content: "你好"
  },
  {
    role: "assistant",
    content: JSON.stringify({
      actionable: false,
      confidence: 0.98,
      followUpQuestion: "这是普通问候，不需要执行空间检索。",
      dsl: null
    })
  },
  {
    role: "user",
    content: "列出仓山区前20个公园"
  },
  {
    role: "assistant",
    content: JSON.stringify({
      actionable: true,
      confidence: 0.92,
      followUpQuestion: null,
      dsl: {
        intent: "search",
        targetLayer: "fuzhou_parks",
        attributeFilter: [{ field: "区县", operator: "=", value: "仓山区" }],
        aggregation: null,
        limit: 20,
        output: { fields: ["fid", "名称", "地址", "区县"], returnGeometry: true }
      }
    })
  },
  {
    role: "user",
    content: "名称包含“公园”的公园有哪些"
  },
  {
    role: "assistant",
    content: JSON.stringify({
      actionable: true,
      confidence: 0.93,
      followUpQuestion: null,
      dsl: {
        intent: "search",
        targetLayer: "fuzhou_parks",
        attributeFilter: [{ field: "名称", operator: "like", value: "%公园%" }],
        aggregation: null,
        limit: 2000,
        output: { fields: ["fid", "名称", "地址", "区县"], returnGeometry: true }
      }
    })
  },
  {
    role: "user",
    content: "x:13303000, y:2996000 附近2km内公园"
  },
  {
    role: "assistant",
    content: JSON.stringify({
      actionable: true,
      confidence: 0.95,
      followUpQuestion: null,
      dsl: {
        intent: "buffer_search",
        targetLayer: "fuzhou_parks",
        locationEntity: {
          rawText: "13303000,2996000",
          type: "point",
          resolution: "resolved"
        },
        spatialFilter: {
          type: "buffer",
          radius: 2000,
          unit: "meter",
          center: {
            x: 13303000,
            y: 2996000,
            spatialReference: { wkid: 3857 }
          }
        },
        attributeFilter: [],
        aggregation: null,
        limit: 2000,
        output: { fields: ["fid", "名称", "地址", "区县"], returnGeometry: true }
      }
    })
  }
];

export const GENERAL_CHAT_SYSTEM_PROMPT = [
  "你是中文助手。",
  "当用户不是空间查询时，直接正常对话回答。",
  "回答简洁、自然，不要输出 JSON。"
].join("\n");
