"""Read-only location acceptance checks against the running local workspace."""
import base64
import hashlib
import json
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]


def main():
    profile = json.loads((ROOT / 'config/local-profile.json').read_text(encoding='utf-8'))
    base = f'http://127.0.0.1:{profile["webPort"]}'
    session = requests.Session()

    def request(method, url, **kwargs):
        response = session.request(method, base + '/api' + url, timeout=30, **kwargs)
        response.raise_for_status()
        return response.json()

    assert request('GET', '/health')['ok']
    challenge = request('POST', '/pow/challenge', json={})
    raw = base64.urlsafe_b64decode(challenge['challenge'] + '==')
    nonce = 0
    while True:
        first = hashlib.sha256(b'csgofriberg-pow-v1\0' + raw + nonce.to_bytes(8, 'little')).digest()
        mixed = bytes(first[(i + 11) & 31] ^ first[i] ^ ((i * 29 + 0x5d) & 0xff) for i in range(32))
        digest = hashlib.sha256(b'csgofriberg-pow-v1\0' + mixed).digest()
        if int.from_bytes(digest, 'big') < 2 ** (256 - challenge['difficulty']):
            break
        nonce += 1
    request('POST', '/pow/verify', json={'id': challenge['id'], 'nonce': str(nonce)})
    credentials = json.loads((ROOT / '.local-data/test-admin.json').read_text(encoding='utf-8-sig'))
    user = request('POST', '/auth/login', json={key: credentials[key] for key in ('username', 'password')})['user']
    assert user['role'] == 'admin'
    full = request('GET', '/admin/location/overview')
    compact = request('GET', '/admin/location/overview', params={'compact': '1'})
    assert compact['questions'] == [] and compact['daily'] == []
    assert compact['capture'] == full['capture'] and compact['counts'] == full['counts']
    assert sum(point['count'] for point in compact['questionPoints']) == len(full['questions'])
    first = full['questions'][0]
    query = {'mapId': first['mapId'], 'floorId': first['floorId'], 'minU': 0, 'maxU': 1, 'minV': 0, 'maxV': 1, 'pageSize': 40}
    page = request('GET', '/admin/location/questions', params=query)
    expected = [q for q in full['questions'] if q['mapId'] == first['mapId'] and q['floorId'] == first['floorId'] and 0 <= q['u'] <= 1 and 0 <= q['v'] <= 1]
    assert page['total'] == len(expected) and len(page['items']) <= 40
    assert page['totalAll'] == len(full['questions'])
    if len(expected) > 40:
        second = request('GET', '/admin/location/questions', params={**query, 'page': 2})
        assert not ({q['id'] for q in page['items']} & {q['id'] for q in second['items']})
    detail = request('GET', '/admin/location/questions/' + first['id'])
    assert detail['question'] == first
    checks = request('GET', '/admin/location/checks')
    assert checks['missingAssets'] == []
    inventory = request('GET', '/admin/location/assets/inventory')
    assert len(inventory['items']) == 822
    assert all(item['state'] in ('referenced', 'staged', 'quarantine-candidate') for item in inventory['items'])
    metrics = request('GET', '/admin/location/metrics')
    assert int(metrics['outbox']['pending']) == 0 and int(metrics['deletions']['pending']) == 0
    replays = request('GET', '/location/replays')
    for item in replays['items']:
        record = request('GET', '/location/games/' + item['gameId'] + '/replay')
        assert record['totalScore'] == item['totalScore'] and len(record['results']) == 5
        assert all('calibration' in round['map'] for round in record['results'])
    report = {'questions': len(full['questions']), 'drafts': full['capture']['points'], 'assets': len(inventory['items']),
              'missingAssets': 0, 'compactOverview': 'ok', 'areaAndPagination': 'ok', 'questionDetail': 'ok',
              'oldPersonalReplaysRead': len(replays['items']), 'outboxPending': 0, 'assetDeletionPending': 0}
    (ROOT / '.local-data/verification/location-http-acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
