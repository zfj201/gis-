import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { LayerCatalogResponse, LayerDescriptor, LayerField, LayerServiceDescriptor } from "@gis/shared";
import { config } from "./config.js";
import { UserFacingError } from "./errors.js";

interface RegistryState extends LayerCatalogResponse {
  version: number;
  updatedAt: string;
}

interface RegisterResult {
  service: LayerServiceDescriptor;
  layers: LayerDescriptor[];
}

interface ArcgisFieldLike {
  name?: string;
  alias?: string;
  type?: string;
}

interface ArcgisLayerMetaLike {
  id?: number;
  name?: string;
  geometryType?: string;
  objectIdField?: string;
  displayField?: string;
  fields?: ArcgisFieldLike[];
}

interface ArcgisServiceMetaLike {
  layers?: Array<{ id?: number; name?: string; geometryType?: string }>;
  maxRecordCount?: number;
  spatialReference?: Record<string, unknown>;
  serviceDescription?: string;
}

function isQueryableFieldType(type: string): boolean {
  return ![
    "esriFieldTypeGeometry",
    "esriFieldTypeBlob",
    "esriFieldTypeRaster",
    "esriFieldTypeXML"
  ].includes(type);
}

function normalizeField(field: ArcgisFieldLike): LayerField | null {
  const name = String(field.name ?? "").trim();
  if (!name) {
    return null;
  }

  const type = String(field.type ?? "unknown").trim();
  return {
    name,
    alias: String(field.alias ?? name).trim() || name,
    type,
    queryable: isQueryableFieldType(type)
  };
}

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function serviceIdFromUrl(serviceUrl: string): string {
  return `svc_${crypto.createHash("sha1").update(serviceUrl).digest("hex").slice(0, 12)}`;
}

function parseFeatureServerUrl(raw: string): { serviceUrl: string; layerId?: number } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new UserFacingError("图层 URL 格式错误，请输入完整的 FeatureServer 地址。");
  }

  if (parsed.protocol !== "https:") {
    throw new UserFacingError("仅允许 https 图层地址。");
  }

  const host = parsed.hostname.toLowerCase();
  if (config.allowedLayerHosts.length > 0 && !config.allowedLayerHosts.includes(host)) {
    throw new UserFacingError(`不允许的图层域名: ${host}`);
  }

  parsed.search = "";
  parsed.hash = "";

  const normalizedPath = parsed.pathname.replace(/\/+$/g, "");
  const match = normalizedPath.match(/\/FeatureServer(?:\/(\d+))?$/i);
  if (!match) {
    throw new UserFacingError("请输入 FeatureServer 根地址或子图层地址（.../FeatureServer 或 .../FeatureServer/0）。");
  }

  const layerId = match[1] ? Number(match[1]) : undefined;
  const rootPath = normalizedPath.replace(/\/FeatureServer(?:\/\d+)?$/i, "/FeatureServer");
  const serviceUrl = `${parsed.origin}${rootPath}`;

  return {
    serviceUrl,
    layerId: Number.isFinite(layerId) ? layerId : undefined
  };
}

function inferServiceName(serviceUrl: string): string {
  const parts = serviceUrl.split("/").filter(Boolean);
  const featureServerIndex = parts.findIndex((item) => item.toLowerCase() === "featureserver");
  const candidate = featureServerIndex > 0 ? parts[featureServerIndex - 1] : parts.at(-1) ?? "feature_service";
  try {
    return decodeURIComponent(candidate);
  } catch {
    return candidate;
  }
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export class LayerRegistry {
  private state: RegistryState = {
    version: 1,
    services: [],
    layers: [],
    updatedAt: new Date(0).toISOString()
  };

  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.loadFromDisk();
    if (this.state.layers.length === 0) {
      try {
        await this.registerService(config.defaultParksLayerUrl);
      } catch (error) {
        console.warn("[layer-registry] 默认公园图层自动注册失败，使用本地兜底配置:", (error as Error).message);
        this.state = this.buildFallbackState();
        await this.persist();
      }
    }
    this.initialized = true;
  }

  listCatalog(): LayerCatalogResponse {
    return {
      services: this.state.services.map((item) => ({ ...item })),
      layers: this.state.layers.map((item) => ({
        ...item,
        fields: item.fields.map((field) => ({ ...field })),
        aliases: [...item.aliases]
      }))
    };
  }

  getLayer(layerKeyOrAlias: string | undefined): LayerDescriptor | undefined {
    if (!layerKeyOrAlias) {
      return this.getDefaultLayer();
    }

    const exact = this.state.layers.find((layer) => layer.layerKey === layerKeyOrAlias);
    if (exact) {
      return exact;
    }

    const normalized = layerKeyOrAlias.trim().toLowerCase();
    return this.state.layers.find(
      (layer) =>
        layer.aliases.some((alias) => alias.toLowerCase() === normalized) ||
        layer.name.toLowerCase() === normalized
    );
  }

  getDefaultLayer(): LayerDescriptor | undefined {
    return (
      this.state.layers.find((layer) => layer.aliases.some((alias) => alias.toLowerCase() === "fuzhou_parks")) ??
      this.state.layers.find((layer) => layer.queryable) ??
      this.state.layers[0]
    );
  }

  async registerService(rawUrl: string): Promise<RegisterResult> {
    const { serviceUrl } = parseFeatureServerUrl(rawUrl);
    const existed = this.state.services.find((item) => item.serviceUrl === serviceUrl);
    if (existed) {
      return {
        service: existed,
        layers: this.state.layers.filter((layer) => layer.serviceId === existed.serviceId)
      };
    }

    if (this.state.services.length >= config.maxRegisteredServices) {
      throw new UserFacingError(`已达到最大服务数量上限（${config.maxRegisteredServices}）。`);
    }

    const serviceMeta = await this.fetchArcgisJson<ArcgisServiceMetaLike>(`${serviceUrl}?f=pjson`);
    const layerDefs = serviceMeta.layers ?? [];
    if (layerDefs.length === 0) {
      throw new UserFacingError("该服务下未发现可用子图层。");
    }

    const serviceId = serviceIdFromUrl(serviceUrl);
    const service: LayerServiceDescriptor = {
      serviceId,
      serviceUrl,
      name: inferServiceName(serviceUrl),
      spatialReference: serviceMeta.spatialReference ?? null,
      maxRecordCount: Number.isFinite(serviceMeta.maxRecordCount) ? Number(serviceMeta.maxRecordCount) : null
    };

    const layers: LayerDescriptor[] = [];
    for (const layerDef of layerDefs) {
      if (typeof layerDef.id !== "number") {
        continue;
      }

      try {
        const layerMeta = await this.fetchArcgisJson<ArcgisLayerMetaLike>(`${serviceUrl}/${layerDef.id}?f=pjson`);
        const fields = (layerMeta.fields ?? [])
          .map((field) => normalizeField(field))
          .filter((field): field is LayerField => Boolean(field));
        const objectIdField = String(layerMeta.objectIdField ?? "OBJECTID");
        const displayField =
          String(layerMeta.displayField ?? "").trim() || fields.find((field) => field.type === "esriFieldTypeString")?.name || objectIdField;
        const layerName = String(layerMeta.name ?? layerDef.name ?? `Layer_${layerDef.id}`);
        const aliases = uniqueValues([
          layerName,
          slugify(layerName),
          `${service.name}_${layerName}`,
          slugify(`${service.name}_${layerName}`),
          layerName.replace(/图层|数据|数据库/g, "")
        ]);

        if (/公园/.test(layerName)) {
          aliases.push("fuzhou_parks");
        }

        layers.push({
          layerKey: `${serviceId}:${layerDef.id}`,
          serviceId,
          layerId: layerDef.id,
          url: `${serviceUrl}/${layerDef.id}`,
          name: layerName,
          geometryType: String(layerMeta.geometryType ?? layerDef.geometryType ?? "unknown"),
          objectIdField,
          displayField,
          fields,
          visibleByDefault: true,
          queryable: true,
          aliases: uniqueValues(aliases)
        });
      } catch (error) {
        console.warn(
          `[layer-registry] 子图层加载失败，已跳过: ${serviceUrl}/${layerDef.id}`,
          (error as Error).message
        );
      }
    }

    if (layers.length === 0) {
      throw new UserFacingError("服务可访问，但子图层元数据解析失败。");
    }

    this.state.services.push(service);
    this.state.layers.push(...layers);
    this.touch();
    await this.persist();

    return { service, layers };
  }

  async removeService(serviceId: string): Promise<void> {
    const existed = this.state.services.some((service) => service.serviceId === serviceId);
    if (!existed) {
      throw new UserFacingError("服务不存在，无法删除。");
    }

    this.state.services = this.state.services.filter((service) => service.serviceId !== serviceId);
    this.state.layers = this.state.layers.filter((layer) => layer.serviceId !== serviceId);
    this.touch();
    await this.persist();
  }

  async updateLayerFlags(
    layerKey: string,
    flags: { visibleByDefault?: boolean; queryable?: boolean }
  ): Promise<LayerDescriptor> {
    const layer = this.state.layers.find((item) => item.layerKey === layerKey);
    if (!layer) {
      throw new UserFacingError("图层不存在，无法更新。");
    }

    if (typeof flags.visibleByDefault === "boolean") {
      layer.visibleByDefault = flags.visibleByDefault;
    }
    if (typeof flags.queryable === "boolean") {
      layer.queryable = flags.queryable;
    }

    this.touch();
    await this.persist();
    return layer;
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const content = await fs.readFile(config.layerRegistryPath, "utf8");
      const parsed = JSON.parse(content) as RegistryState;
      this.state = {
        version: Number(parsed.version ?? 1),
        services: Array.isArray(parsed.services) ? parsed.services : [],
        layers: Array.isArray(parsed.layers) ? parsed.layers : [],
        updatedAt: parsed.updatedAt ?? new Date().toISOString()
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[layer-registry] 注册表读取失败，使用空配置:", (error as Error).message);
      }
      this.state = {
        version: 1,
        services: [],
        layers: [],
        updatedAt: new Date().toISOString()
      };
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(config.layerRegistryPath), { recursive: true });
    const tmpFile = `${config.layerRegistryPath}.${process.pid}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(this.state, null, 2), "utf8");
    await fs.rename(tmpFile, config.layerRegistryPath);
  }

  private async fetchArcgisJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.layerMetaTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new UserFacingError(`图层元数据请求失败: ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private touch(): void {
    this.state.updatedAt = new Date().toISOString();
  }

  private buildFallbackState(): RegistryState {
    const { serviceUrl, layerId } = parseFeatureServerUrl(config.defaultParksLayerUrl);
    const serviceId = serviceIdFromUrl(serviceUrl);
    const pickedLayerId = typeof layerId === "number" ? layerId : 0;

    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      services: [
        {
          serviceId,
          serviceUrl,
          name: inferServiceName(serviceUrl),
          spatialReference: { wkid: 3857 },
          maxRecordCount: 2000
        }
      ],
      layers: [
        {
          layerKey: `${serviceId}:${pickedLayerId}`,
          serviceId,
          layerId: pickedLayerId,
          url: `${serviceUrl}/${pickedLayerId}`,
          name: "福州市公园点",
          geometryType: "esriGeometryPoint",
          objectIdField: "fid",
          displayField: "名称",
          fields: [
            { name: "fid", alias: "fid", type: "esriFieldTypeOID", queryable: true },
            { name: "objectid", alias: "objectid", type: "esriFieldTypeInteger", queryable: true },
            { name: "名称", alias: "名称", type: "esriFieldTypeString", queryable: true },
            { name: "地址", alias: "地址", type: "esriFieldTypeString", queryable: true },
            { name: "城市", alias: "城市", type: "esriFieldTypeString", queryable: true },
            { name: "区县", alias: "区县", type: "esriFieldTypeString", queryable: true }
          ],
          visibleByDefault: true,
          queryable: true,
          aliases: ["fuzhou_parks", "福州市公园点", "公园"]
        }
      ]
    };
  }
}

export const layerRegistry = new LayerRegistry();

export function buildCandidateLayerText(layers: LayerDescriptor[]): string {
  return layers.map((layer) => `${layer.name}（${layer.layerKey}）`).join("、");
}

export function parseLayerServiceUrl(rawUrl: string): { serviceUrl: string; layerId?: number } {
  return parseFeatureServerUrl(rawUrl);
}
