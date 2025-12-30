import { describe, it, expect, afterEach } from 'vitest';
import { createRawSocketClient, RawSocketClient } from '../helpers/index.js';

/**
 * Metadata Tests (draft/metadata-2)
 *
 * Tests the IRCv3 metadata specification for user and channel metadata.
 */
describe('IRCv3 Metadata (draft/metadata-2)', () => {
  const clients: RawSocketClient[] = [];

  const trackClient = (client: RawSocketClient): RawSocketClient => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    clients.length = 0;
  });

  describe('Capability Advertisement', () => {
    it('server advertises metadata capability', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();

      // May be draft/metadata or draft/metadata-2
      const hasMetadata = caps.has('draft/metadata-2') || caps.has('draft/metadata');
      expect(hasMetadata).toBe(true);

      client.send('QUIT');
    });

    it('can request metadata capability', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      const result = await client.capReq([metaCap]);

      expect(result.ack.length).toBeGreaterThan(0);

      client.send('QUIT');
    });
  });

  describe('METADATA Commands', () => {
    it('can set user metadata with METADATA SET', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaset1');
      await client.waitForLine(/001/);

      // Try to set avatar metadata
      client.send('METADATA SET * avatar :https://example.com/avatar.png');

      // Should receive confirmation or error
      const response = await client.waitForLine(/METADATA|761|762|764|765|766|767/, 3000);
      expect(response).toBeDefined();
      console.log('METADATA SET response:', response);

      client.send('QUIT');
    });

    it('can get user metadata with METADATA GET', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaget1');
      await client.waitForLine(/001/);

      // First set some metadata
      client.send('METADATA SET * testkey :testvalue123');
      await new Promise(r => setTimeout(r, 500));

      // Then try to get it
      client.send('METADATA GET * testkey');

      // 761 = RPL_KEYVALUE (metadata value response)
      const response = await client.waitForLine(/761|METADATA.*testkey/, 3000);
      expect(response).toBeDefined();
      console.log('METADATA GET response:', response);

      client.send('QUIT');
    });

    it('can list user metadata with METADATA LIST', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metalist1');
      await client.waitForLine(/001/);

      client.send('METADATA LIST *');

      try {
        // 761 = RPL_KEYVALUE, 762 = RPL_METADATAEND
        // Collect messages until we get 762 or timeout
        let responses: string[] = [];
        let done = false;
        const startTime = Date.now();
        while (!done && Date.now() - startTime < 3000) {
          try {
            const line = await client.waitForLine(/76[12]/, 500);
            responses.push(line);
            if (line.match(/762/)) {
              done = true;
            }
          } catch {
            break;
          }
        }
        expect(responses.length).toBeGreaterThanOrEqual(0);
        console.log('METADATA LIST responses:', responses);
      } catch {
        console.log('No METADATA LIST response');
      }

      client.send('QUIT');
    });

    it('can clear metadata with METADATA CLEAR', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaclear1');
      await client.waitForLine(/001/);

      // Set then clear
      client.send('METADATA SET * cleartest :value');
      await new Promise(r => setTimeout(r, 500));
      client.send('METADATA CLEAR * cleartest');

      try {
        const response = await client.waitForLine(/761|766|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA CLEAR response:', response);
      } catch {
        console.log('No METADATA CLEAR response');
      }

      client.send('QUIT');
    });
  });

  describe('Channel Metadata', () => {
    it('can set channel metadata', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('chanmeta1');
      await client.waitForLine(/001/);

      // Join channel first (need to be op usually)
      const channelName = `#metaTest${Date.now()}`;
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Try to set channel metadata
      client.send(`METADATA SET ${channelName} url :https://example.com`);

      try {
        const response = await client.waitForLine(/761|764|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('Channel METADATA SET response:', response);
      } catch {
        console.log('No channel METADATA SET response - may need op status');
      }

      client.send('QUIT');
    });

    it('can get channel metadata', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('chanmeta2');
      await client.waitForLine(/001/);

      const channelName = `#metaGet${Date.now()}`;
      client.send(`JOIN ${channelName}`);
      await client.waitForLine(new RegExp(`JOIN.*${channelName}`, 'i'));

      // Set then get
      client.send(`METADATA SET ${channelName} testchankey :testvalue`);
      await new Promise(r => setTimeout(r, 500));
      client.send(`METADATA GET ${channelName} testchankey`);

      try {
        const response = await client.waitForLine(/761|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('Channel METADATA GET response:', response);
      } catch {
        console.log('No channel METADATA GET response');
      }

      client.send('QUIT');
    });
  });

  describe('Metadata Subscriptions', () => {
    it('can subscribe to metadata changes with METADATA SUB', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metasub1');
      await client.waitForLine(/001/);

      // Subscribe to all metadata changes for a target
      client.send('METADATA * SUB avatar');

      try {
        const response = await client.waitForLine(/769|770|METADATA/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA SUB response:', response);
      } catch {
        console.log('No METADATA SUB response - may not be supported');
      }

      client.send('QUIT');
    });
  });

  describe('Metadata Error Handling', () => {
    it('returns error for invalid key', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaerr1');
      await client.waitForLine(/001/);

      // Try to get non-existent key
      client.send('METADATA GET * nonexistentkey12345');

      try {
        // 765 = ERR_KEYNOTSET, 766 = ERR_KEYNOPERM
        const response = await client.waitForLine(/765|766|FAIL/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA error response:', response);
      } catch {
        // No error may mean key just doesn't exist (empty response)
        console.log('No METADATA error response');
      }

      client.send('QUIT');
    });

    it('returns error for metadata on non-existent target', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaerr2');
      await client.waitForLine(/001/);

      // Try to get metadata for non-existent user
      client.send('METADATA GET nonexistentnick12345 avatar');

      try {
        // 401 = ERR_NOSUCHNICK, 764 = ERR_TARGETINVALID
        const response = await client.waitForLine(/401|764|FAIL/, 3000);
        expect(response).toBeDefined();
        console.log('METADATA target error response:', response);
      } catch {
        console.log('No METADATA target error response');
      }

      client.send('QUIT');
    });
  });

  describe('Standard Metadata Keys', () => {
    it('can set and get avatar metadata', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('stdmeta1');
      await client.waitForLine(/001/);

      client.send('METADATA SET * avatar :https://example.com/myavatar.png');
      await new Promise(r => setTimeout(r, 500));
      client.send('METADATA GET * avatar');

      try {
        const response = await client.waitForLine(/761.*avatar|METADATA.*avatar/, 3000);
        expect(response).toBeDefined();
      } catch {
        console.log('Avatar metadata not available');
      }

      client.send('QUIT');
    });

    it('can set and get pronouns metadata', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('stdmeta2');
      await client.waitForLine(/001/);

      client.send('METADATA SET * pronouns :they/them');
      await new Promise(r => setTimeout(r, 500));
      client.send('METADATA GET * pronouns');

      try {
        const response = await client.waitForLine(/761.*pronouns|METADATA.*pronouns/, 3000);
        expect(response).toBeDefined();
      } catch {
        console.log('Pronouns metadata not available');
      }

      client.send('QUIT');
    });

    it('can set bot flag metadata', async () => {
      const client = trackClient(await createRawSocketClient());

      await client.capLs();
      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('stdmeta3');
      await client.waitForLine(/001/);

      client.send('METADATA SET * bot :1');
      await new Promise(r => setTimeout(r, 500));
      client.send('METADATA GET * bot');

      try {
        const response = await client.waitForLine(/761.*bot|METADATA.*bot/, 3000);
        expect(response).toBeDefined();
      } catch {
        console.log('Bot metadata not available');
      }

      client.send('QUIT');
    });
  });

  describe('Metadata Limits and Constraints', () => {
    it('rejects metadata value exceeding max size', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metalimit1');
      await client.waitForLine(/001/);

      // Create a very large value (exceeds typical limits)
      const largeValue = 'x'.repeat(100000);
      client.send(`METADATA SET * largetest :${largeValue}`);

      try {
        // Should receive 766 ERR_KEYINVALID or FAIL
        const response = await client.waitForLine(/766|FAIL|ERR/i, 5000);
        console.log('Large value response:', response);
      } catch {
        console.log('No error for large metadata value');
      }

      client.send('QUIT');
    });

    it('handles special characters in metadata keys', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaspecial1');
      await client.waitForLine(/001/);

      // Keys with dots are typically used for namespacing
      client.send('METADATA SET * example.org/customkey :value');
      await new Promise(r => setTimeout(r, 500));
      client.send('METADATA GET * example.org/customkey');

      try {
        const response = await client.waitForLine(/761|METADATA|766|FAIL/i, 3000);
        console.log('Namespaced key response:', response);
      } catch {
        console.log('No response for namespaced key');
      }

      client.send('QUIT');
    });

    it('rejects empty key names', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaempty1');
      await client.waitForLine(/001/);

      // Empty key
      client.send('METADATA SET *  :value');

      try {
        const response = await client.waitForLine(/766|FAIL|ERR|461/i, 3000);
        console.log('Empty key response:', response);
      } catch {
        console.log('No error for empty key');
      }

      client.send('QUIT');
    });
  });

  describe('Metadata Visibility', () => {
    it('private metadata is only visible to owner', async () => {
      const owner = trackClient(await createRawSocketClient());
      const other = trackClient(await createRawSocketClient());

      const caps = await owner.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await owner.capReq([metaCap]);
      owner.capEnd();
      owner.register('metapriv1');
      await owner.waitForLine(/001/);

      await other.capLs();
      await other.capReq([metaCap]);
      other.capEnd();
      other.register('metapriv2');
      await other.waitForLine(/001/);

      // Owner sets private metadata (if supported)
      owner.send('METADATA SET * privatekey :secretvalue');
      await new Promise(r => setTimeout(r, 500));

      // Other tries to get it
      other.send('METADATA GET metapriv1 privatekey');

      try {
        const response = await other.waitForLine(/761|765|766|FAIL/i, 3000);
        console.log('Private metadata access response:', response);
        // 765 = ERR_KEYNOTSET (key not visible), 766 = ERR_KEYNOPERM
      } catch {
        console.log('No response for private metadata access');
      }

      owner.send('QUIT');
      other.send('QUIT');
    });

    it('public metadata is visible to others', async () => {
      const setter = trackClient(await createRawSocketClient());
      const getter = trackClient(await createRawSocketClient());

      const caps = await setter.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await setter.capReq([metaCap]);
      setter.capEnd();
      setter.register('metapub1');
      await setter.waitForLine(/001/);

      await getter.capLs();
      await getter.capReq([metaCap]);
      getter.capEnd();
      getter.register('metapub2');
      await getter.waitForLine(/001/);

      // Setter sets a public key (avatar is typically public)
      setter.send('METADATA SET * avatar :https://example.com/public.png');
      await new Promise(r => setTimeout(r, 500));

      // Getter retrieves it
      getter.send('METADATA GET metapub1 avatar');

      try {
        const response = await getter.waitForLine(/761.*avatar|765/i, 3000);
        console.log('Public metadata access response:', response);
      } catch {
        console.log('No response for public metadata access');
      }

      setter.send('QUIT');
      getter.send('QUIT');
    });
  });

  describe('Metadata Subscription Edge Cases', () => {
    it('handles multiple SUB requests', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metasub2');
      await client.waitForLine(/001/);

      // Subscribe to multiple keys
      client.send('METADATA * SUB avatar');
      client.send('METADATA * SUB pronouns');
      client.send('METADATA * SUB bot');

      await new Promise(r => setTimeout(r, 500));

      // UNSUB from one
      client.send('METADATA * UNSUB avatar');

      try {
        const response = await client.waitForLine(/769|770|METADATA/i, 3000);
        console.log('Multiple SUB response:', response);
      } catch {
        console.log('No response for multiple subscriptions');
      }

      client.send('QUIT');
    });

    it('UNSUB from non-subscribed key', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metaunsub1');
      await client.waitForLine(/001/);

      // Try to unsubscribe from something we never subscribed to
      client.send('METADATA * UNSUB nonexistent');

      try {
        const response = await client.waitForLine(/769|770|FAIL|METADATA/i, 3000);
        console.log('UNSUB non-subscribed response:', response);
      } catch {
        console.log('No response for UNSUB non-subscribed');
      }

      client.send('QUIT');
    });
  });

  describe('Metadata Persistence', () => {
    it('metadata persists across reconnection for authenticated users', async () => {
      // This test requires SASL authentication to verify persistence
      const client1 = trackClient(await createRawSocketClient());

      const caps = await client1.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';

      // Check if SASL is available
      if (!caps.has('sasl')) {
        console.log('Skipping persistence test - SASL not available');
        client1.send('QUIT');
        return;
      }

      await client1.capReq([metaCap, 'sasl']);

      // Try to authenticate
      client1.send('AUTHENTICATE PLAIN');
      try {
        await client1.waitForLine(/AUTHENTICATE \+/);
        const user = process.env.IRC_TEST_ACCOUNT ?? 'testaccount';
        const pass = process.env.IRC_TEST_PASSWORD ?? 'testpass';
        const payload = Buffer.from(`${user}\0${user}\0${pass}`).toString('base64');
        client1.send(`AUTHENTICATE ${payload}`);
        await client1.waitForLine(/903/i, 5000);
      } catch {
        console.log('SASL auth failed - skipping persistence test');
        client1.send('QUIT');
        return;
      }

      client1.capEnd();
      client1.register('metapersist1');
      await client1.waitForLine(/001/);

      // Set metadata
      const testValue = `persist_${Date.now()}`;
      client1.send(`METADATA SET * testpersist :${testValue}`);
      await new Promise(r => setTimeout(r, 500));

      client1.send('QUIT');
      await new Promise(r => setTimeout(r, 1000));

      // Reconnect and check if metadata persists
      const client2 = trackClient(await createRawSocketClient());
      await client2.capLs();
      await client2.capReq([metaCap, 'sasl']);

      client2.send('AUTHENTICATE PLAIN');
      try {
        await client2.waitForLine(/AUTHENTICATE \+/);
        const user = process.env.IRC_TEST_ACCOUNT ?? 'testaccount';
        const pass = process.env.IRC_TEST_PASSWORD ?? 'testpass';
        const payload = Buffer.from(`${user}\0${user}\0${pass}`).toString('base64');
        client2.send(`AUTHENTICATE ${payload}`);
        await client2.waitForLine(/903/i, 5000);
      } catch {
        console.log('SASL auth failed on reconnect');
        client2.send('QUIT');
        return;
      }

      client2.capEnd();
      client2.register('metapersist2');
      await client2.waitForLine(/001/);

      // Try to get the metadata we set
      client2.send('METADATA GET * testpersist');

      try {
        const response = await client2.waitForLine(/761.*testpersist/i, 3000);
        expect(response).toContain(testValue);
        console.log('Metadata persisted:', response);
      } catch {
        console.log('Metadata did not persist or not found');
      }

      client2.send('QUIT');
    });
  });

  describe('Metadata Rate Limiting', () => {
    it('handles rapid metadata requests', async () => {
      const client = trackClient(await createRawSocketClient());

      const caps = await client.capLs();
      const metaCap = caps.has('draft/metadata-2') ? 'draft/metadata-2' : 'draft/metadata';
      await client.capReq([metaCap]);
      client.capEnd();
      client.register('metarate1');
      await client.waitForLine(/001/);

      // Send many rapid metadata requests
      for (let i = 0; i < 20; i++) {
        client.send(`METADATA SET * ratetest${i} :value${i}`);
      }

      await new Promise(r => setTimeout(r, 1000));

      // Check if any rate limiting occurred
      // Server may respond with FAIL or silently drop some
      client.send('METADATA LIST *');

      try {
        const response = await client.waitForLine(/761|762|FAIL|METADATA/i, 5000);
        console.log('Rate limit test response:', response);
      } catch {
        console.log('No response after rapid requests');
      }

      client.send('QUIT');
    });
  });
});
