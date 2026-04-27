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

const { MP_TOKEN, BRAPI_API_KEY, ALPHA_VANTAGE_API_KEY } = process.env;
let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 MP configurado");
}

// ========== COTAÇÕES ==========
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
      await supabase.from("cotacoes").upsert({ ticker, preco: info.preco, variacao: info.variacao || 0, atualizado_em: new Date() }, { onConflict: "ticker" });
    }
    console.log("🪙 Criptos atualizadas");
  } catch (e) {
    console.error("❌ CoinGecko:", e.response?.status, e.message);
    // Fallback: mantém últimos valores salvos
    console.log("⚠️ Usando últimos valores salvos para criptos.");
  }
}

async function atualizarAcoesBR() {
  if (!BRAPI_API_KEY) { console.warn("⚠️ BRAPI_API_KEY ausente"); return; }
  const tickers = ["PETR4", "VALE3", "ITUB4", "BBDC4", "ABEV3", "MGLU3", "BOVA11", "WEGE3"];
  for (const ticker of tickers) {
    try {
      const { data } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, { params: { token: BRAPI_API_KEY } });
      const result = data?.results?.[0];
      if (result?.regularMarketPrice) {
        await supabase.from("cotacoes").upsert({ ticker, preco: result.regularMarketPrice, variacao: result.regularMarketChangePercent || 0, atualizado_em: new Date() }, { onConflict: "ticker" });
      }
    } catch (e) { console.error(`❌ Brapi ${ticker}:`, e.response?.status, e.response?.data?.message || e.message); }
    await new Promise(r => setTimeout(r, 800)); // pausa maior
  }
  console.log("📈 Ações BR atualizadas");
}

async function atualizarAcoesInternacionais() {
  if (!ALPHA_VANTAGE_API_KEY) { console.warn("⚠️ ALPHA_VANTAGE_API_KEY ausente"); return; }
  const tickers = ["AAPL", "TSLA", "GOOGL", "AMZN", "MSFT"];
  for (const ticker of tickers) {
    try {
      const { data } = await axios.get("https://www.alphavantage.co/query", {
        params: { function: "GLOBAL_QUOTE", symbol: ticker, apikey: ALPHA_VANTAGE_API_KEY }
      });
      const quote = data?.["Global Quote"];
      if (quote?.["05. price"]) {
        const preco = parseFloat(quote["05. price"]);
        const variacao = parseFloat(quote["10. change percent"]?.replace("%", "")) || 0;
        await supabase.from("cotacoes").upsert({ ticker, preco, variacao, atualizado_em: new Date() }, { onConflict: "ticker" });
      }
    } catch (e) { console.error(`❌ Alpha Vantage ${ticker}:`, e.message); }
    await new Promise(r => setTimeout(r, 2000)); // Alpha Vantage 5/min
  }
  console.log("🌍 Ações internacionais atualizadas");
}

// Atualiza imediatamente e depois a cada 2 horas (para evitar 429)
atualizarCriptos(); atualizarAcoesBR(); atualizarAcoesInternacionais();
setInterval(() => { atualizarCriptos(); atualizarAcoesBR(); atualizarAcoesInternacionais(); }, 120 * 60 * 1000);

// ===== ROTAS =====
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
  const { data } = await supabase.from("transactions").select("*").eq("uid", req.user.uid).order("criado_em", { ascending: false });
  res.json(data || []);
});

app.post("/deposito", authMiddleware, async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "MP não configurado" });
    const { valor } = req.body;
    if (!valor || valor <= 0) return res.status(400).json({ erro: "Valor inválido" });
    const pagamento = await payment.create({ body: { transaction_amount: Number(valor), payment_method_id: "pix", payer: { email: "cliente@atlax.com" }, metadata: { uid: req.user.uid } } });
    const qr = pagamento.point_of_interaction?.transaction_data;
    if (!qr) return res.status(500).json({ erro: "QR não gerado" });
    res.json({ id: pagamento.id, qr_img: qr.qr_code_base64, copia_cola: qr.qr_code });
  } catch (err) { res.status(500).json({ erro: "Erro ao gerar PIX" }); }
});

app.get("/verificar-pagamento/:id", async (req, res) => {
  if (!payment) return res.status(500).json({ erro: "MP não configurado" });
  const pagamento = await payment.get({ id: req.params.id });
  let saldoAtualizado = null;
  if (pagamento.status === "approved") {
    const uid = pagamento.metadata?.uid; const valor = pagamento.transaction_amount;
    if (uid) {
      await supabase.from("usuarios").upsert({ id: uid, saldo: 0 }, { onConflict: "id" });
      const { data: u } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
      const novo = (u?.saldo ?? 0) + Number(valor);
      await supabase.from("usuarios").update({ saldo: novo }).eq("id", uid);
      await supabase.from("transactions").insert({ uid, tipo: "deposito", valor: Number(valor), status: "aprovado" });
      saldoAtualizado = novo;
    }
  }
  res.json({ status: pagamento.status, amount: pagamento.transaction_amount, saldo: saldoAtualizado });
});

app.post("/investir", authMiddleware, async (req, res) => {
  const { tipo, valor } = req.body; const uid = req.user.uid;
  if (!tipo || isNaN(valor) || Number(valor) <= 0) return res.status(400).json({ erro: "Valor inválido" });
  const { data, error } = await supabase.rpc("realizar_investimento", { p_uid: uid, p_tipo: tipo.toLowerCase().replace(/\s/g, ""), p_valor: Number(valor) });
  if (error) return res.status(500).json({ erro: "Erro no servidor: " + error.message });
  if (data?.erro) return res.status(400).json({ erro: data.erro });
  res.json({ ok: true, novo_saldo: data.novo_saldo });
});

app.post("/saque", authMiddleware, async (req, res) => { /* igual ao anterior */ });
app.post("/ia", authMiddleware, (req, res) => res.json({ resposta: "Você disse: " + req.body.mensagem }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
