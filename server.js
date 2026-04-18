const express = require('express');
const { PluggyClient } = require('pluggy-sdk');

const app = express();
app.use(express.json());

app.post('/connect-token', async (req, res) => {
  try {
    const pluggy = new PluggyClient({
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
    });

    const { clientUserId } = req.body;

    const connectToken = await pluggy.createConnectToken(clientUserId);

    res.json({ accessToken: connectToken.accessToken });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao gerar token' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando'));
