import { Incident } from "@/lib/api";
import { incidentEventCount, labelValue, normalizeValue } from "@/lib/incidents";

export type DistributionDatum = {
  label: string;
  value: number;
  color?: string;
  href?: string;
  key?: string;
};

export function totalAlertEvents(incidents: Incident[]) {
  return incidents.reduce((sum, incident) => sum + incidentEventCount(incident), 0);
}

export function incidentFilterHref(filters: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) {
      search.set(key, value);
    }
  });
  return `/incidents?${search.toString()}`;
}

export function addWeightedDistribution(
  map: Map<string, number>,
  label: string | null | undefined,
  value: number,
) {
  const key = (label || "Unknown").trim() || "Unknown";
  map.set(key, (map.get(key) || 0) + value);
}

export function weightedDistribution(
  incidents: Incident[],
  getLabel: (incident: Incident) => string | null | undefined,
  options: {
    colors?: string[];
    limit?: number;
    hrefFor?: (label: string) => string;
  } = {},
) {
  const map = new Map<string, number>();
  incidents.forEach((incident) => addWeightedDistribution(map, getLabel(incident), incidentEventCount(incident)));
  return Array.from(map.entries())
    .map(([label, value], index) => ({
      label: labelValue(label),
      value,
      color: options.colors?.[index % options.colors.length],
      href: options.hrefFor?.(label),
      key: normalizeValue(label),
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, options.limit);
}

export function mitreDistribution(incidents: Incident[], limit?: number) {
  return weightedDistribution(incidents, (incident) => incident.mitre_technique || "Unknown", {
    limit,
    hrefFor: (label) => incidentFilterHref({ archived: "all", mitre: label }),
  });
}
