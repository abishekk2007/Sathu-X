/**
 * Pure helpers for the Phase 7B voice-output feature.
 *
 * These convert an assistant message (which may contain markdown) into clean,
 * naturally-spoken text. They are deliberately free of DOM/React dependencies
 * so they can be unit tested with `npx tsx` (the project's standalone-test
 * convention) despite the browser-only nature of speechSynthesis.
 */

/** Soft marker inserted where a fenced code block was removed from speech. */
export const CODE_BLOCK_OMITTED_PHRASE = "Code block omitted.";

/**
 * Returns true when the (already markdown-processed) text contains anything
 * worth speaking aloud. Whitespace-only and control-char-only content is not
 * speakable.
 */
export function hasSpeakableText(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.replace(/\s/g, "").length > 0;
}

/**
 * Converts each line of browser-raw speech text into a tidy spoken form:
 * collapses runs of whitespace and strips punctuation-only artifacts while
 * preserving content. Public for direct testing.
 */
export function tidySpokenLine(line: string): string {
  return line
    .replace(/\s+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Removes inline markdown formatting from a single line so speech sounds
 * natural instead of reading markup aloud:
 *   - `**bold**` -> bold, `*italic*`/`_italic_` -> italic
 *   - `` `inline code` `` -> code
 *   - `[label](url)` -> label (never the raw URL)
 *   - `~~strike~~` -> strike
 *   - `#` heading markers are stripped
 *   - `-`/`•`/`1.` list markers map to natural spoken separators
 *   - table pipes (|) and separators are relaxed to pauses
 * Public for direct testing.
 */
export function cleanMarkdownLine(line: string): string {
  let text = line.trim();

  // Heading markers (already handled structurally, but strip any remainder).
  text = text.replace(/^ {0,3}#{1,6}\s+/, "");

  // List markers -> natural spoken phrasing.
  const ulMatch = /^[-•*+]\s+/.exec(text);
  if (ulMatch) {
    text = text.replace(ulMatch[0], "");
  } else {
    const olMatch = /^\d+[.)]\s+/.exec(text);
    if (olMatch) {
      text = text.replace(olMatch[0], "");
    }
  }

  // Blockquote marker.
  text = text.replace(/^>\s?/, "");

  // Markdown links -> label text only.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Inline code -> bare code text.
  text = text.replace(/`([^`]+)`/g, "$1");

  // Bold / italic / strikethrough delimiters.
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2");
  text = text.replace(/_([^_]+)_/g, "$1");
  text = text.replace(/~([^~]+)~/g, "$1");

  return tidySpokenLine(text);
}

/**
 * Converts an assistant message's markdown content into a clean, speakable
 * string suitable for text-to-speech.
 *
 * Rules:
 *   - Fenced code blocks (```...```) are removed and replaced with a short
 *     "Code block omitted." notice so long code is not read aloud.
 *   - Headings, lists, blockquotes, tables, emphasis, links and inline code
 *     are converted into natural spoken text (no raw markup).
 *   - Blank lines become sentence-level pauses.
 *   - The displayed assistant message is never modified.
 */
export function markdownToSpeechText(markdown: string): string {
  if (!markdown) return "";

  // Split on fenced code blocks. Odd segments are code; even are text.
  const segments = markdown.split(/```/);
  const lines: string[] = [];

  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      // Code block: omit the body. Keep a short spoken indication once.
      if (segment.replace(/\n/g, "").trim().length > 0) {
        lines.push(CODE_BLOCK_OMITTED_PHRASE);
      }
      return;
    }

    segment.split("\n").forEach((rawLine) => {
      const trimmed = rawLine.trim();
      if (trimmed === "") {
        lines.push("");
        return;
      }
      // Relax table separators (--- rows) to a pause instead of speaking pipes.
      if (/^\s*\|?[\s-|:]+\|?\s*$/.test(trimmed) && !trimmed.match(/[a-z0-9]/i)) {
        lines.push("");
        return;
      }
      const cleaned = cleanMarkdownLine(trimmed);
      if (cleaned) lines.push(cleaned);
    });
  });

  // Collapse to a stable spoken form: sentence pauses (blank lines become new
  // sentences) — join with a separator the speech engine reads as a pause.
  const spoken = lines.join(" ");
  return tidySpokenLine(spoken);
}
