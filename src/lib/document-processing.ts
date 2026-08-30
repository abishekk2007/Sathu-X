import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getGeminiClient } from "@/lib/gemini";
import { dedupeInFlight } from "@/lib/cache";

export const runtime = "nodejs";

declare global {
  var pdfjsWorker: { WorkerMessageHandler: unknown } | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CHUNK_CHARS = 1200;
const MIN_CHUNK_CHARS = 100;

/** Minimum non-whitespace characters to consider extraction successful. */
const MIN_EXTRACTED_CHARS = 10;

/** Below this threshold, a PDF is considered low-text and OCR fallback triggers. */
const PDF_LOW_TEXT_THRESHOLD = 50;

/** Gemini model for OCR/vision extraction. */
const OCR_MODEL = "gemini-3.5-flash";

/** Maximum PDF size for inline Gemini OCR (50 MB). */
const GEMINI_INLINE_MAX_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessResult {
  ok: boolean;
  error?: string;
  extractedLength?: number;
  chunkCount?: number;
}

interface ExtractionQuality {
  characterCount: number;
  wordCount: number;
  pageCount: number;
  chunkCount: number;
  extractionMethod: string;
  quality: "HIGH" | "MEDIUM" | "LOW" | "FAILED";
}

interface TextChunk {
  text: string;
  pageNumber: number | null;
  heading?: string | null;
}

// ---------------------------------------------------------------------------
// Main processing pipeline
// ---------------------------------------------------------------------------

/**
 * Process a document end-to-end: download → detect type → extract → normalize → chunk → store.
 * In-flight deduplication ensures concurrent requests for the same document
 * share a single processing operation instead of duplicating work.
 */
export async function processDocument(
  documentId: string,
  userId: string
): Promise<ProcessResult> {
  return dedupeInFlight(`process:${documentId}:${userId}`, () =>
    processDocumentInner(documentId, userId)
  );
}

async function processDocumentInner(
  documentId: string,
  userId: string
): Promise<ProcessResult> {
  const supabase = await getSupabaseServerClient();

  // Load and verify ownership
  const { data: doc, error: loadError } = await supabase
    .from("documents")
    .select("id, user_id, storage_path, mime_type, original_filename, processing_status, updated_at")
    .eq("id", documentId)
    .maybeSingle();

  if (loadError || !doc) {
    console.error("[DocumentProcessing] documentId=%s error=not_found", documentId);
    return { ok: false, error: "Document not found." };
  }
  if (doc.user_id !== userId) {
    console.error("[DocumentProcessing] documentId=%s error=unauthorized", documentId);
    return { ok: false, error: "Document not found." };
  }
  if (doc.processing_status === "ready") {
    console.log("[DocumentProcessing] documentId=%s status=already_ready", documentId);
    return { ok: true, extractedLength: 0, chunkCount: 0 };
  }
  if (doc.processing_status === "extracting" || doc.processing_status === "chunking") {
    // If it's been extracting/chunking for more than 5 minutes, assume the job died and retry
    const updatedAt = new Date(doc.updated_at).getTime();
    const now = Date.now();
    const stalled = now - updatedAt > 5 * 60 * 1000;
    if (stalled) {
      console.log("[DocumentProcessing] documentId=%s status=%s stalled for >5m, forcing retry", documentId, doc.processing_status);
    } else {
      console.log("[DocumentProcessing] documentId=%s status=%s — waiting for existing job", documentId, doc.processing_status);
      return await waitForProcessing(documentId, userId);
    }
  }

  // Mark as extracting
  await supabase
    .from("documents")
    .update({
      processing_status: "extracting",
      status: "processing",
      processing_error: null,
    })
    .eq("id", documentId);

  try {
    // Download from Supabase Storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(doc.storage_path);

    if (downloadError || !fileData) {
      throw new Error("Failed to download document from storage.");
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.log("[DocumentProcessing] documentId=%s downloaded bytes=%d mime=%s", documentId, buffer.length, doc.mime_type);

    if (buffer.length === 0) {
      throw new Error("Downloaded file is empty (0 bytes).");
    }

    // --- Detect actual file type via MIME + magic bytes ---
    const resolvedMime = resolveMimeType(buffer, doc.mime_type, doc.original_filename);
    console.log("[DocumentProcessing] documentId=%s resolvedMime=%s (original=%s)", documentId, resolvedMime, doc.mime_type);

    // --- Extract text using appropriate extractor ---
    let extractedText: string;
    let extractionMethod: string;

    switch (resolvedMime) {
      case "application/pdf":
        const pdfResult = await extractPdfWithFallback(buffer, documentId);
        extractedText = pdfResult.text;
        extractionMethod = pdfResult.method;
        // Phase 5E-2: render PDF pages to images (best-effort, non-blocking)
        await renderPdfPagesInBackground(buffer, documentId, userId);
        break;
      case "image/png":
      case "image/jpeg":
      case "image/webp":
        extractedText = await extractImageText(buffer, resolvedMime);
        extractionMethod = "gemini_vision";
        break;
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        extractedText = await extractDocxText(buffer);
        extractionMethod = "mammoth";
        break;
      case "application/vnd.openxmlformats-officedocument.presentationml.document":
        extractedText = await extractPptxText(buffer);
        extractionMethod = "pptx_parser";
        break;
      case "text/plain":
      case "text/markdown":
        extractedText = extractPlainText(buffer);
        extractionMethod = "utf8";
        break;
      default:
        throw new Error(`Unsupported file type: ${resolvedMime}`);
    }

    // --- Normalize ---
    const normalized = normalizeExtractedText(extractedText);

    // --- Validate ---
    const validation = validateExtractedText(normalized);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    // --- Chunk ---
    const chunks = chunkText(normalized);

    // --- Calculate quality metrics ---
    const quality = calculateQuality(normalized, chunks, extractionMethod);
    console.log("[DocumentProcessing] documentId=%s quality=%s method=%s chars=%d words=%d chunks=%d",
      documentId, quality.quality, quality.extractionMethod,
      quality.characterCount, quality.wordCount, quality.chunkCount);

    // --- Store chunks ---
    await supabase
      .from("document_chunks")
      .delete()
      .eq("document_id", documentId);

    const chunkRows = chunks.map((chunk, index) => ({
      document_id: documentId,
      user_id: userId,
      chunk_index: index,
      content: chunk.text,
      page_number: chunk.pageNumber ?? null,
      char_count: chunk.text.length,
    }));

    if (chunkRows.length > 0) {
      const { error: insertError } = await supabase
        .from("document_chunks")
        .insert(chunkRows);

      if (insertError) {
        console.error("[DocumentProcessing] chunk insert failed:", insertError.message);
        throw new Error("Failed to store extracted text chunks.");
      }
    }

    // --- Mark as ready ---
    const now = new Date().toISOString();
    await supabase
      .from("documents")
      .update({
        processing_status: "ready",
        status: "ready",
        extracted_text: normalized,
        extracted_text_length: normalized.length,
        processed_at: now,
        processing_error: null,
      })
      .eq("id", documentId);

    console.log("[DocumentProcessing] documentId=%s status=ready extractedLength=%d chunks=%d method=%s",
      documentId, normalized.length, chunks.length, extractionMethod);

    return {
      ok: true,
      extractedLength: normalized.length,
      chunkCount: chunks.length,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";

    console.error("[DocumentProcessing] documentId=%s status=failed error=%s", documentId, message);

    await supabase
      .from("documents")
      .update({
        processing_status: "failed",
        status: "failed",
        processing_error: message,
      })
      .eq("id", documentId);

    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Wait for in-progress processing
// ---------------------------------------------------------------------------

async function waitForProcessing(
  documentId: string,
  userId: string
): Promise<ProcessResult> {
  const supabase = await getSupabaseServerClient();
  const MAX_POLLS = 30;
  const POLL_INTERVAL_MS = 1000;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const { data: doc } = await supabase
      .from("documents")
      .select("processing_status, extracted_text_length")
      .eq("id", documentId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!doc) {
      return { ok: false, error: "Document disappeared during processing." };
    }

    if (doc.processing_status === "ready") {
      console.log("[DocumentProcessing] documentId=%s status=ready (waited %d polls)", documentId, i + 1);
      return { ok: true, extractedLength: doc.extracted_text_length ?? 0, chunkCount: 0 };
    }

    if (doc.processing_status === "failed") {
      console.log("[DocumentProcessing] documentId=%s status=failed (waited %d polls)", documentId, i + 1);
      return { ok: false, error: "Background processing failed." };
    }
  }

  console.error("[DocumentProcessing] documentId=%s wait timed out after %d polls", documentId, MAX_POLLS);
  return { ok: false, error: "Processing is taking longer than expected. Please try again." };
}

// ---------------------------------------------------------------------------
// MIME type resolution — does NOT trust only the extension
// ---------------------------------------------------------------------------

function resolveMimeType(buffer: Buffer, declaredMime: string, filename: string): string {
  // Check magic bytes first for the most common types
  const sig = buffer.subarray(0, 8);

  // PDF: %PDF
  if (sig.subarray(0, 4).toString("ascii") === "%PDF") {
    return "application/pdf";
  }

  // ZIP-based formats (DOCX, PPTX, XLSX): PK header
  if (sig[0] === 0x50 && sig[1] === 0x4b) {
    // Differentiate by declared MIME or file extension
    if (declaredMime === "application/vnd.openxmlformats-officedocument.presentationml.document" ||
        filename.toLowerCase().endsWith(".pptx")) {
      return "application/vnd.openxmlformats-officedocument.presentationml.document";
    }
    if (declaredMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        filename.toLowerCase().endsWith(".docx")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    // Default ZIP-based to DOCX if declared as such
    if (declaredMime.includes("wordprocessingml")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (declaredMime.includes("presentationml")) {
      return "application/vnd.openxmlformats-officedocument.presentationml.document";
    }
  }

  // PNG: 89 50 4E 47
  if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff) {
    return "image/jpeg";
  }

  // WebP: RIFF....WEBP
  if (sig.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }

  // Fall back to declared MIME type
  return declaredMime;
}

// ---------------------------------------------------------------------------
// PDF extraction with OCR fallback
// ---------------------------------------------------------------------------

interface PdfExtractionResult {
  text: string;
  method: string;
}

async function extractPdfWithFallback(buffer: Buffer, documentId: string): Promise<PdfExtractionResult> {
  // Validate PDF signature
  const signature = buffer.subarray(0, 4).toString("ascii");
  if (signature !== "%PDF") {
    throw new Error(`Stored document is not a valid PDF buffer (signature: ${JSON.stringify(signature)}).`);
  }

  // Step 1: Try pdfjs-dist text extraction
  const textResult = await extractPdfText(buffer);
  console.log("[DocumentProcessing] documentId=%s pdf text extraction chars=%d", documentId, textResult.length);

  // Step 2: If text is healthy, use it directly
  if (textResult.length >= PDF_LOW_TEXT_THRESHOLD) {
    return { text: textResult, method: "pdfjs_text" };
  }

  // Step 3: Low text — try OCR fallback via Gemini
  console.log("[DocumentProcessing] documentId=%s ocr fallback required=true (text chars=%d)", documentId, textResult.length);

  if (buffer.length > GEMINI_INLINE_MAX_BYTES) {
    // Too large for inline — try File API
    const ocrResult = await ocrPdfViaGeminiFileApi(buffer, documentId);
    if (ocrResult.length >= MIN_EXTRACTED_CHARS) {
      return { text: ocrResult, method: "gemini_ocr_fileapi" };
    }
  } else {
    const ocrResult = await ocrPdfViaGeminiInline(buffer, documentId);
    if (ocrResult.length >= MIN_EXTRACTED_CHARS) {
      return { text: ocrResult, method: "gemini_ocr_inline" };
    }
  }

  // Step 4: If OCR also failed but we got some text from pdfjs, use it
  if (textResult.length >= MIN_EXTRACTED_CHARS) {
    console.log("[DocumentProcessing] documentId=%s using minimal pdfjs text (chars=%d)", documentId, textResult.length);
    return { text: textResult, method: "pdfjs_text_minimal" };
  }

  // Step 5: Complete failure
  throw new Error("PDF text extraction returned no usable text and OCR fallback could not extract content. The document may be image-only or corrupted.");
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  // Register pdfjs-dist worker for Node.js
  if (!globalThis.pdfjsWorker) {
    const workerModule = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    globalThis.pdfjsWorker = { WorkerMessageHandler: workerModule.WorkerMessageHandler };
  }

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer);

  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    standardFontDataUrl: await import("node:path").then((p) => {
      let fontPath = p.join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts/");
      fontPath = fontPath.replace(/\\/g, "/");
      if (!fontPath.endsWith("/")) fontPath += "/";
      return fontPath;
    }),
  }).promise;

  try {
    const pageTexts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      if (text.trim().length > 0) {
        pageTexts.push(`[PAGE ${i}]\n${text}`);
      }
    }
    return pageTexts.join("\n\n");
  } finally {
    await doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// Phase 5E-2: PDF page rendering to PNG images
// ---------------------------------------------------------------------------

/**
 * Render PDF pages to PNG images and store them as visual_assets.
 * Best-effort: failures are logged but do not block document processing.
 * Returns the total page count rendered (or null on failure).
 */
async function renderPdfPagesInBackground(
  buffer: Buffer,
  documentId: string,
  userId: string
): Promise<number | null> {
  try {
    const { renderPdfPages } = await import("@/lib/multimodal/pdf-page-renderer");

    const outcome = await renderPdfPages(buffer, documentId, userId);

    if (outcome.ok) {
      console.log(
        "[DocumentProcessing] documentId=%s pdfPages rendered=%d/%d",
        documentId, outcome.renderedPages, outcome.totalPages
      );
      return outcome.renderedPages;
    }

    console.warn(
      "[DocumentProcessing] documentId=%s pdfPages render_partial=%s",
      documentId, outcome.error
    );
    return outcome.renderedPages;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(
      "[DocumentProcessing] documentId=%s pdfPages render_failed: %s",
      documentId, msg
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gemini OCR — inline (for PDFs up to 50 MB)
// ---------------------------------------------------------------------------

async function ocrPdfViaGeminiInline(buffer: Buffer, documentId: string): Promise<string> {
  const client = getGeminiClient();
  if (!client) {
    console.error("[PDFOCR] Gemini client not available, skipping OCR");
    return "";
  }

  console.log("[PDFOCR] inline bytes=%d documentId=%s", buffer.length, documentId);

  const base64Data = buffer.toString("base64");

  try {
    const response = await client.models.generateContent({
      model: OCR_MODEL,
      contents: [
        {
          text: "Extract ALL text from this PDF document. " +
            "Preserve the document structure: headings, paragraphs, numbered lists, " +
            "tables (in readable text format), and any other content. " +
            "Insert [PAGE X] on a new line before the content of each page, where X is the page number. " +
            "Return ONLY the extracted text, no commentary or analysis."
        },
        {
          inlineData: {
            mimeType: "application/pdf",
            data: base64Data,
          },
        },
      ],
    });

    const text = response.text ?? "";
    console.log("[PDFOCR] inline result chars=%d documentId=%s", text.length, documentId);
    return text;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[PDFOCR] inline failed documentId=%s error=%s", documentId, msg);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Gemini OCR — File API (for large PDFs)
// ---------------------------------------------------------------------------

async function ocrPdfViaGeminiFileApi(buffer: Buffer, documentId: string): Promise<string> {
  const client = getGeminiClient();
  if (!client) {
    console.error("[PDFOCR] Gemini client not available, skipping File API OCR");
    return "";
  }

  console.log("[PDFOCR] fileapi bytes=%d documentId=%s", buffer.length, documentId);

  try {
    const blob = new Blob([new Uint8Array(buffer)], { type: "application/pdf" });

    const file = await client.files.upload({
      file: blob,
      config: { mimeType: "application/pdf" },
    });

    // Wait for processing
    let getFile = await client.files.get({ name: file.name ?? "" });
    const MAX_WAIT = 12;
    for (let i = 0; i < MAX_WAIT; i++) {
      if (getFile.state !== "PROCESSING") break;
      await new Promise((r) => setTimeout(r, 5000));
      getFile = await client.files.get({ name: file.name ?? "" });
    }

    if (getFile.state === "FAILED") {
      console.error("[PDFOCR] fileapi processing failed documentId=%s", documentId);
      return "";
    }

    if (!file.uri || !file.mimeType) {
      console.error("[PDFOCR] fileapi missing uri/mimeType documentId=%s", documentId);
      return "";
    }

    const { createPartFromUri } = await import("@google/genai");

    const response = await client.models.generateContent({
      model: OCR_MODEL,
      contents: [
        {
          text: "Extract ALL text from this PDF document. " +
            "Preserve the document structure: headings, paragraphs, numbered lists, " +
            "tables (in readable text format), and any other content. " +
            "Insert [PAGE X] on a new line before the content of each page, where X is the page number. " +
            "Return ONLY the extracted text, no commentary or analysis."
        },
        createPartFromUri(file.uri, file.mimeType),
      ],
    });

    const text = response.text ?? "";
    console.log("[PDFOCR] fileapi result chars=%d documentId=%s", text.length, documentId);

    // Cleanup: delete uploaded file
    await client.files.delete({ name: file.name ?? "" }).catch(() => {});

    return text;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[PDFOCR] fileapi failed documentId=%s error=%s", documentId, msg);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Image OCR via Gemini
// ---------------------------------------------------------------------------

async function extractImageText(buffer: Buffer, mimeType: string): Promise<string> {
  const client = getGeminiClient();
  if (!client) {
    throw new Error("Gemini API key is not configured. Cannot perform image OCR.");
  }

  console.log("[ImageOCR] starting bytes=%d mime=%s", buffer.length, mimeType);

  const base64Data = buffer.toString("base64");

  try {
    const response = await client.models.generateContent({
      model: OCR_MODEL,
      contents: [
        {
          text: "Extract ALL text from this image. " +
            "Preserve the structure: headings, paragraphs, numbered lists, " +
            "tables (in readable text format), and any visible content. " +
            "Return ONLY the extracted text, no commentary or analysis."
        },
        {
          inlineData: {
            mimeType,
            data: base64Data,
          },
        },
      ],
    });

    const text = response.text ?? "";
    console.log("[ImageOCR] completed chars=%d", text.length);

    if (text.trim().length < MIN_EXTRACTED_CHARS) {
      throw new Error("Image OCR returned no usable text. The image may not contain readable text.");
    }

    return text;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[ImageOCR] failed: %s", msg);
    throw new Error(`Image text extraction failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// DOCX extraction via mammoth
// ---------------------------------------------------------------------------

async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? "";
}

// ---------------------------------------------------------------------------
// PPTX extraction via jszip (PPTX = ZIP of XML files)
// ---------------------------------------------------------------------------

async function extractPptxText(buffer: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort();

  const slides: string[] = [];

  for (const slideFile of slideFiles) {
    const xml = await zip.files[slideFile].async("string");
    const slideNumber = Number.parseInt(
      slideFile.match(/slide(\d+)\.xml/)?.[1] ?? "0",
      10
    );
    const text = extractTextFromSlideXml(xml);
    if (text.trim()) {
      slides.push(`[PAGE ${slideNumber}]\n${text.trim()}`);
    }
  }

  return slides.join("\n\n");
}

function extractTextFromSlideXml(xml: string): string {
  const texts: string[] = [];
  const tagRegex = /<a:t[^>]*>([^<]*)<\/a:t>/g;
  let match = tagRegex.exec(xml);
  while (match !== null) {
    const decoded = decodeXmlEntities(match[1]);
    if (decoded.trim()) texts.push(decoded.trim());
    match = tagRegex.exec(xml);
  }
  return texts.join(" ");
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

// ---------------------------------------------------------------------------
// Plain text extraction
// ---------------------------------------------------------------------------

function extractPlainText(buffer: Buffer): string {
  return buffer.toString("utf-8");
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

function normalizeExtractedText(text: string): string {
  return (
    text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/[^\S\n]{2,}/g, " ")
      .trim()
  );
}

function validateExtractedText(text: string): { ok: boolean; error?: string } {
  if (!text || text.trim().length === 0) {
    return { ok: false, error: "No extractable text found in this document." };
  }
  const stripped = text.replace(/\s/g, "");
  if (stripped.length < MIN_EXTRACTED_CHARS) {
    return {
      ok: false,
      error: "Document contains too little extractable text.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Quality metrics
// ---------------------------------------------------------------------------

function calculateQuality(
  text: string,
  chunks: TextChunk[],
  method: string
): ExtractionQuality {
  const characterCount = text.length;
  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;

  // Count unique pages
  const pages = new Set(chunks.map((c) => c.pageNumber).filter((p) => p != null));
  const pageCount = pages.size || 1;

  let quality: ExtractionQuality["quality"] = "HIGH";
  if (characterCount < 100) quality = "LOW";
  else if (characterCount < 500) quality = "MEDIUM";

  return {
    characterCount,
    wordCount,
    pageCount,
    chunkCount: chunks.length,
    extractionMethod: method,
    quality,
  };
}

// ---------------------------------------------------------------------------
// Universal chunking
// ---------------------------------------------------------------------------

/**
 * Splits normalized text into chunks respecting structural boundaries:
 * headings, paragraphs, numbered sections, bullet lists, question patterns,
 * and sentences. Preserves chunk order.
 */
export function chunkText(text: string): TextChunk[] {
  const pageMatch = text.match(/\[PAGE (\d+)\]/);
  const initialPage = pageMatch ? parseInt(pageMatch[1], 10) : null;

  if (text.length <= MAX_CHUNK_CHARS) {
    return [{ text, pageNumber: initialPage }];
  }

  const chunks: TextChunk[] = [];
  const blocks = splitIntoBlocks(text);
  let current = "";
  let currentPage: number | null = null;

  const pushChunk = (chunkText: string) => {
    // Determine the page number for this chunk based on its content or the last known page
    let chunkPage = currentPage;
    const matches = [...chunkText.matchAll(/\[PAGE (\d+)\]/g)];
    if (matches.length > 0) {
      chunkPage = parseInt(matches[matches.length - 1][1], 10);
    }
    chunks.push({ text: chunkText.trim(), pageNumber: chunkPage });
    currentPage = chunkPage;
  };

  for (const block of blocks) {
    if (block.trim().length === 0) continue;

    // Update current page if the block introduces a new one
    const pageMatches = [...block.matchAll(/\[PAGE (\d+)\]/g)];
    if (pageMatches.length > 0) {
      currentPage = parseInt(pageMatches[pageMatches.length - 1][1], 10);
    }

    if (current.length + block.length + 2 <= MAX_CHUNK_CHARS) {
      current = current ? `${current}\n\n${block}` : block;
    } else {
      if (current.length >= MIN_CHUNK_CHARS) {
        pushChunk(current);
        current = "";
      }
      if (block.length > MAX_CHUNK_CHARS) {
        // Split oversized block on structural boundaries, then sentences
        const subChunks = splitOversizedBlock(block);
        for (const sub of subChunks) {
          if (current.length + sub.length + 1 <= MAX_CHUNK_CHARS) {
            current = current ? `${current}\n${sub}` : sub;
          } else {
            if (current.length >= MIN_CHUNK_CHARS) {
              pushChunk(current);
              current = "";
            }
            if (sub.length > MAX_CHUNK_CHARS) {
              const forceSplit = forceSplitText(sub);
              for (const piece of forceSplit) {
                if (current.length + piece.length + 1 <= MAX_CHUNK_CHARS) {
                  current = current ? `${current} ${piece}` : piece;
                } else {
                  if (current.length >= MIN_CHUNK_CHARS) {
                    pushChunk(current);
                    current = "";
                  }
                  current = piece;
                }
              }
            } else {
              current = sub;
            }
          }
        }
      } else {
        current = block;
      }
    }
  }

  if (current.length > 0) {
    pushChunk(current);
  }

  return chunks;
}

/**
 * Split text into logical blocks by structural boundaries.
 * Supports headings, numbered sections, question patterns, bullet lists.
 */
function splitIntoBlocks(text: string): string[] {
  // Split on double newlines first (paragraph boundaries)
  const raw = text.split(/\n{2,}/);
  const blocks: string[] = [];

  for (const para of raw) {
    if (para.trim().length === 0) continue;

    // If paragraph is small, keep as-is
    if (para.length <= MAX_CHUNK_CHARS) {
      blocks.push(para);
      continue;
    }

    // Try splitting on structural boundaries
    const splits = splitOnStructuralBoundaries(para);
    if (splits.length > 1) {
      blocks.push(...splits.filter((s) => s.trim().length > 0));
    } else {
      blocks.push(para);
    }
  }

  return blocks;
}

/**
 * Split a large paragraph on structural boundaries:
 * - Headings (# or ALL CAPS lines)
 * - Numbered sections (1., 2., etc.)
 * - Question patterns (Question N, QN)
 * - Bullet lists (-, *, •)
 */
function splitOnStructuralBoundaries(text: string): string[] {
  const pattern =
    /(?=(?:^|\n)\s*(?:#{1,6}\s|(?:\d{1,3}\s*[.)]\s)|(?:Question\s+\d)|(?:Q\s*\d)|(?:[-*•]\s)|(?:[A-Z][A-Z\s]{3,}(?:\n|$))))/;

  const parts = text.split(pattern);
  return parts.filter((p) => p.trim().length > 0);
}

/**
 * Split an oversized block: try sentences, then force-split on word boundaries.
 */
function splitOversizedBlock(block: string): string[] {
  // Try sentence splitting first
  const sentences = block.split(/(?<=[.!?])\s+/);
  if (sentences.length > 1) {
    return sentences;
  }
  // No sentence boundaries — force split
  return forceSplitText(block);
}

/**
 * Force-split text into pieces that fit within MAX_CHUNK_CHARS,
 * splitting on word boundaries.
 */
function forceSplitText(text: string): string[] {
  const pieces: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_CHUNK_CHARS) {
    const splitAt = remaining.lastIndexOf(" ", MAX_CHUNK_CHARS);
    const cutAt = splitAt > MIN_CHUNK_CHARS ? splitAt : MAX_CHUNK_CHARS;
    pieces.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }

  if (remaining.length > 0) {
    pieces.push(remaining);
  }

  return pieces;
}
