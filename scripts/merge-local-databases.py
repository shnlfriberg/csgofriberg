"""Merge frozen local snapshots into a NEW database, without touching either source.

Player data and review records follow the scraper-side database. Location data,
screenshots, capture drafts and match history follow CS-guesser. A conflicting
user/player ID aborts instead of silently breaking JSON replay references.
"""
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKUPS = ROOT / '.local-data' / 'backups'
OUTPUT = ROOT / 'server' / 'data' / 'csgofriberg.sqlite3'


def rows(db, table):
    return [dict(row) for row in db.execute(f'SELECT * FROM "{table}"')]


def insert(db, table, row):
    keys = ','.join(f'"{key}"' for key in row)
    return db.execute(
        f'INSERT INTO "{table}" ({keys}) VALUES ({",".join("?" for _ in row)})',
        list(row.values()),
    ).lastrowid


def merge():
    if OUTPUT.exists():
        raise SystemExit(f'Refusing to overwrite existing database: {OUTPUT}')
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(f'file:{(BACKUPS / "location.sqlite3").as_posix()}?mode=ro', uri=True)
    players = sqlite3.connect(f'file:{(BACKUPS / "players.sqlite3").as_posix()}?mode=ro', uri=True)
    source.row_factory = players.row_factory = sqlite3.Row
    target = sqlite3.connect(str(OUTPUT))
    target.row_factory = sqlite3.Row
    players.backup(target)
    target.execute('PRAGMA foreign_keys=ON')
    report = {'player_conflicts_kept_from_scraper': [], 'tables': {}, 'source_snapshots': ['location.sqlite3', 'players.sqlite3']}
    try:
        with target:
            for table, natural in [('users', 'username'), ('players', 'nickname')]:
                for row in rows(source, table):
                    same = target.execute(f'SELECT * FROM "{table}" WHERE "{natural}"=?', (row[natural],)).fetchone()
                    if same:
                        if same['id'] != row['id']:
                            raise ValueError(f'{table}: replay ID remapping required for {row[natural]}')
                        if table == 'players' and dict(same) != row:
                            report['player_conflicts_kept_from_scraper'].append(row['nickname'])
                        continue
                    insert(target, table, row)
            for row in rows(source, 'guest_accounts'):
                same = target.execute('SELECT id FROM guest_accounts WHERE guest_key=? OR guest_key_hash=?', (row['guest_key'], row['guest_key_hash'])).fetchone()
                if not same:
                    row.pop('id')  # references use guest_key, never the numeric row ID
                    insert(target, 'guest_accounts', row)
            # Keep scraper difficulty memberships for shared players.
            original_ids = {r['id'] for r in rows(players, 'players')}
            for row in rows(source, 'player_difficulties'):
                if row['player_id'] not in original_ids:
                    insert(target, 'player_difficulties', row)
            daily_ids = {}
            for row in rows(source, 'daily_challenges'):
                old_id = row.pop('id')
                same = target.execute('SELECT id FROM daily_challenges WHERE challenge_date=? AND difficulty_key=?', (row['challenge_date'], row['difficulty_key'])).fetchone()
                if same:
                    raise ValueError('Conflicting daily challenge needs an explicit resolution')
                daily_ids[old_id] = insert(target, 'daily_challenges', row)
            # These tables are empty on one side in the captured projects. Fail on
            # future conflicts rather than overwrite account/history/review data.
            for table in ['email_verifications', 'api_tokens', 'player_change_submissions', 'player_change_items', 'games', 'match_records', 'match_players', 'match_reports', 'report_whitelist', 'announcements', 'daily_challenge_attempts']:
                for row in rows(source, table):
                    if table == 'daily_challenge_attempts':
                        row['challenge_id'] = daily_ids[row['challenge_id']]
                    insert(target, table, row)
            location_tables = [r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'location_%'")]
            for table in location_tables:
                ddl = source.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
                target.execute(ddl)
                for row in rows(source, table):
                    insert(target, table, row)
                for index in source.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", (table,)):
                    target.execute(index[0])
            errors = target.execute('PRAGMA foreign_key_check').fetchall()
            if errors:
                raise ValueError(f'Broken foreign keys: {errors}')
            if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('SQLite integrity check failed')
            # Every original scraper-side row must still exist byte-for-byte.
            for item in players.execute("SELECT name FROM sqlite_master WHERE type='table' AND name!='sqlite_sequence'"):
                table = item[0]
                old = rows(players, table)
                merged = rows(target, table)
                assert all(row in merged for row in old), f'Source row changed: {table}'
            for item in target.execute("SELECT name FROM sqlite_master WHERE type='table' AND name!='sqlite_sequence'"):
                table = item[0]
                report['tables'][table] = len(rows(target, table))
        report['foreign_key_check'] = 'ok'
        report['integrity_check'] = 'ok'
        (ROOT / 'integration' / 'database-merge.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        target.close()
        source.close()
        players.close()


if __name__ == '__main__':
    merge()
