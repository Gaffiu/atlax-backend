const axios = require("axios");
const { db } = require("../firebase");

async function analisarUsuario(uid) {
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    return "Nenhum dado financeiro encontrado.";
  }

  const transacoesSnap = await db
    .collection("transactions")
    .where("uid", "==", uid)
    .get();

  const transacoes = transacoesSnap.docs.map(doc => doc.data());
  const userData = userDoc.data();

  const prompt = `
  Analise os dados financeiros do usuário:

  Saldo: R$ ${userData.saldo}

  Investimentos:
  ${JSON.stringify(userData.investimentos)}

  Transações recentes (últimas 20):
  ${JSON.stringify(transacoes.slice(0, 20))}

  Gere:
  - Uma análise financeira resumida
  - Sugestões personalizadas
  - Riscos identificados
  - Melhorias recomendadas
  Seja gentil e motivador.
  `;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      }
    );
    return response.data.candidates[0].content.parts[0].text;
  } catch (err) {
    console.error("Erro Gemini:", err);
    return "Não foi possível realizar a análise no momento. Tente novamente mais tarde.";
  }
}

module.exports = { analisarUsuario };
