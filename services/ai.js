const axios = require("axios");
const { db } = require("../firebase");

async function analisarUsuario(uid) {
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();

  const transacoesSnap = await db
    .collection("transactions")
    .where("uid", "==", uid)
    .get();

  const transacoes = transacoesSnap.docs.map(doc => doc.data());
  const userData = userDoc.data();

  const prompt = `
  Analise os dados financeiros:

  Saldo: ${userData.saldo}

  Investimentos:
  ${JSON.stringify(userData.investimentos)}

  Transações:
  ${JSON.stringify(transacoes.slice(0, 20))}

  Gere:
  - análise financeira
  - sugestões
  - riscos
  - melhorias
  `;

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ]
    }
  );

  return response.data.candidates[0].content.parts[0].text;
}

module.exports = { analisarUsuario };
