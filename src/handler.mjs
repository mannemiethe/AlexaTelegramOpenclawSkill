import Alexa from "ask-sdk-core";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

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
} = process.env;

// Best effort memory across warm Lambda invokes per user.
const lastByUser = new Map();
let telegramUserClient = null;
let telegramUserEntity = null;

function cleanSpeech(text) {
  if (!text) return "Ich habe gerade keine Antwort erhalten.";
  return String(text)
    .replace(/[\u0000-\u001F]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ")
    .replace(/[`*_~#>|\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    console.log(
      "[TG_DEBUG] user client skipped: missing credentials",
      JSON.stringify({
        hasApiId: Boolean(TELEGRAM_API_ID),
        hasApiHash: Boolean(TELEGRAM_API_HASH),
        hasSession: Boolean(TELEGRAM_SESSION_STRING),
      }),
    );
    return null;
  }

  if (!Number.isFinite(apiId) || apiId <= 0) {
    console.log(
      "[TG_DEBUG] user client skipped: invalid TELEGRAM_API_ID",
      JSON.stringify({ raw: TELEGRAM_API_ID }),
    );
    return null;
  }

  if (telegramUserClient) {
    console.log("[TG_DEBUG] user client reuse");
    return telegramUserClient;
  }

  try {
    console.log(
      "[TG_DEBUG] user client init",
      JSON.stringify({
        apiId,
        sessionLen: TELEGRAM_SESSION_STRING.length,
        connectTimeoutMs: Number(TG_USER_CONNECT_TIMEOUT_MS),
      }),
    );

    telegramUserClient = new TelegramClient(
      new StringSession(TELEGRAM_SESSION_STRING.trim()),
      apiId,
      TELEGRAM_API_HASH.trim(),
      { connectionRetries: 2 },
    );

    await waitFor(
      telegramUserClient.connect(),
      Number(TG_USER_CONNECT_TIMEOUT_MS),
      "tg-connect-timeout",
    );

    console.log("[TG_DEBUG] user client connected");
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
    console.log("[TG_DEBUG] entity resolve skipped: no client");
    return null;
  }
  if (!TELEGRAM_CHAT_ID) {
    console.log("[TG_DEBUG] entity resolve skipped: TELEGRAM_CHAT_ID missing");
    return null;
  }
  if (telegramUserEntity) {
    console.log("[TG_DEBUG] entity reuse");
    return telegramUserEntity;
  }

  const raw = String(TELEGRAM_CHAT_ID).trim();
  const num = Number(raw);

  try {
    // Try numeric id first (e.g. -100...)
    if (Number.isFinite(num)) {
      console.log("[TG_DEBUG] entity resolve try numeric", JSON.stringify({ raw, num }));
      telegramUserEntity = await waitFor(
        client.getEntity(num),
        Number(TG_USER_READ_TIMEOUT_MS),
        "tg-entity-timeout-numeric",
      );
      console.log("[TG_DEBUG] entity resolve ok (numeric)");
      return telegramUserEntity;
    }

    // Fallback: username/string form
    console.log("[TG_DEBUG] entity resolve try string", JSON.stringify({ raw }));
    telegramUserEntity = await waitFor(
      client.getEntity(raw),
      Number(TG_USER_READ_TIMEOUT_MS),
      "tg-entity-timeout-string",
    );
    console.log("[TG_DEBUG] entity resolve ok (string)");
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
      Number(TG_USER_READ_TIMEOUT_MS),
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

async function sendProgressiveResponse(envelope, speech) {
  try {
    const directiveUrl = envelope?.context?.System?.apiEndpoint
      ? `${envelope.context.System.apiEndpoint}/v1/directives`
      : null;
    const token = envelope?.context?.System?.apiAccessToken;
    const requestId = envelope?.request?.requestId;

    if (!directiveUrl || !token || !requestId) return;

    await fetch(directiveUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        header: { requestId },
        directive: {
          type: "VoicePlayer.Speak",
          speech,
        },
      }),
    });
  } catch (err) {
    console.log(
      "Progressive response failed (non-fatal):",
      err?.message || err,
    );
  }
}

async function sendViaTelegramUserApi(query, userId) {
  const client = await getTelegramUserClient();
  if (!client) return null;

  const peer = await getTelegramUserEntity(client);
  if (!peer) return null;

  try {
    const msg = `🎤 Alexa: ${query}\n↩️ Bitte antworte direkt auf diese Nachricht, wenn Alexa es vorlesen soll.`;
    const options = { message: msg };

    // Warning: this only makes sense if TELEGRAM_THREAD_ID is actually a message id
    // that anchors the topic. If it's a forum topic id, this may not behave as expected.
    if (TELEGRAM_THREAD_ID) {
      options.replyTo = Number(TELEGRAM_THREAD_ID);
    }

    const sent = await waitFor(
      client.sendMessage(peer, options),
      Number(TG_USER_SEND_TIMEOUT_MS),
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
    noReply: "Ich habe keine Antwort erhalten.",
    noSend: "Ich konnte die Nachricht nicht an Telegram schicken.",
    notUnderstood: "Ich habe deine Frage nicht verstanden.",
    noLastReply: "Ich habe noch keine letzte Antwort gefunden.",
    lastReplyPrefix: "Die letzte Antwort war:",
    askAgain: "Möchtest du noch etwas wissen?",
    fallback: "Das habe ich leider nicht verstanden. Versuch es mit: Frage, gefolgt von deiner Frage.",
    help: "Sprich einfach frei nach dem Start. Oder sag: Was war die letzte Antwort?",
    bye: "Bis bald.",
    error: "Sorry, da ist etwas schiefgelaufen.",
    errorReprompt: "Bitte versuch es erneut.",
  },
  en: {
    noReply: "I didn't receive a reply.",
    noSend: "I couldn't send the message to Telegram.",
    notUnderstood: "I didn't understand your question.",
    noLastReply: "I don't have a last reply yet.",
    lastReplyPrefix: "The last reply was:",
    askAgain: "Would you like to ask something else?",
    fallback: "Sorry, I didn't get that. Try saying: ask, followed by your question.",
    help: "Just speak freely after the skill starts. Or say: what was the last answer?",
    bye: "Goodbye.",
    error: "Sorry, something went wrong.",
    errorReprompt: "Please try again.",
  },
};

function t(handlerInput) {
  const locale = handlerInput.requestEnvelope?.request?.locale || "de-DE";
  return locale.startsWith("en") ? STRINGS.en : STRINGS.de;
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "LaunchRequest"
    );
  },
  handle(handlerInput) {
    // Dialog.Delegate cannot be combined with speak().
    // The Elicitation prompt ("Was möchtest du fragen?") is spoken by Alexa automatically.
    return handlerInput.responseBuilder
      .addDirective({
        type: "Dialog.Delegate",
        updatedIntent: {
          name: "ChatIntent",
          confirmationStatus: "NONE",
          slots: {
            query: {
              name: "query",
              value: "",
              confirmationStatus: "NONE",
            },
          },
        },
      })
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
    const userId = getUserId(handlerInput.requestEnvelope);

    if (!query) {
      return handlerInput.responseBuilder
        .speak(t(handlerInput).notUnderstood)
        .addDirective({
          type: "Dialog.ElicitSlot",
          slotToElicit: "query",
          updatedIntent: {
            name: "ChatIntent",
            confirmationStatus: "NONE",
            slots: {
              query: { name: "query", value: "", confirmationStatus: "NONE" },
            },
          },
        })
        .getResponse();
    }

    // Append "?" so the Telegram bot always receives a clear question,
    // even when the Alexa trigger word was stripped (e.g. "stimmt es dass").
    const fullQuery = /[.?!]$/.test(query.trim()) ? query.trim() : `${query.trim()}?`;

    let speakOutput = t(handlerInput).noReply;

    try {
      const sentId = await sendViaTelegramUserApi(fullQuery, userId);
      if (sentId) {
        const waitMs = Number(TG_REPLY_WAIT_MS);
        const start = Date.now();
        const settleMs = 1800; // wait until the same reply text stops changing

        let picked = null;
        let lastSeenReplyId = null;
        let lastSeenText = "";
        let lastChangeAt = 0;

        while (Date.now() - start < waitMs) {
          await sleep(500);
          const reply = await getLatestMessageViaUserApi();
          if (!reply?.id || reply.id <= sentId) continue;

          if (lastSeenReplyId !== reply.id) {
            lastSeenReplyId = reply.id;
            lastSeenText = reply.text || "";
            lastChangeAt = Date.now();
            picked = reply;
            continue;
          }

          if ((reply.text || "") !== lastSeenText) {
            lastSeenText = reply.text || "";
            lastChangeAt = Date.now();
            picked = reply;
            continue;
          }

          if (Date.now() - lastChangeAt >= settleMs) {
            picked = reply;
            break;
          }
        }

        if (picked?.text) {
          speakOutput = cleanSpeech(picked.text);
          rememberLast(handlerInput, fullQuery, speakOutput);
        }
      } else {
        speakOutput = t(handlerInput).noSend;
      }
    } catch (err) {
      console.log("[ChatIntent] send/wait failed:", err?.message || err);
    }

    return handlerInput.responseBuilder
      .speak(speakOutput)
      .addDirective({
        type: "Dialog.ElicitSlot",
        slotToElicit: "query",
        updatedIntent: {
          name: "ChatIntent",
          confirmationStatus: "NONE",
          slots: {
            query: {
              name: "query",
              value: "",
              confirmationStatus: "NONE",
            },
          },
        },
      })
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
    const last = getLast(handlerInput);

    const s = t(handlerInput);
    if (last?.reply) {
      return handlerInput.responseBuilder
        .speak(`${s.lastReplyPrefix} ${cleanSpeech(last.reply)}`)
        .reprompt(s.askAgain)
        .withShouldEndSession(false)
        .getResponse();
    }

    return handlerInput.responseBuilder
      .speak(s.noLastReply)
      .reprompt(s.askAgain)
      .withShouldEndSession(false)
      .getResponse();
  },
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === "AMAZON.FallbackIntent"
    );
  },
  handle(handlerInput) {
    // Alexa's FallbackIntent does not provide the spoken text — no slot or
    // transcript is available here. Prompt the user to rephrase.
    const s = t(handlerInput);
    return handlerInput.responseBuilder
      .speak(s.fallback)
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
      .speak(s.help)
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
      .speak(t(handlerInput).bye)
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
    console.log("Session ended:", JSON.stringify(handlerInput.requestEnvelope));
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
      .speak(`Intent ${intentName} wurde ausgelöst.`)
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
      .speak(s.error)
      .reprompt(s.errorReprompt)
      .withShouldEndSession(false)
      .getResponse();
  },
};

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
  .withSkillId(ALEXA_SKILL_ID || undefined)
  .lambda();

// gramjs creates persistent MTProto receive loops and heartbeat timers that keep
// the Node.js event loop alive indefinitely. Without this, Lambda waits for the
// event loop to drain before returning the response, causing Alexa to time out.
export const handler = (event, context, callback) => {
  context.callbackWaitsForEmptyEventLoop = false;
  return alexaHandler(event, context, callback);
};
