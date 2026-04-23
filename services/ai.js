const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function gerarRecomendacao(userData) {
  const prompt = `
  Usuário possui:
  Saldo: ${userData.saldo}
  Investimentos: ${JSON.stringify(userData.investimentos)}

  Dê recomendações financeiras inteligentes.
  `;

  const response = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: [{ role: "user", content: prompt }]
  });

  return response.choices[0].message.content;
}

module.exports = { gerarRecomendacao };
