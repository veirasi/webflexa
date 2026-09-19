// ============================================================================
// core/ui-sheet.js — utilidades genéricas de UI compartilhadas por todos os
// domínios: toasts/snackbar, abrir/fechar modais em formato "sheet" (o único
// par abrir/fechar realmente genérico do app — a maioria dos ~20 modais
// específicos ainda tem sua própria função dedicada, ver ARCHITECTURE.md),
// placeholder de avatar e link de Instagram.
// ============================================================================

/** Imagem usada quando o usuário não tem foto de perfil definida. */
export const AVATAR_PLACEHOLDER_SRC = 'img/avatar.png';

/** Define `imgEl.src`, caindo pro avatar padrão se a URL vier vazia ou falhar ao carregar. */
export function aplicarFotoComPlaceholder(imgEl, fotoUrl = '') {
    if (!imgEl) return;
    const fallback = AVATAR_PLACEHOLDER_SRC;
    const src = String(fotoUrl || '').trim();
    imgEl.onerror = () => {
        imgEl.onerror = null;
        imgEl.src = fallback;
    };
    imgEl.src = src || fallback;
}

/** Extrai só o @handle de um link/valor de Instagram digitado livremente. */
export function normalizarHandleInstagram(valor = '') {
    let txt = String(valor || '').trim();
    if (!txt) return '';
    txt = txt.replace(/^@+/, '');

    const m = txt.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
    if (m && m[1]) {
        txt = m[1];
    } else {
        txt = txt.split(/[/?#\s]/)[0];
    }

    return txt.replace(/^@+/, '').trim();
}

/** Aplica handle + link de Instagram normalizados num elemento `<a>`. */
export function aplicarLinkInstagram(el, valor = '') {
    if (!el) return;
    const handle = normalizarHandleInstagram(valor);
    const hasHandle = Boolean(handle);
    el.textContent = hasHandle ? handle : 'instagram';
    el.href = hasHandle ? `https://www.instagram.com/${encodeURIComponent(handle)}/` : '#';
    el.classList.toggle('is-empty', !hasHandle);
}

/** Camada fixa onde os toasts/snackbars são inseridos (criada sob demanda). */
export function obterLayerSnackbar() {
    let layer = document.getElementById('ui-snackbar-layer');
    if (layer) return layer;
    layer = document.createElement('div');
    layer.id = 'ui-snackbar-layer';
    layer.className = 'ui-snackbar-layer';
    document.body.appendChild(layer);
    return layer;
}

/** Toast/snackbar genérico. `opts.tipo`: 'info' | 'error' | 'success'. */
export function notificarApp(mensagem = '', opts = {}) {
    const texto = String(mensagem || '').trim();
    if (!texto) return null;

    const tipo = String(opts.tipo || 'info').toLowerCase();
    const duracaoBase = Number.isFinite(Number(opts.duracao)) ? Number(opts.duracao) : Math.max(2200, Math.min(5200, texto.length * 45));
    const duracao = Math.max(1200, duracaoBase);

    const layer = obterLayerSnackbar();
    const toast = document.createElement('div');
    toast.className = `ui-snackbar is-${tipo}`;
    toast.setAttribute('role', 'status');
    toast.textContent = texto;
    layer.appendChild(toast);

    const fechar = () => {
        toast.classList.remove('show');
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 220);
    };

    requestAnimationFrame(() => toast.classList.add('show'));
    if (!opts.persistente) setTimeout(fechar, duracao);
    toast.addEventListener('click', fechar);
    return { close: fechar, element: toast };
}

/** Toast de erro (vermelho, some em ~3.6s). */
export function notificarErro(mensagem = 'Falha inesperada. Tente novamente.') {
    return notificarApp(mensagem, { tipo: 'error', duracao: 3600 });
}

/** Toast de sucesso (verde, some em ~2.6s). */
export function notificarSucesso(mensagem = 'Operação concluída.') {
    return notificarApp(mensagem, { tipo: 'success', duracao: 2600 });
}

// `window.alert` nativo é substituído pelo toast interno (`notificarApp`) em
// toda a app — o alerta de sistema original fica preservado em
// `window.alertNativo` pra quem precisar dele explicitamente.
const alertaNativo = (typeof window !== 'undefined' && typeof window.alert === 'function')
    ? window.alert.bind(window)
    : null;

if (typeof window !== 'undefined') {
    window.alertNativo = alertaNativo;
    window.alert = function alertInterno(mensagem = '') {
        notificarApp(mensagem, { tipo: 'info' });
    };
}

/** Abre um modal genérico em formato bottom-sheet (display:flex + classe is-open). */
export function abrirModalSheetGenerico(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('is-open'));
}

/** Fecha um modal aberto com {@link abrirModalSheetGenerico}. */
export function fecharModalSheetGenerico(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('is-open');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 220);
}
