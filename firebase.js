const admin = require("firebase-admin");

let serviceAccount;
let inicializado = false;

try {
  serviceAccount = require("./serviceAccountKey.json");
  console.log("✅ Firebase: credencial local carregada");
} catch (e) {
  console.log("ℹ️ Firebase: arquivo local não encontrado, tentando env...");
}

if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Firebase: credencial da variável de ambiente carregada");
  } catch (e) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT não é um JSON válido");
  }
}

let db;
if (serviceAccount) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  inicializado = true;
  console.log("🔥 Firebase Admin pronto para uso");
} else {
  console.error("❌ NENHUMA CREDENCIAL FIREBASE ENCONTRADA");
  db = {
    collection: () => {
      throw new Error("Firebase não configurado. Configure FIREBASE_SERVICE_ACCOUNT no Render.");
    }
  };
}

module.exports = { db, admin, firebasePronto: inicializado };
