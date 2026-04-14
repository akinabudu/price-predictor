/**
 * APEX Volume Profile Strategy — 3-Month XAUUSD Backtest
 * Mirrors the Pine Script strategy and Next.js app logic exactly.
 * Run: node scripts/backtest.mjs
 */

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SYMBOL        = "GC=F";    // Gold Futures — continuous contract for XAUUSD
const INTERVAL      = "1h";      // 1-hour candles
const RANGE         = "6mo";     // ↑ extended to 6 months
const HORIZON       = "4H";      // ↑ switched to 4H (wider projections, fewer noise trades)
const BUCKETS       = 60;
const VA_PCT        = 0.70;
const SL_MULT       = 2.0;       // ↑ widened from 1.5 — stops were too tight
const EQUITY_START  = 10_000;
const RISK_PCT      = 0.01;      // 1% of equity risked per trade
const MIN_MOMENTUM  = 5;         // ↑ raised from 3 — stricter signal confirmation
const EMA_PERIOD    = 50;        // ← new: trend filter (long only above EMA, short only below)
const MIN_VA_WIDTH_PCT = 0.003;  // ← new: skip signal if value area < 0.3% of price (too tight)

// Timeframe params (mirrors TIMEFRAMES config in the app)
const TF = {
  "30M": { lookback: 30,  momentum: 10, atrMult: 2.0 },
  "1H":  { lookback: 60,  momentum: 20, atrMult: 3.0 },
  "4H":  { lookback: 240, momentum: 60, atrMult: 5.0 },
  "1D":  { lookback: 390, momentum: 90, atrMult: 8.0 },
};
const { lookback: LOOKBACK, momentum: MOMENTUM_N, atrMult: ATR_MULT } = TF[HORIZON];

// ─── EMA ──────────────────────────────────────────────────────────────────────
function calcEMASeries(candles, period) {
  const k   = 2 / (period + 1);
  const ema = new Float64Array(candles.length);
  ema[0] = candles[0].close;
  for (let i = 1; i < candles.length; i++)
    ema[i] = candles[i].close * k + ema[i - 1] * (1 - k);
  return ema;
}

// ─── FETCH DATA ───────────────────────────────────────────────────────────────
async function fetchCandles() {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}` +
              `?interval=${INTERVAL}&range=${RANGE}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      "Accept":     "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error("No chart data returned");

  const q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({
    ts:     t,
    date:   new Date(t * 1000),
    open:   +q.open[i]?.toFixed(2)   || null,
    high:   +q.high[i]?.toFixed(2)   || null,
    low:    +q.low[i]?.toFixed(2)    || null,
    close:  +q.close[i]?.toFixed(2)  || null,
    volume: q.volume[i] || 1,
  })).filter(c => c.open && c.high && c.low && c.close);
}

// ─── VOLUME PROFILE ───────────────────────────────────────────────────────────
function buildProfile(slice) {
  const prices  = slice.flatMap(c => [c.high, c.low]);
  const pMin    = Math.min(...prices);
  const pMax    = Math.max(...prices);
  const bSize   = (pMax - pMin) / BUCKETS;

  const vol = new Float64Array(BUCKETS);

  for (const c of slice) {
    const cVol   = c.volume || 1;
    const nTicks = Math.max(1, Math.round((c.high - c.low) / bSize));
    const step   = (c.high - c.low) / nTicks;
    for (let j = 0; j <= nTicks; j++) {
      const p   = c.low + j * step;
      const idx = Math.min(Math.floor((p - pMin) / bSize), BUCKETS - 1);
      if (idx >= 0) vol[idx] += cVol / (nTicks + 1);
    }
  }

  // POC
  let pocIdx = 0;
  for (let i = 1; i < BUCKETS; i++) if (vol[i] > vol[pocIdx]) pocIdx = i;
  const poc = pMin + (pocIdx + 0.5) * bSize;

  // VAH / VAL
  const totalVol = vol.reduce((s, v) => s + v, 0);
  let captured = vol[pocIdx];
  let lo = pocIdx, hi = pocIdx;
  while (captured / totalVol < VA_PCT) {
    const addLo = lo > 0            ? vol[lo - 1] : 0;
    const addHi = hi < BUCKETS - 1  ? vol[hi + 1] : 0;
    if (addLo === 0 && addHi === 0) break;
    if (addHi >= addLo) { hi++; captured += addHi; }
    else                { lo--; captured += addLo; }
  }
  const vah = pMin + (hi + 1) * bSize;
  const val = pMin + lo       * bSize;

  return { poc, vah, val };
}

// ─── ATR (simple average true range) ─────────────────────────────────────────
function calcATR(slice) {
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low  - slice[i - 1].close),
    );
    sum += tr;
  }
  return sum / (slice.length - 1);
}

// ─── STRATEGY ENGINE ──────────────────────────────────────────────────────────
function runBacktest(candles, emaArr) {
  const trades  = [];
  let   equity  = EQUITY_START;
  const equityCurve = [{ date: candles[LOOKBACK].date, equity }];

  // Position state
  let pos = null; // { type: 'long'|'short', entry, sl, tp, entryDate, entryIdx }

  for (let i = LOOKBACK; i < candles.length; i++) {
    const bar    = candles[i];
    const slice  = candles.slice(i - LOOKBACK, i);
    const { poc, vah, val } = buildProfile(slice);
    const atr     = calcATR(slice);
    const vaWidth = Math.max(vah - val, 1e-10);
    const ema     = emaArr[i];

    // ── Filter 1: value area must be wide enough to be meaningful ────────────
    if (vaWidth / bar.close < MIN_VA_WIDTH_PCT) continue;

    // Momentum
    const mSlice = slice.slice(-MOMENTUM_N);
    let upCount = 0, downCount = 0;
    for (const c of mSlice) { if (c.close > c.open) upCount++; else downCount++; }

    // Signal cases
    const distVAH = bar.close - vah;
    const distVAL = val - bar.close;

    let signal = null;   // 'long' | 'short' | null
    let target = null;

    if (bar.close > vah && upCount >= MIN_MOMENTUM) {
      // Case 1: Breakout above VAH — only if price is above EMA (trending up)
      if (bar.close >= ema) {
        const strength = distVAH / vaWidth;
        const proj = atr * ATR_MULT * (1 + strength * 0.5);
        signal = "long";
        target = bar.close + proj;
      }
    } else if (bar.close < val && downCount >= MIN_MOMENTUM) {
      // Case 2: Breakdown below VAL — only if price is below EMA (trending down)
      if (bar.close <= ema) {
        const strength = distVAL / vaWidth;
        const proj = atr * ATR_MULT * (1 + strength * 0.5);
        signal = "short";
        target = bar.close - proj;
      }
    } else if (bar.close >= val && bar.close <= vah) {
      // Case 3: Inside value area — must align with EMA trend
      const thr = Math.max(3, Math.round(MOMENTUM_N * 0.5));
      if (upCount >= thr && bar.close >= ema) {
        signal = "long";
        target = vah + atr * ATR_MULT * 0.5;
      } else if (downCount >= thr && bar.close <= ema) {
        signal = "short";
        target = val - atr * ATR_MULT * 0.5;
      }
    }

    // ── Check open position for SL / TP hit ──────────────────────────────────
    if (pos) {
      let closed = false;
      let exitPrice = null;
      let exitReason = null;

      if (pos.type === "long") {
        if (bar.low <= pos.sl) {
          exitPrice  = pos.sl;
          exitReason = "SL";
          closed     = true;
        } else if (bar.high >= pos.tp) {
          exitPrice  = pos.tp;
          exitReason = "TP";
          closed     = true;
        }
      } else {
        if (bar.high >= pos.sl) {
          exitPrice  = pos.sl;
          exitReason = "SL";
          closed     = true;
        } else if (bar.low <= pos.tp) {
          exitPrice  = pos.tp;
          exitReason = "TP";
          closed     = true;
        }
      }

      if (closed) {
        const pnlPts = pos.type === "long"
          ? exitPrice - pos.entry
          : pos.entry - exitPrice;
        // Position size: risk 1% of equity over SL distance
        const slDist  = Math.abs(pos.entry - pos.sl);
        const size    = (equity * RISK_PCT) / slDist;
        const pnlUSD  = pnlPts * size;
        equity       += pnlUSD;

        trades.push({
          type:      pos.type,
          entry:     pos.entry,
          exit:      exitPrice,
          sl:        pos.sl,
          tp:        pos.tp,
          exitReason,
          pnlPts,
          pnlUSD,
          entryDate: pos.entryDate,
          exitDate:  bar.date,
          durationH: (bar.ts - pos.entryTs) / 3600,
        });

        equityCurve.push({ date: bar.date, equity });
        pos = null;
      }
    }

    // ── Open new position on signal transition (only if flat) ────────────────
    if (!pos && signal) {
      const prevSlice  = candles.slice(i - LOOKBACK - 1, i - 1);
      // Only enter on first bar of a new signal
      let prevSignal = null;
      if (prevSlice.length >= LOOKBACK) {
        const { vah: pVAH, val: pVAL } = buildProfile(prevSlice.slice(-LOOKBACK));
        const pBar = candles[i - 1];
        const pMom = prevSlice.slice(-MOMENTUM_N);
        let pUp = 0, pDown = 0;
        for (const c of pMom) { if (c.close > c.open) pUp++; else pDown++; }
        if      (pBar.close > pVAH && pUp   >= MIN_MOMENTUM) prevSignal = "long";
        else if (pBar.close < pVAL && pDown >= MIN_MOMENTUM) prevSignal = "short";
        else {
          const thr = Math.max(3, Math.round(MOMENTUM_N * 0.5));
          if      (pUp   >= thr && pBar.close >= pVAL && pBar.close <= pVAH) prevSignal = "long";
          else if (pDown >= thr && pBar.close >= pVAL && pBar.close <= pVAH) prevSignal = "short";
        }
      }

      if (prevSignal !== signal) {
        const sl = signal === "long"
          ? bar.close - atr * SL_MULT
          : bar.close + atr * SL_MULT;
        // Sanity: TP must be on the correct side of entry
        const tpValid = signal === "long" ? target > bar.close : target < bar.close;
        if (tpValid) {
          pos = {
            type:      signal,
            entry:     bar.close,
            sl,
            tp:        target,
            entryDate: bar.date,
            entryTs:   bar.ts,
            entryIdx:  i,
          };
        }
      }
    }
  }

  return { trades, equityCurve, finalEquity: equity };
}

// ─── METRICS ──────────────────────────────────────────────────────────────────
function calcMetrics(trades, equityCurve) {
  if (!trades.length) return null;

  const wins   = trades.filter(t => t.pnlUSD > 0);
  const losses = trades.filter(t => t.pnlUSD <= 0);

  const grossProfit = wins.reduce((s, t)   => s + t.pnlUSD, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));

  // Max drawdown
  let peak = equityCurve[0].equity;
  let maxDD = 0;
  let maxDDPct = 0;
  for (const { equity } of equityCurve) {
    if (equity > peak) peak = equity;
    const dd    = peak - equity;
    const ddPct = dd / peak;
    if (ddPct > maxDDPct) { maxDD = dd; maxDDPct = ddPct; }
  }

  // Sharpe (annualised, using trade returns)
  const returns = trades.map(t => t.pnlUSD / EQUITY_START);
  const meanR   = returns.reduce((s, r) => s + r, 0) / returns.length;
  const stdR    = Math.sqrt(returns.reduce((s, r) => s + (r - meanR) ** 2, 0) / returns.length);
  // Approximate trades per year (252 trading days, avg trade duration)
  const avgDurH   = trades.reduce((s, t) => s + t.durationH, 0) / trades.length;
  const tradesPerYear = (252 * 23) / avgDurH;  // 23 trading hours/day for XAUUSD
  const sharpe    = stdR > 0 ? (meanR * tradesPerYear) / (stdR * Math.sqrt(tradesPerYear)) : 0;

  return {
    totalTrades:   trades.length,
    wins:          wins.length,
    losses:        losses.length,
    winRate:       wins.length / trades.length,
    grossProfit,
    grossLoss,
    profitFactor:  grossLoss > 0 ? grossProfit / grossLoss : Infinity,
    netProfit:     grossProfit - grossLoss,
    totalReturn:   (equityCurve.at(-1).equity - EQUITY_START) / EQUITY_START,
    maxDD,
    maxDDPct,
    avgWin:        wins.length   ? grossProfit / wins.length   : 0,
    avgLoss:       losses.length ? grossLoss   / losses.length : 0,
    largestWin:    wins.length   ? Math.max(...wins.map(t => t.pnlUSD))   : 0,
    largestLoss:   losses.length ? Math.max(...losses.map(t => -t.pnlUSD)): 0,
    avgDurationH: trades.reduce((s, t) => s + t.durationH, 0) / trades.length,
    sharpe,
    longTrades:    trades.filter(t => t.type === "long").length,
    shortTrades:   trades.filter(t => t.type === "short").length,
    tpHits:        trades.filter(t => t.exitReason === "TP").length,
    slHits:        trades.filter(t => t.exitReason === "SL").length,
  };
}

// ─── DISPLAY ──────────────────────────────────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  white:  "\x1b[37m",
  gray:   "\x1b[90m",
  bgGray: "\x1b[100m",
};

function color(val, good, bad, neutral = C.yellow) {
  if (val > 0) return good;
  if (val < 0) return bad;
  return neutral;
}

function pct(n)  { return (n * 100).toFixed(2) + "%"; }
function usd(n)  { return "$" + n.toFixed(2); }
function num(n)  { return n.toFixed(2); }
function hrs(n)  { return n.toFixed(1) + "h"; }

function row(label, value, clr = C.white) {
  const pad = " ".repeat(Math.max(0, 32 - label.length));
  console.log(`  ${C.gray}${label}${pad}${C.reset}${clr}${value}${C.reset}`);
}

function divider(title = "") {
  const line = "─".repeat(56);
  if (title) {
    const pad = Math.floor((56 - title.length - 2) / 2);
    console.log(`${C.gray}${"─".repeat(pad)} ${C.cyan}${C.bold}${title}${C.reset}${C.gray} ${"─".repeat(56 - pad - title.length - 2)}${C.reset}`);
  } else {
    console.log(`${C.gray}${line}${C.reset}`);
  }
}

function printEquityCurve(equityCurve) {
  const maxEq   = Math.max(...equityCurve.map(e => e.equity));
  const minEq   = Math.min(...equityCurve.map(e => e.equity));
  const range   = maxEq - minEq || 1;
  const HEIGHT  = 8;
  const WIDTH   = Math.min(60, equityCurve.length);
  const step    = Math.max(1, Math.floor(equityCurve.length / WIDTH));
  const sampled = equityCurve.filter((_, i) => i % step === 0);

  const grid = Array.from({ length: HEIGHT }, () => new Array(sampled.length).fill(" "));
  sampled.forEach(({ equity }, x) => {
    const y = Math.round(((equity - minEq) / range) * (HEIGHT - 1));
    grid[HEIGHT - 1 - y][x] = equity >= EQUITY_START ? "▪" : "·";
  });

  console.log(`\n  ${C.gray}$${usd(maxEq).padStart(9)}${C.reset}`);
  grid.forEach(line => {
    const row = line.map(c => c === "▪" ? `${C.green}▪${C.reset}` : c === "·" ? `${C.red}·${C.reset}` : " ").join("");
    console.log("  " + row);
  });
  console.log(`  ${C.gray}$${usd(minEq).padStart(9)}${C.reset}`);
  console.log(`  ${C.gray}Start: ${equityCurve[0].date.toLocaleDateString()}  →  End: ${equityCurve.at(-1).date.toLocaleDateString()}${C.reset}`);
}

function printMonthlyBreakdown(trades) {
  const byMonth = {};
  for (const t of trades) {
    const key = t.exitDate.toISOString().slice(0, 7);
    if (!byMonth[key]) byMonth[key] = { pnl: 0, wins: 0, total: 0 };
    byMonth[key].pnl   += t.pnlUSD;
    byMonth[key].wins  += t.pnlUSD > 0 ? 1 : 0;
    byMonth[key].total += 1;
  }
  for (const [month, { pnl, wins, total }] of Object.entries(byMonth).sort()) {
    const bar = pnl >= 0
      ? C.green + "█".repeat(Math.min(20, Math.round(pnl / 50)))   + C.reset
      : C.red   + "█".repeat(Math.min(20, Math.round(-pnl / 50)))  + C.reset;
    const wr = pct(wins / total);
    console.log(`  ${C.gray}${month}${C.reset}  ${(pnl >= 0 ? C.green : C.red) + usd(pnl).padStart(9) + C.reset}  ${bar}  ${C.gray}${total} trades, WR ${wr}${C.reset}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n${C.bold}${C.yellow}  ⚖  APEX · Volume Profile Strategy — Backtest v2 (Improved)${C.reset}`);
  console.log(`${C.gray}  Instrument: XAUUSD  |  Horizon: ${HORIZON}  |  Period: 6 months  |  Candles: ${INTERVAL}${C.reset}`);
  console.log(`${C.gray}  Improvements: SL ${SL_MULT}×ATR · EMA-${EMA_PERIOD} trend filter · Min momentum ${MIN_MOMENTUM} · VA width filter${C.reset}\n`);

  process.stdout.write(`  ${C.gray}Fetching data from Yahoo Finance...${C.reset}`);
  let candles;
  try {
    candles = await fetchCandles();
    console.log(` ${C.green}${candles.length} bars loaded${C.reset}`);
  } catch (e) {
    console.log(` ${C.red}FAILED: ${e.message}${C.reset}`);
    process.exit(1);
  }

  const fromDate = candles[0].date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const toDate   = candles.at(-1).date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  console.log(`  ${C.gray}Date range: ${fromDate} → ${toDate}${C.reset}`);
  console.log(`  ${C.gray}Parameters: lookback=${LOOKBACK}, momentum=${MOMENTUM_N}, ATR×${ATR_MULT}, SL×${SL_MULT}${C.reset}\n`);

  process.stdout.write(`  ${C.gray}Running strategy simulation...${C.reset}`);
  const emaArr = calcEMASeries(candles, EMA_PERIOD);
  const { trades, equityCurve, finalEquity } = runBacktest(candles, emaArr);
  console.log(` ${C.green}done${C.reset} (${trades.length} trades)\n`);

  const m = calcMetrics(trades, equityCurve);
  if (!m) { console.log(`${C.red}  No trades generated.${C.reset}\n`); process.exit(0); }

  // ── Summary ────────────────────────────────────────────────────────────────
  divider("PERFORMANCE SUMMARY");
  row("Net Profit",           usd(m.netProfit),            color(m.netProfit, C.green, C.red));
  row("Total Return",         pct(m.totalReturn),          color(m.totalReturn, C.green, C.red));
  row("Final Equity",         usd(finalEquity),            finalEquity >= EQUITY_START ? C.green : C.red);
  row("Max Drawdown",        `-${usd(m.maxDD)} (${pct(m.maxDDPct)})`, C.red);
  row("Profit Factor",        num(m.profitFactor),         m.profitFactor >= 1.5 ? C.green : m.profitFactor >= 1 ? C.yellow : C.red);
  row("Sharpe Ratio",         num(m.sharpe),               m.sharpe >= 1 ? C.green : m.sharpe >= 0 ? C.yellow : C.red);

  divider("TRADES");
  row("Total Trades",         m.totalTrades.toString(),    C.white);
  row("Long / Short",         `${m.longTrades} / ${m.shortTrades}`, C.white);
  row("TP Hits / SL Hits",    `${m.tpHits} / ${m.slHits}`,C.white);
  row("Win Rate",             pct(m.winRate),              m.winRate >= 0.5 ? C.green : C.yellow);
  row("Wins / Losses",        `${m.wins} / ${m.losses}`,  C.white);

  divider("RISK / REWARD");
  row("Gross Profit",         usd(m.grossProfit),          C.green);
  row("Gross Loss",           usd(m.grossLoss),            C.red);
  row("Avg Win",              usd(m.avgWin),               C.green);
  row("Avg Loss",             usd(m.avgLoss),              C.red);
  row("Largest Win",          usd(m.largestWin),           C.green);
  row("Largest Loss",         usd(m.largestLoss),          C.red);
  row("Avg Trade Duration",   hrs(m.avgDurationH),         C.gray);

  // ── Monthly breakdown ──────────────────────────────────────────────────────
  divider("MONTHLY P&L");
  printMonthlyBreakdown(trades);

  // ── Equity curve ──────────────────────────────────────────────────────────
  divider("EQUITY CURVE");
  printEquityCurve(equityCurve);

  // ── Last 10 trades ────────────────────────────────────────────────────────
  divider("LAST 10 TRADES");
  const last10 = trades.slice(-10);
  console.log(`  ${C.gray}${"Date".padEnd(12)} ${"Type".padEnd(6)} ${"Entry".padEnd(9)} ${"Exit".padEnd(9)} ${"Exit".padEnd(5)} ${"P&L".padStart(9)}${C.reset}`);
  for (const t of last10) {
    const clr  = t.pnlUSD >= 0 ? C.green : C.red;
    const dStr = t.exitDate.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
    console.log(
      `  ${C.gray}${dStr.padEnd(12)}${C.reset}` +
      `${t.type === "long" ? C.green : C.red}${t.type.toUpperCase().padEnd(6)}${C.reset}` +
      `${C.white}${String(t.entry).padEnd(9)}${C.reset}` +
      `${C.white}${String(t.exit.toFixed(2)).padEnd(9)}${C.reset}` +
      `${clr}${t.exitReason.padEnd(5)}${C.reset}` +
      `${clr}${usd(t.pnlUSD).padStart(9)}${C.reset}`
    );
  }

  divider();
  console.log(`\n  ${C.gray}Capital: ${usd(EQUITY_START)}  |  Risk/Trade: ${pct(RISK_PCT)}  |  SL: ${SL_MULT}×ATR  |  EMA-${EMA_PERIOD} filter  |  Min momentum: ${MIN_MOMENTUM}${C.reset}`);
  console.log(`  ${C.gray}Horizon: ${HORIZON}  |  ATR mult: ${ATR_MULT}×  |  Lookback: ${LOOKBACK} bars  |  Momentum window: ${MOMENTUM_N} bars${C.reset}\n`);
})();
