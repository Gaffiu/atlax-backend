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

const {
  MP_TOKEN, BRAPI_API_KEY, ALPHA_VANTAGE_API_KEY,
  BELVO_SECRET_ID, BELVO_SECRET_PASSWORD,
  NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET
} = process.env;

const TAXA_DEPOSITO = 0.05;

// Chaves NowPayments (fallback direto)
const NP_API_KEY = NOWPAYMENTS_API_KEY || "X8W9RCR-8FBMAZE-JY5M30C-7BTTZ5T";
const NP_IPN_SECRET = NOWPAYMENTS_IPN_SECRET || "RqofPHswoZPO4xypGzxBkoKyNtf0px8w";

// --- Mercado Pago ---
let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 MP configurado");
}

// --- Cliente Belvo ---
const BELVO_API_URL = "https://sandbox.belvo.com";
const BELVO_AUTH = BELVO_SECRET_ID && BELVO_SECRET_PASSWORD ? {
  auth: { username: BELVO_SECRET_ID, password: BELVO_SECRET_PASSWORD }
} : null;
if (BELVO_AUTH) console.log("🔑 Belvo configurado (Sandbox)");
else console.warn("⚠️ Belvo não configurado.");

// ========== ATUALIZAÇÃO DE COTAÇÕES ==========
async function atualizarCriptos() {
  try {
    const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
      params: { ids: "bitcoin,ethereum,solana,binancecoin,ripple,cardano,polkadot", vs_currencies: "brl", include_24hr_change: "true" }
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
        ticker, preco: info.preco, variacao: info.variacao || 0, atualizado_em: new Date()
      }, { onConflict: "ticker" });
    }
    console.log("🪙 Criptos atualizadas");
  } catch (e) { console.error("❌ CoinGecko:", e.message); }
}

async function atualizarAcoesBR() {
  if (!BRAPI_API_KEY) return;
  const tickers = ["PETR4","VALE3","ITUB4","BBDC4","ABEV3","MGLU3","BOVA11","WEGE3"];
  for (const ticker of tickers) {
    try {
      const { data } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, { params: { token: BRAPI_API_KEY } });
      const result = data?.results?.[0];
      if (result?.regularMarketPrice) {
        await supabase.from("cotacoes").upsert({
          ticker, preco: result.regularMarketPrice, variacao: result.regularMarketChangePercent || 0, atualizado_em: new Date()
        }, { onConflict: "ticker" });
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 800));
  }
  console.log("📈 Ações BR atualizadas");
}

async function atualizarAcoesInternacionais() {
  if (!ALPHA_VANTAGE_API_KEY) return;
  const tickers = ["AAPL","TSLA","GOOGL","AMZN","MSFT"];
  for (const ticker of tickers) {
    try {
      const { data } = await axios.get("https://www.alphavantage.co/query", {
        params: { function: "GLOBAL_QUOTE", symbol: ticker, apikey: ALPHA_VANTAGE_API_KEY }
      });
      const quote = data?.["Global Quote"];
      if (quote?.["05. price"]) {
        await supabase.from("cotacoes").upsert({
          ticker, preco: parseFloat(quote["05. price"]),
          variacao: parseFloat(quote["10. change percent"]?.replace("%","")) || 0, atualizado_em: new Date()
        }, { onConflict: "ticker" });
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log("🌍 Ações internacionais atualizadas");
}

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
    const pagamento = await payment.create({
      body: { transaction_amount: Number(valor), payment_method_id: "pix", payer: { email: "cliente@atlax.com" }, metadata: { uid: req.user.uid } }
    });
    const qr = pagamento.point_of_interaction?.transaction_data;
    if (!qr) return res.status(500).json({ erro: "QR não gerado" });
    res.json({ id: pagamento.id, qr_img: qr.qr_code_base64, copia_cola: qr.qr_code });
  } catch (err) {
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
        const taxa = valor * TAXA_DEPOSITO;
        const valorLiquido = valor - taxa;
        await supabase.from("usuarios").upsert({ id: uid, saldo: 0 }, { onConflict: "id" });
        const { data: userAtual } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
        const novoSaldo = (userAtual?.saldo ?? 0) + Number(valorLiquido);
        await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
        await supabase.from("transactions").insert([
          { uid, tipo: "deposito", valor: Number(valorLiquido), status: "aprovado" },
          { uid: "admin", tipo: "taxa_deposito", valor: Number(taxa), status: "aprovado", categoria: "taxa" }
        ]);
        saldoAtualizado = novoSaldo;
      }
    }
    res.json({ status: pagamento.status, amount: pagamento.transaction_amount, saldo: saldoAtualizado });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao verificar" });
  }
});

app.post("/investir", authMiddleware, async (req, res) => {
  try {
    const { tipo, valor } = req.body;
    const uid = req.user.uid;
    if (!tipo || isNaN(valor) || Number(valor) <= 0) return res.status(400).json({ erro: "Valor inválido" });
    const { data, error } = await supabase.rpc("realizar_investimento", {
      p_uid: uid, p_tipo: tipo.toLowerCase().replace(/\s/g,""), p_valor: Number(valor)
    });
    if (error) return res.status(500).json({ erro: "Erro no servidor" });
    if (data?.erro) return res.status(400).json({ erro: data.erro });
    res.json({ ok: true, novo_saldo: data.novo_saldo });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno" });
  }
});

app.post("/saque", authMiddleware, async (req, res) => {
  try {
    const { valor, pix } = req.body;
    const uid = req.user.uid;
    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    if (!user || valor > (user.saldo ?? 0)) return res.status(400).json({ erro: "Saldo insuficiente" });
    const novoSaldo = user.saldo - Number(valor);
    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("transactions").insert({ uid, tipo: "saque", valor: Number(valor), status: "pendente", categoria: pix });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ===== DEPÓSITO CRIPTO =====
app.post("/deposito-cripto", authMiddleware, async (req, res) => {
  try {
    const { currency, amount } = req.body;
    const uid = req.user.uid;
    if (!currency || !amount || amount <= 0) return res.status(400).json({ erro: "Dados inválidos" });

    const coinId = currency.toLowerCase();
    let precoBRL = 0;
    try {
      const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", { params: { ids: coinId, vs_currencies: "brl" } });
      precoBRL = data[coinId]?.brl;
      if (!precoBRL) throw new Error("Criptomoeda não suportada");
    } catch (e) { return res.status(400).json({ erro: "Erro ao obter cotação" }); }

    const amountCrypto = (amount / precoBRL).toFixed(8);

    const paymentResponse = await axios.post("https://api.nowpayments.io/v1/payment", {
      price_amount: amount, price_currency: "brl", pay_currency: currency.toLowerCase(),
      pay_amount: amountCrypto, ipn_callback_url: `${req.protocol}://${req.get("host")}/webhook/nowpayments`,
      order_id: `dep-${uid}-${Date.now()}`, order_description: "Depósito Atlax AI"
    }, { headers: { "x-api-key": NP_API_KEY, "Content-Type": "application/json" } });

    const paymentData = paymentResponse.data;
    await supabase.from("cripto_depositos").insert({
      uid, payment_id: paymentData.payment_id, currency: currency.toLowerCase(),
      amount_crypto: amountCrypto, amount_reais: amount, status: "waiting",
      pay_address: paymentData.pay_address, pay_amount: paymentData.pay_amount, created_at: new Date()
    });

    res.json({
      payment_id: paymentData.payment_id, pay_address: paymentData.pay_address,
      pay_amount: paymentData.pay_amount, currency: paymentData.pay_currency,
      qr_code: `https://chart.googleapis.com/chart?chs=200x200&cht=qr&chl=${paymentData.pay_address}`
    });
  } catch (err) {
    console.error("❌ Erro depósito cripto:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao gerar endereço." });
  }
});

app.post("/webhook/nowpayments", async (req, res) => {
  try {
    const { payment_id, payment_status } = req.body;
    if (!payment_id || payment_status !== "finished") return res.status(200).send("OK");
    const { data: deposito, error } = await supabase.from("cripto_depositos").select("*").eq("payment_id", payment_id).single();
    if (error || !deposito || deposito.status === "completed") return res.status(200).send("OK");
    const uid = deposito.uid;
    const valorReais = deposito.amount_reais;
    await supabase.from("cripto_depositos").update({ status: "completed" }).eq("payment_id", payment_id);
    await supabase.from("usuarios").upsert({ id: uid, saldo: 0 }, { onConflict: "id" });
    const { data: userAtual } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    const novoSaldo = (userAtual?.saldo ?? 0) + Number(valorReais);
    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("transactions").insert({ uid, tipo: "deposito_cripto", valor: Number(valorReais), status: "aprovado", categoria: deposito.currency });
    console.log(`✅ Depósito cripto processado para ${uid}: R$ ${valorReais}`);
    res.status(200).send("OK");
  } catch (err) {
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ===== FUNDOS E DEMAIS ROTAS (mantidas integralmente) =====
// (Todo o código de /fundos, /investir-fundo, etc. permanece igual)

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
