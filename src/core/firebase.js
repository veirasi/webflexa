// ============================================================================
// core/firebase.js — inicialização do Firebase (compat SDK)
// ============================================================================
// Carregado a partir dos scripts CDN `firebase-app/auth/database-compat.js`
// em index.html (que precisam continuar carregando ANTES do bundle da app).
// Mantém o SDK "compat" (global `firebase.*`) como já era — trocar para o
// SDK modular do Firebase é uma mudança maior, fora do escopo desta reorg.
// ============================================================================

const firebaseConfig = {
  apiKey: "AIzaSyBNsTcLawc8VaILryw36F5Iv6tIK0N41Og",
  authDomain: "flexa-app-41205.firebaseapp.com",
  projectId: "flexa-app-41205",
  storageBucket: "flexa-app-41205.firebasestorage.app",
  messagingSenderId: "1008393678489",
  appId: "1:1008393678489:web:8b9df090ef4695d6d6d208"
};

firebase.initializeApp(firebaseConfig);

/** Referência única do Realtime Database, compartilhada por toda a app. */
export const db = firebase.database();

/** Referência única do Firebase Auth, compartilhada por toda a app. */
export const auth = firebase.auth();
