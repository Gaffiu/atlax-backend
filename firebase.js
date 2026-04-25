const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

let db;
let firebasePronto = false;

// Tenta carregar credenciais
let serviceAccount = null;

const keyPath = path.join(__dirname, "serviceAccountKey.json");

if (fs.existsSync(keyPath)) {
  serviceAccount = require(keyPath);
  console.log("🔑 Credenciais carregadas do arquivo local");
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("🔑 Credenciais carregadas da variável de ambiente");
  } catch (e) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT contém JSON inválido:", e.message);
  }
} else {
  console.error("❌ Nenhuma credencial Firebase encontrada. Configure FIREBASE_SERVICE_ACCOUNT no Render.");
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  firebasePronto = true;
  console.log("🔥 Firebase Admin inicializado com sucesso");
} else {
  console.error("❌ Firebase NÃO inicializado. O servidor irá iniciar, mas o Firestore não funcionará.");
  // Mock que gera erro descritivo
  db = {
    collection: () => {
      throw new Error("Firebase não configurado. Adicione a variável FIREBASE_SERVICE_ACCOUNT no Render com o JSON completo da service account.");
    }
  };
}

module.exports = { db, admin, firebasePronto };
