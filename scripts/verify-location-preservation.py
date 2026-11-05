"""Compare every pre-existing SQL value and asset against the stopped-service backup."""
import argparse
import hashlib
import json
import sqlite3
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def verify(backup, database, assets, location_only=False, allow_additions=False):
    with sqlite3.connect((backup / 'database.sqlite3').as_uri() + '?mode=ro', uri=True) as before, sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as after:
        tables = [row[0] for row in before.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
        if location_only:
            tables = [table for table in tables if table.startswith('location_')]
        counts = {}
        for table in tables:
            columns = [row[1] for row in before.execute('pragma table_info(' + quote(table) + ')')]
            query = 'select ' + ','.join(map(quote, columns)) + ' from ' + quote(table)
            original = sorted(before.execute(query).fetchall(), key=repr)
            current = sorted(after.execute(query).fetchall(), key=repr)
            unchanged = not (Counter(original) - Counter(current)) if allow_additions else original == current
            if not unchanged:
                raise AssertionError(f'Original data changed: {table}')
            counts[table] = len(original)
        if after.execute('pragma integrity_check').fetchone()[0] != 'ok':
            raise AssertionError('SQLite integrity check failed')
        if after.execute('pragma foreign_key_check').fetchall():
            raise AssertionError('SQLite foreign key check failed')
    total_bytes = 0
    files = list((backup / 'assets').rglob('*'))
    verified = 0
    for original in files:
        if not original.is_file():
            continue
        current = assets / original.relative_to(backup / 'assets')
        if not current.is_file() or hashlib.sha256(original.read_bytes()).digest() != hashlib.sha256(current.read_bytes()).digest():
            raise AssertionError(f'Asset changed: {current}')
        verified += 1
        total_bytes += original.stat().st_size
    return {'verifiedOriginalTables': len(tables), 'counts': counts, 'verifiedAssets': verified, 'assetBytes': total_bytes, 'databaseIntegrity': 'ok'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--backup', type=Path, default=Path((ROOT / '.local-data/location-optimization-backup.txt').read_text(encoding='utf-8-sig').strip()))
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--assets', type=Path, default=ROOT / 'data/location-assets')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--location-only', action='store_true')
    parser.add_argument('--allow-additions', action='store_true')
    args = parser.parse_args()
    result = verify(args.backup.resolve(), args.database.resolve(), args.assets.resolve(), args.location_only, args.allow_additions)
    encoded = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(encoded, encoding='utf-8')
    print(encoded)
