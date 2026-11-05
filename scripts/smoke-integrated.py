"""Exercise the real local HTTP/proxy/auth/scraper/location connection.

Uses the application PoW flow and checks an unchanged submission, so existing
players and pending reviews are preserved. Never points at a remote server.
"""
import base64
import hashlib
import json
import sqlite3
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]


def main():
    # Check against the current local database, rather than the original import
    # counts. Read-only mode prevents creating a database at an incorrect path.
    database = ROOT / 'server/data/csgofriberg.sqlite3'
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
        expected = {
            'players': connection.execute('SELECT COUNT(*) FROM players').fetchone()[0],
            'questions': connection.execute('SELECT COUNT(*) FROM location_questions').fetchone()[0],
            'drafts': connection.execute('SELECT COUNT(*) FROM location_capture_drafts').fetchone()[0],
        }
    credentials = json.loads((ROOT / '.local-data/test-admin.json').read_text(encoding='utf-8-sig'))
    settings = json.loads((ROOT / 'external-scraper/config.json').read_text(encoding='utf-8'))
    assert settings['api_url'] == 'http://127.0.0.1:3002'
    base = 'http://127.0.0.1:5175'
    session = requests.Session()
    session.headers['User-Agent'] = 'FribergIntegratedLocalSmoke/1.0'

    def request(method, url, **kwargs):
        response = session.request(method, base + url, timeout=30, **kwargs)
        response.raise_for_status()
        return response.json()

    health = request('GET', '/api/health')
    assert health['ok'] and health['redis'] == 'up'
    challenge = request('POST', '/api/pow/challenge', json={})
    domain = b'csgofriberg-pow-v1\0'
    raw = base64.urlsafe_b64decode(challenge['challenge'] + '==')
    nonce = 0
    while True:
        first = hashlib.sha256(domain + raw + nonce.to_bytes(8, 'little')).digest()
        mixed = bytes(first[(i + 11) & 31] ^ first[i] ^ ((i * 29 + 0x5d) & 0xff) for i in range(32))
        digest = hashlib.sha256(domain + mixed).digest()
        if int.from_bytes(digest, 'big') < 2 ** (256 - challenge['difficulty']):
            break
        nonce += 1
    request('POST', '/api/pow/verify', json={'id': challenge['id'], 'nonce': str(nonce)})
    user = request('POST', '/api/auth/login', json={k: credentials[k] for k in ('username', 'password')})['user']
    assert user['role'] == 'admin'
    listing = request('GET', '/api/admin/players', params={'pageSize': 20})
    assert listing['total'] == expected['players']
    overview = request('GET', '/api/admin/location/overview')
    assert len(overview['questions']) == expected['questions']
    assert overview['capture']['points'] == expected['drafts']
    checks = request('GET', '/api/admin/location/checks')
    assert checks['missingAssets'] == [], checks
    assert all(checks['compositions'].values()), checks
    authorization = {'Authorization': 'Bearer ' + settings['token']}
    exported = request('GET', '/api/external/players/export', headers=authorization)
    assert len(exported) == expected['players']
    assert all('playerId' in row for row in exported)
    same = request('POST', '/api/external/player-change-submissions', headers=authorization,
                   json={'players': [{'playerId': exported[0]['playerId'], 'changes': {'team': exported[0]['team']}}]})
    assert same == {'submissionId': None, 'submitted': 0, 'unchanged': 1}, same
    anonymous = requests.get(base + '/api/external/players/export', timeout=10)
    assert anonymous.status_code == 401
    game = request('POST', '/api/location/games', json={'mode': 'random', 'difficulty': 'easy'})
    assert game['totalRounds'] == 5 and game['question']['imageUrl'].startswith('/location-assets/')
    try:
        image = session.get(base + game['question']['imageUrl'], timeout=10)
        assert image.status_code == 200 and image.headers['Content-Type'].startswith('image/')
    finally:
        request('POST', f'/api/location/games/{game["id"]}/abandon', json={})
    # Feed a complete, freshly exported database snapshot into the scraper's
    # real dynamic-baseline pipeline via --skip-crawl (no Liquipedia requests).
    snapshot = ROOT / '.local-data/smoke-export.json'
    snapshot.write_text(json.dumps(exported, ensure_ascii=False, indent=2), encoding='utf-8')
    report = {'health': 'ok', 'administrator_login': 'ok', 'players': len(exported),
              'location_questions': len(overview['questions']), 'capture_drafts': overview['capture']['points'],
              'missing_assets': len(checks['missingAssets']), 'difficulty_compositions': checks['compositions'],
              'external_token_export': 'ok', 'unchanged_submission': same,
              'anonymous_export_status': anonymous.status_code, 'random_five_round_start_and_image': 'ok'}
    (ROOT / 'integration/http-smoke.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
