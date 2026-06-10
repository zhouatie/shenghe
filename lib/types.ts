export type MarketScores = {
  rs: number;
  theme: number;
  flow: number;
  structure: number;
  catalyst: number;
};

export type FundamentalScores = {
  growth: number;
  position: number;
  valuation: number;
  cashflow: number;
  governance: number;
};

export type Candidate = {
  id: string;
  name: string;
  code: string;
  symbol: string;
  theme: string;
  tags: string[];
  thesis: string;
  riskNotes: string;
  market: MarketScores;
  fundamental: FundamentalScores;
  riskPenalty: number;
  price: number | null;
  changePct: number | null;
  volume: number | null;
  lastQuoteAt: string | null;
  quoteSource: string | null;
  trend: number[];
  sample: boolean;
  createdAt: string;
  updatedAt: string;
  scores: CandidateScores;
};

export type CandidateInput = {
  id?: string;
  name?: string;
  code?: string;
  symbol?: string;
  theme?: string;
  tags?: string[] | string;
  thesis?: string;
  riskNotes?: string;
  rs?: number | string;
  themeScore?: number | string;
  flow?: number | string;
  structure?: number | string;
  catalyst?: number | string;
  growth?: number | string;
  position?: number | string;
  valuation?: number | string;
  cashflow?: number | string;
  governance?: number | string;
  riskPenalty?: number | string;
  price?: number | string | null;
  changePct?: number | string | null;
  volume?: number | string | null;
  trend?: number[] | string;
  sample?: boolean;
};

export type CandidateScores = {
  market: number;
  fundamental: number;
  risk: number;
  total: number;
};

export type ThemeSummary = {
  id: string;
  name: string;
  mode: "进攻" | "防守";
  strength: number;
  breadth: number;
  turnover: number;
  catalysts: string[];
  risk: string;
  trend: number[];
  color: string;
};

export type PlateRotationSource = "kaipan" | "ths";

export type PlateRotationValueType = "score" | "pct";

export type PlateDirection = "red" | "green";

export type PlateRankingItem = {
  source: PlateRotationSource;
  tradeDate: string;
  rank: number;
  code: string;
  name: string;
  value: string;
  numericValue: number | null;
  valueType: PlateRotationValueType;
  color: PlateDirection;
  refreshedAt: string;
};

export type PlateCurvePoint = {
  date: string;
  value: number | null;
  listed: boolean;
  symbol: string;
};

export type PlateCurveSeries = {
  source: PlateRotationSource;
  name: string;
  points: PlateCurvePoint[];
};

export type PlateCurve = {
  source: PlateRotationSource;
  dates: string[];
  series: PlateCurveSeries[];
  refreshedAt: string;
};

export type PlateHead = {
  rank: string;
  code: string;
  name: string;
};

export type PlateDailyHeads = {
  date: string;
  heads: PlateHead[];
};

export type PlateDragonKing = {
  code: string;
  name: string;
  count: number;
  positions: string[];
};

export type PlateStrengthPoint = {
  date: string;
  strength: number | null;
  volume: number | null;
};

export type PlateDetail = {
  plateCode: string;
  plateName: string;
  source: PlateRotationSource;
  kings: PlateDragonKing[];
  dailyHeads: PlateDailyHeads[];
  strength: PlateStrengthPoint[];
  refreshedAt: string;
};

export type MarketScoreSuggestion = {
  candidateId?: string;
  candidateCode?: string;
  candidateName?: string;
  plateCode: string;
  plateName: string;
  source: PlateRotationSource;
  market: MarketScores;
  evidence: string[];
  refreshedAt: string;
};

export type PlateCandidateDraft = {
  code: string;
  name: string;
  theme: string;
  tags: string[];
  thesis: string;
  riskNotes: string;
  market: MarketScores;
  evidence: string[];
  sourcePlateCode: string;
  sourcePlateName: string;
  source: PlateRotationSource;
};

export type PlateRefreshStatus = {
  ok: boolean;
  message: string;
  refreshedAt: string;
};

export type PlateRotationState = {
  rankings: Record<PlateRotationSource, PlateRankingItem[]>;
  curves: Record<PlateRotationSource, PlateCurve | null>;
  details: PlateDetail[];
  suggestions: MarketScoreSuggestion[];
  drafts: PlateCandidateDraft[];
  status: PlateRefreshStatus | null;
};

export type Holding = {
  id: string;
  candidateId: string;
  customName: string;
  cost: number;
  quantity: number;
  targetWeight: number;
  conviction: string;
  stage: string;
  createdAt: string;
  value: number;
  candidateName: string;
  theme: string;
  health: {
    text: string;
    className: "" | "watch" | "risk";
  };
};

export type HoldingInput = {
  candidateId?: string;
  customName?: string;
  cost?: number | string;
  quantity?: number | string;
  targetWeight?: number | string;
  conviction?: string;
  stage?: string;
};

export type JournalEntry = {
  id: string;
  candidateId: string;
  decision: string;
  thesis: string;
  mutation: string;
  verification: string;
  invalidation: string;
  reviewDate: string;
  createdAt: string;
};

export type JournalInput = Omit<Partial<JournalEntry>, "id" | "createdAt">;

export type Settings = {
  marketPhase: string;
  maxSingleWeight: number;
  weakMarketMaxWeight: number;
};

export type AppMetrics = {
  candidateCount: number;
  topTheme: string;
  avgScore: number;
  highRiskCount: number;
  exposure: number;
  dueJournal: number;
};

export type AppState = {
  version: number;
  updatedAt: string;
  settings: Settings;
  candidates: Candidate[];
  themes: ThemeSummary[];
  plate: PlateRotationState;
  holdings: Holding[];
  journal: JournalEntry[];
  metrics: AppMetrics;
};

export type CsvImportResult = {
  imported: number;
  state: AppState;
};

export type QuoteRefreshResult = {
  updated: number;
  requested?: number;
  skipped?: number;
  source?: string;
  message?: string;
  state: AppState;
};

export type PlateRefreshResult = {
  ok: boolean;
  updated: number;
  message: string;
  state: AppState;
};
