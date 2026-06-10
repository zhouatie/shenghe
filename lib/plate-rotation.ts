import type {
  Candidate,
  MarketScores,
  MarketScoreSuggestion,
  PlateCandidateDraft,
  PlateCurve,
  PlateCurvePoint,
  PlateDailyHeads,
  PlateDetail,
  PlateDragonKing,
  PlateHead,
  PlateRankingItem,
  PlateRefreshStatus,
  PlateRotationSource,
  PlateRotationState,
  PlateStrengthPoint,
} from "@/lib/types";

const HOST = "https://duanxianxia.com";
const DEFAULT_DAYS = 20;
const TOP_N = 10;
const REQUEST_TIMEOUT_MS = 9000;
const RETRY_CODES = new Set([429, 500, 502, 503, 504]);

type JsonRecord = Record<string, unknown>;

export type PlateRotationSnapshot = Pick<PlateRotationState, "rankings" | "curves" | "details"> & {
  status: PlateRefreshStatus;
};

export async function fetchPlateRotationSnapshot(days = DEFAULT_DAYS): Promise<PlateRotationSnapshot> {
  const refreshedAt = new Date().toISOString();
  const errors: string[] = [];
  const rankings: PlateRotationSnapshot["rankings"] = { kaipan: [], ths: [] };
  const curves: PlateRotationSnapshot["curves"] = { kaipan: null, ths: null };
  const details: PlateDetail[] = [];

  for (const source of ["kaipan", "ths"] as const) {
    try {
      const data = await fetchPlateJson("/api/getPlateRotatData", { from: source, days });
      rankings[source] = parsePlateRankings(data, source, refreshedAt, TOP_N);
    } catch (error) {
      errors.push(`${source}榜单: ${errorMessage(error)}`);
    }

    try {
      const curve = await fetchPlateJson("/api/getPlateRotatChart", { from: source, days });
      curves[source] = parsePlateCurve(curve, source, refreshedAt);
    } catch (error) {
      errors.push(`${source}曲线: ${errorMessage(error)}`);
    }
  }

  const detailTargets = uniqueRankings([...rankings.kaipan.slice(0, 2), ...rankings.ths.slice(0, 2)]);
  for (const item of detailTargets) {
    try {
      details.push(await fetchPlateDetail(item.code, item.name, days));
    } catch (error) {
      errors.push(`${item.name}详情: ${errorMessage(error)}`);
    }
  }

  const updated = rankings.kaipan.length + rankings.ths.length + details.length + Number(Boolean(curves.kaipan)) + Number(Boolean(curves.ths));
  const status: PlateRefreshStatus = {
    ok: updated > 0 && errors.length === 0,
    message: errors.length ? `部分刷新异常：${errors.join("；")}` : `板块刷新完成，更新 ${updated} 组数据`,
    refreshedAt,
  };

  if (updated === 0) {
    return {
      rankings,
      curves,
      details,
      status: {
        ok: false,
        message: errors.length ? `板块刷新失败：${errors.join("；")}` : "板块接口返回空数据",
        refreshedAt,
      },
    };
  }

  return { rankings, curves, details, status };
}

export async function fetchPlateDetail(plateCode: string, plateName = "", days = DEFAULT_DAYS): Promise<PlateDetail> {
  const source = inferPlateSource(plateCode);
  const refreshedAt = new Date().toISOString();
  const main = await fetchPlateJson("/api/getPlateRotatData", { from: source, days });
  const dates = parsePlateDates(main);
  const headsPayload = await fetchPlateJson("/api/getLongByPlate", { platecode: plateCode, days });
  const strengthPayload = await fetchPlateJson("/api/getPlateDayChart", { platecode: plateCode, days });
  const dailyHeads = parsePlateDailyHeads(headsPayload, dates);
  const kings = rankDragonKings(dailyHeads);
  const strength = parsePlateStrength(strengthPayload);

  return {
    plateCode,
    plateName: plateName || findPlateName(main, plateCode) || plateCode,
    source,
    kings,
    dailyHeads,
    strength,
    refreshedAt,
  };
}

export function parsePlateRankings(
  data: unknown,
  source: PlateRotationSource,
  refreshedAt: string,
  limit = TOP_N,
): PlateRankingItem[] {
  const payload = asRecord(data);
  const html = String(payload.html || "");
  const tradeDate = parsePlateDates(payload)[0] || refreshedAt.slice(0, 10);
  const parts = html.split(/<span class='rank'[^>]*>(\d+)<\/span>/);
  const rows: PlateRankingItem[] = [];

  for (let index = 1; index < parts.length && rows.length < limit; index += 2) {
    const rank = Number(parts[index]);
    const rest = parts[index + 1] || "";
    const match = rest.match(
      /<td class='plate plate\d+'\s*code='(\d+)'\s*name='([^']+)'[^>]*>[\s\S]*?<span style='color:(red|green);'>([\d.\-]+%?)<\/span>/,
    );
    if (!match || !Number.isFinite(rank)) continue;
    const [, code, name, color, value] = match;
    rows.push({
      source,
      tradeDate,
      rank,
      code,
      name,
      value,
      numericValue: parseValue(value),
      valueType: value.endsWith("%") ? "pct" : "score",
      color: color === "green" ? "green" : "red",
      refreshedAt,
    });
  }

  if (!rows.length) throw new Error("empty_rankings");
  return rows;
}

export function parsePlateCurve(data: unknown, source: PlateRotationSource, refreshedAt: string): PlateCurve {
  const payload = asRecord(data);
  const dates = asStringArray(payload.date);
  const names = asRecord(payload.name);
  const series = [1, 2, 3, 4, 5]
    .map((index) => {
      const name = String(names[String(index)] || "");
      const rawPoints = Array.isArray(payload[String(index)]) ? (payload[String(index)] as JsonRecord[]) : [];
      if (!name || !rawPoints.length) return null;
      return {
        source,
        name,
        points: rawPoints.map((point, pointIndex) => parseCurvePoint(point, dates[pointIndex] || "")),
      };
    })
    .filter((item): item is PlateCurve["series"][number] => Boolean(item));

  if (!dates.length || !series.length) throw new Error("empty_curve");
  return { source, dates, series, refreshedAt };
}

export function parsePlateDailyHeads(data: unknown, dates: string[]): PlateDailyHeads[] {
  const html = String(asRecord(data).html || "");
  const matches = html.matchAll(
    /<td style='(?:text-align:left;padding-bottom:5px;|text-align:center;color:#bbb[^']*)'>([\s\S]*?)(?=<td|$)/g,
  );
  const days: PlateDailyHeads[] = [];
  let index = 0;
  for (const match of matches) {
    const td = match[1] || "";
    const heads: PlateHead[] = td.includes("当日无领涨")
      ? []
      : [...td.matchAll(/<div class='kline' code='(\d{6})'><span>([^<]+)<\/span>([^<]+)<\/div>/g)].map((head) => ({
          code: head[1],
          rank: head[2],
          name: head[3],
        }));
    days.push({ date: dates[index] || "", heads });
    index += 1;
  }
  return days;
}

export function rankDragonKings(days: PlateDailyHeads[], topN = 10): PlateDragonKing[] {
  const bag = new Map<string, PlateDragonKing>();
  for (const day of days) {
    for (const head of day.heads) {
      const current = bag.get(head.code) || { code: head.code, name: head.name, count: 0, positions: [] };
      current.count += 1;
      current.name = head.name;
      current.positions.push(`${day.date}/${head.rank}`);
      bag.set(head.code, current);
    }
  }
  return [...bag.values()].sort((left, right) => right.count - left.count).slice(0, topN);
}

export function parsePlateStrength(data: unknown): PlateStrengthPoint[] {
  const payload = asRecord(data);
  const dates = asStringArray(payload.date);
  const strengths = asNumberArray(payload.series1);
  const volumes = asNumberArray(payload.series2);
  return dates.map((date, index) => ({
    date,
    strength: strengths[index] ?? null,
    volume: volumes[index] ?? null,
  }));
}

export function buildMarketSuggestion(candidate: Candidate, state: PlateRotationState): MarketScoreSuggestion | undefined {
  const codeMatch = findDetailByCandidateCode(candidate.code, state.details);
  const rankingMatch = codeMatch
    ? findRankingByPlate(codeMatch.plateCode, state.rankings)
    : findRankingByTheme(candidate.theme, candidate.tags, state.rankings);
  const plateName = codeMatch?.plateName || rankingMatch?.name || "";
  const plateCode = codeMatch?.plateCode || rankingMatch?.code || "";
  if (!plateCode || !plateName) return undefined;

  const source = codeMatch?.source || rankingMatch?.source || "kaipan";
  const curve = findCurveSeries(plateName, state.curves[source]);
  const king = codeMatch?.kings.find((item) => item.code === candidate.code);
  const market: MarketScores = {
    rs: suggestRs(rankingMatch, king),
    theme: suggestTheme(rankingMatch),
    flow: suggestFlow(rankingMatch),
    structure: suggestStructure(curve),
    catalyst: suggestCatalyst(rankingMatch, king),
  };
  const evidence = buildEvidence(rankingMatch, curve, king, codeMatch?.refreshedAt || rankingMatch?.refreshedAt || "");

  return {
    candidateId: candidate.id,
    candidateCode: candidate.code,
    candidateName: candidate.name,
    plateCode,
    plateName,
    source,
    market,
    evidence,
    refreshedAt: codeMatch?.refreshedAt || rankingMatch?.refreshedAt || new Date().toISOString(),
  };
}

export function buildPlateCandidateDrafts(state: PlateRotationState): PlateCandidateDraft[] {
  const drafts = new Map<string, PlateCandidateDraft>();
  for (const detail of state.details) {
    for (const king of detail.kings.slice(0, 5)) {
      if (drafts.has(king.code)) continue;
      const ranking = findRankingByPlate(detail.plateCode, state.rankings);
      const market: MarketScores = {
        rs: Math.min(20, 12 + king.count * 2),
        theme: suggestTheme(ranking),
        flow: suggestFlow(ranking),
        structure: Math.min(10, 6 + king.count),
        catalyst: Math.min(10, 7 + king.count),
      };
      drafts.set(king.code, {
        code: king.code,
        name: king.name,
        theme: detail.plateName,
        tags: [`${sourceLabel(detail.source)}龙头`, `上榜${king.count}次`],
        thesis: `${detail.plateName}近阶段龙头样本，${king.positions.slice(0, 3).join("、")}。`,
        riskNotes: "板块热度退潮、龙头接力断档、基本面未验证",
        market,
        evidence: [`${detail.plateName} ${king.name} 近${detail.dailyHeads.length}日上榜${king.count}次`, ...king.positions.slice(0, 4)],
        sourcePlateCode: detail.plateCode,
        sourcePlateName: detail.plateName,
        source: detail.source,
      });
    }
  }
  return [...drafts.values()].slice(0, 12);
}

export function emptyPlateState(): PlateRotationState {
  return {
    rankings: { kaipan: [], ths: [] },
    curves: { kaipan: null, ths: null },
    details: [],
    suggestions: [],
    drafts: [],
    status: null,
  };
}

export function inferPlateSource(plateCode: string): PlateRotationSource {
  return plateCode.startsWith("88") ? "ths" : "kaipan";
}

function parsePlateDates(data: unknown): string[] {
  const html = String(asRecord(data).html || "");
  return [...html.matchAll(/line-height:160%;'>(\d{4}-\d{2}-\d{2})/g)].map((match) => match[1]);
}

async function fetchPlateJson(path: string, params: Record<string, string | number>): Promise<JsonRecord> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) body.set(key, String(value));
  const url = `${HOST}${path}`;
  let lastError = "";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": "mutation-radar/1.0",
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Referer: "https://duanxianxia.com/web/main",
          Origin: HOST,
          "X-Requested-With": "XMLHttpRequest",
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        lastError = `http_${response.status}:${text.slice(0, 80)}`;
        if (!RETRY_CODES.has(response.status)) break;
      } else {
        const json = (await response.json()) as unknown;
        return asRecord(json);
      }
    } catch (error) {
      lastError = errorMessage(error);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(lastError || "request_failed");
}

function parseCurvePoint(point: JsonRecord, date: string): PlateCurvePoint {
  const symbol = String(point.symbol || "");
  const raw = Number(point.value);
  const listed = !(raw === 10.5 && symbol.includes("wu.png"));
  return {
    date,
    value: listed && Number.isFinite(raw) ? raw : null,
    listed,
    symbol,
  };
}

function findPlateName(data: unknown, plateCode: string): string {
  return parsePlateRankings(data, inferPlateSource(plateCode), new Date().toISOString(), 50).find((item) => item.code === plateCode)?.name || "";
}

function findDetailByCandidateCode(code: string, details: PlateDetail[]): PlateDetail | undefined {
  return details.find((detail) => detail.kings.some((king) => king.code === code) || detail.dailyHeads.some((day) => day.heads.some((head) => head.code === code)));
}

function findRankingByPlate(plateCode: string, rankings: PlateRotationState["rankings"]): PlateRankingItem | undefined {
  return [...rankings.kaipan, ...rankings.ths].find((item) => item.code === plateCode);
}

function findRankingByTheme(theme: string, tags: string[], rankings: PlateRotationState["rankings"]): PlateRankingItem | undefined {
  const texts = [theme, ...tags].map(cleanTheme).filter(Boolean);
  return [...rankings.kaipan, ...rankings.ths]
    .sort((left, right) => left.rank - right.rank)
    .find((item) => texts.some((text) => themeMatches(text, cleanTheme(item.name))));
}

function findCurveSeries(plateName: string, curve: PlateCurve | null): PlateCurve["series"][number] | undefined {
  if (!curve) return undefined;
  const target = cleanTheme(plateName);
  return curve.series.find((item) => themeMatches(target, cleanTheme(item.name)));
}

function suggestRs(ranking: PlateRankingItem | undefined, king: PlateDragonKing | undefined): number {
  if (king) return Math.min(20, 12 + king.count * 2);
  if (!ranking) return 10;
  if (ranking.rank === 1) return 18;
  if (ranking.rank <= 3) return 16;
  if (ranking.rank <= 5) return 14;
  return 12;
}

function suggestTheme(ranking: PlateRankingItem | undefined): number {
  if (!ranking) return 6;
  if (ranking.rank === 1) return 10;
  if (ranking.rank <= 3) return 9;
  if (ranking.rank <= 5) return 8;
  return 6;
}

function suggestFlow(ranking: PlateRankingItem | undefined): number {
  if (!ranking) return 5;
  if (ranking.valueType === "pct") {
    const pct = ranking.numericValue || 0;
    if (pct >= 3) return 10;
    if (pct >= 1.5) return 8;
    if (pct > 0) return 6;
    return 4;
  }
  const score = ranking.numericValue || 0;
  if (score >= 10000) return 9;
  if (score >= 5000) return 7;
  return ranking.rank <= 5 ? 6 : 5;
}

function suggestStructure(series: PlateCurve["series"][number] | undefined): number {
  if (!series) return 6;
  const listed = series.points.filter((point) => point.listed && point.value !== null);
  if (!listed.length) return 4;
  const latest = series.points[0];
  const previous = listed.find((point) => point.date !== latest.date);
  if (!latest.listed) return 4;
  if (!previous) return 7;
  if ((latest.value || 99) < (previous.value || 99)) return 9;
  if ((latest.value || 99) === (previous.value || 99)) return 7;
  return 6;
}

function suggestCatalyst(ranking: PlateRankingItem | undefined, king: PlateDragonKing | undefined): number {
  if (ranking?.rank === 1) return 10;
  if (king && king.count >= 3) return 9;
  if (ranking && ranking.rank <= 3) return 8;
  if (king) return 7;
  return 5;
}

function buildEvidence(
  ranking: PlateRankingItem | undefined,
  curve: PlateCurve["series"][number] | undefined,
  king: PlateDragonKing | undefined,
  refreshedAt: string,
): string[] {
  const evidence: string[] = [];
  if (ranking) {
    evidence.push(`${sourceLabel(ranking.source)} ${ranking.tradeDate} #${ranking.rank} ${ranking.name} ${ranking.valueType === "pct" ? "涨幅" : "强度"} ${ranking.value}`);
  }
  if (curve) {
    const latest = curve.points[0];
    evidence.push(`${sourceLabel(curve.source)}排名曲线 ${latest?.date || ""} ${latest?.listed ? `#${latest.value}` : "未上榜"}`);
  }
  if (king) evidence.push(`${king.name} 龙头榜上榜${king.count}次：${king.positions.slice(0, 3).join("、")}`);
  if (refreshedAt) evidence.push(`刷新时间 ${refreshedAt.slice(0, 16).replace("T", " ")}`);
  return evidence;
}

function uniqueRankings(items: PlateRankingItem[]): PlateRankingItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.code)) return false;
    seen.add(item.code);
    return true;
  });
}

function parseValue(value: string): number | null {
  const number = Number(value.replace("%", ""));
  return Number.isFinite(number) ? number : null;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

function cleanTheme(value: string): string {
  return String(value || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[（）]/g, "")
    .replace(/概念|板块|行业|主题/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function themeMatches(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
}

function sourceLabel(source: PlateRotationSource): string {
  return source === "kaipan" ? "开盘啦" : "同花顺";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "unknown_error");
}
