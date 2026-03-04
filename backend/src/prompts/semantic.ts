import type { LayerDescriptor } from "@gis/shared";
import { config } from "../config.js";

export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function layerPromptBlock(layers: LayerDescriptor[]): string {
  if (!layers.length) {
    return "当前无可查询图层。";
  }

  return layers
    .slice(0, 20)
    .map((layer) => {
      const fieldNames = layer.fields
        .filter((field) => field.queryable)
        .slice(0, 12)
        .map((field) => `${field.name}(${field.type})`)
        .join(", ");
      return [
        `- 图层名=${layer.name}`,
        `key=${layer.layerKey}`,
        `geometryType=${layer.geometryType}`,
        `objectIdField=${layer.objectIdField}`,
        `displayField=${layer.displayField}`,
        `queryableFields=${fieldNames || "无"}`
      ].join(" | ");
    })
    .join("\n");
}

export function buildSemanticSystemPrompt(layers: LayerDescriptor[]): string {
  const maxLimit = Math.max(1, config.queryMaxFeatures);
  const nearestMax = Math.max(1, config.nearestMaxK);
  const nearestDefault = Math.max(1, config.nearestDefaultK);
  const section1 = [
    "【第1段：角色与目标】",
    "你是 WebGIS 空间语义解析器。",
    "唯一任务：将自然语言问题转换为可执行的 SpatialQueryDSL。"
  ].join("\n");

  const section2 = [
    "【第2段：严格输出契约】",
    "必须且仅能输出一个 JSON 对象，顶层键固定为：actionable、confidence、followUpQuestion、dsl。",
    "禁止输出 markdown、代码块、解释文字。",
    "actionable=false 时 dsl 必须为 null；actionable=true 时 dsl 必须是完整对象。"
  ].join("\n");

  const section3 = [
    "【第3段：DSL 语义约束】",
    "dsl.intent 仅允许：search | count | group_stat | nearest | buffer_search。",
    "attributeFilter.operator 仅允许：= | like | > | >= | < | <=。",
    `search/buffer_search 的 limit 必须 <= ${maxLimit}；若用户未明确“前N”，默认设为 ${maxLimit}。`,
    `nearest 的 limit 必须 <= ${nearestMax}；若用户未明确“前N”，默认设为 ${nearestDefault}。`,
    "buffer_search 需要 radius + unit(meter/kilometer)。",
    "nearest 需要可解析的源要素：要么 spatialFilter.center（坐标），要么 sourceLayer+sourceAttributeFilter（单源）。",
    "字段名只能使用目标图层（或 sourceLayer）的可查询字段，不得自造字段。",
    "数值比较（> >= < <=）不得使用 like。",
    "统计问句（多少/几个/总数/数量）默认不注入“有多少个”等噪音过滤词。"
  ].join("\n");

  const section4 = [
    "【第4段：意图映射规则】",
    "“多少/几个/总数/数量” => intent=count 且 aggregation.type=count。",
    "“为/等于/就是/是/：” => 精确匹配 operator='='。",
    "“包含/含有/相关/类似” => 模糊匹配 operator='like'，并使用 %value%。",
    "当句子包含“有哪些/列表/清单/名录”等问句尾词时，这些词不是检索关键词，必须从 value 中剔除。",
    "例如“名称包含生态的有哪些”应提取 value='生态'；“名称含有湿地的公园列表”应提取 value='湿地'。",
    "“附近/周边/X米内/X公里内” => intent=buffer_search。",
    "“最近/最近的/nearest” => intent=nearest。"
  ].join("\n");

  const section5 = [
    "【第5段：跨图层缓冲硬约束】",
    "若问句是“某条线/某个面 X米内 的 另一图层”，必须填 spatialFilter.sourceLayer + spatialFilter.sourceAttributeFilter。",
    "跨图层缓冲严禁伪造 spatialFilter.center。",
    "显式坐标（如 x:13303000,y:2996000）+ 附近语义时，才允许使用 spatialFilter.center，默认 wkid=3857。"
  ].join("\n");

  const section6 = [
    "【第6段：动态图层上下文】",
    "targetLayer 必须严格使用下方 layer key；一次只允许一个 targetLayer。",
    "若用户同时提及多个目标图层，返回 actionable=false 并要求拆分问题。",
    "若缺少必要依赖（如地名解析结果、源要素条件），返回 actionable=false 并给 followUpQuestion。",
    "可查询图层清单：",
    layerPromptBlock(layers)
  ].join("\n");

  return [
    section1,
    section2,
    section3,
    section4,
    section5,
    section6
  ].join("\n");
}

function resolveSampleLayerKey(
  layers: LayerDescriptor[],
  pattern: RegExp,
  fallback: string
): string {
  return layers.find((layer) => pattern.test(layer.name))?.layerKey ?? fallback;
}

export function buildSemanticFewShots(defaultLayerKey: string, layers: LayerDescriptor[] = []): PromptMessage[] {
  const maxLimit = Math.max(1, config.queryMaxFeatures);
  const roadLayerKey = resolveSampleLayerKey(layers, /道路|街巷|路/, defaultLayerKey);
  const parcelLayerKey = resolveSampleLayerKey(layers, /宗地|院落|地块/, defaultLayerKey);
  const doorplateLayerKey = resolveSampleLayerKey(layers, /门牌|地址|门牌号码/, defaultLayerKey);

  return [
    {
      role: "user",
      content: "查找标准名称为南二环的道路街巷"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.96,
        followUpQuestion: null,
        dsl: {
          intent: "search",
          targetLayer: roadLayerKey,
          attributeFilter: [{ field: "标准名称", operator: "=", value: "南二环" }],
          aggregation: null,
          limit: maxLimit,
          output: { fields: [], returnGeometry: true }
        }
      })
    },
    {
      role: "user",
      content: "门牌号码有多少个"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.96,
        followUpQuestion: null,
        dsl: {
          intent: "count",
          targetLayer: doorplateLayerKey,
          attributeFilter: [],
          aggregation: { type: "count" },
          limit: maxLimit,
          output: { fields: [], returnGeometry: false }
        }
      })
    },
    {
      role: "user",
      content: "公园名称包含生态的有哪些"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.95,
        followUpQuestion: null,
        dsl: {
          intent: "search",
          targetLayer: defaultLayerKey,
          attributeFilter: [{ field: "名称", operator: "like", value: "%生态%" }],
          aggregation: null,
          limit: maxLimit,
          output: { fields: [], returnGeometry: true }
        }
      })
    },
    {
      role: "user",
      content: "名称含有湿地的公园列表"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.95,
        followUpQuestion: null,
        dsl: {
          intent: "search",
          targetLayer: defaultLayerKey,
          attributeFilter: [{ field: "名称", operator: "like", value: "%湿地%" }],
          aggregation: null,
          limit: maxLimit,
          output: { fields: [], returnGeometry: true }
        }
      })
    },
    {
      role: "user",
      content: "给我一份区县维度的公园数量统计"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.95,
        followUpQuestion: null,
        dsl: {
          intent: "group_stat",
          targetLayer: defaultLayerKey,
          attributeFilter: [],
          aggregation: { type: "group_count", groupBy: ["区县"] },
          limit: maxLimit,
          output: { fields: [], returnGeometry: false },
          sort: { by: "区县", order: "asc" }
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
      content: "闽侯县有多少公园"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.92,
        followUpQuestion: null,
        dsl: {
          intent: "count",
          targetLayer: defaultLayerKey,
          attributeFilter: [{ field: "区县", operator: "=", value: "闽侯县" }],
          aggregation: { type: "count" },
          limit: maxLimit,
          output: { fields: [], returnGeometry: false }
        }
      })
    },
    {
      role: "user",
      content: "列出前20条数据"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.92,
        followUpQuestion: null,
        dsl: {
          intent: "search",
          targetLayer: defaultLayerKey,
          attributeFilter: [],
          aggregation: null,
          limit: 20,
          output: { fields: [], returnGeometry: true }
        }
      })
    },
    {
      role: "user",
      content: "x:13303000, y:2996000 附近2km内的数据"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.95,
        followUpQuestion: null,
        dsl: {
          intent: "buffer_search",
          targetLayer: defaultLayerKey,
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
          limit: maxLimit,
          output: { fields: [], returnGeometry: true }
        }
      })
    },
    {
      role: "user",
      content: "x:13303000,y:2996000 最近的公园"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.94,
        followUpQuestion: null,
        dsl: {
          intent: "nearest",
          targetLayer: defaultLayerKey,
          locationEntity: {
            rawText: "13303000,2996000",
            type: "point",
            resolution: "resolved"
          },
          spatialFilter: {
            type: "nearest",
            center: {
              x: 13303000,
              y: 2996000,
              spatialReference: { wkid: 3857 }
            }
          },
          attributeFilter: [],
          aggregation: null,
          limit: Math.max(1, config.nearestDefaultK),
          output: { fields: [], returnGeometry: true }
        }
      })
    },
    {
      role: "user",
      content: "标准名称为南二环的道路街巷最近的门牌号码"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.94,
        followUpQuestion: null,
        dsl: {
          intent: "nearest",
          targetLayer: doorplateLayerKey,
          locationEntity: {
            rawText: "标准名称为南二环的道路街巷",
            type: "road",
            resolution: "resolved"
          },
          spatialFilter: {
            type: "nearest",
            sourceLayer: roadLayerKey,
            sourceAttributeFilter: [{ field: "标准名称", operator: "=", value: "南二环" }]
          },
          attributeFilter: [],
          aggregation: null,
          limit: Math.max(1, config.nearestDefaultK),
          output: { fields: [], returnGeometry: true }
        }
      })
    },
    {
      role: "user",
      content: "面积小于100的宗地院落80米内的道路街巷"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.93,
        followUpQuestion: null,
        dsl: {
          intent: "buffer_search",
          targetLayer: roadLayerKey,
          locationEntity: {
            rawText: "面积小于100的宗地院落",
            type: "subdistrict",
            resolution: "resolved"
          },
          spatialFilter: {
            type: "buffer",
            radius: 80,
            unit: "meter",
            sourceLayer: parcelLayerKey,
            sourceAttributeFilter: [
              {
                field: "SHAPE__Area",
                operator: "<",
                value: "100"
              }
            ]
          },
          attributeFilter: [],
          aggregation: null,
          limit: maxLimit,
          output: { fields: [], returnGeometry: true }
        }
      })
    },
    {
      role: "user",
      content: "OBJECTID：45854的宗地院落80米内的道路街巷"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.93,
        followUpQuestion: null,
        dsl: {
          intent: "buffer_search",
          targetLayer: roadLayerKey,
          locationEntity: {
            rawText: "OBJECTID：45854的宗地院落",
            type: "subdistrict",
            resolution: "resolved"
          },
          spatialFilter: {
            type: "buffer",
            radius: 80,
            unit: "meter",
            sourceLayer: parcelLayerKey,
            sourceAttributeFilter: [
              {
                field: "objectid",
                operator: "=",
                value: "45854"
              }
            ]
          },
          attributeFilter: [],
          aggregation: null,
          limit: maxLimit,
          output: { fields: [], returnGeometry: true }
        }
      })
    },
    {
      role: "user",
      content: "周长不超过300的宗地院落80米内的道路街巷"
    },
    {
      role: "assistant",
      content: JSON.stringify({
        actionable: true,
        confidence: 0.93,
        followUpQuestion: null,
        dsl: {
          intent: "buffer_search",
          targetLayer: roadLayerKey,
          locationEntity: {
            rawText: "周长不超过300的宗地院落",
            type: "subdistrict",
            resolution: "resolved"
          },
          spatialFilter: {
            type: "buffer",
            radius: 80,
            unit: "meter",
            sourceLayer: parcelLayerKey,
            sourceAttributeFilter: [
              {
                field: "SHAPE__Length",
                operator: "<=",
                value: "300"
              }
            ]
          },
          attributeFilter: [],
          aggregation: null,
          limit: maxLimit,
          output: { fields: [], returnGeometry: true }
        }
      })
    }
  ];
}

export const GENERAL_CHAT_SYSTEM_PROMPT = [
  "你是中文助手。",
  "当用户不是空间查询时，直接正常对话回答。",
  "回答简洁、自然，不要输出 JSON。"
].join("\n");
