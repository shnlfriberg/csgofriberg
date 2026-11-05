"""Read-only business-data manifest and SQLite online backup for local rollout."""
import argparse
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def manifest(connection, assets):
    tables = {}
    for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        quoted = '"' + name.replace('"', '""') + '"'
        rows = sorted(json.dumps(row, ensure_ascii=True, default=lambda value: bytes(value).hex()) for row in connection.execute('SELECT * FROM ' + quoted))
        tables[name] = {'rows': len(rows), 'sha256': hashlib.sha256('\n'.join(rows).encode()).hexdigest()}
    files = {str(path.relative_to(assets)): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in sorted(assets.rglob('*')) if path.is_file()}
    return {'observedAt': datetime.now(timezone.utc).isoformat(), 'tables': tables, 'assets': files}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True)
    parser.add_argument('--assets', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--backup')
    args = parser.parse_args()
    source = sqlite3.connect(Path(args.database).resolve().as_uri() + '?mode=ro', uri=True)
    if args.backup:
        backup = Path(args.backup)
        if backup.exists():
            raise SystemExit('Refusing to overwrite an existing backup')
        backup.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(backup) as destination:
            source.backup(destination)
    report = manifest(source, Path(args.assets))
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'tables': len(report['tables']), 'assets': len(report['assets'])}))
