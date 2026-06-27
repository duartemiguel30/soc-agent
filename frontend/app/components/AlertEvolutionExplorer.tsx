"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertEvolutionBucket,
  AlertEvolutionPoint,
  AlertEvolutionRange,
  AlertEvolutionResponse,
  getAlertEvolution,
} from "@/lib/api";

const rangeOptions: { value: AlertEvolutionRange; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "1m", label: "1m" },
  { value: "1y", label: "1y" },
  { value: "all", label: "All" },
];

const bucketOptionsByRange: Record<AlertEvolutionRange, AlertEvolutionBucket[]> = {
  "24h": ["hour"],
  "7d": ["day"],
  "1m": ["day", "week"],
  "1y": ["week", "month"],
  all: ["year"],
};

const defaultBucketByRange: Record<AlertEvolutionRange, AlertEvolutionBucket> = {
  "24h": "hour",
  "7d": "day",
  "1m": "day",
  "1y": "month",
  all: "year",
};

const bucketLabels: Record<AlertEvolutionBucket, string> = {
  hour: "Hourly",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  year: "Yearly",
};

function queryRange(value: string | null): AlertEvolutionRange {
  return value === "24h" || value === "7d" || value === "1m" || value === "1y" || value === "all" ? value : "1m";
}

function queryBucket(value: string | null, range: AlertEvolutionRange): AlertEvolutionBucket {
  const fallback = defaultBucketByRange[range];
  return value && bucketOptionsByRange[range].includes(value as AlertEvolutionBucket)
    ? (value as AlertEvolutionBucket)
    : fallback;
}

function queryAnchor(value: string | null) {
  return value || "";
}

function toDateInputValue(date: Date) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

function shiftAnchorDate(anchor: string, range: AlertEvolutionRange, direction: -1 | 1) {
  const [year, month, day] = anchor.split("-").map((part) => Number(part));
  const date = new Date(year, month - 1, day || 1);
  if (range === "24h") {
    date.setDate(date.getDate() + direction);
  } else if (range === "7d") {
    date.setDate(date.getDate() + direction * 7);
  } else if (range === "1m") {
    date.setMonth(date.getMonth() + direction);
  } else if (range === "1y") {
    date.setFullYear(date.getFullYear() + direction);
  }
  return toDateInputValue(date);
}

function evolutionAnchorValue(range: AlertEvolutionRange, anchor: string) {
  if (range === "1m") {
    return anchor.slice(0, 7);
  }
  if (range === "1y") {
    return anchor.slice(0, 4);
  }
  return anchor;
}

function formatDataExtent(evolution: AlertEvolutionResponse | null) {
  if (!evolution?.data_start || !evolution.data_end) {
    return "No stored events";
  }
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  return `${formatter.format(new Date(evolution.data_start))} - ${formatter.format(new Date(evolution.data_end))}`;
}

function EmptyChart({ children = "No alert events in this period." }: { children?: string }) {
  return <div className="chart-empty">{children}</div>;
}

function timelineHref(range: AlertEvolutionRange, bucket: AlertEvolutionBucket, anchor?: string) {
  const search = new URLSearchParams({ range, bucket });
  if (anchor) {
    search.set("anchor", anchor);
  }
  return `/analytics/alerts?${search.toString()}`;
}

function TimelineBarChart({
  data,
  loading,
  range,
  bucket,
  interactive,
  mode,
}: {
  data: AlertEvolutionPoint[];
  loading: boolean;
  range: AlertEvolutionRange;
  bucket: AlertEvolutionBucket;
  interactive: boolean;
  mode: "compact" | "full";
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const max = Math.max(...data.map((item) => item.count), 1);
  const hasData = data.some((item) => item.count > 0);

  if (loading) {
    return <EmptyChart>Loading alert events...</EmptyChart>;
  }

  if (!data.length || !hasData) {
    return <EmptyChart />;
  }

  const scrollChart = (direction: -1 | 1) => {
    viewportRef.current?.scrollBy({ left: direction * 280, behavior: "smooth" });
  };

  const columns = data.map((item) => {
    const content = (
      <>
        <div className="bar-track" aria-label={`${item.label}: ${item.count}`}>
          <span className="bar-fill" style={{ height: `${Math.max(8, (item.count / max) * 100)}%` }} />
        </div>
        <strong>{item.count}</strong>
        <span>{item.label}</span>
      </>
    );
    return interactive ? (
      <Link
        className="bar-column bar-column-link"
        href={timelineHref(range, bucket, item.start.slice(0, 10))}
        key={item.start}
        role="listitem"
      >
        {content}
      </Link>
    ) : (
      <div className="bar-column" key={item.start} role="listitem">
        {content}
      </div>
    );
  });

  if (mode === "full") {
    return (
      <div className="timeline-grid-full" role="list">
        {columns}
      </div>
    );
  }

  return (
    <div className="chart-scroll-shell">
      <div className="chart-scroll-actions" aria-label="Chart scrolling">
        <button className="button ghost chart-scroll-button" onClick={() => scrollChart(-1)} type="button">
          Left
        </button>
        <button className="button ghost chart-scroll-button" onClick={() => scrollChart(1)} type="button">
          Right
        </button>
      </div>
      <div className="chart-scroll-viewport" ref={viewportRef}>
        <div className="bar-chart evolution-bar-chart" role="list">
          {columns}
        </div>
      </div>
    </div>
  );
}

function AlertEvolutionExplorerContent({
  mode = "full",
  titleLink = false,
}: {
  mode?: "compact" | "full";
  titleLink?: boolean;
}) {
  const searchParams = useSearchParams();
  const initialRange = queryRange(searchParams.get("range"));
  const initialAnchor = queryAnchor(searchParams.get("anchor"));
  const [range, setRange] = useState<AlertEvolutionRange>(initialRange);
  const [bucket, setBucket] = useState<AlertEvolutionBucket>(() => queryBucket(searchParams.get("bucket"), initialRange));
  const [anchor, setAnchor] = useState(initialAnchor);
  const [anchored, setAnchored] = useState(Boolean(initialAnchor));
  const [evolution, setEvolution] = useState<AlertEvolutionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEvolution = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setEvolution(
        await getAlertEvolution({
          range,
          bucket,
          anchor: range === "all" || !anchored ? undefined : anchor,
          archived: "all",
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load alert evolution");
    } finally {
      setLoading(false);
    }
  }, [anchor, anchored, bucket, range]);

  useEffect(() => {
    const initialLoad = window.setTimeout(loadEvolution, 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadEvolution]);

  useEffect(() => {
    const applyParams = window.setTimeout(() => {
      const nextRange = queryRange(searchParams.get("range"));
      const nextAnchor = queryAnchor(searchParams.get("anchor"));
      setRange(nextRange);
      setBucket(queryBucket(searchParams.get("bucket"), nextRange));
      setAnchor(nextAnchor);
      setAnchored(Boolean(nextAnchor));
    }, 0);
    return () => window.clearTimeout(applyParams);
  }, [searchParams]);

  const handleRangeChange = (nextRange: AlertEvolutionRange) => {
    setRange(nextRange);
    setBucket(defaultBucketByRange[nextRange]);
    setAnchor("");
    setAnchored(false);
  };

  const handleAnchorChange = (value: string) => {
    if (!value) {
      return;
    }
    setAnchored(true);
    if (range === "1m") {
      setAnchor(`${value}-01`);
    } else if (range === "1y") {
      setAnchor(`${value}-01-01`);
    } else {
      setAnchor(value);
    }
  };

  const handleNavigation = (direction: -1 | 1) => {
    if (range !== "all") {
      setAnchored(true);
      setAnchor((current) => shiftAnchorDate(current || toDateInputValue(new Date()), range, direction));
    }
  };

  const resetToNow = () => {
    setAnchor("");
    setAnchored(false);
  };

  const showBucketSelector = bucketOptionsByRange[range].length > 1;
  const showDatePicker = range !== "all";
  const compact = mode === "compact";

  return (
    <div className={compact ? "alert-evolution compact-evolution" : "alert-evolution full-evolution"}>
      <div className="section-head">
        <h2>{titleLink ? <Link href="/analytics/alerts">Alert/Event Evolution</Link> : "Alert/Event Evolution"}</h2>
        <span>{evolution ? `${evolution.window_label} · ${evolution.total} events` : "Counted by alert events"}</span>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      <div className="evolution-controls" aria-label="Alert evolution controls">
        <div className="segmented-control range-selector" aria-label="Time range">
          {rangeOptions.map((option) => (
            <button
              className={range === option.value ? "active" : ""}
              key={option.value}
              onClick={() => handleRangeChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="evolution-control-row">
          {showBucketSelector ? (
            <label className="field compact-field">
              Resolution
              <select value={bucket} onChange={(event) => setBucket(event.target.value as AlertEvolutionBucket)}>
                {bucketOptionsByRange[range].map((option) => (
                  <option key={option} value={option}>
                    {bucketLabels[option]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {range === "all" ? (
            <div className="evolution-history-scope">
              <span>History</span>
              <strong>{formatDataExtent(evolution)}</strong>
            </div>
          ) : showDatePicker ? (
            <label className="field compact-field">
              {range === "1m" ? "Month" : range === "1y" ? "Year" : "Date"}
              <input
                max={range === "1y" ? "9999" : undefined}
                min={range === "1y" ? "1970" : undefined}
                onChange={(event) => handleAnchorChange(event.target.value)}
                type={range === "1m" ? "month" : range === "1y" ? "number" : "date"}
                value={anchored ? evolutionAnchorValue(range, anchor) : ""}
              />
            </label>
          ) : null}

          {range !== "all" ? (
            <div className="chart-nav" aria-label="Time period navigation">
              <button
                className="button ghost"
                disabled={loading || !evolution?.can_go_previous}
                onClick={() => handleNavigation(-1)}
                type="button"
              >
                Previous
              </button>
              <button
                className="button ghost"
                disabled={loading || !evolution?.can_go_next}
                onClick={() => handleNavigation(1)}
                type="button"
              >
                Next
              </button>
              {anchored ? (
                <button className="button ghost" onClick={resetToNow} type="button">
                  Reset to now
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <TimelineBarChart
        data={evolution?.points || []}
        loading={loading}
        range={range}
        bucket={bucket}
        interactive
        mode={mode}
      />

      {compact ? (
        <div className="chart-footer">
          <span>Correlated attacks can have multiple alert events inside one incident.</span>
          <Link href={timelineHref(range, bucket, range === "all" ? undefined : anchor)}>Explore timeline</Link>
        </div>
      ) : (
        <p className="section-subtitle">Counted by alert events. Correlated attacks can have multiple alert events inside one incident.</p>
      )}
    </div>
  );
}

export function AlertEvolutionExplorer({
  compact,
  mode,
  titleLink,
}: {
  compact?: boolean;
  mode?: "compact" | "full";
  titleLink?: boolean;
}) {
  const resolvedMode = mode || (compact ? "compact" : "full");
  return (
    <Suspense fallback={<div className="chart-empty">Loading alert events...</div>}>
      <AlertEvolutionExplorerContent mode={resolvedMode} titleLink={titleLink} />
    </Suspense>
  );
}
