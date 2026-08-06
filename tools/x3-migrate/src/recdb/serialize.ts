import { RObject, RValue, ircFold } from './model.js';

export interface SerializeOptions { keyOrder?: 'asWritten' | 'x3' }

const ESCAPES: Record<string, string> = {
  '\\': '\\\\', '\x07': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n',
  '\x0b': '\\v', '\f': '\\f', '\r': '\\r', '"': '\\"',
};
const quote = (s: string) => '"' + s.replace(/[\\\x07\b\t\n\x0b\f\r"]/g, c => ESCAPES[c]!) + '"';

export function serializeDb(root: RObject, opts: SerializeOptions = {}): string {
  const order = (o: RObject): [string, RValue][] => {
    const e = [...o.entries];
    return opts.keyOrder === 'x3' ? e.sort((a, b) => ircFold(a[0]) < ircFold(b[0]) ? -1 : ircFold(a[0]) > ircFold(b[0]) ? 1 : 0) : e;
  };
  const emit = (o: RObject, depth: number): string => {
    let out = '';
    for (const [k, v] of order(o)) {
      const ind = '\t'.repeat(depth);
      if (v.kind === 'string') out += `${ind}${quote(k)} ${quote(v.value)};\n`;
      else if (v.kind === 'list') out += `${ind}${quote(k)} (${v.items.map(quote).join(', ')});\n`;
      else out += `${ind}${quote(k)} {\n${emit(v, depth + 1)}${ind}};\n`;
    }
    return out;
  };
  // top level: sections separated by a blank line (mondo shape)
  return order(root)
    .map(([k, v]) => v.kind === 'object'
      ? `${quote(k)} {\n${emit(v, 1)}};\n`
      : emit({ kind: 'object', entries: new Map([[k, v]]) } as RObject, 0))
    .join('\n');
}
