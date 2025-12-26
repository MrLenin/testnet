export {
  TestIRCClient,
  createTestClient,
  type IRCConfig,
  type MessageEvent,
  type JoinEvent,
  type RawEvent,
} from './irc-client.js';

export {
  IRCv3TestClient,
  createIRCv3Client,
  createRawIRCv3Client,
  RawSocketClient,
  createRawSocketClient,
  createClientOnServer,
  isSecondaryServerAvailable,
  PRIMARY_SERVER,
  SECONDARY_SERVER,
  type IRCv3Config,
  type CapState,
  type ServerConfig,
} from './ircv3-client.js';
