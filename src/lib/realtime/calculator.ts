// ---------------------------------------------------------------------------
// Phase 6A — Safe arithmetic evaluator.
// A strict recursive-descent parser for `+ - * / % ^ ( ) . digits` plus two
// explicit functions: sqrt(x) and pow(a, b). No eval(), no JS exposure, no
// imports, no property access, no filesystem/network access.
//
// Guarantees:
//   - Only the allowed grammar may appear; anything else is a parse error.
//   - Bounded: max input length, token count, nesting depth, exponent size,
//     and result magnitude. Non-finite / oversized results are rejected.
//   - Division/modulo by zero and sqrt(negative) return typed errors.
//   - Never throws across the public boundary (`evaluateExpression`).
// ---------------------------------------------------------------------------

export type CalculationResult =
  | { ok: true; value: number; formatted: string }
  | { ok: false; code: string; message: string };

export const CALCULATION_INPUT_LIMIT = 100;
export const CALCULATION_TOKEN_LIMIT = 200;
export const CALCULATION_DEPTH_LIMIT = 24;
export const CALCULATION_RESULT_BOUND = 1e15;
export const CALCULATION_EXPONENT_LIMIT = 512;

const MSG_PARSE = "That doesn't form a valid arithmetic expression.";
const MSG_DIV_ZERO = "Division by zero isn't allowed.";
const MSG_INVALID = "That calculation isn't valid.";
const MSG_OVERFLOW = "That result is too large to compute safely.";

class MathError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "MathError";
  }
}

interface Token {
  type: "num" | "op" | "lparen" | "rparen" | "comma" | "func";
  value: string;
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = expression.length;
  while (i < n) {
    const ch = expression[i];
    if (ch === undefined) break;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9]/.test(expression[j] ?? "")) j++;
      if (
        expression[j] === "." &&
        (expression[j + 1] ?? "").length > 0 &&
        /[0-9]/.test(expression[j + 1] ?? "")
      ) {
        j++;
        while (j < n && /[0-9]/.test(expression[j] ?? "")) j++;
      }
      tokens.push({ type: "num", value: expression.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%^".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch });
      i++;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < n && /[a-zA-Z]/.test(expression[j] ?? "")) j++;
      const word = expression.slice(i, j).toLowerCase();
      if (word !== "sqrt" && word !== "pow") {
        throw new MathError("math_parse", MSG_PARSE);
      }
      tokens.push({ type: "func", value: word });
      i = j;
      continue;
    }
    throw new MathError("math_parse", MSG_PARSE);
  }
  if (tokens.length > CALCULATION_TOKEN_LIMIT) {
    throw new MathError("math_overflow", MSG_OVERFLOW);
  }
  return tokens;
}

function evaluate(tokens: Token[]): number {
  let pos = 0;
  let depth = 0;

  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];

  function guardFinite(value: number): number {
    if (!Number.isFinite(value)) {
      throw new MathError("math_overflow", MSG_OVERFLOW);
    }
    return value;
  }

  function guardBound(value: number): number {
    guardFinite(value);
    if (Math.abs(value) > CALCULATION_RESULT_BOUND) {
      throw new MathError("math_overflow", MSG_OVERFLOW);
    }
    return value;
  }

  function expr(): number {
    let left = term();
    for (;;) {
      const op = peek();
      if (op?.type !== "op" || (op.value !== "+" && op.value !== "-")) break;
      next();
      const right = term();
      left = guardBound(op.value === "+" ? left + right : left - right);
    }
    return left;
  }

  function term(): number {
    let left = unary();
    for (;;) {
      const op = peek();
      if (
        op?.type !== "op" ||
        (op.value !== "*" && op.value !== "/" && op.value !== "%")
      ) {
        break;
      }
      next();
      const right = unary();
      if ((op.value === "/" || op.value === "%") && right === 0) {
        throw new MathError("math_divide_by_zero", MSG_DIV_ZERO);
      }
      if (op.value === "*") {
        left = guardBound(left * right);
      } else if (op.value === "/") {
        left = guardBound(left / right);
      } else {
        left = guardBound(left % right);
      }
    }
    return left;
  }

  function unary(): number {
    const op = peek();
    if (op?.type === "op" && op.value === "-") {
      next();
      return -unary();
    }
    if (op?.type === "op" && op.value === "+") {
      next();
      return unary();
    }
    return power();
  }

  function power(): number {
    const base = atom();
    const op = peek();
    if (op?.type === "op" && op.value === "^") {
      next();
      const exponent = unary();
      if (Math.abs(exponent) > CALCULATION_EXPONENT_LIMIT) {
        throw new MathError("math_overflow", MSG_OVERFLOW);
      }
      if (base === 0 && exponent < 0) {
        throw new MathError("math_invalid", MSG_INVALID);
      }
      return guardBound(Math.pow(base, exponent));
    }
    return base;
  }

  function atom(): number {
    depth += 1;
    if (depth > CALCULATION_DEPTH_LIMIT) {
      throw new MathError("math_overflow", MSG_OVERFLOW);
    }
    const token = next();
    if (!token) {
      depth -= 1;
      throw new MathError("math_parse", MSG_PARSE);
    }

    if (token.type === "num") {
      depth -= 1;
      return Number.parseFloat(token.value);
    }

    if (token.type === "lparen") {
      const value = expr();
      const close = next();
      depth -= 1;
      if (!close || close.type !== "rparen") {
        throw new MathError("math_parse", MSG_PARSE);
      }
      return value;
    }

    if (token.type === "func") {
      const open = next();
      if (!open || open.type !== "lparen") {
        depth -= 1;
        throw new MathError("math_parse", MSG_PARSE);
      }
      if (token.value === "sqrt") {
        const arg = expr();
        const close = next();
        depth -= 1;
        if (!close || close.type !== "rparen") {
          throw new MathError("math_parse", MSG_PARSE);
        }
        if (arg < 0) {
          throw new MathError("math_invalid", MSG_INVALID);
        }
        return guardBound(Math.sqrt(arg));
      }
      const base = expr();
      const comma = next();
      if (!comma || comma.type !== "comma") {
        depth -= 1;
        throw new MathError("math_parse", MSG_PARSE);
      }
      const exponent = expr();
      const close = next();
      depth -= 1;
      if (!close || close.type !== "rparen") {
        throw new MathError("math_parse", MSG_PARSE);
      }
      if (Math.abs(exponent) > CALCULATION_EXPONENT_LIMIT) {
        throw new MathError("math_overflow", MSG_OVERFLOW);
      }
      return guardBound(Math.pow(base, exponent));
    }

    depth -= 1;
    throw new MathError("math_parse", MSG_PARSE);
  }

  const result = guardBound(expr());
  if (pos !== tokens.length) {
    throw new MathError("math_parse", MSG_PARSE);
  }
  return result;
}

/** Removes trailing zeros from a decimal representation without corrupting it. */
function compactNumber(rendered: string): string {
  if (!rendered.includes(".")) return rendered;
  const [intPart, fracPart] = rendered.split(".");
  if (fracPart === undefined) return intPart;
  const frac = fracPart.replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new MathError("math_overflow", MSG_OVERFLOW);
  }
  if (Object.is(value, -0) || value === 0) return "0";
  if (Number.isInteger(value) && Math.abs(value) < 1e12) {
    return value.toString();
  }
  return compactNumber(value.toPrecision(12));
}

/**
 * Evaluates a strict arithmetic expression. Never throws.
 * Returns `{ ok: true, value, formatted }` or `{ ok: false, code, message }`.
 */
export function evaluateExpression(expression: string): CalculationResult {
  const trimmed = expression.trim();
  try {
    if (!trimmed) {
      return { ok: false, code: "math_parse", message: MSG_PARSE };
    }
    if (trimmed.length > CALCULATION_INPUT_LIMIT) {
      return { ok: false, code: "math_overflow", message: MSG_OVERFLOW };
    }
    const tokens = tokenize(trimmed);
    const value = evaluate(tokens);
    return { ok: true, value, formatted: formatNumber(value) };
  } catch (error) {
    if (error instanceof MathError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: false, code: "math_error", message: MSG_PARSE };
  }
}