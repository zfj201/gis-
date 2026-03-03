import { z } from "zod";

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
  queryable: z.boolean().default(true),
  aliases: z.array(z.string().min(1)).default([])
});

export const layerCatalogResponseSchema = z.object({
  services: z.array(layerServiceDescriptorSchema).default([]),
  layers: z.array(layerDescriptorSchema).default([])
});

export type LayerField = z.infer<typeof layerFieldSchema>;
export type LayerServiceDescriptor = z.infer<typeof layerServiceDescriptorSchema>;
export type LayerDescriptor = z.infer<typeof layerDescriptorSchema>;
export type LayerCatalogResponse = z.infer<typeof layerCatalogResponseSchema>;
