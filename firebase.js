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
    console.warn("⚠️  FIREBASE_SERVICE_ACCOUNT env var is not valid JSON.");
  }
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  console.log("🔥 Firebase initialized");
} else {
  console.warn(
    "⚠️  No Firebase credentials found (serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT). " +
      "Firestore-dependent endpoints will return 503."
  );

  const notConfigured = () => {
    const err = new Error("Firebase not configured");
    err.code = "FIREBASE_NOT_CONFIGURED";
    throw err;
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

module.exports = db;
