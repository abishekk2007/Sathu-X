// ---------------------------------------------------------------------------
// Phase 6C — Gemini image provider (PRIMARY)
//
// Uses the shared getGeminiClient() from @/lib/gemini (server-side key only)
// and the SDK's models.generateContent() with responseModalities: ["IMAGE"]
// (the modern API for image-capable models; models.generateImages() is
// deprecated in @google/genai 2.x and throws when called). Safety is NOT
// bypassed: the safety filter level stays on the provider default and a
// SAFETY/IMAGE_SAFETY finish reason is surfaced as `safety_blocked` so the
// service NEVER fails over to Hugging Face on a user-content block.
//
// Phase 6D — image EDITING reuses the SAME generateContent path with the
// reference image sent as an inlineData part alongside the instruction text
// (the officially recommended way to edit images with Gemini image models).
// The deprecated models.editImage (Imagen-style ReferenceImage API) is
// deliberately NOT used: the installed SDK warns it is being removed (next
// major release) and points at generateContent instead, so keeping one
// verified, live-tested code path for both generation and editing is strictly
// less risky. No GEMINI_IMAGE_EDIT_MODEL var is therefore required — edits use
// GEMINI_IMAGE_MODEL (the same image-model family that already works live).
// ---------------------------------------------------------------------------

import { getGeminiClient } from "@/lib/gemini";
import type { GenerateContentResponse } from "@google/genai";
import type {
  ImageProvider,
  ProviderEditParams,
  ProviderGenerationParams,
  ProviderImageOutput,
} from "./types";
import { ImageFailure } from "./types";

/** Default primary image model. Override with GEMINI_IMAGE_MODEL. */
export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";

export function resolveGeminiImageModel(): string {
  const override = process.env.GEMINI_IMAGE_MODEL?.trim();
  return override || DEFAULT_GEMINI_IMAGE_MODEL;
}

/** Maps a Gemini SDK error to the internal failure taxonomy. */
function mapGeminiError(error: unknown): ImageFailure {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: unknown } | null)?.status;
  const statusNum = typeof status === "number" ? status : 0;

  // Content-level refusals are NEVER provider failures.
  if (
    /safety|blocked|prohibited|not allowed|forbidden|complet(?:ing|e)\s+prompts\s+that\s+are\s+not\s+allowed/i.test(
      message
    )
  ) {
    return new ImageFailure("safety_blocked", message);
  }
  if (statusNum === 401 || statusNum === 403) {
    return new ImageFailure("provider_auth", message);
  }
  if (statusNum === 429 || statusNum === 503) {
    return new ImageFailure("rate_limited", message);
  }
  if (statusNum === 408 || statusNum === 500 || statusNum === 502 || statusNum === 504) {
    return new ImageFailure("provider_unavailable", message);
  }
  if (statusNum === 400) {
    // A 400 is usually a config/unsupported-parameter difference between
    // providers — eligible for fallback (the next provider may accept it).
    return new ImageFailure("provider_invalid_response", message);
  }
  if (name === "AbortError" || error instanceof DOMException) {
    return new ImageFailure("timeout", "Generation aborted.");
  }
  if (error instanceof TypeError) {
    return new ImageFailure("provider_unavailable", message);
  }
  return new ImageFailure("provider_unavailable", message);
}

export const geminiImageProvider: ImageProvider = {
  id: "gemini",
  async generate(params: ProviderGenerationParams): Promise<ProviderImageOutput> {
    const client = getGeminiClient();
    if (!client) {
      throw new ImageFailure("misconfigured", "GEMINI_API_KEY is not configured on the server.");
    }

    const model = resolveGeminiImageModel();
    let response: GenerateContentResponse;
    try {
      response = await client.models.generateContent({
        model,
        contents: params.prompt,
        config: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            // Note: the installed @google/genai ImageConfig type exposes no
            // negativePrompt field, so only the aspect ratio is sent here.
            // ProviderGenerationParams.negativePrompt remains available to
            // providers whose APIs accept it (e.g. a future diffuser).
            aspectRatio: params.aspectRatio,
          },
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
        },
      });
    } catch (error) {
      throw mapGeminiError(error);
    }

    const candidate = response?.candidates?.[0];
    const finishReason = candidate?.finishReason ?? null;
    if (finishReason === "SAFETY" || finishReason === "IMAGE_SAFETY") {
      throw new ImageFailure("safety_blocked", "Gemini filtered the prompt for safety reasons.");
    }

    const inline = (candidate?.content?.parts ?? []).find((part) => part.inlineData);
    if (!inline?.inlineData?.data) {
      throw new ImageFailure("provider_invalid_response", "Gemini returned no image bytes.");
    }

    const data = Buffer.from(inline.inlineData.data, "base64");
    return {
      data,
      mimeType: inline.inlineData.mimeType,
      width: 0,
      height: 0,
      fileSizeBytes: data.length,
    };
  },
  /**
   * Phase 6D — edits a reference image by sending the validated source bytes
   * as an inlineData part plus the composed instruction text to a Gemini image
   * model, requesting an IMAGE response modality. Mirrors `generate` exactly:
   * same client, same model resolver, same safety/finish-reason mapping.
   */
  async edit(params: ProviderEditParams): Promise<ProviderImageOutput> {
    const client = getGeminiClient();
    if (!client) {
      throw new ImageFailure("misconfigured", "GEMINI_API_KEY is not configured on the server.");
    }

    const mimeType = params.sourceImage.mimeType || "image/png";
    const model = resolveGeminiImageModel();
    let response: GenerateContentResponse;
    try {
      response = await client.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              { text: params.instruction },
              {
                inlineData: {
                  mimeType,
                  data: params.sourceImage.bytes.toString("base64"),
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ["IMAGE"],
          ...(params.aspectRatio
            ? { imageConfig: { aspectRatio: params.aspectRatio } }
            : {}),
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
        },
      });
    } catch (error) {
      throw mapGeminiError(error);
    }

    const candidate = response?.candidates?.[0];
    const finishReason = candidate?.finishReason ?? null;
    if (finishReason === "SAFETY" || finishReason === "IMAGE_SAFETY") {
      throw new ImageFailure("safety_blocked", "Gemini filtered the edit for safety reasons.");
    }

    const inline = (candidate?.content?.parts ?? []).find((part) => part.inlineData);
    if (!inline?.inlineData?.data) {
      throw new ImageFailure("provider_invalid_response", "Gemini returned no edited image bytes.");
    }

    const data = Buffer.from(inline.inlineData.data, "base64");
    return {
      data,
      mimeType: inline.inlineData.mimeType,
      width: 0,
      height: 0,
      fileSizeBytes: data.length,
    };
  },
};