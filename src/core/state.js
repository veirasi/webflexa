// ============================================================================
// core/state.js — sessão do usuário logado (o único estado verdadeiramente
// compartilhado entre TODOS os domínios da app)
// ============================================================================
// `usuarioLogado` é lido/escrito de dezenas de lugares em módulos diferentes
// (auth, dashboard, admin, perfil, pagamento, ...). Boa parte do código já
// usava `window.usuarioLogado` como a referência real (em paralelo a uma
// variável local `usuarioLogado` só dentro de auth.js) — este módulo assume
// esse padrão como o único canônico: `window.usuarioLogado` é o dado, e as
// funções abaixo são a forma preferida de consultá-lo. Módulos de domínio
// que só precisam LER (não modificar diretamente) devem importar essas
// funções em vez de acessar `window.usuarioLogado` na unha.
//
// Todos os outros ~45 `let` que existiam no topo do app.js original são
// estado local de um único domínio (ex.: cache do dashboard do entregador,
// posição de swipe de um card) e foram movidos para dentro do respectivo
// módulo de domínio, não centralizados aqui.
// ============================================================================

import { normalizarTexto } from './format.js';

if (typeof window.usuarioLogado === 'undefined') {
    window.usuarioLogado = null;
}
if (typeof window.modoAdmin === 'undefined') {
    window.modoAdmin = false;
}

/** Retorna o id (uid) do usuário logado, ou null se ninguém estiver logado. */
export function getUsuarioIdAtual() {
    return window.usuarioLogado?.id || (firebase.auth().currentUser ? firebase.auth().currentUser.uid : null);
}

/** Retorna o tipo normalizado do usuário logado: 'master' | 'entregador' | 'loja'. */
export function obterTipoUsuarioAtual() {
    const tipoRaw = normalizarTexto(window.usuarioLogado?.tipo || 'loja');
    if (tipoRaw === 'master' || tipoRaw === 'admin') return 'master';
    return (tipoRaw === 'entregador' || tipoRaw === 'entrega') ? 'entregador' : 'loja';
}

/** true se o usuário logado é um entregador (courier). */
export function usuarioEhEntregador() {
    return obterTipoUsuarioAtual() === 'entregador';
}

/** true se o usuário logado é o master/admin. */
export function usuarioEhMaster() {
    return obterTipoUsuarioAtual() === 'master';
}
