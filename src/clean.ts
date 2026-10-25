/**
 * Cleaning of every string that comes from the controller or the daemon,
 * before it reaches the text or `structuredContent`. Anyone who can change a
 * controller's program or configuration can put text there, so nothing that
 * can hide, reorder or restyle text survives:
 *
 * 1. Whole ANSI escape sequences are removed.
 * 2. Every run of characters of the Unicode categories Cc (except newline and
 *    tab), Cf, Co, Cs, Zl and Zp, and of the variation selectors U+FE00 to
 *    U+FE0F and U+E0100 to U+E01EF, becomes one visible U+FFFD. That covers
 *    tag characters, zero-width characters, direction marks, bidi controls,
 *    line and paragraph separators and the soft hyphen.
 * 3. The text is cut at a length, marked `[cut]`.
 */

/** The longest controller string kept, where the daemon does not cut it already. */
export const TEXT_MAX = 1_000;

/** The longest RAPID source line kept. */
export const SOURCE_LINE_MAX = 2_000;

export const CUT_MARK = ' [cut]';
export const REPLACEMENT = '\uFFFD';

// CSI (ESC [ or the 8-bit CSI), OSC (ESC ] ... BEL or ST), DCS/SOS/PM/APC strings,
// then any other escape (ESC, intermediate bytes, a final byte). A lone ESC is left
// to step 2.
const ANSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?|(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[^\u001b\u009c]*(?:\u001b\\|\u009c)?|\u001b[ -/]*[0-~]/g;

const HIDDEN = /(?:(?![\n\t])[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}])+/gu;

/** Steps 1 and 2: no escape sequence and no hidden character left. */
export function scrub(text: string): string {
  return text.replace(ANSI, '').replace(HIDDEN, REPLACEMENT);
}

/** Cut at `max` characters (not inside a surrogate pair), marked. */
export function cut(text: string, max: number): string {
  if (text.length <= max) { return text; }
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) { end--; }
  return text.slice(0, end) + CUT_MARK;
}

/** A controller string, cleaned and cut at TEXT_MAX (or `max`). */
export function clean(text: string, max = TEXT_MAX): string {
  return cut(scrub(text), max);
}

export function cleanOrNull(text: string | null | undefined, max = TEXT_MAX): string | null {
  return text === null || text === undefined ? null : clean(text, max);
}

/** Every string in a value, cleaned (objects and arrays are copied). */
export function cleanDeep<T>(value: T, max = TEXT_MAX): T {
  if (typeof value === 'string') { return clean(value, max) as T; }
  if (Array.isArray(value)) { return value.map(v => cleanDeep(v, max)) as T; }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out[k] = cleanDeep(v, max); }
    return out as T;
  }
  return value;
}

/** The first sentence of a text: up to the first `.`, `!` or `?` followed by a space or the end, or the first line. */
export function firstSentence(text: string | null): string | null {
  if (text === null) { return null; }
  const line = text.split('\n').find(l => l.trim() !== '') ?? '';
  const m = /^.*?[.!?](?=\s|$)/.exec(line.trim());
  return (m ? m[0] : line.trim()) || null;
}
