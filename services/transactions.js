const { db } = require("../firebase");

async function criarTransacao({ uid, tipo, valor, status, categoria = null }) {
  await db.collection("transactions").add({
    uid,
    tipo,
    valor,
    status,
    categoria,
    criadoEm: new Date()
  });
}

module.exports = { criarTransacao };
