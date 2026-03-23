# AlexaTelegramSkill

Alexa Custom Skill that forwards spoken queries via Telegram MTProto to a chat and reads back the reply.

## Architecture

```
Alexa → AWS Lambda → Telegram (MTProto) → Reply → Alexa TTS
```

- Session stays open after each reply (`Dialog.ElicitSlot`) — free-form speech without a trigger word
- Event-based reply listener (gramjs `NewMessage` + `MessageEdited`) with settle timer — supports streaming bots that edit their message
- Optional waiting sound played via `VoicePlayer.Speak` progressive directive while waiting for the Telegram reply (configurable via `UseWaitingSound`)
- "Last reply" intent (including `AMAZON.RepeatIntent`) — falls back to fetching the actual last Telegram message when no session data is available
- Automatic opposite voice: the skill speaks with the opposite gender voice to the global Alexa default (configurable via `AlexaOppositeVoice`)
- Multilingual: German and English (locale-aware strings, Telegram message, TTS voice)

## Prerequisites

- AWS Account
- Alexa Developer Account
- Telegram MTProto API credentials (`api_id`, `api_hash`, `session_string`)

## Obtaining Telegram Credentials

### `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`

1. Go to [https://my.telegram.org](https://my.telegram.org) and log in with your phone number.
2. Click **API development tools**.
3. Fill in the app name/short name (anything works), then click **Create application**.
4. Copy the `api_id` (integer) and `api_hash` (hex string).

### `TELEGRAM_SESSION_STRING`

The session string authenticates your Telegram user account via MTProto. Generate it once locally:

```bash
node -e "
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

(async () => {
  const client = new TelegramClient(new StringSession(''), Number(process.env.API_ID), process.env.API_HASH, {});
  await client.start({ phoneNumber: async () => input.text('Phone: '), password: async () => input.text('2FA: '), phoneCode: async () => input.text('Code: '), onError: console.error });
  console.log('SESSION:', client.session.save());
  await client.disconnect();
})();
" 
```

Or use the official [GramJS examples](https://gram.js.org/). The resulting string is a long base64-like token — store it as a secret, never commit it.

### `TELEGRAM_CHAT_ID`

The numeric ID of the chat/group/channel the skill should send messages to.

**Easiest way:** Forward any message from the target chat to [@userinfobot](https://t.me/userinfobot). It replies with the chat's numeric ID (e.g. `-1001234567890` for groups/channels).

Alternatively, use the Telegram Bot API: add `@RawDataBot` to the chat, send a message, and it will print the full update JSON including `"chat": { "id": ... }`.

### `TELEGRAM_THREAD_ID` (optional)

Only needed for **forum supergroups** (groups with topics enabled). It is the message ID of the topic's root message — visible in the URL when you open a specific topic in Telegram Web: `https://web.telegram.org/k/#-100xxx/YYY` where `YYY` is the thread ID.

## Alexa Setup (Developer Console)

1. Create a skill, type: **Custom**
2. Invocation name: `open claw` (de-DE, en-US, en-GB)
3. Import the interaction model for your locale and build:
   - `models/de-DE.json` — German (Germany)
   - `models/en-US.json` — English (US)
   - `models/en-GB.json` — English (UK)
4. Endpoint: **AWS Lambda ARN** from CloudFormation output `AlexaSkillFunctionArn`
5. Test:
   ```
   Alexa, open Clawi
   → Skill asks: "Hi, I'm Clawi. What would you like to ask?"
   → Just speak freely
   ```

## Deployment (AWS SAM)

```bash
sam build
sam deploy --guided
```

## GitHub Actions Auto-Deploy

Workflow: `.github/workflows/deploy.yml`

Set these repository secrets:

| Secret | Description |
|---|---|
| `AWS_ROLE_TO_ASSUME` | OIDC deploy role ARN |
| `AWS_REGION` | e.g. `eu-central-1` |
| `AWS_STACK_NAME` | e.g. `alexa-telegram-skill` |
| `ALEXA_SKILL_ID` | `amzn1.ask.skill...` |
| `TELEGRAM_CHAT_ID` | Target chat ID |
| `TELEGRAM_THREAD_ID` | (optional) Forum topic ID |
| `TELEGRAM_API_ID` | MTProto API ID |
| `TELEGRAM_API_HASH` | MTProto API Hash |
| `TELEGRAM_SESSION_STRING` | MTProto Session String |
| `USE_WAITING_SOUND` | `true` or `false` |

## SAM / CloudFormation Parameters

| Parameter | Default | Description |
|---|---|---|
| `AlexaSkillId` | `` | Alexa Skill ID for request validation |
| `TelegramChatId` | `` | Target Telegram chat ID |
| `TelegramThreadId` | `` | (optional) Forum topic / thread ID |
| `TelegramApiId` | `` | MTProto API ID |
| `TelegramApiHash` | `` | MTProto API Hash |
| `TelegramSessionString` | `` | MTProto Session String |
| `TgReplyWaitMs` | `20000` | Max wait time for a Telegram reply (ms) |
| `TgUserConnectTimeoutMs` | `2200` | MTProto connect timeout (ms) |
| `TgUserReadTimeoutMs` | `2200` | MTProto read/history timeout (ms) |
| `TgUserSendTimeoutMs` | `2200` | MTProto send timeout (ms) |
| `AlexaOppositeVoice` | `true` | Enable opposite-gender voice (`true`/`false`) |
| `UseWaitingSound` | `true` | Play waiting audio while fetching reply (`true`/`false`) |

### Waiting Sound (`UseWaitingSound`)

When enabled, the skill plays a short audio clip via the `VoicePlayer.Speak` progressive directive while waiting for the Telegram reply. The audio file (`waiting_sound.mp3`) is automatically uploaded to a private S3 bucket by a CloudFormation custom resource during deployment — no manual upload needed.

To disable:
```bash
sam deploy --parameter-overrides UseWaitingSound=false
```

### Opposite Voice (`AlexaOppositeVoice`)

When enabled, the skill automatically uses the opposite-gender voice to the locale's Alexa default — making this skill clearly distinguishable from the global Alexa assistant.

#### Default voice mapping

| Locale | Alexa default | Skill voice |
|---|---|---|
| `de-DE` / `de-AT` / `de-CH` | female (Alexa) | Hans (male) |
| `en-US` / `en-CA` / `en-IN` | female (Alexa) | Matthew (male) |
| `en-GB` | female (Amy) | Brian (male) |
| `en-AU` | female (Nicole) | Russell (male) |
| `fr-FR` / `fr-CA` | female | Mathieu (male) |
| `es-ES` | female | Enrique (male) |
| `es-US` / `es-MX` | female | Miguel (male) |
| `it-IT` | female | Giorgio (male) |
| `ja-JP` | male (Takumi) | Mizuki (female) |
| `pt-BR` | female | Ricardo (male) |

To disable at deploy time:
```bash
sam deploy --parameter-overrides AlexaOppositeVoice=false
```

#### Customizing the voice per locale

The voice names are defined directly in `src/handler.mjs` in two maps:

- **`LOCALE_VOICE_MALE`** — used for all locales where Alexa's default is female (most locales).
- **`LOCALE_VOICE_FEMALE`** — used for locales where Alexa's default is male (currently only `ja-JP`).

To change the voice for a specific locale, edit the corresponding entry in the relevant map. Example — switching German to a female voice while keeping `AlexaOppositeVoice=false`:

```js
// src/handler.mjs
const LOCALE_VOICE_MALE = {
  "de-DE": "Hans",   // ← change to any supported Polly/Alexa voice name
  ...
};
```

Any [Amazon Polly voice](https://docs.aws.amazon.com/polly/latest/dg/voicelist.html) supported in the target locale can be used. After editing, redeploy with `sam build && sam deploy`.

## Local Testing

```bash
npm ci
npm run lint
sam build
```

## Security

- Secrets stored only in GitHub / AWS Secret Stores
- No tokens in code
- Skill ID validation active (`ALEXA_SKILL_ID`)
