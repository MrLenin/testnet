/**
 * P10 Protocol Utilities
 *
 * Provides encoding/decoding for P10 base64 formats including:
 * - Server/user numerics
 * - IP addresses (IPv4 and IPv6)
 *
 * Reference: P10_PROTOCOL_REFERENCE.md, Jobe's Python implementation
 */

/**
 * P10 Base64 alphabet (64 characters)
 * A-Z (0-25), a-z (26-51), 0-9 (52-61), [ (62), ] (63)
 */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789[]';

/**
 * Compression marker for IPv6 zero words (like :: in IPv6 notation)
 */
const COMPRESSION_MARKER = '_';

/**
 * Decode a single P10 base64 character to its 6-bit value
 */
export function b64CharToValue(char: string): number {
  const idx = B64_ALPHABET.indexOf(char);
  if (idx === -1) {
    throw new Error(`Invalid P10 base64 character: ${char}`);
  }
  return idx;
}

/**
 * Encode a 6-bit value to its P10 base64 character
 */
export function valueToB64Char(value: number): string {
  if (value < 0 || value > 63) {
    throw new Error(`Value out of range for P10 base64: ${value}`);
  }
  return B64_ALPHABET[value];
}

/**
 * Decode a 3-character P10 base64 group to a 16-bit word
 *
 * Format: [C1][C2][C3] where:
 * - 3 chars × 6 bits = 18 bits available
 * - Only 16 bits used for the word value
 * - C1 uses only lower 4 bits (upper 2 bits ignored)
 * - C2 uses full 6 bits
 * - C3 uses full 6 bits
 * Value = ((val(C1) & 0x0F) << 12) | (val(C2) << 6) | val(C3)
 */
export function decodeWord(chars: string): number {
  if (chars.length !== 3) {
    throw new Error(`Word must be 3 characters, got ${chars.length}`);
  }
  const v1 = b64CharToValue(chars[0]) & 0x0F; // Only lower 4 bits (16 bits total)
  const v2 = b64CharToValue(chars[1]);
  const v3 = b64CharToValue(chars[2]);
  return (v1 << 12) | (v2 << 6) | v3;
}

/**
 * Encode a 16-bit word to a 3-character P10 base64 group
 *
 * Uses [4-bit][6-bit][6-bit] = 16 bits within 18-bit capacity
 */
export function encodeWord(word: number): string {
  if (word < 0 || word > 0xFFFF) {
    throw new Error(`Word out of range: ${word}`);
  }
  const c1 = (word >> 12) & 0x0F; // Upper 4 bits
  const c2 = (word >> 6) & 0x3F;  // Middle 6 bits
  const c3 = word & 0x3F;         // Lower 6 bits
  return valueToB64Char(c1) + valueToB64Char(c2) + valueToB64Char(c3);
}

/**
 * Decode 6-character P10 base64 to IPv4 address
 *
 * 6 chars = 36 bits, but only lower 32 are used
 */
export function decodeIPv4(encoded: string): string {
  if (encoded.length !== 6) {
    throw new Error(`IPv4 encoding must be 6 characters, got ${encoded.length}`);
  }

  // Decode as 32-bit integer (network byte order - big endian)
  let value = 0;
  for (let i = 0; i < 6; i++) {
    value = (value << 6) | b64CharToValue(encoded[i]);
  }
  // Only use lower 32 bits
  value = value & 0xFFFFFFFF;

  // Extract octets (network byte order)
  const a = (value >> 24) & 0xFF;
  const b = (value >> 16) & 0xFF;
  const c = (value >> 8) & 0xFF;
  const d = value & 0xFF;

  return `${a}.${b}.${c}.${d}`;
}

/**
 * Encode IPv4 address to 6-character P10 base64
 */
export function encodeIPv4(ip: string): string {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }

  // Combine into 32-bit integer (network byte order)
  const value = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];

  // Encode as 6 base64 characters (upper 4 bits will be 0)
  // Iterate from high bits to low bits, appending each character
  let result = '';
  for (let i = 5; i >= 0; i--) {
    result += valueToB64Char((value >> (i * 6)) & 0x3F);
  }

  return result;
}

/**
 * Decode P10 base64 IPv6 address
 *
 * Format:
 * - 3 chars per 16-bit word
 * - '_' = compression marker (consecutive zero words, like ::)
 * - Full address = 24 chars (8 words)
 * - With compression: variable length
 */
export function decodeIPv6(encoded: string): string {
  if (encoded.length === 0) {
    throw new Error('Empty IPv6 encoding');
  }

  // Special case: just compression marker = all zeros
  if (encoded === COMPRESSION_MARKER) {
    return '::';
  }

  const words: number[] = [];

  if (encoded.includes(COMPRESSION_MARKER)) {
    // Split on compression marker
    const [left, right] = encoded.split(COMPRESSION_MARKER);

    // Decode left side words
    const leftWords: number[] = [];
    for (let i = 0; i < left.length; i += 3) {
      if (i + 3 <= left.length) {
        leftWords.push(decodeWord(left.substring(i, i + 3)));
      }
    }

    // Decode right side words
    const rightWords: number[] = [];
    for (let i = 0; i < right.length; i += 3) {
      if (i + 3 <= right.length) {
        rightWords.push(decodeWord(right.substring(i, i + 3)));
      }
    }

    // Calculate number of zero words
    const zeroCount = 8 - leftWords.length - rightWords.length;
    if (zeroCount < 0) {
      throw new Error('IPv6 encoding too long');
    }

    // Combine: left + zeros + right
    words.push(...leftWords);
    for (let i = 0; i < zeroCount; i++) {
      words.push(0);
    }
    words.push(...rightWords);
  } else {
    // No compression - must be 24 characters (8 words)
    if (encoded.length !== 24) {
      throw new Error(`Full IPv6 encoding must be 24 characters, got ${encoded.length}`);
    }
    for (let i = 0; i < 24; i += 3) {
      words.push(decodeWord(encoded.substring(i, i + 3)));
    }
  }

  if (words.length !== 8) {
    throw new Error(`IPv6 must have 8 words, got ${words.length}`);
  }

  // Format as IPv6 with :: compression
  return formatIPv6(words);
}

/**
 * Format IPv6 words array as string with optimal :: compression
 */
function formatIPv6(words: number[]): string {
  // Find longest run of consecutive zeros
  let bestStart = -1;
  let bestLen = 0;
  let currentStart = -1;
  let currentLen = 0;

  for (let i = 0; i < 8; i++) {
    if (words[i] === 0) {
      if (currentStart === -1) {
        currentStart = i;
        currentLen = 1;
      } else {
        currentLen++;
      }
    } else {
      if (currentLen > bestLen) {
        bestStart = currentStart;
        bestLen = currentLen;
      }
      currentStart = -1;
      currentLen = 0;
    }
  }
  if (currentLen > bestLen) {
    bestStart = currentStart;
    bestLen = currentLen;
  }

  // Build output with compression if beneficial
  if (bestLen < 2) {
    // No compression worthwhile
    return words.map(w => w.toString(16)).join(':');
  }

  const left = words.slice(0, bestStart).map(w => w.toString(16));
  const right = words.slice(bestStart + bestLen).map(w => w.toString(16));

  if (left.length === 0 && right.length === 0) {
    return '::';
  } else if (left.length === 0) {
    return '::' + right.join(':');
  } else if (right.length === 0) {
    return left.join(':') + '::';
  } else {
    return left.join(':') + '::' + right.join(':');
  }
}

/**
 * Encode IPv6 address to P10 base64
 */
export function encodeIPv6(ip: string): string {
  // Parse IPv6 address
  const words = parseIPv6(ip);

  // Find longest run of consecutive zeros for compression
  let bestStart = -1;
  let bestLen = 0;
  let currentStart = -1;
  let currentLen = 0;

  for (let i = 0; i < 8; i++) {
    if (words[i] === 0) {
      if (currentStart === -1) {
        currentStart = i;
        currentLen = 1;
      } else {
        currentLen++;
      }
    } else {
      if (currentLen > bestLen) {
        bestStart = currentStart;
        bestLen = currentLen;
      }
      currentStart = -1;
      currentLen = 0;
    }
  }
  if (currentLen > bestLen) {
    bestStart = currentStart;
    bestLen = currentLen;
  }

  // Encode with compression if there are zeros
  if (bestLen > 0) {
    const left = words.slice(0, bestStart).map(encodeWord).join('');
    const right = words.slice(bestStart + bestLen).map(encodeWord).join('');
    return left + COMPRESSION_MARKER + right;
  }

  // No compression - encode all 8 words
  return words.map(encodeWord).join('');
}

/**
 * Parse IPv6 address string to array of 8 16-bit words
 */
function parseIPv6(ip: string): number[] {
  // Handle :: compression
  const doubleColon = ip.indexOf('::');
  let parts: string[];
  let words: number[] = [];

  if (doubleColon !== -1) {
    const left = ip.substring(0, doubleColon);
    const right = ip.substring(doubleColon + 2);

    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const zeroCount = 8 - leftParts.length - rightParts.length;

    words = leftParts.map(p => parseInt(p, 16) || 0);
    for (let i = 0; i < zeroCount; i++) {
      words.push(0);
    }
    words.push(...rightParts.map(p => parseInt(p, 16) || 0));
  } else {
    parts = ip.split(':');
    if (parts.length !== 8) {
      throw new Error(`Invalid IPv6 address: ${ip}`);
    }
    words = parts.map(p => parseInt(p, 16));
  }

  if (words.length !== 8) {
    throw new Error(`Invalid IPv6 address: ${ip}`);
  }

  return words;
}

/**
 * Decode P10 base64 IP address (auto-detect IPv4 or IPv6)
 *
 * - 6 characters = IPv4
 * - Contains '_' or 24 characters = IPv6
 */
export function decodeIP(encoded: string): string {
  if (encoded.length === 6 && !encoded.includes(COMPRESSION_MARKER)) {
    return decodeIPv4(encoded);
  }
  return decodeIPv6(encoded);
}

/**
 * Encode IP address to P10 base64 (auto-detect IPv4 or IPv6)
 */
export function encodeIP(ip: string): string {
  if (ip.includes(':')) {
    return encodeIPv6(ip);
  }
  return encodeIPv4(ip);
}

/**
 * Check if an IP is IPv4-mapped IPv6 (::ffff:x.x.x.x)
 */
export function isIPv4Mapped(ip: string): boolean {
  return ip.toLowerCase().startsWith('::ffff:');
}

/**
 * Extract IPv4 from IPv4-mapped IPv6 address
 */
export function extractIPv4FromMapped(ip: string): string | null {
  if (!isIPv4Mapped(ip)) {
    return null;
  }
  return ip.substring(7); // Skip "::ffff:"
}

/**
 * Decode P10 server numeric (2 characters) to number
 */
export function decodeServerNumeric(numeric: string): number {
  if (numeric.length !== 2) {
    throw new Error(`Server numeric must be 2 characters, got ${numeric.length}`);
  }
  return (b64CharToValue(numeric[0]) << 6) | b64CharToValue(numeric[1]);
}

/**
 * Encode server number to P10 numeric (2 characters)
 */
export function encodeServerNumeric(num: number): string {
  if (num < 0 || num > 4095) {
    throw new Error(`Server number out of range: ${num}`);
  }
  return valueToB64Char((num >> 6) & 0x3F) + valueToB64Char(num & 0x3F);
}

/**
 * Decode P10 user numeric (3 characters) to number
 */
export function decodeUserNumeric(numeric: string): number {
  if (numeric.length !== 3) {
    throw new Error(`User numeric must be 3 characters, got ${numeric.length}`);
  }
  return (b64CharToValue(numeric[0]) << 12) |
         (b64CharToValue(numeric[1]) << 6) |
         b64CharToValue(numeric[2]);
}

/**
 * Encode user number to P10 numeric (3 characters)
 */
export function encodeUserNumeric(num: number): string {
  if (num < 0 || num > 262143) {
    throw new Error(`User number out of range: ${num}`);
  }
  return valueToB64Char((num >> 12) & 0x3F) +
         valueToB64Char((num >> 6) & 0x3F) +
         valueToB64Char(num & 0x3F);
}

/**
 * Decode full user numeric (5 characters: 2 server + 3 user)
 */
export function decodeFullNumeric(numeric: string): { server: number; user: number } {
  if (numeric.length !== 5) {
    throw new Error(`Full numeric must be 5 characters, got ${numeric.length}`);
  }
  return {
    server: decodeServerNumeric(numeric.substring(0, 2)),
    user: decodeUserNumeric(numeric.substring(2, 5))
  };
}

/**
 * Encode server and user numbers to full P10 numeric (5 characters)
 */
export function encodeFullNumeric(server: number, user: number): string {
  return encodeServerNumeric(server) + encodeUserNumeric(user);
}
