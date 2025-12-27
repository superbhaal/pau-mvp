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

// 2. Construction des prompts
const buildHomeboardingPrompt = (user) => {
  const missingFields = [];
  if (!user.first_name) missingFields.push('prénom');
  if (!user.last_name) missingFields.push('nom');
  if (!user.email) missingFields.push('email');
  if (!user.instagram_id) missingFields.push('identifiant Instagram');

  const knownBits = [
    user.first_name ? `Prénom: ${user.first_name}` : null,
    user.last_name ? `Nom: ${user.last_name}` : null,
    user.email ? `Email: ${user.email}` : null,
    user.instagram_id ? `Instagram: ${user.instagram_id}` : null
  ].filter(Boolean).join(' | ');

  const missingSentence = missingFields.length
    ? `Il manque : ${missingFields.join(', ')}.`
    : 'Toutes les informations clés sont connues.';

  return `Tu es PAU, un assistant d'onboarding.
Contexte utilisateur: ${knownBits || 'aucune info pour le moment'}.
${missingSentence}
Objectif: récolte chaque information manquante une par une (dans l'ordre prénom, nom, email, Instagram), vérifie l'orthographe et reformule si besoin. Pose des questions courtes et professionnelles.`;
};

const buildChatPrompt = (user) => {
  const identity = `Prénom: ${user.first_name || '?'}, Nom: ${user.last_name || '?'}, Email: ${user.email || '?'}, Instagram: ${user.instagram_id || '?'}`;

  return `Tu es PAU, un assistant stratégique qui répond aux questions utilisateur.
Identité connue: ${identity}.
Utilise ces informations pour contextualiser tes réponses (ton, niveau de détail, exemples pertinents). Si une information est manquante, tu peux gentiment la demander mais privilégie une réponse utile.`;
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
          'INSERT INTO users (pau_id, whatsapp_id, first_name) VALUES (gen_random_uuid(), $1, $2) RETURNING *',
          [waId, 'Ami']
        );
        user = insertion.rows[0];
      }

      const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

      // 4.b Extraction d'informations utilisateur (homeboarding)
      const extractionPrompt = `Analyse ce message : "${userMsg}".
Si l'utilisateur fournit son prénom, nom, email ou identifiant Instagram, renvoie UNIQUEMENT un JSON clair :
{"first_name": "...", "last_name": "...", "email": "...", "instagram_id": "..."}.
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

        const refreshed = await pool.query('SELECT * FROM users WHERE whatsapp_id = $1', [waId]);
        user = refreshed.rows[0];
      } catch (parseError) {
        // Pas de données détectées ou JSON invalide, on passe au message.
      }

      // 4.c Sélection du mode (homeboarding vs chat)
      const needsHomeboarding = !user.first_name || !user.email || !user.instagram_id || !user.last_name;
      const promptBuilder = needsHomeboarding ? buildHomeboardingPrompt : buildChatPrompt;

      const chatPayload = {
        contents: [{ parts: [{ text: `${promptBuilder(user)}\n\nUtilisateur : ${userMsg}` }] }]
      };

      const geminiRes = await axios.post(geminiUrl, chatPayload);
      const aiResponse = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || "Je n'ai pas compris, peux-tu reformuler ?";

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
