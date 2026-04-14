import { NextRequest, NextResponse } from "next/server";
import { chromium } from "playwright";

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── PER-SYMBOL CACHE (TTL = 60 s) ───────────────────────────────────────────
const cache = new Map<string, { bars: Bar[]; ts: number }>();
const CACHE_TTL = 60_000;

// ─── TRADINGVIEW PROTOCOL PARSER ──────────────────────────────────────────────
function parseTVFrames(raw: string): unknown[] {
  const out: unknown[] = [];
  const re = /~m~(\d+)~m~/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const len = parseInt(match[1], 10);
    const start = match.index + match[0].length;
    const content = raw.slice(start, start + len);
    try { out.push(JSON.parse(content)); } catch { /* heartbeat */ }
  }
  return out;
}

function extractBars(msg: unknown): Bar[] {
  const bars: Bar[] = [];
  const m = msg as { m?: string; p?: unknown[] };
  if (m.m !== "timescale_update" && m.m !== "du") return bars;
  const seriesMap = m.p?.[1] as
    | Record<string, { s?: Array<{ v: number[] }> }>
    | undefined;
  if (!seriesMap) return bars;
  for (const key of Object.keys(seriesMap)) {
    const series = seriesMap[key];
    if (!Array.isArray(series?.s)) continue;
    for (const bar of series.s) {
      const [t, o, h, l, c, v] = bar.v;
      if (t && o && h && l && c)
        bars.push({ timestamp: t, open: o, high: h, low: l, close: c, volume: v || 0 });
    }
  }
  return bars;
}

// ─── PLAYWRIGHT SCRAPER ───────────────────────────────────────────────────────
async function fetchFromTradingView(tvSymbol: string): Promise<Bar[]> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    const allBars: Bar[] = [];

    page.on("websocket", (ws) => {
      if (!ws.url().includes("tradingview.com")) return;
      ws.on("framereceived", (event) => {
        const payload = typeof event.payload === "string" ? event.payload : "";
        for (const msg of parseTVFrames(payload))
          allBars.push(...extractBars(msg));
      });
    });

    const encodedSymbol = encodeURIComponent(tvSymbol);
    await page.goto(
      `https://www.tradingview.com/chart/?symbol=${encodedSymbol}&interval=1`,
      { waitUntil: "domcontentloaded", timeout: 30_000 }
    );

    // Resolve once we have enough bars or hit the hard timeout.
    await Promise.race([
      new Promise<void>((resolve) => {
        const id = setInterval(() => {
          if (allBars.length >= 120) { clearInterval(id); resolve(); }
        }, 400);
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
    ]);

    if (allBars.length < 5)
      throw new Error(`TradingView returned only ${allBars.length} bars for ${tvSymbol}`);

    // Deduplicate, sort, keep only today's bars.
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    const cutoff = todayMidnight.getTime() / 1000;

    return [...new Map(allBars.map((b) => [b.timestamp, b])).values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((b) => b.timestamp >= cutoff);
  } finally {
    await browser.close();
  }
}

// ─── ROUTE HANDLER ────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol") ?? "XAUUSD";
  const tvSymbol = searchParams.get("tv") ?? symbol;

  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL)
    return NextResponse.json({ candles: cached.bars, source: "cache" });

  try {
    const bars = await fetchFromTradingView(tvSymbol);
    cache.set(symbol, { bars, ts: Date.now() });
    return NextResponse.json({ candles: bars, source: "tradingview" });
  } catch (err) {
    if (cached)
      return NextResponse.json({
        candles: cached.bars,
        source: "stale-cache",
        warning: (err as Error).message,
      });
    return NextResponse.json({ error: (err as Error).message }, { status: 503 });
  }
}
