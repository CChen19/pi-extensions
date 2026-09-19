import {
  FILE_RELEVANCE_THRESHOLD,
  INITIAL_RERANK_CANDIDATES,
  MAX_RERANK_CANDIDATES,
  MAX_SEMANTIC_FILES,
  RERANK_WIDENING_BATCH,
  RESULT_RELEVANCE_THRESHOLD,
} from "./constants.js";
import type { SearchDatabase } from "./database.js";
import type { DiscoveryResult } from "./files.js";
import { type IndexUpdateResult, refreshIndex } from "./indexer.js";
import type { JevEvaluation, JevEvaluator } from "./jev-client.js";
import {
  chunksForSemanticFiles,
  mergeCandidates,
  type RetrievedChunk,
  retrieveLexicalCandidates,
  selectFileMaps,
} from "./retrieval.js";

export type SearchPhase = "index" | "files" | "rerank";

export interface SearchRequest {
  query: string;
  alternatives: readonly string[];
  limit: number;
}

export interface SearchMatch extends RetrievedChunk {
  relevance: number;
}

export interface SearchResponse {
  matches: SearchMatch[];
  index: IndexUpdateResult;
  scannedFiles: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  fileMapsEvaluated: number;
  candidatesEvaluated: number;
}

export async function searchIndexedWorkspace(options: {
  database: SearchDatabase;
  discovery: DiscoveryResult;
  evaluator: JevEvaluator;
  request: SearchRequest;
  signal?: AbortSignal;
  onProgress?: (phase: SearchPhase, detail: string) => void;
}): Promise<SearchResponse> {
  const { database, discovery, evaluator, request, signal, onProgress } = options;
  signal?.throwIfAborted();
  onProgress?.("index", `Refreshing index for ${discovery.files.length} files`);
  const index = await refreshIndex(database, discovery, signal, (progress) => {
    if (progress.current === 1 || progress.current === progress.total || progress.current % 25 === 0) {
      onProgress?.("index", `Indexing ${progress.current}/${progress.total}: ${progress.path}`);
    }
  });
  signal?.throwIfAborted();

  const lexical = retrieveLexicalCandidates(database, request.query, request.alternatives);
  const maps = selectFileMaps(database, lexical);
  onProgress?.("files", `Screening ${maps.length} file maps with Jev`);
  const semanticQuery = queryWithAlternatives(request.query, request.alternatives);
  const fileEvaluation = await evaluator.evaluate(
    semanticQuery,
    maps.map((file) => ({ id: file.path, path: file.path, text: file.outline })),
    "file",
    signal,
  );
  signal?.throwIfAborted();
  const semanticFiles = maps
    .map((file) => ({ path: file.path, score: fileEvaluation.scores.get(file.path) ?? 0 }))
    .filter((file) => file.score >= FILE_RELEVANCE_THRESHOLD)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, MAX_SEMANTIC_FILES);
  const semantic = chunksForSemanticFiles(database, request.query, request.alternatives, semanticFiles);
  const candidates = mergeCandidates(lexical, semantic).slice(0, MAX_RERANK_CANDIDATES);

  const scores = new Map<string, number>();
  const evaluationTotals: JevEvaluation = {
    scores,
    requests: fileEvaluation.requests,
    inputTokens: fileEvaluation.inputTokens,
    outputTokens: fileEvaluation.outputTokens,
    model: fileEvaluation.model,
  };
  let evaluated = 0;
  let target = Math.min(INITIAL_RERANK_CANDIDATES, candidates.length);
  while (evaluated < candidates.length) {
    signal?.throwIfAborted();
    const current = candidates.slice(evaluated, target);
    onProgress?.("rerank", `Reranking candidates ${evaluated + 1}-${target} of ${candidates.length}`);
    const response = await evaluator.evaluate(
      semanticQuery,
      current.map((candidate) => ({
        id: String(candidate.id),
        path: `${candidate.filePath}:${candidate.startLine}-${candidate.endLine}`,
        text: candidate.body,
      })),
      "chunk",
      signal,
    );
    for (const [id, score] of response.scores) scores.set(id, score);
    evaluationTotals.requests += response.requests;
    evaluationTotals.inputTokens += response.inputTokens;
    evaluationTotals.outputTokens += response.outputTokens;
    evaluationTotals.model = response.model ?? evaluationTotals.model;
    evaluated = target;

    const accepted = acceptedMatches(candidates, evaluated, scores);
    if (accepted.length >= request.limit || evaluated >= candidates.length) break;
    target = Math.min(candidates.length, target + RERANK_WIDENING_BATCH);
  }

  const matches = acceptedMatches(candidates, evaluated, scores).slice(0, request.limit);

  return {
    matches,
    index,
    scannedFiles: discovery.files.length,
    requests: evaluationTotals.requests,
    inputTokens: evaluationTotals.inputTokens,
    outputTokens: evaluationTotals.outputTokens,
    model: evaluationTotals.model,
    fileMapsEvaluated: maps.length,
    candidatesEvaluated: evaluated,
  };
}

function acceptedMatches(
  candidates: readonly RetrievedChunk[],
  evaluated: number,
  scores: ReadonlyMap<string, number>,
): SearchMatch[] {
  return mergeOverlappingMatches(
    candidates
      .slice(0, evaluated)
      .flatMap((candidate): SearchMatch[] => {
        const relevance = scores.get(String(candidate.id));
        return relevance !== undefined && relevance >= RESULT_RELEVANCE_THRESHOLD ? [{ ...candidate, relevance }] : [];
      })
      .sort(
        (left, right) =>
          right.relevance - left.relevance ||
          (left.lexicalRank ?? Number.POSITIVE_INFINITY) - (right.lexicalRank ?? Number.POSITIVE_INFINITY) ||
          left.filePath.localeCompare(right.filePath) ||
          left.startLine - right.startLine,
      ),
  );
}

export function mergeOverlappingMatches(matches: readonly SearchMatch[]): SearchMatch[] {
  const merged: SearchMatch[] = [];
  for (const match of matches) {
    const existing = merged.find(
      (candidate) =>
        candidate.filePath === match.filePath &&
        candidate.startLine <= match.endLine &&
        match.startLine <= candidate.endLine,
    );
    if (!existing) {
      merged.push({ ...match, sources: [...match.sources] });
      continue;
    }
    existing.body = mergeBodies(existing, match);
    existing.startLine = Math.min(existing.startLine, match.startLine);
    existing.endLine = Math.max(existing.endLine, match.endLine);
    existing.relevance = Math.max(existing.relevance, match.relevance);
    existing.rrfScore = Math.max(existing.rrfScore, match.rrfScore);
    existing.fileScore = Math.max(existing.fileScore ?? 0, match.fileScore ?? 0) || undefined;
    existing.lexicalRank = Math.min(
      existing.lexicalRank ?? Number.POSITIVE_INFINITY,
      match.lexicalRank ?? Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(existing.lexicalRank)) existing.lexicalRank = undefined;
    existing.sources.push(...match.sources);
  }
  return merged.sort(
    (left, right) =>
      right.relevance - left.relevance ||
      left.filePath.localeCompare(right.filePath) ||
      left.startLine - right.startLine,
  );
}

function mergeBodies(left: SearchMatch, right: SearchMatch): string {
  const lines = new Map<number, string>();
  for (const match of [left, right]) {
    for (const [offset, text] of match.body.split("\n").entries()) {
      const line = match.startLine + offset;
      const previous = lines.get(line);
      if (previous === undefined || text.length > previous.length) lines.set(line, text);
    }
  }
  const start = Math.min(left.startLine, right.startLine);
  const end = Math.max(left.endLine, right.endLine);
  return Array.from({ length: end - start + 1 }, (_, offset) => lines.get(start + offset) ?? "").join("\n");
}

function queryWithAlternatives(query: string, alternatives: readonly string[]): string {
  if (alternatives.length === 0) return query;
  return `${query}\n\nAlternative phrasings supplied by the caller:\n${alternatives.map((value) => `- ${value}`).join("\n")}`;
}
