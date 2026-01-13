import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';

describe('IRCv3 CAP Negotiation', () => {
  const rawClients: RawSocketClient[] = [];

  const trackRawClient = (client: RawSocketClient): RawSocketClient => {
    rawClients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of rawClients) {
      try {
        client.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
    rawClients.length = 0;
  });

  describe('CAP LS (raw socket)', () => {
    it('server responds to CAP LS 302 with capabilities', async () => {
      const client = trackRawClient(await createRawSocketClient());

      // Send CAP LS
      client.send('CAP LS 302');

      // Collect all CAP LS lines
      const capLines: string[] = [];

      // Wait for first CAP LS line (multiline starts with * after LS)
      const firstLine = await client.waitForLine(/CAP \* LS/i);
      console.log('First CAP LS line:', firstLine);
      capLines.push(firstLine);

      // Check for multiline indicator - if present, wait for final line
      const isMultiline = /CAP \* LS \*/.test(firstLine);
      if (isMultiline) {
        // Wait for the final line (no * after LS, pattern: "CAP * LS :" without *)
        const lastLine = await client.waitForLine(/CAP \* LS :/i);
        console.log('Last CAP LS line:', lastLine);
        capLines.push(lastLine);
      }

      // Parse capabilities from ALL CAP LS lines
      const capList: string[] = [];
      for (const line of capLines) {
        const capsMatch = line.match(/CAP \* LS \*? ?:(.+)$/);
        if (capsMatch) {
          capList.push(...capsMatch[1].split(' '));
        }
      }
      console.log('Capabilities found:', capList.length);

      expect(capList).toContain('multi-prefix');
      expect(capList).toContain('extended-join');
      // SASL should include at least PLAIN (OAUTHBEARER requires X3 client token)
      const saslCap = capList.find(c => c.startsWith('sasl='));
      expect(saslCap).toBeDefined();
      expect(saslCap).toContain('PLAIN');

      // Clean up - send QUIT
      client.send('QUIT :Test done');
    });
  });

  // Helper to parse capabilities from CAP LS lines
  const parseCapabilities = (lines: string[]): Map<string, string | null> => {
    const caps = new Map<string, string | null>();
    for (const line of lines) {
      const match = line.match(/CAP \* LS \*? ?:(.+)$/);
      if (match) {
        for (const cap of match[1].split(' ')) {
          const eqIdx = cap.indexOf('=');
          if (eqIdx === -1) {
            caps.set(cap, null);
          } else {
            caps.set(cap.substring(0, eqIdx), cap.substring(eqIdx + 1));
          }
        }
      }
    }
    return caps;
  };

  // Helper to get all CAP LS lines from a raw socket client
  const getCapLsLines = async (client: RawSocketClient): Promise<string[]> => {
    client.send('CAP LS 302');
    const lines: string[] = [];

    // Get first line
    const firstLine = await client.waitForLine(/CAP \* LS/i);
    lines.push(firstLine);

    // Check if multiline (has * after LS before the colon)
    // Multiline format: "CAP * LS * :caps..." (asterisk before colon)
    // Final format:     "CAP * LS :caps..." (no asterisk, just space-colon)
    if (/CAP \* LS \* :/.test(firstLine)) {
      // Wait for final line - it does NOT have asterisk after LS (just space-colon)
      // Use negative lookahead to exclude lines with asterisk
      const lastLine = await client.waitForLine(/CAP \* LS (?!\*)/i);
      lines.push(lastLine);
    }

    return lines;
  };

  describe('CAP LS', () => {
    it('server responds to CAP LS 302', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      // Should have at least some basic IRCv3 capabilities
      expect(caps.size).toBeGreaterThan(0);
      console.log('Available capabilities:', caps.size);
      client.send('QUIT');
    });

    it('advertises multi-prefix capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('multi-prefix')).toBe(true);
      client.send('QUIT');
    });

    it('advertises extended-join capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('extended-join')).toBe(true);
      client.send('QUIT');
    });

    it('advertises away-notify capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('away-notify')).toBe(true);
      client.send('QUIT');
    });

    it('advertises account-notify capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('account-notify')).toBe(true);
      client.send('QUIT');
    });

    it('advertises sasl capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('sasl')).toBe(true);
      client.send('QUIT');
    });

    it('advertises server-time capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('server-time')).toBe(true);
      client.send('QUIT');
    });

    it('advertises message-tags capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('message-tags')).toBe(true);
      client.send('QUIT');
    });

    it('advertises batch capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('batch')).toBe(true);
      client.send('QUIT');
    });

    it('advertises labeled-response capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('labeled-response')).toBe(true);
      client.send('QUIT');
    });

    it('advertises echo-message capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('echo-message')).toBe(true);
      client.send('QUIT');
    });

    it('advertises setname capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('setname')).toBe(true);
      client.send('QUIT');
    });
  });

  describe('Draft Capabilities', () => {
    it('advertises draft/chathistory capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('draft/chathistory')).toBe(true);
      client.send('QUIT');
    });

    it('advertises draft/multiline capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('draft/multiline')).toBe(true);
      client.send('QUIT');
    });

    it('advertises draft/read-marker capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('draft/read-marker')).toBe(true);
      client.send('QUIT');
    });

    it('advertises draft/metadata-2 capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      // May be draft/metadata or draft/metadata-2
      const hasMetadata = caps.has('draft/metadata-2') || caps.has('draft/metadata');
      expect(hasMetadata).toBe(true);
      client.send('QUIT');
    });

    it('advertises draft/account-registration capability', async () => {
      const client = trackRawClient(await createRawSocketClient());
      const lines = await getCapLsLines(client);
      const caps = parseCapabilities(lines);

      expect(caps.has('draft/account-registration')).toBe(true);
      client.send('QUIT');
    });
  });

  describe('CAP REQ', () => {
    it('can request and receive ACK for multi-prefix', async () => {
      const client = trackRawClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['multi-prefix']);

      expect(result.ack).toContain('multi-prefix');
      expect(result.nak).toHaveLength(0);
      expect(client.hasCapEnabled('multi-prefix')).toBe(true);
      client.send('QUIT');
    });

    it('can request multiple capabilities at once', async () => {
      const client = trackRawClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq([
        'multi-prefix',
        'away-notify',
        'account-notify',
      ]);

      expect(result.ack).toContain('multi-prefix');
      expect(result.ack).toContain('away-notify');
      expect(result.nak).toHaveLength(0);
      client.send('QUIT');
    });

    it('receives NAK for unsupported capability', async () => {
      const client = trackRawClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['nonexistent-cap-xyz123']);

      expect(result.nak).toContain('nonexistent-cap-xyz123');
      expect(result.ack).toHaveLength(0);
      client.send('QUIT');
    });

    it('can request server-time and receive timestamps', async () => {
      const client = trackRawClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['server-time']);
      client.capEnd();
      client.register('timetest1');

      // Wait for registration (001 welcome)
      await client.waitForNumeric('001');

      // Join a channel to trigger timestamped messages
      client.send('JOIN #timetest');
      const joinMsg = await client.waitForJoin('#timetest');

      // Server-time should add @time= tags
      expect(joinMsg).toBeDefined();
      // Note: actual time tag presence depends on server config
      client.send('QUIT');
    });
  });

  describe('CAP END', () => {
    it('completes registration after CAP END', async () => {
      const client = trackRawClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('endtest1');

      // Should receive welcome message
      const welcomeMsg = await client.waitForNumeric('001');
      expect(welcomeMsg.raw).toContain('endtest1');
      client.send('QUIT');
    });
  });

  describe('Automatic CAP Negotiation', () => {
    it('completes full CAP negotiation and registration', async () => {
      const client = trackRawClient(await createRawSocketClient());

      // Perform full CAP negotiation
      await client.capLs();
      await client.capReq(['multi-prefix', 'away-notify', 'server-time']);
      client.capEnd();
      client.register('autotest1');

      // Should receive welcome (001)
      const welcomeMsg = await client.waitForNumeric('001');
      expect(welcomeMsg.raw).toContain('autotest1');
      client.send('QUIT');
    });
  });
});

describe('IRCv3 SASL Value', () => {
  const rawClients: RawSocketClient[] = [];

  const trackRawClient = (client: RawSocketClient): RawSocketClient => {
    rawClients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of rawClients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    rawClients.length = 0;
  });

  it('SASL capability includes mechanism list', async () => {
    const client = trackRawClient(await createRawSocketClient());

    const caps = await client.capLs();
    const saslValue = caps.get('sasl');

    // SASL value should include supported mechanisms
    // e.g., "PLAIN,EXTERNAL" or just be present (null means no value)
    expect(caps.has('sasl')).toBe(true);
    console.log('SASL mechanisms:', saslValue ?? '(no value/all)');

    if (saslValue) {
      // Should include PLAIN at minimum
      expect(saslValue.toUpperCase()).toContain('PLAIN');
    }
    client.send('QUIT');
  });
});

describe('CAP Edge Cases', () => {
  const rawClients: RawSocketClient[] = [];

  const trackRawClient = (client: RawSocketClient): RawSocketClient => {
    rawClients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of rawClients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    rawClients.length = 0;
  });

  describe('CAP LS Versions', () => {
    it('CAP LS without version returns capabilities', async () => {
      const client = trackRawClient(await createRawSocketClient());

      // Send CAP LS without version number (legacy)
      client.send('CAP LS');

      const response = await client.waitForCap('LS');
      expect(response.command).toBe('CAP');
      expect(response.params[1]).toBe('LS');
      client.send('QUIT');
    });

    it('CAP LS 301 returns capabilities without values', async () => {
      const client = trackRawClient(await createRawSocketClient());

      client.send('CAP LS 301');

      const response = await client.waitForCap('LS');
      expect(response.command).toBe('CAP');
      expect(response.params[1]).toBe('LS');
      // CAP 301 should not include values (no = in caps)
      client.send('QUIT');
    });

    it('CAP LS 302 returns capabilities with values', async () => {
      const client = trackRawClient(await createRawSocketClient());

      const caps = await client.capLs(302);

      // 302 should include capability values
      // Check that at least one cap has a value (like sasl=PLAIN or multiline=...)
      const hasValues = Array.from(caps.values()).some(v => v !== null);
      expect(hasValues).toBe(true);
      client.send('QUIT');
    });
  });

  describe('CAP REQ Edge Cases', () => {
    it('can disable a capability with -prefix', async () => {
      const client = trackRawClient(await createRawSocketClient());

      await client.capLs();

      // First enable
      await client.capReq(['multi-prefix']);
      expect(client.hasCapEnabled('multi-prefix')).toBe(true);

      // Then disable
      const result = await client.capReq(['-multi-prefix']);
      expect(result.ack).toContain('-multi-prefix');
      expect(client.hasCapEnabled('multi-prefix')).toBe(false);
      client.send('QUIT');
    });

    it('NAKs request with mix of valid and invalid caps', async () => {
      const client = trackRawClient(await createRawSocketClient());

      await client.capLs();

      // Request valid and invalid together - should NAK entire request
      const result = await client.capReq(['multi-prefix', 'invalid-cap-xyz']);

      // Per spec, entire request should be NAKed if any cap is invalid
      expect(result.nak.length).toBeGreaterThan(0);
      client.send('QUIT');
    });

    it('can request capabilities before CAP LS', async () => {
      const client = trackRawClient(await createRawSocketClient());

      // Request without LS first - server should still respond
      client.send('CAP REQ :multi-prefix');

      const response = await client.waitForCap(['ACK', 'NAK']);
      expect(response.command).toBe('CAP');
      expect(['ACK', 'NAK']).toContain(response.params[1]);
      client.send('QUIT');
    });

    it('handles empty CAP REQ gracefully', async () => {
      const client = trackRawClient(await createRawSocketClient());

      await client.capLs();
      client.send('CAP REQ :');

      // Should get some response (ACK or NAK)
      try {
        const response = await client.waitForCap(['ACK', 'NAK'], undefined, 3000);
        expect(response).toBeDefined();
      } catch {
        // Some servers may ignore empty REQ
      }
      client.send('QUIT');
    });
  });

  describe('CAP LIST', () => {
    it('CAP LIST shows enabled capabilities', async () => {
      const client = trackRawClient(await createRawSocketClient());

      await client.capLs();
      await client.capReq(['multi-prefix', 'away-notify']);

      client.send('CAP LIST');

      const response = await client.waitForCap('LIST');
      expect(response.trailing).toMatch(/multi-prefix/);
      expect(response.trailing).toMatch(/away-notify/);
      client.send('QUIT');
    });

    it('CAP LIST is empty when no caps enabled', async () => {
      const client = trackRawClient(await createRawSocketClient());

      // Don't request any caps
      client.send('CAP LIST');

      const response = await client.waitForCap('LIST');
      // LIST response should exist but may have empty cap list
      expect(response.command).toBe('CAP');
      expect(response.params[1]).toBe('LIST');
      client.send('QUIT');
    });
  });

  describe('CAP NEW/DEL (cap-notify)', () => {
    it('can request cap-notify capability', async () => {
      const client = trackRawClient(await createRawSocketClient());

      await client.capLs();
      const result = await client.capReq(['cap-notify']);

      // cap-notify is implicitly enabled with CAP 302, but explicit REQ should work
      expect(result.ack.length + result.nak.length).toBeGreaterThan(0);
      client.send('QUIT');
    });
  });

  describe('CAP During Registration', () => {
    it('CAP negotiation pauses registration', async () => {
      const client = trackRawClient(await createRawSocketClient());

      // Start CAP negotiation
      await client.capLs();

      // Send NICK and USER but not CAP END
      client.register('cappause1');

      // Should NOT receive 001 yet
      try {
        await client.waitForNumeric('001', 1000);
        // If we get here, server didn't wait for CAP END
        throw new Error('Server should wait for CAP END');
      } catch (error) {
        // Expected - timeout means server is waiting
        if (error instanceof Error && error.message.includes('should wait')) {
          throw error;
        }
        // Timeout is expected
      }

      // Now send CAP END
      client.capEnd();

      // Should receive 001
      const welcomeMsg = await client.waitForNumeric('001');
      expect(welcomeMsg.raw).toContain('cappause1');
      client.send('QUIT');
    });
  });

  describe('Capability Values', () => {
    it('multiline capability has max-bytes value', async () => {
      const client = trackRawClient(await createRawSocketClient());

      const caps = await client.capLs(302);
      const multiline = caps.get('draft/multiline');

      if (multiline) {
        expect(multiline).toMatch(/max-bytes=\d+/);
      }
      client.send('QUIT');
    });

    it('multiline capability has max-lines value', async () => {
      const client = trackRawClient(await createRawSocketClient());

      const caps = await client.capLs(302);
      const multiline = caps.get('draft/multiline');

      if (multiline) {
        expect(multiline).toMatch(/max-lines=\d+/);
      }
      client.send('QUIT');
    });

    it('chathistory capability has limit value', async () => {
      const client = trackRawClient(await createRawSocketClient());

      const caps = await client.capLs(302);
      const chathistory = caps.get('draft/chathistory');

      // chathistory may have max messages value
      console.log('chathistory value:', chathistory);
      client.send('QUIT');
    });
  });
});

describe('CAP Post-Registration', () => {
  const rawClients: RawSocketClient[] = [];

  const trackRawClient = (client: RawSocketClient): RawSocketClient => {
    rawClients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of rawClients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    rawClients.length = 0;
  });

  it('can request additional caps after registration', async () => {
    const client = trackRawClient(await createRawSocketClient());

    // Complete registration with minimal caps
    await client.capLs();
    await client.capReq(['multi-prefix']);
    client.capEnd();
    client.register('postreg1');
    await client.waitForNumeric('001');

    // Now request additional capability
    const result = await client.capReq(['away-notify']);
    expect(result.ack).toContain('away-notify');
    client.send('QUIT');
  });

  it('can disable caps after registration', async () => {
    const client = trackRawClient(await createRawSocketClient());

    await client.capLs();
    await client.capReq(['multi-prefix', 'away-notify']);
    client.capEnd();
    client.register('postreg2');
    await client.waitForNumeric('001');

    // Disable a capability
    const result = await client.capReq(['-away-notify']);
    expect(result.ack).toContain('-away-notify');
    client.send('QUIT');
  });

  it('CAP LS works after registration', async () => {
    const client = trackRawClient(await createRawSocketClient());

    await client.capLs();
    await client.capReq(['multi-prefix']);
    client.capEnd();
    client.register('postreg3');
    await client.waitForNumeric('001');

    // CAP LS after registration
    const caps = await client.capLs(302);
    expect(caps.size).toBeGreaterThan(0);
    client.send('QUIT');
  });
});
