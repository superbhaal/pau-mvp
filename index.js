const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(bodyParser.json());

// 1. CONFIGURATION DES FONDATIONS (BBD & IA)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-1.5-flash",
  apiVersion: 'v1' 
});

// PROMPT SYSTÈME : Définit la personnalité de PAU
const SYSTEM_PROMPT = `Tu es PAU, un assistant stratégique intelligent. 
Ton but est d'aider l'utilisateur à structurer ses idées. 
Sois concis, professionnel et utilise le prénom de l'utilisateur.`;

// 2. WEBHOOK POUR META (Vérification initiale)
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

// 3. RÉCEPTION ET TRAITEMENT DES MESSAGES
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message?.text?.body) {
      const waId = message.from; // Numéro WhatsApp
      const userMsg = message.text.body;

      // GOUVERNANCE : Liaison entre WhatsApp et l'UUID pau_id
      let { rows } = await pool.query('SELECT * FROM users WHERE whatsapp_id = $1', [waId]);
      let user = rows[0];

      if (!user) {
        // Création d'un nouvel utilisateur avec UUID natif Postgres
        const newUser = await pool.query(
          'INSERT INTO users (pau_id, whatsapp_id, first_name, step) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING *',
          [waId, 'Ami', 'onboarding']
        );
        user = newUser.rows[0];
      }

      // INTELLIGENCE : Génération de la réponse personnalisée via Gemini
      const chat = model.startChat({
        history: [
          { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
          { role: "model", parts: [{ text: "Compris. Je suis prêt." }] },
        ],
      });

      const result = await chat.sendMessage(`L'utilisateur s'appelle ${user.first_name}. Il dit : ${userMsg}`);
      const aiResponse = result.response.text();

      // PROTOCOLE : Envoi de la réponse via l'API Meta
      await axios.post(
        `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: waId,
          text: { body: aiResponse }
        },
        { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
      );
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Erreur Webhook PAU:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`PAU (Gemini Edition) en ligne sur le port ${PORT}`));