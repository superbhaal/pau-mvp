const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SYSTEM_PROMPT = `Tu es PAU, un assistant stratégique intelligent. 
Ton but est d'aider l'utilisateur à structurer ses idées. 
Sois concis, professionnel et utilise le prénom de l'utilisateur.`;

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

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message?.text?.body) {
      const waId = message.from;
      const userMsg = message.text.body;

      let { rows } = await pool.query('SELECT * FROM users WHERE whatsapp_id = $1', [waId]);
      let user = rows[0];

      if (!user) {
        const newUser = await pool.query(
          'INSERT INTO users (pau_id, whatsapp_id, first_name, step) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING *',
          [waId, 'Ami', 'onboarding']
        );
        user = newUser.rows[0];
      }

      // INTELLIGENCE : Appel à Gemini 2.0 Flash (modèle confirmé par ton compte)
      const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
      
      const geminiPayload = {
        contents: [{
          parts: [{
            text: `${SYSTEM_PROMPT}\n\nL'utilisateur s'appelle ${user.first_name}. Il dit : ${userMsg}`
          }]
        }]
      };

      const geminiRes = await axios.post(geminiUrl, geminiPayload);
      const aiResponse = geminiRes.data.candidates[0].content.parts[0].text;

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
app.listen(PORT, () => console.log(`PAU (Gemini 2.0) en ligne sur le port ${PORT}`));