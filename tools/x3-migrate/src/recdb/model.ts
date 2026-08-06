export type RValue = RString | RList | RObject;
export interface RString { kind: 'string'; value: string }
export interface RList   { kind: 'list';   items: string[] }
export interface RObject { kind: 'object'; entries: Map<string, RValue> }

export const rstr = (value: string): RString => ({ kind: 'string', value });
export const rlist = (items: string[]): RList => ({ kind: 'list', items });
export const robj = (pairs?: Iterable<[string, RValue]>): RObject =>
  ({ kind: 'object', entries: new Map(pairs ?? []) });

/** RFC1459 casemapping fold: A-Z -> a-z, [ -> {, ] -> }, \ -> |, ~ -> ^.
 * Matches X3's irccasecmp key semantics (dict-splay.c). */
export function ircFold(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0x41 && c <= 0x5a) out += String.fromCharCode(c + 32);
    else if (ch === '[') out += '{';
    else if (ch === ']') out += '}';
    else if (ch === '\\') out += '|';
    else if (ch === '~') out += '^';
    else out += ch;
  }
  return out;
}

export function oget(obj: RObject, key: string): RValue | undefined {
  const want = ircFold(key);
  let found: RValue | undefined;
  for (const [k, v] of obj.entries) if (ircFold(k) === want) found = v; // last wins, like X3
  return found;
}
export const ogetStr = (o: RObject, k: string): string | undefined => {
  const v = oget(o, k); return v?.kind === 'string' ? v.value : undefined;
};
export const ogetObj = (o: RObject, k: string): RObject | undefined => {
  const v = oget(o, k); return v?.kind === 'object' ? v : undefined;
};
export const ogetList = (o: RObject, k: string): string[] | undefined => {
  const v = oget(o, k); return v?.kind === 'list' ? v.items : undefined;
};
