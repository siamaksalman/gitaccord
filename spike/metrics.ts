// Summarise run results (runs/*/result.json) as markdown tables.
// Usage: bun metrics.ts [--since <run-dir-timestamp, e.g. 2026-10-31T10>]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Result {
  scenario: string; mode: string; agent: string; runDir: string; error?: string;
  success: boolean; intentPreserved: number; landed: number; agents: number;
  conflictsResolved: number; whyRate: number; signedRate: number; notes: number;
  directionChanges: number; decisionRecorded: boolean; escalated: boolean; notices: number;
  noticeBytes: number; rejectedCommits: number; unverifiedBlocked: number; hookMsAvg: number;
  hookMsMax: number; firstOverlapSeconds: Record<string, number>; seconds: number;
  features: Record<string, boolean>;
}

export function loadResults(runsDir: string, since = ""): Result[] {
  return readdirSync(runsDir)
    .filter((d) => (d.match(/(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/)?.[1] ?? "") >= since)
    .map((d) => join(runsDir, d, "result.json"))
    .filter(existsSync)
    .map((f) => JSON.parse(readFileSync(f, "utf8")))
    .filter((r) => r.success !== undefined || r.error);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export function perRunTable(rows: Result[]): string {
  const out = [
    "| scenario | mode | agent | success | features kept | landed | conflicts fixed | Why | signed | notes | decision / human flag | notices (bytes) | hook ms avg/max | first overlap | time |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of [...rows].sort((a, b) => `${a.scenario}${a.agent}${a.mode}`.localeCompare(`${b.scenario}${b.agent}${b.mode}`))) {
    if (r.error) {
      out.push(`| ${r.scenario} | ${r.mode} | ${r.agent} | ${r.error} | | | | | | | | | | | |`);
      continue;
    }
    const kept = Object.entries(r.features).map(([f, ok]) => (ok ? f : `~~${f}~~`)).join(" ");
    const overlaps = Object.values(r.firstOverlapSeconds);
    out.push(
      `| ${r.scenario} | ${r.mode} | ${r.agent} | ${r.success ? "✅" : "❌"} | ${kept} | ${r.landed}/${r.agents} | ${r.conflictsResolved} | ${pct(r.whyRate)} | ${pct(r.signedRate)} | ${r.notes} | ${r.mode === "baseline" ? "-" : `${r.decisionRecorded ? "yes" : "no"} / ${r.escalated ? "yes" : "no"}`} | ${r.notices} (${r.noticeBytes}) | ${r.hookMsAvg}/${r.hookMsMax} | ${overlaps.length ? `${Math.min(...overlaps)}s` : "-"} | ${r.seconds}s |`,
    );
  }
  return out.join("\n");
}

export function summaryTable(rows: Result[]): string {
  const groups = new Map<string, Result[]>();
  for (const r of rows) {
    const k = `${r.scenario}|${r.mode}|${r.agent}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out = [
    "| scenario | mode | agent | runs | success | features kept | notes | notices/run | hook ms avg | time avg | failed to start |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [k, rs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [scenario, mode, agent] = k.split("|");
    const ok = rs.filter((r) => !r.error);
    out.push(
      `| ${scenario} | ${mode} | ${agent} | ${ok.length} | ${ok.filter((r) => r.success).length}/${ok.length} | ${pct(avg(ok.map((r) => r.intentPreserved)))} | ${avg(ok.map((r) => r.notes)).toFixed(1)} | ${avg(ok.map((r) => r.notices)).toFixed(1)} | ${Math.round(avg(ok.map((r) => r.hookMsAvg)))} | ${Math.round(avg(ok.map((r) => r.seconds)))}s | ${rs.length - ok.length} |`,
    );
  }
  return out.join("\n");
}

// 95% Wilson score interval for k successes out of n.
function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
const rate = (k: number, n: number) => (n ? `${pct(k / n)} [${pct(wilson(k, n)[0])}–${pct(wilson(k, n)[1])}] (${k}/${n})` : "no data");

const MIN_RUNS = 10; // per scenario, model and mode, for a claim to count

// Success metrics scorecard: the approach (coord + remote) against plain git with
// agents landing their own work, for one model. Thresholds are from the design doc.
export function scorecard(rows: Result[], agent: string): string {
  const ok = rows.filter((r) => !r.error && r.agent === agent && (r as any).ownFeatures);
  const base = ok.filter((r) => r.mode === "baseline");
  const coord = ok.filter((r) => r.mode !== "baseline");
  const clash = (rs: Result[]) => rs.filter((r) => r.scenario !== "nowin");
  const featureCounts = (rs: Result[]) => {
    let k = 0, n = 0;
    for (const r of clash(rs)) for (const v of Object.values(r.features)) { n++; if (v) k++; }
    return [k, n] as const;
  };
  const count = (rs: Result[], f: (r: any) => boolean) => [rs.filter(f).length, rs.length] as const;
  const [ck, cn] = featureCounts(coord), [bk, bn] = featureCounts(base);
  const [cs, csn] = count(coord, (r) => r.silentOverrides > 0), [bs, bsn] = count(base, (r) => r.silentOverrides > 0);
  const nowin = coord.filter((r) => r.scenario === "nowin");
  const [nd, ndn] = count(nowin, (r) => r.decisionRecorded), [ne, nen] = count(nowin, (r) => r.escalated);
  const [cb, cbn] = count(coord, (r) => r.brokenMain), [bb, bbn] = count(base, (r) => r.brokenMain);
  let det = 0, detN = 0;
  for (const r of coord as any[]) { det += r.clashesDetected; detN += r.clashesTotal; }
  // Time overhead: per scenario, mean coord time / mean baseline time.
  // Work overhead uses model tokens (independent of provider queueing); wall time is
  // shown for reference. Only runs that recorded usage count for tokens.
  const ratios: number[] = [], tokenRatios: number[] = [];
  for (const s of new Set(coord.map((r) => r.scenario))) {
    const c = coord.filter((r) => r.scenario === s && r.mode === "coord"), b = base.filter((r) => r.scenario === s);
    if (c.length && b.length) ratios.push(avg(c.map((r) => r.seconds)) / avg(b.map((r) => r.seconds)));
    const ct = c.filter((r: any) => r.tokens > 0), bt = b.filter((r: any) => r.tokens > 0);
    if (ct.length && bt.length) tokenRatios.push(avg(ct.map((r: any) => r.tokens)) / avg(bt.map((r: any) => r.tokens)));
  }
  const overhead = avg(ratios), tokenOverhead = avg(tokenRatios);
  const kbPerAgent = avg(coord.map((r) => r.noticeBytes / r.agents / 1024));
  const hookMax = coord.map((r) => r.hookMsMax).sort((a, b) => a - b);
  const hookP95 = hookMax.length ? hookMax[Math.min(hookMax.length - 1, Math.floor(hookMax.length * 0.95))] : 0;
  const why = avg(coord.map((r) => r.whyRate)), signed = avg(coord.map((r) => r.signedRate));

  const mark = (pass: boolean) => (pass ? "✅" : "❌");
  const cells = new Map<string, number>();
  for (const r of ok) cells.set(`${r.scenario}/${r.mode}`, (cells.get(`${r.scenario}/${r.mode}`) ?? 0) + 1);
  const thin = [...cells].filter(([, n]) => n < MIN_RUNS).length;

  return [
    `### ${agent}`,
    "",
    "| # | Metric | Threshold | agentsync | plain git | Met |",
    "|---|---|---|---|---|---|",
    `| P1 | Intent survival: features working on main (clash scenarios) | ≥ 95% and ≥ plain git | ${rate(ck, cn)} | ${rate(bk, bn)} | ${mark(cn > 0 && ck / cn >= 0.95 && ck / cn >= (bn ? bk / bn : 0))} |`,
    `| P2 | Silent overrides: runs where a feature was broken with no recorded decision | ≤ 5% | ${rate(cs, csn)} | ${rate(bs, bsn)} | ${mark(csn > 0 && cs / csn <= 0.05)} |`,
    ...(() => {
      // v2 hook only: overridden features that nobody declared with an Override line.
      const v2 = coord.filter((r: any) => r.overridesDeclared);
      const unflagged = (r: any) => (r.overridden ?? []).some((a: string) => !(r.overridesDeclared ?? []).includes(a));
      const [k, n] = count(v2, unflagged), [bk2, bn2] = count(base, (r: any) => (r.overridden ?? []).length > 0);
      return v2.length
        ? [`| P2b | Unflagged overrides: a feature broken with no \`Override:\` line (v2 hook) | 0% | ${rate(k, n)} | ${rate(bk2, bn2)} | ${mark(k === 0)} |`]
        : [];
    })(),
    `| P3 | No-win cases: decision recorded / flagged for a human | 100% / ≥ 80% | ${rate(nd, ndn)} / ${rate(ne, nen)} | not possible | ${mark(ndn > 0 && nd === ndn && ne / nen >= 0.8)} |`,
    `| G1 | Broken main: project tests fail or conflict markers committed | ≤ 5% and ≤ plain git | ${rate(cb, cbn)} | ${rate(bb, bbn)} | ${mark(cbn > 0 && cb / cbn <= 0.05 && cb / cbn <= (bbn ? bb / bbn : 1))} |`,
    `| G2 | Work overhead vs plain git: model tokens (wall time for reference) | ≤ 1.5× tokens | ${tokenOverhead ? `${tokenOverhead.toFixed(2)}×` : "no data"} (time ${overhead ? `${overhead.toFixed(2)}×` : "–"}) | 1.00× | ${mark(tokenOverhead > 0 && tokenOverhead <= 1.5)} |`,
    `| G3 | Coordination text per agent per run | ≤ 4 KB | ${kbPerAgent.toFixed(1)} KB | – | ${mark(kbPerAgent <= 4)} |`,
    `| G4 | Hook latency, p95 of per-run max | ≤ 500 ms | ${hookP95} ms | – | ${mark(hookP95 <= 500)} |`,
    `| M1 | Clash detection recall (designed clashes flagged) | ≥ 90% | ${rate(det, detN)} | – | ${mark(detN > 0 && det / detN >= 0.9)} |`,
    `| M2 | Commits with a Why line / signed and verified | ≥ 95% / 100% | ${pct(why)} / ${pct(signed)} | – | ${mark(why >= 0.95 && signed >= 0.999)} |`,
    "",
    thin
      ? `⚠️ ${thin} of ${cells.size} scenario/mode cells have fewer than ${MIN_RUNS} runs, so these results are indicative, not conclusive.`
      : `All cells have at least ${MIN_RUNS} runs.`,
  ].join("\n");
}

if (import.meta.main) {
  const i = process.argv.indexOf("--since");
  const rows = loadResults(join(import.meta.dir, "runs"), i === -1 ? "" : process.argv[i + 1]);
  const agents = [...new Set(rows.map((r) => r.agent))].filter((a) => a !== "noop");
  console.log(
    "## Scorecard\n\n" + agents.map((a) => scorecard(rows, a)).join("\n\n") +
      "\n\n## Summary\n\n" + summaryTable(rows) + "\n\n## Per run\n\n" + perRunTable(rows),
  );
}
