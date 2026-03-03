import {
  type ParseResponse,
  type SpatialQueryDSL,
  spatialQueryDslSchema
} from "@gis/shared";
import { config } from "./config.js";

const countyPattern = /(鼓楼区|仓山区|台江区|晋安区|马尾区|长乐区|闽侯县|连江县|罗源县|闽清县|永泰县|福清市|平潭县)/;

const coordinatePatterns = [
  /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/,
  /x\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*[，,\s]+y\s*[:：]\s*(-?\d+(?:\.\d+)?)/i
];

function parseRadiusMeters(question: string): number | undefined {
  const match = question.match(/(\d+(?:\.\d+)?)\s*(km|公里|千米|m|米)/i);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (Number.isNaN(value)) {
    return undefined;
  }

  if (unit === "km" || unit === "公里" || unit === "千米") {
    return Math.round(value * 1000);
  }
  return Math.round(value);
}

function parseCoordinate(question: string): { x: number; y: number } | undefined {
  for (const pattern of coordinatePatterns) {
    const match = question.match(pattern);
    if (match) {
      const x = Number(match[1]);
      const y = Number(match[2]);
      if (!Number.isNaN(x) && !Number.isNaN(y)) {
        return { x, y };
      }
    }
  }
  return undefined;
}

function parseTopLimit(question: string): number | undefined {
  const topMatch = question.match(/前\s*(\d+)\s*(个|条|家|所)?/);
  if (!topMatch) {
    return undefined;
  }

  const limit = Number(topMatch[1]);
  if (Number.isNaN(limit) || limit < 1) {
    return undefined;
  }

  return Math.min(limit, 2000);
}

function inferIntent(question: string): SpatialQueryDSL["intent"] {
  if (/按.*区县.*统计|各区县|分组统计/.test(question)) {
    return "group_stat";
  }
  if (/多少|几个|总数|数量/.test(question)) {
    return "count";
  }
  if (/附近|周边|以内|内/.test(question)) {
    return "buffer_search";
  }
  return "search";
}

function parseKeyword(question: string): string | undefined {
  const quoteMatch = question.match(/[“\"]([^\"”]+)[”\"]/);
  if (quoteMatch?.[1]) {
    return quoteMatch[1].trim();
  }

  const keywordMatch = question.match(/名称.*?(?:是|为)?\s*([\u4e00-\u9fa5a-zA-Z0-9]+)/);
  return keywordMatch?.[1];
}

export function parseQuestion(question: string): ParseResponse {
  const normalized = question.trim();
  const intent = inferIntent(normalized);
  const radiusMeters = parseRadiusMeters(normalized);
  const coordinate = parseCoordinate(normalized);
  const limit = parseTopLimit(normalized) ?? 2000;
  const county = normalized.match(countyPattern)?.[1];
  const keyword = parseKeyword(normalized);

  const dsl: SpatialQueryDSL = {
    intent,
    targetLayer: "fuzhou_parks",
    attributeFilter: [],
    aggregation: null,
    limit,
    output: {
      fields: ["fid", "名称", "地址", "区县"],
      returnGeometry: true
    }
  };

  let followUpQuestion: string | null = null;

  if (county) {
    dsl.attributeFilter.push({
      field: "区县",
      operator: "=",
      value: county
    });
  }

  if (keyword) {
    dsl.attributeFilter.push({
      field: "名称",
      operator: "like",
      value: `%${keyword}%`
    });
  }

  if (intent === "count") {
    dsl.aggregation = { type: "count" };
    dsl.output.returnGeometry = false;
  }

  if (intent === "group_stat") {
    dsl.aggregation = { type: "group_count", groupBy: ["区县"] };
    dsl.output.returnGeometry = false;
    dsl.sort = { by: "区县", order: "asc" };
  }

  if (intent === "buffer_search") {
    const radius = radiusMeters ?? config.defaultRadiusMeters;

    if (config.maxRadiusMeters > 0 && radius > config.maxRadiusMeters) {
      followUpQuestion = `查询半径超过上限 ${config.maxRadiusMeters} 米，请缩小半径后重试。`;
    }

    dsl.spatialFilter = {
      type: "buffer",
      radius,
      unit: "meter",
      center: coordinate
        ? {
            x: coordinate.x,
            y: coordinate.y,
            spatialReference: { wkid: 3857 }
          }
        : undefined
    };

    if (!coordinate) {
      if (/街道/.test(normalized)) {
        dsl.locationEntity = {
          rawText: normalized,
          type: "unknown",
          resolution: "missing_dependency"
        };
        followUpQuestion = "当前仅有公园点图层。请补充道路/行政街道图层，或直接提供坐标点以执行半径查询。";
      } else if (/县/.test(normalized)) {
        dsl.locationEntity = {
          rawText: normalized,
          type: "county",
          resolution: "missing_dependency"
        };
        followUpQuestion = "当前缺少区县边界图层。请补充县界 polygon 图层后可执行“某县1km内”查询。";
      } else {
        dsl.locationEntity = {
          rawText: normalized,
          type: "unknown",
          resolution: "missing_dependency"
        };
        followUpQuestion = "请提供坐标点（x,y）或开启地名 geocode 服务后再执行附近查询。";
      }
    } else {
      dsl.locationEntity = {
        rawText: `${coordinate.x},${coordinate.y}`,
        type: "point",
        resolution: "resolved"
      };
      dsl.sort = { by: "距离", order: "asc" };
    }
  }

  const parsed = spatialQueryDslSchema.parse(dsl);

  return {
    dsl: parsed,
    confidence: followUpQuestion ? 0.65 : 0.9,
    followUpQuestion,
    parserSource: "rule"
  };
}
