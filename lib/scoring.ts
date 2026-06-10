import type { Candidate, CandidateScores, Holding, Settings, ThemeSummary } from "@/lib/types";

export function marketScore(candidate: Pick<Candidate, "market">): number {
  return Object.values(candidate.market || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

export function fundamentalScore(candidate: Pick<Candidate, "fundamental">): number {
  return Object.values(candidate.fundamental || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

export function scoreCandidate(candidate: Pick<Candidate, "market" | "fundamental" | "riskPenalty">): CandidateScores {
  const market = marketScore(candidate);
  const fundamental = fundamentalScore(candidate);
  const risk = Number(candidate.riskPenalty || 0);
  return {
    market,
    fundamental,
    risk,
    total: Math.max(0, Math.round(market + fundamental - risk)),
  };
}

export function deriveThemes(candidates: Candidate[]): ThemeSummary[] {
  const map = new Map<string, ThemeSummary & { catalystSet: Set<string>; rawTurnover: number }>();

  for (const candidate of candidates) {
    const name = candidate.theme || "未归类";
    const current =
      map.get(name) ||
      ({
        id: slug(name),
        name,
        mode: name.includes("高股息") || name.includes("红利") || name.includes("防守") ? "防守" : "进攻",
        strength: 0,
        breadth: 0,
        turnover: 0,
        rawTurnover: 0,
        catalysts: [],
        catalystSet: new Set<string>(),
        risk: "",
        trend: [],
        color: themeColor(name),
      } satisfies ThemeSummary & { catalystSet: Set<string>; rawTurnover: number });

    current.breadth += 1;
    current.strength += candidate.scores.total;
    current.rawTurnover += Math.max(0, Number(candidate.changePct || 0));
    for (const tag of candidate.tags || []) current.catalystSet.add(tag);
    if (candidate.riskNotes && !current.risk) {
      current.risk = candidate.riskNotes.split(/[，,;；]/)[0] || "待验证";
    }
    current.trend = mergeTrend(current.trend, candidate.trend);
    map.set(name, current);
  }

  return [...map.values()]
    .map((theme) => ({
      id: theme.id,
      name: theme.name,
      mode: theme.mode,
      strength: theme.breadth ? Math.round(theme.strength / theme.breadth) : 0,
      breadth: theme.breadth,
      turnover: theme.breadth ? Number((theme.rawTurnover / theme.breadth).toFixed(2)) : 0,
      catalysts: [...theme.catalystSet].slice(0, 4),
      risk: theme.risk || "待验证",
      trend: theme.trend.length ? theme.trend : [40, 45, 50, 55, 60],
      color: theme.color,
    }))
    .sort((a, b) => b.strength - a.strength);
}

export function healthFor(
  candidate: Candidate | undefined,
  holding: Pick<Holding, "targetWeight" | "stage">,
  settings: Settings,
): Holding["health"] {
  if (!candidate) return { text: "自定义观察", className: "watch" };
  if (Number(holding.targetWeight || 0) > Number(settings.maxSingleWeight || 20)) {
    return { text: "仓位超限", className: "risk" };
  }
  if (holding.stage === "防守") return { text: "波动缓冲", className: "watch" };
  if (candidate.scores.total >= 78 && candidate.scores.risk <= 10) return { text: "强势跟踪", className: "" };
  if (candidate.scores.total >= 64) return { text: "降仓观察", className: "watch" };
  return { text: "证伪复盘", className: "risk" };
}

export function themeColor(value: string): string {
  const colors = ["#087f8c", "#0b7a5a", "#285cc4", "#7052c9", "#a66a00", "#b42318"];
  return colors[hash(value) % colors.length];
}

export function slug(value: string): string {
  return Math.abs(hash(value)).toString(16).padStart(8, "0").slice(0, 10);
}

function hash(value: string): number {
  let result = 0;
  for (const char of String(value || "")) {
    result = (result * 31 + char.charCodeAt(0)) % 2147483647;
  }
  return result;
}

function mergeTrend(left: number[], right: number[]): number[] {
  if (!left.length) return right || [];
  const max = Math.max(left.length, right?.length || 0);
  return Array.from({ length: max }, (_, index) => {
    const a = left[index] ?? left[left.length - 1] ?? 0;
    const b = right?.[index] ?? right?.[right.length - 1] ?? a;
    return Math.round((a + b) / 2);
  });
}
