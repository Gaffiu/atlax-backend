console.log("🔥 Iniciando servidor...");
process.on("uncaughtException", (err) => console.error("💥 Erro:", err));
process.on("unhandledRejection", (err) => console.error("💥 Promise:", err));
process.setMaxListeners(50);

const express = require("express");
const axios = require("axios");
const axiosRetry = require("axios-retry").default;
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const supabase = require("./supabase");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const authMiddleware = require("./middleware/auth");

axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => retryCount * 1000,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status === 429;
  }
});

axios.defaults.timeout = 15000;

const app = express();
app.use(compression());

const limiterGeral = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { erro: "Muitas requisições. Tente novamente em 15 minutos." },
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiterGeral);

const limiterTrades = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { erro: "Muitas ordens em pouco tempo. Aguarde 1 minuto." }
});

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

const FRONTEND_URLS = process.env.FRONTEND_URLS ? process.env.FRONTEND_URLS.split(",") : null;
app.use(cors({
  origin: FRONTEND_URLS
    ? (origin, callback) => {
        if (!origin || FRONTEND_URLS.includes(origin)) callback(null, true);
        else {
          console.warn(`🚫 CORS bloqueado: ${origin}`);
          callback(new Error("Origem não permitida"));
        }
      }
    : true,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "1mb" }));

const {
  MP_TOKEN, BRAPI_API_KEY, ALPHA_VANTAGE_API_KEY,
  BELVO_SECRET_ID, BELVO_SECRET_PASSWORD,
  NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET,
  GEMINI_API_KEY
} = process.env;

// ========== TAXAS E CONFIGURAÇÕES (SPRINT 6) ==========
const TAXA_DEPOSITO = 0.05;
const TAXA_SAQUE = 0.05;
const TAXA_TRADE = 0.003;
const SAQUE_MINIMO = 100;

const BONUS_MINIMO = 20;
const BONUS_MAXIMO = 200;
const BONUS_MULTIPLICADOR = 2;      // 2x o valor depositado
const ROLLOVER_MULTIPLICADOR = 5;   // 5x o bônus em volume de trade

const VERSAO_TERMOS = "v1.0";

const cache = new Map();
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expira) { cache.delete(key); return null; }
  return item.valor;
}
function setCache(key, valor, ttlSegundos = 300) {
  cache.set(key, { valor, expira: Date.now() + ttlSegundos * 1000 });
}
setInterval(() => {
  const agora = Date.now();
  for (const [key, item] of cache.entries()) {
    if (agora > item.expira) cache.delete(key);
  }
}, 10 * 60 * 1000);

function sanitizar(str, max = 500) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>/g, "").replace(/[<>"'`]/g, "").trim().slice(0, max);
}
function validarEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function validarTelefone(tel) {
  if (!tel) return true;
  return /^[\d\s()+-]{8,20}$/.test(tel);
}
function validarChavePix(chave) {
  if (!chave || typeof chave !== "string") return false;
  return chave.trim().length >= 4 && chave.trim().length <= 100;
}
function validarValor(valor) {
  const n = Number(valor);
  return !isNaN(n) && n > 0 && n < 1000000;
}
function validarCPF(cpf) {
  if (!cpf) return false;
  const limpo = String(cpf).replace(/\D/g, "");
  if (limpo.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(limpo)) return false;
  let soma = 0, resto;
  for (let i = 1; i <= 9; i++) soma += parseInt(limpo.substring(i - 1, i)) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(limpo.substring(9, 10))) return false;
  soma = 0;
  for (let i = 1; i <= 10; i++) soma += parseInt(limpo.substring(i - 1, i)) * (12 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(limpo.substring(10, 11))) return false;
  return true;
}

async function verificarCompliance(uid, exigirKYC = false) {
  const { data: user } = await supabase.from("usuarios")
    .select("termos_aceitos, kyc_aprovado, suitability_feito")
    .eq("id", uid).single();
  if (!user) return { ok: false, erro: "Usuário não encontrado" };
  if (!user.termos_aceitos) return { ok: false, erro: "Você precisa aceitar os Termos de Uso" };
  if (!user.suitability_feito) return { ok: false, erro: "Você precisa preencher o questionário de perfil de investidor" };
  if (exigirKYC && !user.kyc_aprovado) return { ok: false, erro: "Você precisa completar a verificação de identidade (KYC) antes de sacar" };
  return { ok: true };
}

// ========== PROCESSAR BÔNUS NO PRIMEIRO DEPÓSITO ==========
async function processarBonusPrimeiroDeposito(uid, valorDepositoLiquido) {
  try {
    const { data: user } = await supabase.from("usuarios")
      .select("bonus_recebido")
      .eq("id", uid).single();
    if (user?.bonus_recebido) return { aplicado: false };

    let valorBonus = valorDepositoLiquido * BONUS_MULTIPLICADOR;
    if (valorBonus < BONUS_MINIMO) valorBonus = BONUS_MINIMO;
    if (valorBonus > BONUS_MAXIMO) valorBonus = BONUS_MAXIMO;

    const rolloverMeta = valorBonus * ROLLOVER_MULTIPLICADOR;

    await supabase.from("usuarios").update({
      bonus_bloqueado: valorBonus,
      rollover_meta: rolloverMeta,
      rollover_progresso: 0,
      bonus_recebido: true
    }).eq("id", uid);

    await supabase.from("bonus_historico").insert({
      uid,
      valor_bonus: valorBonus,
      rollover_meta: rolloverMeta,
      status: "bloqueado"
    });

    console.log(`🎁 Bônus aplicado: ${uid} | R$ ${valorBonus} | rollover R$ ${rolloverMeta}`);
    return { aplicado: true, valorBonus, rolloverMeta };
  } catch (e) {
    console.error("Erro ao processar bônus:", e.message);
    return { aplicado: false };
  }
}

// ========== REGISTRAR VOLUME DE TRADE (PARA ROLLOVER) ==========
async function registrarVolumeTrade(uid, valorOperacao) {
  try {
    const { data: user } = await supabase.from("usuarios")
      .select("bonus_bloqueado, rollover_meta, rollover_progresso")
      .eq("id", uid).single();
    if (!user) return;
    if (Number(user.bonus_bloqueado) <= 0) return;

    const novoProgresso = Number(user.rollover_progresso || 0) + Number(valorOperacao);
    const meta = Number(user.rollover_meta || 0);

    if (novoProgresso >= meta) {
      // Rollover atingido: libera o bônus
      const { data: userAtual } = await supabase.from("usuarios")
        .select("saldo, bonus_bloqueado").eq("id", uid).single();
      const novoSaldo = Number(userAtual.saldo || 0) + Number(userAtual.bonus_bloqueado);
      await supabase.from("usuarios").update({
        saldo: novoSaldo,
        bonus_bloqueado: 0,
        bonus_liberado: userAtual.bonus_bloqueado,
        rollover_progresso: novoProgresso
      }).eq("id", uid);
      await supabase.from("bonus_historico").update({
        status: "liberado",
        liberado_em: new Date()
      }).eq("uid", uid).eq("status", "bloqueado");
      console.log(`✅ Rollover completo! Bônus liberado para ${uid}`);
    } else {
      await supabase.from("usuarios").update({
        rollover_progresso: novoProgresso
      }).eq("id", uid);
    }
  } catch (e) {
    console.error("Erro rollover:", e.message);
  }
}

let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 MP configurado");
}

const BELVO_API_URL = "https://sandbox.belvo.com";
const BELVO_AUTH = BELVO_SECRET_ID && BELVO_SECRET_PASSWORD ? {
  auth: { username: BELVO_SECRET_ID, password: BELVO_SECRET_PASSWORD }
} : null;
if (BELVO_AUTH) console.log("🔑 Belvo configurado (Sandbox)");
else console.warn("⚠️ Belvo não configurado.");

const MAPA_CRIPTO = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", USDT: "tether", LTC: "litecoin", DOGE: "dogecoin",
  XRP: "ripple", ADA: "cardano", BNB: "binancecoin", DOT: "polkadot", MATIC: "matic-network",
  TRX: "tron", AVAX: "avalanche-2", LINK: "chainlink", UNI: "uniswap", ATOM: "cosmos",
  ETC: "ethereum-classic", FIL: "filecoin", VET: "vechain", ALGO: "algorand",
  ICP: "internet-computer", NEAR: "near", FTM: "fantom", SAND: "the-sandbox",
  MANA: "decentraland", AXS: "axie-infinity", THETA: "theta-token", HNT: "helium",
  FLOW: "flow", EGLD: "elrond-erd-2", BCH: "bitcoin-cash", XLM: "stellar",
  XMR: "monero", EOS: "eos", ZEC: "zcash", DASH: "dash", NEO: "neo",
  QTUM: "qtum", IOTA: "iota", ZIL: "zilliqa", BAT: "basic-attention-token",
  ENJ: "enjincoin", COMP: "compound-governance-token", SNX: "synthetix-network-token",
  SUSHI: "sushi", GRT: "the-graph", CELO: "celo", LUNA: "terra-luna-2",
  APT: "aptos", SUI: "sui", ARB: "arbitrum", OP: "optimism",
  PEPE: "pepe", SHIB: "shiba-inu", CRO: "crypto-com-chain", INJ: "injective-protocol",
  TIA: "celestia", SEI: "sei-network", BONK: "bonk", WIF: "dogwifcoin",
  FLOKI: "floki", USDC: "usd-coin", DAI: "dai", RUNE: "thorchain",
  LDO: "lido-dao", RNDR: "render-token", FET: "fetch-ai", AGIX: "singularitynet",
  JUP: "jupiter-exchange-solana", PYTH: "pyth-network"
};

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
  } catch (e) {
    console.error("❌ CoinGecko:", e.message);
  }
}

async function atualizarAcoesBR() {
  if (!BRAPI_API_KEY) return;
  const tickers = ["PETR4", "VALE3", "ITUB4", "BBDC4", "ABEV3", "MGLU3", "BOVA11", "WEGE3"];
  for (const ticker of tickers) {
    try {
      const { data } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, { params: { token: BRAPI_API_KEY } });
      const result = data?.results?.[0];
      if (result?.regularMarketPrice) {
        await supabase.from("cotacoes").upsert({
          ticker, preco: result.regularMarketPrice, variacao: result.regularMarketChangePercent || 0, atualizado_em: new Date()
        }, { onConflict: "ticker" });
      }
    } catch (e) {
      console.warn(`⚠️ ${ticker}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  console.log("📈 Ações BR atualizadas");
}

async function atualizarAcoesInternacionais() {
  if (!ALPHA_VANTAGE_API_KEY) return;
  const tickers = ["AAPL", "TSLA", "GOOGL", "AMZN", "MSFT"];
  for (const ticker of tickers) {
    try {
      const { data } = await axios.get("https://www.alphavantage.co/query", {
        params: { function: "GLOBAL_QUOTE", symbol: ticker, apikey: ALPHA_VANTAGE_API_KEY }
      });
      const quote = data?.["Global Quote"];
      if (quote?.["05. price"]) {
        await supabase.from("cotacoes").upsert({
          ticker, preco: parseFloat(quote["05. price"]),
          variacao: parseFloat(quote["10. change percent"]?.replace("%", "")) || 0, atualizado_em: new Date()
        }, { onConflict: "ticker" });
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log("🌍 Ações internacionais atualizadas");
}

async function atualizarPrecosFundos() {
  console.log("📊 Atualizando preços dos fundos...");
  if (BRAPI_API_KEY) {
    const todosTickers = [
      "PETR4", "VALE3", "ITUB4", "BBDC4", "ABEV3", "WEGE3", "MGLU3",
      "BOVA11", "SMAL11", "IVVB11", "FIND11",
      "AAPL34", "TSLA34", "GOGL34", "AMZO34", "MSFT34"
    ];
    try {
      const { data } = await axios.get(`https://brapi.dev/api/quote/${todosTickers.join(",")}`, {
        params: { token: BRAPI_API_KEY }
      });
      const results = data?.results || [];
      for (const r of results) {
        if (r?.regularMarketPrice) {
          await supabase.from("fundos").update({
            preco: r.regularMarketPrice,
            variacao: r.regularMarketChangePercent || 0
          }).eq("ticker", r.symbol);
        }
      }
      console.log(`  ✅ ${results.length} tickers atualizados`);
    } catch (e) {
      console.warn(`  ⚠️ Erro batch Brapi: ${e.message}`);
    }
  }
  const { data: cotacoes } = await supabase.from("cotacoes").select("*");
  if (cotacoes) {
    const mapa = {};
    cotacoes.forEach(c => {
      mapa[c.ticker] = { preco: c.preco, variacao: c.variacao };
    });
    for (const t of ["BTC", "ETH", "SOL"]) {
      if (mapa[t]) {
        await supabase.from("fundos").update({ preco: mapa[t].preco, variacao: mapa[t].variacao }).eq("ticker", t);
      }
    }
    console.log("  🪙 Criptos sincronizadas");
  }
  console.log("📊 Preços dos fundos atualizados!");
}

// ========== COMPLIANCE ==========
app.get("/compliance/status", authMiddleware, async (req, res) => {
  const { data: user } = await supabase.from("usuarios")
    .select("termos_aceitos, kyc_aprovado, suitability_feito")
    .eq("id", req.user.uid).single();
  res.json({
    termos_aceitos: user?.termos_aceitos || false,
    kyc_aprovado: user?.kyc_aprovado || false,
    suitability_feito: user?.suitability_feito || false,
    versao_termos: VERSAO_TERMOS
  });
});

app.post("/compliance/aceitar-termos", authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    await supabase.from("termos_aceitos").upsert({
      uid, versao: VERSAO_TERMOS, aceito_em: new Date(),
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress
    }, { onConflict: "uid,versao" });
    await supabase.from("usuarios").update({ termos_aceitos: true }).eq("id", uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: "Erro ao aceitar termos" });
  }
});

app.post("/compliance/kyc", authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { cpf, nome_completo, data_nascimento, telefone, endereco_rua, endereco_numero, endereco_cidade, endereco_estado, endereco_cep } = req.body;
    if (!validarCPF(cpf)) return res.status(400).json({ erro: "CPF inválido" });
    if (!nome_completo || nome_completo.trim().split(" ").length < 2) return res.status(400).json({ erro: "Informe nome completo" });
    if (!data_nascimento) return res.status(400).json({ erro: "Data de nascimento obrigatória" });

    await supabase.from("kyc").upsert({
      uid,
      cpf: cpf.replace(/\D/g, ""),
      nome_completo: sanitizar(nome_completo, 200),
      data_nascimento,
      telefone: sanitizar(telefone || "", 20),
      endereco_rua: sanitizar(endereco_rua || "", 200),
      endereco_numero: sanitizar(endereco_numero || "", 20),
      endereco_cidade: sanitizar(endereco_cidade || "", 100),
      endereco_estado: sanitizar(endereco_estado || "", 2),
      endereco_cep: sanitizar(endereco_cep || "", 10),
      status: "aprovado",
      aprovado_em: new Date()
    }, { onConflict: "uid" });

    await supabase.from("usuarios").update({ kyc_aprovado: true }).eq("id", uid);
    res.json({ ok: true, mensagem: "KYC aprovado com sucesso" });
  } catch (e) {
    res.status(500).json({ erro: "Erro ao processar KYC" });
  }
});

app.get("/compliance/kyc", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("kyc").select("*").eq("uid", req.user.uid).single();
  res.json(data || {});
});

const PERGUNTAS_SUITABILITY = [
  { id: 1, texto: "Qual seu objetivo principal ao investir?", respostas: [
    { t: "Preservar capital", p: 0 },
    { t: "Gerar renda extra", p: 1 },
    { t: "Multiplicar patrimônio", p: 3 }
  ]},
  { id: 2, texto: "Por quanto tempo pretende deixar investido?", respostas: [
    { t: "Menos de 1 ano", p: 0 },
    { t: "De 1 a 5 anos", p: 1 },
    { t: "Mais de 5 anos", p: 3 }
  ]},
  { id: 3, texto: "Se seus investimentos caíssem 20%, o que faria?", respostas: [
    { t: "Venderia tudo", p: 0 },
    { t: "Manteria posição", p: 1 },
    { t: "Compraria mais", p: 3 }
  ]},
  { id: 4, texto: "Qual sua experiência com investimentos?", respostas: [
    { t: "Nenhuma", p: 0 },
    { t: "Alguma experiência", p: 1 },
    { t: "Bastante experiência", p: 3 }
  ]},
  { id: 5, texto: "Qual % da renda pode investir por mês?", respostas: [
    { t: "Até 10%", p: 0 },
    { t: "10% a 30%", p: 1 },
    { t: "Mais de 30%", p: 3 }
  ]}
];

app.get("/compliance/suitability/perguntas", (_, res) => {
  const publicas = PERGUNTAS_SUITABILITY.map(p => ({
    id: p.id, texto: p.texto,
    respostas: p.respostas.map(r => r.t)
  }));
  res.json(publicas);
});

app.post("/compliance/suitability", authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { respostas } = req.body;
    if (!Array.isArray(respostas) || respostas.length !== PERGUNTAS_SUITABILITY.length) {
      return res.status(400).json({ erro: "Responda todas as perguntas" });
    }
    let pontuacao = 0;
    const detalhes = {};
    for (const pergunta of PERGUNTAS_SUITABILITY) {
      const idx = respostas[pergunta.id - 1];
      if (idx === undefined || idx < 0 || idx >= pergunta.respostas.length) {
        return res.status(400).json({ erro: "Resposta inválida" });
      }
      pontuacao += pergunta.respostas[idx].p;
      detalhes[pergunta.id] = pergunta.respostas[idx].t;
    }
    let perfil = "conservador";
    if (pontuacao >= 10) perfil = "arrojado";
    else if (pontuacao >= 5) perfil = "moderado";

    await supabase.from("suitability").upsert({
      uid, perfil, pontuacao, respostas: detalhes, preenchido_em: new Date()
    }, { onConflict: "uid" });
    await supabase.from("usuarios").update({ suitability_feito: true }).eq("id", uid);
    res.json({ ok: true, perfil, pontuacao });
  } catch (e) {
    res.status(500).json({ erro: "Erro ao processar suitability" });
  }
});

app.get("/compliance/suitability", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("suitability").select("*").eq("uid", req.user.uid).single();
  res.json(data || {});
});

// ========== SUPORTE ==========
app.post("/suporte/criar", authMiddleware, limiterTrades, async (req, res) => {
  const { tipo, assunto, mensagem } = req.body;
  if (!["duvida", "reclamacao", "sugestao", "ouvidoria"].includes(tipo)) {
    return res.status(400).json({ erro: "Tipo inválido" });
  }
  if (!assunto || !mensagem) return res.status(400).json({ erro: "Preencha assunto e mensagem" });
  const { error } = await supabase.from("solicitacoes_suporte").insert({
    uid: req.user.uid,
    tipo,
    assunto: sanitizar(assunto, 200),
    mensagem: sanitizar(mensagem, 2000)
  });
  if (error) return res.status(500).json({ erro: "Erro ao criar solicitação" });
  res.json({ ok: true });
});

app.get("/suporte/lista/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("solicitacoes_suporte")
    .select("*").eq("uid", req.user.uid).order("criado_em", { ascending: false });
  res.json(data || []);
});

// ========== BÔNUS ==========
app.get("/bonus/status", authMiddleware, async (req, res) => {
  const { data: user } = await supabase.from("usuarios")
    .select("bonus_bloqueado, bonus_liberado, rollover_meta, rollover_progresso, bonus_recebido, saldo")
    .eq("id", req.user.uid).single();
  res.json({
    saldo_real: Number(user?.saldo || 0),
    bonus_bloqueado: Number(user?.bonus_bloqueado || 0),
    bonus_liberado: Number(user?.bonus_liberado || 0),
    rollover_meta: Number(user?.rollover_meta || 0),
    rollover_progresso: Number(user?.rollover_progresso || 0),
    rollover_percentual: user?.rollover_meta > 0
      ? Math.min(100, (Number(user.rollover_progresso) / Number(user.rollover_meta)) * 100)
      : 0,
    bonus_recebido: user?.bonus_recebido || false
  });
});

// ========== ROTAS PRINCIPAIS ==========
app.get("/", (_, res) => res.send("API Atlax 🚀"));
app.get("/health", (_, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

app.get("/cotacoes", async (_, res) => {
  const cached = getCache("cotacoes");
  if (cached) return res.json(cached);
  const { data } = await supabase.from("cotacoes").select("*");
  const mapa = {};
  data.forEach(c => {
    mapa[c.ticker] = { preco: c.preco, variacao: c.variacao };
  });
  setCache("cotacoes", mapa, 60);
  res.json(mapa);
});

app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("usuarios")
    .select("saldo, bonus_bloqueado, bonus_liberado, rollover_meta, rollover_progresso")
    .eq("id", req.user.uid).single();
  res.json({
    saldo: data?.saldo ?? 0,
    bonus_bloqueado: data?.bonus_bloqueado ?? 0,
    bonus_liberado: data?.bonus_liberado ?? 0,
    rollover_meta: data?.rollover_meta ?? 0,
    rollover_progresso: data?.rollover_progresso ?? 0
  });
});

app.get("/extrato/:uid", authMiddleware, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const { data, count } = await supabase.from("transactions")
    .select("*", { count: "exact" })
    .eq("uid", req.user.uid)
    .order("criado_em", { ascending: false })
    .range(offset, offset + limit - 1);
  res.json({ transacoes: data || [], total: count || 0, limit, offset });
});

app.get("/perfil/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("usuarios").select("*").eq("id", req.user.uid).single();
  res.json(data || {});
});

app.put("/perfil/:uid", authMiddleware, async (req, res) => {
  const { nome, email, telefone, bio, foto } = req.body;
  const updates = {};
  if (nome !== undefined) {
    const n = sanitizar(nome, 100);
    if (!n) return res.status(400).json({ erro: "Nome inválido" });
    updates.nome = n;
  }
  if (email !== undefined) {
    if (!validarEmail(email)) return res.status(400).json({ erro: "Email inválido" });
    updates.email = sanitizar(email, 200);
  }
  if (telefone !== undefined) {
    if (!validarTelefone(telefone)) return res.status(400).json({ erro: "Telefone inválido" });
    updates.telefone = sanitizar(telefone, 20);
  }
  if (bio !== undefined) updates.bio = sanitizar(bio, 500);
  if (foto !== undefined) {
    if (typeof foto !== "string" || !foto.startsWith("data:image/")) {
      return res.status(400).json({ erro: "Foto inválida" });
    }
    updates.foto = foto.slice(0, 500000);
  }
  const { error } = await supabase.from("usuarios").update(updates).eq("id", req.user.uid);
  if (error) return res.status(500).json({ erro: "Erro ao atualizar perfil" });
  res.json({ ok: true });
});

app.post("/email/verificado", authMiddleware, async (req, res) => {
  try {
    await supabase.from("usuarios").update({ email_verificado: true }).eq("id", req.user.uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: "Erro ao marcar email" });
  }
});

// ========== DEPÓSITO PIX (COM BÔNUS) ==========
app.post("/deposito", authMiddleware, limiterTrades, async (req, res) => {
  try {
    const comp = await verificarCompliance(req.user.uid);
    if (!comp.ok) return res.status(403).json({ erro: comp.erro });
    if (!payment) return res.status(500).json({ erro: "Método indisponível" });
    const { valor } = req.body;
    if (!validarValor(valor)) return res.status(400).json({ erro: "Valor inválido" });
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
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "Método indisponível" });
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
        // 🎁 Aplicar bônus se for o primeiro depósito
        await processarBonusPrimeiroDeposito(uid, valorLiquido);
        saldoAtualizado = novoSaldo;
      }
    }
    res.json({ status: pagamento.status, amount: pagamento.transaction_amount, saldo: saldoAtualizado });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao verificar" });
  }
});

// ========== SAQUE ==========
app.post("/saque", authMiddleware, limiterTrades, async (req, res) => {
  try {
    const comp = await verificarCompliance(req.user.uid, true);
    if (!comp.ok) return res.status(403).json({ erro: comp.erro });
    const { valor, pix } = req.body;
    const uid = req.user.uid;
    const valorSaque = Number(valor);
    if (!valorSaque || valorSaque < SAQUE_MINIMO) {
      return res.status(400).json({ erro: `Mínimo R$ ${SAQUE_MINIMO}` });
    }
    if (!validarChavePix(pix)) {
      return res.status(400).json({ erro: "Chave PIX inválida" });
    }
    const taxa = valorSaque * TAXA_SAQUE;
    const valorTotal = valorSaque + taxa;
    const { data: user } = await supabase.from("usuarios").select("saldo, bonus_bloqueado").eq("id", uid).single();
    if (!user || user.saldo < valorTotal) {
      return res.status(400).json({
        erro: `Saldo real insuficiente. Você tem R$ ${Number(user?.saldo || 0).toFixed(2)} disponível. Seu bônus de R$ ${Number(user?.bonus_bloqueado || 0).toFixed(2)} só é liberado após completar o rollover.`
      });
    }
    const novoSaldo = user.saldo - valorTotal;
    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("transactions").insert([
      { uid, tipo: "saque", valor: valorSaque, status: "pendente", categoria: sanitizar(pix, 100) },
      { uid: "admin", tipo: "taxa_saque", valor: taxa, status: "aprovado", categoria: "taxa" }
    ]);
    res.json({ ok: true, taxa, valorLiquido: valorSaque, valorTotal });
  } catch (e) {
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ========== INVESTIR (genérico) ==========
app.post("/investir", authMiddleware, limiterTrades, async (req, res) => {
  try {
    const comp = await verificarCompliance(req.user.uid);
    if (!comp.ok) return res.status(403).json({ erro: comp.erro });
    const { tipo, valor } = req.body;
    const uid = req.user.uid;
    if (!tipo || !validarValor(valor)) return res.status(400).json({ erro: "Valor inválido" });
    const { data, error } = await supabase.rpc("realizar_investimento", {
      p_uid: uid, p_tipo: tipo.toLowerCase().replace(/\s/g, ""), p_valor: Number(valor)
    });
    if (error) return res.status(500).json({ erro: "Erro no servidor" });
    if (data?.erro) return res.status(400).json({ erro: data.erro });
    await registrarVolumeTrade(uid, Number(valor));
    res.json({ ok: true, novo_saldo: data.novo_saldo });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ========== DEPÓSITO CRIPTO ==========
app.post("/deposito-cripto", authMiddleware, limiterTrades, async (req, res) => {
  try {
    const comp = await verificarCompliance(req.user.uid);
    if (!comp.ok) return res.status(403).json({ erro: comp.erro });
    if (!NOWPAYMENTS_API_KEY) return res.status(500).json({ erro: "Depósito cripto indisponível" });
    const { currency, amount } = req.body;
    const uid = req.user.uid;
    if (!currency || !validarValor(amount)) return res.status(400).json({ erro: "Dados inválidos" });
    const coinId = currency.toLowerCase();
    let precoBRL = 0;
    try {
      const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", { params: { ids: coinId, vs_currencies: "brl" } });
      precoBRL = data[coinId]?.brl;
      if (!precoBRL) throw new Error("Criptomoeda não suportada");
    } catch (e) {
      return res.status(400).json({ erro: "Erro ao obter cotação" });
    }
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
    await processarBonusPrimeiroDeposito(uid, valorReais);
    res.status(200).send("OK");
  } catch (err) {
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ========== FUNDOS ==========
app.get("/fundos", async (_, res) => {
  const cached = getCache("fundos");
  if (cached) return res.json(cached);
  const { data } = await supabase.from("fundos").select("*").eq("ativo", true);
  setCache("fundos", data || [], 120);
  res.json(data || []);
});

app.get("/ativos", async (req, res) => {
  const { tipo } = req.query;
  const cacheKey = `ativos_${tipo || "todos"}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  let query = supabase.from("fundos").select("*").eq("ativo", true);
  if (tipo) query = query.eq("tipo", tipo);
  const { data } = await query;
  setCache(cacheKey, data || [], 120);
  res.json(data || []);
});

app.get("/carteira/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("investimentos").select("*, fundos(*)").eq("uid", req.user.uid).eq("status", "ativo");
  res.json(data || []);
});

// ========== RENDA FIXA ==========
app.post("/renda-fixa/aplicar", authMiddleware, limiterTrades, async (req, res) => {
  const comp = await verificarCompliance(req.user.uid);
  if (!comp.ok) return res.status(403).json({ erro: comp.erro });
  const { ticker, valor } = req.body;
  const uid = req.user.uid;
  if (!ticker || !validarValor(valor)) return res.status(400).json({ erro: "Dados inválidos" });
  const { data: fundo } = await supabase.from("fundos").select("nome, rentabilidade_12m").eq("ticker", ticker).single();
  if (!fundo) return res.status(400).json({ erro: "Ativo não encontrado" });
  const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
  if (!user || user.saldo < valor) return res.status(400).json({ erro: "Saldo insuficiente" });
  const novoSaldo = user.saldo - valor;
  await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
  await supabase.from("renda_fixa_investimentos").insert({
    uid, ticker, nome: fundo.nome, valor_aplicado: valor,
    rentabilidade_contratada: fundo.rentabilidade_12m,
    data_vencimento: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
  });
  await supabase.from("transactions").insert({ uid, tipo: "investimento_rf", valor, status: "aprovado", categoria: ticker });
  await registrarVolumeTrade(uid, Number(valor));
  res.json({ ok: true, novo_saldo: novoSaldo });
});

app.get("/renda-fixa/carteira/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("renda_fixa_investimentos").select("*").eq("uid", req.user.uid).eq("status", "ativo");
  res.json(data || []);
});

app.post("/renda-fixa/resgatar", authMiddleware, limiterTrades, async (req, res) => {
  const { investimento_id } = req.body;
  const uid = req.user.uid;
  const { data: inv } = await supabase.from("renda_fixa_investimentos").select("*").eq("id", investimento_id).eq("uid", uid).single();
  if (!inv) return res.status(400).json({ erro: "Investimento não encontrado" });
  const agora = new Date();
  const dataAplicacao = new Date(inv.data_aplicacao);
  const meses = (agora - dataAplicacao) / (30 * 24 * 60 * 60 * 1000);
  const taxaMensal = Math.pow(1 + inv.rentabilidade_contratada / 100, 1 / 12) - 1;
  const valorAtual = inv.valor_aplicado * Math.pow(1 + taxaMensal, Math.max(0, meses));
  const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
  const novoSaldo = (user?.saldo ?? 0) + valorAtual;
  await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
  await supabase.from("renda_fixa_investimentos").update({ status: "resgatado" }).eq("id", investimento_id);
  await supabase.from("transactions").insert({ uid, tipo: "resgate_rf", valor: valorAtual, status: "aprovado" });
  res.json({ ok: true, valor_resgate: valorAtual.toFixed(2) });
});

// ========== RENDA VARIÁVEL ==========
app.post("/renda-variavel/comprar", authMiddleware, limiterTrades, async (req, res) => {
  const comp = await verificarCompliance(req.user.uid);
  if (!comp.ok) return res.status(403).json({ erro: comp.erro });
  const { ticker, valor } = req.body;
  const uid = req.user.uid;
  if (!ticker || !validarValor(valor)) return res.status(400).json({ erro: "Dados inválidos" });
  if (!BRAPI_API_KEY) return res.status(500).json({ erro: "Serviço indisponível" });
  try {
    const { data } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, { params: { token: BRAPI_API_KEY } });
    const preco = data?.results?.[0]?.regularMarketPrice;
    if (!preco) return res.status(400).json({ erro: "Ativo não encontrado" });
    const quantidade = valor / preco;
    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    if (!user || user.saldo < valor) return res.status(400).json({ erro: "Saldo insuficiente" });
    const novoSaldo = user.saldo - valor;
    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("renda_variavel_investimentos").insert({ uid, ticker, nome: ticker, quantidade, preco_medio: preco, valor_investido: valor });
    await supabase.from("transactions").insert({ uid, tipo: "investimento_rv", valor, status: "aprovado", categoria: ticker });
    await registrarVolumeTrade(uid, Number(valor));
    res.json({ ok: true, novo_saldo: novoSaldo, quantidade, preco });
  } catch (e) {
    res.status(500).json({ erro: "Erro ao obter cotação" });
  }
});

app.get("/renda-variavel/carteira/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("renda_variavel_investimentos").select("*").eq("uid", req.user.uid).eq("status", "ativo");
  res.json(data || []);
});

app.post("/renda-variavel/vender", authMiddleware, limiterTrades, async (req, res) => {
  const { investimento_id } = req.body;
  const uid = req.user.uid;
  const { data: inv } = await supabase.from("renda_variavel_investimentos").select("*").eq("id", investimento_id).eq("uid", uid).single();
  if (!inv) return res.status(400).json({ erro: "Investimento não encontrado" });
  if (!BRAPI_API_KEY) return res.status(500).json({ erro: "Serviço indisponível" });
  try {
    const { data } = await axios.get(`https://brapi.dev/api/quote/${inv.ticker}`, { params: { token: BRAPI_API_KEY } });
    const precoAtual = data?.results?.[0]?.regularMarketPrice;
    if (!precoAtual) return res.status(400).json({ erro: "Erro ao obter cotação" });
    const valorVenda = precoAtual * inv.quantidade;
    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    const novoSaldo = (user?.saldo ?? 0) + valorVenda;
    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("renda_variavel_investimentos").update({ status: "vendido" }).eq("id", investimento_id);
    await supabase.from("transactions").insert({ uid, tipo: "venda_rv", valor: valorVenda, status: "aprovado", categoria: inv.ticker });
    await registrarVolumeTrade(uid, Number(valorVenda));
    res.json({ ok: true, valor_venda: valorVenda.toFixed(2) });
  } catch (e) {
    res.status(500).json({ erro: "Erro ao processar venda" });
  }
});

// ========== FUNDOS (aplicar/resgatar) ==========
app.post("/fundos/aplicar", authMiddleware, limiterTrades, async (req, res) => {
  const comp = await verificarCompliance(req.user.uid);
  if (!comp.ok) return res.status(403).json({ erro: comp.erro });
  const { fundo_id, valor } = req.body;
  const uid = req.user.uid;
  if (!fundo_id || !validarValor(valor)) return res.status(400).json({ erro: "Dados inválidos" });
  const { data: fundo } = await supabase.from("fundos").select("*").eq("id", fundo_id).single();
  if (!fundo) return res.status(400).json({ erro: "Fundo não encontrado" });
  const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
  if (!user || user.saldo < valor) return res.status(400).json({ erro: "Saldo insuficiente" });
  const cotas = valor / 100;
  const novoSaldo = user.saldo - valor;
  await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
  await supabase.from("fundos_investimentos").insert({ uid, fundo_id, cotas, valor_aplicado: valor, valor_atual: valor, rentabilidade: 0, status: "ativo" });
  await supabase.from("transactions").insert({ uid, tipo: "investimento_fundos", valor, status: "aprovado", categoria: fundo.nome });
  await registrarVolumeTrade(uid, Number(valor));
  res.json({ ok: true, novo_saldo: novoSaldo });
});

app.get("/fundos/carteira/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("fundos_investimentos").select("*, fundos(*)").eq("uid", req.user.uid).eq("status", "ativo");
  res.json(data || []);
});

app.post("/fundos/resgatar", authMiddleware, limiterTrades, async (req, res) => {
  const { investimento_id, cotas_a_resgatar } = req.body;
  const uid = req.user.uid;
  const { data: inv } = await supabase.from("fundos_investimentos").select("*").eq("id", investimento_id).eq("uid", uid).single();
  if (!inv) return res.status(400).json({ erro: "Investimento não encontrado" });
  if (inv.cotas < cotas_a_resgatar) return res.status(400).json({ erro: "Cotas insuficientes" });
  const valorPorCota = inv.valor_atual / inv.cotas;
  const valorResgate = valorPorCota * cotas_a_resgatar;
  const novasCotas = inv.cotas - cotas_a_resgatar;
  const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
  const novoSaldo = (user?.saldo ?? 0) + valorResgate;
  await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
  if (novasCotas <= 0) {
    await supabase.from("fundos_investimentos").update({ status: "resgatado", cotas: 0 }).eq("id", investimento_id);
  } else {
    const novoValorAplicado = inv.valor_aplicado - valorResgate;
    const novoValorAtual = novasCotas * valorPorCota;
    await supabase.from("fundos_investimentos").update({
      cotas: novasCotas,
      valor_aplicado: novoValorAplicado,
      valor_atual: novoValorAtual
    }).eq("id", investimento_id);
  }
  await supabase.from("transactions").insert({ uid, tipo: "resgate_fundos", valor: valorResgate, status: "aprovado" });
  res.json({ ok: true, valor_resgate: valorResgate.toFixed(2) });
});

// ========== CRIPTO ==========
app.post("/cripto/comprar", authMiddleware, limiterTrades, async (req, res) => {
  const comp = await verificarCompliance(req.user.uid);
  if (!comp.ok) return res.status(403).json({ erro: comp.erro });
  const { ticker, valor } = req.body;
  const uid = req.user.uid;
  if (!ticker || !validarValor(valor)) return res.status(400).json({ erro: "Dados inválidos" });
  try {
    const coinId = MAPA_CRIPTO[ticker.toUpperCase()] || ticker.toLowerCase();
    const { data: precoData } = await axios.get("https://api.coingecko.com/api/v3/simple/price", { params: { ids: coinId, vs_currencies: "brl" } });
    const preco = precoData[coinId]?.brl;
    if (!preco) return res.status(400).json({ erro: "Cripto não suportada" });
    const quantidade = valor / preco;
    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    if (!user || user.saldo < valor) return res.status(400).json({ erro: "Saldo insuficiente" });
    const novoSaldo = user.saldo - valor;
    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("cripto_investimentos").insert({
      uid,
      ticker: ticker.toUpperCase(),
      nome: ticker.toUpperCase(),
      quantidade_cripto: quantidade,
      preco_medio: preco,
      valor_investido: valor
    });
    await supabase.from("transactions").insert({ uid, tipo: "investimento_cripto", valor, status: "aprovado", categoria: ticker.toUpperCase() });
    await registrarVolumeTrade(uid, Number(valor));
    res.json({ ok: true, novo_saldo: novoSaldo, quantidade, preco });
  } catch (e) {
    res.status(500).json({ erro: "Erro ao obter cotação" });
  }
});

app.get("/cripto/carteira/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("cripto_investimentos").select("*").eq("uid", req.user.uid).eq("status", "ativo");
  res.json(data || []);
});

app.post("/cripto/vender", authMiddleware, limiterTrades, async (req, res) => {
  const { investimento_id } = req.body;
  const uid = req.user.uid;
  const { data: inv } = await supabase.from("cripto_investimentos").select("*").eq("id", investimento_id).eq("uid", uid).single();
  if (!inv) return res.status(400).json({ erro: "Investimento não encontrado" });
  try {
    const coinId = MAPA_CRIPTO[inv.ticker] || inv.ticker.toLowerCase();
    const { data: precoData } = await axios.get("https://api.coingecko.com/api/v3/simple/price", { params: { ids: coinId, vs_currencies: "brl" } });
    const precoAtual = precoData[coinId]?.brl;
    if (!precoAtual) return res.status(400).json({ erro: "Erro ao obter cotação" });
    const valorVenda = precoAtual * inv.quantidade_cripto;
    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
    const novoSaldo = (user?.saldo ?? 0) + valorVenda;
    await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
    await supabase.from("cripto_investimentos").update({ status: "vendido" }).eq("id", investimento_id);
    await supabase.from("transactions").insert({ uid, tipo: "venda_cripto", valor: valorVenda, status: "aprovado", categoria: inv.ticker });
    await registrarVolumeTrade(uid, Number(valorVenda));
    res.json({ ok: true, valor_venda: valorVenda.toFixed(2) });
  } catch (e) {
    res.status(500).json({ erro: "Erro ao processar venda" });
  }
});

// ========== MOTOR DE ORDENS AUTOMÁTICAS ==========
async function executarOrdensAutomaticas() {
  console.log("⏳ [ORDENS] Verificando ordens automáticas...");
  try {
    const { data: ordens } = await supabase.from("ordens_automaticas")
      .select("*, fundos(*)")
      .eq("ativo", true)
      .is("processando_desde", null);
    if (!ordens || ordens.length === 0) {
      console.log("  📭 Nenhuma ordem ativa.");
      return;
    }
    for (const ordem of ordens) {
      const { data: lockOk } = await supabase.from("ordens_automaticas")
        .update({ processando_desde: new Date() })
        .eq("id", ordem.id).is("processando_desde", null)
        .select().single();
      if (!lockOk) continue;
      try {
        const uid = ordem.uid;
        const fundo = ordem.fundos;
        if (!fundo) continue;
        const ticker = fundo.ticker;
        const tipo = ordem.tipo;
        const rentabilidadeAlvo = ordem.rentabilidade_acionadora;
        const [rvRes, criptoRes] = await Promise.all([
          supabase.from("renda_variavel_investimentos").select("*").eq("uid", uid).eq("ticker", ticker).eq("status", "ativo").single(),
          supabase.from("cripto_investimentos").select("*").eq("uid", uid).eq("ticker", ticker).eq("status", "ativo").single()
        ]);
        const investimentoRV = rvRes.data;
        const investimentoCripto = criptoRes.data;
        let precoAtual = null, precoMedio = null, quantidade = null, investimentoId = null, tipoCarteira = null;
        if (investimentoRV) {
          tipoCarteira = "rv";
          precoMedio = investimentoRV.preco_medio;
          quantidade = investimentoRV.quantidade;
          investimentoId = investimentoRV.id;
          if (BRAPI_API_KEY) {
            try {
              const { data: cotData } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, { params: { token: BRAPI_API_KEY } });
              precoAtual = cotData?.results?.[0]?.regularMarketPrice;
            } catch (e) {}
          }
        } else if (investimentoCripto) {
          tipoCarteira = "cripto";
          precoMedio = investimentoCripto.preco_medio;
          quantidade = investimentoCripto.quantidade_cripto;
          investimentoId = investimentoCripto.id;
          const coinId = MAPA_CRIPTO[ticker.toUpperCase()] || ticker.toLowerCase();
          try {
            const { data: cgData } = await axios.get("https://api.coingecko.com/api/v3/simple/price", { params: { ids: coinId, vs_currencies: "brl" } });
            precoAtual = cgData[coinId]?.brl;
          } catch (e) {}
        }
        if (!investimentoId || !precoAtual || !precoMedio) {
          await supabase.from("ordens_automaticas").update({ processando_desde: null }).eq("id", ordem.id);
          continue;
        }
        const rentabilidadeAtual = ((precoAtual - precoMedio) / precoMedio) * 100;
        let executar = false;
        if (tipo === "stop_loss" && rentabilidadeAtual <= -Math.abs(rentabilidadeAlvo)) executar = true;
        else if (tipo === "stop_gain" && rentabilidadeAtual >= rentabilidadeAlvo) executar = true;
        if (executar) {
          const valorVenda = precoAtual * quantidade;
          const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
          const novoSaldo = (user?.saldo ?? 0) + valorVenda;
          await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
          if (tipoCarteira === "rv") {
            await supabase.from("renda_variavel_investimentos").update({ status: "vendido" }).eq("id", investimentoId);
            await supabase.from("transactions").insert({ uid, tipo: "venda_rv_auto", valor: valorVenda, status: "aprovado", categoria: `${ticker} (${tipo})` });
          } else {
            await supabase.from("cripto_investimentos").update({ status: "vendido" }).eq("id", investimentoId);
            await supabase.from("transactions").insert({ uid, tipo: "venda_cripto_auto", valor: valorVenda, status: "aprovado", categoria: `${ticker} (${tipo})` });
          }
          await registrarVolumeTrade(uid, Number(valorVenda));
          await supabase.from("ordens_automaticas").update({
            ativo: false, status: "executada", data_execucao: new Date(),
            preco_execucao: precoAtual, rentabilidade_execucao: rentabilidadeAtual,
            processando_desde: null
          }).eq("id", ordem.id);
        } else {
          await supabase.from("ordens_automaticas").update({ processando_desde: null }).eq("id", ordem.id);
        }
      } catch (e) {
        await supabase.from("ordens_automaticas").update({ processando_desde: null }).eq("id", ordem.id);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log("✅ [ORDENS] Verificação concluída.");
  } catch (e) {
    console.error("❌ [ORDENS] Erro geral:", e.message);
  }
}

app.get("/ordens-automaticas/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("ordens_automaticas")
    .select("*, fundos(nome, ticker)")
    .eq("uid", req.user.uid)
    .order("criado_em", { ascending: false });
  for (const ordem of data || []) {
    if (ordem.ativo && ordem.fundos?.ticker) {
      const ticker = ordem.fundos.ticker;
      const [invRV, invCripto] = await Promise.all([
        supabase.from("renda_variavel_investimentos").select("preco_medio").eq("uid", req.user.uid).eq("ticker", ticker).eq("status", "ativo").single(),
        supabase.from("cripto_investimentos").select("preco_medio").eq("uid", req.user.uid).eq("ticker", ticker).eq("status", "ativo").single()
      ]);
      const inv = invRV.data || invCripto.data;
      if (inv?.preco_medio) {
        try {
          let precoAtual = null;
          if (invRV.data && BRAPI_API_KEY) {
            const { data: cot } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, { params: { token: BRAPI_API_KEY } });
            precoAtual = cot?.results?.[0]?.regularMarketPrice;
          } else {
            const coinId = MAPA_CRIPTO[ticker.toUpperCase()] || ticker.toLowerCase();
            const { data: cg } = await axios.get("https://api.coingecko.com/api/v3/simple/price", { params: { ids: coinId, vs_currencies: "brl" } });
            precoAtual = cg[coinId]?.brl;
          }
          if (precoAtual) {
            ordem._rentabilidadeAtual = (((precoAtual - inv.preco_medio) / inv.preco_medio) * 100).toFixed(2);
            ordem._precoAtual = precoAtual;
          }
        } catch (e) {}
      }
    }
  }
  res.json(data || []);
});

app.post("/ordem-automatica", authMiddleware, limiterTrades, async (req, res) => {
  const { fundo_id, tipo, rentabilidade_acionadora } = req.body;
  if (!fundo_id || !tipo || !rentabilidade_acionadora) return res.status(400).json({ erro: "Dados inválidos" });
  const { error } = await supabase.from("ordens_automaticas").insert({ uid: req.user.uid, fundo_id, tipo, rentabilidade_acionadora });
  if (error) return res.status(500).json({ erro: "Erro ao criar ordem" });
  res.json({ ok: true });
});

app.delete("/ordem-automatica/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("ordens_automaticas").update({ ativo: false }).eq("id", req.params.id).eq("uid", req.user.uid);
  if (error) return res.status(500).json({ erro: "Erro ao cancelar" });
  res.json({ ok: true });
});

// ========== APORTES ==========
app.get("/aportes-automaticos/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("aportes_automaticos").select("*, fundos(nome, ticker)").eq("uid", req.user.uid).eq("ativo", true);
  res.json(data || []);
});

app.post("/aporte-automatico", authMiddleware, limiterTrades, async (req, res) => {
  const { fundo_id, valor, periodicidade, dia_do_mes } = req.body;
  if (!fundo_id || !validarValor(valor)) return res.status(400).json({ erro: "Dados inválidos" });
  const { error } = await supabase.from("aportes_automaticos").insert({ uid: req.user.uid, fundo_id, valor, periodicidade, dia_do_mes });
  if (error) return res.status(500).json({ erro: "Erro ao criar aporte" });
  res.json({ ok: true });
});

app.delete("/aporte-automatico/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("aportes_automaticos").update({ ativo: false }).eq("id", req.params.id).eq("uid", req.user.uid);
  if (error) return res.status(500).json({ erro: "Erro ao cancelar" });
  res.json({ ok: true });
});

// ========== COMPARADOR ==========
app.get("/comparar-fundos", async (req, res) => {
  const tickers = req.query.tickers?.split(",") || [];
  const cacheKey = `comparar_${tickers.sort().join("_")}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  const { data } = await supabase.from("fundos").select("*").in("ticker", tickers).eq("ativo", true);
  setCache(cacheKey, data || [], 120);
  res.json(data || []);
});

// ========== INDICADORES ==========
app.get("/indicadores", async (_, res) => {
  const cached = getCache("indicadores");
  if (cached) return res.json(cached);
  const ind = [];
  try {
    const selicRes = await axios.get("https://api.bcb.gov.br/dados/serie/bcdata.sgs.4189/dados/ultimos/1?formato=json");
    const selic = selicRes.data?.[0]?.valor;
    if (selic) {
      const s = parseFloat(selic.replace(",", "."));
      ind.push({ nome: "SELIC", valor: `${s.toFixed(2)}%`, var: "estável", positivo: true });
      ind.push({ nome: "CDI", valor: `${(s - 0.10).toFixed(2)}%`, var: "+0,02%", positivo: true });
    } else throw new Error("Vazio");
  } catch (e) {
    ind.push({ nome: "SELIC", valor: "10,50%", var: "estável", positivo: true });
    ind.push({ nome: "CDI", valor: "10,40%", var: "+0,02%", positivo: true });
  }
  try {
    const ipcaRes = await axios.get("https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados/ultimos/1?formato=json");
    const ipca = ipcaRes.data?.[0]?.valor || "0,38";
    ind.push({ nome: "IPCA", valor: `${ipca}%`, var: "-0,05%", positivo: false });
  } catch (e) {
    ind.push({ nome: "IPCA", valor: "0,38%", var: "-0,05%", positivo: false });
  }
  const { data: cotacoes } = await supabase.from("cotacoes").select("*");
  const mapa = {};
  if (cotacoes) cotacoes.forEach(c => {
    mapa[c.ticker] = { preco: c.preco, variacao: c.variacao };
  });
  const ibov = mapa["IBOV"] || { preco: 128500, variacao: 0.82 };
  ind.push({ nome: "IBOV", valor: ibov.preco.toLocaleString("pt-BR"), var: `${ibov.variacao >= 0 ? '+' : ''}${ibov.variacao.toFixed(2)}%`, positivo: ibov.variacao >= 0 });
  const ifix = mapa["IFIX"] || { preco: 3150, variacao: 0.35 };
  ind.push({ nome: "IFIX", valor: ifix.preco.toFixed(0), var: `${ifix.variacao >= 0 ? '+' : ''}${ifix.variacao.toFixed(2)}%`, positivo: ifix.variacao >= 0 });
  const usd = mapa["USDBRL"] || { preco: 5.12, variacao: -0.34 };
  ind.push({ nome: "Dólar", valor: `R$ ${usd.preco.toFixed(2)}`, var: `${usd.variacao >= 0 ? '+' : ''}${usd.variacao.toFixed(2)}%`, positivo: usd.variacao >= 0 });
  setCache("indicadores", ind, 300);
  res.json(ind);
});

// ========== NOTÍCIAS ==========
app.get("/noticias", async (_, res) => {
  const cached = getCache("noticias");
  if (cached) return res.json(cached);
  let noticias = null;
  if (process.env.NEWS_API_KEY) {
    try {
      const response = await axios.get("https://newsapi.org/v2/top-headlines", {
        params: { country: "br", category: "business", apiKey: process.env.NEWS_API_KEY }
      });
      const lista = response.data.articles.slice(0, 5).map(a => ({
        titulo: a.title,
        fonte: a.source.name,
        resumo: a.description || "Clique para ler mais"
      }));
      if (lista.length > 0) noticias = lista;
    } catch (e) {}
  }
  if (!noticias) {
    noticias = [
      { titulo: "Ibovespa fecha em alta com expectativa de cortes na SELIC", fonte: "InfoMoney", resumo: "Índice renovou máxima com fluxo estrangeiro positivo." },
      { titulo: "S&P 500 atinge novo recorde histórico", fonte: "Valor Econômico", resumo: "Big techs lideram ganhos." },
      { titulo: "Dólar recua com entrada de capital", fonte: "Reuters", resumo: "Moeda americana acumula queda." },
      { titulo: "Petrobras anuncia dividendos bilionários", fonte: "Exame", resumo: "R$ 15 bilhões aos acionistas." }
    ];
  }
  setCache("noticias", noticias, 600);
  res.json(noticias);
});

app.get("/historico-cdi", async (_, res) => {
  const cached = getCache("historico-cdi");
  if (cached) return res.json(cached);
  const fallback = {
    labels: ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"],
    data: [100, 100.82, 101.65, 102.49, 103.34, 104.20, 105.07, 105.95, 106.84, 107.74, 108.65, 109.57]
  };
  if (!BRAPI_API_KEY) {
    setCache("historico-cdi", fallback, 3600);
    return res.json(fallback);
  }
  try {
    const response = await axios.get("https://brapi.dev/api/v2/prime-rate", {
      params: {
        token: BRAPI_API_KEY, country: "brazil", historical: true,
        start: `${new Date().getFullYear() - 1}-01-01`,
        end: `${new Date().getFullYear()}-12-31`
      }
    });
    const rates = response.data?.prime_rate || [];
    if (rates.length > 0) {
      const sorted = rates.sort((a, b) => new Date(a.date) - new Date(b.date));
      const ultimos12 = sorted.slice(-12);
      let acumulado = 100;
      const labels = [];
      const data = [acumulado];
      ultimos12.forEach((item, index) => {
        if (index > 0) {
          const taxa = item.value / 100;
          acumulado = acumulado * (1 + taxa);
          data.push(parseFloat(acumulado.toFixed(2)));
        }
        labels.push(new Date(item.date + "T00:00:00").toLocaleString("pt-BR", { month: "short" }));
      });
      const resultado = { labels, data };
      setCache("historico-cdi", resultado, 3600);
      return res.json(resultado);
    }
  } catch (e) {}
  setCache("historico-cdi", fallback, 3600);
  res.json(fallback);
});

app.get("/historico-ibov", async (_, res) => {
  const cached = getCache("historico-ibov");
  if (cached) return res.json(cached);
  const fallback = {
    labels: ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"],
    data: [125000, 126000, 124000, 128000, 130000, 128000, 131000, 129000, 132000, 130000, 128500, 128500]
  };
  if (!BRAPI_API_KEY) {
    setCache("historico-ibov", fallback, 3600);
    return res.json(fallback);
  }
  try {
    const response = await axios.get("https://brapi.dev/api/quote/%5EBVSP", {
      params: { token: BRAPI_API_KEY, range: "1y", interval: "1mo" }
    });
    const results = response.data?.results?.[0];
    if (results?.historicalDataPrice && results.historicalDataPrice.length > 0) {
      const historico = results.historicalDataPrice.slice(-12);
      const labels = historico.map(item => new Date(item.date * 1000).toLocaleString("pt-BR", { month: "short" }));
      const data = historico.map(item => item.close);
      const resultado = { labels, data };
      setCache("historico-ibov", resultado, 3600);
      return res.json(resultado);
    }
  } catch (e) {}
  setCache("historico-ibov", fallback, 3600);
  res.json(fallback);
});

app.get("/taxas-renda-fixa", async (_, res) => {
  const cached = getCache("taxas-renda-fixa");
  if (cached) return res.json(cached);
  let selic = 10.50, cdi = 10.40;
  try {
    const selicRes = await axios.get("https://api.bcb.gov.br/dados/serie/bcdata.sgs.4189/dados/ultimos/1?formato=json");
    const s = selicRes.data?.[0]?.valor;
    if (s) {
      selic = parseFloat(s.replace(",", "."));
      cdi = selic - 0.10;
    }
  } catch (e) {}
  const resultado = {
    selic: parseFloat(selic.toFixed(2)),
    cdi: parseFloat(cdi.toFixed(2)),
    taxas: {
      cdb_100: parseFloat((cdi * 1.0).toFixed(2)),
      cdb_110: parseFloat((cdi * 1.1).toFixed(2)),
      cdb_120: parseFloat((cdi * 1.2).toFixed(2)),
      tesouro_selic: parseFloat((selic * 1.0).toFixed(2)),
      tesouro_ipca: parseFloat((5.5 + 0.38).toFixed(2)),
      lci_90: parseFloat((cdi * 0.9).toFixed(2)),
      lca_92: parseFloat((cdi * 0.92).toFixed(2)),
      cri_ipca: parseFloat((6.5 + 0.38).toFixed(2)),
      cra_cdi: parseFloat((cdi * 1.02).toFixed(2)),
      deb_infra: parseFloat((cdi * 1.15).toFixed(2)),
      deb_energia: parseFloat((cdi * 1.1).toFixed(2))
    }
  };
  setCache("taxas-renda-fixa", resultado, 300);
  res.json(resultado);
});

app.get("/trade/cotacao/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const cacheKey = `trade_cotacao_${ticker}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  if (BRAPI_API_KEY) {
    try {
      const { data } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, { params: { token: BRAPI_API_KEY } });
      const result = data?.results?.[0];
      if (result?.regularMarketPrice) {
        const resp = {
          preco: result.regularMarketPrice,
          variacao: result.regularMarketChangePercent || 0,
          high: result.regularMarketDayHigh || 0,
          low: result.regularMarketDayLow || 0,
          volume: result.regularMarketVolume || 0
        };
        setCache(cacheKey, resp, 30);
        return res.json(resp);
      }
    } catch (e) {}
  }
  const coinId = MAPA_CRIPTO[ticker] || ticker.toLowerCase();
  try {
    const [priceRes, marketRes] = await Promise.all([
      axios.get("https://api.coingecko.com/api/v3/simple/price", {
        params: { ids: coinId, vs_currencies: "brl", include_24hr_change: "true" }
      }),
      axios.get("https://api.coingecko.com/api/v3/coins/markets", {
        params: { vs_currency: "brl", ids: coinId, per_page: 1 }
      })
    ]);
    const preco = priceRes.data[coinId]?.brl || 0;
    const variacao = priceRes.data[coinId]?.brl_24h_change || 0;
    const m = marketRes.data[0] || {};
    const resp = { preco, variacao, high: m.high_24h || 0, low: m.low_24h || 0, volume: m.total_volume || 0 };
    setCache(cacheKey, resp, 30);
    return res.json(resp);
  } catch (e) {}
  res.json({ preco: 0, variacao: 0, high: 0, low: 0, volume: 0 });
});

app.get("/trade/historico/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const range = parseInt(req.query.range) || 365;
  const cacheKey = `trade_hist_${ticker}_${range}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  if (BRAPI_API_KEY) {
    try {
      const { data } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, {
        params: { token: BRAPI_API_KEY, range: `${Math.floor(range / 30)}mo`, interval: "1d" }
      });
      const result = data?.results?.[0];
      if (result?.historicalDataPrice) {
        const ohlc = result.historicalDataPrice.map(item => [item.date * 1000, item.open, item.high, item.low, item.close]);
        setCache(cacheKey, ohlc, 600);
        return res.json(ohlc);
      }
    } catch (e) {}
  }
  const coinId = MAPA_CRIPTO[ticker] || ticker.toLowerCase();
  try {
    const { data } = await axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`, {
      params: { vs_currency: "brl", days: Math.min(range, 365) }
    });
    setCache(cacheKey, data || [], 600);
    return res.json(data || []);
  } catch (e) {}
  res.json([]);
});

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

app.get("/coins/:uid", authMiddleware, async (req, res) => {
  const { data: user } = await supabase.from("usuarios").select("atlax_coins").eq("id", req.user.uid).single();
  res.json({ coins: user?.atlax_coins ?? 0 });
});

app.post("/coins/adicionar", authMiddleware, limiterTrades, async (req, res) => {
  const { quantidade, motivo } = req.body;
  const uid = req.user.uid;
  await supabase.from("usuarios").upsert({ id: uid, atlax_coins: 0 }, { onConflict: "id" });
  const { data: user } = await supabase.from("usuarios").select("atlax_coins").eq("id", uid).single();
  const novoSaldo = (user?.atlax_coins ?? 0) + quantidade;
  await supabase.from("usuarios").update({ atlax_coins: novoSaldo }).eq("id", uid);
  await supabase.from("coins").insert({ uid, quantidade, motivo });
  res.json({ ok: true, novo_saldo: novoSaldo });
});

app.post("/coins/resgatar", authMiddleware, limiterTrades, async (req, res) => {
  const { quantidade } = req.body;
  const uid = req.user.uid;
  const { data: user } = await supabase.from("usuarios").select("atlax_coins, saldo").eq("id", uid).single();
  if (!user || (user.atlax_coins || 0) < quantidade) return res.status(400).json({ erro: "Coins insuficientes" });
  const valor_creditado = quantidade * 0.05;
  const novoCoins = (user.atlax_coins || 0) - quantidade;
  const novoSaldo = (user.saldo || 0) + valor_creditado;
  await supabase.from("usuarios").update({ atlax_coins: novoCoins, saldo: novoSaldo }).eq("id", uid);
  await supabase.from("coins").insert({ uid, quantidade: -quantidade, motivo: "resgate" });
  await supabase.from("transactions").insert({ uid, tipo: "resgate_coins", valor: valor_creditado, status: "aprovado", categoria: "coins" });
  res.json({ ok: true, valor_creditado });
});

app.post("/ia/perguntar", authMiddleware, async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ resposta: "IA indisponível" });
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: req.body.mensagem }] }] }
    );
    res.json({ resposta: response.data.candidates[0].content.parts[0].text });
  } catch (e) {
    res.json({ resposta: "Não foi possível responder agora." });
  }
});

app.post("/ia/analisar", authMiddleware, async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ resposta: "IA indisponível" });
  try {
    const { data: user } = await supabase.from("usuarios").select("*").eq("id", req.user.uid).single();
    const { data: transacoes } = await supabase.from("transactions").select("*").eq("uid", req.user.uid).limit(20);
    const prompt = `Analise: saldo R$ ${user.saldo}, transações ${JSON.stringify(transacoes)}. Gere análise + sugestões.`;
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    res.json({ resposta: response.data.candidates[0].content.parts[0].text });
  } catch (e) {
    res.json({ resposta: "Não foi possível analisar agora." });
  }
});

app.get("/ia", async (req, res) => {
  res.json({ resposta: "Faça uma pergunta direta." });
});

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

app.post("/cartao", authMiddleware, limiterTrades, async (req, res) => {
  const { descricao, valor } = req.body;
  const { error } = await supabase.from("transactions").insert({ uid: req.user.uid, tipo: "cartao", valor, status: "pendente", categoria: descricao });
  if (error) return res.status(500).json({ erro: "Erro ao adicionar" });
  res.json({ ok: true });
});

app.post("/belvo/connect-token", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.status(500).json({ erro: "Belvo indisponível" });
  try {
    const response = await axios.post(
      `${BELVO_API_URL}/api/token`,
      {
        id: "atlax-connect",
        password: BELVO_SECRET_PASSWORD,
        scopes: "read_institutions,write_links,read_links,read_accounts,read_transactions,read_credit_cards"
      },
      { auth: BELVO_AUTH }
    );
    res.json({ accessToken: response.data.access });
  } catch (e) {
    res.status(500).json({ erro: "Falha ao gerar token Belvo" });
  }
});

app.get("/belvo/contas/:itemId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.json([]);
  try {
    const response = await axios.get(`${BELVO_API_URL}/api/accounts/?link=${req.params.itemId}`, { auth: BELVO_AUTH });
    res.json(response.data.results || []);
  } catch (e) {
    res.json([]);
  }
});

app.get("/belvo/transacoes/:itemId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.json([]);
  try {
    const response = await axios.get(`${BELVO_API_URL}/api/transactions/?link=${req.params.itemId}`, { auth: BELVO_AUTH });
    res.json(response.data.results || []);
  } catch (e) {
    res.json([]);
  }
});

app.get("/belvo/cartoes-contas/:itemId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.json({ encontradas: false, cartoes: [] });
  try {
    const response = await axios.get(`${BELVO_API_URL}/api/credit-cards/?link=${req.params.itemId}`, { auth: BELVO_AUTH });
    res.json({ encontradas: true, cartoes: response.data.results || [] });
  } catch (e) {
    res.json({ encontradas: false, cartoes: [] });
  }
});

app.get("/belvo/faturas/:linkId/:accountId", authMiddleware, async (req, res) => {
  if (!BELVO_AUTH) return res.json([]);
  try {
    const response = await axios.get(
      `${BELVO_API_URL}/api/transactions/?link=${req.params.linkId}&account=${req.params.accountId}`,
      { auth: BELVO_AUTH }
    );
    res.json(response.data.results || []);
  } catch (e) {
    res.json([]);
  }
});

app.get("/watchlist/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("watchlist")
    .select("*").eq("uid", req.user.uid).order("criado_em", { ascending: false });
  res.json(data || []);
});

app.post("/watchlist/adicionar", authMiddleware, async (req, res) => {
  const { ticker, nome, tipo } = req.body;
  if (!ticker) return res.status(400).json({ erro: "Ticker obrigatório" });
  const { error } = await supabase.from("watchlist").insert({
    uid: req.user.uid,
    ticker: ticker.toUpperCase(),
    nome: sanitizar(nome || ticker, 100),
    tipo: tipo || "acao"
  });
  if (error) {
    if (error.code === "23505") return res.status(400).json({ erro: "Já está na watchlist" });
    return res.status(500).json({ erro: "Erro ao adicionar" });
  }
  res.json({ ok: true });
});

app.delete("/watchlist/:ticker", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("watchlist")
    .delete().eq("uid", req.user.uid).eq("ticker", req.params.ticker.toUpperCase());
  if (error) return res.status(500).json({ erro: "Erro ao remover" });
  res.json({ ok: true });
});

app.get("/alertas/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("alertas_preco")
    .select("*").eq("uid", req.user.uid).order("criado_em", { ascending: false });
  res.json(data || []);
});

app.post("/alerta/criar", authMiddleware, limiterTrades, async (req, res) => {
  const { ticker, nome, preco_alvo, condicao } = req.body;
  if (!ticker || !validarValor(preco_alvo)) return res.status(400).json({ erro: "Dados inválidos" });
  if (!["acima", "abaixo"].includes(condicao)) return res.status(400).json({ erro: "Condição inválida" });
  const { error } = await supabase.from("alertas_preco").insert({
    uid: req.user.uid,
    ticker: ticker.toUpperCase(),
    nome: sanitizar(nome || ticker, 100),
    preco_alvo: Number(preco_alvo),
    condicao
  });
  if (error) return res.status(500).json({ erro: "Erro ao criar alerta" });
  res.json({ ok: true });
});

app.delete("/alerta/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("alertas_preco")
    .delete().eq("id", req.params.id).eq("uid", req.user.uid);
  if (error) return res.status(500).json({ erro: "Erro ao remover" });
  res.json({ ok: true });
});

app.get("/ordens-limitadas/:uid", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("ordens_limitadas")
    .select("*").eq("uid", req.user.uid).order("criado_em", { ascending: false });
  res.json(data || []);
});

app.post("/ordem-limitada/criar", authMiddleware, limiterTrades, async (req, res) => {
  const { ticker, nome, tipo_operacao, preco_limite, valor_ou_quantidade } = req.body;
  if (!ticker || !validarValor(preco_limite) || !validarValor(valor_ou_quantidade)) {
    return res.status(400).json({ erro: "Dados inválidos" });
  }
  if (!["compra", "venda"].includes(tipo_operacao)) {
    return res.status(400).json({ erro: "Tipo inválido" });
  }
  if (tipo_operacao === "compra") {
    const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", req.user.uid).single();
    if (!user || user.saldo < valor_ou_quantidade) {
      return res.status(400).json({ erro: "Saldo insuficiente" });
    }
  } else {
    const { data: inv } = await supabase.from("renda_variavel_investimentos")
      .select("quantidade").eq("uid", req.user.uid).eq("ticker", ticker.toUpperCase()).eq("status", "ativo").single();
    if (!inv || inv.quantidade < valor_ou_quantidade) {
      return res.status(400).json({ erro: "Quantidade insuficiente na carteira" });
    }
  }
  const { error } = await supabase.from("ordens_limitadas").insert({
    uid: req.user.uid,
    ticker: ticker.toUpperCase(),
    nome: sanitizar(nome || ticker, 100),
    tipo_operacao,
    preco_limite: Number(preco_limite),
    valor_ou_quantidade: Number(valor_ou_quantidade)
  });
  if (error) return res.status(500).json({ erro: "Erro ao criar ordem" });
  res.json({ ok: true });
});

app.delete("/ordem-limitada/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase.from("ordens_limitadas")
    .update({ status: "cancelada" }).eq("id", req.params.id).eq("uid", req.user.uid);
  if (error) return res.status(500).json({ erro: "Erro ao cancelar" });
  res.json({ ok: true });
});

async function verificarAlertasPreco() {
  try {
    const { data: alertas } = await supabase.from("alertas_preco").select("*").eq("disparado", false);
    if (!alertas || alertas.length === 0) return;
    for (const alerta of alertas) {
      try {
        const ticker = alerta.ticker;
        let precoAtual = null;
        if (BRAPI_API_KEY) {
          try {
            const { data: cot } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, {
              params: { token: BRAPI_API_KEY }
            });
            precoAtual = cot?.results?.[0]?.regularMarketPrice;
          } catch (e) {}
        }
        if (!precoAtual) {
          const coinId = MAPA_CRIPTO[ticker.toUpperCase()] || ticker.toLowerCase();
          try {
            const { data: cg } = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
              params: { ids: coinId, vs_currencies: "brl" }
            });
            precoAtual = cg[coinId]?.brl;
          } catch (e) {}
        }
        if (!precoAtual) continue;
        let disparar = false;
        if (alerta.condicao === "acima" && precoAtual >= alerta.preco_alvo) disparar = true;
        else if (alerta.condicao === "abaixo" && precoAtual <= alerta.preco_alvo) disparar = true;
        if (disparar) {
          await supabase.from("alertas_preco").update({
            disparado: true,
            data_disparo: new Date(),
            preco_no_disparo: precoAtual
          }).eq("id", alerta.id);
          console.log(`  🔔 Alerta disparado: ${ticker} a R$ ${precoAtual.toFixed(2)}`);
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (e) {
    console.error("❌ [ALERTAS] Erro:", e.message);
  }
}

async function executarOrdensLimitadas() {
  try {
    const { data: ordens } = await supabase.from("ordens_limitadas")
      .select("*").eq("status", "ativa").is("processando_desde", null);
    if (!ordens || ordens.length === 0) return;
    for (const ordem of ordens) {
      const { data: lockOk } = await supabase.from("ordens_limitadas")
        .update({ processando_desde: new Date() })
        .eq("id", ordem.id).is("processando_desde", null)
        .select().single();
      if (!lockOk) continue;
      try {
        const ticker = ordem.ticker;
        let precoAtual = null;
        if (BRAPI_API_KEY) {
          try {
            const { data: cot } = await axios.get(`https://brapi.dev/api/quote/${ticker}`, { params: { token: BRAPI_API_KEY } });
            precoAtual = cot?.results?.[0]?.regularMarketPrice;
          } catch (e) {}
        }
        if (!precoAtual) {
          const coinId = MAPA_CRIPTO[ticker.toUpperCase()] || ticker.toLowerCase();
          try {
            const { data: cg } = await axios.get("https://api.coingecko.com/api/v3/simple/price", { params: { ids: coinId, vs_currencies: "brl" } });
            precoAtual = cg[coinId]?.brl;
          } catch (e) {}
        }
        if (!precoAtual) {
          await supabase.from("ordens_limitadas").update({ processando_desde: null }).eq("id", ordem.id);
          continue;
        }
        let executar = false;
        if (ordem.tipo_operacao === "compra" && precoAtual <= ordem.preco_limite) executar = true;
        else if (ordem.tipo_operacao === "venda" && precoAtual >= ordem.preco_limite) executar = true;
        if (executar) {
          const uid = ordem.uid;
          if (ordem.tipo_operacao === "compra") {
            const valorCompra = ordem.valor_ou_quantidade;
            const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
            if (user && user.saldo >= valorCompra) {
              const quantidade = valorCompra / precoAtual;
              const novoSaldo = user.saldo - valorCompra;
              await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
              await supabase.from("renda_variavel_investimentos").insert({
                uid, ticker, nome: ordem.nome, quantidade, preco_medio: precoAtual, valor_investido: valorCompra
              });
              await supabase.from("transactions").insert({
                uid, tipo: "investimento_rv_limite", valor: valorCompra, status: "aprovado", categoria: `${ticker} (limite)`
              });
              await registrarVolumeTrade(uid, Number(valorCompra));
            }
          } else {
            const quantidade = ordem.valor_ou_quantidade;
            const { data: inv } = await supabase.from("renda_variavel_investimentos")
              .select("*").eq("uid", uid).eq("ticker", ticker).eq("status", "ativo").single();
            if (inv && inv.quantidade >= quantidade) {
              const valorVenda = quantidade * precoAtual;
              const { data: user } = await supabase.from("usuarios").select("saldo").eq("id", uid).single();
              const novoSaldo = (user?.saldo ?? 0) + valorVenda;
              await supabase.from("usuarios").update({ saldo: novoSaldo }).eq("id", uid);
              await supabase.from("renda_variavel_investimentos").update({ status: "vendido" }).eq("id", inv.id);
              await supabase.from("transactions").insert({
                uid, tipo: "venda_rv_limite", valor: valorVenda, status: "aprovado", categoria: `${ticker} (limite)`
              });
              await registrarVolumeTrade(uid, Number(valorVenda));
            }
          }
          await supabase.from("ordens_limitadas").update({
            status: "executada",
            data_execucao: new Date(),
            preco_execucao: precoAtual,
            processando_desde: null
          }).eq("id", ordem.id);
        } else {
          await supabase.from("ordens_limitadas").update({ processando_desde: null }).eq("id", ordem.id);
        }
      } catch (e) {
        await supabase.from("ordens_limitadas").update({ processando_desde: null }).eq("id", ordem.id);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) {
    console.error("❌ [ORDENS LIMITADAS] Erro:", e.message);
  }
}

app.use((req, res) => {
  res.status(404).json({ erro: "Rota não encontrada", path: req.path });
});

app.use((err, req, res, next) => {
  console.error("❌ Erro global:", err.message);
  res.status(500).json({ erro: "Erro interno do servidor" });
});

setTimeout(atualizarPrecosFundos, 10000);
setInterval(atualizarPrecosFundos, 30 * 60 * 1000);

setTimeout(executarOrdensAutomaticas, 30000);
setInterval(executarOrdensAutomaticas, 5 * 60 * 1000);

setTimeout(verificarAlertasPreco, 60000);
setInterval(verificarAlertasPreco, 2 * 60 * 1000);

setTimeout(executarOrdensLimitadas, 90000);
setInterval(executarOrdensLimitadas, 2 * 60 * 1000);

setTimeout(() => {
  atualizarCriptos();
  atualizarAcoesBR();
  atualizarAcoesInternacionais();
}, 5000);
setInterval(() => {
  atualizarCriptos();
  atualizarAcoesBR();
  atualizarAcoesInternacionais();
}, 120 * 60 * 1000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
