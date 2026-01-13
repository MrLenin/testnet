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
  // IRC message parsing utilities (parseIRCMessage already exported from message-parser.js)
  isFromService,
  isServiceNotice,
  type IRCv3Config,
  type CapState,
  type ServerConfig,
  type IRCMessage,
  type ParsedLine,
  // BATCH collection
  type ActiveBatch,
} from './ircv3-client.js';

export {
  CAP_BUNDLES,
  getCaps,
  getMergedCaps,
  uniqueId,
  uniqueChannel,
  uniqueNick,
  retryAsync,
  waitForCondition,
  collectChathistoryBatch,
  waitForChathistory,
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

export {
  checkKeycloakAvailable,
  isKeycloakAvailable,
  KEYCLOAK_SKIP_REASON,
  resetKeycloakCheck,
} from '../setup/keycloak-check.js';

export {
  SERVERS,
  TOPOLOGY,
  createMultiServerClients,
  waitForCrossServerSync,
  expectCrossServerSync,
  collectMultipleLines,
  verifyChannelSync,
  getHopCount,
  getAvailableServers,
  isServerAvailable,
  type MultiServerContext,
} from './multiserver.js';

export {
  // Core parsing
  parseIRCMessage,
  type ParsedMessage,
  type MessageSource,
  type AssertableMessage,
  // Assertion helpers
  assertPrivmsg,
  assertNumeric,
  assertJoin,
  assertMode,
  assertKick,
  assertTag,
  // Non-throwing checks
  isCommand,
  isNumeric,
  // Value extractors
  getMessageText,
  getServerTime,
  getMsgId,
  getAccount,
  // Batch helpers
  parseBatchStart,
  isBatchEnd,
  getBatchId,
} from './message-parser.js';

export {
  // P10 message parsing
  parseP10Message,
  parseBurst,
  parseNick,
  type P10Message,
  type P10Burst,
  type P10Nick,
  type ServerNode,
  // Docker log parsing
  getP10Logs,
  getBurstLogs,
  getNickLogs,
  // Burst order validation
  BurstPhase,
  validateBurstOrder,
  // TS comparison rules
  compareTimestamps,
  nickCollisionWinner,
  channelTsWinner,
  // Numeric utilities
  getServerFromNumeric,
  isFromServer,
  // Assertions
  assertBurstUsers,
  assertBurstModes,
  assertBurstBans,
} from './p10-protocol.js';

export {
  // X3 service client
  X3Client,
  createX3Client,
  createAuthenticatedX3Client,
  createTestAccount,
  createOperClient,
  // Account pool helpers
  getTestAccount,
  releaseTestAccount,
  setupTestAccount,
  // State verification helpers
  waitForUserAccess,
  waitForAccountExists,
  waitForChannelMode,
  // Access level constants
  ACCESS_LEVELS,
  // Admin/Oper credentials
  X3_ADMIN,
  IRC_OPER,
  // Types
  type ServiceResponse,
} from './x3-client.js';

export {
  // Account pool management
  accountPool,
  initializeAccountPool,
  checkoutPoolAccount,
  checkinPoolAccount,
  getPoolStats,
  isPoolInitialized,
  type PoolAccount,
} from './account-pool.js';

export {
  // Cookie observer for capturing activation cookies via IRC
  CookieObserver,
  getGlobalCookieObserver,
  getGlobalObserverNick,
  shutdownGlobalCookieObserver,
} from './cookie-observer.js';
