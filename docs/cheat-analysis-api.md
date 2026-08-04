# External Cheat Analysis API

The admin UI requests analysis only after an administrator clicks the analysis button. The main application does not persist the response.

## Configuration

```env
CHEAT_ANALYSIS_API_URL=https://analysis.example.com/v1/analyze
CHEAT_ANALYSIS_API_TOKEN=replace-with-a-random-bearer-token
CHEAT_ANALYSIS_TIMEOUT_MS=15000
```

`CHEAT_ANALYSIS_API_URL` and `CHEAT_ANALYSIS_API_TOKEN` must be configured together. The timeout is clamped to 1-30 seconds.

## Request Authentication

The application sends a JSON `POST` request with these headers:

```text
Content-Type: application/json
Accept: application/json
Authorization: Bearer <CHEAT_ANALYSIS_API_TOKEN>
```

The external service should compare the bearer token using a timing-safe equality check and return `401` or `403` when it is invalid.

## Request Body

```json
{
  "schemaVersion": 1,
  "requestId": "uuid",
  "generatedAt": "2026-08-02T12:00:00.000Z",
  "locale": "zh-CN",
  "trigger": "report",
  "subject": {
    "type": "user",
    "opaqueId": "per-request-uuid"
  },
  "playerPool": {
    "revision": "42",
    "players": [
      {
        "id": 1,
        "nickname": "player",
        "nationality": "China",
        "region": "Asia",
        "team": "Team",
        "teamHistory": ["Former Team"],
        "age": 24,
        "role": "Rifler",
        "majorChampionships": 1,
        "majorAppearances": 4,
        "isActive": true,
        "isEnabled": true,
        "difficulties": ["easy", "normal"],
        "createdAt": "2026-01-01T00:00:00.000Z"
      }
    ]
  },
  "singleGames": [
    {
      "recordId": 10,
      "targetPlayerId": 1,
      "mode": "normal",
      "status": "won",
      "guessCount": 2,
      "firstGuessPlayerId": 2,
      "guessPlayerIds": [2, 1],
      "guessTimesMs": [900, 1750],
      "startedAt": "2026-08-02T11:58:00.000Z",
      "finishedAt": "2026-08-02T12:00:00.000Z"
    }
  ],
  "matches": [
    {
      "recordId": 20,
      "mode": "normal",
      "boType": 3,
      "result": "won",
      "winnerParticipantId": "same-as-subject-opaque-id",
      "forfeitedParticipantId": null,
      "finishReason": "score",
      "finishedAt": "2026-08-02T12:00:00.000Z",
      "participants": [
        {
          "participantId": "same-as-subject-opaque-id",
          "isSubject": true,
          "score": 2,
          "isWinner": true,
          "winningGuessSum": 3,
          "winningRounds": 2
        }
      ],
      "rounds": [
        {
          "round": 1,
          "targetPlayerId": 1,
          "winnerParticipantId": "same-as-subject-opaque-id",
          "reason": "guessed",
          "guessesByParticipant": {
            "same-as-subject-opaque-id": [2, 1]
          },
          "guessTimesMsByParticipant": {
            "same-as-subject-opaque-id": [900, 1750]
          }
        }
      ]
    }
  ],
  "reports": {
    "count": 3,
    "independentReporters": 2,
    "pending": 2
  }
}
```

`playerPool.players` contains the complete current player pool, including disabled players, every difficulty membership, and each player's normalized historical teams. `teamHistory` is optional for rolling compatibility and defaults to an empty array when omitted. The snapshot contains the subject's latest 50 completed single-player games and latest 50 completed multiplayer matches. Each multiplayer match contains every participant and its complete stored replay; valid game records contain at most 8 guesses per player per round. Guess times are server-recorded milliseconds from game or round start.

The request excludes account usernames, emails, multiplayer display names, raw user/guest identity keys, report descriptions, admin notes, IP addresses, cookies, and authentication tokens. `subject.opaqueId` is generated independently for every request. Every multiplayer participant receives a per-request opaque ID, and the subject keeps the same opaque ID across `subject`, participants, winners, forfeits, guesses, and timings.

## Response Body

The service must return JSON matching this presentation envelope:

```json
{
  "schemaVersion": 1,
  "requestId": "same-request-uuid",
  "analysisId": "temporary-analysis-id",
  "modelVersion": "2026.08.1",
  "generatedAt": "2026-08-02T12:00:01.000Z",
  "decision": {
    "level": "high",
    "score": 92,
    "label": "High risk",
    "summary": "Behavior is strongly consistent with automation."
  },
  "sections": [
    {
      "title": "Signals",
      "items": [
        {
          "type": "metric",
          "label": "Suspicious rounds",
          "value": 12,
          "displayValue": "12",
          "severity": "danger"
        }
      ]
    }
  ]
}
```

Supported item types are `metric`, `text`, `badge`, `table`, `timeline`, and `distribution`. Severity values are `neutral`, `info`, `success`, `warning`, and `danger`. Decision levels are `unknown`, `low`, `medium`, `high`, and `critical`. `decision.score` is a required integer from 0 to 100.

The frontend renders all strings as text. HTML is not accepted.

## Response Validation

The response does not require a signature. The application rejects unsuccessful HTTP responses, invalid JSON, mismatched request IDs, unknown fields, oversized responses, and unsupported presentation types.
