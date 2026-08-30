"use client";

import * as React from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const HL: Record<string, { kw: RegExp; bi: RegExp; cmt: string }> = {
  javascript: {
    kw: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|super|new|this|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|yield|void|delete|static|get|set)\b/,
    bi: /\b(console|document|window|Math|JSON|Promise|Array|Object|String|Number|Boolean|Date|null|undefined|true|false|NaN|Infinity)\b/,
    cmt: "//",
  },
  typescript: {
    kw: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|super|new|this|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|yield|void|delete|static|get|set|type|interface|enum|implements|abstract|declare|namespace|module|as|is|keyof|readonly|private|protected|public|override|satisfies|infer|never|unknown|any|bigint)\b/,
    bi: /\b(console|document|window|Math|JSON|Promise|Array|Object|String|Number|Boolean|Date|null|undefined|true|false|NaN|Infinity)\b/,
    cmt: "//",
  },
  python: {
    kw: /\b(def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|try|except|finally|raise|with|yield|lambda|global|nonlocal|assert|del|in|not|and|or|is|async|await)\b/,
    bi: /\b(print|len|range|int|str|float|bool|list|dict|set|tuple|True|False|None|self|super|isinstance|enumerate|zip|map|filter|sorted|input|open|abs|min|max|sum|any|all|Exception|ValueError|TypeError|KeyError)\b/,
    cmt: "#",
  },
  java: {
    kw: /\b(public|private|protected|static|final|abstract|class|interface|extends|implements|new|this|super|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|throws|void|int|long|short|byte|float|double|char|boolean|enum|instanceof|import|package)\b/,
    bi: /\b(System|String|Integer|Double|Float|Boolean|Character|Long|Object|Class|Math|List|ArrayList|Map|HashMap|null|true|false|Exception)\b/,
    cmt: "//",
  },
  c: {
    kw: /\b(auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while)\b/,
    bi: /\b(NULL|printf|malloc|free|strlen|strcpy|strcmp|FILE|stdin|stdout|true|false)\b/,
    cmt: "//",
  },
  cpp: {
    kw: /\b(auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|while|class|public|private|protected|virtual|override|new|delete|this|template|typename|namespace|using|try|catch|throw|noexcept|constexpr|nullptr)\b/,
    bi: /\b(NULL|true|false|std|string|vector|map|set|pair|tuple|unique_ptr|shared_ptr|cout|cin|cerr|endl|nullptr)\b/,
    cmt: "//",
  },
  go: {
    kw: /\b(break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/,
    bi: /\b(true|false|nil|iota|make|len|cap|append|copy|delete|panic|recover|fmt|error|string|int|bool|byte|rune|any)\b/,
    cmt: "//",
  },
  rust: {
    kw: /\b(as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while)\b/,
    bi: /\b(true|false|Option|Result|Some|None|Ok|Err|String|Vec|HashMap|Box|println|eprintln|format|todo|assert_eq)\b/,
    cmt: "//",
  },
  ruby: {
    kw: /\b(and|begin|break|case|class|def|do|else|elsif|end|ensure|false|for|if|in|module|next|nil|not|or|return|self|super|then|true|unless|until|when|while|yield)\b/,
    bi: /\b(puts|print|gets|chomp|length|size|each|map|select|reject|include|push|pop|require|attr_reader|attr_writer|attr_accessor)\b/,
    cmt: "#",
  },
  sql: {
    kw: /\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|IN|BETWEEN|LIKE|IS|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|EXISTS|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|FUNCTION|RETURNS|BEGIN|COMMIT|ROLLBACK)\b/i,
    bi: /\b(COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|CONVERT|NOW|ABS|ROUND|CEIL|FLOOR|LENGTH|UPPER|LOWER|TRIM|SUBSTRING|CONCAT|IFNULL|ROW_NUMBER|RANK|DENSE_RANK)\b/,
    cmt: "--",
  },
  bash: {
    kw: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|in|select|until|time)\b/,
    bi: /\b(echo|printf|read|cd|pwd|ls|cat|grep|sed|awk|find|sort|mkdir|rm|cp|mv|chmod|touch|curl|wget|git|docker|npm|npx|node|python|pip|export|source|alias|set|eval|exec)\b/,
    cmt: "#",
  },
  json: {
    kw: /\b(true|false|null)\b/,
    bi: /\b/,
    cmt: "",
  },
  graphql: {
    kw: /\b(type|query|mutation|subscription|fragment|input|enum|interface|union|scalar|schema|extend|implements|directive|repeatable|on)\b/,
    bi: /\b(String|Int|Float|Boolean|ID|null|true|false)\b/,
    cmt: "#",
  },
};

const ALIAS: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  dockerfile: "bash",
  yml: "json",
  yaml: "json",
  tf: "bash",
  rs: "rust",
  kt: "kotlin",
  cs: "java",
};

function lookupRules(lang?: string): (typeof HL)[string] | null {
  if (!lang) return null;
  const l = lang.toLowerCase().trim();
  const key = ALIAS[l] ?? l;
  return HL[key] ?? null;
}

function highlightLine(text: string): string {
  const escaped = esc(text);
  const result = escaped.replace(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(#.*$|\/\/.*$)|\b(true|false|null|undefined|None|True|False|nil|NaN|Infinity|self|this|super)\b|\b(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|super|new|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|yield|void|delete|static|get|set|type|interface|enum|implements|abstract|declare|namespace|module|as|is|keyof|readonly|private|protected|public|override|satisfies|infer|never|unknown|any|bigint|def|elif|except|raise|with|lambda|global|nonlocal|assert|del|pass|fn|impl|pub|mut|mod|trait|unsafe|use|where|loop|match|crate|dyn|async|func|chan|defer|fallthrough|package|range|select|var|struct|map|interface|package|proc|begin|end|unless|until|when|elsif|yield|nil|not|and|or|SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|IN|BETWEEN|LIKE|IS|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|EXISTS|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|FUNCTION|RETURNS|BEGIN|COMMIT|ROLLBACK|if|then|else|elif|fi|for|while|do|done|case|esac|function|exit|select|until|public|private|protected|static|final|abstract|class|interface|extends|implements|void|int|long|short|byte|float|double|char|boolean|enum|auto|break|case|char|const|continue|default|double|extern|goto|inline|register|restrict|signed|sizeof|struct|typedef|union|unsigned|volatile|template|typename|namespace|using|noexcept|constexpr|nullptr|virtual|override|delete)\b/g,
    (match, str, cmt, literal, num, kw) => {
      if (str !== undefined) return `<span style="color:#a3e635">${str}</span>`;
      if (cmt !== undefined) return `<span style="color:#6b7280;font-style:italic">${cmt}</span>`;
      if (literal !== undefined) return `<span style="color:#c084fc">${literal}</span>`;
      if (num !== undefined) return `<span style="color:#fb923c">${num}</span>`;
      if (kw !== undefined) return `<span style="color:#60a5fa">${kw}</span>`;
      return match;
    }
  );
  return result;
}

function highlight(code: string, lang?: string): string {
  const rules = lookupRules(lang);
  if (!rules) return esc(code);
  const lines = code.split("\n");
  return lines.map((line) => highlightLine(line)).join("\n");
}

export function CodeBlock({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Code copied");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  const html = React.useMemo(() => highlight(code, language), [code, language]);

  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border bg-zinc-950 text-zinc-100 dark:border-white/10">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[11px] tracking-wide text-zinc-400 uppercase">
          {language ?? "code"}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          onClick={copy}
          aria-label="Copy code"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto scrollbar-slim p-3 font-mono text-[13px] leading-relaxed">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
