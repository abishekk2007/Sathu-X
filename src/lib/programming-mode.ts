/**
 * Programming intent and language detection.
 *
 * Examines the latest user message to decide whether the user is asking for
 * programming help and, if so, which language they likely want. Detection is
 * purely regex-based — no model call, no false positives on normal questions.
 */

export interface ProgrammingIntent {
  /** Whether the message is likely a programming request. */
  detected: boolean;
  /** Normalised language name (e.g. "python", "javascript") or null. */
  language: string | null;
  /** Whether the user explicitly named a language (stronger signal). */
  explicitLanguage: boolean;
}

// ---------------------------------------------------------------------------
// Language patterns — ordered most-specific first so "c++" beats "c".
// Each entry: [normalised name, regex tested against lowercased message]
// ---------------------------------------------------------------------------

const LANGUAGE_PATTERNS: [string, RegExp][] = [
  // Specific first
  ["typescript", /\btypescript\b/i],
  ["javascript", /\bjavascript\b|\bnode\.?js\b|\bnode\.?ts\b/i],
  ["tsx", /\btsx\b/i],
  ["jsx", /\bjsx\b/i],
  ["react", /\breact(?:\.?js|\.?ts)?\b/i],
  ["nextjs", /\bnext\.?js\b|\bnext\.?ts\b/i],
  ["python", /\bpython\b|\bpython3\b|\b\.py\b/i],
  ["java", /\bjava\b(?!script)/i],
  ["c\\+\\+", /\bc\+\+\b|\bcpp\b/i],
  ["c#", /\bc#\b|\bcsharp\b|\bdotnet\b/i],
  ["go", /\bgolang\b|\bgo\b(?:\s+program|\s+code|\s+function|\s+struct|\s+channel)/i],
  ["rust", /\brust\b|\b\.rs\b/i],
  ["kotlin", /\bkotlin\b|\b\.kt\b/i],
  ["swift", /\bswift\b(?! ui)/i],
  ["dart", /\bdart\b|\bflutter\b/i],
  ["php", /\bphp\b/i],
  ["ruby", /\bruby\b|\b\.rb\b/i],
  ["r", /\br\b(?:\s+program|\s+code|\s+script|\s+language|\s+studio)/i],
  ["matlab", /\bmatlab\b/i],
  ["sql", /\bsql\b|\bmysql\b|\bpostgresql\b|\bsqlite\b|\bpostgres\b/i],
  ["html", /\bhtml\b/i],
  ["css", /\bcss\b|\bscss\b|\bsass\b|\btailwind\b/i],
  ["bash", /\bbash\b|\bshell\s+script\b|\bsh\b(?:\s+script)/i],
  ["powershell", /\bpowershell\b|\bps1\b/i],
  ["c", /\bc\b(?:\s+program|\s+code|\s+language|\s+function|\s+struct)/i],
  ["perl", /\bperl\b/i],
  ["scala", /\bscala\b/i],
  ["sas", /\bsas\b(?:\s+program|\s+code)/i],
  ["assembly", /\bassembly\b|\basm\b/i],
  ["graphql", /\bgraphql\b|\bgql\b/i],
  ["terraform", /\bterraform\b|\b\.tf\b/i],
  ["yaml", /\byaml\b|\b\.yml\b/i],
  ["json", /\bjson\b/i],
  ["xml", /\bxml\b/i],
  ["latex", /\blatex\b|\b\.tex\b/i],
  ["markdown", /\bmarkdown\b/i],
  ["excel", /\bexcel\b|\bvba\b|\bmacro\b/i],
];

// ---------------------------------------------------------------------------
// Programming intent patterns — keywords that signal a code request.
// These must be specific enough to avoid false positives on normal questions.
// ---------------------------------------------------------------------------

const INTENT_PATTERNS: RegExp[] = [
  // Direct code requests
  /\b(?:write|create|build|make|generate|produce|code|implement)\b.*\b(?:a\s+)?(?:program|function|method|class|component|module|script|app|application|api|endpoint|query|migration|schema|algorithm|solution|project|file|program)\b/i,
  /\b(?:write|create|build|make|code|implement)\b.*\b(?:a\s+)?(?:\w+\s+)?(?:program|code|function|class|component|script|app|api)\b/i,

  // Fix / debug / explain
  /\b(?:fix|debug|debugg|troubleshoot|resolve|repair|correct|patch)\b.*\b(?:this|my|the|following|below|code|bug|error|issue|problem|crash|exception)\b/i,
  /\b(?:explain|walk\s+through|describe|analyze|analyse|review)\b.*\b(?:this|my|the|following|below|code|function|class|algorithm|logic)\b/i,
  /\b(?:optimize|refactor|improve|rewrite|simplify)\b.*\b(?:this|my|the|following|below|code|function|class|algorithm|performance)\b/i,

  // Convert / translate
  /\b(?:convert|translate|port|rewrite|migrate)\b.*\b(?:this|my|the|following|below|code|program|function|from|to)\b.*\b(?:to|into|in|from)\b/i,

  // Snippet requests
  /\b(?:write|give|show|provide|send|share)\b.*\b(?:me\s+)?(?:a\s+)?(?:small\s+)?(?:code\s+)?(?:snippet|example|sample|demo|snippet)\b/i,

  // Direct code topics
  /\b(?:write|create|build|make)\b.*\b(?:a\s+)?(?:rest\s+api|graphql|grpc|socket|websocket|cli|console|terminal)\b/i,
  /\b(?:write|create|build|make)\b.*\b(?:a\s+)?(?:database|db|migration|schema|table|query)\b/i,
  /\b(?:write|create|build|make)\b.*\b(?:a\s+)?(?:html|css|jsx|tsx|vue|svelte|angular)\b/i,

  // Problem solving that implies code
  /\b(?:data\s+structure|algorithm|sorting|searching|linked\s+list|binary\s+tree|hash|graph|stack|queue|dynamic\s+programming|recursion|backtrack)\b/i,

  // FizzBuzz-type classic problems
  /\b(?:fizz\s*buzz|fibonacci|factorial|palindrome|anagram|binary\s+search|merge\s+sort|quick\s+sort|bubble\s+sort|selection\s+sort)\b/i,
];

// ---------------------------------------------------------------------------
// Code snippet detection — if the user pastes code, they likely want help
// with it.
// ---------------------------------------------------------------------------

const CODE_FENCE_PATTERN = /```[\s\S]*?```/;

/**
 * Detects whether the message contains a code block (backtick-fenced).
 */
function containsCodeBlock(message: string): boolean {
  return CODE_FENCE_PATTERN.test(message);
}

// ---------------------------------------------------------------------------
// Language name normalisation
// ---------------------------------------------------------------------------

function normaliseLanguage(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const map: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    rb: "ruby",
    kt: "kotlin",
    cs: "c#",
    rs: "rust",
    sh: "bash",
    zsh: "bash",
    ps1: "powershell",
    yml: "yaml",
    "c++": "c++",
    cpp: "c++",
    csharp: "c#",
    dotnet: "c#",
    golang: "go",
    nodejs: "javascript",
    node: "javascript",
    react: "react",
    nextjs: "nextjs",
    next: "nextjs",
    html5: "html",
    css3: "css",
    scss: "css",
    sass: "css",
    tailwind: "css",
    graphql: "graphql",
    gql: "graphql",
    sqlite: "sql",
    mysql: "sql",
    postgresql: "sql",
    postgres: "sql",
  };
  return map[lower] ?? lower;
}

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

/**
 * Analyses the latest user message to determine programming intent.
 *
 * Returns `{ detected: true }` only when there are strong signals the user
 * wants code. Normal questions like "What is photosynthesis?" or "Explain
 * relativity" will return `{ detected: false }`.
 */
export function detectProgrammingIntent(message: string): ProgrammingIntent {
  // 1. Check for explicit code fence in user message — pasted code = help wanted.
  if (containsCodeBlock(message)) {
    return { detected: true, language: guessLanguageFromCode(message), explicitLanguage: false };
  }

  // 2. Check programming intent patterns.
  let intentScore = 0;
  for (const pattern of INTENT_PATTERNS) {
    if (pattern.test(message)) {
      intentScore += 1;
    }
  }

  // 3. Check for language name mentions.
  let detectedLanguage: string | null = null;
  let explicitLanguage = false;
  for (const [name, pattern] of LANGUAGE_PATTERNS) {
    if (pattern.test(message)) {
      detectedLanguage = normaliseLanguage(name);
      explicitLanguage = true;
      break;
    }
  }

  // 4. Check for common code keywords/syntax that indicate programming.
  const hasCodeSyntax =
    /[{}\[\]();]/.test(message) && /\b(?:function|class|def|import|from|const|let|var|return|if|else|for|while|try|catch)\b/.test(message);

  // Decision: if intent patterns match strongly, or code syntax + any language hint.
  if (intentScore >= 2) {
    return { detected: true, language: detectedLanguage, explicitLanguage };
  }
  if (intentScore >= 1 && detectedLanguage) {
    return { detected: true, language: detectedLanguage, explicitLanguage };
  }
  if (intentScore >= 1 && hasCodeSyntax) {
    return { detected: true, language: detectedLanguage, explicitLanguage };
  }
  if (detectedLanguage && hasCodeSyntax) {
    return { detected: true, language: detectedLanguage, explicitLanguage };
  }

  // Weak signal: language explicitly mentioned with a code-related verb.
  if (detectedLanguage && intentScore >= 1) {
    return { detected: true, language: detectedLanguage, explicitLanguage };
  }

  return { detected: false, language: detectedLanguage, explicitLanguage: false };
}

/**
 * When the user pastes code in a fence, try to guess the language from the
 * fence tag (```python, ```js, etc.).
 */
function guessLanguageFromCode(message: string): string | null {
  const match = /```(\w+)/.exec(message);
  if (!match) return null;
  const tag = match[1].toLowerCase();
  // Common aliases
  const aliasMap: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    rb: "ruby",
    kt: "kotlin",
    cs: "c#",
    rs: "rust",
    sh: "bash",
    shell: "bash",
    yml: "yaml",
    dockerfile: "dockerfile",
    tf: "terraform",
  };
  return aliasMap[tag] ?? tag;
}
