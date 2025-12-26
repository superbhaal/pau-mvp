require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const axios = require('axios');

const app = express().use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === 'pau_secure_2025') {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const msg = body.entry[0].changes[0].value.messages[0];
      const from = msg.from;
      const text = msg.text.body;
      try {
        await handleUserMessage(from, text);
      } catch (err) {
        console.error("Erreur:", err);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

async function handleUserMessage(whatsappId, text) {
  const channelRes = await pool.query(
    'SELECT pau_id FROM user_channels WHERE channel_type = $1 AND channel_value = $2',
    ['whatsapp', whatsappId]
  );

  if (channelRes.rows.length === 0) {
    const userRes = await pool.query(
      'INSERT INTO users (current_state, onboarding_step) VALUES ($1, $2) RETURNING pau_id',
      ['onboarding', 'name']
    );
    const newPauId = userRes.rows[0].pau_id;
    await pool.query(
      'INSERT INTO user_channels (pau_id, channel_type, channel_value) VALUES ($1, $2, $3)',
      [newPauId, 'whatsapp', whatsappId]
    );
    await sendWhatsApp(whatsappId, "Bonjour, je suis PAU. C’est la première fois que tu me contactes. Comment t’appelles-tu ?");
  } else {
    const pauId = channelRes.rows[0].pau_id;
    const user = (await pool.query('SELECT * FROM users WHERE pau_id = $1', [pauId])).rows[0];
    if (user.current_state === 'onboarding') {
      await processOnboarding(user, text, whatsappId);
    } else {
      await sendWhatsApp(whatsappId, "Bonjour " + user.first_name + ", je suis ton assistant PAU. (Le mode IA arrive !)");
    }
  }
}

async function processOnboarding(user, text, whatsappId) {
    switch (user.onboarding_step) {
        case 'name':
            await pool.query('UPDATE users SET first_name = $1, onboarding_step = $2 WHERE pau_id = $3', [text, 'insta', user.pau_id]);
            await sendWhatsApp(whatsappId, "Enchanté " + text + " ! Quel est ton identifiant Instagram ?");
            break;
        case 'insta':
            await pool.query('UPDATE users SET instagram_id = $1, onboarding_step = $2 WHERE pau_id = $3', [text, 'email', user.pau_id]);
            await sendWhatsApp(whatsappId, "C'est noté. Et ton adresse email ?");
            break;
        case 'email':
            await pool.query('UPDATE users SET email = $1, current_state = $2, onboarding_step = $3 WHERE pau_id = $4', [text, 'chat', 'completed', user.pau_id]);
            await sendWhatsApp(whatsappId, "Merci ! Ton profil est complet. Je suis désormais ton assistant personnel.");
            break;
    }
}

async function sendWhatsApp(to, text) {
  try {
    await axios.post(
      "https://graph.facebook.com/v17.0/" + process.env.WHATSAPP_PHONE_NUMBER_ID + "/messages",
      { messaging_product: "whatsapp", to: to, text: { body: text } },
      { headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN } }
    );
  } catch (error) {
    console.error("Erreur d'envoi", error.response ? error.response.data : error);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("PAU en ligne sur le port " + PORT));
