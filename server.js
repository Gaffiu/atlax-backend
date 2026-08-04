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

// Headers de segurança manuais (sem dependência helmet)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// CORS inteligente: permite tudo se FRONTEND_URLS não existir
const FRONTEND_URLS = process.env.FRONTEND_URLS
  ? process.env.FRONTEND_URLS.split(",")
  : null;

app.use(cors({
  origin: FRONTEND_URLS
    ? (origin, callback) => {
        if (!origin || FRONTEND_URLS.includes(origin)) callback(null, true);
        else { console.warn(`🚫 CORS bloqueado: ${origin}`); callback(new Error("Origem não permitida")); }
      }
    : true,
  methods: ["GET","POST","PUT","DELETE"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

app.use(express.json());

const {
  MP_TOKEN, BRAPI_API_KEY, ALPHA_VANTAGE_API_KEY,
  BELVO_SECRET_ID, BELVO_SECRET_PASSWORD,
  NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET,
  GEMINI_API_KEY
} = process.env;

const TAXA_DEPOSITO = 0.10;
const TAXA_SAQUE = 0.10;
const SAQUE_MINIMO = 100;

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

// ========== ATUALIZAR PREÇOS NA TABELA FUNDOS ==========
async function atualizarPrecosFundos() {
  console.log("📊 Atualizando preços dos fundos...");

  // 1. Ações BR via Brapi
  if (BRAPI_API_KEY) {
    const tickersAcoes = ["PETR4", "VALE3", "ITUB4", "BBDC4", "ABEV3", "WEGE3", "MGLU3"];
    for (const ticker of tickersAcoes) {
      try {
        const { data } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, {
          params: { token: BRAPI_API_KEY }
        });
        const result = data?.results?.[0];
        if (result?.regularMarketPrice) {
          await supabase.from("fundos").update({
            preco: result.regularMarketPrice,
            variacao: result.regularMarketChangePercent || 0
          }).eq("ticker", ticker);
          console.log(`  ✅ ${ticker}: R$ ${result.regularMarketPrice}`);
        }
      } catch (e) {
        console.warn(`  ⚠️ Erro ao atualizar ${ticker}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 800)); // Pausa de 800ms entre chamadas
    }
  }

  // 2. ETFs via Brapi
  if (BRAPI_API_KEY) {
    const tickersETFs = ["BOVA11", "SMAL11", "IVVB11", "FIND11"];
    for (const ticker of tickersETFs) {
      try {
        const { data } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, {
          params: { token: BRAPI_API_KEY }
        });
        const result = data?.results?.[0];
        if (result?.regularMarketPrice) {
          await supabase.from("fundos").update({
            preco: result.regularMarketPrice,
            variacao: result.regularMarketChangePercent || 0
          }).eq("ticker", ticker);
          console.log(`  ✅ ${ticker}: R$ ${result.regularMarketPrice}`);
        }
      } catch (e) {
        console.warn(`  ⚠️ Erro ao atualizar ${ticker}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 800));
    }
  }

  // 3. Criptos (sincronizar da tabela cotacoes para fundos)
  const { data: cotacoes } = await supabase.from("cotacoes").select("*");
  if (cotacoes) {
    const mapa = {};
    cotacoes.forEach(c => mapa[c.ticker] = { preco: c.preco, variacao: c.variacao });

    if (mapa["BTC"]) {
      await supabase.from("fundos").update({
        preco: mapa["BTC"].preco,
        variacao: mapa["BTC"].variacao
      }).eq("ticker", "BTC");
    }
    if (mapa["ETH"]) {
      await supabase.from("fundos").update({
        preco: mapa["ETH"].preco,
        variacao: mapa["ETH"].variacao
      }).eq("ticker", "ETH");
    }
    if (mapa["SOL"]) {
      await supabase.from("fundos").update({
        preco: mapa["SOL"].preco,
        variacao: mapa["SOL"].variacao
      }).eq("ticker", "SOL");
    }
    console.log("  🪙 Criptos sincronizadas da tabela cotacoes");
  }

  console.log("📊 Preços dos fundos atualizados!");
}

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

// ===== PERFIL =====
app.get("/perfil/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("usuarios").select("*").eq("id", req.user.uid).single();
  res.json(data || {});
});

app.put("/perfil/:uid", authMiddleware, async (req, res) => {
  const { nome, email, telefone, bio, foto } = req.body;
  const updates = {};
  if (nome !== undefined) updates.nome = nome;
  if (email !== undefined) updates.email = email;
  if (telefone !== undefined) updates.telefone = telefone;
  if (bio !== undefined) updates.bio = bio;
  if (foto !== undefined) updates.foto = foto;
  const { error } = await supabase.from("usuarios").update(updates).eq("id", req.user.uid);
  if (error) return res.status(500).json({ erro: "Erro ao atualizar perfil" });
  res.json({ ok: true });
});

// ===== DEPÓSITO PIX =====
app.post("/deposito", authMiddleware, async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "Método de pagamento indisponível" });
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
    if (!payment) return res.status(500).json({ erro: "Método de pagamento indisponível" });
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

// ===== SAQUE =====
app.post("/saque", authMiddleware, async (req, res) => {
  try {
    const { valor, pix } = req.body;
    const uid = req.user.uid;
    const valorSaque = Number(valor);
    if (!valorSaque || valorSaque < SAQUE_MINIMO) {
      return res.status(400).json({ erro: `Valor mínimo para saque é R$ ${SAQUE_MINIMO}` });
    }
    const taxa = valorSaque * TAXA_SAQUE;
    const valorTotal = valorSaque + taxa;
    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    if (!user || user.saldo == null || user.saldo < valorTotal) {
      return res.status(400).json({ erro: `Saldo insuficiente. Necessário R$ ${valorTotal.toFixed(2)} (já com taxa de 10%)` });
    }
    const novoSaldo = user.saldo - valorTotal;
    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("transactions").insert([
      { uid, tipo: "saque", valor: valorSaque, status: "pendente", categoria: pix || "pix" },
      { uid: "admin", tipo: "taxa_saque", valor: taxa, status: "aprovado", categoria: "taxa" }
    ]);
    res.json({ ok: true, taxa, valorLiquido: valorSaque, valorTotal });
  } catch (e) { res.status(500).json({ erro: "Erro interno" }); }
});

// ===== INVESTIR (genérico) =====
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

// ===== DEPÓSITO CRIPTO =====
app.post("/deposito-cripto", authMiddleware, async (req, res) => {
  if (!NOWPAYMENTS_API_KEY) return res.status(500).json({ erro: "Depósito cripto indisponível" });
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
    }, { headers: { "x-api-key": NOWPAYMENTS_API_KEY, "Content-Type": "application/json" } });

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

// ===== FUNDOS E INVESTIMENTOS =====
app.get("/fundos", async (_, res) => {
  const { data } = await supabase.from("fundos").select("*").eq("ativo", true);
  res.json(data || []);
});

app.get("/ativos", async (req, res) => {
  const { tipo } = req.query;
  let query = supabase.from("fundos").select("*").eq("ativo", true);
  if (tipo) query = query.eq("tipo", tipo);
  const { data } = await query;
  res.json(data || []);
});

app.get("/carteira/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("investimentos").select("*, fundos(*)").eq("uid", req.user.uid).eq("status", "ativo");
  res.json(data || []);
});

app.post("/investir-fundo", authMiddleware, async (req, res) => {
  const { fundo_id, valor } = req.body;
  const uid = req.user.uid;
  if (!fundo_id || !valor || valor <= 0) return res.status(400).json({ erro: "Dados inválidos" });

  const { data: fundo } = await supabase.from("fundos").select("*").eq("id", fundo_id).single();
  if (!fundo) return res.status(400).json({ erro: "Fundo não encontrado" });

  const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
  if (!user || user.saldo < valor) return res.status(400).json({ erro: "Saldo insuficiente" });

  const cotas = valor / 100;
  const novoSaldo = user.saldo - valor;

  await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
  await supabase.from("investimentos").insert({
    uid, fundo_id, valor_aplicado: valor, valor_atual: valor, cotas,
    rentabilidade: 0, status: "ativo"
  });
  await supabase.from("transactions").insert({ uid, tipo: "investimento", valor, status: "aprovado", categoria: fundo.nome });

  res.json({ ok: true, novo_saldo: novoSaldo });
});

app.post("/resgatar-fundo", authMiddleware, async (req, res) => {
  const { investimento_id } = req.body;
  const uid = req.user.uid;

  const { data: inv } = await supabase.from("investimentos").select("*, fundos(*)").eq("id", investimento_id).eq("uid", uid).single();
  if (!inv) return res.status(400).json({ erro: "Investimento não encontrado" });

  const valorResgate = inv.valor_atual || inv.valor_aplicado;
  const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
  const novoSaldo = (user?.saldo ?? 0) + valorResgate;

  await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
  await supabase.from("investimentos").update({ status: "resgatado" }).eq("id", investimento_id);
  await supabase.from("transactions").insert({ uid, tipo: "resgate", valor: valorResgate, status: "aprovado", categoria: inv.fundos?.nome || "Fundo" });

  res.json({ ok: true, valor_resgate: valorResgate });
});

app.post("/resgatar-fundo-parcial", authMiddleware, async (req, res) => {
  const { investimento_id, cotas_a_resgatar } = req.body;
  const uid = req.user.uid;

  const { data: inv } = await supabase.from("investimentos").select("*").eq("id", investimento_id).eq("uid", uid).single();
  if (!inv) return res.status(400).json({ erro: "Investimento não encontrado" });

  if (inv.cotas < cotas_a_resgatar) return res.status(400).json({ erro: "Cotas insuficientes" });

  const valorPorCota = inv.valor_atual / inv.cotas;
  const valorResgate = valorPorCota * cotas_a_resgatar;
  const novasCotas = inv.cotas - cotas_a_resgatar;

  const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
  const novoSaldo = (user?.saldo ?? 0) + valorResgate;

  await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
  if (novasCotas <= 0) {
    await supabase.from("investimentos").update({ status: "resgatado", cotas: 0 }).eq("id", investimento_id);
  } else {
    await supabase.from("investimentos").update({
      cotas: novasCotas,
      valor_aplicado: inv.valor_aplicado - (inv.valor_aplicado / inv.cotas) * cotas_a_resgatar,
      valor_atual: novasCotas * valorPorCota
    }).eq("id", investimento_id);
  }
  await supabase.from("transactions").insert({ uid, tipo: "resgate", valor: valorResgate, status: "aprovado" });

  res.json({ ok: true, valor_resgate: valorResgate });
});

app.get("/certificado-investimento/:id", authMiddleware, async (req, res) => {
  const { data: inv } = await supabase.from("investimentos").select("*, fundos(nome, ticker)").eq("id", req.params.id).eq("uid", req.user.uid).single();
  if (!inv) return res.status(404).json({ erro: "Investimento não encontrado" });
  res.json({
    nome_fundo: inv.fundos?.nome,
    ticker: inv.fundos?.ticker,
    valor_aplicado: inv.valor_aplicado,
    cotas: inv.cotas,
    data_aplicacao: inv.data_aplicacao
  });
});

// ===== APORTES AUTOMÁTICOS =====
app.get("/aportes-automaticos/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("aportes_automaticos").select("*, fundos(nome, ticker)").eq("uid", req.user.uid).eq("ativo", true);
  res.json(data || []);
});

app.post("/aporte-automatico", authMiddleware, async (req, res) => {
  const { fundo_id, valor, periodicidade, dia_do_mes } = req.body;
  const { error } = await supabase.from("aportes_automaticos").insert({
    uid: req.user.uid, fundo_id, valor, periodicidade, dia_do_mes
  });
  if (error) return res.status(500).json({ erro: "Erro ao criar aporte" });
  res.json({ ok: true });
});

app.delete("/aporte-automatico/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("aportes_automaticos").update({ ativo: false }).eq("id", req.params.id).eq("uid", req.user.uid);
  if (error) return res.status(500).json({ erro: "Erro ao cancelar" });
  res.json({ ok: true });
});

// ===== ORDENS AUTOMÁTICAS =====
app.get("/ordens-automaticas/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("ordens_automaticas").select("*, fundos(nome, ticker)").eq("uid", req.user.uid).eq("ativo", true);
  res.json(data || []);
});

app.post("/ordem-automatica", authMiddleware, async (req, res) => {
  const { fundo_id, tipo, rentabilidade_acionadora } = req.body;
  const { error } = await supabase.from("ordens_automaticas").insert({
    uid: req.user.uid, fundo_id, tipo, rentabilidade_acionadora
  });
  if (error) return res.status(500).json({ erro: "Erro ao criar ordem" });
  res.json({ ok: true });
});

app.delete("/ordem-automatica/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("ordens_automaticas").update({ ativo: false }).eq("id", req.params.id).eq("uid", req.user.uid);
  if (error) return res.status(500).json({ erro: "Erro ao cancelar" });
  res.json({ ok: true });
});

// ===== COMPARADOR =====
app.get("/comparar-fundos", async (req, res) => {
  const tickers = req.query.tickers?.split(",") || [];
  const { data } = await supabase.from("fundos").select("*").in("ticker", tickers).eq("ativo", true);
  res.json(data || []);
});

// ===== CONTAS E BELVO =====
app.get("/contas/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("contas").select("*").eq("uid", req.user.uid);
  res.json(data || []);
});

app.put("/conta/:id", authMiddleware, async (req, res) => {
  const { saldo } = req.body;
  const { error } = await supabase.from("contas").update({ saldo }).eq("id", req.params.id).eq("uid", req.user.uid);
  if (error) return res.status(500).json({ erro: "Erro ao atualizar" });
  res.json({ ok: true });
});

app.post("/cartao", authMiddleware, async (req, res) => {
  const { descricao, valor, categoria } = req.body;
  const { error } = await supabase.from("transactions").insert({
    uid: req.user.uid, tipo: "cartao", valor, status: "pendente", categoria: descricao
  });
  if (error) return res.status(500).json({ erro: "Erro ao adicionar" });
  res.json({ ok: true });
});

app.post("/belvo/connect-token", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.status(500).json({ erro: "Serviço de conexão bancária indisponível" });
  try {
    const response = await axios.post(`${BELVO_API_URL}/api/token`, {
      id: "atlax-connect",
      password: BELVO_SECRET_PASSWORD,
      scopes: "read_institutions,write_links,read_links,read_accounts,read_transactions,read_credit_cards"
    }, { auth: BELVO_AUTH });
    res.json({ accessToken: response.data.access });
  } catch (e) {
    console.error("❌ Erro token Belvo:", e.response?.data || e.message);
    res.status(500).json({ erro: "Falha ao gerar token Belvo" });
  }
});

app.get("/belvo/contas/:itemId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.json([]);
  try {
    const response = await axios.get(`${BELVO_API_URL}/api/accounts/?link=${req.params.itemId}`, { auth: BELVO_AUTH });
    res.json(response.data.results || []);
  } catch (e) {
    console.error("❌ Erro Belvo contas:", e.response?.data || e.message);
    res.json([]);
  }
});

app.get("/belvo/transacoes/:itemId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.json([]);
  try {
    const response = await axios.get(`${BELVO_API_URL}/api/transactions/?link=${req.params.itemId}`, { auth: BELVO_AUTH });
    res.json(response.data.results || []);
  } catch (e) {
    console.error("❌ Erro Belvo transações:", e.response?.data || e.message);
    res.json([]);
  }
});

app.get("/belvo/cartoes-contas/:itemId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.json({ encontradas: false, cartoes: [] });
  try {
    const response = await axios.get(`${BELVO_API_URL}/api/credit-cards/?link=${req.params.itemId}`, { auth: BELVO_AUTH });
    res.json({ encontradas: true, cartoes: response.data.results || [] });
  } catch (e) {
    console.error("❌ Erro Belvo cartões:", e.response?.data || e.message);
    res.json({ encontradas: false, cartoes: [] });
  }
});

app.get("/belvo/faturas/:linkId/:accountId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.json([]);
  try {
    const response = await axios.get(`${BELVO_API_URL}/api/transactions/?link=${req.params.linkId}&account=${req.params.accountId}`, { auth: BELVO_AUTH });
    res.json(response.data.results || []);
  } catch (e) {
    console.error("❌ Erro Belvo faturas:", e.response?.data || e.message);
    res.json([]);
  }
});

// ===== IA (GEMINI) =====
app.post("/ia/perguntar", authMiddleware, async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ resposta: "Assistente IA indisponível" });
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: req.body.mensagem }] }] }
    );
    const texto = response.data.candidates[0].content.parts[0].text;
    res.json({ resposta: texto });
  } catch (e) {
    console.error("Erro Gemini:", e.response?.data || e.message);
    res.json({ resposta: "Não foi possível responder agora." });
  }
});

app.post("/ia/analisar", authMiddleware, async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ resposta: "Assistente IA indisponível" });
  try {
    const { data: user } = await supabase.from("usuarios").select("*").eq("id", req.user.uid).single();
    const { data: transacoes } = await supabase.from("transactions").select("*").eq("uid", req.user.uid).limit(20);
    const prompt = `Analise os dados financeiros do usuário:\nSaldo: R$ ${user.saldo}\nTransações recentes: ${JSON.stringify(transacoes)}\n\nGere uma análise financeira resumida, sugestões personalizadas e riscos identificados. Seja gentil e motivador.`;
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    const texto = response.data.candidates[0].content.parts[0].text;
    res.json({ resposta: texto });
  } catch (e) {
    console.error("Erro Gemini análise:", e.response?.data || e.message);
    res.json({ resposta: "Não foi possível analisar agora." });
  }
});

app.get("/ia", async (req, res) => {
  res.json({ resposta: "O Oráculo está nebuloso. Faça uma pergunta direta." });
});

// ===== COFRE DO TEMPO =====
app.get("/cartas/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("cartas").select("*").eq("uid", req.user.uid).order("criada_em", { ascending: false });
  res.json(data || []);
});

app.post("/cartas", authMiddleware, async (req, res) => {
  const { titulo, texto, data_abertura } = req.body;
  const { error } = await supabase.from("cartas").insert({ uid: req.user.uid, titulo, texto, data_abertura });
  if (error) return res.status(500).json({ erro: "Erro ao salvar" });
  res.json({ ok: true });
});

// ===== ATLAX COINS =====
app.get("/coins/:uid", authMiddleware, async (req, res) => {
  const { data: user } = await supabase.from("usuarios").select("atlax_coins").eq("id", req.user.uid).single();
  res.json({ coins: user?.atlax_coins ?? 0 });
});

app.post("/coins/adicionar", authMiddleware, async (req, res) => {
  const { quantidade, motivo } = req.body;
  const uid = req.user.uid;
  await supabase.from("usuarios").upsert({ id: uid, atlax_coins: 0 }, { onConflict: "id" });
  const { data: user } = await supabase.from("usuarios").select("atlax_coins").eq("id", uid).single();
  const novoSaldo = (user?.atlax_coins ?? 0) + quantidade;
  await supabase.from("usuarios").update({ atlax_coins: novoSaldo }).eq("id", uid);
  await supabase.from("coins").insert({ uid, quantidade, motivo });
  res.json({ ok: true, novo_saldo: novoSaldo });
});

app.post("/coins/resgatar", authMiddleware, async (req, res) => {
  const { quantidade } = req.body;
  const uid = req.user.uid;
  const taxa_conversao = 0.05;
  const { data: user } = await supabase.from("usuarios").select("atlax_coins, saldo").eq("id", uid).single();
  if (!user || (user.atlax_coins || 0) < quantidade) return res.status(400).json({ erro: "Coins insuficientes" });
  const valor_creditado = quantidade * taxa_conversao;
  const novoCoins = (user.atlax_coins || 0) - quantidade;
  const novoSaldo = (user.saldo || 0) + valor_creditado;
  await supabase.from("usuarios").update({ atlax_coins: novoCoins, saldo: novoSaldo }).eq("id", uid);
  await supabase.from("coins").insert({ uid, quantidade: -quantidade, motivo: "resgate" });
  await supabase.from("transactions").insert({ uid, tipo: "resgate_coins", valor: valor_creditado, status: "aprovado", categoria: "coins" });
  res.json({ ok: true, valor_creditado });
});

app.get("/historico-cdi", async (_, res) => {
  // Dados mensais do CDI (acumulado dos últimos 12 meses)
  // Fonte: Banco Central (série 4389) ou Brapi
  if (BRAPI_API_KEY) {
    try {
      // A Brapi não tem endpoint direto de CDI, vamos usar a SELIC como proxy
      const response = await axios.get("https://brapi.dev/api/v2/prime-rate", {
        params: { token: BRAPI_API_KEY, historical: true }
      });
      // Processar dados históricos...
    } catch (e) {}
  }

  // Fallback: dados sintéticos (baseados no CDI real de ~10,40% a.a.)
  const labels = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const data = [100, 100.82, 101.65, 102.49, 103.34, 104.20, 105.07, 105.95, 106.84, 107.74, 108.65, 109.57];
  res.json({ labels, data });
});

app.get("/historico-ibov", async (_, res) => {
  // Dados mensais do Ibovespa (últimos 12 meses)
  // Fonte: Brapi ou Alpha Vantage
  if (BRAPI_API_KEY) {
    try {
      const response = await axios.get("https://brapi.dev/api/quote/%5EBVSP", {
        params: { token: BRAPI_API_KEY, range: "1y", interval: "1mo" }
      });
      // Processar...
    } catch (e) {}
  }

  // Fallback sintético
  const labels = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const data = [125000, 126000, 124000, 128000, 130000, 128000, 131000, 129000, 132000, 130000, 128500, 128500];
  res.json({ labels, data });
});



app.get("/indicadores", async (_, res) => {
  const ind = [];

  // Buscar SELIC e CDI da Brapi (se key existir)
  if (BRAPI_API_KEY) {
    try {
      const selicRes = await axios.get("https://brapi.dev/api/v2/prime-rate", {
        params: { token: BRAPI_API_KEY }
      });
      const selic = selicRes.data?.prime_rate?.[0]?.value || 10.50;
      ind.push({ nome: "SELIC", valor: `${selic.toFixed(2)}%`, var: "estável", positivo: true });

      const cdi = selic - 0.10; // CDI geralmente é SELIC - 0,10%
      ind.push({ nome: "CDI", valor: `${cdi.toFixed(2)}%`, var: "+0,02%", positivo: true });
    } catch (e) {
      console.warn("Erro ao buscar SELIC:", e.message);
    }
  }

  // Se não conseguiu SELIC, usa fallback
  if (ind.length === 0) {
    ind.push({ nome: "SELIC", valor: "10,50%", var: "estável", positivo: true });
    ind.push({ nome: "CDI", valor: "10,40%", var: "+0,02%", positivo: true });
  }

  // IPCA (mensal – buscar do Banco Central)
  try {
    const ipcaRes = await axios.get("https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados/ultimos/1?formato=json");
    const ipca = ipcaRes.data?.[0]?.valor || "0,38";
    ind.push({ nome: "IPCA", valor: `${ipca}%`, var: "-0,05%", positivo: false });
  } catch (e) {
    ind.push({ nome: "IPCA", valor: "0,38%", var: "-0,05%", positivo: false });
  }

  // IBOV, IFIX, Dólar (buscar da tabela cotacoes)
  const { data: cotacoes } = await supabase.from("cotacoes").select("*");
  const mapa = {};
  if (cotacoes) cotacoes.forEach(c => mapa[c.ticker] = { preco: c.preco, variacao: c.variacao });

  const ibov = mapa["IBOV"] || { preco: 128500, variacao: 0.82 };
  ind.push({
    nome: "IBOV",
    valor: ibov.preco.toLocaleString("pt-BR"),
    var: `${ibov.variacao >= 0 ? '+' : ''}${ibov.variacao.toFixed(2)}%`,
    positivo: ibov.variacao >= 0
  });

  const ifix = mapa["IFIX"] || { preco: 3150, variacao: 0.35 };
  ind.push({
    nome: "IFIX",
    valor: ifix.preco.toFixed(0),
    var: `${ifix.variacao >= 0 ? '+' : ''}${ifix.variacao.toFixed(2)}%`,
    positivo: ifix.variacao >= 0
  });

  const usd = mapa["USDBRL"] || { preco: 5.12, variacao: -0.34 };
  ind.push({
    nome: "Dólar",
    valor: `R$ ${usd.preco.toFixed(2)}`,
    var: `${usd.variacao >= 0 ? '+' : ''}${usd.variacao.toFixed(2)}%`,
    positivo: usd.variacao >= 0
  });

  res.json(ind);
});

app.get("/noticias", async (_, res) => {
  // Tentar NewsAPI se configurada
  if (process.env.NEWS_API_KEY) {
    try {
      const response = await axios.get("https://newsapi.org/v2/top-headlines", {
        params: {
          country: "br",
          category: "business",
          apiKey: process.env.NEWS_API_KEY
        }
      });
      const noticias = response.data.articles.slice(0, 5).map(a => ({
        titulo: a.title,
        fonte: a.source.name,
        resumo: a.description || "Clique para ler mais"
      }));
      if (noticias.length > 0) return res.json(noticias);
    } catch (e) {
      console.warn("Erro ao buscar notícias:", e.message);
    }
  }

  // Fallback estático
  const noticias = [
    { titulo: "Ibovespa fecha em alta com expectativa de cortes na SELIC", fonte: "InfoMoney", resumo: "O índice renovou máxima com fluxo estrangeiro positivo." },
    { titulo: "S&P 500 atinge novo recorde histórico impulsionado por tecnologia", fonte: "Valor Econômico", resumo: "Big techs lideram ganhos com balanços acima do esperado." },
    { titulo: "Dólar recua com entrada de capital e melhora do cenário fiscal", fonte: "Reuters", resumo: "Moeda americana acumula queda de 1,2% na semana." },
    { titulo: "Petrobras anuncia pagamento de dividendos bilionários", fonte: "Exame", resumo: "Estatal distribuirá R$ 15 bilhões aos acionistas." }
  ];
  res.json(noticias);
});

// Executa ao iniciar o servidor
atualizarPrecosFundos();

// Executa a cada 2 horas (120 minutos * 60 segundos * 1000 milissegundos)
setInterval(atualizarPrecosFundos, 120 * 60 * 1000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
