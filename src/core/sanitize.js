// ============================================================================
// core/sanitize.js — escape de HTML/strings usadas em `.innerHTML =` e chaves
// do Firebase Realtime Database.
// ============================================================================
// Antes da reorg existiam DUAS implementações idênticas de escape de HTML
// (`escaparHtmlMarketplace` já delegava pra `escapeHtmlChat` quando disponível
// — eram, na prática, a mesma função duplicada). Unificadas aqui em
// `escapeHtml`; os dois nomes antigos continuam exportados como alias, sem
// precisar caçar/trocar cada call-site pelo arquivo inteiro.
// ============================================================================

/** Escapa &, <, >, ", ' — uso padrão antes de interpolar texto em `.innerHTML`. */
export function escapeHtml(valor) {
    return (valor || '')
        .toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** @deprecated use {@link escapeHtml} — mantido só pra compatibilidade de nome. */
export const escapeHtmlChat = escapeHtml;

/** @deprecated use {@link escapeHtml} — mantido só pra compatibilidade de nome. */
export const escaparHtmlMarketplace = escapeHtml;

/** Troca caracteres inválidos como chave do Realtime Database (`. # $ [ ] /` e espaços) por `_`. */
export function sanitizeFirebaseKey(valor) {
    return String(valor || '')
        .replace(/[.#$\[\]/]/g, '_')
        .replace(/\s+/g, '_');
}
