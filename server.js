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

const { MP_TOKEN } = process.env;
let payment = null;
if (MP_TOKEN) {
  const client = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  payment = new Payment(client);
  console.log("💳 MP configurado");
}

// ========== ROTAS ==========

app.get("/", (req, res) => res.send("API Atlax 🚀"));

// Diagnóstico
app.get("/teste-supabase", async (req, res) => {
  try {
    const { data, error } = await supabase.from("usuarios").select("*").limit(1);
    if (error) {
      console.error("❌ Erro no teste:", error);
      return res.status(500).json({ status: "offline", erro: error.message });
    }
    res.json({ status: "online", data });
  } catch (e) {
    res.status(500).json({ status: "offline", erro: e.message });
  }
});

// Saldo
app.get("/saldo/:uid", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("usuarios")
      .select("saldo")
      .eq("id", req.user.uid)
      .single();

    if (error) {
      console.error("❌ Erro Supabase /saldo:", error);
      return res.status(500).json({ erro: error.message });
    }

    const saldo = data?.saldo ?? 0;
    console.log(`📊 Saldo de ${req.user.uid}: ${saldo}`);
    res.json({ saldo });
  } catch (e) {
    console.error("❌ Erro inesperado /saldo:", e);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// Depósito (QR Code original)
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

    console.log(`✅ Pagamento criado: ${pagamento.id}`);
    res.json({ id: pagamento.id, qr_img: qr.qr_code_base64, copia_cola: qr.qr_code });
  } catch (err) {
    console.error("❌ Erro depósito:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao gerar PIX" });
  }
});

// 🔥 VERIFICAR PAGAMENTO (COM INCREMENTO ATÔMICO)
app.get("/verificar-pagamento/:id", async (req, res) => {
  try {
    if (!payment) return res.status(500).json({ erro: "MP não configurado" });
    const { id } = req.params;
    console.log(`🔍 Verificando pagamento ${id}...`);
    const pagamento = await payment.get({ id });
    console.log(`📊 Status: ${pagamento.status}`);

    let saldoAtualizado = null;

    if (pagamento.status === "approved") {
      const valor = pagamento.transaction_amount;
      const uid = pagamento.metadata?.uid;
      console.log(`✅ Aprovado! UID: ${uid}, Valor: R$ ${valor}`);

      if (uid) {
        // Chama a função RPC que incrementa e retorna o novo saldo
        const { data: novoSaldo, error: rpcErr } = await supabase.rpc(
          "incrementar_saldo",
          { uid, valor }
        );

        if (rpcErr) {
          console.error("❌ Erro no RPC:", rpcErr.message);
        } else {
          saldoAtualizado = novoSaldo;
          console.log(`💰 Saldo incrementado via RPC: ${saldoAtualizado}`);

          // Registra transação
          const { error: transErr } = await supabase.from("transactions").insert({
            uid,
            tipo: "deposito",
            valor: Number(valor),
            status: "aprovado",
          });
          if (transErr) {
            console.error("❌ Erro ao registrar transação:", transErr.message);
          }
        }
      }
    }

    res.json({
      status: pagamento.status,
      amount: pagamento.transaction_amount,
      saldo: saldoAtualizado,
    });
  } catch (err) {
    console.error("❌ Erro verificar:", err.response?.data || err.message);
    res.status(500).json({ erro: "Erro ao verificar" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
