"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { TimelineBucket } from "@/lib/admin/campaign-report";
import styles from "./report.module.css";

/** A submit button that asks first. Works inside a server-action form. */
export function ConfirmSubmit({
  message,
  className,
  children,
}: {
  message: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(event) => {
        if (!window.confirm(message)) {
          event.preventDefault();
        }
      }}
    >
      {children}
    </button>
  );
}

function niceMax(value: number): number {
  if (value <= 4) return Math.max(1, value);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

function ticksFor(max: number): number[] {
  if (max <= 4) return Array.from({ length: max + 1 }, (_, i) => i);
  return [0, max / 4, max / 2, (max * 3) / 4, max].map((v) =>
    Number.isInteger(v) ? v : Number(v.toFixed(1)),
  );
}

function compact(value: number): string {
  if (value >= 10_000) {
    return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  }
  return value.toLocaleString("bg-BG");
}

const HEIGHT = 240;
const MARGIN = { top: 14, right: 18, bottom: 30, left: 44 };

export function EngagementChart({
  buckets,
  unit,
}: {
  buckets: TimelineBucket[];
  unit: "hour" | "day";
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [mode, setMode] = useState<"period" | "total">("period");
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const update = () => setWidth(Math.max(280, Math.round(node.clientWidth)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const series = useMemo(() => {
    let opens = 0;
    let clicks = 0;
    return buckets.map((bucket) => {
      opens += bucket.opens;
      clicks += bucket.clicks;
      return mode === "total"
        ? { opens, clicks }
        : { opens: bucket.opens, clicks: bucket.clicks };
    });
  }, [buckets, mode]);

  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const peak = series.reduce((m, p) => Math.max(m, p.opens, p.clicks), 0);
  const yMax = niceMax(peak);
  const ticks = ticksFor(yMax);
  const n = buckets.length;
  const x = useCallback(
    (i: number) => MARGIN.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW),
    [innerW, n],
  );
  const y = (v: number) => MARGIN.top + innerH - (v / yMax) * innerH;

  const line = (key: "opens" | "clicks") =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  const area =
    n > 1
      ? `${line("opens")}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`
      : "";

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 90))));
  const xLabels = buckets
    .map((bucket, i) => ({ i, label: bucket.label }))
    .filter(({ i }) => i % labelEvery === 0);

  const pick = (clientX: number, target: Element) => {
    const rect = target.getBoundingClientRect();
    const px = clientX - rect.left;
    if (n <= 1) return 0;
    const ratio = (px - MARGIN.left) / innerW;
    return Math.min(n - 1, Math.max(0, Math.round(ratio * (n - 1))));
  };

  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    setActive(pick(event.clientX, event.currentTarget));
  };

  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      setActive((current) =>
        Math.min(n - 1, Math.max(0, (current ?? (delta > 0 ? -1 : n)) + delta)),
      );
    } else if (event.key === "Escape") {
      setActive(null);
    }
  };

  const activePoint = active !== null ? series[active] : null;
  const activeBucket = active !== null ? buckets[active] : null;
  const tooltipLeft =
    active !== null ? Math.min(Math.max(x(active), 90), width - 90) : 0;
  const totals = series.at(-1);
  const periodWord = unit === "hour" ? "hour" : "day";

  return (
    <div className={styles.chart}>
      <div className={styles.chartTop}>
        <ul className={styles.legend} aria-label="Series">
          <li>
            <span className={`${styles.legendKey} ${styles.keyOpen}`} aria-hidden />
            Unique opens
          </li>
          <li>
            <span className={`${styles.legendKey} ${styles.keyClick}`} aria-hidden />
            Unique clicks
          </li>
        </ul>
        <div className={styles.segmented} role="group" aria-label="Chart values">
          <button
            type="button"
            aria-pressed={mode === "period"}
            className={mode === "period" ? styles.segmentedOn : undefined}
            onClick={() => setMode("period")}
          >
            Per {periodWord}
          </button>
          <button
            type="button"
            aria-pressed={mode === "total"}
            className={mode === "total" ? styles.segmentedOn : undefined}
            onClick={() => setMode("total")}
          >
            Running total
          </button>
        </div>
      </div>

      <div ref={wrapRef} className={styles.chartCanvas}>
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          tabIndex={0}
          aria-label={`Unique opens and clicks per ${periodWord}. Use the arrow keys to step through.`}
          onMouseMove={onMove}
          onMouseLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(tick)}
                y2={y(tick)}
                className={tick === 0 ? styles.axisBase : styles.grid}
              />
              <text x={MARGIN.left - 8} y={y(tick)} className={styles.yTick}>
                {compact(tick)}
              </text>
            </g>
          ))}
          {xLabels.map(({ i, label }) => (
            <text key={i} x={x(i)} y={HEIGHT - 8} className={styles.xTick}>
              {label}
            </text>
          ))}
          {area ? <path d={area} className={styles.areaOpen} /> : null}
          {n > 1 ? <path d={line("opens")} className={styles.lineOpen} /> : null}
          {n > 1 ? <path d={line("clicks")} className={styles.lineClick} /> : null}
          {n <= 2
            ? series.map((p, i) => (
                <g key={i}>
                  <circle cx={x(i)} cy={y(p.opens)} r={4} className={styles.dotOpen} />
                  <circle cx={x(i)} cy={y(p.clicks)} r={4} className={styles.dotClick} />
                </g>
              ))
            : null}
          {activePoint && active !== null ? (
            <g pointerEvents="none">
              <line
                x1={x(active)}
                x2={x(active)}
                y1={MARGIN.top}
                y2={MARGIN.top + innerH}
                className={styles.crosshair}
              />
              <circle cx={x(active)} cy={y(activePoint.opens)} r={4.5} className={styles.dotOpen} />
              <circle cx={x(active)} cy={y(activePoint.clicks)} r={4.5} className={styles.dotClick} />
            </g>
          ) : null}
        </svg>
        {activePoint && activeBucket ? (
          <div className={styles.tooltip} style={{ left: tooltipLeft }} role="status">
            <div className={styles.tooltipTitle}>{activeBucket.longLabel}</div>
            <div className={styles.tooltipRow}>
              <span className={`${styles.legendKey} ${styles.keyOpen}`} aria-hidden />
              <span>{mode === "total" ? "Opens so far" : "Opens"}</span>
              <strong>{activePoint.opens.toLocaleString("bg-BG")}</strong>
            </div>
            <div className={styles.tooltipRow}>
              <span className={`${styles.legendKey} ${styles.keyClick}`} aria-hidden />
              <span>{mode === "total" ? "Clicks so far" : "Clicks"}</span>
              <strong>{activePoint.clicks.toLocaleString("bg-BG")}</strong>
            </div>
          </div>
        ) : null}
      </div>

      <details className={styles.chartTable}>
        <summary>Show as table</summary>
        <div className={styles.tableScroll}>
          <table className={styles.miniTable}>
            <thead>
              <tr>
                <th>{unit === "hour" ? "Hour" : "Day"}</th>
                <th className={styles.num}>Opens</th>
                <th className={styles.num}>Clicks</th>
              </tr>
            </thead>
            <tbody>
              {buckets
                .filter((bucket) => bucket.opens > 0 || bucket.clicks > 0)
                .map((bucket) => (
                  <tr key={bucket.key}>
                    <td>{bucket.longLabel}</td>
                    <td className={styles.num}>{bucket.opens.toLocaleString("bg-BG")}</td>
                    <td className={styles.num}>{bucket.clicks.toLocaleString("bg-BG")}</td>
                  </tr>
                ))}
            </tbody>
            {totals ? (
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className={styles.num}>
                    {buckets.reduce((s, b) => s + b.opens, 0).toLocaleString("bg-BG")}
                  </td>
                  <td className={styles.num}>
                    {buckets.reduce((s, b) => s + b.clicks, 0).toLocaleString("bg-BG")}
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </details>
    </div>
  );
}
