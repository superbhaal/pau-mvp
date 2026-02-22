const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.json());

// 1. Base de données
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 2. Construction des prompts et règles d'onboarding
const REQUIRED_FIELDS = [
  { key: 'first_name', label: 'prénom' },
  { key: 'last_name', label: 'nom' },
  { key: 'email', label: 'email' }
];

const OPTIONAL_CHANNELS = [
  { key: 'instagram_id', label: "identifiant Instagram" },
  { key: 'facebook_id', label: 'compte Facebook' },
  { key: 'tiktok_id', label: 'compte TikTok' }
];

const LANGUAGE_LABELS = {
  fr: 'français',
  en: 'anglais',
  es: 'espagnol',
  de: 'allemand',
  it: 'italien',
  pt: 'portugais'
};

const getLanguageCode = (user) => user.language || 'fr';
const getLanguageLabel = (user) => LANGUAGE_LABELS[getLanguageCode(user)] || getLanguageCode(user);
const localize = (languageCode, translations) =>
  translations[languageCode] || translations.fr || translations.en || translations.default || Object.values(translations)[0];

const getMissingRequiredFields = (user) =>
  REQUIRED_FIELDS.filter(({ key }) => !user[key]).map(({ label }) => label);

const buildHomeboardingPrompt = (user) => {
  const missingRequired = getMissingRequiredFields(user);
  const knownBits = [
    user.first_name ? `Prénom: ${user.first_name}` : null,
    user.last_name ? `Nom: ${user.last_name}` : null,
    user.email ? `Email: ${user.email}` : null,
    user.instagram_id ? `Instagram: ${user.instagram_id}` : null,
    user.facebook_id ? `Facebook: ${user.facebook_id}` : null,
    user.tiktok_id ? `TikTok: ${user.tiktok_id}` : null
  ].filter(Boolean).join(' | ');

  const optionalList = OPTIONAL_CHANNELS.map(({ label }) => label).join(', ');
  const languageLabel = getLanguageLabel(user);
  const missingSentence = missingRequired.length
    ? `Il manque : ${missingRequired.join(', ')}.`
    : `Les informations essentielles sont complètes. Tu peux proposer de compléter les canaux optionnels (${optionalList}) ou conclure l'onboarding.`;

  const introInstruction = user.introduction_done
    ? `Ne répète plus la présentation : passe directement à la prochaine question utile.`
    : `Commence par te présenter ("Je suis Pau, un agent IA personnel qui vous connait et dont vous pouvez maitriser les données qu'il a sur vous à tout moment, que vous pouvez contacter via différents canaux (email, whatsapp, messenger, instagram, etc...) et qui peut vous rendre des services personnalisés"), puis pose immédiatement la question équivalente à "Quel est ton prénom ?" dans la langue ${languageLabel}. Ensuite, ne redis plus cette présentation dans les messages suivants.`;

  return `Tu es PAU, un assistant d'onboarding. Tu réponds dans la langue ${languageLabel}.
Contexte utilisateur: ${knownBits || 'aucune info pour le moment'}.
${missingSentence}
Objectif: ${introInstruction}
Collecte d'abord les informations essentielles (prénom, nom, email) puis propose, sans insister, d'ajouter les canaux optionnels (${optionalList}).
Garde un ton concis et professionnel, pose une seule question à la fois et confirme brièvement la réception des données.`;
};

const buildChatPrompt = (user) => {
  const identity = `Prénom: ${user.first_name || '?'}, Nom: ${user.last_name || '?'}, Email: ${user.email || '?'}, Instagram: ${user.instagram_id || '?'}, Facebook: ${user.facebook_id || '?'}, TikTok: ${user.tiktok_id || '?'}`;
  const languageLabel = getLanguageLabel(user);

  return `Tu es PAU, maintenant en mode agent. Réponds dans la langue ${languageLabel}.
Identité connue: ${identity}.
Utilise ces informations pour contextualiser tes réponses (ton, niveau de détail, exemples pertinents). Si une information optionnelle est manquante et pertinente, tu peux la demander en une phrase mais privilégie une réponse utile.`;
};

// 3. Helpers d'envoi de messages par canal
const sendWhatsAppMessage = async (to, text) => {
  await axios.post(
    `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, text: { body: text } },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );
};

const sendInstagramMessage = async (recipientId, text) => {
  await axios.post(
    'https://graph.facebook.com/v21.0/me/messages',
    { recipient: { id: recipientId }, message: { text }, messaging_type: 'RESPONSE' },
    { headers: { Authorization: `Bearer ${process.env.INSTAGRAM_PAGE_TOKEN}` } }
  );
};

// 4. Logique de conversation commune (WhatsApp + Instagram)
// idColumn : colonne de lookup ('whatsapp_id' ou 'instagram_id')
// idValue  : valeur de l'identifiant (WAID ou PSID Instagram)
// sendReply: fonction (text) => Promise pour envoyer la réponse sur le bon canal
const processConversation = async (user, idColumn, idValue, userMsg, sendReply) => {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

  // 4.a Extraction d'informations utilisateur
  const extractionPrompt = `Analyse ce message : "${userMsg}".
Si l'utilisateur fournit son prénom, nom, email, identifiant Instagram, compte Facebook ou TikTok, renvoie UNIQUEMENT un JSON clair :
{"first_name": "...", "last_name": "...", "email": "...", "instagram_id": "...", "facebook_id": "...", "tiktok_id": "...", "language": "..."}.
Le champ "language" doit contenir le code ISO-639-1 détecté du message (ex: fr, en, es). Si tu n'es pas certain, renvoie null.
Si aucune donnée n'est présente, renvoie {}.`;

  const exRes = await axios.post(geminiUrl, { contents: [{ parts: [{ text: extractionPrompt }] }] });
  try {
    const rawJson = exRes.data.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g, '')?.trim();
    const data = rawJson ? JSON.parse(rawJson) : {};

    if (data.first_name) await pool.query(`UPDATE users SET first_name = $1 WHERE ${idColumn} = $2`, [data.first_name, idValue]);
    if (data.last_name) {
      try {
        await pool.query(`UPDATE users SET last_name = $1 WHERE ${idColumn} = $2`, [data.last_name, idValue]);
      } catch (_) {
        // La colonne last_name peut ne pas exister en base : on ignore silencieusement.
      }
    }
    if (data.email) await pool.query(`UPDATE users SET email = $1 WHERE ${idColumn} = $2`, [data.email, idValue]);
    // Ne pas écraser l'instagram_id (PSID) d'un utilisateur Instagram avec une valeur extraite du texte
    if (data.instagram_id && idColumn !== 'instagram_id') {
      await pool.query(`UPDATE users SET instagram_id = $1 WHERE ${idColumn} = $2`, [data.instagram_id, idValue]);
    }
    if (data.facebook_id) await pool.query(`UPDATE users SET facebook_id = $1 WHERE ${idColumn} = $2`, [data.facebook_id, idValue]);
    if (data.tiktok_id) await pool.query(`UPDATE users SET tiktok_id = $1 WHERE ${idColumn} = $2`, [data.tiktok_id, idValue]);
    if (data.language) {
      try {
        await pool.query(`UPDATE users SET language = $1 WHERE ${idColumn} = $2`, [data.language, idValue]);
      } catch (_) {
        // La colonne language peut ne pas exister en base : on ignore silencieusement.
      }
    }

    const refreshed = await pool.query(`SELECT * FROM users WHERE ${idColumn} = $1`, [idValue]);
    user = refreshed.rows[0];
  } catch (parseError) {
    // Pas de données détectées ou JSON invalide, on passe au message.
  }

  // 4.b Sélection du mode (homeboarding vs agent)
  const missingRequired = getMissingRequiredFields(user);
  const missingOptional = OPTIONAL_CHANNELS.filter(({ key }) => !user[key]).map(({ label }) => label);
  const languageCode = getLanguageCode(user);

  let aiResponse;

  if (user.current_state === 'agent') {
    const chatPayload = {
      contents: [{ parts: [{ text: `${buildChatPrompt(user)}\n\nUtilisateur : ${userMsg}` }] }]
    };

    const geminiRes = await axios.post(geminiUrl, chatPayload);
    aiResponse =
      geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text ||
      localize(languageCode, {
        fr: "Je n'ai pas compris, peux-tu reformuler ?",
        en: "I didn't understand, could you rephrase?"
      });
  } else {
    // Homeboarding
    if (missingRequired.length > 0) {
      const chatPayload = {
        contents: [{ parts: [{ text: `${buildHomeboardingPrompt(user)}\n\nUtilisateur : ${userMsg}` }] }]
      };

      const geminiRes = await axios.post(geminiUrl, chatPayload);
      aiResponse =
        geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text ||
        localize(languageCode, {
          fr: "Je n'ai pas compris, peux-tu reformuler ?",
          en: "I didn't understand, could you rephrase?"
        });
      await pool.query(`UPDATE users SET current_state = $1 WHERE ${idColumn} = $2`, ['homeboarding', idValue]);
      user.current_state = 'homeboarding';
    } else if (user.onboarding_step === 'awaiting_confirmation') {
      const normalized = userMsg.toLowerCase();
      const isPositive = /\b(oui|yes|ok|c'est bon|c est bon|valide|confirm)/.test(normalized);
      const isNegative = /\b(non|no|pas encore|attends)/.test(normalized);

      if (isPositive) {
        await pool.query(`UPDATE users SET current_state = $1, onboarding_step = NULL WHERE ${idColumn} = $2`, ['agent', idValue]);
        user.current_state = 'agent';
        user.onboarding_step = null;
        aiResponse = localize(languageCode, {
          fr: "Parfait, j'ai validé ces informations et je passe en mode agent. Comment puis-je t'aider ?",
          en: "Great, I've saved these details and I'm switching to agent mode. How can I help you?"
        });
      } else if (isNegative) {
        aiResponse = localize(languageCode, {
          fr: "D'accord, indique-moi les corrections à apporter sur tes informations et je mettrai à jour avant de passer en mode agent.",
          en: "Alright, tell me what needs to be corrected before I switch to agent mode."
        });
      } else {
        aiResponse = localize(languageCode, {
          fr: "Peux-tu confirmer si le récapitulatif est correct ? Réponds par oui pour valider ou précise ce qui doit être ajusté.",
          en: "Can you confirm if the summary is correct? Reply yes to validate or tell me what should be adjusted."
        });
      }
    } else if (user.onboarding_step !== 'optional_requested' && missingOptional.length > 0) {
      await pool.query(`UPDATE users SET onboarding_step = $1 WHERE ${idColumn} = $2`, ['optional_requested', idValue]);
      user.onboarding_step = 'optional_requested';
      aiResponse = localize(languageCode, {
        fr: `J'ai toutes les infos essentielles. Si tu veux, tu peux partager aussi : ${missingOptional.join(', ')}.`,
        en: `I have all the essential info. If you want, you can also share: ${missingOptional.join(', ')}.`
      });
    } else {
      await pool.query(`UPDATE users SET onboarding_step = $1 WHERE ${idColumn} = $2`, ['awaiting_confirmation', idValue]);
      user.onboarding_step = 'awaiting_confirmation';
      const recap = [
        `Prénom: ${user.first_name || 'non fourni'}`,
        `Nom: ${user.last_name || 'non fourni'}`,
        `Email: ${user.email || 'non fourni'}`,
        `Instagram: ${user.instagram_id || 'non fourni'}`,
        `Facebook: ${user.facebook_id || 'non fourni'}`,
        `TikTok: ${user.tiktok_id || 'non fourni'}`
      ].join(' | ');
      aiResponse = localize(languageCode, {
        fr: `Voici les données que j'ai collectées : ${recap}. Est-ce correct ? Réponds oui pour valider et passer en mode agent.`,
        en: `Here are the details I've collected: ${recap}. Is everything correct? Reply yes to validate so I can switch to agent mode.`
      });
    }
  }

  if (!user.introduction_done && user.current_state !== 'agent') {
    try {
      await pool.query(`UPDATE users SET introduction_done = TRUE WHERE ${idColumn} = $1`, [idValue]);
      user.introduction_done = true;
    } catch (_) {
      // La colonne introduction_done peut ne pas exister : ignorer silencieusement.
    }
  }

  await sendReply(aiResponse);
};

// 5. Webhook de vérification Meta (WhatsApp + Instagram partagent le même token)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === 'pau_secure_2025') {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 6. Réception des messages (WhatsApp + Instagram via le même endpoint Meta)
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'instagram') {
      // --- Messages Instagram DM ---
      const messaging = body.entry?.[0]?.messaging?.[0];

      // Ignorer les echos (messages envoyés par le bot lui-même)
      if (messaging?.message?.text && !messaging.message.is_echo) {
        const igPsid = messaging.sender.id;
        const userMsg = messaging.message.text;

        let { rows } = await pool.query('SELECT * FROM users WHERE instagram_id = $1', [igPsid]);
        let user = rows[0];
        if (!user) {
          const insertion = await pool.query(
            'INSERT INTO users (pau_id, instagram_id, current_state) VALUES (gen_random_uuid(), $1, $2) RETURNING *',
            [igPsid, 'homeboarding']
          );
          user = insertion.rows[0];
        } else if (!user.current_state) {
          await pool.query('UPDATE users SET current_state = $1 WHERE instagram_id = $2', ['homeboarding', igPsid]);
          user.current_state = 'homeboarding';
        }

        await processConversation(
          user,
          'instagram_id',
          igPsid,
          userMsg,
          (text) => sendInstagramMessage(igPsid, text)
        );
      }
    } else {
      // --- Messages WhatsApp ---
      const entry = req.body.entry?.[0];
      const changes = entry?.changes?.[0];
      const message = changes?.value?.messages?.[0];

      if (message?.text?.body) {
        const waId = message.from;
        const userMsg = message.text.body;

        let { rows } = await pool.query('SELECT * FROM users WHERE whatsapp_id = $1', [waId]);
        let user = rows[0];
        if (!user) {
          const insertion = await pool.query(
            'INSERT INTO users (pau_id, whatsapp_id, first_name, current_state, language) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING *',
            [waId, null, 'homeboarding', null]
          );
          user = insertion.rows[0];
        } else if (!user.current_state) {
          await pool.query('UPDATE users SET current_state = $1 WHERE whatsapp_id = $2', ['homeboarding', waId]);
          user.current_state = 'homeboarding';
        }

        await processConversation(
          user,
          'whatsapp_id',
          waId,
          userMsg,
          (text) => sendWhatsAppMessage(waId, text)
        );
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Erreur PAU:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`PAU Intelligent sur le port ${PORT}`));
