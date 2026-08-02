console.log("🔥 Iniciando servidor...");
process.on("uncaughtException", (err) => console.error("💥 Erro:", err));
process.on("unhandledRejection", (err) => console.error("💥 Promise:", err));

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const supabase = require("./supabase");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const authMiddleware = require("./middleware/auth");

const app = express();
app.use(cors());
app.use(express.json());

console.log("📌 Supabase:", process.env.SUPABASE_URL ? "configurado" : "NÃO configurado");

const { MP_TOKEN, BRAPI_API_KEY, ALPHA_VANTAGE_API_KEY, BELVO_SECRET_ID, BELVO_SECRET_PASSWORD } = process.env;

// --- Mercado Pago ---
let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 MP configurado");
}

// --- Cliente Belvo (ambiente Sandbox) ---
const BELVO_API_URL = "https://sandbox.belvo.com";
const BELVO_AUTH = BELVO_SECRET_ID && BELVO_SECRET_PASSWORD ? {
  auth: {
    username: BELVO_SECRET_ID,
    password: BELVO_SECRET_PASSWORD
  }
} : null;
if (BELVO_AUTH) {
  console.log("🔑 Belvo configurado (Sandbox)");
} else {
  console.warn("⚠️ Variáveis BELVO_SECRET_ID/BELVO_SECRET_PASSWORD não definidas. Rotas Belvo não funcionarão.");
}

// ========== ATUALIZAÇÃO DE COTAÇÕES (mantida) ==========
async function atualizarCriptos() {
  try {
    const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
      params: {
        ids: "bitcoin,ethereum,solana,binancecoin,ripple,cardano,polkadot",
        vs_currencies: "brl",
        include_24hr_change: "true"
      }
    });
    const precos = {
      BTC: { preco: data.bitcoin.brl, variacao: data.bitcoin.brl_24h_change },
      ETH: { preco: data.ethereum.brl, variacao: data.ethereum.brl_24h_change },
      SOL: { preco: data.solana.brl, variacao: data.solana.brl_24h_change },
      BNB: { preco: data.binancecoin.brl, variacao: data.binancecoin.brl_24h_change },
      XRP: { preco: data.ripple.brl, variacao: data.ripple.brl_24h_change },
      ADA: { preco: data.cardano.brl, variacao: data.cardano.brl_24h_change },
      DOT: { preco: data.polkadot.brl, variacao: data.polkadot.brl_24h_change }
    };
    for (const [ticker, info] of Object.entries(precos)) {
      await supabase.from("cotacoes").upsert({
        ticker,
        preco: info.preco,
        variacao: info.variacao || 0,
        atualizado_em: new Date()
      }, { onConflict: "ticker" });
    }
    console.log("🪙 Criptos atualizadas");
  } catch (e) {
    console.error("❌ CoinGecko:", e.response?.status, e.message);
  }
}

async function atualizarAcoesBR() {
  if (!BRAPI_API_KEY) { console.warn("⚠️ BRAPI_API_KEY ausente"); return; }
  const tickers = ["PETR4", "VALE3", "ITUB4", "BBDC4", "ABEV3", "MGLU3", "BOVA11", "WEGE3"];
  for (const ticker of tickers) {
    try {
      const { data } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, {
        params: { token: BRAPI_API_KEY }
      });
      const result = data?.results?.[0];
      if (result?.regularMarketPrice) {
        await supabase.from("cotacoes").upsert({
          ticker,
          preco: result.regularMarketPrice,
          variacao: result.regularMarketChangePercent || 0,
          atualizado_em: new Date()
        }, { onConflict: "ticker" });
      }
    } catch (e) {
      console.error(`❌ Brapi ${ticker}:`, e.response?.status, e.message);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  console.log("📈 Ações BR atualizadas");
}

async function atualizarAcoesInternacionais() {
  if (!ALPHA_VANTAGE_API_KEY) { console.warn("⚠️ ALPHA_VANTAGE_API_KEY ausente"); return; }
  const tickers = ["AAPL", "TSLA", "GOOGL", "AMZN", "MSFT"];
  for (const ticker of tickers) {
    try {
      const { data } = await axios.get("https://www.alphavantage.co/query", {
        params: {
          function: "GLOBAL_QUOTE",
          symbol: ticker,
          apikey: ALPHA_VANTAGE_API_KEY
        }
      });
      const quote = data?.["Global Quote"];
      if (quote?.["05. price"]) {
        const preco = parseFloat(quote["05. price"]);
        const variacao = parseFloat(quote["10. change percent"]?.replace("%", "")) || 0;
        await supabase.from("cotacoes").upsert({
          ticker,
          preco,
          variacao,
          atualizado_em: new Date()
        }, { onConflict: "ticker" });
      }
    } catch (e) {
      console.error(`❌ Alpha Vantage ${ticker}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log("🌍 Ações internacionais atualizadas");
}

atualizarCriptos(); atualizarAcoesBR(); atualizarAcoesInternacionais();
setInterval(() => { atualizarCriptos(); atualizarAcoesBR(); atualizarAcoesInternacionais(); }, 120 * 60 * 1000);

// ===== ROTAS ORIGINAIS (mantidas integralmente) =====
app.get("/", (_, res) => res.send("API Atlax 🚀"));

app.get("/cotacoes", async (_, res) => {
  const { data } = await supabase.from("cotacoes").select("*");
  const mapa = {};
  data.forEach(c => (mapa[c.ticker] = { preco: c.preco, variacao: c.variacao }));
  res.json(mapa);
});

app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("usuarios").select("saldo").eq("id", req.user.uid).single();
  res.json({ saldo: data?.saldo ?? 0 });
});

app.get("/extrato/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("transactions").select("*")
    .eq("uid", req.user.uid)
    .order("criado_em", { ascending: false });
  res.json(data || []);
});

app.post("/deposito", authMiddleware, async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "MP não configurado" });
    const { valor } = req.body;
    if (!valor || valor <= 0) return res.status(400).json({ erro: "Valor inválido" });
    const pagamento = await payment.create({
      body: {
        transaction_amount: Number(valor),
        payment_method_id: "pix",
        payer: { email: "cliente@atlax.com" },
        metadata: { uid: req.user.uid }
      }
    });
    const qr = pagamento.point_of_interaction?.transaction_data;
    if (!qr) return res.status(500).json({ erro: "QR não gerado" });
    res.json({ id: pagamento.id, qr_img: qr.qr_code_base64, copia_cola: qr.qr_code });
  } catch (err) {
    console.error("❌ Erro depósito:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "MP não configurado" });
    const pagamento = await payment.get({ id: req.params.id });
    let saldoAtualizado = null;
    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;
      if (uid) {
        await supabase.from("usuarios").upsert({ id: uid, saldo: 0 }, { onConflict: "id" });
        const { data: userAtual } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
        const novoSaldo = (userAtual?.saldo ?? 0) + Number(valor);
        await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
        await supabase.from("transactions").insert({ uid, tipo: "deposito", valor: Number(valor), status: "aprovado" });
        saldoAtualizado = novoSaldo;
      }
    }
    res.json({ status: pagamento.status, amount: pagamento.transaction_amount, saldo: saldoAtualizado });
  } catch (err) {
    console.error("❌ Erro verificar:", err.message);
    res.status(500).json({ erro: "Erro ao verificar" });
  }
});

app.post("/investir", authMiddleware, async (req, res) => {
  try {
    const { tipo, valor } = req.body;
    const uid = req.user.uid;
    if (!tipo || isNaN(valor) || Number(valor) <= 0) return res.status(400).json({ erro: "Valor inválido" });

    const { data, error } = await supabase.rpc("realizar_investimento", {
      p_uid: uid,
      p_tipo: tipo.toLowerCase().replace(/\s/g, ""),
      p_valor: Number(valor)
    });

    if (error) {
      console.error("❌ Erro RPC:", error);
      return res.status(500).json({ erro: "Erro no servidor: " + error.message });
    }
    if (data?.erro) return res.status(400).json({ erro: data.erro });
    res.json({ ok: true, novo_saldo: data.novo_saldo });
  } catch (err) {
    console.error("❌ Erro investir:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

app.post("/saque", authMiddleware, async (req, res) => {
  try {
    const { valor } = req.body;
    const uid = req.user.uid;
    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    if (!user || valor > (user.saldo ?? 0)) return res.status(400).json({ erro: "Saldo insuficiente" });
    const novoSaldo = user.saldo - Number(valor);
    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("transactions").insert({ uid, tipo: "saque", valor: Number(valor), status: "pendente" });
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ Erro saque:", e.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ===== ASSISTENTE IA (GEMINI) =====
const { analisarUsuario } = require("./services/ai");

app.post("/ia/analisar", authMiddleware, async (req, res) => {
  try {
    const analise = await analisarUsuario(req.user.uid);
    res.json({ resposta: analise });
  } catch (err) {
    console.error("❌ Erro ao analisar:", err.message);
    res.status(500).json({ resposta: "Não foi possível realizar a análise agora. Tente novamente." });
  }
});

app.post("/ia/perguntar", authMiddleware, async (req, res) => {
  try {
    const { mensagem } = req.body;
    if (!mensagem) return res.status(400).json({ resposta: "Digite uma pergunta." });

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: `Você é um assistente financeiro especializado. Responda de forma CURTA, DIRETA e RESUMIDA, no máximo 3 frases. Seja gentil e motivador. Pergunta do usuário: ${mensagem}` }] }]
      }
    );

    const texto = response.data.candidates[0].content.parts[0].text;
    res.json({ resposta: texto });
  } catch (err) {
    console.error("❌ Erro Gemini:", err.response?.data || err.message);
    res.json({ resposta: "Desculpe, ocorreu um erro ao processar sua pergunta. Tente novamente." });
  }
});

// ===== ATLAX COINS =====
app.get("/coins/:uid", authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from("usuarios")
      .select("atlax_coins")
      .eq("id", req.user.uid)
      .single();
    res.json({ coins: data?.atlax_coins || 0 });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar coins" });
  }
});

app.post("/coins/adicionar", authMiddleware, async (req, res) => {
  try {
    const { quantidade, motivo } = req.body;
    const uid = req.user.uid;
    const { data: user } = await supabase
      .from("usuarios")
      .select("atlax_coins")
      .eq("id", uid)
      .single();
    const saldoAtual = user?.atlax_coins || 0;
    const novoSaldo = saldoAtual + quantidade;
    await supabase
      .from("usuarios")
      .update({ atlax_coins: novoSaldo })
      .eq("id", uid);
    await supabase.from("transactions").insert({
      uid,
      tipo: "coins_ganhos",
      valor: quantidade,
      status: "aprovado",
      categoria: motivo || "checkin"
    });
    res.json({ coins: novoSaldo, ganhos: quantidade });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao adicionar coins" });
  }
});

app.post("/coins/resgatar", authMiddleware, async (req, res) => {
  try {
    const { quantidade } = req.body;
    const uid = req.user.uid;
    if (!quantidade || quantidade <= 0) {
      return res.status(400).json({ erro: "Quantidade inválida" });
    }
    const TAXA_CONVERSAO = 0.05;
    const { data, error } = await supabase.rpc("resgatar_atlax_coins", {
      p_uid: uid,
      p_coins: quantidade,
      p_taxa: TAXA_CONVERSAO
    });
    if (error) return res.status(500).json({ erro: error.message });
    if (data?.erro) return res.status(400).json({ erro: data.erro });
    res.json({
      ok: true,
      valor_creditado: quantidade * TAXA_CONVERSAO,
      novo_saldo: data.novo_saldo,
      coins_restantes: data.coins_restantes
    });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao resgatar" });
  }
});

// ===== CONTAS MANUAIS =====
app.post("/conta", authMiddleware, async (req, res) => {
  try {
    const { nome, saldo, item_id } = req.body;
    const uid = req.user.uid;
    await supabase.from("contas").insert({
      uid,
      nome,
      saldo: Number(saldo || 0),
      item_id: item_id || null,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get("/contas/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("contas").select("*").eq("uid", req.user.uid);
  res.json(data || []);
});

app.put("/conta/:id", authMiddleware, async (req, res) => {
  try {
    const { saldo } = req.body;
    const { id } = req.params;
    const { error } = await supabase.from("contas").update({ saldo: Number(saldo) }).eq("id", id).eq("uid", req.user.uid);
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ===== CARTÕES =====
app.post("/cartao", authMiddleware, async (req, res) => {
  try {
    const { descricao, valor, categoria } = req.body;
    const uid = req.user.uid;
    await supabase.from("cartoes").insert({
      uid,
      descricao,
      valor: Number(valor),
      categoria
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get("/cartoes/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("cartoes").select("*").eq("uid", req.user.uid).order("criado_em", { ascending: false });
  res.json(data || []);
});

// ===== BELVO - OPEN FINANCE =====
app.post("/belvo/connect-token", authMiddleware, async (req, res) => {
  if (!process.env.BELVO_SECRET_ID || !process.env.BELVO_SECRET_PASSWORD) {
    return res.status(500).json({ erro: "Belvo não configurado" });
  }
  try {
    const response = await axios.post(`${BELVO_API_URL}/api/token/`, {
      id: process.env.BELVO_SECRET_ID,
      password: process.env.BELVO_SECRET_PASSWORD,
      scopes: "read_institutions,write_links,read_links"
    }, { headers: { "Content-Type": "application/json" } });
    res.json({ accessToken: response.data.access });
  } catch (err) {
    console.error("❌ Erro Belvo Token:", err.response?.status);
    res.status(500).json({ erro: "Erro ao gerar token Belvo" });
  }
});

app.post("/webhook/belvo", async (req, res) => {
  const { webhook_type, data } = req.body;
  if (webhook_type === "links" && data?.link_id) {
    try {
      const linkResponse = await axios.get(`${BELVO_API_URL}/api/links/${data.link_id}/`, BELVO_AUTH);
      const institution = linkResponse.data.institution;
      await supabase.from("contas").insert({
        uid: data.user_id,
        nome: institution || "Banco Conectado",
        item_id: data.link_id,
        saldo: 0
      });
    } catch (err) {
      console.error("❌ Erro ao processar webhook:", err.message);
    }
  }
  res.status(200).send("OK");
});

app.get("/belvo/contas/:linkId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.status(500).json({ erro: "Belvo não configurado" });
  try {
    const response = await axios.get(`${BELVO_API_URL}/api/accounts/?link=${req.params.linkId}`, BELVO_AUTH);
    res.json(response.data.results);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar contas" });
  }
});

app.get("/belvo/transacoes/:linkId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.status(500).json({ erro: "Belvo não configurado" });
  try {
    const response = await axios.get(`${BELVO_API_URL}/api/transactions/?link=${req.params.linkId}`, BELVO_AUTH);
    res.json(response.data.results);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar transações" });
  }
});

app.get("/belvo/cartoes-contas/:linkId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.status(500).json({ erro: "Belvo não configurado" });
  try {
    const response = await axios.get(`${BELVO_API_URL}/api/accounts/?link=${req.params.linkId}`, BELVO_AUTH);
    const contasCredito = response.data.results.filter(acc => acc.category === "CREDIT_CARD");
    res.json({ encontradas: contasCredito.length > 0, cartoes: contasCredito });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar cartões" });
  }
});

app.get("/belvo/faturas/:linkId/:accountId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.status(500).json({ erro: "Belvo não configurado" });
  try {
    const { linkId, accountId } = req.params;
    const hoje = new Date().toISOString().split('T')[0];
    const mesPassado = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const response = await axios.get(`${BELVO_API_URL}/api/transactions/?link=${linkId}&account=${accountId}&date_from=${mesPassado}&date_to=${hoje}`, BELVO_AUTH);
    res.json(response.data.results);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar faturas" });
  }
});

// ===== NOTÍCIAS DO MERCADO =====
app.get("/noticias", async (req, res) => {
  if (!ALPHA_VANTAGE_API_KEY) return res.json([]);
  try {
    const response = await axios.get("https://www.alphavantage.co/query", {
      params: { function: "NEWS_SENTIMENT", topics: "finance, economy", apikey: ALPHA_VANTAGE_API_KEY }
    });
    const feed = response.data?.feed || [];
    res.json(feed.slice(0, 10).map(item => ({
      title: item.title,
      summary: item.summary,
      url: item.url,
      source: item.source
    })));
  } catch (err) {
    res.json([]);
  }
});

// ===== COFRE DO TEMPO =====
app.post("/cartas", authMiddleware, async (req, res) => {
  try {
    const { titulo, texto, data_abertura } = req.body;
    await supabase.from("cartas_tempo").insert({
      uid: req.user.uid, titulo, texto, data_abertura
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get("/cartas/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("cartas_tempo").select("*").eq("uid", req.user.uid).order("criada_em", { ascending: false });
  res.json(data || []);
});

// ===== PERFIL DO USUÁRIO =====
app.get("/perfil/:uid", authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase.from("usuarios").select("nome, email, telefone, foto, bio").eq("id", req.user.uid).single();
    res.json(data || { nome: "", email: "", telefone: "", foto: "", bio: "" });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.put("/perfil/:uid", authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { nome, email, telefone, foto, bio } = req.body;
    const updates = {};
    if (nome !== undefined) updates.nome = nome;
    if (email !== undefined) updates.email = email;
    if (telefone !== undefined) updates.telefone = telefone;
    if (foto !== undefined) updates.foto = foto;
    if (bio !== undefined) updates.bio = bio;
    if (Object.keys(updates).length === 0) return res.status(400).json({ erro: "Nenhum campo" });
    await supabase.from("usuarios").upsert({ id: uid }, { onConflict: "id" });
    const { error } = await supabase.from("usuarios").update(updates).eq("id", uid);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ===== NOVAS ROTAS DE FUNDOS =====
// Função auxiliar para obter preço atual (com fallback e múltiplas APIs)
async function obterPrecoAtual(ticker) {
  const precosFallback = {
    "TESOURO_SELIC": 100.00, "TESOURO_IPCA": 100.00,
    "CDB_110_CDI": 150.00, "CDB_120_CDI": 200.00,
    "LCI_90_CDI": 180.00, "LCA_92_CDI": 190.00,
    "CRI_IPCA": 500.00, "DEB_INFRA": 400.00,
    "HGLG11": 180.00, "KNRI11": 150.00, "MXRF11": 10.00,
    "XPLG11": 120.00, "VISC11": 110.00, "RECR11": 95.00,
    "FUNDO_ACOES_BLUE": 500.00, "FUNDO_SMALL_CAPS": 350.00,
    "FUNDO_DIVIDENDOS": 400.00, "FUNDO_TECH": 600.00,
    "FUNDO_ESG": 450.00, "FUNDO_MULTI_01": 300.00,
    "FUNDO_MULTI_02": 250.00, "FUNDO_MULTI_03": 400.00
  };

  try {
    const { data: brapiData } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, {
      params: { token: process.env.BRAPI_API_KEY }
    });
    if (brapiData?.results?.[0]?.regularMarketPrice) return brapiData.results[0].regularMarketPrice;
  } catch (e) {}

  try {
    const criptoMap = { "BITCOIN": "bitcoin", "ETHEREUM": "ethereum", "SOLANA": "solana" };
    const coinId = criptoMap[ticker];
    if (coinId) {
      const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
        params: { ids: coinId, vs_currencies: "brl" }
      });
      if (data[coinId]?.brl) return data[coinId].brl;
    }
  } catch (e) {}

  try {
    if (process.env.ALPHA_VANTAGE_API_KEY) {
      const { data: avData } = await axios.get("https://www.alphavantage.co/query", {
        params: { function: "GLOBAL_QUOTE", symbol: ticker, apikey: process.env.ALPHA_VANTAGE_API_KEY }
      });
      const quote = avData?.["Global Quote"];
      if (quote?.["05. price"]) return parseFloat(quote["05. price"]) * 5.10; // USD->BRL fixo
    }
  } catch (e) {}

  return precosFallback[ticker] || 100;
}

app.get("/fundos", async (req, res) => {
  const { data } = await supabase.from("fundos").select("*").eq("ativo", true);
  res.json(data || []);
});

app.post("/investir-fundo", authMiddleware, async (req, res) => {
  try {
    const { fundo_id, valor } = req.body;
    const uid = req.user.uid;
    if (!fundo_id || !valor || valor <= 0) return res.status(400).json({ erro: "Dados inválidos" });

    const { data: fundo } = await supabase.from("fundos").select("*").eq("id", fundo_id).single();
    if (!fundo) return res.status(404).json({ erro: "Fundo não encontrado" });

    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    if (!user || user.saldo < valor) return res.status(400).json({ erro: "Saldo insuficiente" });

    const valor_cota = await obterPrecoAtual(fundo.ticker);
    const cotas = valor / valor_cota;
    const novoSaldo = user.saldo - valor;

    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("investimentos").insert({
      uid, fundo_id, valor_aplicado: valor, cotas, valor_cota_entrada: valor_cota
    });
    await supabase.from("transactions").insert({
      uid, tipo: "investimento", valor, status: "aprovado", categoria: fundo.ticker
    });
    res.json({ ok: true, novo_saldo: novoSaldo });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno ao investir" });
  }
});

app.post("/resgatar-fundo", authMiddleware, async (req, res) => {
  try {
    const { investimento_id } = req.body;
    const uid = req.user.uid;
    const { data: inv } = await supabase.from("investimentos").select("*, fundos(*)").eq("id", investimento_id).eq("uid", uid).single();
    if (!inv || inv.status !== "ativo") return res.status(400).json({ erro: "Investimento não encontrado" });

    const valor_cota_atual = await obterPrecoAtual(inv.fundos.ticker);
    const valor_resgate = inv.cotas * valor_cota_atual;

    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    await supabase.from("usuarios").update({ saldo: user.saldo + valor_resgate }).eq("id", uid);
    await supabase.from("investimentos").update({ status: "resgatado", data_resgate: new Date() }).eq("id", investimento_id);
    await supabase.from("transactions").insert({ uid, tipo: "resgate", valor: valor_resgate, status: "aprovado" });

    res.json({ ok: true, valor_resgate });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno ao resgatar" });
  }
});

app.get("/carteira/:uid", authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase.from("investimentos").select("*, fundos(*)").eq("uid", req.user.uid).eq("status", "ativo");
    const carteira = await Promise.all(data.map(async (inv) => {
      const precoAtual = await obterPrecoAtual(inv.fundos.ticker);
      const valorAtual = inv.cotas * precoAtual;
      const rentabilidade = ((valorAtual - inv.valor_aplicado) / inv.valor_aplicado) * 100;
      return { ...inv, valor_atual: valorAtual, rentabilidade };
    }));
    res.json(carteira);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao carregar carteira" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
