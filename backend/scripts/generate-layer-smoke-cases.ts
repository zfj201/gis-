import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { LayerDescriptor } from "@gis/shared";
import { layerRegistry } from "../src/layer-registry.js";

interface SmokeCase {
  id: string;
  question: string;
  tags: string[];
  expect?: {
    requireDsl?: boolean;
    requireQueryPlan?: boolean;
    allowFollowUp?: boolean;
  };
}

interface CliOptions {
  serviceId?: string;
  outputPath?: string;
  maxPerLayer: number;
}

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(backendRoot, "..");

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    maxPerLayer: 10
  };
  for (const arg of argv) {
    if (arg.startsWith("--service-id=")) {
      options.serviceId = arg.slice("--service-id=".length).trim();
    } else if (arg.startsWith("--output=")) {
      options.outputPath = path.resolve(projectRoot, arg.slice("--output=".length));
    } else if (arg.startsWith("--max-per-layer=")) {
      const parsed = Number(arg.slice("--max-per-layer=".length));
      if (Number.isFinite(parsed) && parsed > 0) {
        options.maxPerLayer = Math.min(30, Math.floor(parsed));
      }
    }
  }
  return options;
}

// 按字段语义角色优先选字段；仅在允许时使用兜底字段，避免生成无意义问句。
function findFieldByRole(
  layer: LayerDescriptor,
  roles: Array<string>,
  options?: { allowFallback?: boolean }
): string | null {
  const profile = layer.semanticProfile;
  if (profile) {
    for (const role of roles) {
      const field = Object.entries(profile.fieldRoles).find(([, fieldRole]) => fieldRole === role)?.[0];
      if (field) {
        return field;
      }
    }
  }
  if (roles.includes("id")) {
    return layer.objectIdField;
  }
  if (roles.includes("name")) {
    return layer.displayField;
  }
  if (options?.allowFallback) {
    return layer.fields.find((field) => field.queryable)?.name ?? null;
  }
  return null;
}

// valueHints 优先，保证新服务接入后优先使用真实值，降低冒烟用例假阳性。
function pickValueHint(layer: LayerDescriptor, field: string): string | null {
  const hints = layer.semanticProfile?.valueHints?.[field] ?? [];
  const first = hints.find((item) => item.trim().length > 0);
  if (first) {
    return first.trim();
  }
  const role = layer.semanticProfile?.fieldRoles?.[field] ?? "unknown";
  if (role === "admin") {
    return "会泽县";
  }
  if (role === "name") {
    return "生态";
  }
  if (role === "category") {
    return "汉族";
  }
  if (role === "id" || role === "measure") {
    return "1";
  }
  return "示例值";
}

// like 用例只截取短词元，避免把整句噪声带入条件值。
function pickLikeToken(raw: string): string {
  const compact = raw.replace(/[\s，,。！？!?“”"'：:;；]/g, "").trim();
  if (!compact) {
    return "生态";
  }
  return compact.length <= 4 ? compact : compact.slice(0, 4);
}

// 单图层冒烟：覆盖 eq/like/count/group/in/not in/measure(compare)。
function buildSingleLayerCases(layer: LayerDescriptor): SmokeCase[] {
  const cases: SmokeCase[] = [];
  const nameField = findFieldByRole(layer, ["name", "category", "admin"], { allowFallback: true });
  const adminField = findFieldByRole(layer, ["admin"]);
  const idField = findFieldByRole(layer, ["id"], { allowFallback: true });
  const measureField = findFieldByRole(layer, ["measure"]);
  const measureFieldType = measureField
    ? layer.fields.find((field) => field.name === measureField)?.type
    : null;

  if (nameField) {
    const value = pickValueHint(layer, nameField) ?? "示例值";
    cases.push({
      id: "",
      question: `查询${nameField}为${value}的${layer.name}`,
      tags: ["onboarding", "eq", "layer"],
      expect: { requireDsl: true }
    });

    cases.push({
      id: "",
      question: `${layer.name}${nameField}包含${pickLikeToken(value)}的有哪些`,
      tags: ["onboarding", "like", "layer"],
      expect: { requireDsl: true }
    });
  }

  cases.push({
    id: "",
    question: `${layer.name}有多少个`,
    tags: ["onboarding", "count", "layer"],
    expect: { requireDsl: true }
  });

  if (adminField) {
    cases.push({
      id: "",
      question: `按${adminField}统计${layer.name}数量`,
      tags: ["onboarding", "group", "layer"],
      expect: { requireDsl: true }
    });
  }

  if (idField) {
    cases.push({
      id: "",
      question: `${idField}在1、2中的${layer.name}`,
      tags: ["onboarding", "in", "layer"],
      expect: { requireDsl: true }
    });
    cases.push({
      id: "",
      question: `${idField}不在1,2里的${layer.name}`,
      tags: ["onboarding", "not_in", "layer"],
      expect: { requireDsl: true }
    });
  }

  if (
    measureField &&
    (measureFieldType === "esriFieldTypeOID" ||
      measureFieldType === "esriFieldTypeInteger" ||
      measureFieldType === "esriFieldTypeSmallInteger" ||
      measureFieldType === "esriFieldTypeSingle" ||
      measureFieldType === "esriFieldTypeDouble")
  ) {
    cases.push({
      id: "",
      question: `${measureField}小于100的${layer.name}`,
      tags: ["onboarding", "compare", "layer"],
      expect: { requireDsl: true }
    });
  }

  return cases;
}

// 跨图层冒烟：优先生成 buffer + nearest 两类高风险语义路径。
function findSourceLayer(layers: LayerDescriptor[], target: LayerDescriptor): LayerDescriptor | null {
  for (const layer of layers) {
    if (!layer.queryable || layer.layerKey === target.layerKey) {
      continue;
    }
    const sourceField = findFieldByRole(layer, ["name", "admin", "id"], { allowFallback: true });
    if (sourceField) {
      return layer;
    }
  }
  return null;
}

function buildCrossLayerCases(target: LayerDescriptor, source: LayerDescriptor): SmokeCase[] {
  const sourceField = findFieldByRole(source, ["name", "admin", "id"], { allowFallback: true });
  if (!sourceField) {
    return [];
  }
  const sourceValue = pickValueHint(source, sourceField) ?? "示例值";
  return [
    {
      id: "",
      question: `${sourceField}为${sourceValue}的${source.name}100米内的${target.name}`,
      tags: ["onboarding", "buffer", "cross_layer"],
      expect: { requireDsl: true }
    },
    {
      id: "",
      question: `${sourceField}为${sourceValue}的${source.name}最近的${target.name}前5个`,
      tags: ["onboarding", "nearest", "cross_layer"],
      expect: { requireDsl: true }
    }
  ];
}

function finalizeIds(cases: SmokeCase[]): SmokeCase[] {
  return cases.map((item, index) => ({
    ...item,
    id: `ONB${String(index + 1).padStart(3, "0")}`
  }));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await layerRegistry.init();
  const catalog = layerRegistry.listCatalog();

  const service = options.serviceId
    ? catalog.services.find((item) => item.serviceId === options.serviceId)
    : catalog.services.at(-1);

  if (!service) {
    throw new Error("未找到目标服务，请传入 --service-id=<serviceId>。\n可用服务为空或 serviceId 不存在。");
  }

  const layers = catalog.layers.filter((layer) => layer.serviceId === service.serviceId && layer.queryable);
  if (layers.length === 0) {
    throw new Error(`服务 ${service.serviceId} 下没有可查询图层。`);
  }

  const generated: SmokeCase[] = [];
  for (const layer of layers) {
    const singleLayerCases = buildSingleLayerCases(layer).slice(0, options.maxPerLayer);
    generated.push(...singleLayerCases);

    const sourceLayer = findSourceLayer(layers, layer);
    if (sourceLayer) {
      generated.push(...buildCrossLayerCases(layer, sourceLayer));
    }
  }

  // 追加坐标场景，确保新服务至少覆盖一个 center 缓冲问法。
  generated.push({
    id: "",
    question: `13303000,2996000 500米内的${layers[0].name}`,
    tags: ["onboarding", "buffer", "center"],
    expect: { requireDsl: true }
  });

  const deduped = new Map<string, SmokeCase>();
  for (const item of generated) {
    if (!deduped.has(item.question)) {
      deduped.set(item.question, item);
    }
  }

  const cases = finalizeIds(Array.from(deduped.values()));
  const defaultOutput = path.resolve(
    backendRoot,
    `testcases/chat-query-cases-onboarding-${service.serviceId}.json`
  );
  const outputPath = options.outputPath ?? defaultOutput;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(cases, null, 2)}\n`, "utf8");

  console.log(`已生成 onboarding smoke cases: ${outputPath}`);
  console.log(`serviceId=${service.serviceId}, layers=${layers.length}, cases=${cases.length}`);
}

main().catch((error) => {
  console.error("生成 onboarding smoke cases 失败:", (error as Error).message);
  process.exitCode = 1;
});
