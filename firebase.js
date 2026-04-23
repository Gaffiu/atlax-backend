const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

let db;

const keyPath = path.join(__dirname, "serviceAccountKey.json");
let serviceAccount = null;

if (fs.existsSync(keyPath)) {
  serviceAccount = require("./serviceAccountKey.json");
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT inválido");
  }
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  db = admin.firestore();
  console.log("🔥 Firebase initialized");
} else {
  console.warn("⚠️ Firebase não configurado");

  const notConfigured = () => {
    throw new Error("Firebase not configured");
  };

  db = {
    collection: () => ({
      doc: () => ({
        get: notConfigured,
        set: notConfigured,
        update: notConfigured
      }),
      add: notConfigured
    })
  };
}

module.exports = {
  db,
  admin
};
