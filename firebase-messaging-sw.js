// firebase-messaging-sw.js
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBoKjxuXPavGouobfLmDkI2Po6K5kBkulc",
  authDomain: "atlax-ai.firebaseapp.com",
  projectId: "atlax-ai",
  storageBucket: "atlax-ai.firebasestorage.app",
  messagingSenderId: "520071634356",
  appId: "1:520071634356:web:2cf391fb9017d8a472a6e1"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  const options = {
    body: body || "",
    icon: "/icon.png",
    badge: "/icon.png",
    vibrate: [200, 100, 200],
    data: payload.data || {}
  };
  self.registration.showNotification(title || "Atlax AI", options);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("dashboard") && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow("/dashboard.html");
      }
    })
  );
});
