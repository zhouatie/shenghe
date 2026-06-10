"use server";

import { revalidatePath } from "next/cache";
import {
  addHolding,
  addJournal,
  applyCandidateMarketSuggestion,
  clearJournal,
  confirmPlateCandidateDraft,
  deleteCandidate,
  deleteHolding,
  deleteJournal,
  getAppState,
  importCandidatesCsv,
  refreshPlateDetailData,
  refreshPlateRotationData,
  refreshQuotes,
  upsertCandidate,
} from "@/lib/db";
import type {
  AppState,
  CandidateInput,
  CsvImportResult,
  HoldingInput,
  JournalInput,
  PlateCandidateDraft,
  PlateRefreshResult,
  QuoteRefreshResult,
} from "@/lib/types";

export async function createCandidateAction(input: CandidateInput): Promise<AppState> {
  await upsertCandidate(input);
  revalidatePath("/");
  return getAppState();
}

export async function deleteCandidateAction(id: string): Promise<AppState> {
  await deleteCandidate(id);
  revalidatePath("/");
  return getAppState();
}

export async function importCsvAction(csv: string): Promise<CsvImportResult> {
  const result = await importCandidatesCsv(csv);
  revalidatePath("/");
  return result;
}

export async function addHoldingAction(input: HoldingInput): Promise<AppState> {
  await addHolding(input);
  revalidatePath("/");
  return getAppState();
}

export async function deleteHoldingAction(id: string): Promise<AppState> {
  await deleteHolding(id);
  revalidatePath("/");
  return getAppState();
}

export async function addJournalAction(input: JournalInput): Promise<AppState> {
  await addJournal(input);
  revalidatePath("/");
  return getAppState();
}

export async function deleteJournalAction(id: string): Promise<AppState> {
  await deleteJournal(id);
  revalidatePath("/");
  return getAppState();
}

export async function clearJournalAction(): Promise<AppState> {
  await clearJournal();
  revalidatePath("/");
  return getAppState();
}

export async function refreshQuotesAction(): Promise<QuoteRefreshResult> {
  const result = await refreshQuotes();
  revalidatePath("/");
  return result;
}

export async function refreshPlatesAction(): Promise<PlateRefreshResult> {
  const result = await refreshPlateRotationData();
  revalidatePath("/");
  return result;
}

export async function refreshPlateDetailAction(plateCode: string, plateName?: string): Promise<PlateRefreshResult> {
  const result = await refreshPlateDetailData(plateCode, plateName || "");
  revalidatePath("/");
  return result;
}

export async function applyMarketSuggestionAction(candidateId: string): Promise<AppState> {
  const result = await applyCandidateMarketSuggestion(candidateId);
  revalidatePath("/");
  return result;
}

export async function confirmPlateDraftAction(draft: PlateCandidateDraft): Promise<AppState> {
  const result = await confirmPlateCandidateDraft(draft);
  revalidatePath("/");
  return result;
}
