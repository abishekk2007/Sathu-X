// ---------------------------------------------------------------------------
// PDF Page Rendering — Phase 5E-2
// Renders PDF pages to PNG images using pdfjs-dist + @napi-rs/canvas.
// Stores rendered pages in Supabase Storage and creates visual_assets records.
// Uses dynamic imports for @napi-rs/canvas to avoid Turbopack ESM bundling issues
// with native Node.js modules.
//
// Type notes:
// - pdfjs-dist v5 TS types don't include canvasFactory in DocumentInitParameters,
//   but the runtime supports it. We use type assertions where needed.
// - @napi-rs/canvas SKRSContext2D lacks drawFocusIfNeeded which pdfjs-dist expects
//   on CanvasRenderingContext2D. We cast context for the render() call.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type {
  PdfPageRenderResult,
  VisualProcessingConfig,
} from "./visual-types";

export const runtime = "nodejs";

declare global {
  var pdfjsWorker: { WorkerMessageHandler: unknown } | undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PdfPageInfo {
  pageNumber: number;
  hasTextContent: boolean;
  textLength: number;
}

interface PdfRenderOutcome {
  ok: boolean;
  rendered: PdfPageRenderResult[];
  error?: string;
  totalPages: number;
  renderedPages: number;
  skippedPages: number;
}

// Minimal canvas factory shape expected by pdfjs-dist at runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfjsCanvasFactory = any;

// ---------------------------------------------------------------------------
// Core rendering
// ---------------------------------------------------------------------------

/**
 * Render all pages of a PDF buffer to PNG images.
 *
 * Steps:
 * 1. Load PDF with pdfjs-dist
 * 2. For each page, get viewport at configured scale
 * 3. Render to @napi-rs/canvas
 * 4. Convert canvas to PNG buffer
 * 5. Upload PNG to Supabase Storage
 * 6. Create visual_assets record
 * 7. Return PdfPageRenderResult[] for downstream use
 */
export async function renderPdfPages(
  buffer: Buffer,
  documentId: string,
  userId: string,
  config?: Partial<VisualProcessingConfig>
): Promise<PdfRenderOutcome> {
  const supabase = await getSupabaseServerClient();
  const mergedConfig = { ...getDefaultConfig(), ...config };

  // Dynamic import for @napi-rs/canvas (native module, incompatible with Turbopack ESM)
  const { createCanvas } = await import("@napi-rs/canvas");

  // Ensure worker is registered
  if (!globalThis.pdfjsWorker) {
    const workerModule = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    globalThis.pdfjsWorker = { WorkerMessageHandler: workerModule.WorkerMessageHandler };
  }

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer);
  const canvasFactory = buildCanvasFactory(createCanvas);

  // canvasFactory is valid at runtime but not in pdfjs-dist v5 TS types
  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    standardFontDataUrl: await import("node:path").then((p) => p.join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts/")),
    canvasFactory,
  } as PdfjsCanvasFactory).promise;

  try {
    const totalPages = Math.min(doc.numPages, mergedConfig.pdfMaxPages);
    const results: PdfPageRenderResult[] = [];

    console.log(
      "[PdfPageRenderer] documentId=%s totalPages=%d renderScale=%f",
      documentId, doc.numPages, mergedConfig.pdfRenderScale
    );

    for (let i = 1; i <= totalPages; i++) {
      try {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: mergedConfig.pdfRenderScale });

        const canvas = createCanvas(viewport.width, viewport.height);
        const ctx = canvas.getContext("2d");

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, viewport.width, viewport.height);

        // SKRSContext2D lacks drawFocusIfNeeded which pdfjs-dist expects.
        // Cast to CanvasRenderingContext2D for the render() call.
        // pdfjs-dist v5 TS types also require 'canvas' in RenderParameters,
        // but it's not needed when canvasContext is provided with canvasFactory.
        await page.render({
          canvasContext: ctx as unknown as CanvasRenderingContext2D,
          canvas: null as unknown as HTMLCanvasElement,
          viewport,
        } as PdfjsCanvasFactory).promise;

        const pngBuffer = canvas.toBuffer("image/png");
        const fileSize = pngBuffer.length;
        // PDF.js viewport dims are fractional (render-scale dependent); the
        // visual_assets.width/height columns are INTEGER, so round up to the
        // nearest pixel to avoid "invalid input syntax for type integer".
        const width = Math.round(viewport.width);
        const height = Math.round(viewport.height);
        const contentHash = createHash("sha256").update(pngBuffer).digest("hex");
        const storagePath = `${userId}/visual_assets/${documentId}/page_${i}.png`;

        const { error: uploadError } = await supabase.storage
          .from("documents")
          .upload(storagePath, pngBuffer, {
            contentType: "image/png",
            upsert: true,
          });

        if (uploadError) {
          console.error(
            "[PdfPageRenderer] upload failed page=%d error=%s",
            i, uploadError.message
          );
          continue;
        }

        const { error: insertError } = await supabase
          .from("visual_assets")
          .insert({
            user_id: userId,
            document_id: documentId,
            asset_type: "page_image",
            storage_path: storagePath,
            mime_type: "image/png",
            page_number: i,
            width,
            height,
            file_size_bytes: fileSize,
            content_hash: contentHash,
            processing_status: "ready",
          });

        if (insertError) {
          console.error(
            "[PdfPageRenderer] visual_assets insert failed page=%d error=%s",
            i, insertError.message
          );
        }

        results.push({
          pageNumber: i,
          storagePath,
          width,
          height,
          fileSize,
        });

        console.log(
          "[PdfPageRenderer] page=%d width=%d height=%d size=%d storage=%s",
          i, width, height, fileSize, storagePath
        );

        page.cleanup();
      } catch (pageError) {
        const msg = pageError instanceof Error ? pageError.message : String(pageError);
        console.error(
          "[PdfPageRenderer] page=%d render failed: %s",
          i, msg
        );
      }
    }

    const renderedPages = results.length;
    const skippedPages = totalPages - renderedPages;

    console.log(
      "[PdfPageRenderer] documentId=%s complete rendered=%d skipped=%d total=%d",
      documentId, renderedPages, skippedPages, totalPages
    );

    return {
      ok: renderedPages > 0,
      rendered: results,
      totalPages,
      renderedPages,
      skippedPages,
      error: skippedPages > 0
        ? `${skippedPages} of ${totalPages} pages failed to render`
        : undefined,
    };
  } finally {
    await doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// Targeted rendering — render a specific page
// ---------------------------------------------------------------------------

/**
 * Render a single page of a PDF buffer to a PNG image.
 * Useful for on-demand rendering when a specific page is needed.
 */
export async function renderPdfPage(
  buffer: Buffer,
  pageNumber: number,
  documentId: string,
  userId: string,
  config?: Partial<VisualProcessingConfig>
): Promise<PdfPageRenderResult | null> {
  const supabase = await getSupabaseServerClient();
  const mergedConfig = { ...getDefaultConfig(), ...config };

  const { createCanvas } = await import("@napi-rs/canvas");

  if (!globalThis.pdfjsWorker) {
    const workerModule = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    globalThis.pdfjsWorker = { WorkerMessageHandler: workerModule.WorkerMessageHandler };
  }

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer);
  const canvasFactory = buildCanvasFactory(createCanvas);

  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    canvasFactory,
  } as PdfjsCanvasFactory).promise;

  try {
    if (pageNumber < 1 || pageNumber > doc.numPages) {
      console.error(
        "[PdfPageRenderer] invalid page=%d (max=%d)",
        pageNumber, doc.numPages
      );
      return null;
    }

    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: mergedConfig.pdfRenderScale });

    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    await page.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      canvas: null as unknown as HTMLCanvasElement,
      viewport,
    } as PdfjsCanvasFactory).promise;

    const pngBuffer = canvas.toBuffer("image/png");
    const fileSize = pngBuffer.length;
    // PDF.js viewport dims are fractional; round to whole pixels to satisfy
    // the visual_assets.height/width INTEGER columns.
    const width = Math.round(viewport.width);
    const height = Math.round(viewport.height);
    const contentHash = createHash("sha256").update(pngBuffer).digest("hex");
    const storagePath = `${userId}/visual_assets/${documentId}/page_${pageNumber}.png`;

    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, pngBuffer, {
        contentType: "image/png",
        upsert: true,
      });

    if (uploadError) {
      console.error(
        "[PdfPageRenderer] single page upload failed page=%d error=%s",
        pageNumber, uploadError.message
      );
      return null;
    }

    const { error: upsertError } = await supabase
      .from("visual_assets")
      .upsert({
        user_id: userId,
        document_id: documentId,
        asset_type: "page_image",
        storage_path: storagePath,
        mime_type: "image/png",
        page_number: pageNumber,
        width,
        height,
        file_size_bytes: fileSize,
        content_hash: contentHash,
        processing_status: "ready",
      }, {
        onConflict: "document_id,page_number",
      });

    if (upsertError) {
      console.error(
        "[PdfPageRenderer] visual_assets upsert failed page=%d error=%s",
        pageNumber, upsertError.message
      );
    }

    page.cleanup();

    console.log(
      "[PdfPageRenderer] single page=%d width=%d height=%d size=%d",
      pageNumber, width, height, fileSize
    );

    return {
      pageNumber,
      storagePath,
      width,
      height,
      fileSize,
    };
  } finally {
    await doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// Check if a PDF has renderable pages (not empty/encrypted)
// ---------------------------------------------------------------------------

/**
 * Inspect a PDF to determine if it has renderable pages.
 * Returns page info for each page including text content status.
 */
export async function inspectPdfPages(
  buffer: Buffer,
  maxPages: number = 100
): Promise<PdfPageInfo[]> {
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
  }).promise;

  try {
    const pages: PdfPageInfo[] = [];
    const limit = Math.min(doc.numPages, maxPages);

    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim();

      pages.push({
        pageNumber: i,
        hasTextContent: text.length > 0,
        textLength: text.length,
      });

      page.cleanup();
    }

    return pages;
  } finally {
    await doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a canvas factory object that pdfjs-dist expects.
 * pdfjs-dist calls canvasFactory.create(w,h) which must return { canvas, context }.
 */
function buildCanvasFactory(
  createCanvasFn: (w: number, h: number) => { getContext: (t: "2d") => unknown }
): PdfjsCanvasFactory {
  return {
    create(width: number, height: number) {
      const canvas = createCanvasFn(width, height);
      const ctx = canvas.getContext("2d");
      return {
        canvas: { width, height, style: {} },
        context: ctx,
      };
    },
    reset(canvasAndContext: { canvas: { width: number; height: number } }, width: number, height: number) {
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    },
    destroy(canvasAndContext: { canvas: { width: number; height: number } }) {
      void canvasAndContext;
    },
  };
}

function getDefaultConfig(): VisualProcessingConfig {
  return {
    maxImageSizeBytes: 25 * 1024 * 1024,
    maxImageDimension: 10000,
    pdfRenderScale: 2.0,
    pdfMaxPages: 100,
  };
}

export type { PdfRenderOutcome, PdfPageInfo };
