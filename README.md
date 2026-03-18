# AlexaTelegramSkill

Alexa Custom Skill, der gesprochene Anfragen per Telegram MTProto an einen Chat weiterleitet und die Antwort vorliest.

## Architektur

```
Alexa → AWS Lambda → Telegram (MTProto) → Antwort → Alexa TTS
```

- Session bleibt nach jeder Antwort offen (`Dialog.ElicitSlot`) — vollständig freies Sprechen ohne Trigger-Wort
- Progressive Response ("Einen Moment …") während Verarbeitung
- Intent "letzte Antwort" (inkl. AMAZON.RepeatIntent)

## Voraussetzungen

- AWS Account
- Alexa Developer Account
- Telegram MTProto API Credentials (`api_id`, `api_hash`, `session_string`)

## Alexa Setup (Developer Console)

1. Skill anlegen, Typ: **Custom**
2. Invocation Name: `chloe`
3. Interaction Model aus `models/de-DE.json` importieren und bauen
4. Endpoint: **AWS Lambda ARN** aus CloudFormation Output `AlexaSkillFunctionArn`
5. Testen:
   ```
   Alexa, öffne Chloe
   → Skill fragt: "Hi, ich bin Clawi. Was möchtest du fragen?"
   → Einfach frei sprechen
   ```

## Deployment (AWS SAM)

```bash
sam build
sam deploy --guided
```

## GitHub Actions Auto-Deploy

Workflow: `.github/workflows/deploy.yml`

Setze diese Repository-Secrets:

| Secret | Beschreibung |
|---|---|
| `AWS_ROLE_TO_ASSUME` | OIDC deploy role ARN |
| `AWS_REGION` | z. B. `eu-central-1` |
| `AWS_STACK_NAME` | z. B. `alexa-telegram-skill` |
| `ALEXA_SKILL_ID` | `amzn1.ask.skill...` |
| `TELEGRAM_CHAT_ID` | Chat-ID des Ziel-Chats |
| `TELEGRAM_THREAD_ID` | (optional) Forum-Topic-ID |
| `TELEGRAM_API_ID` | MTProto API ID |
| `TELEGRAM_API_HASH` | MTProto API Hash |
| `TELEGRAM_SESSION_STRING` | MTProto Session String |

## Timeout-Parameter (SAM / CloudFormation)

| Parameter | Default | Beschreibung |
|---|---|---|
| `TgReplyWaitMs` | `20000` | Max. Wartezeit auf Telegram-Antwort |
| `TgUserConnectTimeoutMs` | `2200` | MTProto Connect-Timeout |
| `TgUserReadTimeoutMs` | `2200` | MTProto Read-Timeout |
| `TgUserSendTimeoutMs` | `2200` | MTProto Send-Timeout |

## Lokal testen

```bash
npm ci
npm run lint
sam build
```

## Sicherheit

- Secrets nur in GitHub/AWS Secret Stores
- Keine Tokens im Code
- Skill-ID Validierung aktiv (`ALEXA_SKILL_ID`)
