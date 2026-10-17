/**
 * Speeds up regexes whose first alternative starts with a greedy "match anything" run,
 * such as `[\s\S]*<scene>|</scene>` from popular presets.
 *
 * Without an anchor, a string that lacks `<scene>` makes the engine retry that run from
 * every position, which is quadratic in the string length. The first alternative can only
 * ever match at position 0: if `<scene>` occurs anywhere, the greedy run matches from 0 to the
 * last occurrence, so no later occurrence remains; if it does not occur, no position matches.
 * Anchoring it to the start of the input therefore keeps every result the same, provided the
 * rest of the alternative always consumes at least one character (otherwise an extra empty
 * match at the end would be lost). Only that safe shape is rewritten; anything else is
 * returned untouched.
 */

const WILDCARD_RUNS = ['[\\s\\S]*', '[\\S\\s]*', '[\\w\\W]*', '[\\W\\w]*', '[\\d\\D]*', '[\\D\\d]*', '[^]*'];
const SPECIAL = new Set(['\\', '^', '$', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}']);
const OPTIONAL_QUANTIFIER = new Set(['?', '*', '{']);

/**
 * Length of a single atom that always consumes exactly one character, or 0.
 * Accepts a plain literal or an escaped punctuation character such as `\<` or `\/`.
 * @param {string} source
 * @param {number} index
 */
function literalLength(source, index) {
    const char = source[index];
    if (char === undefined) return 0;
    if (char === '\\') {
        const escaped = source[index + 1];
        return escaped !== undefined && /[^\p{L}\p{N}_]/u.test(escaped) ? 2 : 0;
    }
    return SPECIAL.has(char) ? 0 : 1;
}

/**
 * Index just past the group that opens at `index`, or -1 if the group may match empty
 * (it has a top-level alternation) or cannot be parsed.
 * @param {string} source
 * @param {number} index
 */
function groupEnd(source, index) {
    let depth = 0;
    let inClass = false;
    for (let i = index; i < source.length; i++) {
        const char = source[i];
        if (char === '\\') {
            i++;
        } else if (inClass) {
            if (char === ']') inClass = false;
        } else if (char === '[') {
            inClass = true;
        } else if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth === 0) return i + 1;
        } else if (char === '|' && depth === 1) {
            return -1;
        }
    }
    return -1;
}

/**
 * Whether the pattern starting at `index` always consumes at least one character first.
 * @param {string} source
 * @param {number} index
 */
function startsWithRequiredCharacter(source, index) {
    const literal = literalLength(source, index);
    if (literal) {
        return !OPTIONAL_QUANTIFIER.has(source[index + literal]);
    }
    if (source[index] !== '(') {
        return false;
    }
    // Capturing, non-capturing or named group whose body starts with a required literal.
    const opener = /^\((?:\?:|\?<[A-Za-z_$][\w$]*>)?/.exec(source.slice(index))?.[0];
    if (!opener || source.startsWith('(?<=', index) || source.startsWith('(?<!', index)) {
        return false;
    }
    const end = groupEnd(source, index);
    if (end === -1 || OPTIONAL_QUANTIFIER.has(source[end])) {
        return false;
    }
    return startsWithRequiredCharacter(source, index + opener.length);
}

/**
 * Returns an equivalent regex with the leading wildcard run anchored to the start of the
 * input when that is provably safe, otherwise the same regex.
 * @param {RegExp} regex
 * @returns {RegExp}
 */
export function anchorLeadingWildcard(regex) {
    if (!(regex instanceof RegExp) || regex.sticky) {
        return regex;
    }
    const { source, flags } = regex;
    const run = WILDCARD_RUNS.find(prefix => source.startsWith(prefix))
        ?? (regex.dotAll && source.startsWith('.*') ? '.*' : null);
    if (!run || source[run.length] === '?' || !startsWithRequiredCharacter(source, run.length)) {
        return regex;
    }
    // `^` means "start of input" unless the m flag makes it match at every line start.
    const anchor = regex.multiline ? '(?<![\\s\\S])' : '^';
    try {
        return new RegExp(anchor + source, flags);
    } catch {
        return regex;
    }
}
