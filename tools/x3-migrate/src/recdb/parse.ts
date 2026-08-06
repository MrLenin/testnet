import { RObject, RValue, robj, rstr, rlist, ircFold } from './model.js';

export class RecdbParseError extends Error {
  constructor(message: string, public line: number, public col: number) {
    super(`${message} at ${line}:${col}`);
    this.name = 'RecdbParseError';
  }
}

export interface ParseDiagnostic {
  line: number;
  col: number;
  kind: 'duplicate-key' | 'reader-only-equals' | 'reader-only-escape' | 'reader-only-trailing-comma';
  detail: string;
}

export interface ParseResult { root: RObject; diagnostics: ParseDiagnostic[] }

// isspace() in the C locale: space, \t, \n, \v, \f, \r.
function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
}
function isOctalDigit(c: string): boolean { return c >= '0' && c <= '7'; }
function isHexDigit(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

export function parseDb(text: string): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];

  // --- cursor state -------------------------------------------------
  let pos = 0, line = 1, col = 1;

  const atEnd = (): boolean => pos >= text.length;
  const peek = (): string => text[pos] as string; // caller must check !atEnd() first
  const advance = (): string => {
    const c = text[pos] as string;
    pos++;
    if (c === '\n') { line++; col = 1; } else { col++; }
    return c;
  };
  const here = () => ({ pos, line, col });
  const restore = (mark: { pos: number; line: number; col: number }) => {
    pos = mark.pos; line = mark.line; col = mark.col;
  };
  const fail = (message: string): never => { throw new RecdbParseError(message, line, col); };

  // Consumes whitespace and both comment forms; returns the next
  // significant character WITHOUT consuming it, or undefined at EOF.
  // An unterminated block comment silently runs to EOF (no error).
  //
  // NOTE: this deliberately does NOT replicate x3/src/recdb.c's parse_skip_ws literally.
  // Traced by hand: once its comment scanner hits true EOF, dbgetc() returns EOF forever
  // without ever setting in_comment = 0, so the `do {...} while(in_comment)` loop never
  // terminates — the C reader genuinely infinite-loops on a file ending mid `/* comment`.
  // That can't be "the exact semantics" to match (there is no terminating behavior to
  // observe), and hanging can't accept anything the C reader would otherwise accept, so
  // this diverges to terminate cleanly at EOF instead, matching the brief's stated intent.
  function skipWs(): string | undefined {
    for (;;) {
      if (atEnd()) return undefined;
      const c = peek();
      if (isSpace(c)) { advance(); continue; }
      if (c !== '/') return c;
      advance(); // consume the first '/'
      if (atEnd()) return '/'; // lone trailing slash: not a comment
      const mark = here();
      const d = advance();
      if (d === '*') {
        // block comment: consume up to '*/', or silently to EOF.
        for (;;) {
          if (atEnd()) return undefined;
          const e = advance();
          if (e === '*') {
            if (atEnd()) return undefined;
            if (peek() === '/') { advance(); break; }
          }
        }
        continue;
      } else if (d === '/') {
        // line comment: consume up to (not including) the newline, or EOF.
        while (!atEnd() && peek() !== '\n') advance();
        continue;
      } else {
        // not a comment after all: push back the lookahead char, keep the '/'.
        restore(mark);
        return '/';
      }
    }
  }

  // Parses a double-quoted string. Skips leading whitespace/comments first.
  // Returns undefined only when EOF is hit while looking for the opening
  // quote (a "clean" EOF where a record name may legitimately not follow).
  // Any other malformed input throws.
  function parseQstring(): string | undefined {
    const c = skipWs();
    if (c === undefined) return undefined;
    if (c !== '"') throw fail(`Expected '"'`);
    advance(); // consume opening quote
    let out = '';
    for (;;) {
      if (atEnd()) throw fail('Unterminated string');
      const ch = advance();
      if (ch === '"') return out;
      if (ch === '\n') throw fail('Unterminated string (raw newline)');
      if (ch !== '\\') { out += ch; continue; }
      // escape sequence
      const escLine = line, escCol = col; // position right after the backslash
      if (atEnd()) throw fail('Unterminated string');
      const e = advance();
      if (isOctalDigit(e)) {
        let digits = e;
        for (let i = 1; i < 3; i++) {
          if (i === 2 && digits[0]! > '3') break;
          if (atEnd()) break;
          const p = peek();
          if (!isOctalDigit(p)) break;
          digits += advance();
        }
        out += String.fromCharCode(parseInt(digits, 8));
        diagnostics.push({ line: escLine, col: escCol, kind: 'reader-only-escape', detail: `octal escape \\${digits}` });
      } else if (e === 'x') {
        let digits = '';
        for (let i = 0; i < 2; i++) {
          if (atEnd()) break;
          const p = peek();
          if (!isHexDigit(p)) break;
          digits += advance();
        }
        if (digits.length > 0) {
          out += String.fromCharCode(parseInt(digits, 16));
        } else {
          out += '\\x';
        }
        diagnostics.push({ line: escLine, col: escCol, kind: 'reader-only-escape', detail: `hex escape \\x${digits}` });
      } else {
        switch (e) {
          case 'a': out += '\x07'; break;
          case 'b': out += '\x08'; break;
          case 't': out += '\t'; break;
          case 'n': out += '\n'; break;
          case 'v': out += '\x0b'; break;
          case 'f': out += '\x0c'; break;
          case 'r': out += '\r'; break;
          case '\\': out += '\\'; break;
          case '"': out += '"'; break;
          default:
            out += '\\' + e;
            diagnostics.push({ line: escLine, col: escCol, kind: 'reader-only-escape', detail: `unknown escape \\${e}` });
        }
      }
    }
  }

  // object := '{' record* '}'  -- opening '{' already confirmed & NOT consumed.
  function parseObject(): RObject {
    advance(); // consume '{'
    const obj = robj();
    for (;;) {
      const c = skipWs();
      if (c === '}') { advance(); break; }
      if (c === undefined) break; // unterminated: surfaces as an error at the enclosing ';' check
      parseRecordInto(obj);
    }
    return obj;
  }

  // stringlist := '(' [qstring (',' qstring)*] ')'  -- opening '(' already confirmed & NOT consumed.
  //
  // x3/src/recdb.c's parse_string_list loop actually accepts a single trailing comma:
  // after an element's comma is consumed, the loop re-enters at the top, which checks
  // for ')' (or EOF) *before* requiring another qstring. So `("x",)` parses to ["x"]
  // in the real reader, even though the file's own documented grammar comment (and the
  // brief's formal grammar) has no production for a dangling comma. Confirmed by tracing
  // the C loop: `(,)` and `("x",,)` still error, because in both cases the char sitting
  // where an element is expected is a bare ',' (not EOF/')'), so control falls into
  // dbungetc()+parse_qstring(), which sees ',' where '"' is required and aborts
  // EXPECTED_OPEN_QUOTE. Only a comma *immediately followed by the closing ')'* is
  // tolerated. Since X3's own writer never emits a trailing comma, a lone tolerated one
  // is flagged as a 'reader-only-trailing-comma' diagnostic (hand-edited/foreign file).
  function parseStringList(): string[] {
    advance(); // consume '('
    const items: string[] = [];
    // Set right after consuming a comma; cleared as soon as another element is parsed.
    // If it's still set when we hit ')', that comma was a (tolerated) trailing one.
    let pendingCommaMark: { line: number; col: number } | null = null;
    for (;;) {
      const c = skipWs();
      if (c === undefined || c === ')') {
        if (c === ')') {
          advance();
          if (pendingCommaMark) {
            diagnostics.push({
              line: pendingCommaMark.line, col: pendingCommaMark.col,
              kind: 'reader-only-trailing-comma', detail: 'trailing comma before )',
            });
          }
        }
        return items;
      }
      pendingCommaMark = null;
      const s = parseQstring(); // re-peeks c; throws EXPECTED_OPEN_QUOTE if c isn't '"'
      if (s === undefined) throw fail('Unterminated string list');
      items.push(s);
      const c2 = skipWs();
      if (c2 === undefined || c2 === ')') { if (c2 === ')') advance(); return items; }
      if (c2 !== ',') throw fail("Expected ','");
      pendingCommaMark = here();
      advance(); // consume ','
    }
  }

  // record := qstring ['='] (qstring | object | stringlist) ';'
  // Returns false on a clean EOF before any name was found (end of the
  // enclosing database/object). Throws on any malformed input.
  function parseRecordInto(target: RObject): boolean {
    const nameMark = here();
    const name = parseQstring();
    if (name === undefined) return false;

    let c = skipWs();
    if (c === undefined) throw fail('Expected record data');

    let sawEquals = false;
    const eqMark = here();
    if (c === '=') {
      advance();
      sawEquals = true;
      c = skipWs();
      if (c === undefined) throw fail('Expected record data');
    }

    let value: RValue;
    if (c === '"') {
      value = rstr(parseQstring()!);
    } else if (c === '{') {
      value = parseObject();
    } else if (c === '(') {
      value = rlist(parseStringList());
    } else {
      throw fail('Expected start of record data');
    }

    const semi = skipWs();
    if (semi !== ';') throw fail("Expected ';'");
    advance(); // consume ';'

    if (sawEquals) {
      diagnostics.push({ line: eqMark.line, col: eqMark.col, kind: 'reader-only-equals', detail: `optional '=' after key "${name}"` });
    }

    const wantFold = ircFold(name);
    let isDup = false;
    for (const k of target.entries.keys()) {
      if (ircFold(k) === wantFold) { isDup = true; break; }
    }
    if (isDup) {
      diagnostics.push({ line: nameMark.line, col: nameMark.col, kind: 'duplicate-key', detail: `duplicate key "${name}"` });
    }
    target.entries.set(name, value);
    return true;
  }

  // database := record*
  const root = robj();
  for (;;) {
    if (!parseRecordInto(root)) break;
  }
  return { root, diagnostics };
}
