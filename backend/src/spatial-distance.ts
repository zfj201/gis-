type SpatialDistanceUnit = "meter" | "kilometer" | undefined;

function toPositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function normalizeRadiusMeters(
  radius: unknown,
  unit: SpatialDistanceUnit
): number | undefined {
  const parsed = toPositiveNumber(radius);
  if (parsed === null) {
    return undefined;
  }
  if (unit === "kilometer") {
    return Math.round(parsed * 1000);
  }
  return Math.round(parsed);
}

export function normalizeDistancesMeters(
  distances: unknown,
  unit: SpatialDistanceUnit
): number[] {
  if (!Array.isArray(distances)) {
    return [];
  }
  const normalized = distances
    .map((item) => normalizeRadiusMeters(item, unit))
    .filter((item): item is number => typeof item === "number" && item > 0);
  return Array.from(new Set(normalized)).sort((a, b) => a - b);
}

