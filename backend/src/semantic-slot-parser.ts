import type { LayerDescriptor } from "@gis/shared";

function trimWrappingQuotes(value: string): string {
  return value.replace(/^[“"'`]+|[”"'`]+$/g, "");
}

function cleanPunctuationTail(value: string): string {
  return value.replace(/[。！？!?，,\s]+$/g, "");
}

function fieldRoleFromLayer(fieldName: string, layer: LayerDescriptor): string {
  const role = layer.semanticProfile?.fieldRoles?.[fieldName];
  if (role) {
    return role;
  }
  const merged = fieldName.toLowerCase();
  if (/(county|district|city|town|village|区县|行政|县级|城市|乡镇|街道)/i.test(merged)) {
    return "admin";
  }
  if (/(objectid|fid|编号|id)$/i.test(merged)) {
    return "id";
  }
  if (/(shape__area|shape__length|面积|长度|周长|area|length)/i.test(merged)) {
    return "measure";
  }
  if (/(地址|address|门牌)/i.test(merged)) {
    return "address";
  }
  if (/(名称|name|title|标准名称)/i.test(merged)) {
    return "name";
  }
  return "unknown";
}

function layerEntityTokens(layer: LayerDescriptor): string[] {
  const fromProfile = layer.semanticProfile?.tokens ?? [];
  if (fromProfile.length > 0) {
    return fromProfile;
  }
  const tokens = new Set<string>();
  for (const raw of [layer.name, ...layer.aliases]) {
    const chunks = raw
      .split(/[_\-\s,/\\|:;()（）【】\[\]]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    for (const chunk of chunks) {
      if (chunk.length >= 2) {
        tokens.add(chunk);
      }
    }
    const zhMatches = raw.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
    for (const token of zhMatches) {
      tokens.add(token);
    }
  }
  return Array.from(tokens);
}

export function cleanCollectionValue(value: string): string {
  let next = cleanPunctuationTail(trimWrappingQuotes(value).trim());
  next = next
    .replace(/的(?:宗地院落|道路街巷|门牌号码|公园|房屋建筑|单元楼).*$/g, "")
    .replace(/(?:列表|清单|名录).*$/g, "")
    .trim();
  next = next
    .replace(/(?:之)?中$/g, "")
    .replace(/里$/g, "")
    .replace(/内$/g, "")
    .trim();
  return next;
}

export function trimLayerEntityTailByField(value: string, field: string, layer: LayerDescriptor): string {
  const role = fieldRoleFromLayer(field, layer);
  if (role !== "admin" && role !== "name" && role !== "category") {
    return value;
  }

  let next = value.trim();
  const sortedTokens = layerEntityTokens(layer).sort((a, b) => b.length - a.length);
  for (const token of sortedTokens) {
    if (!token.trim()) {
      continue;
    }
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`的?${escaped}$`, "i"), "").trim();
  }

  if (role === "admin" && /[县区市州乡镇旗]的/.test(next)) {
    next = next.replace(/([^\s，,。！？!?]*?[县区市州乡镇旗])的.+$/, "$1").trim();
  }
  return cleanPunctuationTail(next);
}
