export interface LdifEntry {
  dn: string;
  /** every attribute, lowercased name -> raw values (utf8-decoded; base64 already decoded) */
  attrs: Map<string, string[]>;
}

export interface LdapAccount {
  uid: string;
  dn: string;
  objectClasses: string[];
  /** parsed from userPassword values: e.g. { scheme: 'SSHA', raw: '{SSHA}...' }; scheme '' = plaintext/unprefixed */
  passwords: { scheme: string; raw: string }[];
  createTimestamp?: string;
  modifyTimestamp?: string;
}

/**
 * Parse LDIF format text per RFC 2849.
 *
 * Handles:
 * - Continuation lines (lines starting with single space continue previous line, minus that space)
 * - Comments (lines starting with # are dropped, including continuations)
 * - Base64 values (name:: base64-value)
 * - Regular values (name: value)
 * - Entry splitting on blank lines
 * - Multi-valued attributes
 */
export function parseLdif(text: string): LdifEntry[] {
  const lines = text.split('\n');
  const entries: LdifEntry[] = [];
  let currentEntry: Map<string, string[]> | null = null;
  let currentDn: string | null = null;
  let i = 0;

  // Skip leading version line if present
  if (lines[0]?.startsWith('version:')) {
    i = 1;
  }

  while (i < lines.length) {
    const line = lines[i];
    i++;

    // Skip blank lines between entries
    if (line.trim() === '') {
      if (currentEntry !== null && currentDn !== null) {
        entries.push({
          dn: currentDn,
          attrs: currentEntry,
        });
        currentEntry = null;
        currentDn = null;
      }
      continue;
    }

    // Skip comment lines
    if (line.startsWith('#')) {
      // Also skip any continuation lines of the comment
      while (i < lines.length && lines[i]?.startsWith(' ')) {
        i++;
      }
      continue;
    }

    // Handle continuation lines: unfold by gathering all continuations
    let fullLine = line;
    while (i < lines.length && lines[i]?.startsWith(' ')) {
      const continuationLine = lines[i];
      fullLine += continuationLine.substring(1); // Remove the leading space
      i++;
    }

    // Parse the attribute line
    const colonIndex = fullLine.indexOf(':');
    if (colonIndex === -1) {
      continue; // Malformed line, skip
    }

    const name = fullLine.substring(0, colonIndex);
    const rest = fullLine.substring(colonIndex + 1);

    // Check for base64 (::) or URL (<)
    if (rest.startsWith(':')) {
      // Base64 value: name:: base64value
      const base64Value = rest.substring(1).trim();
      const decodedValue = Buffer.from(base64Value, 'base64').toString('utf8');

      if (name.toLowerCase() === 'dn') {
        currentDn = decodedValue;
      } else {
        if (currentEntry === null) {
          currentEntry = new Map();
        }
        const attrName = name.toLowerCase();
        if (!currentEntry.has(attrName)) {
          currentEntry.set(attrName, []);
        }
        currentEntry.get(attrName)!.push(decodedValue);
      }
    } else if (rest.startsWith('<')) {
      // URL reference (unsupported, keep raw with url: prefix)
      const urlValue = 'url:' + rest.substring(1).trim();
      if (name.toLowerCase() !== 'dn') {
        if (currentEntry === null) {
          currentEntry = new Map();
        }
        const attrName = name.toLowerCase();
        if (!currentEntry.has(attrName)) {
          currentEntry.set(attrName, []);
        }
        currentEntry.get(attrName)!.push(urlValue);
      }
    } else {
      // Regular value: name: value
      const value = rest.trim();

      if (name.toLowerCase() === 'dn') {
        currentDn = value;
      } else {
        if (currentEntry === null) {
          currentEntry = new Map();
        }
        const attrName = name.toLowerCase();
        if (!currentEntry.has(attrName)) {
          currentEntry.set(attrName, []);
        }
        currentEntry.get(attrName)!.push(value);
      }
    }
  }

  // Don't forget the last entry if file doesn't end with blank line
  if (currentEntry !== null && currentDn !== null) {
    entries.push({
      dn: currentDn,
      attrs: currentEntry,
    });
  }

  return entries;
}

/**
 * Filter LDIF entries to accounts: those with a uid attribute.
 * Parse passwords, objectClasses, and timestamps.
 */
export function ldapAccounts(entries: LdifEntry[]): LdapAccount[] {
  return entries
    .filter((entry) => entry.attrs.has('uid'))
    .map((entry) => {
      const uid = entry.attrs.get('uid')?.[0] ?? '';
      const objectClasses = entry.attrs.get('objectclass') ?? [];
      const passwordValues = entry.attrs.get('userpassword') ?? [];

      const passwords = passwordValues.map((raw) => {
        const match = raw.match(/^\{([^}]+)\}/);
        const scheme = match ? match[1].toUpperCase() : '';
        return { scheme, raw };
      });

      const createTimestamp = entry.attrs.get('createtimestamp')?.[0];
      const modifyTimestamp = entry.attrs.get('modifytimestamp')?.[0];

      const account: LdapAccount = {
        uid,
        dn: entry.dn,
        objectClasses,
        passwords,
      };

      if (createTimestamp) {
        account.createTimestamp = createTimestamp;
      }
      if (modifyTimestamp) {
        account.modifyTimestamp = modifyTimestamp;
      }

      return account;
    });
}
