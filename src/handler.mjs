import Alexa from "ask-sdk-core";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import tgEvents from "telegram/events/index.js";
const { NewMessage, MessageEdited, Raw } = tgEvents;

// Pre-built once at module load — avoids object construction on every warm invocation.
const newMsgEvent = new NewMessage({});
const editMsgEvent = MessageEdited ? new MessageEdited({}) : Raw ? new Raw({}) : null;
const isRawFallback = !MessageEdited && Boolean(Raw);

const {
  TELEGRAM_CHAT_ID,
  ALEXA_SKILL_ID,
  TELEGRAM_THREAD_ID = "",
  TELEGRAM_API_ID = "",
  TELEGRAM_API_HASH = "",
  TELEGRAM_SESSION_STRING = "",
  TG_USER_CONNECT_TIMEOUT_MS = "2200",
  TG_USER_READ_TIMEOUT_MS = "2200",
  TG_USER_SEND_TIMEOUT_MS = "2200",
  TG_REPLY_WAIT_MS = "20000",
  WAITING_AUDIO_URL = "",
  ALEXA_OPPOSITE_VOICE = "true",
  USE_WAITING_SOUND = "false",
} = process.env;

// Best effort memory across warm Lambda invokes per user.
const lastByUser = new Map();
let telegramUserClient = null;
let telegramUserEntity = null;
const useWaitingSound = USE_WAITING_SOUND.toLowerCase() === "true";
const audioSpeech = `<speak><audio src="${escapeSsml(WAITING_AUDIO_URL.trim())}"/></speak>`;

// Parse once at cold start to avoid repeated Number() coercions per invocation.
const tgConnectTimeoutMs = Number(TG_USER_CONNECT_TIMEOUT_MS);
const tgReadTimeoutMs = Number(TG_USER_READ_TIMEOUT_MS);
const tgSendTimeoutMs = Number(TG_USER_SEND_TIMEOUT_MS);
const tgReplyWaitMs = Number(TG_REPLY_WAIT_MS);

function cleanSpeech(text) {
  if (!text) return "";
  return String(text)
    .replace(/[\u0000-\u001F]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ")
    .replace(/[`*_~#>|\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SSML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
function escapeSsml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => SSML_ESCAPE_MAP[ch]);
}

// CLAWINAMETOKEN is a plain-alphanumeric placeholder that survives cleanSpeech and escapeSsml.
// It is replaced with the locale-correct <phoneme> tag inside toAlexaSpeech.
const NAME_PHONEME_DE = '<phoneme alphabet="ipa" ph="klɔːi">Clawi</phoneme>';
const NAME_PHONEME_EN = '<phoneme alphabet="ipa" ph="klɔːi">Clawi</phoneme>';

// Set to true to use the opposite-gender voice for skill responses.
// When false, Alexa's default voice for the locale is used (no <voice> tag).
// Controlled via the ALEXA_OPPOSITE_VOICE environment variable.
const USE_OPPOSITE_VOICE = ALEXA_OPPOSITE_VOICE.toLowerCase() !== "false";

// Female voices per locale (opposite of a male Alexa default).
const LOCALE_VOICE_FEMALE = {
  "de-DE": "Vicki",
  "de-AT": "Vicki",
  "de-CH": "Vicki",
  "en-US": "Joanna",
  "en-GB": "Amy",
  "en-AU": "Nicole",
  "en-CA": "Joanna",
  "en-IN": "Aditi",
  "fr-FR": "Celine",
  "fr-CA": "Chantal",
  "es-ES": "Conchita",
  "es-US": "Penelope",
  "es-MX": "Mia",
  "it-IT": "Carla",
  "ja-JP": "Mizuki",
  "pt-BR": "Vitoria",
};

// Male voices per locale (opposite of a female Alexa default).
const LOCALE_VOICE_MALE = {
  "de-DE": "Hans",
  "de-AT": "Hans",
  "de-CH": "Hans",
  "en-US": "Matthew",
  "en-GB": "Brian",
  "en-AU": "Russell",
  "en-CA": "Matthew",
  "en-IN": "Matthew",
  "fr-FR": "Mathieu",
  "fr-CA": "Mathieu",
  "es-ES": "Enrique",
  "es-US": "Miguel",
  "es-MX": "Miguel",
  "it-IT": "Giorgio",
  "ja-JP": "Takumi",
  "pt-BR": "Ricardo",
};

// Locales where Alexa's built-in default voice is male — so opposite = female.
const LOCALES_WITH_MALE_DEFAULT = new Set(["ja-JP"]);

function toAlexaSpeech(text, handlerInput) {
  const cleaned = cleanSpeech(text);
  const escaped = escapeSsml(cleaned);
  const locale = handlerInput?.requestEnvelope?.request?.locale || "de-DE";
  const withName = escaped.replace(/CLAWINAMETOKEN/g, locale.startsWith("en") ? NAME_PHONEME_EN : NAME_PHONEME_DE);

  if (!USE_OPPOSITE_VOICE) {
    return `<speak>${withName}</speak>`;
  }

  const useFemale = LOCALES_WITH_MALE_DEFAULT.has(locale);
  const voiceMap = useFemale ? LOCALE_VOICE_FEMALE : LOCALE_VOICE_MALE;
  const voiceName = voiceMap[locale] ?? (useFemale ? "Joanna" : "Matthew");

  return `<speak><voice name="${voiceName}">${withName}</voice></speak>`;
}

function getUserId(envelope) {
  return envelope?.context?.System?.user?.userId || "anonymous";
}

function rememberLast(handlerInput, query, reply) {
  const userId = getUserId(handlerInput.requestEnvelope);
  const attributes = handlerInput.attributesManager.getSessionAttributes();
  attributes.lastQuery = query;
  attributes.lastReply = reply;
  handlerInput.attributesManager.setSessionAttributes(attributes);
  lastByUser.set(userId, { query, reply, ts: Date.now() });
}

function getLast(handlerInput) {
  const attributes = handlerInput.attributesManager.getSessionAttributes();
  if (attributes.lastReply) {
    return { query: attributes.lastQuery, reply: attributes.lastReply };
  }
  return lastByUser.get(getUserId(handlerInput.requestEnvelope)) || null;
}

function waitFor(promise, ms, timeoutLabel = "inline-timeout") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutLabel)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getTelegramUserClient() {
  const apiId = Number(TELEGRAM_API_ID);
  const hasCreds = Boolean(
    TELEGRAM_API_ID && TELEGRAM_API_HASH && TELEGRAM_SESSION_STRING,
  );

  if (!hasCreds) {
    return null;
  }

  if (!Number.isFinite(apiId) || apiId <= 0) {
    return null;
  }

  if (telegramUserClient) {
    return telegramUserClient;
  }

  try {
    telegramUserClient = new TelegramClient(
      new StringSession(TELEGRAM_SESSION_STRING.trim()),
      apiId,
      TELEGRAM_API_HASH.trim(),
      { connectionRetries: 2 },
    );

    await waitFor(
      telegramUserClient.connect(),
      tgConnectTimeoutMs,
      "tg-connect-timeout",
    );

    return telegramUserClient;
  } catch (err) {
    console.log(
      "[TG_DEBUG] user client init failed:",
      err?.message || String(err),
    );
    const orphan = telegramUserClient;
    telegramUserClient = null;
    if (orphan) {
      orphan.disconnect().catch(() => {});
    }
    return null;
  }
}

async function getTelegramUserEntity(client) {
  if (!client) {
    return null;
  }
  if (!TELEGRAM_CHAT_ID) {
    return null;
  }
  if (telegramUserEntity) {
    return telegramUserEntity;
  }

  const raw = String(TELEGRAM_CHAT_ID).trim();
  const num = Number(raw);

  try {
    // Try numeric id first (e.g. -100...)
    if (Number.isFinite(num)) {
      telegramUserEntity = await waitFor(
        client.getEntity(num),
        tgReadTimeoutMs,
        "tg-entity-timeout-numeric",
      );
      return telegramUserEntity;
    }

    // Fallback: username/string form
    telegramUserEntity = await waitFor(
      client.getEntity(raw),
      tgReadTimeoutMs,
      "tg-entity-timeout-string",
    );
    return telegramUserEntity;
  } catch (err) {
    console.log(
      "[TG_DEBUG] entity resolve failed:",
      err?.message || String(err),
      JSON.stringify({ raw, numIsFinite: Number.isFinite(num) }),
    );
    telegramUserEntity = null;
    if (err?.message?.includes("tg-entity-timeout")) {
      const orphan = telegramUserClient;
      telegramUserClient = null;
      if (orphan) {
        orphan.disconnect().catch(() => {});
      }
    }
    return null;
  }
}

function extractSenderName(sender) {
  return sender?.firstName || sender?.title || sender?.username || "unbekannt";
}

async function getLatestMessageViaUserApi() {
  const client = await getTelegramUserClient();
  if (!client) return null;

  const peer = await getTelegramUserEntity(client);
  if (!peer) return null;

  try {
    const history = await waitFor(
      client.getMessages(peer, { limit: 10 }),
      tgReadTimeoutMs,
      "tg-history-timeout",
    );

    const items = Array.isArray(history)
      ? history
      : history?.messages || history || [];
    for (const m of items) {
      const text = String(m?.message || "").trim();
      if (!text) continue;
      if (m?.out) continue;
      if (text.startsWith("🎤 Alexa:")) continue;

      let sender = "unbekannt";
      try {
        const s = await m.getSender?.();
        sender = extractSenderName(s);
      } catch {
        // ignore
      }

      return {
        id: Number(m?.id || 0),
        text,
        sender,
      };
    }

    return null;
  } catch (err) {
    console.log("Telegram user api history failed:", err?.message || err);
    if (err?.message === "tg-history-timeout") {
      const orphan = telegramUserClient;
      telegramUserClient = null;
      telegramUserEntity = null;
      if (orphan) {
        orphan.disconnect().catch(() => {});
      }
    }
    return null;
  }
}

async function sendViaTelegramUserApi(query, strings) {
  const client = await getTelegramUserClient();
  if (!client) return null;

  const peer = await getTelegramUserEntity(client);
  if (!peer) return null;

  try {
    const msg = strings.telegramMsg(query);
    const options = { message: msg };

    // Warning: this only makes sense if TELEGRAM_THREAD_ID is actually a message id
    // that anchors the topic. If it's a forum topic id, this may not behave as expected.
    if (TELEGRAM_THREAD_ID) {
      options.replyTo = Number(TELEGRAM_THREAD_ID);
    }

    const sent = await waitFor(
      client.sendMessage(peer, options),
      tgSendTimeoutMs,
      "tg-user-send-timeout",
    );

    const sentId = Number(sent?.id || 0);
    return sentId || null;
  } catch (err) {
    console.log("Telegram user api send failed:", err?.message || err);
    return null;
  }
}

const STRINGS = {
  de: {
    greetings: [
      "Hi, ich bin CLAWINAMETOKEN. Was möchtest du fragen?",
      "Was möchtest du fragen?",
      "Was denn hier los?",
      "Ja? CLAWINAMETOKEN hier.",
      "Hier CLAWINAMETOKEN, wie kann ich helfen?",
    ],
    noReply: "Ich habe keine Antwort erhalten.",
    noSend: "Ich konnte die Nachricht nicht an Telegram schicken.",
    notUnderstood: "Ich habe deine Frage nicht verstanden.",
    noLastReply: "Ich habe noch keine letzte Antwort gefunden.",
    lastReplyPrefix: "Die letzte Antwort war:",
    askAgain: "Möchtest du noch etwas wissen?",
    fallback:
      "Das habe ich leider nicht verstanden. Versuch es mit: Frage, gefolgt von deiner Frage.",
    help: "Sprich einfach frei nach dem Start. Oder sag: Was war die letzte Antwort?",
    bye: "Bis bald.",
    error: "Sorry, da ist etwas schiefgelaufen.",
    errorReprompt: "Bitte versuch es erneut.",
    telegramMsg: (query) =>
      `🎤 Alexa: ${query}\n↩️ Bitte antworte direkt auf diese Nachricht. Antworte nur mit Text, der für die Sprachausgabe durch Alexa optimiert ist: keine Emojis, Sonderzeichen, Klammern, Markdown oder Aufzählungszeichen. Schreibe in vollständigen, natürlichen Sätzen.`,
  },
  en: {
    greetings: [
      "Hi, I'm CLAWINAMETOKEN. What would you like to ask?",
      "What would you like to ask?",
      "Yes? CLAWINAMETOKEN here.",
      "CLAWINAMETOKEN here, how can I help?",
    ],
    noReply: "I didn't receive a reply.",
    noSend: "I couldn't send the message to Telegram.",
    notUnderstood: "I didn't understand your question.",
    noLastReply: "I don't have a last reply yet.",
    lastReplyPrefix: "The last reply was:",
    askAgain: "Would you like to ask something else?",
    fallback:
      "Sorry, I didn't get that. Try saying: ask, followed by your question.",
    help: "Just speak freely after the skill starts. Or say: what was the last answer?",
    bye: "Goodbye.",
    error: "Sorry, something went wrong.",
    errorReprompt: "Please try again.",
    telegramMsg: (query) =>
      `🎤 Alexa: ${query}\n↩️ Please reply directly to this message. Reply with text optimized for Alexa text-to-speech: no emojis, special characters, brackets, markdown or bullet points. Write in complete, natural sentences.`,
  },
};

function t(handlerInput) {
  const locale = handlerInput.requestEnvelope?.request?.locale || "de-DE";
  return locale.startsWith("en") ? STRINGS.en : STRINGS.de;
}

function elicitQueryDirective() {
  return {
    type: "Dialog.ElicitSlot",
    slotToElicit: "query",
    updatedIntent: {
      name: "ChatIntent",
      confirmationStatus: "NONE",
      slots: {
        query: { name: "query", value: "", confirmationStatus: "NONE" },
      },
    },
  };
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "LaunchRequest"
    );
  },
  handle(handlerInput) {
    const strings = t(handlerInput);
    const greeting =
      strings.greetings[Math.floor(Math.random() * strings.greetings.length)];
    return handlerInput.responseBuilder
      .speak(toAlexaSpeech(greeting, handlerInput))
      .addDirective(elicitQueryDirective())
      .getResponse();
  },
};

const ChatIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === "ChatIntent"
    );
  },
  async handle(handlerInput) {
    const query = Alexa.getSlotValue(handlerInput.requestEnvelope, "query");
    const strings = t(handlerInput);

    if (!query) {
      return handlerInput.responseBuilder
        .speak(toAlexaSpeech(strings.notUnderstood, handlerInput))
        .addDirective(elicitQueryDirective())
        .getResponse();
    }

    // send async to not wait
    if (useWaitingSound) {
      callDirectiveService(handlerInput, audioSpeech);
    }

    return handlerInput.responseBuilder
      .speak(
        toAlexaSpeech(
          await getResponseFromTelegram(
            handlerInput,
            strings,
            query,
          ),
          handlerInput,
        ),
      )
      .addDirective(elicitQueryDirective())
      .getResponse();
  },
};

const LastResponseIntentHandler = {
  canHandle(handlerInput) {
    if (Alexa.getRequestType(handlerInput.requestEnvelope) !== "IntentRequest")
      return false;
    const intent = Alexa.getIntentName(handlerInput.requestEnvelope);
    return intent === "LastResponseIntent" || intent === "AMAZON.RepeatIntent";
  },
  async handle(handlerInput) {
    const s = t(handlerInput);
    const local = getLast(handlerInput);
    const last = local ?? (await getLatestMessageViaUserApi());

    if (last?.reply ?? last?.text) {
      const replyText = last.reply ?? last.text;
      return handlerInput.responseBuilder
        .speak(
          toAlexaSpeech(
            `${s.lastReplyPrefix} ${cleanSpeech(replyText)}`,
            handlerInput,
          ),
        )
        .reprompt(s.askAgain)
        .withShouldEndSession(false)
        .getResponse();
    }

    return handlerInput.responseBuilder
      .speak(toAlexaSpeech(s.noLastReply, handlerInput))
      .reprompt(s.askAgain)
      .withShouldEndSession(false)
      .getResponse();
  },
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) ===
        "AMAZON.FallbackIntent"
    );
  },
  handle(handlerInput) {
    // Alexa's FallbackIntent does not provide the spoken text — no slot or
    // transcript is available here. Prompt the user to rephrase.
    const s = t(handlerInput);
    return handlerInput.responseBuilder
      .speak(toAlexaSpeech(s.fallback, handlerInput))
      .reprompt(s.askAgain)
      .withShouldEndSession(false)
      .getResponse();
  },
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === "AMAZON.HelpIntent"
    );
  },
  handle(handlerInput) {
    const s = t(handlerInput);
    return handlerInput.responseBuilder
      .speak(toAlexaSpeech(s.help, handlerInput))
      .reprompt(s.askAgain)
      .withShouldEndSession(false)
      .getResponse();
  },
};

const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      ["AMAZON.CancelIntent", "AMAZON.StopIntent"].includes(
        Alexa.getIntentName(handlerInput.requestEnvelope),
      )
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(toAlexaSpeech(t(handlerInput).bye, handlerInput))
      .withShouldEndSession(true)
      .getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) ===
      "SessionEndedRequest"
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.getResponse();
  },
};

const IntentReflectorHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest"
    );
  },
  handle(handlerInput) {
    const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
    return handlerInput.responseBuilder
      .speak(
        toAlexaSpeech(`Intent ${intentName} wurde ausgelöst.`, handlerInput),
      )
      .getResponse();
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error(`Error handled: ${error.message}`, error.stack);
    const s = t(handlerInput);
    return handlerInput.responseBuilder
      .speak(toAlexaSpeech(s.error, handlerInput))
      .reprompt(s.errorReprompt)
      .withShouldEndSession(false)
      .getResponse();
  },
};

function callDirectiveService(handlerInput, speechContent) {
  const { requestEnvelope, serviceClientFactory } = handlerInput;
  const directiveServiceClient =
    serviceClientFactory.getDirectiveServiceClient();
  const requestId = requestEnvelope.request.requestId;
  return directiveServiceClient.enqueue({
    header: { requestId },
    directive: { type: "VoicePlayer.Speak", speech: speechContent },
  });
}

const alexaHandler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    ChatIntentHandler,
    FallbackIntentHandler,
    LastResponseIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    SessionEndedRequestHandler,
    IntentReflectorHandler,
  )
  .addErrorHandlers(ErrorHandler)
  .withCustomUserAgent("alexa/telegram-openclaw-skill/v0.4.0")
  .withApiClient(new Alexa.DefaultApiClient())
  .withSkillId(ALEXA_SKILL_ID || undefined)
  .lambda();

// gramjs creates persistent MTProto receive loops and heartbeat timers that keep
// the Node.js event loop alive indefinitely. Without this, Lambda waits for the
// event loop to drain before returning the response, causing Alexa to time out.
// Node.js 24 Lambda no longer supports callback-based handler signatures, so we
// wrap the Alexa SDK's callback handler in a Promise.
export const handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  return new Promise((resolve, reject) => {
    alexaHandler(event, context, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
};
async function getResponseFromTelegram(
  handlerInput,
  strings,
  query,
) {
  // Append "?" so the Telegram bot always receives a clear question,
  // even when the Alexa trigger word was stripped (e.g. "stimmt es dass").
  const fullQuery = /[.?!]$/.test(query.trim())
    ? query.trim()
    : `${query.trim()}?`;

  let speakOutput = strings.noReply;

  try {
    const sentId = await sendViaTelegramUserApi(fullQuery, strings);
    if (sentId) {
      const settleMs = 1200; // wait for streaming bots that edit their message

      const client = await getTelegramUserClient();
      const picked = await new Promise((resolve) => {
        if (!client) {
          resolve(null);
          return;
        }

        let settleTimer = null;
        let latestText = "";
        let latestId = 0;

        const finish = (result) => {
          clearTimeout(settleTimer);
          clearTimeout(globalTimeout);
          client.removeEventHandler(onMsg, newMsgEvent);
          if (editMsgEvent) client.removeEventHandler(onMsg, editMsgEvent);
          resolve(result);
        };

        const globalTimeout = setTimeout(
          () => finish(latestId ? { id: latestId, text: latestText } : null),
          tgReplyWaitMs,
        );

        const onMsg = (event) => {
          // Raw fallback delivers the TL update directly; extract the message from it.
          const msg = isRawFallback
            ? (event.message ?? event.editMessage ?? null)
            : event.message;
          if (!msg || msg.out) return;
          if (Number(msg.id || 0) <= sentId) return;
          const text = String(msg.message || "").trim();
          if (!text || text.startsWith("🎤 Alexa:")) return;
          latestText = text;
          latestId = Number(msg.id);
          clearTimeout(settleTimer);
          settleTimer = setTimeout(
            () => finish({ id: latestId, text: latestText }),
            settleMs,
          );
        };

        client.addEventHandler(onMsg, newMsgEvent);
        if (editMsgEvent) client.addEventHandler(onMsg, editMsgEvent);
      });

      if (picked?.text) {
        speakOutput = cleanSpeech(picked.text);
        rememberLast(handlerInput, fullQuery, speakOutput);
      }
    } else {
      speakOutput = strings.noSend;
    }
  } catch (err) {
    console.log("[ChatIntent] send/wait failed:", err?.message || err);
  }

  return speakOutput;
}
