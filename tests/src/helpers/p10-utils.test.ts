/**
 * Unit tests for P10 base64 encoding/decoding utilities
 *
 * Test vectors from Jobe's Python reference implementation:
 * https://jobe.users.mdbnet.net/p10b64ipv6decode.txt
 */

import { describe, it, expect } from 'vitest';
import {
  b64CharToValue,
  valueToB64Char,
  decodeWord,
  encodeWord,
  decodeIPv4,
  encodeIPv4,
  decodeIPv6,
  encodeIPv6,
  decodeIP,
  encodeIP,
  decodeServerNumeric,
  encodeServerNumeric,
  decodeUserNumeric,
  encodeUserNumeric,
  decodeFullNumeric,
  encodeFullNumeric,
} from './p10-utils.js';

describe('P10 Base64 Character Encoding', () => {
  it('should decode A as 0', () => {
    expect(b64CharToValue('A')).toBe(0);
  });

  it('should decode Z as 25', () => {
    expect(b64CharToValue('Z')).toBe(25);
  });

  it('should decode a as 26', () => {
    expect(b64CharToValue('a')).toBe(26);
  });

  it('should decode z as 51', () => {
    expect(b64CharToValue('z')).toBe(51);
  });

  it('should decode 0 as 52', () => {
    expect(b64CharToValue('0')).toBe(52);
  });

  it('should decode 9 as 61', () => {
    expect(b64CharToValue('9')).toBe(61);
  });

  it('should decode [ as 62', () => {
    expect(b64CharToValue('[')).toBe(62);
  });

  it('should decode ] as 63', () => {
    expect(b64CharToValue(']')).toBe(63);
  });

  it('should round-trip all values 0-63', () => {
    for (let i = 0; i < 64; i++) {
      const char = valueToB64Char(i);
      expect(b64CharToValue(char)).toBe(i);
    }
  });

  it('should throw on invalid character', () => {
    expect(() => b64CharToValue('!')).toThrow();
    expect(() => b64CharToValue('_')).toThrow(); // _ is compression marker, not alphabet
  });
});

describe('P10 Word Encoding (16-bit)', () => {
  it('should decode AAA as 0', () => {
    expect(decodeWord('AAA')).toBe(0);
  });

  it('should decode AAB as 1', () => {
    expect(decodeWord('AAB')).toBe(1);
  });

  it('should decode BAA as 0x1000 (4096)', () => {
    // B = 1, only lower 2 bits used, so 1 << 12 = 0x1000
    expect(decodeWord('BAA')).toBe(0x1000);
  });

  it('should round-trip word values', () => {
    const testValues = [0, 1, 255, 256, 4095, 4096, 0x1000, 0xFFFF];
    for (const value of testValues) {
      const encoded = encodeWord(value);
      expect(encoded.length).toBe(3);
      expect(decodeWord(encoded)).toBe(value);
    }
  });

  it('should throw on invalid word length', () => {
    expect(() => decodeWord('AA')).toThrow();
    expect(() => decodeWord('AAAA')).toThrow();
  });
});

describe('P10 IPv4 Encoding', () => {
  it('should decode AAAAAA as 0.0.0.0', () => {
    expect(decodeIPv4('AAAAAA')).toBe('0.0.0.0');
  });

  it('should round-trip 0.0.0.0', () => {
    const encoded = encodeIPv4('0.0.0.0');
    expect(encoded.length).toBe(6);
    expect(decodeIPv4(encoded)).toBe('0.0.0.0');
  });

  it('should round-trip 127.0.0.1', () => {
    const encoded = encodeIPv4('127.0.0.1');
    expect(encoded.length).toBe(6);
    expect(decodeIPv4(encoded)).toBe('127.0.0.1');
  });

  it('should round-trip 192.168.1.1', () => {
    const encoded = encodeIPv4('192.168.1.1');
    expect(encoded.length).toBe(6);
    expect(decodeIPv4(encoded)).toBe('192.168.1.1');
  });

  it('should round-trip 255.255.255.255', () => {
    const encoded = encodeIPv4('255.255.255.255');
    expect(encoded.length).toBe(6);
    expect(decodeIPv4(encoded)).toBe('255.255.255.255');
  });

  it('should throw on invalid IPv4', () => {
    expect(() => encodeIPv4('256.0.0.0')).toThrow();
    expect(() => encodeIPv4('1.2.3')).toThrow();
    expect(() => encodeIPv4('not.an.ip.addr')).toThrow();
  });
});

describe('P10 IPv6 Encoding - Jobe Test Vectors', () => {
  it('should decode _ as :: (all zeros)', () => {
    const result = decodeIPv6('_');
    expect(result).toBe('::');
  });

  it('should decode AAA_AAA as :: (explicit zero words)', () => {
    const result = decodeIPv6('AAA_AAA');
    expect(result).toBe('::');
  });

  it('should decode BAA_BAA as 1000::1000', () => {
    const result = decodeIPv6('BAA_BAA');
    expect(result).toBe('1000::1000');
  });

  it('should decode full 24-char encoding without compression', () => {
    // BAABAABAABAABAABAABAABAA = 1000:1000:1000:1000:1000:1000:1000:1000
    const result = decodeIPv6('BAABAABAABAABAABAABAABAA');
    expect(result).toBe('1000:1000:1000:1000:1000:1000:1000:1000');
  });

  it('should decode _AAB as ::1 (loopback)', () => {
    const result = decodeIPv6('_AAB');
    expect(result).toBe('::1');
  });
});

describe('P10 IPv6 Encoding - Round-trips', () => {
  it('should round-trip ::', () => {
    const encoded = encodeIPv6('::');
    const decoded = decodeIPv6(encoded);
    expect(decoded).toBe('::');
  });

  it('should round-trip ::1', () => {
    const encoded = encodeIPv6('::1');
    const decoded = decodeIPv6(encoded);
    expect(decoded).toBe('::1');
  });

  it('should round-trip 1000::1000', () => {
    const encoded = encodeIPv6('1000::1000');
    const decoded = decodeIPv6(encoded);
    expect(decoded).toBe('1000::1000');
  });

  it('should round-trip 2001:db8::1', () => {
    const encoded = encodeIPv6('2001:db8::1');
    const decoded = decodeIPv6(encoded);
    expect(decoded).toBe('2001:db8::1');
  });

  it('should round-trip fe80::1', () => {
    const encoded = encodeIPv6('fe80::1');
    const decoded = decodeIPv6(encoded);
    expect(decoded).toBe('fe80::1');
  });

  it('should round-trip full address without zeros', () => {
    const encoded = encodeIPv6('1:2:3:4:5:6:7:8');
    const decoded = decodeIPv6(encoded);
    expect(decoded).toBe('1:2:3:4:5:6:7:8');
  });
});

describe('P10 IP Auto-detection', () => {
  it('should auto-detect IPv4 from 6-char encoding', () => {
    const encoded = encodeIPv4('192.168.1.1');
    expect(encoded.length).toBe(6);
    const decoded = decodeIP(encoded);
    expect(decoded).toBe('192.168.1.1');
  });

  it('should auto-detect IPv6 from compression marker', () => {
    const decoded = decodeIP('_AAB');
    expect(decoded).toBe('::1');
  });

  it('should auto-detect IPv6 from 24-char encoding', () => {
    const decoded = decodeIP('BAABAABAABAABAABAABAABAA');
    expect(decoded).toBe('1000:1000:1000:1000:1000:1000:1000:1000');
  });

  it('should auto-encode IPv4', () => {
    const encoded = encodeIP('10.0.0.1');
    expect(encoded.length).toBe(6);
    expect(decodeIP(encoded)).toBe('10.0.0.1');
  });

  it('should auto-encode IPv6', () => {
    const encoded = encodeIP('::1');
    expect(encoded).toContain('_');
    expect(decodeIP(encoded)).toBe('::1');
  });
});

describe('P10 Server Numerics', () => {
  it('should decode AA as 0', () => {
    expect(decodeServerNumeric('AA')).toBe(0);
  });

  it('should decode AB as 1', () => {
    expect(decodeServerNumeric('AB')).toBe(1);
  });

  it('should decode BA as 64', () => {
    expect(decodeServerNumeric('BA')).toBe(64);
  });

  it('should decode ]] as 4095', () => {
    expect(decodeServerNumeric(']]')).toBe(4095);
  });

  it('should round-trip server numerics', () => {
    const testValues = [0, 1, 63, 64, 100, 1000, 4095];
    for (const num of testValues) {
      const encoded = encodeServerNumeric(num);
      expect(encoded.length).toBe(2);
      expect(decodeServerNumeric(encoded)).toBe(num);
    }
  });

  it('should throw on out-of-range server number', () => {
    expect(() => encodeServerNumeric(-1)).toThrow();
    expect(() => encodeServerNumeric(4096)).toThrow();
  });
});

describe('P10 User Numerics', () => {
  it('should decode AAA as 0', () => {
    expect(decodeUserNumeric('AAA')).toBe(0);
  });

  it('should decode AAB as 1', () => {
    expect(decodeUserNumeric('AAB')).toBe(1);
  });

  it('should decode ]]] as 262143', () => {
    expect(decodeUserNumeric(']]]')).toBe(262143);
  });

  it('should round-trip user numerics', () => {
    const testValues = [0, 1, 100, 1000, 10000, 100000, 262143];
    for (const num of testValues) {
      const encoded = encodeUserNumeric(num);
      expect(encoded.length).toBe(3);
      expect(decodeUserNumeric(encoded)).toBe(num);
    }
  });

  it('should throw on out-of-range user number', () => {
    expect(() => encodeUserNumeric(-1)).toThrow();
    expect(() => encodeUserNumeric(262144)).toThrow();
  });
});

describe('P10 Full Numerics (5-char)', () => {
  it('should decode AAAAA as server=0, user=0', () => {
    const { server, user } = decodeFullNumeric('AAAAA');
    expect(server).toBe(0);
    expect(user).toBe(0);
  });

  it('should decode ABAAB as server=1, user=1', () => {
    const { server, user } = decodeFullNumeric('ABAAB');
    expect(server).toBe(1);
    expect(user).toBe(1);
  });

  it('should round-trip full numerics', () => {
    const testCases = [
      { server: 0, user: 0 },
      { server: 1, user: 1 },
      { server: 100, user: 1000 },
      { server: 4095, user: 262143 },
    ];
    for (const { server, user } of testCases) {
      const encoded = encodeFullNumeric(server, user);
      expect(encoded.length).toBe(5);
      const decoded = decodeFullNumeric(encoded);
      expect(decoded.server).toBe(server);
      expect(decoded.user).toBe(user);
    }
  });
});
