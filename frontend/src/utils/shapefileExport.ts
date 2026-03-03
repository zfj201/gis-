import JSZip from "jszip";
import shpwrite from "@mapbox/shp-write";

interface EsriFeatureLike {
  attributes?: Record<string, unknown>;
  geometry?: Record<string, unknown>;
}

interface ExportOptions {
  features: EsriFeatureLike[];
  fileNameBase: string;
  encoding?: string;
}

const WEB_MERCATOR_PRJ = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",' +
  'SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],' +
  'UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],' +
  'PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],' +
  'PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]';

function sanitizeFileName(input: string): string {
  const value = input.replace(/[\\/:*?"<>|]+/g, "_").trim();
  return value || "layer_export";
}

function toCoordinates(value: unknown): number[][] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((pair) => (Array.isArray(pair) ? [Number(pair[0]), Number(pair[1])] : null))
    .filter((item): item is number[] => Array.isArray(item) && Number.isFinite(item[0]) && Number.isFinite(item[1]));
}

function toGeoJsonGeometry(geometry: Record<string, unknown> | undefined): GeoJSON.Geometry | null {
  if (!geometry) {
    return null;
  }

  const x = Number((geometry as { x?: unknown }).x);
  const y = Number((geometry as { y?: unknown }).y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return {
      type: "Point",
      coordinates: [x, y]
    };
  }

  const points = (geometry as { points?: unknown }).points;
  if (Array.isArray(points) && points.length > 0) {
    const coordinates = toCoordinates(points);
    if (coordinates.length > 0) {
      return {
        type: "MultiPoint",
        coordinates
      };
    }
  }

  const paths = (geometry as { paths?: unknown }).paths;
  if (Array.isArray(paths) && paths.length > 0) {
    const allPaths = paths
      .map((path) => toCoordinates(path))
      .filter((item) => item.length > 0);
    if (allPaths.length === 1) {
      return {
        type: "LineString",
        coordinates: allPaths[0]
      };
    }
    if (allPaths.length > 1) {
      return {
        type: "MultiLineString",
        coordinates: allPaths
      };
    }
  }

  const rings = (geometry as { rings?: unknown }).rings;
  if (Array.isArray(rings) && rings.length > 0) {
    const allRings = rings
      .map((ring) => toCoordinates(ring))
      .filter((item) => item.length > 0);
    if (allRings.length > 0) {
      return {
        type: "Polygon",
        coordinates: allRings
      };
    }
  }

  return null;
}

async function appendCpgFiles(zipBuffer: ArrayBuffer, encoding: string): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const dbfFiles = Object.keys(zip.files).filter((name) => name.toLowerCase().endsWith(".dbf"));
  for (const dbfName of dbfFiles) {
    const cpgName = dbfName.replace(/\.dbf$/i, ".cpg");
    zip.file(cpgName, encoding);
  }
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

export async function downloadShapefileFromEsriFeatures(options: ExportOptions): Promise<void> {
  const fileNameBase = sanitizeFileName(options.fileNameBase);
  const encoding = options.encoding ?? "UTF-8";
  const features: GeoJSON.Feature[] = [];
  for (const feature of options.features) {
    const geometry = toGeoJsonGeometry(feature.geometry);
    if (!geometry) {
      continue;
    }
    features.push({
      type: "Feature",
      properties: (feature.attributes ?? {}) as GeoJSON.GeoJsonProperties,
      geometry
    });
  }

  if (features.length === 0) {
    throw new Error("没有可导出的几何要素。");
  }

  const geoJson: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features
  };

  const zipBuffer = await shpwrite.zip<"arraybuffer">(geoJson, {
    filename: fileNameBase,
    folder: fileNameBase,
    compression: "DEFLATE",
    outputType: "arraybuffer",
    prj: WEB_MERCATOR_PRJ
  });
  const finalBuffer = await appendCpgFiles(zipBuffer, encoding);

  const blob = new Blob([finalBuffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileNameBase}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
