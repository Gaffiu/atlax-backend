// services/ai.js
const axios = require("axios");
const supabase = require("../supabase");

async function analisarUsuario(uid) {
  // Busca dados do usuário no Supabase
  const { data: usuario, error: errUsuario } = await supabase
    .from("usuarios")
    .select("*")
    .eq("id", uid)
    .single();

  if (errUsuario || !usuario) {
    return "Nenhum dado financeiro encontrado.";
  }

  // Busca transações recentes
  const { data: transacoes } = await supabase
    .from("transactions")
    .select("*")
    .eq("uid", uid)
    .order("criado_em", { ascending: false })
    .limit(20);

  const prompt = `
  Analise os dados financeiros do usuário:

  Saldo: R$ ${usuario.saldo || 0}
  Atlax Coins: ${usuario.atlax_coins || 0}

  Transações recentes (últimas ${transacoes?.length || 0}):
  ${JSON.stringify(transacoes || [])}

  Gere:
  - Uma análise financeira resumida
  - Sugestões personalizadas
  - Riscos identificados
  - Melhorias recomendadas
  Seja gentil e motivador.
  `;

  try {
    // 🔁 MODELO CORRIGIDO: gemini-2.5-flash (gratuito e funcional)
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    return response.data.candidates[0].content.parts[0].text;
  } catch (err) {
    console.error("Erro Gemini:", err.response?.data || err.message);
    return "Não foi possível realizar a análise no momento. Tente novamente mais tarde.";
  }
}

module.exports = { analisarUsuario };
