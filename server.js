const express = require('express');
const cors = require('cors');
const { PluggyClient } = require('pluggy-sdk');

const app = express();

// middlewares
app.use(cors());
app.use(express.json());

// rota de teste
app.get('/', (req, res) => {
  res.send('Servidor rodando 🚀');
});

// rota principal
app.post('/connect-token', async (req, res) => {
  try {
    const pluggy = new PluggyClient({
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
    });

    const { clientUserId } = req.body;

    if (!clientUserId) {
      return res.status(400).json({ error: 'clientUserId é obrigatório' });
    }

    const connectToken = await pluggy.createConnectToken(clientUserId);

    res.json({ accessToken: connectToken.accessToken });

  } catch (error) {
    console.error('Erro real:', error);
    res.status(500).json({ error: 'Erro ao gerar token' });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('Servidor rodando na porta ' + PORT);
});
