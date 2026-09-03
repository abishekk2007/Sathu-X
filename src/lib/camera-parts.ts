// ---------------------------------------------------------------------------
// Phase 7E — Camera image → Gemini part builders (server-safe).
//
// These are pure node-side helpers used by the /api/chat route to turn a
// validated camera image into inline Gemini parts alongside the user's text.
// The part shape (`{ inlineData: { mimeType, data } }`) is exactly what the
// installed @google/genai SDK accepts and matches the existing
// `buildGeminiImageParts` output used for document visual evidence.
//
// NONE of these functions touch browser globals, Tavily, or storage, and none
// of them ever log image bytes. The camera image travels to Gemini only.
// ---------------------------------------------------------------------------

export interface GeminiInlineImageData {
  mimeType: string;
  data: string;
}

export type GeminiInlinePart =
  | { text: string }
  | { inlineData: GeminiInlineImageData };

/**
 * Builds a single inline image part from validated bytes + a real MIME type.
 * The MIME type passed here is the magic-byte-verified value from
 * `validateImage` — never the client's declared value alone.
 */
export function buildInlineImagePart(
  bytes: Buffer | Uint8Array,
  mimeType: string
): { inlineData: { mimeType: string; data: string } } {
  const data = Buffer.isBuffer(bytes) ? bytes.toString("base64") : Buffer.from(bytes).toString("base64");
  return { inlineData: { mimeType, data } };
}

/**
 * Assembles the parts for the latest user message. With an image the parts
 * are [text, imagePart] so the prompt is read first and the photo follows;
 * with no image the parts are exactly [text] (the pre-existing text-only
 * path — regression-safe). When text is empty but an image is present, the
 * caller supplies the default prompt so parts are never empty or image-only.
 */
export function buildCameraMessageParts(
  text: string,
  image: GeminiInlineImageData | undefined
): GeminiInlinePart[] {
  const parts: GeminiInlinePart[] = [{ text }];
  if (image) {
    parts.push({ inlineData: image });
  }
  return parts;
}