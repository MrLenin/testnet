# SEARCH (soju.im/search)

History search over the chathistory store, per the soju extension
(<https://codeberg.org/emersion/soju/src/branch/master/doc/ext/search.md>).
Added 2026-09-20 at Rubin's request: the client can search what the server
holds, not just what it has in memory.

## Wire

Capability `soju.im/search`. Without it the command is unknown (421).

```
SEARCH in=<target> [from=<nick>] [text=<words>] [after=<ts>] [before=<ts>] [limit=<n>]
```

Selectors are `key=value` parameters; `text` may carry spaces as the
trailing parameter. Unknown selectors are ignored.

| selector | meaning |
|---|---|
| `in` | a channel or a nick (a private conversation). See "Without `in`" below. |
| `from` | sender nick, matched case-insensitively against the stored `nick!user@host` |
| `text` | case-insensitive substring of the message body; no regular expressions |
| `after` | server-time timestamp; rows at or after it |
| `before` | server-time timestamp; rows at or before it; defaults to now |
| `limit` | at most this many rows; defaults to and is capped at `CHATHISTORY_MAX` |

The reply is a batch of type `search` holding the matching `PRIVMSG` and
`NOTICE` rows (multiline messages included), ascending by time, each with
`msgid` and `time` tags like a CHATHISTORY page. No match is an empty
batch. A label on the request lands on the batch opener.

Errors are standard replies:

- `FAIL SEARCH INVALID_PARAMS <selector> :…` for a malformed selector, a bad
  timestamp or limit, or an `in` the requester may not read (the same
  access rule as CHATHISTORY: membership, or `+H`, or being a party to the
  private conversation).
- `FAIL SEARCH INTERNAL_ERROR` when the store is unavailable or the walk fails.

## How it searches

There is no index. The walk is CHATHISTORY BEFORE's, from `before` back
towards `after`, keeping the newest `limit` matches; the match runs inside
the walk as a row hook, behind the strict-presence hook when that is on,
so a member who was not present for a message does not find it. The reply
side runs the same redaction and presence filters as a CHATHISTORY page.

The scan is bounded: `SEARCH_SCAN_MAX` (50 000) raw rows per request, spent
across every channel the request covers. A busy channel's window may not
be scanned to `after` within that; a client that wants more asks a
narrower window (Seance's plan: a bounded default window and a "search
older" step). The spec has no marker for a truncated scan and none is
added.

## Without `in`

The spec makes `in` optional. Here a request without it searches every
channel the requester is currently in (each under the same access rule)
and returns the newest `limit` across them, each row addressed to its own
channel. Private conversations are not included without `in=<nick>`: their
keyspace is not enumerable per requester.

## Not merged: storage peers

Results come from the local store only; a storage peer holding the
channel is not queried (single-server prod; the CHATHISTORY federation
path is not reused here yet).

## Tests

`tests/src/ircv3/search.test.ts`: text, from, limit, after/before, the
empty batch, INVALID_PARAMS, the missing capability, and strict presence.
