// ---------------------------------------------------------------------------
// Agent retrieval orchestrator — dispatches retrieval across source types.
// Phase 5C: Multi-source reranking, diversity filtering, improved confidence.
// Phase 5D: Multi-source intelligence orchestration.
// ---------------------------------------------------------------------------

import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  retrieveDocumentChunks,
  type RetrievalChunk,
} from "@/lib/document-retrieval";
import {
  analyzeQuery,
  scoreChunk,
  buildChunkTokenSets,
  computeScoreGap,
} from "@/lib/retrieval";
import type { QueryAnalysis } from "@/lib/retrieval";
import type { ScoredChunk } from "@/lib/retrieval";
import { VISUAL_QUERY_SIGNALS } from "@/lib/multimodal";
import { queryAnalysisCache, visualAssetCache } from "@/lib/cache";
import type {
  AgentSource,
  RetrievalRequest,
  RetrievalResult,
} from "./types";
import {
  orchestrateMultiSourceRetrieval,
} from "./multi-source";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHUNKS = 8;
const DEFAULT_MAX_CHARS = 12_000;
const PASTE_CHUNK_MAX = 1200;
const PASTE_CHUNK_MIN = 100;

// ---------------------------------------------------------------------------
// Document retrieval (wraps document-retrieval.ts)
// ---------------------------------------------------------------------------

async function retrieveFromDocument(
  source: AgentSource,
  query: string,
  userId: string,
  maxChunks: number,
  maxChars: number
): Promise<RetrievalResult[]> {
  const result = await retrieveDocumentChunks({
    documentId: source.id,
    userId,
    question: query,
    maxChunks,
    maxChars,
  });
  if (!result) return [];

  console.log(
    `[agent] document ${source.id} chunks=${result.chunks.length} total=${result.totalChunks} confidence=${result.confidence} best=${result.chunks[0]?.score ?? 0}`
  );

  const agentResults: RetrievalResult[] = result.chunks.map((chunk: RetrievalChunk) => ({
    sourceId: source.id,
    sourceType: "document" as const,
    sourceName: result.originalFilename || result.documentName,
    content: chunk.text,
    score: chunk.score,
    confidence: result.confidence,
    metadata: {
      pageNumber: chunk.pageNumber,
      structuralMatch: result.structuralMatch,
    },
    signals: chunk.signals,
  }));

  // Phase 5E-1: If visual assets exist, check for visual-element queries
  // and augment results with visual evidence metadata.
  const visualAssets = await getVisualAssets(source.id, userId);
  if (visualAssets.length > 0) {
    const augmentation = detectVisualAugmentation(query, visualAssets);
    if (augmentation) {
      const bestChunk = agentResults[0];
      if (bestChunk) {
        const prev: Record<string, unknown> = bestChunk.metadata ?? {};
        bestChunk.metadata = {
          ...prev,
          hasVisualAsset: true,
          visualStoragePath: augmentation.storagePath,
          visualWidth: augmentation.width,
          visualHeight: augmentation.height,
          visualAssetType: augmentation.assetType,
          pageNumber: augmentation.pageNumber,
        };
        bestChunk.score += 0.05;
      }
    }
  }

  return agentResults;
}

// ---------------------------------------------------------------------------
// Pasted text retrieval — chunk on-the-fly, score with same algorithm
// ---------------------------------------------------------------------------

interface PastedSourceRow {
  id: string;
  content_text: string;
  name: string | null;
}

async function retrieveFromPastedText(
  source: AgentSource,
  query: string,
  userId: string
): Promise<RetrievalResult[]> {
  const supabase = await getSupabaseServerClient();

  const { data: row } = await supabase
    .from("context_sources")
    .select("id, content_text, name")
    .eq("id", source.id)
    .eq("user_id", userId)
    .eq("type", "pasted_text")
    .maybeSingle();

  if (!row || !row.content_text) return [];

  const text = (row as PastedSourceRow).content_text;
  const name = (row as PastedSourceRow).name ?? "Pasted notes";

  // Chunk the pasted text
  const textChunks = chunkPastedText(text);

  // Analyze the query
  const analysis = analyzeQuery(query);

  // Score each chunk using the same multi-signal scoring
  const chunkObjects = textChunks.map((content, index) => ({
    id: `paste-${source.id}-${index}`,
    content,
    chunk_index: index,
    page_number: null as number | null,
  }));

  const chunkTokenSets = buildChunkTokenSets(chunkObjects);
  const scored: ScoredChunk[] = chunkObjects.map((chunk) =>
    scoreChunk(chunk, analysis, chunkTokenSets)
  );

  scored.sort((a, b) => b.score - a.score);

  // Take top results, then re-sort by original order
  const top = scored.slice(0, 8);
  top.sort((a, b) => a.chunkIndex - b.chunkIndex);

  return top.map((c) => ({
    sourceId: source.id,
    sourceType: "pasted_text" as const,
    sourceName: name,
    content: c.text,
    score: c.score,
    metadata: {},
    signals: c.signals,
  }));
}

// ---------------------------------------------------------------------------
// Chunking helpers for pasted text
// ---------------------------------------------------------------------------

function chunkPastedText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (normalized.length <= PASTE_CHUNK_MAX) return [normalized];

  const chunks: string[] = [];
  const paragraphs = normalized.split(/\n{2,}/);
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.trim().length === 0) continue;

    if (current.length + paragraph.length + 2 <= PASTE_CHUNK_MAX) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    } else {
      if (current.length >= PASTE_CHUNK_MIN) {
        chunks.push(current);
        current = "";
      }
      if (paragraph.length > PASTE_CHUNK_MAX) {
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 <= PASTE_CHUNK_MAX) {
            current = current ? `${current} ${sentence}` : sentence;
          } else {
            if (current.length >= PASTE_CHUNK_MIN) {
              chunks.push(current);
              current = "";
            }
            if (sentence.length > PASTE_CHUNK_MAX) {
              let remaining = sentence;
              while (remaining.length > PASTE_CHUNK_MAX) {
                const splitAt = remaining.lastIndexOf(" ", PASTE_CHUNK_MAX);
                const cutAt = splitAt > PASTE_CHUNK_MIN ? splitAt : PASTE_CHUNK_MAX;
                chunks.push(remaining.slice(0, cutAt));
                remaining = remaining.slice(cutAt).trimStart();
              }
              current = remaining;
            } else {
              current = sentence;
            }
          }
        }
      } else {
        current = paragraph;
      }
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Image retrieval — loads image metadata and prepares visual evidence
// ---------------------------------------------------------------------------

interface ImageSourceRow {
  id: string;
  name: string | null;
  storage_path: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  image_width: number | null;
  image_height: number | null;
  metadata: Record<string, unknown> | null;
}

interface VisualAssetInfo {
  assetType: string;
  pageNumber: number | null;
  storagePath: string;
  width: number | null;
  height: number | null;
}

interface VisualAssetFilters {
  pageNumber?: number;
  assetType?: string;
  limit?: number;
}

/**
 * Retrieve visual assets for a document with optional filters.
 * Returns empty array if no assets exist or on error.
 */
async function getVisualAssets(
  documentId: string,
  userId: string,
  filters?: VisualAssetFilters
): Promise<VisualAssetInfo[]> {
  // Only use L2 cache for unfiltered lookups (most common path)
  const cacheKey = `${userId}:${documentId}`;
  if (!filters) {
    const cached = visualAssetCache.get(cacheKey) as VisualAssetInfo[] | undefined;
    if (cached) return cached;
  }

  try {
    const supabase = await getSupabaseServerClient();

    let query = supabase
      .from("visual_assets")
      .select("asset_type, page_number, storage_path, width, height")
      .eq("document_id", documentId)
      .eq("user_id", userId)
      .eq("processing_status", "ready");

    if (filters?.assetType) {
      query = query.eq("asset_type", filters.assetType);
    }
    if (filters?.pageNumber != null) {
      query = query.eq("page_number", filters.pageNumber);
    }

    query = query
      .order("page_number", { ascending: true })
      .limit(filters?.limit ?? 100);

    const { data: assets } = await query;

    if (!assets || assets.length === 0) {
      if (!filters) visualAssetCache.set(cacheKey, []);
      return [];
    }

    const result = assets
      .filter((a) => a.storage_path != null)
      .map((a) => ({
        assetType: a.asset_type ?? "unknown",
        pageNumber: a.page_number,
        storagePath: a.storage_path,
        width: a.width,
        height: a.height,
      }));

    if (!filters) visualAssetCache.set(cacheKey, result);
    return result;
  } catch (error) {
    console.warn(
      "[agent] getVisualAssets failed for document %s: %s",
      documentId,
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Visual query detection — matches query against available visual assets
// ---------------------------------------------------------------------------

interface VisualAugmentation {
  storagePath: string;
  assetType: string;
  pageNumber: number | null;
  width: number | null;
  height: number | null;
}

/**
 * Detect which visual asset (if any) to augment the query results with.
 * Checks page references, figure references, diagram references, etc.
 * Returns null if no visual asset matches the query intent.
 */
function detectVisualAugmentation(
  query: string,
  assets: VisualAssetInfo[]
): VisualAugmentation | null {
  // 1. Exact page reference
  const pageMatch = query.match(VISUAL_QUERY_SIGNALS.pageRef);
  if (pageMatch) {
    const targetPage = Number.parseInt(pageMatch[1], 10);
    const match = assets.find(
      (a) => a.pageNumber === targetPage && a.assetType === "page_image"
    );
    if (match) return match;
  }

  // 2. Figure reference — look for figure/thumbnail assets on that page
  const figMatch = query.match(VISUAL_QUERY_SIGNALS.figureRef);
  if (figMatch) {
    const targetPage = Number.parseInt(figMatch[1], 10);
    const match =
      assets.find((a) => a.pageNumber === targetPage && a.assetType === "figure") ??
      assets.find((a) => a.pageNumber === targetPage);
    if (match) return match;
  }

  // 3. Diagram reference
  const diagMatch = query.match(VISUAL_QUERY_SIGNALS.diagramRef);
  if (diagMatch) {
    const targetPage = Number.parseInt(diagMatch[1], 10);
    const match =
      assets.find((a) => a.pageNumber === targetPage && a.assetType === "diagram") ??
      assets.find((a) => a.pageNumber === targetPage);
    if (match) return match;
  }

  // 4. Chart reference
  const chartMatch = query.match(VISUAL_QUERY_SIGNALS.chartRef);
  if (chartMatch) {
    const targetPage = Number.parseInt(chartMatch[1], 10);
    const match =
      assets.find((a) => a.pageNumber === targetPage && a.assetType === "chart") ??
      assets.find((a) => a.pageNumber === targetPage);
    if (match) return match;
  }

  // 5. Table reference
  const tableMatch = query.match(VISUAL_QUERY_SIGNALS.tableRef);
  if (tableMatch) {
    const targetPage = Number.parseInt(tableMatch[1], 10);
    const match =
      assets.find((a) => a.pageNumber === targetPage && a.assetType === "table") ??
      assets.find((a) => a.pageNumber === targetPage);
    if (match) return match;
  }

  // 6. Generic image reference
  const imgMatch = query.match(VISUAL_QUERY_SIGNALS.imageRef);
  if (imgMatch) {
    const targetPage = Number.parseInt(imgMatch[1], 10);
    const match = assets.find((a) => a.pageNumber === targetPage);
    if (match) return match;
  }

  // 7. Scanned/OCR reference — return first page_image if available
  if (VISUAL_QUERY_SIGNALS.scannedRef.test(query)) {
    const match = assets.find((a) => a.assetType === "page_image");
    if (match) return match;
  }

  return null;
}

async function retrieveFromImage(
  source: AgentSource,
  userId: string
): Promise<RetrievalResult[]> {
  const supabase = await getSupabaseServerClient();

  const { data: row } = await supabase
    .from("context_sources")
    .select("id, name, storage_path, mime_type, file_size_bytes, image_width, image_height, metadata")
    .eq("id", source.id)
    .eq("user_id", userId)
    .eq("type", "image")
    .maybeSingle();

  if (!row) return [];

  const img = row as ImageSourceRow;
  const name = img.name ?? source.name ?? "Image";

  // Build a descriptive text passage from image metadata.
  // Phase 5E-2 will extend this to include OCR text and Gemini visual analysis.
  const meta = img.metadata ?? {};
  const descriptionParts: string[] = [];

  descriptionParts.push(`[Visual Source: ${name}]`);
  descriptionParts.push(`Type: Image (${img.mime_type ?? "unknown"})`);

  if (img.image_width && img.image_height) {
    descriptionParts.push(`Dimensions: ${img.image_width}x${img.image_height} pixels`);
  }
  if (img.file_size_bytes) {
    const sizeMB = (img.file_size_bytes / (1024 * 1024)).toFixed(1);
    descriptionParts.push(`Size: ${sizeMB} MB`);
  }
  if (img.storage_path) {
    descriptionParts.push(`Storage: ${img.storage_path}`);
  }

  // Include any additional metadata from upload
  if (meta.originalFilename && meta.originalFilename !== name) {
    descriptionParts.push(`Original filename: ${String(meta.originalFilename)}`);
  }

  const content = descriptionParts.join("\n");

  console.log(
    "[agent] image %s mime=%s dims=%dx%d storage=%s",
    source.id,
    img.mime_type,
    img.image_width ?? 0,
    img.image_height ?? 0,
    img.storage_path ?? "none"
  );

  return [
    {
      sourceId: source.id,
      sourceType: "image" as const,
      sourceName: name,
      content,
      score: 1.0, // Base score — Phase 5E-2 will add visual relevance scoring
      confidence: "medium" as const,
      metadata: {
        storagePath: img.storage_path,
        mimeType: img.mime_type,
        width: img.image_width,
        height: img.image_height,
        fileSize: img.file_size_bytes,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Main retrieval orchestrator — Phase 5C + Phase 5D
// ---------------------------------------------------------------------------

/**
 * Retrieves evidence from all attached sources, bounded by maxChars total.
 * For multiple sources, uses the Phase 5D multi-source orchestrator.
 * For single sources, uses the existing Phase 5C retrieval.
 */
export async function retrieveAgentContext(
  request: RetrievalRequest,
  userId: string
): Promise<RetrievalResult[]> {
  // Phase 5D: multi-source orchestration
  if (request.sources.length > 1) {
    const multiResult = await orchestrateMultiSourceRetrieval(
      request.query,
      request.sources,
      userId
    );
    return multiResult.results;
  }

  // Phase 5C: single-source retrieval (existing logic)
  // Analyze the query once for all sources (L2 cached for identical queries)
  const analysisCacheKey = request.query.toLowerCase().trim();
  let analysis: QueryAnalysis;
  const cached = queryAnalysisCache.get(analysisCacheKey) as QueryAnalysis | undefined;
  if (cached) {
    analysis = cached;
  } else {
    analysis = analyzeQuery(request.query);
    queryAnalysisCache.set(analysisCacheKey, analysis);
  }
  console.log(
    `[QueryAnalysis] intent=${analysis.intent} tokens=${analysis.importantTokens.length} references=${JSON.stringify(analysis.entities)} scopeQuery=${analysis.scopeQuery}`
  );

  // Use higher limits for scope queries to avoid re-truncating scope retrieval results
  const maxChunks = analysis.scopeQuery
    ? (request.maxChunks ?? 20)
    : (request.maxChunks ?? DEFAULT_MAX_CHUNKS);
  const maxChars = analysis.scopeQuery
    ? (request.maxChars ?? 24_000)
    : (request.maxChars ?? DEFAULT_MAX_CHARS);

  const allResults: RetrievalResult[] = [];

  // Retrieve from each source in parallel
  const promises = request.sources.map(async (source) => {
    switch (source.type) {
      case "document":
        return retrieveFromDocument(source, request.query, userId, maxChunks, maxChars);
      case "pasted_text":
        return retrieveFromPastedText(source, request.query, userId);
      case "image":
        return retrieveFromImage(source, userId);
      default:
        return [];
    }
  });

  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === "fulfilled") {
      allResults.push(...result.value);
    } else {
      console.error("[agent] retrieval failed:", result.reason);
    }
  }

  // Sort by score descending
  allResults.sort((a, b) => b.score - a.score);

  // Multi-source reranking: normalize scores across sources
  const reranked = performMultiSourceReranking(allResults);

  // Log per-source stats
  const bySource = new Map<string, { count: number; bestScore: number }>();
  for (const r of reranked) {
    const existing = bySource.get(r.sourceName) ?? { count: 0, bestScore: 0 };
    existing.count++;
    if (r.score > existing.bestScore) existing.bestScore = r.score;
    bySource.set(r.sourceName, existing);
  }
  for (const [name, stats] of bySource) {
    console.log(
      `[SourceRanking] source=${name} count=${stats.count} bestScore=${stats.bestScore}`
    );
  }

  // Bound total characters directly on RetrievalResult
  const bounded: RetrievalResult[] = [];
  let totalChars = 0;
  for (const r of reranked) {
    if (bounded.length >= maxChunks) break;
    if (totalChars + r.content.length > maxChars && bounded.length > 0) break;
    bounded.push(r);
    totalChars += r.content.length;
  }

  // Determine overall confidence using score gap analysis
  const scoreGap = computeScoreGap(
    bounded.map((r) => ({
      id: r.sourceId,
      text: r.content,
      score: r.score,
      pageNumber: null,
      chunkIndex: 0,
      signals: {
        exactPhrase: 0,
        quotedPhrase: 0,
        structuralRef: 0,
        headingMatch: 0,
        tokenOverlap: 0,
        coverage: 0,
        proximity: 0,
        pageMatch: 0,
        headingPhrase: 0,
        hierarchicalStructural: 0,
        structuralMismatch: false,
      },
    }))
  );

  const confidence = computeMultiSourceConfidence(scoreGap, bounded);

  console.log(
    `[RetrievalConfidence] confidence=${confidence} bestScore=${scoreGap.best} secondScore=${scoreGap.second} gap=${scoreGap.gap} chunks=${bounded.length}`
  );

  console.log(
    `[ContextAssembly] selectedChunks=${bounded.length} sources=${bySource.size} chars=${bounded.reduce((sum, r) => sum + r.content.length, 0)}`
  );

  return bounded;
}

// ---------------------------------------------------------------------------
// Multi-source reranking with normalization (Phase 5C)
// ---------------------------------------------------------------------------

function performMultiSourceReranking(
  results: RetrievalResult[]
): RetrievalResult[] {
  if (results.length <= 1) return results;

  // Group by source
  const bySource = new Map<string, RetrievalResult[]>();
  for (const r of results) {
    const existing = bySource.get(r.sourceId) ?? [];
    existing.push(r);
    bySource.set(r.sourceId, existing);
  }

  // If only one source, no normalization needed
  if (bySource.size <= 1) return results;

  // Find global max score
  let globalMax = 0;
  for (const r of results) {
    if (r.score > globalMax) globalMax = r.score;
  }
  if (globalMax === 0) return results;

  // Normalize: dampen sources whose best score is much lower than the global best
  const normalized: RetrievalResult[] = [];
  for (const [, sourceResults] of bySource) {
    const sourceMax = Math.max(...sourceResults.map((r) => r.score));
    const crossSourceNorm = sourceMax / globalMax;
    // Floor: even weak sources keep 30% of their score
    const dampening = Math.max(0.3, crossSourceNorm);

    for (const r of sourceResults) {
      normalized.push({
        ...r,
        score: Math.round(r.score * (0.6 + 0.4 * dampening)),
      });
    }
  }

  normalized.sort((a, b) => b.score - a.score);
  return normalized;
}

// ---------------------------------------------------------------------------
// Multi-source confidence calculation
// ---------------------------------------------------------------------------

function computeMultiSourceConfidence(
  scoreGap: { best: number; second: number; gap: number; ratio: number },
  results: RetrievalResult[]
): "high" | "medium" | "low" | "none" {
  const best = scoreGap.best;
  if (best === 0) return "none";

  // Check if any result has structural/exact match
  const hasStructural = results.some((r) => (r.signals?.structuralRef ?? 0) > 0);
  const hasExactPhrase = results.some((r) => (r.signals?.exactPhrase ?? 0) > 0);

  if (hasStructural || hasExactPhrase) return "high";

  if (best >= 120 && scoreGap.gap >= 40) return "high";
  if (best >= 60) return "medium";
  if (best > 0) return "low";
  return "none";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Formats retrieval results into a string suitable for the system prompt.
 * Groups passages by source.
 */
export function formatAgentRetrievalContext(results: RetrievalResult[]): string {
  if (results.length === 0) return "";

  // Group by source
  const bySource = new Map<string, RetrievalResult[]>();
  for (const r of results) {
    const existing = bySource.get(r.sourceId) ?? [];
    existing.push(r);
    bySource.set(r.sourceId, existing);
  }

  const lines: string[] = [];
  let sourceIndex = 0;

  for (const [, sourceResults] of bySource) {
    sourceIndex++;
    const sourceName = sourceResults[0].sourceName;
    const icon = sourceResults[0].sourceType === "pasted_text" ? "📋" : "📄";

    for (let i = 0; i < sourceResults.length; i++) {
      const r = sourceResults[i];
      const pageInfo =
        r.metadata?.pageNumber != null
          ? ` (page ${r.metadata.pageNumber})`
          : "";
      lines.push(
        `[${icon} Source ${sourceIndex}${i > 0 ? `, passage ${i + 1}` : ""}${pageInfo}] ${sourceName}:`
      );
      lines.push(r.content);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
