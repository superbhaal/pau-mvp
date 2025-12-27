const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.json());

// 1. FONDATIONS : Base de données
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 2. LOGIQUE D'INTELLIGENCE : Prompt dynamique
const getSystemPrompt = (user) => {
  return `Tu es PAU, un assistant stratégique. Ton but est de compléter le profil utilisateur.
Infos actuelles : Prénom: ${user.first_name}, Email: ${user.email || '?'}, Insta: ${user.instagram_id || '?'}.
Règle : Demande l'info manquante dans l'ordre (Prénom -> Email -> Instagram). Sois pro et concis.`;
};

// 3. WEBHOOK META (Vérification)
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

// 4. RÉCEPTION ET TRAITEMENT
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message?.text?.body) {
      const waId = message.from;
      const userMsg = message.text.body;

      // GOUVERNANCE : Récupération ou création de l'utilisateur
      let { rows } = await pool.query('SELECT * FROM users WHERE whatsapp_id = $1', [waId]);
      let user = rows[0];
      if (!user) {
        const newUser = await pool.query(
          'INSERT INTO users (pau_id, whatsapp_id, first_name) VALUES (gen_random_uuid(), $1, $2) RETURNING *',
          [waId, 'Ami']
        );
        user = newUser.rows[0];
      }

      const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

      // ÉTAPE A : EXTRACTION DES DONNÉES (Clean Inputs)
      const extractionPrompt = `Analyse ce message : "${userMsg}". 
      Si l'utilisateur donne son prénom, email ou instagram, renvoie UNIQUEMENT un JSON : 
      {"first_name": "...", "email": "...", "instagram_id": "..."}. Sinon renvoie {}.`;
      
      const exRes = await axios.post(geminiUrl, { contents: [{ parts: [{ text: extractionPrompt }] }] });
      try {
        const rawJson = exRes.data.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim();
        const data = JSON.parse(rawJson);
        
        if (data.first_name) await pool.query('UPDATE users SET first_name = $1 WHERE whatsapp_id = $2', [data.first_name, waId]);
        if (data.email) await pool.query('UPDATE users SET email = $1 WHERE whatsapp_id = $2', [data.email, waId]);
        if (data.instagram_id) await pool.query('UPDATE users SET instagram_id = $1 WHERE whatsapp_id = $2', [data.instagram_id, waId]);
        
        // Rafraîchir les infos utilisateur après mise à jour
        const updated = await pool.query('SELECT * FROM users WHERE whatsapp_id = $1', [waId]);
        user = updated.rows[0];
      } catch (e) { /* Pas de données trouvées */ }

      // ÉTAPE B : GÉNÉRATION DE LA RÉPONSE
      const chatPayload = {
        contents: [{ parts: [{ text: `${getSystemPrompt(user)}\n\nUtilisateur : ${userMsg}` }] }]
      };
      const geminiRes = await axios.post(geminiUrl, chatPayload);
      const aiResponse = geminiRes.data.candidates[0].content.parts[0].text;

      // PROTOCOLE : Envoi WhatsApp
      await axios.post(
        `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        { messaging_product: "whatsapp", to: waId, text: { body: aiResponse } },
        { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
      );
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Erreur PAU:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`PAU Intelligent sur le port ${PORT}`));