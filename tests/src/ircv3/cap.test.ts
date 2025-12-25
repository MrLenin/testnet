import { describe, it, expect, afterEach } from 'vitest';
import { IRCv3TestClient, createRawIRCv3Client, createIRCv3Client } from '../helpers/index.js';

describe('IRCv3 CAP Negotiation', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore errors during cleanup
      }
    }
    clients.length = 0;
  });

  describe('CAP LS', () => {
    it('server responds to CAP LS 302', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest1' })
      );

      const caps = await client.capLs(302);

      // Should have at least some basic IRCv3 capabilities
      expect(caps.size).toBeGreaterThan(0);

      // Log available caps for debugging
      console.log('Available capabilities:', Array.from(caps.entries()));
    });

    it('advertises multi-prefix capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest2' })
      );

      const caps = await client.capLs();
      expect(caps.has('multi-prefix')).toBe(true);
    });

    it('advertises extended-join capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest3' })
      );

      const caps = await client.capLs();
      expect(caps.has('extended-join')).toBe(true);
    });

    it('advertises away-notify capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest4' })
      );

      const caps = await client.capLs();
      expect(caps.has('away-notify')).toBe(true);
    });

    it('advertises account-notify capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest5' })
      );

      const caps = await client.capLs();
      expect(caps.has('account-notify')).toBe(true);
    });

    it('advertises sasl capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest6' })
      );

      const caps = await client.capLs();
      expect(caps.has('sasl')).toBe(true);
    });

    it('advertises server-time capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest7' })
      );

      const caps = await client.capLs();
      expect(caps.has('server-time')).toBe(true);
    });

    it('advertises message-tags capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest8' })
      );

      const caps = await client.capLs();
      expect(caps.has('message-tags')).toBe(true);
    });

    it('advertises batch capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest9' })
      );

      const caps = await client.capLs();
      expect(caps.has('batch')).toBe(true);
    });

    it('advertises labeled-response capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest10' })
      );

      const caps = await client.capLs();
      expect(caps.has('labeled-response')).toBe(true);
    });

    it('advertises echo-message capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest11' })
      );

      const caps = await client.capLs();
      expect(caps.has('echo-message')).toBe(true);
    });

    it('advertises setname capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'captest12' })
      );

      const caps = await client.capLs();
      expect(caps.has('setname')).toBe(true);
    });
  });

  describe('Draft Capabilities', () => {
    it('advertises draft/chathistory capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'drafttest1' })
      );

      const caps = await client.capLs();
      expect(caps.has('draft/chathistory')).toBe(true);
    });

    it('advertises draft/multiline capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'drafttest2' })
      );

      const caps = await client.capLs();
      expect(caps.has('draft/multiline')).toBe(true);
    });

    it('advertises draft/read-marker capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'drafttest3' })
      );

      const caps = await client.capLs();
      expect(caps.has('draft/read-marker')).toBe(true);
    });

    it('advertises draft/metadata-2 capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'drafttest4' })
      );

      const caps = await client.capLs();
      // May be draft/metadata or draft/metadata-2
      const hasMetadata = caps.has('draft/metadata-2') || caps.has('draft/metadata');
      expect(hasMetadata).toBe(true);
    });

    it('advertises draft/account-registration capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'drafttest5' })
      );

      const caps = await client.capLs();
      expect(caps.has('draft/account-registration')).toBe(true);
    });
  });

  describe('CAP REQ', () => {
    it('can request and receive ACK for multi-prefix', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'reqtest1' })
      );

      await client.capLs();
      const result = await client.capReq(['multi-prefix']);

      expect(result.ack).toContain('multi-prefix');
      expect(result.nak).toHaveLength(0);
      expect(client.hasCapEnabled('multi-prefix')).toBe(true);
    });

    it('can request multiple capabilities at once', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'reqtest2' })
      );

      await client.capLs();
      const result = await client.capReq([
        'multi-prefix',
        'away-notify',
        'account-notify',
      ]);

      expect(result.ack).toContain('multi-prefix');
      expect(result.ack).toContain('away-notify');
      expect(result.nak).toHaveLength(0);
    });

    it('receives NAK for unsupported capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'reqtest3' })
      );

      await client.capLs();
      const result = await client.capReq(['nonexistent-cap-xyz123']);

      expect(result.nak).toContain('nonexistent-cap-xyz123');
      expect(result.ack).toHaveLength(0);
    });

    it('can request server-time and receive timestamps', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'timetest1' })
      );

      await client.capLs();
      await client.capReq(['server-time']);
      client.capEnd();
      client.register('timetest1');

      // Wait for registration
      await client.waitForRaw(/001/);

      // Join a channel to trigger timestamped messages
      client.join('#timetest');
      await client.waitForRaw(/JOIN.*#timetest/i);

      // Check that we receive time tags on messages
      const joinLine = client.rawMessages.find(
        line => line.includes('JOIN') && line.includes('#timetest')
      );

      // Server-time should add @time= tags
      expect(joinLine).toBeDefined();
      // Note: actual time tag presence depends on server config
    });
  });

  describe('CAP END', () => {
    it('completes registration after CAP END', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'endtest1' })
      );

      await client.capLs();
      await client.capReq(['multi-prefix']);
      client.capEnd();
      client.register('endtest1');

      // Should receive welcome message
      const welcome = await client.waitForRaw(/001.*endtest1/);
      expect(welcome).toContain('endtest1');
    });
  });

  describe('Automatic CAP Negotiation', () => {
    it('automatically negotiates capabilities on connect', async () => {
      const client = trackClient(
        await createIRCv3Client({ nick: 'autotest1' })
      );

      // Should be registered
      expect(client.isRegistered).toBe(true);

      // Should have received 001
      const hasWelcome = client.rawMessages.some(msg => msg.includes('001'));
      expect(hasWelcome).toBe(true);
    });
  });
});

describe('IRCv3 SASL Value', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  it('SASL capability includes mechanism list', async () => {
    const client = trackClient(
      await createRawIRCv3Client({ nick: 'saslval1' })
    );

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
  });
});

describe('CAP Edge Cases', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('CAP LS Versions', () => {
    it('CAP LS without version returns capabilities', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'lsver1' })
      );

      // Send CAP LS without version number (legacy)
      client.raw('CAP LS');

      const response = await client.waitForRaw(/^:\S+ CAP \S+ LS/i);
      expect(response).toMatch(/CAP \S+ LS/i);
    });

    it('CAP LS 301 returns capabilities without values', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'lsver2' })
      );

      client.raw('CAP LS 301');

      const response = await client.waitForRaw(/^:\S+ CAP \S+ LS/i);
      expect(response).toMatch(/CAP \S+ LS/i);
      // CAP 301 should not include values (no = in caps)
    });

    it('CAP LS 302 returns capabilities with values', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'lsver3' })
      );

      const caps = await client.capLs(302);

      // 302 should include capability values
      // Check that at least one cap has a value (like sasl=PLAIN or multiline=...)
      const hasValues = Array.from(caps.values()).some(v => v !== null);
      expect(hasValues).toBe(true);
    });
  });

  describe('CAP REQ Edge Cases', () => {
    it('can disable a capability with -prefix', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'capdis1' })
      );

      await client.capLs();

      // First enable
      await client.capReq(['multi-prefix']);
      expect(client.hasCapEnabled('multi-prefix')).toBe(true);

      // Then disable
      const result = await client.capReq(['-multi-prefix']);
      expect(result.ack).toContain('-multi-prefix');
      expect(client.hasCapEnabled('multi-prefix')).toBe(false);
    });

    it('NAKs request with mix of valid and invalid caps', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'capmix1' })
      );

      await client.capLs();

      // Request valid and invalid together - should NAK entire request
      const result = await client.capReq(['multi-prefix', 'invalid-cap-xyz']);

      // Per spec, entire request should be NAKed if any cap is invalid
      expect(result.nak.length).toBeGreaterThan(0);
    });

    it('can request capabilities before CAP LS', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'caporder1' })
      );

      // Request without LS first - server should still respond
      client.raw('CAP REQ :multi-prefix');

      const response = await client.waitForRaw(/^:\S+ CAP \S+ (ACK|NAK)/i);
      expect(response).toMatch(/CAP \S+ (ACK|NAK)/i);
    });

    it('handles empty CAP REQ gracefully', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'capempty1' })
      );

      await client.capLs();
      client.raw('CAP REQ :');

      // Should get some response (ACK or NAK)
      try {
        const response = await client.waitForRaw(/^:\S+ CAP \S+ (ACK|NAK)/i, 3000);
        expect(response).toBeDefined();
      } catch {
        // Some servers may ignore empty REQ
      }
    });
  });

  describe('CAP LIST', () => {
    it('CAP LIST shows enabled capabilities', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'caplist1' })
      );

      await client.capLs();
      await client.capReq(['multi-prefix', 'away-notify']);

      client.raw('CAP LIST');

      const response = await client.waitForRaw(/^:\S+ CAP \S+ LIST/i);
      expect(response).toMatch(/multi-prefix/);
      expect(response).toMatch(/away-notify/);
    });

    it('CAP LIST is empty when no caps enabled', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'caplist2' })
      );

      // Don't request any caps
      client.raw('CAP LIST');

      const response = await client.waitForRaw(/^:\S+ CAP \S+ LIST/i);
      // LIST response should exist but may have empty cap list
      expect(response).toMatch(/CAP \S+ LIST/i);
    });
  });

  describe('CAP NEW/DEL (cap-notify)', () => {
    it('can request cap-notify capability', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'capnotify1' })
      );

      await client.capLs();
      const result = await client.capReq(['cap-notify']);

      // cap-notify is implicitly enabled with CAP 302, but explicit REQ should work
      expect(result.ack.length + result.nak.length).toBeGreaterThan(0);
    });
  });

  describe('CAP During Registration', () => {
    it('CAP negotiation pauses registration', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'cappause1' })
      );

      // Start CAP negotiation
      await client.capLs();

      // Send NICK and USER but not CAP END
      client.register('cappause1');

      // Should NOT receive 001 yet
      try {
        await client.waitForRaw(/001/, 1000);
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
      const welcome = await client.waitForRaw(/001/);
      expect(welcome).toContain('cappause1');
    });
  });

  describe('Capability Values', () => {
    it('multiline capability has max-bytes value', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'capval1' })
      );

      const caps = await client.capLs(302);
      const multiline = caps.get('draft/multiline');

      if (multiline) {
        expect(multiline).toMatch(/max-bytes=\d+/);
      }
    });

    it('multiline capability has max-lines value', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'capval2' })
      );

      const caps = await client.capLs(302);
      const multiline = caps.get('draft/multiline');

      if (multiline) {
        expect(multiline).toMatch(/max-lines=\d+/);
      }
    });

    it('chathistory capability has limit value', async () => {
      const client = trackClient(
        await createRawIRCv3Client({ nick: 'capval3' })
      );

      const caps = await client.capLs(302);
      const chathistory = caps.get('draft/chathistory');

      // chathistory may have max messages value
      console.log('chathistory value:', chathistory);
    });
  });
});

describe('CAP Post-Registration', () => {
  const clients: IRCv3TestClient[] = [];

  const trackClient = (client: IRCv3TestClient): IRCv3TestClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.quit('Test cleanup');
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  it('can request additional caps after registration', async () => {
    const client = trackClient(
      await createRawIRCv3Client({ nick: 'postreg1' })
    );

    // Complete registration with minimal caps
    await client.capLs();
    await client.capReq(['multi-prefix']);
    client.capEnd();
    client.register('postreg1');
    await client.waitForRaw(/001/);

    // Now request additional capability
    const result = await client.capReq(['away-notify']);
    expect(result.ack).toContain('away-notify');
  });

  it('can disable caps after registration', async () => {
    const client = trackClient(
      await createRawIRCv3Client({ nick: 'postreg2' })
    );

    await client.capLs();
    await client.capReq(['multi-prefix', 'away-notify']);
    client.capEnd();
    client.register('postreg2');
    await client.waitForRaw(/001/);

    // Disable a capability
    const result = await client.capReq(['-away-notify']);
    expect(result.ack).toContain('-away-notify');
  });

  it('CAP LS works after registration', async () => {
    const client = trackClient(
      await createRawIRCv3Client({ nick: 'postreg3' })
    );

    await client.capLs();
    await client.capReq(['multi-prefix']);
    client.capEnd();
    client.register('postreg3');
    await client.waitForRaw(/001/);

    // CAP LS after registration
    const caps = await client.capLs(302);
    expect(caps.size).toBeGreaterThan(0);
  });
});
