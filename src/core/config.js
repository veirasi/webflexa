// ============================================================================
// core/config.js — configuração vinda de index.html (window.FLEXA_*)
// ============================================================================
// index.html define `window.FLEXA_GOOGLE_MAPS_KEY`, `window.FLEXA_PAYMENTS_PROXY_URL`
// e `window.FLEXA_MP_TEST_TOKEN` num <script> inline antes de carregar o bundle
// (ver comentário lá sobre o motivo do fallback de teste local temporário,
// enquanto o plano Blaze não é ativado). Este módulo só lê e valida esses
// globais uma vez, num lugar só.
// ============================================================================

/** Chave da Google Maps JS API (client-side, restrição por referrer no Cloud Console). */
export const GOOGLE_MAPS_KEY = (window.FLEXA_GOOGLE_MAPS_KEY || '').trim();

/** URL da Cloud Function "payments" — vazia enquanto o plano Blaze não está ativo. */
export const FLEXA_PAYMENTS_PROXY_URL = (window.FLEXA_PAYMENTS_PROXY_URL || '').trim();

// Caminho TEMPORÁRIO só pra desenvolvimento local, enquanto o plano Blaze não é
// ativado e a Cloud Function "payments" não pode ser deployada. Só aceita token
// de TESTE — nunca deve receber uma credencial de produção. Assim que
// FLEXA_PAYMENTS_PROXY_URL estiver configurada, esse caminho deixa de ser usado.
export const FLEXA_MP_TEST_TOKEN = (window.FLEXA_MP_TEST_TOKEN || '').trim();
if (FLEXA_MP_TEST_TOKEN && !FLEXA_MP_TEST_TOKEN.startsWith('TEST-')) {
    throw new Error('FLEXA_MP_TEST_TOKEN precisa começar com "TEST-". Nunca coloque uma credencial de produção do Mercado Pago no navegador — use a Cloud Function "payments" (FLEXA_PAYMENTS_PROXY_URL) para produção.');
}
