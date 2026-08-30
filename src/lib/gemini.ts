import { GoogleGenAI } from "@google/genai";

/**
 * Shared server-side Gemini client. Returns null when GEMINI_API_KEY is not
 * configured so callers can respond with a structured misconfiguration error
 * instead of leaking the key anywhere.
 */
let cachedClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!cachedClient) cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}
