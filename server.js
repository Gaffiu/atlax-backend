const express = require('express');
const cors = require('cors');

const app = express();

// 🔥 LIBERA TUDO (modo simples)
app.use(cors());

app.use(express.json());
const express = require('express');
const { PluggyClient } = require('pluggy-sdk');

const app = express();
app.use(express.json());

// rota pra testar no navegador
app.get('/', (req, res) => {
  res.send('Servidor rodando 🚀');
});

// 🔥 ROTA PRINCIPAL (IMPORTANTE)
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
app.listen(PORT, () => {
  console.log('Servidor rodando na porta ' + PORT);
});
