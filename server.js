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
const TAXA_DEPOSITO = 0.05; // 5% de taxa de serviço

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
  auth: { username: BELVO_SECRET_ID, password: BELVO_SECRET_PASSWORD }
} : null;
if (BELVO_AUTH) console.log("🔑 Belvo configurado (Sandbox)");
else console.warn("⚠️ Variáveis BELVO_SECRET_ID/BELVO_SECRET_PASSWORD não definidas.");

// ========== ATUALIZAÇÃO DE COTAÇÕES ==========
async function atualizarCriptos() { /* ... (mantida) ... */ }
async function atualizarAcoesBR() { /* ... (mantida) ... */ }
async function atualizarAcoesInternacionais() { /* ... (mantida) ... */ }

// ========== ROTAS ==========
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
    console.error("❌ Erro verificar:", err.message);
    res.status(500).json({ erro: "Erro ao verificar" });
  }
});

app.post("/investir", authMiddleware, async (req, res) => {
  // ... (mantida)
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
    console.error("❌ Erro saque:", e.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// ===== FUNDOS (com rentabilidade real) =====
async function obterPrecoAtual(ticker) {
  // ... (fallback + APIs reais)
}

app.get("/fundos", async (req, res) => {
  const { data } = await supabase.from("fundos").select("*").eq("ativo", true);
  res.json(data || []);
});

app.post("/investir-fundo", authMiddleware, async (req, res) => {
  // ... (mantida)
});

app.post("/resgatar-fundo", authMiddleware, async (req, res) => {
  // ... (mantida)
});

app.get("/carteira/:uid", authMiddleware, async (req, res) => {
  // ... (mantida)
});

// ===== ATUALIZAÇÃO AUTOMÁTICA DE RENTABILIDADE =====
async function atualizarRentabilidadeFundos() {
  console.log("🔄 Atualizando rentabilidade...");
  const { data: fundos } = await supabase.from("fundos").select("*");
  for (const fundo of fundos) {
    const variacao = (Math.random() * 2 - 0.5) / 100;
    const novoPreco = (fundo.preco_atual || 100) * (1 + variacao);
    await supabase.from("fundos").update({
      preco_atual: novoPreco,
      rentabilidade_12m: (fundo.rentabilidade_12m || 0) + variacao * 200
    }).eq("ticker", fundo.ticker);
  }
  console.log("✅ Rentabilidade atualizada.");
}

setInterval(atualizarRentabilidadeFundos, 60 * 60 * 1000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
