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
  const missingSentence = missingRequired.length
    ? `Il manque : ${missingRequired.join(', ')}.`
    : `Les informations essentielles sont complètes. Tu peux proposer de compléter les canaux optionnels (${optionalList}) ou conclure l'onboarding.`;

  return `Tu es PAU, un assistant d'onboarding.
Contexte utilisateur: ${knownBits || 'aucune info pour le moment'}.
${missingSentence}
Objectif: collecte d'abord les informations essentielles (prénom, nom, email) puis propose, sans insister, d'ajouter les canaux optionnels (${optionalList}).
Garde un ton concis et professionnel, pose une seule question à la fois et confirme brièvement la réception des données.`;
};

const buildChatPrompt = (user) => {
  const identity = `Prénom: ${user.first_name || '?'}, Nom: ${user.last_name || '?'}, Email: ${user.email || '?'}, Instagram: ${user.instagram_id || '?'}, Facebook: ${user.facebook_id || '?'}, TikTok: ${user.tiktok_id || '?'}`;

  return `Tu es PAU, maintenant en mode agent. Réponds aux questions de l'utilisateur en t'appuyant sur le contexte connu.
Identité connue: ${identity}.
Utilise ces informations pour contextualiser tes réponses (ton, niveau de détail, exemples pertinents). Si une information optionnelle est manquante et pertinente, tu peux la demander en une phrase mais privilégie une réponse utile.`;
};

// 3. Webhook de vérification Meta
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

// 4. Réception des messages WhatsApp
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message?.text?.body) {
      const waId = message.from;
      const userMsg = message.text.body;

      // 4.a Récupération/initialisation utilisateur
      let { rows } = await pool.query('SELECT * FROM users WHERE whatsapp_id = $1', [waId]);
      let user = rows[0];
      if (!user) {
        const insertion = await pool.query(
          'INSERT INTO users (pau_id, whatsapp_id, first_name, current_state) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING *',
          [waId, 'Ami', 'homeboarding']
        );
        user = insertion.rows[0];
      } else if (!user.current_state) {
        await pool.query('UPDATE users SET current_state = $1 WHERE whatsapp_id = $2', ['homeboarding', waId]);
        user.current_state = 'homeboarding';
      }

      const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

      // 4.b Extraction d'informations utilisateur (homeboarding)
      const extractionPrompt = `Analyse ce message : "${userMsg}".
Si l'utilisateur fournit son prénom, nom, email, identifiant Instagram, compte Facebook ou TikTok, renvoie UNIQUEMENT un JSON clair :
{"first_name": "...", "last_name": "...", "email": "...", "instagram_id": "...", "facebook_id": "...", "tiktok_id": "..."}.
Si aucune donnée n'est présente, renvoie {}.`;

      const exRes = await axios.post(geminiUrl, { contents: [{ parts: [{ text: extractionPrompt }] }] });
      try {
        const rawJson = exRes.data.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/```json|```/g, '')?.trim();
        const data = rawJson ? JSON.parse(rawJson) : {};

        if (data.first_name) await pool.query('UPDATE users SET first_name = $1 WHERE whatsapp_id = $2', [data.first_name, waId]);
        if (data.last_name) {
          try {
            await pool.query('UPDATE users SET last_name = $1 WHERE whatsapp_id = $2', [data.last_name, waId]);
          } catch (_) {
            // La colonne last_name peut ne pas exister en base : on ignore silencieusement.
          }
        }
        if (data.email) await pool.query('UPDATE users SET email = $1 WHERE whatsapp_id = $2', [data.email, waId]);
        if (data.instagram_id) await pool.query('UPDATE users SET instagram_id = $1 WHERE whatsapp_id = $2', [data.instagram_id, waId]);
        if (data.facebook_id) await pool.query('UPDATE users SET facebook_id = $1 WHERE whatsapp_id = $2', [data.facebook_id, waId]);
        if (data.tiktok_id) await pool.query('UPDATE users SET tiktok_id = $1 WHERE whatsapp_id = $2', [data.tiktok_id, waId]);

        const refreshed = await pool.query('SELECT * FROM users WHERE whatsapp_id = $1', [waId]);
        user = refreshed.rows[0];
      } catch (parseError) {
        // Pas de données détectées ou JSON invalide, on passe au message.
      }

      // 4.c Sélection du mode (homeboarding vs chat)
      const missingRequired = getMissingRequiredFields(user);
      const missingOptional = OPTIONAL_CHANNELS.filter(({ key }) => !user[key]).map(({ label }) => label);

      let aiResponse;

      if (user.current_state === 'agent') {
        const chatPayload = {
          contents: [{ parts: [{ text: `${buildChatPrompt(user)}\n\nUtilisateur : ${userMsg}` }] }]
        };

        const geminiRes = await axios.post(geminiUrl, chatPayload);
        aiResponse = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || "Je n'ai pas compris, peux-tu reformuler ?";
      } else {
        // Homeboarding
        if (missingRequired.length > 0) {
          const chatPayload = {
            contents: [{ parts: [{ text: `${buildHomeboardingPrompt(user)}\n\nUtilisateur : ${userMsg}` }] }]
          };

          const geminiRes = await axios.post(geminiUrl, chatPayload);
          aiResponse = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || "Je n'ai pas compris, peux-tu reformuler ?";
          await pool.query('UPDATE users SET current_state = $1 WHERE whatsapp_id = $2', ['homeboarding', waId]);
          user.current_state = 'homeboarding';
        } else if (user.onboarding_step === 'awaiting_confirmation') {
          const normalized = userMsg.toLowerCase();
          const isPositive = /\b(oui|yes|ok|c'est bon|c est bon|valide|confirm)/.test(normalized);
          const isNegative = /\b(non|no|pas encore|attends)/.test(normalized);

          if (isPositive) {
            await pool.query('UPDATE users SET current_state = $1, onboarding_step = NULL WHERE whatsapp_id = $2', ['agent', waId]);
            user.current_state = 'agent';
            user.onboarding_step = null;
            aiResponse = "Parfait, j'ai validé ces informations et je passe en mode agent. Comment puis-je t'aider ?";
          } else if (isNegative) {
            aiResponse = "D'accord, indique-moi les corrections à apporter sur tes informations et je mettrai à jour avant de passer en mode agent.";
          } else {
            aiResponse = "Peux-tu confirmer si le récapitulatif est correct ? Réponds par oui pour valider ou précise ce qui doit être ajusté.";
          }
        } else if (user.onboarding_step !== 'optional_requested' && missingOptional.length > 0) {
          await pool.query('UPDATE users SET onboarding_step = $1 WHERE whatsapp_id = $2', ['optional_requested', waId]);
          user.onboarding_step = 'optional_requested';
          aiResponse = `J'ai toutes les infos essentielles. Si tu veux, tu peux partager aussi : ${missingOptional.join(', ')}.`;
        } else {
          await pool.query('UPDATE users SET onboarding_step = $1 WHERE whatsapp_id = $2', ['awaiting_confirmation', waId]);
          user.onboarding_step = 'awaiting_confirmation';
          const recap = [
            `Prénom: ${user.first_name || 'non fourni'}`,
            `Nom: ${user.last_name || 'non fourni'}`,
            `Email: ${user.email || 'non fourni'}`,
            `Instagram: ${user.instagram_id || 'non fourni'}`,
            `Facebook: ${user.facebook_id || 'non fourni'}`,
            `TikTok: ${user.tiktok_id || 'non fourni'}`
          ].join(' | ');
          aiResponse = `Voici les données que j'ai collectées : ${recap}. Est-ce correct ? Réponds oui pour valider et passer en mode agent.`;
        }
      }

      // 4.d Envoi de la réponse sur WhatsApp
      await axios.post(
        `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        { messaging_product: 'whatsapp', to: waId, text: { body: aiResponse } },
        { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
      );
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Erreur PAU:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`PAU Intelligent sur le port ${PORT}`));
