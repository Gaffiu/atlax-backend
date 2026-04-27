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
      params: { ids: "bitcoin,ethereum,solana,binancecoin,ripple,cardano,polkadot", vs_currencies: "brl" }
    });
    const precos = { BTC: data.bitcoin.brl, ETH: data.ethereum.brl, SOL: data.solana.brl, BNB: data.binancecoin.brl, XRP: data.ripple.brl, ADA: data.cardano.brl, DOT: data.polkadot.brl };
    for (const [ticker, preco] of Object.entries(precos)) {
      await supabase.from("cotacoes").upsert({ ticker, preco, atualizado_em: new Date() }, { onConflict: "ticker" });
    }
    console.log("🪙 Criptos atualizadas");
  } catch (e) { console.error("❌ CoinGecko:", e.message); }
}

async function atualizarAcoesBR() {
  if (!BRAPI_API_KEY) return;
  const tickers = ["PETR4", "VALE3", "ITUB4", "BBDC4", "ABEV3", "MGLU3", "BOVA11", "WEGE3"];
  try {
    for (const ticker of tickers) {
      const { data } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, { params: { token: BRAPI_API_KEY } });
      const preco = data?.results?.[0]?.regularMarketPrice;
      if (preco) await supabase.from("cotacoes").upsert({ ticker, preco, atualizado_em: new Date() }, { onConflict: "ticker" });
      await new Promise(r => setTimeout(r, 500));
    }
    console.log("📈 Ações BR atualizadas");
  } catch (e) { console.error("❌ Brapi:", e.message); }
}

async function atualizarAcoesInternacionais() {
  if (!ALPHA_VANTAGE_API_KEY) return;
  const tickers = ["AAPL", "TSLA", "GOOGL", "AMZN", "MSFT"];
  try {
    for (const ticker of tickers) {
      const { data } = await axios.get("https://www.alphavantage.co/query", {
        params: { function: "GLOBAL_QUOTE", symbol: ticker, apikey: ALPHA_VANTAGE_API_KEY }
      });
      const preco = parseFloat(data?.["Global Quote"]?.["05. price"]);
      if (preco) await supabase.from("cotacoes").upsert({ ticker, preco, atualizado_em: new Date() }, { onConflict: "ticker" });
      await new Promise(r => setTimeout(r, 1200));
    }
    console.log("🌍 Ações internacionais atualizadas");
  } catch (e) { console.error("❌ Alpha Vantage:", e.message); }
}

atualizarCriptos(); atualizarAcoesBR(); atualizarAcoesInternacionais();
setInterval(() => { atualizarCriptos(); atualizarAcoesBR(); atualizarAcoesInternacionais(); }, 30 * 60 * 1000);

// ===== ROTAS =====
app.get("/", (_, res) => res.send("API Atlax 🚀"));
app.get("/cotacoes", async (_, res) => {
  const { data } = await supabase.from("cotacoes").select("*");
  const mapa = {}; data.forEach(c => mapa[c.ticker] = c.preco);
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
app.post("/deposito", authMiddleware, async (req, res) => { /* ... igual ao anterior ... */ });
app.get("/verificar-pagamento/:id", async (req, res) => { /* ... igual ao anterior ... */ });
app.post("/investir", authMiddleware, async (req, res) => {
  const { tipo, valor } = req.body;
  const uid = req.user.uid;
  if (!tipo || isNaN(valor) || Number(valor) <= 0) return res.status(400).json({ erro: "Valor inválido" });
  const { data, error } = await supabase.rpc("realizar_investimento", { p_uid: uid, p_tipo: tipo.toLowerCase().replace(/\s/g, ""), p_valor: Number(valor) });
  if (error) return res.status(500).json({ erro: "Erro interno" });
  if (data?.erro) return res.status(400).json({ erro: data.erro });
  res.json({ ok: true, novo_saldo: data.novo_saldo });
});
app.post("/saque", authMiddleware, async (req, res) => { /* ... igual ao anterior ... */ });
app.post("/ia", authMiddleware, (req, res) => res.json({ resposta: "Você disse: " + req.body.mensagem }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
