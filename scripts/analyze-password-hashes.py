#!/usr/bin/env python3
"""
Password Hash Migration Analysis Tool for X3 Services

Analyzes password hash distribution in X3 SAXDB files and generates reports
on hash algorithm usage. Helps plan migration from legacy MD5 to modern
algorithms (PBKDF2, bcrypt).

Usage:
    ./analyze-password-hashes.py <saxdb-file>
    ./analyze-password-hashes.py --docker  # Analyze from running x3 container

Output:
    - Summary of hash algorithms in use
    - List of accounts by algorithm
    - Migration recommendations

Hash formats detected:
    - $pbkdf2-sha256$i=NNNN$salt$hash - PBKDF2-SHA256
    - $pbkdf2-sha512$i=NNNN$salt$hash - PBKDF2-SHA512
    - $2a$/$2b$/$2y$ - bcrypt
    - $argon2id$ - Argon2id
    - $XXXXXXXX + 32hex (41 chars) - Legacy X3 seeded MD5
    - 32 hex chars - Plain MD5
"""

import sys
import re
import argparse
import subprocess
import json
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Tuple, Optional


def detect_algorithm(hash_str: str) -> str:
    """Detect the password hashing algorithm from the hash string."""
    if not hash_str:
        return "empty"

    # PBKDF2-SHA256
    if hash_str.startswith("$pbkdf2-sha256$"):
        return "pbkdf2-sha256"

    # PBKDF2-SHA512
    if hash_str.startswith("$pbkdf2-sha512$"):
        return "pbkdf2-sha512"

    # bcrypt variants
    if len(hash_str) >= 4 and hash_str[0] == '$' and hash_str[1] == '2':
        if hash_str[2] in ('a', 'b', 'y') and hash_str[3] == '$':
            return "bcrypt"

    # Argon2id
    if hash_str.startswith("$argon2id$"):
        return "argon2id"

    # Legacy X3 seeded MD5: $XXXXXXXX + 32 hex chars = 41 chars total
    if hash_str.startswith('$') and len(hash_str) == 41:
        # Check if the rest is hex
        if all(c in '0123456789abcdefABCDEF' for c in hash_str[1:]):
            return "md5-seeded"

    # Plain MD5: exactly 32 hex characters
    if len(hash_str) == 32:
        if all(c in '0123456789abcdefABCDEF' for c in hash_str):
            return "md5-plain"

    return "unknown"


def parse_pbkdf2_iterations(hash_str: str) -> Optional[int]:
    """Extract iteration count from PBKDF2 hash."""
    match = re.search(r'\$i=(\d+)\$', hash_str)
    if match:
        return int(match.group(1))
    return None


def parse_bcrypt_cost(hash_str: str) -> Optional[int]:
    """Extract cost factor from bcrypt hash."""
    match = re.match(r'\$2[aby]\$(\d+)\$', hash_str)
    if match:
        return int(match.group(1))
    return None


def parse_saxdb_nickserv(content: str) -> Dict[str, dict]:
    """
    Parse NickServ section from SAXDB content.
    Returns dict of account_name -> {passwd, lastseen, register, ...}
    """
    accounts = {}

    # Find NickServ section - handle nested braces properly
    # Look for "NickServ" { ... }; at the top level
    ns_start = content.find('"NickServ"')
    if ns_start == -1:
        return accounts

    # Find the opening brace
    brace_start = content.find('{', ns_start)
    if brace_start == -1:
        return accounts

    # Find matching closing brace (handle nested braces)
    depth = 1
    pos = brace_start + 1
    while pos < len(content) and depth > 0:
        if content[pos] == '{':
            depth += 1
        elif content[pos] == '}':
            depth -= 1
        pos += 1

    ns_content = content[brace_start + 1:pos - 1]

    # Parse each account entry
    # Format: "accountname" { "key1" "value1"; "key2" "value2"; ... };
    # Account entries have the format "name" { ... };
    account_pattern = re.compile(
        r'"([^"]+)"\s*\{\s*([^}]+)\s*\};',
        re.DOTALL
    )

    for match in account_pattern.finditer(ns_content):
        account_name = match.group(1)
        properties_str = match.group(2)

        # Skip non-account entries (like version_control, etc.)
        if account_name in ('version_control', 'note_types', 'dnr', 'channels', 'bots'):
            continue

        # Parse properties
        props = {}
        # Match "key" "value"; or "key" (list);
        prop_pattern = re.compile(r'"([^"]+)"\s+(?:"([^"]*)"|(\([^)]*\)));?\s*')
        for prop_match in prop_pattern.finditer(properties_str):
            key = prop_match.group(1)
            value = prop_match.group(2) if prop_match.group(2) is not None else prop_match.group(3)
            props[key] = value

        if props:
            accounts[account_name] = props

    return accounts


def read_saxdb_from_docker() -> str:
    """Read SAXDB content from running x3 Docker container."""
    try:
        result = subprocess.run(
            ['docker', 'exec', 'x3', 'cat', '/x3/data/x3.db'],
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout
    except subprocess.CalledProcessError as e:
        print(f"Error reading from Docker container: {e.stderr}", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("Docker command not found. Please install Docker or specify a file path.", file=sys.stderr)
        sys.exit(1)


def read_saxdb_from_file(filepath: str) -> str:
    """Read SAXDB content from file."""
    try:
        with open(filepath, 'r') as f:
            return f.read()
    except FileNotFoundError:
        print(f"File not found: {filepath}", file=sys.stderr)
        sys.exit(1)
    except IOError as e:
        print(f"Error reading file: {e}", file=sys.stderr)
        sys.exit(1)


def format_timestamp(ts_str: str) -> str:
    """Convert Unix timestamp string to human-readable format."""
    try:
        ts = int(ts_str)
        return datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M')
    except (ValueError, TypeError, OSError):
        return "N/A"


def generate_report(accounts: Dict[str, dict], output_format: str = "text") -> str:
    """Generate analysis report."""

    # Categorize accounts by algorithm
    by_algorithm: Dict[str, List[Tuple[str, dict]]] = defaultdict(list)
    iterations_stats: Dict[str, List[int]] = defaultdict(list)
    bcrypt_costs: List[int] = []

    for account_name, props in accounts.items():
        passwd = props.get('passwd', '')
        algo = detect_algorithm(passwd)
        by_algorithm[algo].append((account_name, props))

        # Collect iteration/cost stats
        if algo.startswith('pbkdf2'):
            iters = parse_pbkdf2_iterations(passwd)
            if iters:
                iterations_stats[algo].append(iters)
        elif algo == 'bcrypt':
            cost = parse_bcrypt_cost(passwd)
            if cost:
                bcrypt_costs.append(cost)

    if output_format == "json":
        return generate_json_report(accounts, by_algorithm, iterations_stats, bcrypt_costs)
    else:
        return generate_text_report(accounts, by_algorithm, iterations_stats, bcrypt_costs)


def generate_json_report(accounts, by_algorithm, iterations_stats, bcrypt_costs) -> str:
    """Generate JSON format report."""
    report = {
        "generated": datetime.now().isoformat(),
        "total_accounts": len(accounts),
        "algorithms": {},
        "accounts_by_algorithm": {},
        "recommendations": []
    }

    for algo, accts in sorted(by_algorithm.items()):
        report["algorithms"][algo] = {
            "count": len(accts),
            "percentage": round(len(accts) / len(accounts) * 100, 1) if accounts else 0
        }
        report["accounts_by_algorithm"][algo] = [name for name, _ in accts]

    # Add iteration stats
    for algo, iters in iterations_stats.items():
        if iters:
            report["algorithms"][algo]["iterations"] = {
                "min": min(iters),
                "max": max(iters),
                "avg": sum(iters) // len(iters)
            }

    if bcrypt_costs:
        report["algorithms"]["bcrypt"]["cost"] = {
            "min": min(bcrypt_costs),
            "max": max(bcrypt_costs),
            "avg": sum(bcrypt_costs) // len(bcrypt_costs)
        }

    # Recommendations
    legacy_count = len(by_algorithm.get('md5-seeded', [])) + len(by_algorithm.get('md5-plain', []))
    if legacy_count > 0:
        report["recommendations"].append({
            "priority": "high",
            "message": f"{legacy_count} accounts using legacy MD5 - migrate on next login"
        })

    return json.dumps(report, indent=2)


def generate_text_report(accounts, by_algorithm, iterations_stats, bcrypt_costs) -> str:
    """Generate human-readable text report."""
    lines = []
    lines.append("=" * 60)
    lines.append("Password Hash Migration Analysis Report")
    lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("=" * 60)
    lines.append("")

    # Summary
    lines.append("SUMMARY")
    lines.append("-" * 40)
    lines.append(f"Total accounts analyzed: {len(accounts)}")
    lines.append("")

    # Algorithm distribution
    lines.append("ALGORITHM DISTRIBUTION")
    lines.append("-" * 40)

    algo_order = ['pbkdf2-sha256', 'pbkdf2-sha512', 'bcrypt', 'argon2id', 'md5-seeded', 'md5-plain', 'unknown', 'empty']

    for algo in algo_order:
        if algo in by_algorithm:
            count = len(by_algorithm[algo])
            pct = count / len(accounts) * 100 if accounts else 0
            status = ""
            if algo in ('md5-seeded', 'md5-plain'):
                status = " [NEEDS MIGRATION]"
            elif algo == 'unknown':
                status = " [REVIEW]"
            lines.append(f"  {algo:20s}: {count:5d} ({pct:5.1f}%){status}")

    lines.append("")

    # Iteration/cost stats
    if iterations_stats or bcrypt_costs:
        lines.append("SECURITY PARAMETERS")
        lines.append("-" * 40)
        for algo, iters in sorted(iterations_stats.items()):
            if iters:
                lines.append(f"  {algo} iterations: min={min(iters)}, max={max(iters)}, avg={sum(iters)//len(iters)}")
        if bcrypt_costs:
            lines.append(f"  bcrypt cost: min={min(bcrypt_costs)}, max={max(bcrypt_costs)}, avg={sum(bcrypt_costs)//len(bcrypt_costs)}")
        lines.append("")

    # Legacy account details
    legacy_algos = ['md5-seeded', 'md5-plain']
    legacy_accounts = []
    for algo in legacy_algos:
        legacy_accounts.extend(by_algorithm.get(algo, []))

    if legacy_accounts:
        lines.append("ACCOUNTS NEEDING MIGRATION")
        lines.append("-" * 40)
        lines.append(f"{'Account':<20s} {'Algorithm':<12s} {'Last Seen':<18s} {'Registered':<18s}")
        lines.append("-" * 70)

        for account_name, props in sorted(legacy_accounts, key=lambda x: x[0]):
            algo = detect_algorithm(props.get('passwd', ''))
            lastseen = format_timestamp(props.get('lastseen', ''))
            registered = format_timestamp(props.get('register', ''))
            lines.append(f"{account_name:<20s} {algo:<12s} {lastseen:<18s} {registered:<18s}")
        lines.append("")

    # Unknown/problematic hashes
    unknown_accounts = by_algorithm.get('unknown', []) + by_algorithm.get('empty', [])
    if unknown_accounts:
        lines.append("ACCOUNTS WITH UNKNOWN/EMPTY HASHES")
        lines.append("-" * 40)
        for account_name, props in sorted(unknown_accounts, key=lambda x: x[0]):
            passwd = props.get('passwd', '')
            display_hash = passwd[:30] + "..." if len(passwd) > 30 else passwd if passwd else "(empty)"
            lines.append(f"  {account_name}: {display_hash}")
        lines.append("")

    # Recommendations
    lines.append("RECOMMENDATIONS")
    lines.append("-" * 40)

    legacy_count = len(by_algorithm.get('md5-seeded', [])) + len(by_algorithm.get('md5-plain', []))
    modern_count = (len(by_algorithm.get('pbkdf2-sha256', [])) +
                   len(by_algorithm.get('pbkdf2-sha512', [])) +
                   len(by_algorithm.get('bcrypt', [])))

    if legacy_count == 0 and len(accounts) > 0:
        lines.append("  [OK] All accounts using modern password hashing!")
    else:
        if legacy_count > 0:
            lines.append(f"  [ACTION] {legacy_count} accounts need migration from legacy MD5")
            lines.append("           These will auto-migrate on next login with lazy migration enabled")

        if modern_count == 0:
            lines.append("  [INFO] No accounts using modern algorithms yet")
            lines.append("         Ensure password_lazy_migration=1 in x3.conf")

    # Check iteration counts
    for algo, iters in iterations_stats.items():
        if iters and min(iters) < 100000:
            lines.append(f"  [WARN] Some {algo} hashes use low iteration count ({min(iters)})")
            lines.append("         Consider increasing password_pbkdf2_iterations")

    if bcrypt_costs and min(bcrypt_costs) < 10:
        lines.append(f"  [WARN] Some bcrypt hashes use low cost factor ({min(bcrypt_costs)})")
        lines.append("         Consider increasing password_bcrypt_cost")

    lines.append("")
    lines.append("=" * 60)

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description='Analyze password hash distribution in X3 SAXDB files'
    )
    parser.add_argument(
        'saxdb_file',
        nargs='?',
        help='Path to SAXDB file (e.g., x3.db)'
    )
    parser.add_argument(
        '--docker',
        action='store_true',
        help='Read from running x3 Docker container'
    )
    parser.add_argument(
        '--format',
        choices=['text', 'json'],
        default='text',
        help='Output format (default: text)'
    )
    parser.add_argument(
        '--list-accounts',
        action='store_true',
        help='List all accounts with their algorithm'
    )

    args = parser.parse_args()

    if not args.saxdb_file and not args.docker:
        # Try default locations
        import os
        default_paths = [
            '/home/ibutsu/testnet/x3data/x3.db',
            './x3data/x3.db',
            './data/x3.db',
            './x3.db'
        ]
        for path in default_paths:
            if os.path.exists(path):
                args.saxdb_file = path
                break

        if not args.saxdb_file:
            parser.print_help()
            print("\nError: No SAXDB file specified and no default found.", file=sys.stderr)
            sys.exit(1)

    # Read content
    if args.docker:
        content = read_saxdb_from_docker()
    else:
        content = read_saxdb_from_file(args.saxdb_file)

    # Parse accounts
    accounts = parse_saxdb_nickserv(content)

    if not accounts:
        print("No accounts found in SAXDB file.", file=sys.stderr)
        sys.exit(1)

    # Generate and print report
    if args.list_accounts:
        print(f"{'Account':<20s} {'Algorithm':<15s} {'Hash Preview':<40s}")
        print("-" * 75)
        for name, props in sorted(accounts.items()):
            passwd = props.get('passwd', '')
            algo = detect_algorithm(passwd)
            preview = passwd[:35] + "..." if len(passwd) > 35 else passwd
            print(f"{name:<20s} {algo:<15s} {preview:<40s}")
    else:
        report = generate_report(accounts, args.format)
        print(report)


if __name__ == '__main__':
    main()
