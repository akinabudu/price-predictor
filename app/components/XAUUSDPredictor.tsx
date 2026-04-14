"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Cell, BarChart,
} from "recharts";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const VOLUME_BUCKETS = 60;
const VALUE_AREA_PCT = 0.70;
const REFRESH_INTERVAL = 60_000;

const PAIRS = [
  { label: "XAU/USD", symbol: "XAUUSD", yahoo: "XAUUSD=X", tv: "XAUUSD",      decimals: 2, base: 3285,   drift: 1.2,    range: 3.0   },
  { label: "EUR/USD", symbol: "EURUSD", yahoo: "EURUSD=X", tv: "FX:EURUSD",   decimals: 5, base: 1.0850, drift: 0.0002, range: 0.0005 },
  { label: "GBP/USD", symbol: "GBPUSD", yahoo: "GBPUSD=X", tv: "FX:GBPUSD",   decimals: 5, base: 1.2700, drift: 0.0002, range: 0.0006 },
  { label: "USD/JPY", symbol: "USDJPY", yahoo: "USDJPY=X", tv: "FX:USDJPY",   decimals: 3, base: 154.00, drift: 0.05,   range: 0.15  },
  { label: "USD/CHF", symbol: "USDCHF", yahoo: "USDCHF=X", tv: "FX:USDCHF",   decimals: 5, base: 0.9050, drift: 0.0002, range: 0.0005 },
  { label: "AUD/USD", symbol: "AUDUSD", yahoo: "AUDUSD=X", tv: "FX:AUDUSD",   decimals: 5, base: 0.6500, drift: 0.0002, range: 0.0004 },
  { label: "USD/CAD", symbol: "USDCAD", yahoo: "USDCAD=X", tv: "FX:USDCAD",   decimals: 5, base: 1.3650, drift: 0.0002, range: 0.0005 },
  { label: "NZD/USD", symbol: "NZDUSD", yahoo: "NZDUSD=X", tv: "FX:NZDUSD",   decimals: 5, base: 0.5950, drift: 0.0001, range: 0.0004 },
] as const;

type Pair = typeof PAIRS[number];

// lookback = ATR window (1-min candles), momentum = candle count for directional bias,
// atrMult = projection aggressiveness, label shown in prediction panel.
const TIMEFRAMES = [
  { label: "30M",  lookback: 30,  momentum: 10, atrMult: 2.0, display: "30-MINUTE" },
  { label: "1H",   lookback: 60,  momentum: 20, atrMult: 3.0, display: "1-HOUR"    },
  { label: "4H",   lookback: 240, momentum: 60, atrMult: 5.0, display: "4-HOUR"    },
  { label: "1D",   lookback: 390, momentum: 90, atrMult: 8.0, display: "DAILY"     },
] as const;

type Timeframe = typeof TIMEFRAMES[number];

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface Candle {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Bucket {
  priceLevel: number;
  volume: number;
  normalizedVol?: number;
  isPOC?: boolean;
  isVAH?: boolean;
  isVAL?: boolean;
}

interface Prediction {
  direction: "BULLISH" | "BEARISH";
  target: number;
  rangeLow: number;
  rangeHigh: number;
  confidence: number;
  reasoning: string;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function buildVolumeProfile(candles: Candle[]) {
  if (!candles.length) return { profile: [] as Bucket[], poc: 0, vah: 0, val: 0 };
  const prices = candles.flatMap(c => [c.high, c.low]);
  const priceMin = Math.min(...prices);
  const priceMax = Math.max(...prices);
  const bucketSize = (priceMax - priceMin) / VOLUME_BUCKETS;

  const buckets: Bucket[] = Array.from({ length: VOLUME_BUCKETS }, (_, i) => ({
    priceLevel: priceMin + (i + 0.5) * bucketSize,
    volume: 0,
  }));

  candles.forEach(c => {
    const vol = c.volume || 1;
    const rangeTicks = Math.max(1, Math.round((c.high - c.low) / bucketSize));
    for (let p = c.low; p <= c.high + 1e-9; p += bucketSize) {
      const idx = Math.min(Math.floor((p - priceMin) / bucketSize), VOLUME_BUCKETS - 1);
      if (idx >= 0) buckets[idx].volume += vol / rangeTicks;
    }
  });

  const totalVol = buckets.reduce((s, b) => s + b.volume, 0);
  const pocIdx = buckets.reduce((mi, b, i, a) => b.volume > a[mi].volume ? i : mi, 0);
  const poc = buckets[pocIdx].priceLevel;

  let captured = buckets[pocIdx].volume;
  let lo = pocIdx, hi = pocIdx;
  while (captured / totalVol < VALUE_AREA_PCT) {
    const addLo = lo > 0 ? buckets[lo - 1].volume : 0;
    const addHi = hi < VOLUME_BUCKETS - 1 ? buckets[hi + 1].volume : 0;
    if (addLo === 0 && addHi === 0) break;
    if (addHi >= addLo) { hi++; captured += addHi; }
    else { lo--; captured += addLo; }
  }
  const vah = buckets[hi].priceLevel + bucketSize / 2;
  const val = buckets[lo].priceLevel - bucketSize / 2;
  const maxVol = Math.max(...buckets.map(b => b.volume));

  return {
    profile: buckets.map((b, i) => ({
      ...b,
      normalizedVol: b.volume / maxVol,
      isPOC: i === pocIdx,
      isVAH: i === hi,
      isVAL: i === lo,
    })),
    poc, vah, val,
  };
}

function buildPrediction(
  candles: Candle[],
  poc: number, vah: number, val: number,
  currentPrice: number,
  tf: Timeframe,
  decimals: number,
): Prediction | null {
  if (!candles.length || !poc) return null;

  const recentCandles = candles.slice(-tf.lookback);
  const momentumCandles = recentCandles.slice(-tf.momentum);
  const upCount = momentumCandles.filter(c => c.close > c.open).length;
  const downCount = momentumCandles.length - upCount;

  const atr = recentCandles.reduce((s, c) => s + (c.high - c.low), 0) / recentCandles.length;
  const valueAreaWidth = vah - val;
  const distFromVAH = currentPrice - vah;
  const distFromVAL = val - currentPrice;
  const fmt = (n: number) => n.toFixed(decimals);

  let direction: "BULLISH" | "BEARISH", target: number,
    rangeLow: number, rangeHigh: number, confidence: number, reasoning: string;

  if (currentPrice > vah) {
    const strength = distFromVAH / valueAreaWidth;
    const momentum = upCount / momentumCandles.length;
    direction = "BULLISH";
    const proj = atr * tf.atrMult * (1 + strength * 0.5);
    target = currentPrice + proj;
    rangeLow = currentPrice + proj * 0.5;
    rangeHigh = currentPrice + proj * 1.8;
    confidence = Math.min(95, Math.round(55 + strength * 25 + momentum * 15));
    reasoning = `Price broke above VAH (${fmt(vah)}). Momentum breakout — targeting ${fmt(proj)} pts higher.`;
  } else if (currentPrice < val) {
    const strength = distFromVAL / valueAreaWidth;
    const momentum = downCount / momentumCandles.length;
    direction = "BEARISH";
    const proj = atr * tf.atrMult * (1 + strength * 0.5);
    target = currentPrice - proj;
    rangeLow = currentPrice - proj * 1.8;
    rangeHigh = currentPrice - proj * 0.5;
    confidence = Math.min(95, Math.round(55 + strength * 25 + momentum * 15));
    reasoning = `Price broke below VAL (${fmt(val)}). Bearish breakdown — targeting ${fmt(proj)} pts lower.`;
  } else {
    const posInVA = (currentPrice - val) / valueAreaWidth;
    const momentumThreshold = Math.max(3, Math.round(tf.momentum * 0.5));
    if (upCount >= momentumThreshold) {
      direction = "BULLISH";
      target = vah + atr * tf.atrMult * 0.5;
      rangeLow = poc;
      rangeHigh = vah + atr * tf.atrMult;
      confidence = Math.round(40 + (upCount / momentumCandles.length) * 20);
      reasoning = `Price inside Value Area, bullish bias. Target: test VAH (${fmt(vah)}).`;
    } else if (downCount >= momentumThreshold) {
      direction = "BEARISH";
      target = val - atr * tf.atrMult * 0.5;
      rangeLow = val - atr * tf.atrMult;
      rangeHigh = poc;
      confidence = Math.round(40 + (downCount / momentumCandles.length) * 20);
      reasoning = `Price inside Value Area, bearish bias. Target: test VAL (${fmt(val)}).`;
    } else {
      direction = posInVA > 0.5 ? "BEARISH" : "BULLISH";
      target = poc;
      rangeLow = val;
      rangeHigh = vah;
      confidence = 35;
      reasoning = `No clear momentum inside Value Area. POC magnet at ${fmt(poc)}.`;
    }
  }

  return { direction, target, rangeLow, rangeHigh, confidence, reasoning };
}

// ─── FETCH DATA ───────────────────────────────────────────────────────────────
async function fetchTradingViewData(pair: Pair): Promise<{ candles: Candle[]; source: string }> {
  const params = new URLSearchParams({ symbol: pair.symbol, tv: pair.tv });
  const res = await fetch(`/api/candles?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error);

  return {
    source: json.source ?? "tradingview",
    candles: (json.candles as Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>)
      .map(c => ({
        time: new Date(c.timestamp * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
        timestamp: c.timestamp,
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      })),
  };
}

async function fetchYahooData(pair: Pair): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const period1 = Math.floor(midnight.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pair.yahoo}?interval=1m&period1=${period1}&period2=${now}`;
  const res = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("No Yahoo data");
  const timestamps: number[] = result.timestamp;
  const q = result.indicators.quote[0];
  return timestamps.map((t, i) => ({
    time: new Date(t * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    timestamp: t,
    open: +q.open[i]?.toFixed(pair.decimals) || 0,
    high: +q.high[i]?.toFixed(pair.decimals) || 0,
    low: +q.low[i]?.toFixed(pair.decimals) || 0,
    close: +q.close[i]?.toFixed(pair.decimals) || 0,
    volume: q.volume[i] || 0,
  })).filter(c => c.open && c.high && c.low && c.close);
}

function generateDemoData(pair: Pair): Candle[] {
  const candles: Candle[] = [];
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  let price = pair.base as number;
  const totalMinutes = Math.min(Math.floor((now.getTime() - start.getTime()) / 60_000), 390);
  for (let i = 0; i < totalMinutes; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    const d = pair.drift as number;
    const r = pair.range as number;
    const open = price;
    const close = +(price + (Math.random() - 0.495) * d).toFixed(pair.decimals);
    const high = +(Math.max(open, close) + Math.random() * r).toFixed(pair.decimals);
    const low = +(Math.min(open, close) - Math.random() * r).toFixed(pair.decimals);
    candles.push({
      time: t.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      timestamp: t.getTime() / 1000,
      open, high, low, close,
      volume: Math.floor(Math.random() * 800 + 200),
    });
    price = close;
  }
  return candles;
}

// ─── SHARED STYLE HELPERS ─────────────────────────────────────────────────────
const pillBase: React.CSSProperties = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 11,
  fontWeight: 600,
  padding: "5px 12px",
  borderRadius: 6,
  cursor: "pointer",
  border: "1px solid transparent",
  letterSpacing: "0.5px",
  transition: "background 0.15s, border-color 0.15s, color 0.15s",
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
/** Convert "HH:MM" to a unix timestamp using today's date. */
function anchorToTimestamp(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime() / 1000;
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function Predictor() {
  const [pairIdx, setPairIdx] = useState(0);
  const [tfIdx, setTfIdx] = useState(0);
  const [anchorTime, setAnchorTime] = useState("00:00");
  const [anchorInput, setAnchorInput] = useState("00:00"); // controlled input value
  const [candles, setCandles] = useState<Candle[]>([]);
  const [profile, setProfile] = useState<Bucket[]>([]);
  const [poc, setPoc] = useState(0);
  const [vah, setVah] = useState(0);
  const [val, setVal] = useState(0);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [dataSource, setDataSource] = useState("—");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [nextRefresh, setNextRefresh] = useState(60);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pair = PAIRS[pairIdx];
  const tf = TIMEFRAMES[tfIdx];

  // ── Fetch raw candles (no profile logic here) ──────────────────────────────
  const loadData = useCallback(async () => {
    const currentPair = PAIRS[pairIdx];
    setLoading(true);
    setError(null);
    try {
      let data: Candle[];
      try {
        const result = await fetchTradingViewData(currentPair);
        if (result.candles.length < 5) throw new Error("Insufficient data");
        data = result.candles;
        setIsDemo(false);
        setDataSource(result.source);
      } catch (e1) {
        console.warn("TradingView failed:", (e1 as Error).message);
        try {
          data = await fetchYahooData(currentPair);
          if (data.length < 5) throw new Error("Insufficient data");
          setIsDemo(false);
          setDataSource("yahoo");
        } catch (e2) {
          console.warn("Yahoo failed:", (e2 as Error).message);
          data = generateDemoData(currentPair);
          setIsDemo(true);
          setDataSource("demo");
        }
      }
      setCandles(data);
      setLastUpdate(new Date());
      setNextRefresh(60);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairIdx]);

  // ── Recompute profile + prediction whenever candles, anchor, or tf change ──
  useEffect(() => {
    if (!candles.length) return;
    const cutoff = anchorToTimestamp(anchorTime);
    const anchored = candles.filter(c => c.timestamp >= cutoff);
    if (!anchored.length) return;
    const { profile: vp, poc: p, vah: vh, val: vl } = buildVolumeProfile(anchored);
    setProfile(vp);
    setPoc(p); setVah(vh); setVal(vl);
    const curr = anchored[anchored.length - 1]?.close || p;
    setPrediction(buildPrediction(anchored, p, vh, vl, curr, TIMEFRAMES[tfIdx], PAIRS[pairIdx].decimals));
  }, [candles, anchorTime, tfIdx, pairIdx]);

  // ── Reset data + fetch when pair changes ───────────────────────────────────
  useEffect(() => {
    setCandles([]); setProfile([]); setPoc(0); setVah(0); setVal(0); setPrediction(null);
    loadData();
  }, [loadData]);

  // Auto-refresh timer.
  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(loadData, REFRESH_INTERVAL);
      countdownRef.current = setInterval(() => setNextRefresh(p => p <= 1 ? 60 : p - 1), 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, loadData]);

  const currentPrice = candles[candles.length - 1]?.close || 0;
  const prevPrice = candles[candles.length - 2]?.close || 0;
  const priceChange = currentPrice - prevPrice;
  const displayCandles = candles.slice(-80);
  const fmt = (n: number) => n.toFixed(pair.decimals);

  const priceMin = displayCandles.length ? Math.min(...displayCandles.map(c => c.low)) * 0.9998 : 0;
  const priceMax = displayCandles.length ? Math.max(...displayCandles.map(c => c.high)) * 1.0002 : 0;

  const chartData = displayCandles.map(c => ({
    ...c,
    priceRange: [c.low, c.high],
    bodyRange: [Math.min(c.open, c.close), Math.max(c.open, c.close)],
  }));

  // Find the candle in displayCandles closest to the anchor timestamp,
  // used to draw a vertical reference line on the chart.
  const anchorTs = anchorToTimestamp(anchorTime);
  const anchorCandle = displayCandles.find(c => c.timestamp >= anchorTs);
  const anchorXValue = anchorCandle?.time ?? null;

  // Tick formatter — show fewer decimals on the Y-axis to save space.
  const tickDecimals = pair.decimals <= 3 ? pair.decimals : pair.decimals - 1;
  const yTickFmt = (v: number) => v.toFixed(tickDecimals);

  return (
    <div style={{ background: "#090e1a", minHeight: "100vh", fontFamily: "'IBM Plex Mono', monospace", color: "#e2e8f0" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Syne:wght@700;800&display=swap" rel="stylesheet" />

      {/* ── HEADER ── */}
      <div style={{
        background: "linear-gradient(135deg, #0d1526 0%, #111827 100%)",
        borderBottom: "1px solid #1e2d4a",
        padding: "14px 24px",
        display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ background: "linear-gradient(135deg, #c9a227, #f5c842)", borderRadius: 8, padding: "6px 10px", fontSize: 18 }}>⚖</div>
          <div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 20, fontWeight: 800, color: "#f5c842", letterSpacing: "-0.5px" }}>
              {pair.label} · APEX
            </div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "2px", textTransform: "uppercase" }}>
              Volume Profile Predictor · 1M → {tf.label}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {currentPrice > 0 && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 26, fontWeight: 800, color: priceChange >= 0 ? "#00e5a0" : "#ff4d6d", lineHeight: 1 }}>
                {fmt(currentPrice)}
              </div>
              <div style={{ fontSize: 11, color: priceChange >= 0 ? "#00e5a0" : "#ff4d6d" }}>
                {priceChange >= 0 ? "▲" : "▼"} {Math.abs(priceChange).toFixed(pair.decimals)}
              </div>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={loadData} disabled={loading} style={{
                ...pillBase,
                background: loading ? "#1e2d4a" : "linear-gradient(135deg, #c9a227, #f5c842)",
                color: loading ? "#64748b" : "#0d1526",
                cursor: loading ? "not-allowed" : "pointer",
              }}>
                {loading ? "LOADING..." : "↻ REFRESH"}
              </button>
              <button onClick={() => setAutoRefresh(a => !a)} style={{
                ...pillBase,
                background: autoRefresh ? "#0f2d1a" : "#1a0f0f",
                border: `1px solid ${autoRefresh ? "#00e5a0" : "#ff4d6d"}`,
                color: autoRefresh ? "#00e5a0" : "#ff4d6d",
              }}>
                AUTO {autoRefresh ? "ON" : "OFF"}
              </button>
            </div>
            {autoRefresh && <div style={{ fontSize: 10, color: "#475569" }}>Next refresh in {nextRefresh}s</div>}
          </div>
        </div>
      </div>

      {/* ── STATUS BADGES ── */}
      {isDemo && (
        <div style={{ background: "#1a1500", borderBottom: "1px solid #c9a22740", padding: "6px 24px", fontSize: 11, color: "#c9a227", letterSpacing: "1px" }}>
          ⚡ DEMO MODE — TradingView and Yahoo Finance both unavailable. Showing simulated {pair.label} data.
        </div>
      )}
      {error && !isDemo && (
        <div style={{ background: "#1a0010", padding: "6px 24px", fontSize: 11, color: "#ff4d6d" }}>⚠ {error}</div>
      )}

      <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 16 }}>

        {/* ── SELECTORS ROW ── */}
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>

          {/* Pair selector */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 9, color: "#475569", letterSpacing: "2px" }}>INSTRUMENT</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {PAIRS.map((p, i) => (
                <button
                  key={p.symbol}
                  onClick={() => setPairIdx(i)}
                  style={{
                    ...pillBase,
                    background: i === pairIdx ? "#c9a22720" : "#0d1526",
                    border: `1px solid ${i === pairIdx ? "#c9a227" : "#1e2d4a"}`,
                    color: i === pairIdx ? "#f5c842" : "#64748b",
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div style={{ width: 1, height: 40, background: "#1e2d4a", flexShrink: 0 }} />

          {/* Timeframe selector */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 9, color: "#475569", letterSpacing: "2px" }}>PREDICTION HORIZON</div>
            <div style={{ display: "flex", gap: 4 }}>
              {TIMEFRAMES.map((t, i) => (
                <button
                  key={t.label}
                  onClick={() => setTfIdx(i)}
                  style={{
                    ...pillBase,
                    background: i === tfIdx ? "#a78bfa20" : "#0d1526",
                    border: `1px solid ${i === tfIdx ? "#a78bfa" : "#1e2d4a"}`,
                    color: i === tfIdx ? "#a78bfa" : "#64748b",
                    minWidth: 44,
                    textAlign: "center",
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div style={{ width: 1, height: 40, background: "#1e2d4a", flexShrink: 0 }} />

          {/* Anchor time */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 9, color: "#475569", letterSpacing: "2px" }}>ANCHOR TIME (LOCAL)</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="time"
                value={anchorInput}
                onChange={e => setAnchorInput(e.target.value)}
                onBlur={() => setAnchorTime(anchorInput)}
                onKeyDown={e => { if (e.key === "Enter") setAnchorTime(anchorInput); }}
                style={{
                  background: "#0d1526",
                  border: `1px solid ${anchorTime !== "00:00" ? "#f5c842" : "#1e2d4a"}`,
                  borderRadius: 6,
                  color: anchorTime !== "00:00" ? "#f5c842" : "#94a3b8",
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "5px 10px",
                  cursor: "pointer",
                  outline: "none",
                  letterSpacing: "1px",
                  colorScheme: "dark",
                }}
              />
              {anchorTime !== "00:00" && (
                <button
                  onClick={() => { setAnchorTime("00:00"); setAnchorInput("00:00"); }}
                  title="Reset to session open"
                  style={{
                    ...pillBase,
                    background: "#1e2d4a",
                    color: "#64748b",
                    padding: "5px 8px",
                    fontSize: 12,
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            <div style={{ fontSize: 9, color: "#334155" }}>
              {anchorTime !== "00:00"
                ? `Profile anchored from ${anchorTime} · ${candles.filter(c => c.timestamp >= anchorTs).length} candles`
                : "Session open (00:00)"}
            </div>
          </div>
        </div>

        {/* ── KEY LEVELS ── */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "VAH",    value: vah,       color: "#00e5a0", sub: "Value Area High" },
            { label: "POC",    value: poc,       color: "#f5c842", sub: "Point of Control" },
            { label: "VAL",    value: val,       color: "#ff4d6d", sub: "Value Area Low" },
            { label: "SPREAD", value: vah - val, color: "#a78bfa", sub: "Value Area Width" },
          ].map(({ label, value, color, sub }) => (
            <div key={label} style={{
              flex: "1 1 130px",
              background: "#0d1526",
              border: `1px solid ${color}22`,
              borderLeft: `3px solid ${color}`,
              borderRadius: 8,
              padding: "10px 14px",
            }}>
              <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "2px" }}>{label}</div>
              <div style={{ fontSize: 18, fontWeight: 600, color, marginTop: 2 }}>
                {value ? fmt(value) : "—"}
              </div>
              <div style={{ fontSize: 9, color: "#475569", marginTop: 2 }}>{sub}</div>
            </div>
          ))}
        </div>

        {/* ── CHARTS ROW ── */}
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>

          {/* PRICE CHART */}
          <div style={{ flex: 3, background: "#0d1526", border: "1px solid #1e2d4a", borderRadius: 12, padding: "16px" }}>
            <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "2px", marginBottom: 12 }}>
              {pair.label} · 1M · ANCHORED FROM {anchorTime.toUpperCase()}
              {anchorTime !== "00:00" && (
                <span style={{ color: "#f5c842", marginLeft: 8 }}>⚓</span>
              )}
            </div>
            {displayCandles.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 68 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2d4a" />
                  <XAxis
                    dataKey="time"
                    tick={{ fill: "#475569", fontSize: 9, fontFamily: "IBM Plex Mono" }}
                    tickLine={false}
                    interval={Math.floor(displayCandles.length / 8)}
                  />
                  <YAxis
                    domain={[priceMin, priceMax]}
                    tick={{ fill: "#475569", fontSize: 9, fontFamily: "IBM Plex Mono" }}
                    tickLine={false}
                    tickFormatter={yTickFmt}
                    width={65}
                  />
                  <Tooltip
                    content={(props) => {
                      const payload = props.payload as unknown as Array<{ payload: Candle }> | undefined;
                      const label = props.label as string | undefined;
                      if (!payload?.length) return null;
                      const d = payload[0]?.payload;
                      if (!d) return null;
                      const bull = d.close >= d.open;
                      return (
                        <div style={{ background: "#0d1526", border: "1px solid #1e2d4a", borderRadius: 8, padding: "10px 14px", fontSize: 11 }}>
                          <div style={{ color: "#f5c842", marginBottom: 6 }}>{label}</div>
                          {(["O", "H", "L", "C"] as const).map((k, idx) => {
                            const v = [d.open, d.high, d.low, d.close][idx];
                            return <div key={k} style={{ color: bull ? "#00e5a0" : "#ff4d6d" }}>{k}: {v?.toFixed(pair.decimals)}</div>;
                          })}
                          <div style={{ color: "#64748b" }}>Vol: {d.volume?.toLocaleString()}</div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="priceRange" fill="transparent" isAnimationActive={false}>
                    {chartData.map((e, i) => (
                      <Cell key={i} stroke={e.close >= e.open ? "#00e5a0" : "#ff4d6d"} strokeWidth={1} fill="transparent" />
                    ))}
                  </Bar>
                  <Bar dataKey="bodyRange" isAnimationActive={false} radius={[1, 1, 1, 1]}>
                    {chartData.map((e, i) => (
                      <Cell key={i} fill={e.close >= e.open ? "#00e5a022" : "#ff4d6d22"} stroke={e.close >= e.open ? "#00e5a0" : "#ff4d6d"} strokeWidth={1} />
                    ))}
                  </Bar>
                  <Line dataKey="close" dot={false} stroke="#f5c84260" strokeWidth={1} isAnimationActive={false} />
                  {vah > 0 && <ReferenceLine y={vah} stroke="#00e5a0" strokeDasharray="5 3" strokeWidth={1.5} label={{ value: `VAH ${fmt(vah)}`, fill: "#00e5a0", fontSize: 9, position: "insideLeft" }} />}
                  {poc > 0 && <ReferenceLine y={poc} stroke="#f5c842" strokeDasharray="8 3" strokeWidth={2}   label={{ value: `POC ${fmt(poc)}`, fill: "#f5c842", fontSize: 9, position: "insideLeft" }} />}
                  {val > 0 && <ReferenceLine y={val} stroke="#ff4d6d" strokeDasharray="5 3" strokeWidth={1.5} label={{ value: `VAL ${fmt(val)}`, fill: "#ff4d6d", fontSize: 9, position: "insideLeft" }} />}
                  {prediction?.target && prediction.target > 0 && (
                    <ReferenceLine y={prediction.target} stroke="#a78bfa" strokeDasharray="4 4" strokeWidth={1}
                      label={{ value: `TARGET ${fmt(prediction.target)}`, fill: "#a78bfa", fontSize: 9, position: "insideRight" }} />
                  )}
                  {/* Vertical anchor line */}
                  {anchorXValue && anchorTime !== "00:00" && (
                    <ReferenceLine x={anchorXValue} stroke="#f5c842" strokeDasharray="3 3" strokeWidth={1.5}
                      label={{ value: `⚓ ${anchorTime}`, fill: "#f5c842", fontSize: 9, position: "insideTopRight" }} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: 320, display: "flex", alignItems: "center", justifyContent: "center", color: "#475569" }}>
                {loading ? "Loading price data..." : "No data"}
              </div>
            )}
          </div>

          {/* VOLUME PROFILE */}
          <div style={{ flex: 1, background: "#0d1526", border: "1px solid #1e2d4a", borderRadius: 12, padding: "16px", minWidth: 130 }}>
            <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "2px", marginBottom: 12 }}>VOL PROFILE</div>
            {profile.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={[...profile].reverse()} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }} barCategoryGap={1}>
                  <XAxis type="number" hide />
                  <YAxis dataKey="priceLevel" type="number" domain={[priceMin, priceMax]} hide />
                  <Bar dataKey="normalizedVol" isAnimationActive={false} radius={[0, 2, 2, 0]}>
                    {[...profile].reverse().map((e, i) => (
                      <Cell key={i} fill={e.isPOC ? "#f5c842" : e.isVAH ? "#00e5a0" : e.isVAL ? "#ff4d6d" : "#1e3a5f"} opacity={e.isPOC ? 1 : 0.75} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: 320, display: "flex", alignItems: "center", justifyContent: "center", color: "#475569", fontSize: 11 }}>
                {loading ? "..." : "No data"}
              </div>
            )}
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {[["#f5c842", "POC"], ["#00e5a0", "VAH"], ["#ff4d6d", "VAL"], ["#1e3a5f", "Volume"]].map(([color, label]) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "#64748b" }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
                  {label}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── PREDICTION PANEL ── */}
        {prediction && (
          <div style={{
            background: prediction.direction === "BULLISH" ? "linear-gradient(135deg, #0a1f12, #0d1526)" : "linear-gradient(135deg, #1f0a0f, #0d1526)",
            border: `1px solid ${prediction.direction === "BULLISH" ? "#00e5a040" : "#ff4d6d40"}`,
            borderRadius: 12,
            padding: "18px 22px",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
              <div>
                <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "2px" }}>{tf.display} PREDICTION · {pair.label}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
                  <div style={{
                    background: prediction.direction === "BULLISH" ? "#00e5a020" : "#ff4d6d20",
                    border: `1px solid ${prediction.direction === "BULLISH" ? "#00e5a0" : "#ff4d6d"}`,
                    borderRadius: 6, padding: "4px 14px",
                    color: prediction.direction === "BULLISH" ? "#00e5a0" : "#ff4d6d",
                    fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 22, letterSpacing: "2px",
                  }}>
                    {prediction.direction === "BULLISH" ? "▲" : "▼"} {prediction.direction}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8, maxWidth: 420 }}>
                  {prediction.reasoning}
                </div>
              </div>

              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "2px" }}>TARGET</div>
                  <div style={{ fontSize: 22, fontWeight: 600, color: "#a78bfa", marginTop: 2 }}>{fmt(prediction.target)}</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "2px" }}>RANGE</div>
                  <div style={{ fontSize: 13, marginTop: 2 }}>
                    <span style={{ color: "#ff4d6d" }}>{fmt(prediction.rangeLow)}</span>
                    <span style={{ color: "#475569", margin: "0 4px" }}>–</span>
                    <span style={{ color: "#00e5a0" }}>{fmt(prediction.rangeHigh)}</span>
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "2px" }}>CONFIDENCE</div>
                  <div style={{ marginTop: 6 }}>
                    <svg width={70} height={70} viewBox="0 0 70 70">
                      <circle cx={35} cy={35} r={28} fill="none" stroke="#1e2d4a" strokeWidth={6} />
                      <circle cx={35} cy={35} r={28} fill="none"
                        stroke={prediction.confidence >= 70 ? "#00e5a0" : prediction.confidence >= 50 ? "#f5c842" : "#ff4d6d"}
                        strokeWidth={6}
                        strokeDasharray={`${(prediction.confidence / 100) * 175.9} 175.9`}
                        strokeLinecap="round"
                        transform="rotate(-90 35 35)"
                        style={{ transition: "stroke-dasharray 1s ease" }}
                      />
                      <text x={35} y={39} textAnchor="middle" fill="#e2e8f0" fontSize={13} fontWeight="600" fontFamily="IBM Plex Mono">
                        {prediction.confidence}%
                      </text>
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── FOOTER ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10, color: "#334155", padding: "0 4px" }}>
          <span>Anchored Volume Profile · Value Area 70% · Momentum Breakout Logic</span>
          <span>
            {lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : "—"}
            {" · "}{candles.length} candles · {dataSource.toUpperCase()}
          </span>
        </div>
      </div>
    </div>
  );
}
