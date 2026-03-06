import { z } from "zod";

export const semanticFieldRoleSchema = z.enum([
  "id",
  "name",
  "admin",
  "address",
  "measure",
  "category",
  "unknown"
]);

export const layerSemanticProfileSchema = z.object({
  tokens: z.array(z.string().min(1)).default([]),
  fieldRoles: z.record(z.string().min(1), semanticFieldRoleSchema).default({}),
  adminFields: z.array(z.string().min(1)).default([]),
  nameFields: z.array(z.string().min(1)).default([]),
  valueHints: z.record(z.string().min(1), z.array(z.string().min(1)).max(20)).optional()
});

export const layerFieldSchema = z.object({
  name: z.string().min(1),
  alias: z.string().min(1),
  type: z.string().min(1),
  queryable: z.boolean().default(true)
});

export const layerServiceDescriptorSchema = z.object({
  serviceId: z.string().min(1),
  serviceUrl: z.string().url(),
  name: z.string().min(1),
  spatialReference: z.record(z.unknown()).nullable().optional(),
  maxRecordCount: z.number().int().positive().nullable().optional()
});

export const layerDescriptorSchema = z.object({
  layerKey: z.string().min(1),
  serviceId: z.string().min(1),
  layerId: z.number().int().nonnegative(),
  url: z.string().url(),
  name: z.string().min(1),
  geometryType: z.string().min(1),
  objectIdField: z.string().min(1),
  displayField: z.string().min(1),
  fields: z.array(layerFieldSchema).default([]),
  visibleByDefault: z.boolean().default(true),
  pointRenderMode: z.enum(["default", "heatmap"]).optional(),
  queryable: z.boolean().default(true),
  aliases: z.array(z.string().min(1)).default([]),
  semanticProfile: layerSemanticProfileSchema.optional()
});

export const layerCatalogResponseSchema = z.object({
  services: z.array(layerServiceDescriptorSchema).default([]),
  layers: z.array(layerDescriptorSchema).default([])
});

export type LayerField = z.infer<typeof layerFieldSchema>;
export type SemanticFieldRole = z.infer<typeof semanticFieldRoleSchema>;
export type LayerSemanticProfile = z.infer<typeof layerSemanticProfileSchema>;
export type LayerServiceDescriptor = z.infer<typeof layerServiceDescriptorSchema>;
export type LayerDescriptor = z.infer<typeof layerDescriptorSchema>;
export type LayerCatalogResponse = z.infer<typeof layerCatalogResponseSchema>;
