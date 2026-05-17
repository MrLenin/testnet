# IRC Tester: Autonomous Activity Simulator

## Overview

Feature proposal for [bennamrouche/irc-tester](https://github.com/bennamrouche/irc-tester) fork.

The existing tool connects N clients to an IRC server for stress testing. This proposal adds an **autonomous activity mode** where connected clients randomly perform realistic IRC actions at randomized intervals, turning the tool from a connection stress tester into a traffic simulator.

## Use Cases

- Generate realistic traffic patterns for server performance testing
- Test chathistory storage under sustained load
- Validate server linking stability with active users across multiple servers
- Verify metadata propagation, message delivery, and P10 burst behavior
- Test flood protection and rate limiting under organic-looking traffic
- Backwards-compatibility testing (e.g. modified IRCd linked with stock upstream)

## Core Feature: Activity Scheduler

Each connected client gets an independent activity timer that fires at a **random interval** within a configurable range.

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `activityEnabled` | `false` | Enable autonomous activity mode |
| `minInterval` | `20` | Minimum seconds between actions |
| `maxInterval` | `300` | Maximum seconds between actions (5 min) |
| `actions` | all | Comma-separated list of enabled action types |
| `maxChannels` | `5` | Max channels a client will join |
| `channelPrefix` | `#test-` | Prefix for auto-generated channel names |
| `channelPool` | `10` | Number of channels in the random pool |
| `messageCorpus` | built-in | Path to custom message file (one per line) |

### Interval Behavior

On each timer fire:
1. Generate random delay: `uniform(minInterval, maxInterval)` seconds
2. Pick a weighted random action from the enabled set
3. Execute the action
4. Schedule next fire with a new random delay

This produces organic-looking traffic — no two clients act at the same time or at predictable intervals.

## Action Types

### Tier 1 — High frequency (common IRC activity)

| Action | Weight | Description |
|--------|--------|-------------|
| `message` | 40% | Send PRIVMSG to a random joined channel |
| `action` | 10% | Send CTCP ACTION (/me) to a random joined channel |

### Tier 2 — Medium frequency (normal user behavior)

| Action | Weight | Description |
|--------|--------|-------------|
| `join` | 10% | Join a random channel from the pool (if below maxChannels) |
| `part` | 10% | Part a random joined channel (if in more than 1) |
| `topic` | 5% | Set topic on a random joined channel |
| `nick` | 5% | Change to a random nick variant |

### Tier 3 — Low frequency (occasional)

| Action | Weight | Description |
|--------|--------|-------------|
| `away` | 5% | Toggle AWAY status with random message |
| `notice` | 5% | Send NOTICE to a random joined channel |
| `pm` | 5% | Send PM to a random other connected client |
| `quit_rejoin` | 5% | Disconnect and reconnect (simulates client restart) |

Weights are defaults — configurable via the `actions` parameter to enable/disable or reweight specific types.

## Message Corpus

### Built-in Default

A bundled list of ~200 generic chat messages covering:
- Greetings/farewells ("hey everyone", "gotta go, later")
- Questions ("anyone here?", "what's going on?")
- Reactions ("lol", "nice", "interesting")
- Filler ("just testing", "checking in")
- Longer messages (2-3 sentences for realistic length distribution)

### Custom Corpus

Load from a text file (one message per line). The tool picks randomly from the list, optionally with:
- `%nick%` placeholder — replaced with a random nick from the channel
- `%channel%` placeholder — replaced with the current channel name
- `%time%` placeholder — replaced with current timestamp

## Client State Tracking

Each client maintains:
- Set of currently joined channels
- Current nick
- Away status
- Last action timestamp
- Action history (for logging/stats)

This state is updated on both outgoing actions and incoming server responses (e.g., if kicked from a channel, remove it from the joined set).

## UI Integration

The existing UI shows per-client stats. Add:
- **Activity indicator**: action count per client
- **Global stats**: total actions/minute, actions by type
- **Activity log**: scrollable log of recent actions across all clients
- **Start/Stop**: button to enable/disable activity mode while running

## Implementation Notes

### Threading

- One `ScheduledExecutorService` shared across all clients
- Each client schedules its own next action via `schedule()` with random delay
- Actions execute on the executor thread, synchronized on per-client state
- Avoids creating N threads for N clients

### Startup Behavior

- Clients connect and join initial channel(s) first (existing behavior)
- Activity mode starts after a configurable warmup period (default: 10s)
- Stagger initial action timers across clients to avoid a thundering herd at startup:
  `initialDelay = random(0, maxInterval)` per client

### Error Handling

- If an action fails (e.g., server returns error), log it and schedule next action normally
- If disconnected, attempt reconnect after backoff (existing reconnect logic if any)
- Rate limit detection: if server sends `ERR_TARGETTOOFAST` or similar, back off the interval temporarily

### SASL / Authentication

- Optional: configure SASL credentials per client or credential pattern
- Useful for testing authenticated user activity vs anonymous

## Future Extensions (not in initial implementation)

- **Conversation mode**: clients respond to each other's messages (basic pattern matching)
- **Scenario scripting**: define sequences of actions (e.g., "join, wait, set topic, invite another client")
- **Multi-server**: split clients across multiple servers (useful for link testing)
- **Metrics export**: export action stats to CSV/JSON for analysis
- **IRCv3 actions**: request chathistory, set metadata, use read markers
