// ============================================================================
// Flexa — entry point do bundle (src/main.js)
// ============================================================================
// Este arquivo é o ÚNICO ponto de entrada do build (esbuild). Ele:
//   1. importa todo o código da aplicação (hoje ainda um único módulo de
//      transição, `legacy-monolith.js` — será substituído por módulos de
//      domínio nas próximas etapas do refactor);
//   2. expõe no `window` todas as funções que o index.html chama via
//      atributos inline (`onclick=`, `onchange=`, `oninput=`, `onkeydown=`,
//      `onblur=`) — o HTML não muda nesta reorganização, então essas
//      funções precisam continuar acessíveis em escopo global do jeito que
//      já eram antes do bundler existir.
//
// Formato de build: IIFE (não ESM) — ver package.json / esbuild.config —
// então nada aqui vaza pro escopo global automaticamente; a exposição via
// `Object.assign(window, ...)` abaixo é o único jeito de continuar
// compatível com os handlers inline existentes.
// ============================================================================

import * as legacy from './legacy-monolith.js';

Object.assign(window, legacy);
