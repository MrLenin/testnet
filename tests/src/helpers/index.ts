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

export {
  CAP_BUNDLES,
  getCaps,
  getMergedCaps,
  uniqueId,
  uniqueChannel,
  uniqueNick,
  type CapBundle,
} from './cap-bundles.js';

export {
  // P10 base64 character encoding
  b64CharToValue,
  valueToB64Char,
  // IP address encoding/decoding
  decodeIP,
  encodeIP,
  decodeIPv4,
  encodeIPv4,
  decodeIPv6,
  encodeIPv6,
  isIPv4Mapped,
  extractIPv4FromMapped,
  // Word-level encoding
  decodeWord,
  encodeWord,
  // Numeric encoding
  decodeServerNumeric,
  encodeServerNumeric,
  decodeUserNumeric,
  encodeUserNumeric,
  decodeFullNumeric,
  encodeFullNumeric,
} from './p10-utils.js';
