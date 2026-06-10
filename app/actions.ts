"use server";

import { revalidatePath } from "next/cache";
import {
  addHolding,
  addJournal,
  clearJournal,
  deleteCandidate,
  deleteHolding,
  deleteJournal,
  getAppState,
  importCandidatesCsv,
  refreshQuotes,
  upsertCandidate,
} from "@/lib/db";
import type { AppState, CandidateInput, CsvImportResult, HoldingInput, JournalInput, QuoteRefreshResult } from "@/lib/types";

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
