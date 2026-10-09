const { onRequest } = require('firebase-functions/v2/https');
const { onValueWritten } = require('firebase-functions/v2/database');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();

const db = admin.database();

const ROUTING_REGION = process.env.ROUTING_REGION || 'southamerica-east1';
const PAYMENTS_REGION = process.env.PAYMENTS_REGION || 'southamerica-east1';
const REQUIRE_AUTH = String(process.env.REQUIRE_AUTH || 'true').toLowerCase() === 'true';
// Lista de origens permitidas pra CORS, separadas por vírgula (ex:
// "https://app.seudominio.com,http://localhost:5501"). Sem isso configurado,
// NENHUMA origem é liberada (fail-closed) — antes disso o padrão era '*'
// (qualquer site podia chamar a função), que precisa ser travado no domínio
// real de produção antes do lançamento comercial.
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Segredos: NUNCA hardcoded. Definidos via:
//   firebase functions:secrets:set MP_ACCESS_TOKEN
//   firebase functions:secrets:set GOOGLE_MAPS_SERVER_KEY
// (o valor é digitado direto no terminal do dono da conta, nunca passa pelo código-fonte)
const MP_ACCESS_TOKEN = defineSecret('MP_ACCESS_TOKEN');
const GOOGLE_MAPS_SERVER_KEY = defineSecret('GOOGLE_MAPS_SERVER_KEY');

function setCors(req, res) {
  const origin = req.get('Origin');
  if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function formatAddress(endereco) {
  if (!endereco) return '';
  const ruaNum = [endereco.rua, endereco.num].filter(Boolean).join(', ');
  const bairro = endereco.bairro ? ` - ${endereco.bairro}` : '';
  const cidadeUf = [endereco.cidade, endereco.uf].filter(Boolean).join('/');
  const base = `${ruaNum}${bairro}${cidadeUf ? ` - ${cidadeUf}` : ''}`.trim();
  const cep = String(endereco.cep || '').trim();
  if (base && cep) return `${base} - CEP ${cep}`;
  return base;
}

function normalizeGeo(geo) {
  if (!geo) return null;
  const lat = Number(geo.lat);
  const lon = Number(geo.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function parseBearerToken(req) {
  const authHeader = req.get('Authorization') || '';
  const [type, token] = authHeader.split(' ');
  if (type !== 'Bearer' || !token) return null;
  return token;
}

async function resolveRequester(req) {
  const token = parseBearerToken(req);
  if (!token) return null;
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded;
}

async function geocodeGoogle(address, apiKey) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&components=country:BR&key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google Geocoding HTTP ${response.status}`);
  const json = await response.json();
  const loc = json?.results?.[0]?.geometry?.location;
  if (json?.status !== 'OK' || !loc) return null;
  return { lat: Number(loc.lat), lon: Number(loc.lng) };
}

async function routeGoogleDistanceMatrix(origin, destination, apiKey) {
  const origins = `${origin.lat},${origin.lon}`;
  const destinations = `${destination.lat},${destination.lon}`;
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origins)}&destinations=${encodeURIComponent(destinations)}&mode=driving&region=br&language=pt-BR&key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google Distance Matrix HTTP ${response.status}`);
  const json = await response.json();
  const el = json?.rows?.[0]?.elements?.[0];
  if (json?.status !== 'OK' || el?.status !== 'OK') return null;
  return {
    distanciaKm: Number((Number(el.distance.value) / 1000).toFixed(2)),
    duracaoMin: Math.max(1, Math.round(Number(el.duration.value) / 60))
  };
}

// Taxa de espera/subida (mesmas constantes do frontend, src/legacy-monolith.js
// TAXA_ESPERA_GRACE_MIN/TAXA_ESPERA_POR_MIN/TAXA_SUBIR_FIXA) — precisam ficar
// iguais nos dois lados, senão o valor mostrado antes de confirmar diverge do
// valor que o servidor de fato grava.
const TAXA_ESPERA_GRACE_MIN = 5;
const TAXA_ESPERA_POR_MIN = 1;
const TAXA_SUBIR_FIXA = 6;

// Este app grava envio em DOIS modelos de dados dependendo de qual fluxo criou
// ele: usuarios/{uid}/pacotes/{id} (modelo novo) ou usuarios/{uid}/clientes/{c}/historico[]
// (modelo antigo, usado pelo fluxo padrão "Novo Envio" do lojista). Resolve o
// envio em qualquer um dos dois e devolve o path certo pra gravar depois — sem
// isso, um envio do modelo antigo nunca é encontrado por estas rotas de
// pagamento. Ver project-flexa-cobranca-entrega-dinheiro (mesmo bug já existia
// no frontend em persistirEntregaPacoteAtual).
async function resolverEnvioLojista(tenantId, envioId) {
  const pacoteSnap = await db.ref(`usuarios/${tenantId}/pacotes/${envioId}`).once('value');
  if (pacoteSnap.exists()) {
    return { dados: pacoteSnap.val(), path: `usuarios/${tenantId}/pacotes/${envioId}` };
  }

  const clientesSnap = await db.ref(`usuarios/${tenantId}/clientes`).once('value');
  const clientesNo = clientesSnap.val() || {};
  for (const clienteId of Object.keys(clientesNo)) {
    const historico = Array.isArray(clientesNo[clienteId]?.historico) ? clientesNo[clienteId].historico : [];
    for (let idx = 0; idx < historico.length; idx += 1) {
      const h = historico[idx];
      const idAtual = String(h?.id || `envio-${clienteId}-${idx}`);
      if (idAtual === envioId) {
        return { dados: h, path: `usuarios/${tenantId}/clientes/${clienteId}/historico/${idx}` };
      }
    }
  }

  return { dados: null, path: null };
}

// Mesmo padrão de sincronizarCamposEnvioLojista no frontend: grava sempre no
// modelo novo (pacotes/{envioId}) e, se achar o mesmo id no modelo antigo
// (clientes/*/historico), grava lá também — mantém os dois em sincronia
// igual o app já faz hoje, sem mudar qual modelo cada tela lê.
async function syncEnvioFields(tenantId, envioId, campos) {
  const updates = {};
  Object.keys(campos).forEach((chave) => {
    updates[`usuarios/${tenantId}/pacotes/${envioId}/${chave}`] = campos[chave];
  });

  const clientesSnap = await db.ref(`usuarios/${tenantId}/clientes`).once('value');
  const clientesNo = clientesSnap.val() || {};
  Object.keys(clientesNo).forEach((clienteId) => {
    const historico = Array.isArray(clientesNo[clienteId]?.historico) ? clientesNo[clienteId].historico : [];
    historico.forEach((h, idx) => {
      const idAtual = String(h?.id || `envio-${clienteId}-${idx}`);
      if (idAtual !== envioId) return;
      Object.keys(campos).forEach((chave) => {
        updates[`usuarios/${tenantId}/clientes/${clienteId}/historico/${idx}/${chave}`] = campos[chave];
      });
    });
  });

  await db.ref().update(updates);
}

// Mesmo padrão de criarDividaLojistaEntregador no frontend: grava a dívida
// nos dois espelhos (lojista deve, entregador tem a receber).
async function criarDividaLojistaEntregador({ lojistaUid, uidEntregador, entregadorNome, rotaId, envioId, valor, motivo }) {
  const finSnap = await db.ref(`usuarios/${uidEntregador}/financeiro`).once('value');
  const fin = finSnap.val() || {};
  const id = db.ref().push().key;
  const registro = {
    id,
    lojistaUid,
    entregadorUid: uidEntregador,
    entregadorNome: entregadorNome || 'Entregador',
    valor: Number(valor),
    motivo: motivo || 'Taxa de espera/subida',
    rotaId: String(rotaId || ''),
    envioId: String(envioId || ''),
    criadoEm: Date.now(),
    pixTipo: fin?.pix?.tipo || '',
    pixChave: fin?.pix?.chave || '',
    status: 'pendente'
  };

  const updates = {};
  updates[`usuarios/${lojistaUid}/dividasEntregador/${id}`] = registro;
  updates[`usuarios/${uidEntregador}/taxasAReceber/${id}`] = registro;
  await db.ref().update(updates);
  return registro;
}

// Mesma lógica de ajustarDividaUsuario no frontend (lê, soma, grava — sem
// .transaction() pelo mesmo motivo documentado lá: .transaction() nesse
// projeto às vezes recebe null mesmo com valor real já gravado).
async function ajustarDividaUsuarioServer(uid, delta) {
  const dividaRef = db.ref(`usuarios/${uid}/financeiro/divida`);
  const snap = await dividaRef.once('value');
  const dividaAntes = Number(snap.val() || 0);
  const dividaDepois = Math.max(0, Number((dividaAntes + delta).toFixed(2)));
  await dividaRef.set(dividaDepois);
  const dividaDesdeRef = db.ref(`usuarios/${uid}/financeiro/dividaDesde`);
  if (dividaAntes <= 0 && dividaDepois > 0) {
    await dividaDesdeRef.set(Date.now());
  } else if (dividaDepois <= 0) {
    await dividaDesdeRef.remove();
  }
  return { dividaAntes, dividaDepois };
}

// Mesma lógica de ajustarSaldoUsuario no frontend (lê, soma, grava).
async function ajustarSaldoUsuarioServer(uid, delta) {
  const saldoRef = db.ref(`usuarios/${uid}/financeiro/saldo`);
  const snap = await saldoRef.once('value');
  const saldoAntes = Number(snap.val() || 0);
  const saldoDepois = Number((saldoAntes + delta).toFixed(2));
  await saldoRef.set(saldoDepois);
  return { saldoAntes, saldoDepois };
}

// Taxa de entrega na porta — crédito RETIDO (pedido do dono, 2026-10-04): o
// Pix do cliente aprova e marca esperaEntrega.subirStatus:'pago', mas o
// valor só vira saldo gastável do entregador quando a entrega é de fato
// CONFIRMADA (código de confirmação validado) — nunca antes. Sem isso, um
// entregador podia aceitar, embolsar o Pix assim que aprovasse, e nunca
// subir. Chamada de dois lugares: dentro de /resolver-taxa-espera (o
// caminho normal — só roda depois que confirmarEntregaPacoteAtual já
// validou o código, ver comentário lá) e dentro de /checar-pagamento-pendencias-cliente, pro
// caso raro do Pix aprovar DEPOIS que a entrega já foi confirmada (usa
// esperaEntrega.finalizada, que /resolver-taxa-espera grava ao terminar,
// como sinal de "já rodou e não vai rodar de novo pra essa entrega" — sem
// isso o crédito ficaria retido pra sempre). Se a entrega virar devolução/
// "não consegui entregar" em vez de confirmada, esta função nunca é
// chamada — o valor fica retido, pra alguém decidir manualmente depois.
async function liberarCreditoSubidaSeElegivel(tenantId, envioId, entregadorId, pacote) {
  const espera = pacote?.esperaEntrega || {};
  if (espera.subirStatus !== 'pago' || espera.subidaCreditoLiberadoEm) return false;

  await ajustarSaldoUsuarioServer(entregadorId, TAXA_SUBIR_FIXA);
  await db.ref(`usuarios/${entregadorId}/financeiro/transacoes`).push({
    protocolo: gerarProtocoloTransacaoServer(),
    tipo: 'CREDITO',
    metodo: 'pix',
    valor: TAXA_SUBIR_FIXA,
    descricao: `Taxa de entrega na porta liberada (pedido #${envioId})`,
    remetente: 'Cliente (Pix)',
    destinatario: 'Você (entregador)',
    criadoEm: Date.now()
  });
  await syncEnvioFields(tenantId, envioId, { 'esperaEntrega/subidaCreditoLiberadoEm': Date.now() });
  return true;
}

// Mesma lógica de liberarCreditoSubidaSeElegivel, pra taxa de ESPERA (tempo
// parado) — pedido do dono, 2026-10-04: essa taxa deixou de ter fallback de
// dinheiro/dívida (gerava dúvida sobre o que foi ou não recebido), agora só
// existe via Pix combinado em /create-pix-taxas. valorEsperaPago é gravado
// por /check-pix-taxas no momento da aprovação (o valor correto, já
// recalculado lá — nunca confia em nada vindo daqui).
async function liberarCreditoEsperaSeElegivel(tenantId, envioId, entregadorId, pacote) {
  const espera = pacote?.esperaEntrega || {};
  const valor = Number(espera.valorEsperaPago || 0);
  if (espera.esperaStatus !== 'pago' || valor <= 0 || espera.esperaCreditoLiberadoEm) return false;

  await ajustarSaldoUsuarioServer(entregadorId, valor);
  await db.ref(`usuarios/${entregadorId}/financeiro/transacoes`).push({
    protocolo: gerarProtocoloTransacaoServer(),
    tipo: 'CREDITO',
    metodo: 'pix',
    valor,
    descricao: `Taxa de espera liberada (pedido #${envioId})`,
    remetente: 'Cliente (Pix)',
    destinatario: 'Você (entregador)',
    criadoEm: Date.now()
  });
  await syncEnvioFields(tenantId, envioId, { 'esperaEntrega/esperaCreditoLiberadoEm': Date.now() });
  return true;
}

// Mesmas faixas/piso de TAXA_PLATAFORMA_FAIXAS/PISO_KM_ENTREGADOR no
// frontend (src/legacy-monolith.js ~1420) — precisam ficar iguais nos dois
// lados pelo mesmo motivo documentado em TAXA_ESPERA_GRACE_MIN acima.
const TAXA_PLATAFORMA_FAIXAS = [
  { ate: 5, taxa: 1.00 },
  { ate: 15, taxa: 1.50 },
  { ate: 25, taxa: 2.00 },
  { ate: Infinity, taxa: 2.50 }
];
const PISO_KM_ENTREGADOR = 1.00;

function calcularTaxaPlataformaAlvo(valorFrete) {
  const v = Number(valorFrete || 0);
  const faixa = TAXA_PLATAFORMA_FAIXAS.find((f) => v <= f.ate) || TAXA_PLATAFORMA_FAIXAS[TAXA_PLATAFORMA_FAIXAS.length - 1];
  return faixa.taxa;
}

function calcularTaxaPlataformaRota(valorFrete, distanciaKm) {
  const v = Number(valorFrete || 0);
  if (v <= 0) return 0;
  const alvo = calcularTaxaPlataformaAlvo(v);
  const km = Number(distanciaKm);
  if (!Number.isFinite(km) || km <= 0) return Number(alvo.toFixed(2));
  const taxaMaxSemFurarPiso = Math.max(0, v - km * PISO_KM_ENTREGADOR);
  return Number(Math.min(alvo, taxaMaxSemFurarPiso).toFixed(2));
}

function calcularValorRepasseEntregador(valorFrete, distanciaKm) {
  const v = Number(valorFrete || 0);
  if (v <= 0) return 0;
  const taxa = calcularTaxaPlataformaRota(v, distanciaKm);
  return Number(Math.max(0, v - taxa).toFixed(2));
}

// ===================== [ÍNDICE PÚBLICO DO MARKETPLACE] (plano de segurança
// 2026-09-27, Fase 3) =====================
// carregarMarketplaceRotasEntregador (frontend) lê a coleção `usuarios`
// INTEIRA em tempo real pra montar a lista de fretes do entregador — o que
// exige `usuarios/.read: auth != null` na raiz, vazando financeiro/dívida/
// saques/clientes de TODO MUNDO pra qualquer autenticado (não é fraude —
// nenhuma dessas escritas confia no cliente desde a Fase 2 — mas é
// privacidade real). Em vez disso, este índice espelha SÓ os campos que o
// marketplace realmente usa (perfil público, rotas em aberto/andamento,
// pacotes associados com endereço de entrega e detalhes de frete — o MESMO
// nível de detalhe que o marketplace já expõe hoje antes de aceitar, nunca
// mais) pra `marketplacePublico/{lojistaUid}`, mantido em sincronia por
// estes dois triggers (dispara em `usuarios/{uid}` E em `pacotes/{uid}`,
// porque o app grava pacote em dois modelos — ver resolverEnvioLojista).
// Isso permite fechar `usuarios/.read` pra master/dono apenas.
const ALLOWLIST_HISTORICO_ITEM = ['id', 'destino', 'destinoEndereco', 'cidadeDestino', 'bairroDestino', 'cidade', 'servico', 'status', 'statusRaw', 'distanciaKm', 'duracaoMin', 'valorFrete', 'valor', 'tamanho', 'embalagem', 'veiculo', 'tipoFluxo', 'rotaId'];
const ALLOWLIST_CLIENTE_ENDERECO = ['cidade', 'estado', 'uf', 'endereco', 'cep', 'rua', 'num', 'bairro', 'comp'];
// aceitoEm/coletaConfirmada (2026-10-09): precisam estar no espelho público
// pra liberarRotasAtrasadasServer decidir, só lendo marketplacePublico (sem
// precisar abrir usuarios/{lojistaUid} inteiro), se uma rota "aceita" já
// passou do prazo de 20 min pra coleta sem confirmação — nenhum dos dois é
// dado sensível (é só timing/status operacional, mesma classe de status já
// exposta aqui).
const ALLOWLIST_ROTA_MARKETPLACE = ['status', 'pagamentoStatus', 'totalFrete', 'pacoteIds', 'pacotes', 'quantidade', 'entregadorId', 'aceitoPor', 'criadoEm', 'aceitoEm', 'coletaConfirmada'];

// Prazo pra confirmar a coleta na loja depois de aceitar a rota (pedido do
// dono 2026-10-09, prevenção contra entregador "travar" uma rota sem nunca
// aparecer): passou disso sem confirmar, a rota volta a ficar disponível
// pra qualquer outro entregador — ver o uso dentro de /aceitar-rota-marketplace
// (aceite atrasado) e liberarRotasAtrasadasServer (limpeza proativa).
const PRAZO_COLETA_MS = 20 * 60 * 1000;

function filtrarCampos(obj, campos) {
  const out = {};
  campos.forEach((c) => {
    if (obj && obj[c] !== undefined && obj[c] !== null) out[c] = obj[c];
  });
  return out;
}

async function montarMarketplacePublicoDoLojista(uid) {
  const marketplaceRef = db.ref(`marketplacePublico/${uid}`);
  const [userSnap, pacotesRaizSnap] = await Promise.all([
    db.ref(`usuarios/${uid}`).once('value'),
    db.ref(`pacotes/${uid}`).once('value')
  ]);
  const usuario = userSnap.val();
  if (!usuario) {
    await marketplaceRef.remove();
    return;
  }

  const tipoRaw = String(usuario.tipo || '').toLowerCase();
  if (['entrega', 'entregador', 'master', 'admin'].includes(tipoRaw)) {
    await marketplaceRef.remove();
    return;
  }

  const rotasNo = usuario.rotas || {};
  const rotaIds = Object.keys(rotasNo);
  if (!rotaIds.length) {
    await marketplaceRef.remove();
    return;
  }

  const rotasFiltradas = {};
  rotaIds.forEach((rid) => {
    rotasFiltradas[rid] = filtrarCampos(rotasNo[rid], ALLOWLIST_ROTA_MARKETPLACE);
  });

  const clientesNo = usuario.clientes || {};
  const clientesFiltrados = {};
  Object.keys(clientesNo).forEach((cid) => {
    const cliente = clientesNo[cid] || {};
    const historico = Array.isArray(cliente.historico) ? cliente.historico : [];
    clientesFiltrados[cid] = {
      ...filtrarCampos(cliente, ALLOWLIST_CLIENTE_ENDERECO),
      historico: historico.map((h) => filtrarCampos(h, ALLOWLIST_HISTORICO_ITEM))
    };
  });

  const pacotesRaizNo = pacotesRaizSnap.val() || {};
  const pacotesRaizFiltrados = {};
  Object.keys(pacotesRaizNo).forEach((pid) => {
    pacotesRaizFiltrados[pid] = filtrarCampos(pacotesRaizNo[pid], ALLOWLIST_HISTORICO_ITEM);
  });

  // BUG CORRIGIDO 2026-09-28: faltava espelhar usuarios/{uid}/pacotes (o
  // modelo "novo" de verdade, o mesmo que resolverEnvioLojista checa
  // primeiro) — só clientes/historico (antigo) e pacotes/{uid} raiz (bem
  // legado) estavam sendo espelhados, então uma rota cujos pacotes vivem só
  // no modelo novo aparecia no marketplace sem nenhum detalhe de destino/
  // tamanho/valor (achado testando o dropdown de origem/destino).
  const pacotesNovoNo = usuario.pacotes || {};
  const pacotesNovoFiltrados = {};
  Object.keys(pacotesNovoNo).forEach((pid) => {
    pacotesNovoFiltrados[pid] = filtrarCampos(pacotesNovoNo[pid], ALLOWLIST_HISTORICO_ITEM);
  });

  await marketplaceRef.set({
    perfil: {
      nome: usuario.nome || '',
      loja: usuario.loja || '',
      foto: usuario.foto || '',
      logo: usuario.logo || '',
      endereco: {
        cidade: usuario.endereco?.cidade || '',
        uf: usuario.endereco?.uf || '',
        estado: usuario.endereco?.estado || '',
        bairro: usuario.endereco?.bairro || ''
      }
    },
    rotas: rotasFiltradas,
    clientes: clientesFiltrados,
    pacotesRaiz: pacotesRaizFiltrados,
    pacotesNovo: pacotesNovoFiltrados,
    atualizadoEm: Date.now()
  });
}

// Triggers de Realtime Database (Eventarc) não têm suporte em
// southamerica-east1 ainda — us-central1 é a região universalmente
// suportada hoje para este tipo de gatilho.
const MARKETPLACE_TRIGGER_REGION = process.env.MARKETPLACE_TRIGGER_REGION || 'us-central1';

exports.marketplacePublicoUsuarios = onValueWritten({ ref: '/usuarios/{uid}', region: MARKETPLACE_TRIGGER_REGION }, async (event) => {
  try {
    await montarMarketplacePublicoDoLojista(event.params.uid);
  } catch (err) {
    logger.error('marketplace_publico_usuarios_error', err);
  }
});

exports.marketplacePublicoPacotesRaiz = onValueWritten({ ref: '/pacotes/{uid}', region: MARKETPLACE_TRIGGER_REGION }, async (event) => {
  try {
    await montarMarketplacePublicoDoLojista(event.params.uid);
  } catch (err) {
    logger.error('marketplace_publico_pacotes_error', err);
  }
});

// Painel master (plano de segurança 2026-09-27): atualizarStatusRotaMaster/
// adminExcluirRota no frontend só conferiam usuarioEhMaster() no JAVASCRIPT
// do próprio navegador — a regra do banco pra "rotas" é `auth != null` (não
// exige master), então qualquer autenticado podia reescrever/apagar a rota
// de qualquer lojista direto do console. Esta checagem lê o "tipo" real do
// chamador no banco (campo write-once, nunca vira master por escrita comum
// — ver database.rules.json), a única fonte confiável.
async function requesterEhMasterOuAdmin(requester) {
  if (!requester) return false;
  if (requester.admin === true || requester.role === 'admin') return true;
  const snap = await db.ref(`usuarios/${requester.uid}/tipo`).once('value');
  const tipo = snap.val();
  return tipo === 'master' || tipo === 'admin';
}

// ===================== [LOGIN AUTOMÁTICO DO CLIENTE VIA LINK] (plano
// 2026-09-28) =====================
// Antes, dar acesso ao cliente final exigia uma ação manual separada do
// lojista (convidarClienteParaApp) que mandava uma SEGUNDA mensagem de
// WhatsApp com usuário+senha temporária em TEXTO PURO — exposto em preview
// de notificação, tela bloqueada, ou pra qualquer um com acesso ao celular
// do cliente. Agora o link de rastreio (que já é mandado pra TODO pedido)
// carrega um token de login de uso único — o cliente nunca vê senha
// nenhuma, só clica e já está autenticado.
const LOGIN_TOKEN_TTL_MS = 30 * 60 * 1000;

function normalizarWhatsappServer(valor) {
  return String(valor || '').replace(/\D/g, '');
}

// Acha (ou cria) a conta do cliente pra este WhatsApp e devolve um
// loginToken de uso único — chamado pelo LOJISTA (autenticado) no momento
// de montar a mensagem de rastreio, nunca pelo cliente.
async function gerarLoginCliente(req, res, requester) {
  const whatsapp = normalizarWhatsappServer((req.body || {}).whatsapp);
  if (!whatsapp) {
    return res.status(400).json({ error: 'Missing required fields', required: ['whatsapp'] });
  }
  // BUG CORRIGIDO 2026-10-03 (pedido do dono): o lojista já sabe o nome do
  // destinatário (digitou ao criar o envio) — sem repassar aqui, a conta
  // nascia sempre com nome vazio, e a tela de completar cadastro do cliente
  // abria sem nenhum nome pré-preenchido.
  const nomeDestinatario = String((req.body || {}).nome || '').trim().slice(0, 120);

  let uid;
  const emailSnap = await db.ref(`telefoneParaEmail/${whatsapp}`).once('value');
  if (emailSnap.exists()) {
    const userRecord = await admin.auth().getUserByEmail(emailSnap.val());
    uid = userRecord.uid;
    // BUG CORRIGIDO 2026-10-03: conta já existia (convite anterior nunca
    // concluído) — sem isto, o nome ficava travado no que quer que tenha
    // sido passado (ou vazio) da PRIMEIRA vez, mesmo em envios seguintes
    // com o nome certo disponível. Só atualiza enquanto o cliente ainda não
    // confirmou a própria conta (cadastroCompleto:false) — depois disso o
    // nome passa a ser dele pra editar, nunca mais sobrescrito por aqui.
    if (nomeDestinatario) {
      const usuarioAtualSnap = await db.ref(`usuarios/${uid}/cadastroCompleto`).once('value');
      if (usuarioAtualSnap.val() !== true) {
        await db.ref(`usuarios/${uid}/nome`).set(nomeDestinatario);
        await db.ref(`clientesGlobais/${whatsapp}/nome`).set(nomeDestinatario);
      }
    }
  } else {
    // Senha aleatória só pra satisfazer o Firebase Auth por baixo — nunca é
    // exposta em lugar nenhum (o cliente entra sempre via loginToken/custom
    // token, ou depois via a própria senha que ele mesmo criar ao completar
    // o cadastro). Mesmo formato de conta que convidarClienteParaApp já cria.
    const emailConvite = `cliente.${whatsapp}@flex.local`;
    const senhaInterna = crypto.randomBytes(24).toString('hex');
    const userRecord = await admin.auth().createUser({ email: emailConvite, password: senhaInterna });
    uid = userRecord.uid;
    await db.ref(`usuarios/${uid}`).set({
      nome: nomeDestinatario,
      email: emailConvite,
      whatsapp,
      tipo: 'cliente',
      criadoEm: Date.now(),
      convidadoPorUid: requester.uid,
      cadastroCompleto: false
    });
    await db.ref(`telefoneParaEmail/${whatsapp}`).set(emailConvite);
    await db.ref(`clientesGlobais/${whatsapp}`).set({ nome: nomeDestinatario, whatsapp, uid, cadastroCompleto: false });
  }

  const loginToken = crypto.randomBytes(24).toString('hex');
  const agora = Date.now();
  await db.ref(`loginTokens/${loginToken}`).set({
    uid,
    whatsapp,
    criadoEm: agora,
    expiraEm: agora + LOGIN_TOKEN_TTL_MS,
    usado: false
  });

  return res.status(200).json({ loginToken });
}

// Chamado pelo CLIENTE (sem nenhum token de auth ainda — é o próprio
// loginToken que prova a identidade aqui). Uso único: marca como usado
// antes mesmo de gerar o custom token, pra uma corrida de dois cliques
// simultâneos nunca gerar dois logins válidos do mesmo token.
async function consumirLoginCliente(req, res) {
  const loginToken = String((req.body || {}).loginToken || '').trim();
  if (!loginToken) {
    return res.status(400).json({ error: 'Missing required fields', required: ['loginToken'] });
  }

  const tokenRef = db.ref(`loginTokens/${loginToken}`);
  const tokenSnap = await tokenRef.once('value');
  const registro = tokenSnap.val();
  if (!registro) {
    return res.status(404).json({ error: 'Link de acesso inválido ou já expirado' });
  }
  if (registro.usado) {
    return res.status(409).json({ error: 'Este link de acesso já foi usado' });
  }
  if (Number(registro.expiraEm || 0) < Date.now()) {
    return res.status(410).json({ error: 'Este link de acesso expirou' });
  }

  await tokenRef.update({ usado: true, usadoEm: Date.now() });

  const customToken = await admin.auth().createCustomToken(registro.uid);
  const usuarioSnap = await db.ref(`usuarios/${registro.uid}`).once('value');
  const usuario = usuarioSnap.val() || {};

  return res.status(200).json({
    customToken,
    cadastroCompleto: usuario.cadastroCompleto === true,
    nome: usuario.nome || ''
  });
}

// ===================== [PIX DA TAXA DE ENTREGA NA PORTA] =====================
// Pedido do dono (2026-10-03): a cobrança em dinheiro/dívida da subida dependia
// do cliente "confessar" ter recebido o valor (ou virava dívida do lojista pro
// entregador) — o cliente podia simplesmente se negar a pagar e o prejuízo
// ficava com o entregador, e em dinheiro não tinha nem como comprovar. Agora,
// depois que o ENTREGADOR aceita subir (já autenticado, ver
// responderSolicitacaoSubida/subirStatus:'aceito' em /resolver-taxa-espera
// acima), o CLIENTE gera um Pix e paga direto pra plataforma, que credita o
// entregador assim que aprovado — o cliente nesta tela não está logado em
// nada (mesma situação de /consumir-login-cliente), então a identidade aqui
// é provada pelo mesmo rastreioToken que já governa o link de rastreio
// (ver criarLinksRastreioParaRota no frontend: rastreioToken/{token} ->
// {rotaId, pacoteId, lojistaUid}), nunca pelo Bearer normal.
async function resolverRastreioTokenServer(token) {
  const tokenStr = String(token || '').trim();
  if (!tokenStr) return null;
  const snap = await db.ref(`rastreioToken/${tokenStr}`).once('value');
  const dados = snap.val();
  if (!dados?.rotaId || !dados?.pacoteId || !dados?.lojistaUid) return null;
  return { rotaId: String(dados.rotaId), pacoteId: String(dados.pacoteId), lojistaUid: String(dados.lojistaUid) };
}

// ===== [PENDÊNCIAS DA ENTREGA — PAGAMENTO ÚNICO DO CLIENTE] (2026-10-08) =====
// Substituiu os dois fluxos separados (taxas / cobrança na entrega): o
// pedido do dono foi juntar TUDO que o cliente deve pagar nesta entrega —
// taxa de espera + taxa de entrega na porta + cobrança do PEDIDO (valor do
// produto, quando a loja escolhe que o entregador cobra na hora) — num card
// só, com uma escolha de forma de pagamento só (nunca duas cobranças em
// telas/momentos diferentes). Gerado pelo CLIENTE, na própria tela de
// rastreio — identidade provada pelo rastreioToken (nunca Bearer), mesmo
// esquema das outras rotas públicas acima.
//
// "Dinheiro" só é oferecido quando a cobrança do PEDIDO já aceita dinheiro
// (formasAceitas) — as taxas sozinhas continuam exigindo Pix (forçar Pix só
// nelas é o que evita o entregador ter que negociar trocado por uma taxa de
// R$3); quando a loja já confia em cobrar o produto em espécie, estender
// essa mesma confiança pro total combinado (produto + taxas, tudo na mesma
// entrega em mãos) é razoável.
async function calcularPendenciasCliente(lojistaUid, pacoteId) {
  const { dados: pacote, path: pacotePath } = await resolverEnvioLojista(lojistaUid, pacoteId);
  if (!pacote) return null;

  const espera = pacote.esperaEntrega || {};
  const cobranca = pacote.cobrancaEntrega;
  const cobrancaPendente = Boolean(cobranca?.ativa) && cobranca.status !== 'pago';
  const formasAceitasCobranca = Array.isArray(cobranca?.formasAceitas) ? cobranca.formasAceitas : [];

  // BUG CORRIGIDO 2026-10-08 (achado pelo dono em teste ao vivo, 2 rodadas):
  // a taxa de espera cresce minuto a minuto. 1ª rodada: só congelava quando
  // o cliente escolhia DINHEIRO — mas o mesmo problema acontecia com Pix: o
  // cliente gerava o Pix dentro da carência, só que o tempo virava (carência
  // estourava) ENQUANTO ele ainda estava pagando, e o valor pendente
  // calculado "ao vivo" criava uma SOBRA nova (ex: R$1 de espera) que nunca
  // tinha entrado em nenhum pagamento — nem no Pix já gerado (que já tinha
  // valor fixo), nem em lugar nenhum. 2ª rodada (pedido do dono: "o
  // cronômetro deve parar quando o cliente informar o tipo de pagamento"):
  // agora o congelamento acontece assim que o cliente clica em Pagar, pra
  // QUALQUER forma (dinheiro ou Pix) — o relógio da espera para de contar
  // pro cliente a partir do instante em que ele inicia o pagamento, e o
  // entregador recebe exatamente o que foi combinado, nem mais nem menos.
  const pendenciaCongelada = Boolean(espera?.escolhaClienteCongeladoEm);
  let valorEspera;
  let valorSubida;
  let valorCobranca;
  if (pendenciaCongelada) {
    valorEspera = espera.esperaStatus === 'pago' ? 0 : Number(espera.valorEsperaCongelado || 0);
    valorSubida = espera.subirStatus === 'pago' ? 0 : Number(espera.valorSubidaCongelado || 0);
    valorCobranca = cobrancaPendente ? Number(cobranca.valorCongelado || 0) : 0;
  } else {
    const chegouEm = Number(espera.chegouEm) || 0;
    const minutosEspera = chegouEm ? Math.max(0, Math.round((Date.now() - chegouEm) / 60000) - TAXA_ESPERA_GRACE_MIN) : 0;
    valorEspera = espera.esperaStatus === 'pago' ? 0 : Number((minutosEspera * TAXA_ESPERA_POR_MIN).toFixed(2));
    valorSubida = espera.subirStatus === 'aceito' ? TAXA_SUBIR_FIXA : 0;
    valorCobranca = cobrancaPendente ? (Number(cobranca.valor) || 0) : 0;
  }

  const valorTotal = Number((valorEspera + valorSubida + valorCobranca).toFixed(2));

  return {
    pacote,
    pacotePath,
    valorEspera,
    valorSubida,
    cobrancaPendente,
    valorCobranca,
    valorTotal,
    aceitaDinheiro: cobrancaPendente && formasAceitasCobranca.includes('dinheiro'),
    jaCongelada: pendenciaCongelada
  };
}

async function criarPagamentoPendenciasCliente(req, res) {
  const body = req.body || {};
  const resolvido = await resolverRastreioTokenServer(body.rastreioToken);
  const forma = String(body.forma || '').trim();
  if (!resolvido) {
    return res.status(404).json({ error: 'Link de rastreio inválido' });
  }
  if (forma !== 'dinheiro' && forma !== 'pix') {
    return res.status(400).json({ error: 'Forma de pagamento inválida' });
  }
  const { rotaId, pacoteId, lojistaUid } = resolvido;

  const pend = await calcularPendenciasCliente(lojistaUid, pacoteId);
  if (!pend) {
    return res.status(404).json({ error: 'Envio não encontrado' });
  }
  if (pend.valorTotal <= 0) {
    return res.status(422).json({ error: 'Nenhuma pendência para pagar' });
  }
  if (forma === 'dinheiro' && !pend.aceitaDinheiro) {
    return res.status(422).json({ error: 'Pagamento em dinheiro não disponível para este pedido' });
  }

  const rotaSnap = await db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}`).once('value');
  const rota = rotaSnap.val();
  const entregadorId = String(rota?.entregadorId || rota?.aceitoPor || '');
  if (!rota || !entregadorId) {
    return res.status(404).json({ error: 'Rota não encontrada' });
  }

  // Congela o valor pendente assim que o cliente clica em Pagar — pra
  // QUALQUER forma, dinheiro ou Pix (pedido do dono 2026-10-08: "o
  // cronômetro deve parar quando o cliente informar o tipo de pagamento").
  // Só congela na PRIMEIRA chamada (duplo clique, aba reaberta, ou o
  // cliente cancela e escolhe nessa mesma pendência de novo não re-congela
  // com um valor mais novo — ver cancelarEscolhaPagamentoCliente, que limpa
  // esse congelamento pra permitir recomeçar do zero).
  if (!pend.jaCongelada) {
    await syncEnvioFields(lojistaUid, pacoteId, {
      'esperaEntrega/escolhaClienteCongeladoEm': Date.now(),
      'esperaEntrega/valorEsperaCongelado': pend.valorEspera,
      'esperaEntrega/valorSubidaCongelado': pend.valorSubida,
      'cobrancaEntrega/valorCongelado': pend.valorCobranca
    });
  }

  if (forma === 'dinheiro') {
    // Dinheiro é só a DECLARAÇÃO do cliente — não finaliza nada sozinho.
    // Quem confirma de verdade é o ENTREGADOR, ao físicamente receber o
    // valor e clicar "Recebi em dinheiro" do lado dele (ver
    // confirmarRecebimentoPendenciasEntregador) — senão o cliente sozinho
    // poderia "declarar" que pagou sem nunca ter entregado nada, criando uma
    // dívida real pro entregador por algo que não aconteceu.
    await syncEnvioFields(lojistaUid, pacoteId, {
      'cobrancaEntrega/escolhaCliente': 'dinheiro',
      'cobrancaEntrega/escolhaClienteEm': Date.now()
    });
    // Espelha a escolha E o valor TOTAL já congelado pra tela do cliente —
    // sem isso ela recalcularia "ao vivo" de novo a partir de chegouEm (só
    // tem o espelho público, não os campos congelados acima) e mostraria um
    // valor crescendo, diferente do que foi realmente combinado/travado.
    await db.ref(`rastreioPublico/${rotaId}/pacotes/${pacoteId}`).update({ cobrancaEscolha: 'dinheiro', valorTotalCongelado: pend.valorTotal }).catch(() => {});
    return res.status(200).json({ forma: 'dinheiro', valor: pend.valorTotal });
  }

  // forma === 'pix': espelha a escolha também (pedido do dono: o entregador
  // nunca deve poder gerar um Pix/confirmar dinheiro em paralelo enquanto o
  // cliente já escolheu Pix — ver renderBlocoCobrancaEntrega no frontend,
  // que só mostra "Recebi em dinheiro" quando escolhaCliente === 'dinheiro',
  // nunca quando já é 'pix'). Diferente de dinheiro, aqui não é uma
  // declaração que precisa de confirmação manual depois — o próprio Pix
  // aprovado já finaliza tudo sozinho (ver checarPagamentoPendenciasCliente).
  await syncEnvioFields(lojistaUid, pacoteId, {
    'cobrancaEntrega/escolhaCliente': 'pix',
    'cobrancaEntrega/escolhaClienteEm': Date.now()
  });
  await db.ref(`rastreioPublico/${rotaId}/pacotes/${pacoteId}`).update({ cobrancaEscolha: 'pix', valorTotalCongelado: pend.valorTotal }).catch(() => {});

  // forma === 'pix' — um Pix só pro total combinado.
  const token = MP_ACCESS_TOKEN.value();
  if (!token) {
    return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado no servidor' });
  }
  const ambiente = ambienteDoTokenMp(token);

  const nomeCliente = String(pend.pacote?.destinatario || 'Cliente Flex').trim() || 'Cliente Flex';
  const [firstNameCliente, ...restoNomeCliente] = nomeCliente.split(' ');
  const lastNameCliente = restoNomeCliente.join(' ') || 'Flex';
  const partesDesc = [];
  if (pend.valorEspera > 0) partesDesc.push('espera');
  if (pend.valorSubida > 0) partesDesc.push('entrega na porta');
  if (pend.cobrancaPendente) partesDesc.push('pedido');

  const mpData = await criarPagamentoPixMp(token, {
    valor: pend.valorTotal,
    descricao: `Flex - pagamento da entrega (${partesDesc.join(' + ')}) (pedido ${pacoteId})`,
    payerEmail: `cliente-${pacoteId}@flex.app`,
    payerFirstName: firstNameCliente || 'Cliente',
    payerLastName: lastNameCliente,
    externalReference: `pendencias:${rotaId}:${pacoteId}`,
    idempotencyKey: `${lojistaUid}-${rotaId}-${pacoteId}-pendencias-${Date.now()}`
  });

  const tx = mpData?.point_of_interaction?.transaction_data || {};
  const pixCode = tx.qr_code || '';
  if (!pixCode) {
    return res.status(502).json({ error: 'Mercado Pago não retornou código Pix Copia e Cola' });
  }

  const paymentId = String(mpData?.id || '');
  await db.ref(`mp_payments/${paymentId}`).set({
    tenantId: lojistaUid,
    rotaId,
    envioId: pacoteId,
    entregadorId,
    tipo: 'pendencias_entrega_cliente',
    total: pend.valorTotal,
    valorEspera: pend.valorEspera,
    valorSubida: pend.valorSubida,
    valorCobranca: pend.valorCobranca,
    ambiente,
    criadoEm: Date.now()
  });
  await db.ref(`${pend.pacotePath}/esperaEntrega/taxasPixPaymentId`).set(paymentId).catch(() => {});

  return res.status(200).json({
    forma: 'pix',
    paymentId,
    status: mpData?.status || 'pending',
    statusDetail: mpData?.status_detail || '',
    pixCode,
    ticketUrl: tx.ticket_url || '',
    qrCodeBase64: tx.qr_code_base64 || '',
    valor: pend.valorTotal,
    valorEspera: pend.valorEspera,
    valorSubida: pend.valorSubida,
    valorCobranca: pend.valorCobranca,
    ambiente
  });
}

async function checarPagamentoPendenciasCliente(req, res) {
  const body = req.body || {};
  const resolvido = await resolverRastreioTokenServer(body.rastreioToken);
  const paymentId = String(body.paymentId || '').trim();
  if (!resolvido || !paymentId) {
    return res.status(404).json({ error: 'Link de rastreio ou pagamento inválido' });
  }
  const { rotaId, pacoteId, lojistaUid } = resolvido;

  const token = MP_ACCESS_TOKEN.value();
  if (!token) {
    return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado no servidor' });
  }

  const registroSnap = await db.ref(`mp_payments/${paymentId}`).once('value');
  const registro = registroSnap.val();
  if (!registro || registro.tipo !== 'pendencias_entrega_cliente' || String(registro.tenantId) !== lojistaUid || String(registro.envioId) !== pacoteId || String(registro.rotaId) !== rotaId) {
    return res.status(404).json({ error: 'Pagamento não encontrado para este link de rastreio' });
  }

  const data = await consultarPagamentoPixMp(token, paymentId);
  const statusPagamento = data?.status || 'pending';

  if (statusPagamento === 'approved') {
    const { path: envioPath, dados: pacote } = await resolverEnvioLojista(lojistaUid, pacoteId);
    if (envioPath && pacote) {
      // Taxas (espera + entrega na porta) — retidas até a entrega ser de
      // fato confirmada, igual sempre foi (ver liberarCreditoSubidaSeElegivel/
      // liberarCreditoEsperaSeElegivel, chamadas em confirmarEntregaPacoteAtual).
      if (Number(registro.valorEspera) > 0 || Number(registro.valorSubida) > 0) {
        const marcadorTaxasRef = db.ref(`${envioPath}/esperaEntrega/taxasCreditoEfetuadoEm`);
        const marcadorTaxasSnap = await marcadorTaxasRef.once('value');
        if (!marcadorTaxasSnap.val()) {
          await marcadorTaxasRef.set(Date.now());
          const updatesTaxas = {};
          if (Number(registro.valorSubida) > 0) {
            updatesTaxas['esperaEntrega/subirStatus'] = 'pago';
            updatesTaxas['esperaEntrega/subidaPagoEm'] = Date.now();
          }
          if (Number(registro.valorEspera) > 0) {
            updatesTaxas['esperaEntrega/esperaStatus'] = 'pago';
            updatesTaxas['esperaEntrega/valorEsperaPago'] = registro.valorEspera;
            updatesTaxas['esperaEntrega/esperaPagoEm'] = Date.now();
          }
          await syncEnvioFields(lojistaUid, pacoteId, updatesTaxas);

          const mirrorTaxas = {};
          if (Number(registro.valorSubida) > 0) mirrorTaxas.subirStatus = 'pago';
          if (Number(registro.valorEspera) > 0) mirrorTaxas.esperaStatus = 'pago';
          if (Object.keys(mirrorTaxas).length) {
            await db.ref(`rastreioPublico/${rotaId}/pacotes/${pacoteId}`).update(mirrorTaxas).catch(() => {});
          }

          // Caso raro: o Pix só aprova DEPOIS que a entrega já foi confirmada
          // — libera na hora, senão ficaria retido pra sempre.
          const esperaAtual = pacote.esperaEntrega || {};
          if (esperaAtual.finalizada) {
            const pacoteAtualizado = {
              ...pacote,
              esperaEntrega: {
                ...esperaAtual,
                subirStatus: Number(registro.valorSubida) > 0 ? 'pago' : esperaAtual.subirStatus,
                esperaStatus: Number(registro.valorEspera) > 0 ? 'pago' : esperaAtual.esperaStatus,
                valorEsperaPago: Number(registro.valorEspera) > 0 ? registro.valorEspera : esperaAtual.valorEsperaPago
              }
            };
            await liberarCreditoSubidaSeElegivel(lojistaUid, pacoteId, registro.entregadorId, pacoteAtualizado);
            await liberarCreditoEsperaSeElegivel(lojistaUid, pacoteId, registro.entregadorId, pacoteAtualizado);
          }
        }
      }

      // Cobrança do pedido (produto) — vira crédito direto na carteira da
      // LOJA, nunca passa pelo entregador nem gera dívida (ele só
      // intermediou a cobrança). Marcador próprio, independente do das taxas.
      if (Number(registro.valorCobranca) > 0) {
        const marcadorCobrancaRef = db.ref(`${envioPath}/cobrancaEntrega/creditoEfetuadoEm`);
        const marcadorCobrancaSnap = await marcadorCobrancaRef.once('value');
        if (!marcadorCobrancaSnap.val()) {
          const saldoRef = db.ref(`usuarios/${lojistaUid}/financeiro/saldo`);
          const saldoSnap = await saldoRef.once('value');
          const saldoAntes = Number(saldoSnap.val() || 0);
          const saldoDepois = Number((saldoAntes + registro.valorCobranca).toFixed(2));
          await saldoRef.set(saldoDepois);
          await marcadorCobrancaRef.set(Date.now());
          await db.ref(`usuarios/${lojistaUid}/financeiro/transacoes`).push({
            protocolo: gerarProtocoloTransacaoServer(),
            tipo: 'CREDITO',
            metodo: 'pix',
            valor: registro.valorCobranca,
            descricao: `Cobrança na entrega recebida via Pix (pedido #${pacoteId})`,
            remetente: 'Cliente (Pix)',
            destinatario: 'Carteira da loja',
            paymentIdMp: String(paymentId),
            criadoEm: Date.now()
          });
          await db.ref(`${envioPath}/cobrancaEntrega`).update({ status: 'pago', pagoEm: Date.now() });
          await db.ref(`rastreioPublico/${rotaId}/pacotes/${pacoteId}`).update({ cobrancaStatus: 'pago' }).catch(() => {});
        }
      }
    }
  }

  return res.status(200).json({
    paymentId,
    status: statusPagamento,
    statusDetail: data?.status_detail || '',
    ambiente: ambienteDoTokenMp(token)
  });
}

// Pedido do dono (2026-10-08): "deve ter um botão cancelar no meio de
// pagamento (às vezes clicou sem querer ou mudou de ideia) e escolher
// novamente o meio de pagamento". A escolha (dinheiro/pix) e o congelamento
// do valor (ver criarPagamentoPendenciasCliente) são escritos como
// write-once no espelho público (rastreioPublico) bem de propósito — o
// CLIENTE não consegue desfazer sozinho pelo navegador (nem com
// FLEXA_PAYMENTS_PROXY_URL fora do ar). Precisa do Admin SDK aqui, que
// ignora essa trava. Só permite cancelar enquanto nada foi CONFIRMADO de
// verdade ainda (nenhum status 'pago') — depois disso não tem mais o que
// desfazer, só o que já está resolvido.
async function cancelarEscolhaPagamentoCliente(req, res) {
  const body = req.body || {};
  const resolvido = await resolverRastreioTokenServer(body.rastreioToken);
  if (!resolvido) {
    return res.status(404).json({ error: 'Link de rastreio inválido' });
  }
  const { rotaId, pacoteId, lojistaUid } = resolvido;

  const { dados: pacote } = await resolverEnvioLojista(lojistaUid, pacoteId);
  if (!pacote) {
    return res.status(404).json({ error: 'Envio não encontrado' });
  }
  const espera = pacote.esperaEntrega || {};
  const cobranca = pacote.cobrancaEntrega || {};
  if (espera.esperaStatus === 'pago' || espera.subirStatus === 'pago' || cobranca.status === 'pago') {
    return res.status(422).json({ error: 'Pagamento já confirmado, não é possível cancelar' });
  }

  // Zera a escolha e o congelamento — a próxima chamada de
  // criarPagamentoPendenciasCliente recalcula tudo AO VIVO de novo (o
  // relógio da espera volta a contar a partir de agora, não do zero: o
  // tempo real de espera não para só porque o cliente mudou de ideia sobre
  // a forma de pagamento).
  await syncEnvioFields(lojistaUid, pacoteId, {
    'cobrancaEntrega/escolhaCliente': null,
    'cobrancaEntrega/escolhaClienteEm': null,
    'cobrancaEntrega/valorCongelado': null,
    'esperaEntrega/escolhaClienteCongeladoEm': null,
    'esperaEntrega/valorEsperaCongelado': null,
    'esperaEntrega/valorSubidaCongelado': null
  });
  await db.ref(`rastreioPublico/${rotaId}/pacotes/${pacoteId}`).update({ cobrancaEscolha: null, valorTotalCongelado: null }).catch(() => {});

  return res.status(200).json({ ok: true });
}

// Mesma normalização de normalizarStatusRotaFiltro no frontend (sem a parte
// de remover acentos — os valores reais gravados no banco pra status de
// rota são sempre ASCII puro).
// BUG CORRIGIDO 2026-09-28: card "Em rota"/"Rotas Recentes" da home do
// entregador mostrava "Origem: --" / "Destino: --" sempre. Causa raiz: esses
// campos (origemLabel/origemCidade/destinos/destinoPrincipal) nunca foram de
// fato gravados na rota do LOJISTA — eram só computados na hora, client-side,
// só pra montar a lista do marketplace (carregarMarketplaceRotasEntregador).
// Então quando o entregador aceitava, `rotaAtualizada` (o nó real da rota)
// nunca tinha esses campos, e o espelho gravado em
// usuarios/{uidEntregador}/rotas/{rotaId} caía sempre no fallback vazio.
// Resolve calculando de verdade a partir do endereço da loja + pacotes da
// rota (mesma fonte que o índice do marketplace usa) no momento do aceite.
function resolverCidadeDestinoServer(pacote = {}) {
  const cidadeDireta = (pacote?.cidadeDestino || pacote?.cidade || '').toString().trim();
  if (cidadeDireta) return cidadeDireta;
  const destino = (pacote?.destino || pacote?.destinoEndereco || '').toString().trim();
  if (!destino) return '';
  const antesUf = destino.includes('/') ? destino.split('/')[0] : destino;
  const partes = antesUf.split(',').map((p) => p.trim()).filter(Boolean);
  return partes.length ? partes[partes.length - 1].replace(/\)$/g, '').trim() : '';
}

async function calcularResumoRotaParaEntregador(lojistaUid, pacoteIds) {
  const [enderecoSnap, clientesSnap, pacotesSnap] = await Promise.all([
    db.ref(`usuarios/${lojistaUid}/endereco`).once('value'),
    db.ref(`usuarios/${lojistaUid}/clientes`).once('value'),
    db.ref(`usuarios/${lojistaUid}/pacotes`).once('value')
  ]);
  const endereco = enderecoSnap.val() || {};
  const origemCidade = (endereco.cidade || '').toString().trim();
  const origemUf = (endereco.uf || endereco.estado || '').toString().trim().toUpperCase();
  const origemLabel = origemCidade ? (origemUf ? `${origemCidade}, ${origemUf}` : origemCidade) : '';
  const origemBairro = (endereco.bairro || '').toString().trim();

  const mapaPacotes = new Map();
  const clientesNo = clientesSnap.val() || {};
  Object.values(clientesNo).forEach((cliente) => {
    const historico = Array.isArray(cliente?.historico) ? cliente.historico : [];
    historico.forEach((h) => {
      if (!h?.id) return;
      mapaPacotes.set(String(h.id), {
        cidade: resolverCidadeDestinoServer(h),
        bairro: (h?.bairroDestino || '').toString().trim(),
        distanciaKm: Number(h?.distanciaKm || 0),
        duracaoMin: Number(h?.duracaoMin || 0),
        valorFrete: Number(h?.valorFrete || 0)
      });
    });
  });
  const pacotesNo = pacotesSnap.val() || {};
  Object.keys(pacotesNo).forEach((pid) => {
    const p = pacotesNo[pid];
    mapaPacotes.set(String(pid), {
      cidade: resolverCidadeDestinoServer(p),
      bairro: (p?.bairroDestino || '').toString().trim(),
      distanciaKm: Number(p?.distanciaKm || 0),
      duracaoMin: Number(p?.duracaoMin || 0),
      valorFrete: Number(p?.valorFrete || 0)
    });
  });

  const pacotesResumo = pacoteIds.map((id) => mapaPacotes.get(String(id))).filter(Boolean);
  const destinos = [...new Set(pacotesResumo.map((p) => p.cidade).filter(Boolean))];
  const bairrosDestino = [...new Set(pacotesResumo.map((p) => p.bairro).filter(Boolean))];

  return {
    origemLabel,
    origemCidade,
    origemBairro,
    destinos,
    destinoPrincipal: destinos.length > 1 ? 'Multi-cidades' : (destinos[0] || ''),
    bairrosDestino,
    distanciaTotal: pacotesResumo.reduce((acc, p) => acc + p.distanciaKm, 0),
    duracaoTotal: pacotesResumo.reduce((acc, p) => acc + p.duracaoMin, 0),
    totalFrete: pacotesResumo.reduce((acc, p) => acc + p.valorFrete, 0)
  };
}

// ===== [ENTREGA FLASH/EXPRESSO — PRAZO DE 2H] (pedido do dono 2026-09-29) =====
// A promessa de flash/expresso (entregar em até 2h) nunca foi de fato
// aplicada em código — só existia um campo informativo (temFlash) pra
// mostrar a tag "⚡ Flash" no marketplace, sem nenhuma trava real. Regra
// nova: enquanto o entregador tiver QUALQUER pacote flash/expresso ainda
// não entregue (não checa se o prazo já estourou — se já estourou, ele
// precisa resolver antes de piorar pegando mais trabalho), ele não pode
// aceitar rota nova. O prazo em si (aceitoEm + 2h) é calculado no cliente
// a partir de rota.aceitoEm, que já é gravado de verdade por este mesmo
// endpoint — não precisa de campo novo no banco.
const FLASH_PRAZO_MS = 2 * 60 * 60 * 1000;

function pacoteEhFlashServer(pacote) {
  const servico = String(pacote?.servico || '').toLowerCase();
  return servico.includes('flash') || servico.includes('expresso');
}

async function entregadorTemFlashPendente(uidEntregador) {
  const rotasSnap = await db.ref(`usuarios/${uidEntregador}/rotas`).once('value');
  const rotasNo = rotasSnap.val() || {};
  const rotasEmRota = Object.entries(rotasNo)
    .filter(([, r]) => normalizarStatusRotaServer(r?.status || r?.pagamentoStatus || 'CRIADA') === 'EM_ROTA');

  for (const [rotaId, rota] of rotasEmRota) {
    const lojistaUid = rota?.origemLojistaUid || rota?.lojistaId || rota?.lojistaUid;
    const pacoteIds = Array.isArray(rota?.pacoteIds) ? rota.pacoteIds : (Array.isArray(rota?.pacotes) ? rota.pacotes : []);
    if (!lojistaUid || !pacoteIds.length) continue;

    const [clientesSnap, pacotesSnap] = await Promise.all([
      db.ref(`usuarios/${lojistaUid}/clientes`).once('value'),
      db.ref(`usuarios/${lojistaUid}/pacotes`).once('value')
    ]);
    const mapa = new Map();
    const clientesNo = clientesSnap.val() || {};
    Object.values(clientesNo).forEach((cliente) => {
      const historico = Array.isArray(cliente?.historico) ? cliente.historico : [];
      historico.forEach((h) => { if (h?.id) mapa.set(String(h.id), h); });
    });
    const pacotesNo = pacotesSnap.val() || {};
    Object.keys(pacotesNo).forEach((pid) => mapa.set(String(pid), pacotesNo[pid]));

    for (const pid of pacoteIds) {
      const p = mapa.get(String(pid));
      if (!p || !pacoteEhFlashServer(p)) continue;
      const status = String(p?.status || '').toUpperCase();
      if (status === 'CONCLUIDO' || status === 'CANCELADO') continue;
      return {
        bloqueado: true,
        rotaId,
        prazoFlashAte: Number(rota?.aceitoEm || rota?.criadoEm || Date.now()) + FLASH_PRAZO_MS
      };
    }
  }
  return { bloqueado: false };
}

function normalizarStatusRotaServer(status) {
  const s = String(status || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (!s) return 'BUSCANDO';
  if (s === 'EM_ROTA') return 'EM_ROTA';
  if (['CONCLUIDO', 'CONCLUIDA', 'FINALIZADA', 'FINALIZADO', 'ENTREGUE'].includes(s)) return 'CONCLUIDO';
  if (s === 'CANCELADO' || s === 'CANCELADA') return 'CANCELADO';
  return 'BUSCANDO';
}

// Pedido do dono (2026-10-09): limpeza PROATIVA das rotas "aceitas" cujo
// prazo de 20 min pra coleta já estourou — devolve status:'BUSCANDO' e tira
// o entregador, pra elas aparecerem de novo na LISTAGEM do marketplace (não
// só ficarem aceitáveis nos bastidores, ver o aceite atrasado dentro de
// /aceitar-rota-marketplace, que cobre a aceitação em si mas não corrige o
// que a listagem mostra até alguém escrever algo). Lê marketplacePublico
// (o mesmo espelho que o app já lê pra montar a lista) em vez de usuarios/*
// inteiro — mais barato e já filtrado só pra lojistas.
async function liberarRotasAtrasadasServer() {
  const snap = await db.ref('marketplacePublico').once('value');
  const usuariosNo = snap.val() || {};
  const agora = Date.now();
  const liberadas = [];

  for (const lojistaUid of Object.keys(usuariosNo)) {
    const rotasNo = usuariosNo[lojistaUid]?.rotas || {};
    for (const rotaId of Object.keys(rotasNo)) {
      const rotaEspelho = rotasNo[rotaId] || {};
      const entregadorIdEspelho = String(rotaEspelho.entregadorId || rotaEspelho.aceitoPor || '');
      if (!entregadorIdEspelho) continue;
      if (normalizarStatusRotaServer(rotaEspelho.status || rotaEspelho.pagamentoStatus) !== 'EM_ROTA') continue;
      if (rotaEspelho.coletaConfirmada === true) continue;
      const aceitoEmEspelho = Number(rotaEspelho.aceitoEm || 0);
      if (!aceitoEmEspelho || (agora - aceitoEmEspelho) < PRAZO_COLETA_MS) continue;

      // Confere e reverte de verdade via transação na origem (nunca confia
      // só no espelho, que pode estar um instante desatualizado).
      let entregadorRevertidoId = '';
      const rotaRef = db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}`);
      const tx = await rotaRef.transaction((atual) => {
        if (!atual) return atual;
        if (normalizarStatusRotaServer(atual?.status || atual?.pagamentoStatus) !== 'EM_ROTA') return;
        if (atual?.coletaConfirmada === true) return;
        const aceitoEmAtual = Number(atual?.aceitoEm || 0);
        if (!aceitoEmAtual || (agora - aceitoEmAtual) < PRAZO_COLETA_MS) return;
        entregadorRevertidoId = String(atual?.entregadorId || atual?.aceitoPor || '');
        return {
          ...atual,
          status: 'BUSCANDO',
          entregadorId: null,
          aceitoPor: null,
          aceitoEm: null,
          entregadorNome: null,
          entregadorFoto: null,
          codigoConfirmacaoColeta: null,
          atualizadoEm: agora
        };
      }).catch(() => ({ committed: false }));

      if (!tx.committed || !entregadorRevertidoId) continue;

      liberadas.push({ lojistaUid, rotaId, entregadorId: entregadorRevertidoId });
      await db.ref(`usuarios/${entregadorRevertidoId}/rotas/${rotaId}`).remove().catch(() => {});
      await db.ref(`rastreioPublico/${rotaId}`).update({ statusRota: 'BUSCANDO' }).catch(() => {});
      await db.ref(`usuarios/${entregadorRevertidoId}/notificacoes`).push({
        tipo: 'rota_liberada_atraso',
        titulo: 'Rota liberada por atraso',
        mensagem: 'Você não confirmou a coleta em até 20 minutos — essa rota voltou a ficar disponível para outros entregadores.',
        rotaId: String(rotaId),
        lida: false,
        criadoEm: agora
      }).catch(() => {});

      // Mesmo dual-write de /aceitar-rota-marketplace, na direção contrária:
      // sem isso, a tela de Pedidos do lojista (que confia em
      // pacotes/{id}/status, não no status da rota) continuava mostrando
      // "Em rota" pros pacotes mesmo depois da rota voltar a "Buscando".
      const rotaRevertidaVal = tx.snapshot.val() || {};
      const pacoteIdsRevertidos = Array.isArray(rotaRevertidaVal.pacoteIds) ? rotaRevertidaVal.pacoteIds : (Array.isArray(rotaRevertidaVal.pacotes) ? rotaRevertidaVal.pacotes : []);
      if (pacoteIdsRevertidos.length) {
        const clientesSnap = await db.ref(`usuarios/${lojistaUid}/clientes`).once('value');
        const clientesNo = clientesSnap.val() || {};
        const idsSet = new Set(pacoteIdsRevertidos.map((id) => String(id)));
        const updatesStatus = {};
        Object.keys(clientesNo).forEach((clienteId) => {
          const historico = Array.isArray(clientesNo[clienteId]?.historico) ? clientesNo[clienteId].historico : [];
          historico.forEach((h, idx) => {
            const idAtual = String(h?.id || `envio-${clienteId}-${idx}`);
            if (!idsSet.has(idAtual)) return;
            updatesStatus[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/status`] = 'BUSCANDO';
            updatesStatus[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/atualizadoEm`] = agora;
          });
        });
        pacoteIdsRevertidos.forEach((pid) => {
          updatesStatus[`usuarios/${lojistaUid}/pacotes/${pid}/status`] = 'BUSCANDO';
          updatesStatus[`usuarios/${lojistaUid}/pacotes/${pid}/statusRaw`] = 'BUSCANDO';
          updatesStatus[`usuarios/${lojistaUid}/pacotes/${pid}/atualizadoEm`] = agora;
        });
        if (Object.keys(updatesStatus).length) {
          await db.ref().update(updatesStatus).catch(() => {});
        }
      }
    }
  }

  return liberadas;
}

function gerarCodigoConfirmacaoEntregaServer() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Protocolo de pagamento (pedido do dono 2026-09-30): toda transação em
// financeiro/transacoes ganha um identificador curto e legível pra facilitar
// achar o comprovante depois — as que envolvem Pix de verdade (cobrança,
// quitação de dívida) também guardam o paymentId real da Mercado Pago, que é
// a chave que realmente resolve o comprovante no painel deles.
function gerarProtocoloTransacaoServer() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TX-${ts}-${rand}`;
}

async function canAccessTenant(requester, tenantId) {
  if (!requester) return false;

  if (requester.uid === tenantId) return true;

  if (requester.admin === true || requester.role === 'admin') return true;

  // fallback: check user type in database
  const snap = await db.ref(`usuarios/${requester.uid}/tipo`).once('value');
  return snap.val() === 'admin';
}

exports.routing = onRequest({ region: ROUTING_REGION, timeoutSeconds: 20, secrets: [GOOGLE_MAPS_SERVER_KEY], invoker: 'public' }, async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const path = (req.path || '/').replace(/\/+$/, '') || '/';
  if (path !== '/' && path !== '/estimate-route') {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const requester = await resolveRequester(req);
    if (REQUIRE_AUTH && !requester) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId, tenantType, origemEndereco, destinoEndereco, origemGeo, destinoGeo } = req.body || {};

    if (!tenantId || !tenantType || !destinoEndereco) {
      return res.status(400).json({ error: 'Missing required fields', required: ['tenantId', 'tenantType', 'destinoEndereco'] });
    }

    if (tenantType !== 'lojista') {
      return res.status(400).json({ error: 'Unsupported tenantType' });
    }

    if (REQUIRE_AUTH) {
      const allowed = await canAccessTenant(requester, tenantId);
      if (!allowed) {
        return res.status(403).json({ error: 'Forbidden tenant access' });
      }
    }

    const enderecoLojistaSnap = await db.ref(`usuarios/${tenantId}/endereco`).once('value');
    const enderecoLojistaObj = enderecoLojistaSnap.val() || {};
    const origemResolvida = formatAddress(enderecoLojistaObj) || origemEndereco || '';

    if (!origemResolvida) {
      return res.status(400).json({ error: 'Origem não definida para o lojista' });
    }

    const geoOrigemPreferida = normalizeGeo(origemGeo) || normalizeGeo(enderecoLojistaObj.geo);
    const geoDestinoPreferida = normalizeGeo(destinoGeo);
    const mapsKey = GOOGLE_MAPS_SERVER_KEY.value();

    const [originGeo, destinationGeo] = await Promise.all([
      geoOrigemPreferida ? Promise.resolve(geoOrigemPreferida) : geocodeGoogle(origemResolvida, mapsKey),
      geoDestinoPreferida ? Promise.resolve(geoDestinoPreferida) : geocodeGoogle(destinoEndereco, mapsKey)
    ]);

    if (!originGeo || !destinationGeo) {
      return res.status(422).json({ error: 'Não foi possível geocodificar origem/destino' });
    }

    const route = await routeGoogleDistanceMatrix(originGeo, destinationGeo, mapsKey);
    if (!route) {
      return res.status(422).json({ error: 'Não foi possível calcular rota' });
    }

    return res.status(200).json({
      tenantId,
      tenantType,
      origemEndereco: origemResolvida,
      destinoEndereco,
      distanciaKm: route.distanciaKm,
      duracaoMin: route.duracaoMin
    });
  } catch (error) {
    logger.error('routing_error', error);
    return res.status(500).json({ error: 'Internal error', message: error.message });
  }
});

function ambienteDoTokenMp(token) {
  return String(token || '').startsWith('TEST-') ? 'teste' : 'producao';
}

async function criarPagamentoPixMp(token, dados) {
  const response = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': dados.idempotencyKey
    },
    body: JSON.stringify({
      transaction_amount: Number(dados.valor.toFixed(2)),
      description: dados.descricao,
      payment_method_id: 'pix',
      payer: {
        email: dados.payerEmail,
        first_name: dados.payerFirstName,
        last_name: dados.payerLastName
      },
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      external_reference: dados.externalReference
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detalhe = data?.message || data?.error || data?.cause?.[0]?.description || `HTTP ${response.status}`;
    throw new Error(`Mercado Pago: ${detalhe}`);
  }
  return data;
}

async function consultarPagamentoPixMp(token, paymentId) {
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detalhe = data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`Mercado Pago: ${detalhe}`);
  }
  return data;
}

// Endpoints: POST /create-pix, POST /check-pix
// O access token do Mercado Pago nunca sai do servidor. O valor cobrado é
// sempre recalculado aqui a partir dos envios persistidos (nunca confia em
// total enviado pelo cliente).
exports.payments = onRequest({ region: PAYMENTS_REGION, timeoutSeconds: 20, secrets: [MP_ACCESS_TOKEN], invoker: 'public' }, async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const path = (req.path || '/').replace(/\/+$/, '') || '/';
  const rotasValidas = ['/create-pix', '/check-pix', '/criar-pagamento-pendencias-cliente', '/checar-pagamento-pendencias-cliente', '/cancelar-escolha-pagamento-cliente', '/create-pix-devolucao', '/check-pix-devolucao', '/create-pix-quitacao-divida', '/check-pix-quitacao-divida', '/resolver-taxa-espera', '/confirmar-taxa-espera-recebida', '/confirmar-cobranca-dinheiro', '/creditar-rota-finalizada', '/admin-atualizar-status-rota', '/admin-excluir-rota', '/aceitar-rota-marketplace', '/liberar-rotas-atrasadas', '/gerar-login-cliente', '/consumir-login-cliente'];
  if (!rotasValidas.includes(path)) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Login automático do cliente final via link de rastreio (plano 2026-09-28):
  // o cliente clica no link SEM estar logado em nada ainda, então esta rota
  // não pode exigir o Bearer token que todas as outras exigem abaixo — a
  // prova de identidade aqui é o próprio loginToken (aleatório, uso único,
  // expira rápido — ver gerarLoginClienteToken). Tratada antes do bloco de
  // autenticação de propósito.
  if (path === '/consumir-login-cliente') {
    try {
      return await consumirLoginCliente(req, res);
    } catch (error) {
      logger.error('consumir_login_cliente_error', error);
      return res.status(500).json({ error: 'Internal error', message: error.message });
    }
  }

  // Mesmo motivo do bloco acima: o cliente nesta tela (link de rastreio
  // público) não está logado em nada, então estas rotas também precisam
  // rodar antes do Bearer obrigatório — a prova de identidade é o
  // rastreioToken (ver resolverRastreioTokenServer).
  if (path === '/criar-pagamento-pendencias-cliente') {
    try {
      return await criarPagamentoPendenciasCliente(req, res);
    } catch (error) {
      logger.error('criar_pagamento_pendencias_cliente_error', error);
      return res.status(500).json({ error: 'Internal error', message: error.message });
    }
  }
  if (path === '/checar-pagamento-pendencias-cliente') {
    try {
      return await checarPagamentoPendenciasCliente(req, res);
    } catch (error) {
      logger.error('checar_pagamento_pendencias_cliente_error', error);
      return res.status(500).json({ error: 'Internal error', message: error.message });
    }
  }
  if (path === '/cancelar-escolha-pagamento-cliente') {
    try {
      return await cancelarEscolhaPagamentoCliente(req, res);
    } catch (error) {
      logger.error('cancelar_escolha_pagamento_cliente_error', error);
      return res.status(500).json({ error: 'Internal error', message: error.message });
    }
  }

  let ambiente = null;
  try {
    const requester = await resolveRequester(req);
    if (!requester) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (path === '/gerar-login-cliente') {
      return await gerarLoginCliente(req, res, requester);
    }

    const token = MP_ACCESS_TOKEN.value();
    if (!token) {
      return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado no servidor' });
    }
    ambiente = ambienteDoTokenMp(token);

    if (path === '/create-pix') {
      const { tenantId, rotaId, envioIds } = req.body || {};
      if (!tenantId || !rotaId || !Array.isArray(envioIds) || !envioIds.length) {
        return res.status(400).json({ error: 'Missing required fields', required: ['tenantId', 'rotaId', 'envioIds[]'] });
      }

      const allowed = await canAccessTenant(requester, tenantId);
      if (!allowed) {
        return res.status(403).json({ error: 'Forbidden tenant access' });
      }

      // valor sempre recalculado a partir dos envios persistidos, nunca do que o cliente mandar
      const pacotesSnap = await db.ref(`usuarios/${tenantId}/pacotes`).once('value');
      const pacotesNo = pacotesSnap.val() || {};
      let total = 0;
      let contados = 0;
      envioIds.forEach((id) => {
        const p = pacotesNo[id];
        if (p && Number.isFinite(Number(p.valorFrete))) {
          total += Number(p.valorFrete);
          contados += 1;
        }
      });
      if (contados !== envioIds.length || total <= 0) {
        return res.status(422).json({ error: 'Não foi possível validar os envios/valor da rota' });
      }

      const usuarioSnap = await db.ref(`usuarios/${tenantId}`).once('value');
      const usuario = usuarioSnap.val() || {};
      const nomeCompleto = String(usuario?.nome || 'Lojista Flex').trim() || 'Lojista Flex';
      const [firstName, ...restoNome] = nomeCompleto.split(' ');
      const lastName = restoNome.join(' ') || 'Flex';
      const payerEmail = String(usuario?.email || requester.email || 'pagador@flex.app');

      const mpData = await criarPagamentoPixMp(token, {
        valor: total,
        descricao: `Flex Rota ${rotaId} (${envioIds.length} pacote(s))`,
        payerEmail,
        payerFirstName: firstName || 'Lojista',
        payerLastName: lastName,
        externalReference: rotaId,
        idempotencyKey: `${tenantId}-${rotaId}-${Date.now()}`
      });

      const tx = mpData?.point_of_interaction?.transaction_data || {};
      const pixCode = tx.qr_code || '';
      if (!pixCode) {
        return res.status(502).json({ error: 'Mercado Pago não retornou código Pix Copia e Cola' });
      }

      const paymentId = String(mpData?.id || '');
      await db.ref(`mp_payments/${paymentId}`).set({
        tenantId,
        rotaId,
        envioIds,
        total,
        ambiente,
        criadoEm: Date.now()
      });

      return res.status(200).json({
        paymentId,
        status: mpData?.status || 'pending',
        statusDetail: mpData?.status_detail || '',
        pixCode,
        ticketUrl: tx.ticket_url || '',
        qrCodeBase64: tx.qr_code_base64 || '',
        totalFrete: total,
        ambiente
      });
    }

    // Devolucao: entrega falhou (cliente nao pagou, ausente, endereco errado,
    // recusou, etc), entregador leva o pacote de volta pra loja. O entregador
    // recebe o frete normal da rota de qualquer forma (ver creditarCarteiraEntregadorRotaFinalizada
    // no frontend); esta cobranca aqui e um EXTRA que o LOJISTA paga pelo frete
    // da viagem de volta, cobrado na hora via Pix (payer = lojista, igual o
    // pagamento de rota), creditado direto no saldo do entregador quando aprovado.
    // Ver project-flexa-cobranca-entrega-dinheiro.
    if (path === '/create-pix-devolucao') {
      const { tenantId, rotaId, envioId } = req.body || {};
      if (!tenantId || !rotaId || !envioId) {
        return res.status(400).json({ error: 'Missing required fields', required: ['tenantId', 'rotaId', 'envioId'] });
      }

      const rotaSnap = await db.ref(`usuarios/${tenantId}/rotas/${rotaId}`).once('value');
      const rota = rotaSnap.val();
      if (!rota) {
        return res.status(404).json({ error: 'Rota não encontrada' });
      }
      const entregadorId = String(rota.entregadorId || rota.aceitoPor || '');
      const isEntregadorDaRota = Boolean(entregadorId) && requester.uid === entregadorId;
      const allowed = isEntregadorDaRota || await canAccessTenant(requester, tenantId);
      if (!allowed) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const { dados: pacote, path: pacotePath } = await resolverEnvioLojista(tenantId, envioId);
      if (!pacote || pacote.devolucaoStatus !== 'DEVOLUCAO_CONFIRMADA') {
        return res.status(422).json({ error: 'Envio sem devolução confirmada pelo lojista' });
      }

      const valorFreteVolta = Number(pacote.valorFrete);
      if (!Number.isFinite(valorFreteVolta) || valorFreteVolta <= 0) {
        return res.status(422).json({ error: 'Frete do envio inválido para cobrança de devolução' });
      }

      const usuarioSnap = await db.ref(`usuarios/${tenantId}`).once('value');
      const usuario = usuarioSnap.val() || {};
      const nomeLojista = String(usuario?.nome || 'Lojista Flex').trim() || 'Lojista Flex';
      const [firstNameLojista, ...restoNomeLojista] = nomeLojista.split(' ');
      const lastNameLojista = restoNomeLojista.join(' ') || 'Flex';
      const payerEmailLojista = String(usuario?.email || requester.email || 'pagador@flex.app');

      const mpData = await criarPagamentoPixMp(token, {
        valor: valorFreteVolta,
        descricao: `Flex - frete de devolução (pedido ${envioId})`,
        payerEmail: payerEmailLojista,
        payerFirstName: firstNameLojista || 'Lojista',
        payerLastName: lastNameLojista,
        externalReference: `devolucao:${rotaId}:${envioId}`,
        idempotencyKey: `${tenantId}-${rotaId}-${envioId}-devolucao-${Date.now()}`
      });

      const tx = mpData?.point_of_interaction?.transaction_data || {};
      const pixCode = tx.qr_code || '';
      if (!pixCode) {
        return res.status(502).json({ error: 'Mercado Pago não retornou código Pix Copia e Cola' });
      }

      const paymentId = String(mpData?.id || '');
      await db.ref(`mp_payments/${paymentId}`).set({
        tenantId,
        rotaId,
        envioId,
        entregadorId,
        tipo: 'devolucao_frete',
        total: valorFreteVolta,
        ambiente,
        criadoEm: Date.now()
      });
      await db.ref(`${pacotePath}/devolucaoPixPaymentId`).set(paymentId);

      return res.status(200).json({
        paymentId,
        status: mpData?.status || 'pending',
        statusDetail: mpData?.status_detail || '',
        pixCode,
        ticketUrl: tx.ticket_url || '',
        qrCodeBase64: tx.qr_code_base64 || '',
        valor: valorFreteVolta,
        ambiente
      });
    }

    if (path === '/check-pix-devolucao') {
      const { tenantId, paymentId } = req.body || {};
      if (!tenantId || !paymentId) {
        return res.status(400).json({ error: 'Missing required fields', required: ['tenantId', 'paymentId'] });
      }

      const registroSnap = await db.ref(`mp_payments/${paymentId}`).once('value');
      const registro = registroSnap.val();
      if (!registro || String(registro.tenantId) !== String(tenantId) || registro.tipo !== 'devolucao_frete') {
        return res.status(404).json({ error: 'Pagamento não encontrado para este tenant' });
      }

      const isEntregadorDoPagamento = Boolean(registro.entregadorId) && requester.uid === registro.entregadorId;
      const allowed = isEntregadorDoPagamento || await canAccessTenant(requester, tenantId);
      if (!allowed) {
        return res.status(403).json({ error: 'Forbidden tenant access' });
      }

      const data = await consultarPagamentoPixMp(token, paymentId);
      const statusPagamento = data?.status || 'pending';

      if (statusPagamento === 'approved') {
        // credita o entregador pelo frete extra da volta — leitura+gravacao (nao
        // .transaction(), mesmo motivo documentado em ajustarSaldoUsuario no
        // frontend) protegida por um marcador pra nao creditar duas vezes.
        // O Pix pago libera o CODIGO de confirmacao pro lojista dar ao entregador
        // na hora que ele voltar na loja com o pacote; devolucaoStatus so vira
        // DEVOLVIDO quando esse codigo e confirmado (feito no frontend, em
        // confirmarCodigoDevolucaoPacoteAtual) — nao aqui. Isso evita liberar a
        // confirmacao antes do frete de volta ter sido de fato pago. Ver
        // project-flexa-cobranca-entrega-dinheiro (pedido do dono 2026-08-15).
        const { path: envioPath } = await resolverEnvioLojista(tenantId, registro.envioId);
        if (envioPath) {
          const marcadorRef = db.ref(`${envioPath}/devolucaoCreditoEfetuadoEm`);
          const marcadorSnap = await marcadorRef.once('value');
          if (!marcadorSnap.val()) {
            const saldoRef = db.ref(`usuarios/${registro.entregadorId}/financeiro/saldo`);
            const saldoSnap = await saldoRef.once('value');
            const saldoAntes = Number(saldoSnap.val() || 0);
            const saldoDepois = Number((saldoAntes + registro.total).toFixed(2));
            await saldoRef.set(saldoDepois);
            await marcadorRef.set(Date.now());
            const codigoDevolucao = String(Math.floor(1000 + Math.random() * 9000));
            await db.ref(envioPath).update({
              devolucaoStatus: 'DEVOLUCAO_PIX_PAGO',
              codigoConfirmacaoDevolucao: codigoDevolucao,
              devolucaoFretePagoEm: Date.now()
            });
          }
        }
      }

      return res.status(200).json({
        paymentId,
        status: statusPagamento,
        statusDetail: data?.status_detail || '',
        ambiente
      });
    }

    // Quitação da dívida em dinheiro do entregador (ver financeiro/divida no
    // frontend, ajustarDividaUsuario) — o entregador paga a própria dívida via
    // Pix pra sair do bloqueio de 5 dias (entregadorBloqueadoPorDividaAtrasada).
    // Sem isso não existia NENHUM jeito de sair do bloqueio, já que ele impede
    // aceitar rota nova — inclusive as que poderiam gerar frete suficiente pra
    // liquidar automaticamente. Pedido do dono, 2026-09-18.
    if (path === '/create-pix-quitacao-divida') {
      const uidEntregador = requester.uid;

      // valor sempre recalculado a partir da dívida persistida, nunca do que o app mandar
      const dividaSnap = await db.ref(`usuarios/${uidEntregador}/financeiro/divida`).once('value');
      const divida = Number(dividaSnap.val() || 0);
      if (!Number.isFinite(divida) || divida <= 0) {
        return res.status(422).json({ error: 'Nenhuma dívida pendente para quitar' });
      }

      const usuarioSnap = await db.ref(`usuarios/${uidEntregador}`).once('value');
      const usuario = usuarioSnap.val() || {};
      const nomeCompleto = String(usuario?.nome || 'Entregador Flex').trim() || 'Entregador Flex';
      const [firstName, ...restoNome] = nomeCompleto.split(' ');
      const lastName = restoNome.join(' ') || 'Flex';
      const payerEmail = String(usuario?.email || requester.email || 'pagador@flex.app');

      const mpData = await criarPagamentoPixMp(token, {
        valor: divida,
        descricao: 'Flex - quitação de dívida em dinheiro',
        payerEmail,
        payerFirstName: firstName || 'Entregador',
        payerLastName: lastName,
        externalReference: `quitacao:${uidEntregador}`,
        idempotencyKey: `${uidEntregador}-quitacao-${Date.now()}`
      });

      const tx = mpData?.point_of_interaction?.transaction_data || {};
      const pixCode = tx.qr_code || '';
      if (!pixCode) {
        return res.status(502).json({ error: 'Mercado Pago não retornou código Pix Copia e Cola' });
      }

      const paymentId = String(mpData?.id || '');
      await db.ref(`mp_payments/${paymentId}`).set({
        entregadorId: uidEntregador,
        tipo: 'quitacao_divida',
        total: divida,
        ambiente,
        criadoEm: Date.now()
      });

      return res.status(200).json({
        paymentId,
        status: mpData?.status || 'pending',
        statusDetail: mpData?.status_detail || '',
        pixCode,
        ticketUrl: tx.ticket_url || '',
        qrCodeBase64: tx.qr_code_base64 || '',
        valor: divida,
        ambiente
      });
    }

    if (path === '/check-pix-quitacao-divida') {
      const { paymentId } = req.body || {};
      if (!paymentId) {
        return res.status(400).json({ error: 'Missing required fields', required: ['paymentId'] });
      }

      const registroSnap = await db.ref(`mp_payments/${paymentId}`).once('value');
      const registro = registroSnap.val();
      if (!registro || registro.tipo !== 'quitacao_divida' || registro.entregadorId !== requester.uid) {
        return res.status(404).json({ error: 'Pagamento não encontrado' });
      }

      const data = await consultarPagamentoPixMp(token, paymentId);
      const statusPagamento = data?.status || 'pending';

      if (statusPagamento === 'approved') {
        // leitura+gravacao (nao .transaction(), mesmo motivo de sempre) protegida
        // por marcador pra nao abater a divida duas vezes.
        const marcadorRef = db.ref(`mp_payments/${paymentId}/creditoEfetuadoEm`);
        const marcadorSnap = await marcadorRef.once('value');
        if (!marcadorSnap.val()) {
          const dividaRef = db.ref(`usuarios/${registro.entregadorId}/financeiro/divida`);
          const dividaSnap = await dividaRef.once('value');
          const dividaAtual = Number(dividaSnap.val() || 0);
          const dividaNova = Math.max(0, Number((dividaAtual - registro.total).toFixed(2)));
          await dividaRef.set(dividaNova);
          if (dividaNova <= 0) {
            await db.ref(`usuarios/${registro.entregadorId}/financeiro/dividaDesde`).remove();
          }
          await marcadorRef.set(Date.now());
          await db.ref(`usuarios/${registro.entregadorId}/financeiro/transacoes`).push({
            protocolo: gerarProtocoloTransacaoServer(),
            tipo: 'DEBITO_DIVIDA',
            metodo: 'pix',
            valor: registro.total,
            descricao: 'Dívida quitada via Pix',
            remetente: 'Você (Pix)',
            destinatario: 'Flex (quitação de dívida)',
            paymentIdMp: String(paymentId),
            criadoEm: Date.now()
          });
        }
      }

      return res.status(200).json({
        paymentId,
        status: statusPagamento,
        statusDetail: data?.status_detail || '',
        ambiente
      });
    }

    // Taxa de espera/entrega na porta (pedido do dono, 2026-10-04; revisto
    // 2026-10-08): o entregador nunca negocia dinheiro pra essas duas
    // sozinho — só existem via Pix (gerado pela tela do cliente, sozinhas
    // ou junto da cobrança do pedido, ver /criar-pagamento-pendencias-cliente),
    // ficam RETIDAS até aprovar e só viram saldo gastável do entregador aqui,
    // no momento em que confirmarEntregaPacoteAtual já validou o código de
    // confirmação (prova que a entrega aconteceu de verdade). A ÚNICA
    // exceção é dinheiro vindo junto de uma cobrança-na-entrega que já aceita
    // espécie — nesse caso o pagamento combinado (ver
    // criarPagamentoPendenciasCliente) já marca as duas como pagas na hora,
    // sem passar por aqui. Se nunca foi paga (nem Pix nem dinheiro), o
    // entregador simplesmente não recebe por ela — sem dívida, sem pergunta.
    if (path === '/resolver-taxa-espera') {
      const { tenantId, rotaId, envioId } = req.body || {};
      if (!tenantId || !rotaId || !envioId) {
        return res.status(400).json({ error: 'Missing required fields', required: ['tenantId', 'rotaId', 'envioId'] });
      }

      const rotaSnap = await db.ref(`usuarios/${tenantId}/rotas/${rotaId}`).once('value');
      const rota = rotaSnap.val();
      if (!rota) {
        return res.status(404).json({ error: 'Rota não encontrada' });
      }
      const entregadorId = String(rota.entregadorId || rota.aceitoPor || '');
      if (!entregadorId || requester.uid !== entregadorId) {
        return res.status(403).json({ error: 'Só o entregador desta rota pode resolver a taxa' });
      }

      const { dados: pacote } = await resolverEnvioLojista(tenantId, envioId);
      if (!pacote) {
        return res.status(404).json({ error: 'Envio não encontrado' });
      }

      await liberarCreditoSubidaSeElegivel(tenantId, envioId, entregadorId, pacote);
      await liberarCreditoEsperaSeElegivel(tenantId, envioId, entregadorId, pacote);

      const espera = pacote.esperaEntrega || {};
      if (!espera.finalizada) {
        await syncEnvioFields(tenantId, envioId, { 'esperaEntrega/finalizada': true });
      }

      return res.status(200).json({ ok: true });
    }

    // Confirmação de recebimento da taxa de espera/subida (plano de
    // segurança 2026-09-27): antes o entregador confirmava direto no banco,
    // lendo só a PRÓPRIA cópia (taxasAReceber) — bastava fabricar um registro
    // com o mesmo id de uma dívida real de outro lojista pra "confirmar"
    // (limpar) uma dívida que nunca foi paga. Agora confere pela cópia
    // CANÔNICA (do lado do lojista) que quem chama é de fato o entregador
    // daquela dívida específica.
    if (path === '/confirmar-taxa-espera-recebida') {
      const { tenantId, dividaId } = req.body || {};
      if (!tenantId || !dividaId) {
        return res.status(400).json({ error: 'Missing required fields', required: ['tenantId', 'dividaId'] });
      }

      const dividaSnap = await db.ref(`usuarios/${tenantId}/dividasEntregador/${dividaId}`).once('value');
      const registro = dividaSnap.val();
      if (!registro) {
        return res.status(404).json({ error: 'Dívida não encontrada' });
      }
      if (String(registro.entregadorUid || '') !== requester.uid) {
        return res.status(403).json({ error: 'Só o entregador desta dívida pode confirmar o recebimento' });
      }
      if (registro.status === 'confirmado') {
        return res.status(200).json({ jaResolvido: true });
      }

      const agora = Date.now();
      const updates = {};
      updates[`usuarios/${tenantId}/dividasEntregador/${dividaId}/status`] = 'confirmado';
      updates[`usuarios/${tenantId}/dividasEntregador/${dividaId}/confirmadoEm`] = agora;
      updates[`usuarios/${requester.uid}/taxasAReceber/${dividaId}/status`] = 'confirmado';
      updates[`usuarios/${requester.uid}/taxasAReceber/${dividaId}/confirmadoEm`] = agora;
      await db.ref().update(updates);

      return res.status(200).json({ confirmado: true });
    }

    // Cobrança na entrega paga EM DINHEIRO (plano de segurança 2026-09-27):
    // antes o entregador reportava o valor recebido direto do navegador —
    // um cliente adulterado podia mandar qualquer valor pra marcar o pacote
    // de qualquer lojista como "pago". Agora o teto vem sempre do que está
    // persistido no servidor (calcularPendenciasCliente), nunca do que o
    // app manda.
    if (path === '/confirmar-cobranca-dinheiro') {
      const { tenantId, rotaId, envioId } = req.body || {};
      if (!tenantId || !rotaId || !envioId) {
        return res.status(400).json({ error: 'Missing required fields', required: ['tenantId', 'rotaId', 'envioId'] });
      }

      const rotaSnap = await db.ref(`usuarios/${tenantId}/rotas/${rotaId}`).once('value');
      const rota = rotaSnap.val();
      if (!rota) {
        return res.status(404).json({ error: 'Rota não encontrada' });
      }
      const entregadorId = String(rota.entregadorId || rota.aceitoPor || '');
      if (!entregadorId || requester.uid !== entregadorId) {
        return res.status(403).json({ error: 'Só o entregador desta rota pode confirmar a cobrança' });
      }

      // Pedido do dono (2026-10-08): o entregador confirma o recebimento em
      // dinheiro de TUDO que estiver pendente nesta entrega (taxa de espera
      // + entrega na porta, se houver, mais a cobrança do pedido) — não só
      // da cobrança sozinha — porque o cliente já pode ter entregado um
      // valor combinado único (ver /criar-pagamento-pendencias-cliente, que
      // só REGISTRA a intenção de pagar em dinheiro, nunca finaliza sozinho:
      // só o entregador, recebendo de verdade e confirmando aqui, é que
      // libera o valor — senão o cliente sozinho criaria uma dívida real
      // pro entregador sem nunca ter entregado nada).
      const pend = await calcularPendenciasCliente(tenantId, envioId);
      if (!pend || pend.valorTotal <= 0) {
        return res.status(422).json({ error: 'Nenhuma pendência para confirmar neste envio' });
      }

      const updates = {};
      if (pend.valorEspera > 0) {
        updates['esperaEntrega/esperaStatus'] = 'pago';
        updates['esperaEntrega/valorEsperaPago'] = pend.valorEspera;
        updates['esperaEntrega/esperaPagoEm'] = Date.now();
      }
      if (pend.valorSubida > 0) {
        updates['esperaEntrega/subirStatus'] = 'pago';
        updates['esperaEntrega/subidaPagoEm'] = Date.now();
      }
      if (pend.cobrancaPendente) {
        await ajustarDividaUsuarioServer(entregadorId, pend.valorCobranca);
        updates['cobrancaEntrega/status'] = 'pago';
        updates['cobrancaEntrega/valorDinheiro'] = pend.valorCobranca;
        updates['cobrancaEntrega/valorPix'] = 0;
        updates['cobrancaEntrega/pagoEm'] = Date.now();
      }
      await syncEnvioFields(tenantId, envioId, updates);

      // Espelha o desfecho pra tela do cliente — o entregador pode ter
      // resolvido direto com ele (cliente nunca abriu o link, ou abriu mas
      // não escolheu nada), mas a tela de rastreio, se o cliente olhar
      // depois, precisa saber que já foi pago.
      const mirror = {};
      if (pend.valorEspera > 0) mirror.esperaStatus = 'pago';
      if (pend.valorSubida > 0) mirror.subirStatus = 'pago';
      if (pend.cobrancaPendente) mirror.cobrancaStatus = 'pago';
      if (Object.keys(mirror).length) {
        await db.ref(`rastreioPublico/${rotaId}/pacotes/${envioId}`).update(mirror).catch(() => {});
      }

      return res.status(200).json({ valor: pend.valorTotal });
    }

    // Crédito da rota finalizada pro entregador (plano de segurança
    // 2026-09-27): antes o valor vinha calculado no navegador do PRÓPRIO
    // entregador a partir do espelho local dele (rotaObj/pacotes) — bastava
    // chamar creditarCarteiraEntregadorRotaFinalizada direto do console com
    // um valor inflado pra se creditar o quanto quisesse. Agora o servidor
    // recalcula tudo a partir da rota+pacotes CANÔNICOS do lado do lojista
    // (resolverEnvioLojista, dual-model-aware) e decide sozinho se houve
    // entrega de verdade — nunca confia em nenhum valor vindo do cliente.
    if (path === '/creditar-rota-finalizada') {
      const { tenantId, rotaId } = req.body || {};
      if (!tenantId || !rotaId) {
        return res.status(400).json({ error: 'Missing required fields', required: ['tenantId', 'rotaId'] });
      }

      const rotaSnap = await db.ref(`usuarios/${tenantId}/rotas/${rotaId}`).once('value');
      const rota = rotaSnap.val();
      if (!rota) {
        return res.status(404).json({ error: 'Rota não encontrada' });
      }
      const entregadorId = String(rota.entregadorId || rota.aceitoPor || '');
      if (!entregadorId || requester.uid !== entregadorId) {
        return res.status(403).json({ error: 'Só o entregador desta rota pode creditar' });
      }

      // Mesma trava de crédito duplicado da versão antiga (lê-e-grava em vez
      // de .transaction(), mesmo motivo documentado em ajustarDividaUsuarioServer).
      const markerRef = db.ref(`usuarios/${entregadorId}/rotas/${rotaId}/creditoEntregadorEfetuadoEm`);
      const markerSnap = await markerRef.once('value');
      if (markerSnap.val()) {
        const saldoSnap = await db.ref(`usuarios/${entregadorId}/financeiro/saldo`).once('value');
        return res.status(200).json({ creditado: false, jaCreditado: true, saldoAtualizado: Number(saldoSnap.val() || 0) });
      }

      const pacoteIds = Array.isArray(rota.pacoteIds) ? rota.pacoteIds : (Array.isArray(rota.pacotes) ? rota.pacotes : []);
      const pacotes = [];
      for (const envioId of pacoteIds) {
        const { dados } = await resolverEnvioLojista(tenantId, String(envioId));
        if (dados) pacotes.push(dados);
      }

      const desfechoPacote = (p) => {
        const status = String(p?.statusRaw || p?.status || '').toUpperCase();
        if (status === 'ENTREGUE') return 'entregue';
        if (p?.devolucaoStatus === 'DEVOLVIDO') return 'devolvido';
        if (status === 'CANCELADO') return 'cancelado';
        return 'pendente';
      };
      const teveEntrega = pacotes.some((p) => desfechoPacote(p) === 'entregue');

      const semCredito = async (valorCreditado = 0) => {
        const saldoSnap = await db.ref(`usuarios/${entregadorId}/financeiro/saldo`).once('value');
        return res.status(200).json({ creditado: false, saldoAtualizado: Number(saldoSnap.val() || 0), valorCreditado });
      };

      if (!teveEntrega) {
        return semCredito(0);
      }

      let valorBruto = 0;
      for (const v of [rota.totalFrete, rota.valorTotal, rota.valor, rota.preco]) {
        const num = Number(v);
        if (Number.isFinite(num) && num > 0) { valorBruto = Number(num.toFixed(2)); break; }
      }
      if (valorBruto <= 0) {
        valorBruto = Number(pacotes.reduce((acc, p) => acc + (Number(p?.valorFrete) || 0), 0).toFixed(2));
      }
      if (valorBruto <= 0) {
        return semCredito(0);
      }

      const distanciaKm = Number(rota.distanciaTotal) || pacotes.reduce((acc, p) => acc + (Number(p?.distanciaKm) || 0), 0);
      const valorCredito = calcularValorRepasseEntregador(valorBruto, distanciaKm);
      if (valorCredito <= 0) {
        return semCredito(0);
      }

      await markerRef.set(Date.now());

      // Liquidação automática: mesma regra da versão antiga (abate dívida em
      // dinheiro do entregador primeiro, só o que sobra vira saldo livre).
      const dividaSnap = await db.ref(`usuarios/${entregadorId}/financeiro/divida`).once('value');
      const dividaAntes = Number(dividaSnap.val() || 0);
      const abatimentoDivida = Number(Math.min(valorCredito, Math.max(0, dividaAntes)).toFixed(2));
      const saldoLiberado = Number((valorCredito - abatimentoDivida).toFixed(2));
      if (abatimentoDivida > 0) {
        await ajustarDividaUsuarioServer(entregadorId, -abatimentoDivida);
      }
      let saldoAtualizado;
      if (saldoLiberado > 0) {
        const resultadoSaldo = await ajustarSaldoUsuarioServer(entregadorId, saldoLiberado);
        saldoAtualizado = resultadoSaldo.saldoDepois;
      } else {
        const saldoSnap = await db.ref(`usuarios/${entregadorId}/financeiro/saldo`).once('value');
        saldoAtualizado = Number(saldoSnap.val() || 0);
      }

      const agora = Date.now();
      const updates = {};
      updates[`usuarios/${entregadorId}/financeiro/atualizadoEm`] = agora;
      updates[`usuarios/${entregadorId}/rotas/${rotaId}/creditoEntregadorValor`] = valorCredito;
      updates[`usuarios/${entregadorId}/rotas/${rotaId}/creditoEntregadorAbatimentoDivida`] = abatimentoDivida;
      updates[`usuarios/${entregadorId}/rotas/${rotaId}/creditoEntregadorEfetuadoEm`] = agora;
      updates[`usuarios/${entregadorId}/rotas/${rotaId}/atualizadoEm`] = agora;
      updates[`usuarios/${tenantId}/rotas/${rotaId}/creditoEntregadorValor`] = valorCredito;
      updates[`usuarios/${tenantId}/rotas/${rotaId}/creditoEntregadorEfetuadoEm`] = agora;
      updates[`usuarios/${tenantId}/rotas/${rotaId}/atualizadoEm`] = agora;
      await db.ref().update(updates);

      const txRef = db.ref(`usuarios/${entregadorId}/financeiro/transacoes`).push();
      await txRef.set({
        id: txRef.key,
        protocolo: gerarProtocoloTransacaoServer(),
        tipo: 'CREDITO',
        metodo: 'interno',
        valor: valorCredito,
        descricao: `Rota ${rotaId} finalizada`,
        criadoEm: agora
      });

      return res.status(200).json({ creditado: true, saldoAtualizado, valorCreditado: valorCredito });
    }

    // Painel master: alterar status de rota de qualquer lojista (plano de
    // segurança 2026-09-27 — ver requesterEhMasterOuAdmin acima). Mesma
    // lógica de atualizarStatusRotaMaster no frontend: grava nas DUAS cópias
    // (lojista+entregador), e volta a ficar "BUSCANDO" limpa o vínculo com o
    // entregador que tinha aceito antes.
    if (path === '/admin-atualizar-status-rota') {
      const statusValidos = ['BUSCANDO', 'EM_ROTA', 'CONCLUIDO', 'CANCELADO'];
      const { lojistaUid, rotaId, status } = req.body || {};
      if (!lojistaUid || !rotaId || !statusValidos.includes(status)) {
        return res.status(400).json({ error: 'Missing/invalid fields', required: ['lojistaUid', 'rotaId', 'status'], statusValidos });
      }

      const ehMaster = await requesterEhMasterOuAdmin(requester);
      if (!ehMaster) {
        return res.status(403).json({ error: 'Só um master pode alterar rotas de outros usuários' });
      }

      const snapAtual = await db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}`).once('value');
      const rotaAtual = snapAtual.val();
      if (!rotaAtual) {
        return res.status(404).json({ error: 'Rota não encontrada' });
      }
      const entregadorId = rotaAtual?.entregadorId || rotaAtual?.aceitoPor || null;
      const agora = Date.now();

      const updates = {};
      updates[`usuarios/${lojistaUid}/rotas/${rotaId}/status`] = status;
      updates[`usuarios/${lojistaUid}/rotas/${rotaId}/pagamentoStatus`] = status;
      updates[`usuarios/${lojistaUid}/rotas/${rotaId}/atualizadoEm`] = agora;

      if (status === 'BUSCANDO') {
        updates[`usuarios/${lojistaUid}/rotas/${rotaId}/entregadorId`] = null;
        updates[`usuarios/${lojistaUid}/rotas/${rotaId}/aceitoPor`] = null;
        updates[`usuarios/${lojistaUid}/rotas/${rotaId}/aceitoEm`] = null;
        if (entregadorId) updates[`usuarios/${entregadorId}/rotas/${rotaId}`] = null;
      } else if (entregadorId) {
        updates[`usuarios/${entregadorId}/rotas/${rotaId}/status`] = status;
        updates[`usuarios/${entregadorId}/rotas/${rotaId}/pagamentoStatus`] = status;
        updates[`usuarios/${entregadorId}/rotas/${rotaId}/atualizadoEm`] = agora;
      }

      await db.ref().update(updates);
      return res.status(200).json({ atualizado: true, status });
    }

    // Painel master: excluir rota de qualquer lojista (plano de segurança
    // 2026-09-27). Mesma lógica de adminExcluirRota no frontend: apaga a
    // cópia do lojista e, se tinha entregador vinculado, a cópia dele também.
    if (path === '/admin-excluir-rota') {
      const { lojistaUid, rotaId } = req.body || {};
      if (!lojistaUid || !rotaId) {
        return res.status(400).json({ error: 'Missing required fields', required: ['lojistaUid', 'rotaId'] });
      }

      const ehMaster = await requesterEhMasterOuAdmin(requester);
      if (!ehMaster) {
        return res.status(403).json({ error: 'Só um master pode excluir rotas de outros usuários' });
      }

      const snapAtual = await db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}`).once('value');
      const rotaAtual = snapAtual.val();
      if (!rotaAtual) {
        return res.status(404).json({ error: 'Rota não encontrada' });
      }
      const entregadorId = rotaAtual?.entregadorId || rotaAtual?.aceitoPor || null;

      const updates = { [`usuarios/${lojistaUid}/rotas/${rotaId}`]: null };
      if (entregadorId) updates[`usuarios/${entregadorId}/rotas/${rotaId}`] = null;
      await db.ref().update(updates);

      return res.status(200).json({ excluido: true });
    }

    // Limpeza oportunista das rotas atrasadas (pedido do dono 2026-10-09):
    // chamada pelo app sempre que um entregador abre/atualiza o marketplace
    // (ver carregarMarketplaceRotasEntregador) e pela própria tela de
    // confirmar coleta (ver renderSheetColetaPacotes), pra devolver
    // 'BUSCANDO' as rotas cujo prazo de 20 min estourou ANTES de montar a
    // lista/decidir se fecha a tela — qualquer autenticado pode chamar
    // (é uma limpeza idempotente, sem nenhum dado sensível envolvido).
    if (path === '/liberar-rotas-atrasadas') {
      const liberadas = await liberarRotasAtrasadasServer();
      return res.status(200).json({ liberadas });
    }

    // Aceitar rota no marketplace (plano de segurança 2026-09-27, item 6/6):
    // a regra do banco pra "rotas" é auth != null (não valida vínculo real
    // com a rota) — um entregador mal-intencionado podia pular as checagens
    // de bloqueio por dívida/capacidade de cobrança chamando um update()
    // direto no console, ou até "roubar" uma rota já aceita por outro
    // entregador sobrescrevendo entregadorId fora da transação condicional
    // que o app usa. Agora a aceitação inteira (checagens + transação
    // condicional + espelhos nos dois modelos) roda no servidor.
    if (path === '/aceitar-rota-marketplace') {
      const { lojistaUid, rotaId } = req.body || {};
      if (!lojistaUid || !rotaId) {
        return res.status(400).json({ error: 'Missing required fields', required: ['lojistaUid', 'rotaId'] });
      }

      const uidEntregador = requester.uid;
      const tipoSnap = await db.ref(`usuarios/${uidEntregador}/tipo`).once('value');
      const tipoRaw = String(tipoSnap.val() || '').toLowerCase();
      if (tipoRaw !== 'entrega' && tipoRaw !== 'entregador') {
        return res.status(403).json({ error: 'Somente entregador pode aceitar rota' });
      }

      // Documentos de verificação (2026-10-08, pedido do dono: limitar
      // quantidade de entregadores ativos a quem já teve endereço/CNH/
      // documento do veículo aprovados pelo master — ver Perfil >
      // Documentos no app e a aba Documentos no painel master). Checado
      // aqui (não só escondido na tela) porque é o ÚNICO jeito de garantir
      // de verdade — a tela pode ser contornada, o servidor não.
      const docsSnap = await db.ref(`usuarios/${uidEntregador}/documentos`).once('value');
      const docs = docsSnap.val() || {};
      const tiposDocsObrigatorios = ['comprovanteEndereco', 'cnh', 'docVeiculo'];
      const documentosAprovados = tiposDocsObrigatorios.every((t) => docs[t]?.status === 'aprovado');
      if (!documentosAprovados) {
        return res.status(403).json({
          error: 'Seus documentos ainda não foram aprovados — envie e aguarde a aprovação em Perfil > Documentos',
          motivo: 'documentos_pendentes'
        });
      }

      const flashCheck = await entregadorTemFlashPendente(uidEntregador);
      if (flashCheck.bloqueado) {
        return res.status(403).json({
          error: 'Você tem uma entrega Flash pendente — finalize-a antes de aceitar outra rota',
          motivo: 'flash_pendente',
          rotaId: flashCheck.rotaId,
          prazoFlashAte: flashCheck.prazoFlashAte
        });
      }

      // Bloqueio de 5 dias por dívida atrasada (mesma regra de
      // entregadorBloqueadoPorDividaAtrasada no frontend).
      const [dividaSnap, desdeSnap] = await Promise.all([
        db.ref(`usuarios/${uidEntregador}/financeiro/divida`).once('value'),
        db.ref(`usuarios/${uidEntregador}/financeiro/dividaDesde`).once('value')
      ]);
      const divida = Number(dividaSnap.val() || 0);
      const desde = Number(desdeSnap.val() || 0);
      const CINCO_DIAS_MS = 5 * 24 * 60 * 60 * 1000;
      if (divida > 0 && desde > 0 && (Date.now() - desde) > CINCO_DIAS_MS) {
        return res.status(403).json({ error: 'Conta bloqueada por dívida em aberto há mais de 5 dias', motivo: 'bloqueado_divida' });
      }

      const rotaSnapPre = await db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}`).once('value');
      const rotaPre = rotaSnapPre.val();
      if (!rotaPre) {
        return res.status(404).json({ error: 'Rota não encontrada' });
      }
      const pacoteIdsPre = Array.isArray(rotaPre.pacoteIds) ? rotaPre.pacoteIds : (Array.isArray(rotaPre.pacotes) ? rotaPre.pacotes : []);

      // Valor de cobrança em dinheiro dessa rota (mesma regra de
      // calcularValorCobrancaDinheiroRota) — decide se precisa checar capacidade.
      let valorCobrancaDinheiro = 0;
      if (pacoteIdsPre.length) {
        const pacotesSnap = await db.ref(`usuarios/${lojistaUid}/pacotes`).once('value');
        const pacotesNo = pacotesSnap.val() || {};
        pacoteIdsPre.forEach((id) => {
          const cobranca = pacotesNo[id]?.cobrancaEntrega;
          if (!cobranca?.ativa || !Array.isArray(cobranca.formasAceitas) || !cobranca.formasAceitas.includes('dinheiro')) return;
          const v = Number(cobranca.valor);
          if (Number.isFinite(v) && v > 0) valorCobrancaDinheiro += v;
        });
        valorCobrancaDinheiro = Number(valorCobrancaDinheiro.toFixed(2));
      }

      if (valorCobrancaDinheiro > 0) {
        const [saldoSnap, dividaSnap2, rotasSnap] = await Promise.all([
          db.ref(`usuarios/${uidEntregador}/financeiro/saldo`).once('value'),
          db.ref(`usuarios/${uidEntregador}/financeiro/divida`).once('value'),
          db.ref(`usuarios/${uidEntregador}/rotas`).once('value')
        ]);
        const saldo = Number(saldoSnap.val() || 0);
        const dividaAtual = Number(dividaSnap2.val() || 0);
        const rotasNo = rotasSnap.val() || {};
        let aReceberPendente = 0;
        Object.values(rotasNo).forEach((r) => {
          if (normalizarStatusRotaServer(r?.status || r?.pagamentoStatus || 'CRIADA') !== 'EM_ROTA') return;
          const frete = Number(r?.totalFrete ?? r?.valorTotal ?? 0);
          if (Number.isFinite(frete) && frete > 0) aReceberPendente += frete;
        });
        const capacidade = Number((saldo + aReceberPendente - dividaAtual).toFixed(2));
        if (capacidade < valorCobrancaDinheiro) {
          // Pedido do dono (2026-10-09): mensagens de sistema devem mostrar
          // os valores reais (saldo/capacidade), não só "está baixo" — manda
          // os números pro frontend montar a mensagem certa.
          return res.status(403).json({
            error: 'Capacidade de cobrança insuficiente',
            motivo: 'capacidade_insuficiente',
            capacidade,
            valorNecessario: valorCobrancaDinheiro
          });
        }
      }

      const [nomeSnap, fotoSnap, lojistaNomeSnap, lojistaLojaSnap, lojistaFotoSnap, lojistaLogoSnap] = await Promise.all([
        db.ref(`usuarios/${uidEntregador}/nome`).once('value'),
        db.ref(`usuarios/${uidEntregador}/foto`).once('value'),
        db.ref(`usuarios/${lojistaUid}/nome`).once('value'),
        db.ref(`usuarios/${lojistaUid}/loja`).once('value'),
        db.ref(`usuarios/${lojistaUid}/foto`).once('value'),
        db.ref(`usuarios/${lojistaUid}/logo`).once('value')
      ]);
      const entregadorNome = String(nomeSnap.val() || 'Entregador');
      const entregadorFoto = String(fotoSnap.val() || '');
      // BUG CORRIGIDO 2026-09-29: mesma causa-raiz do fix de origem/destino
      // acima — lojistaNome/lojistaFoto nunca eram gravados de verdade na
      // rota, então o espelho do entregador sempre caía no fallback
      // genérico "Lojista" (card "Em rota"/histórico mostrava só isso em
      // vez do nome real da loja).
      const lojistaNomeReal = String(lojistaLojaSnap.val() || lojistaNomeSnap.val() || 'Lojista');
      const lojistaFotoReal = String(lojistaLogoSnap.val() || lojistaFotoSnap.val() || '');
      const agora = Date.now();
      const codigoConfirmacaoColeta = gerarCodigoConfirmacaoEntregaServer();

      const metaEntregador = {
        entregadorId: uidEntregador,
        entregadorNome,
        entregadorFoto,
        aceitoPor: uidEntregador,
        aceitoEm: agora,
        status: 'EM_ROTA',
        atualizadoEm: agora,
        coletaConfirmada: false,
        codigoConfirmacaoColeta
      };

      // Capturado de DENTRO da transação (closure) — fica com o uid do
      // entregador que estava na rota ANTES dela ser tomada por aceite
      // atrasado (ver abaixo). A própria API de transaction() não expõe o
      // valor "antes" separado do commit, então guardar aqui é o jeito de
      // saber de quem limpar o espelho depois.
      let entregadorSubstituidoId = '';
      const rotaRef = db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}`);
      const tx = await rotaRef.transaction((atual) => {
        if (!atual) return atual;
        const statusAtual = normalizarStatusRotaServer(atual?.status || atual?.pagamentoStatus || 'CRIADA');
        const jaTemEntregador = Boolean(atual?.entregadorId || atual?.aceitoPor);
        if (statusAtual === 'BUSCANDO' && !jaTemEntregador) {
          entregadorSubstituidoId = '';
          return { ...atual, ...metaEntregador };
        }
        // Pedido do dono (2026-10-09): entregador tem 20 min pra confirmar a
        // coleta na loja depois de aceitar — se passar desse prazo sem
        // confirmar, a rota volta a valer "disponível" na prática, mesmo que
        // nenhuma limpeza em segundo plano tenha rodado ainda (ver
        // liberarRotasAtrasadasServer, chamada de forma oportunista sempre
        // que um entregador abre o marketplace). Checar isso AQUI, dentro da
        // própria transação de aceite, garante que o primeiro a tentar
        // aceitar depois do prazo leva, sem depender de mais nada já ter
        // rodado antes — sem essa checagem, um entregador atrasado podia
        // travar a rota pra sempre só não aparecendo na loja.
        if (statusAtual === 'EM_ROTA' && jaTemEntregador && atual?.coletaConfirmada !== true) {
          const aceitoEmAnterior = Number(atual?.aceitoEm || 0);
          if (aceitoEmAnterior && (agora - aceitoEmAnterior) >= PRAZO_COLETA_MS) {
            entregadorSubstituidoId = String(atual?.entregadorId || atual?.aceitoPor || '');
            return { ...atual, ...metaEntregador };
          }
        }
        return;
      });

      if (!tx.committed || !tx.snapshot.exists()) {
        return res.status(409).json({ error: 'Essa rota já foi aceita por outro entregador', motivo: 'ja_aceita' });
      }

      // Rota tomada de um entregador atrasado (ver acima) — limpa o espelho
      // dele e avisa, senão o app dele continuava mostrando essa rota como
      // sendo dele mesmo depois de ter sido aceita por outra pessoa.
      if (entregadorSubstituidoId && entregadorSubstituidoId !== uidEntregador) {
        await db.ref(`usuarios/${entregadorSubstituidoId}/rotas/${rotaId}`).remove().catch(() => {});
        await db.ref(`usuarios/${entregadorSubstituidoId}/notificacoes`).push({
          tipo: 'rota_liberada_atraso',
          titulo: 'Rota liberada por atraso',
          mensagem: `Você não confirmou a coleta da rota #${rotaId} em até 20 minutos — ela foi liberada e aceita por outro entregador.`,
          rotaId: String(rotaId),
          lida: false,
          criadoEm: agora
        }).catch(() => {});
      }

      const rotaAtualizada = tx.snapshot.val() || {};
      const pacoteIds = Array.isArray(rotaAtualizada?.pacoteIds) ? rotaAtualizada.pacoteIds : (Array.isArray(rotaAtualizada?.pacotes) ? rotaAtualizada.pacotes : []);

      if (pacoteIds.length) {
        const clientesSnap = await db.ref(`usuarios/${lojistaUid}/clientes`).once('value');
        const clientesNo = clientesSnap.val() || {};
        const idsSet = new Set(pacoteIds.map((id) => String(id)));
        const updatesHistorico = {};
        Object.keys(clientesNo).forEach((clienteId) => {
          const historico = Array.isArray(clientesNo[clienteId]?.historico) ? clientesNo[clienteId].historico : [];
          historico.forEach((h, idx) => {
            const idAtual = String(h?.id || `envio-${clienteId}-${idx}`);
            if (!idsSet.has(idAtual)) return;
            updatesHistorico[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/id`] = idAtual;
            updatesHistorico[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/status`] = 'EM_ROTA';
            updatesHistorico[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/rotaId`] = String(rotaId);
            updatesHistorico[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/atualizadoEm`] = agora;
          });
        });
        // BUG CORRIGIDO 2026-10-02: só atualizava o modelo antigo (historico) —
        // usuarios/{uid}/pacotes/{id}/status nunca virava EM_ROTA aqui, então
        // a tela de Pedidos (que faz merge historico+pacotes, com pacotes
        // tendo prioridade) continuava mostrando o status de ANTES de aceitar
        // a rota até a entrega ser confirmada (quando persistirEntregaPacoteAtual
        // finalmente sincronizava os dois modelos de novo).
        pacoteIds.forEach((pid) => {
          updatesHistorico[`usuarios/${lojistaUid}/pacotes/${pid}/status`] = 'EM_ROTA';
          updatesHistorico[`usuarios/${lojistaUid}/pacotes/${pid}/statusRaw`] = 'EM_ROTA';
          updatesHistorico[`usuarios/${lojistaUid}/pacotes/${pid}/rotaId`] = String(rotaId);
          updatesHistorico[`usuarios/${lojistaUid}/pacotes/${pid}/atualizadoEm`] = agora;
        });
        if (Object.keys(updatesHistorico).length) {
          await db.ref().update(updatesHistorico);
        }
      }

      await db.ref(`rastreioPublico/${rotaId}`).update({
        entregadorNome,
        statusRota: 'EM_ROTA',
        atualizadoEm: agora
      }).catch(() => {});

      const resumoCalculado = pacoteIds.length
        ? await calcularResumoRotaParaEntregador(lojistaUid, pacoteIds).catch(() => null)
        : null;

      const rotaNoEntregador = {
        id: String(rotaId),
        ...rotaAtualizada,
        origemLojistaUid: String(lojistaUid),
        lojistaId: String(lojistaUid),
        lojistaNome: String(rotaAtualizada?.lojistaNome || lojistaNomeReal),
        lojistaFoto: String(rotaAtualizada?.lojistaFoto || lojistaFotoReal),
        // montarCardHistoricoRotaEntregador (front) lê lojistaLogo, não
        // lojistaFoto — grava os dois pra não depender de qual nome de
        // campo cada tela escolheu ler.
        lojistaLogo: String(rotaAtualizada?.lojistaLogo || lojistaFotoReal),
        sincronizadaDoLojista: true,
        atualizadoEm: agora,
        origemLabel: rotaAtualizada?.origemLabel || resumoCalculado?.origemLabel || '',
        origemCidade: rotaAtualizada?.origemCidade || resumoCalculado?.origemCidade || '',
        origemBairro: rotaAtualizada?.origemBairro || resumoCalculado?.origemBairro || '',
        destinoPrincipal: rotaAtualizada?.destinoPrincipal || resumoCalculado?.destinoPrincipal || '',
        destinos: (Array.isArray(rotaAtualizada?.destinos) && rotaAtualizada.destinos.length) ? rotaAtualizada.destinos : (resumoCalculado?.destinos || []),
        bairrosDestino: resumoCalculado?.bairrosDestino || [],
        distanciaTotal: rotaAtualizada?.distanciaTotal || resumoCalculado?.distanciaTotal || 0,
        duracaoTotal: rotaAtualizada?.duracaoTotal || resumoCalculado?.duracaoTotal || 0,
        totalPacotes: rotaAtualizada?.totalPacotes || pacoteIds.length || 0,
        totalFrete: rotaAtualizada?.totalFrete || resumoCalculado?.totalFrete || 0
      };
      await db.ref(`usuarios/${uidEntregador}/rotas/${rotaId}`).set(rotaNoEntregador);

      const notifRef = db.ref(`usuarios/${lojistaUid}/notificacoes`).push();
      await notifRef.set({
        id: notifRef.key,
        tipo: 'rota_aceita',
        titulo: 'Rota aceita',
        mensagem: codigoConfirmacaoColeta
          ? `${entregadorNome} aceitou a rota #${rotaId}. Código de coleta: ${codigoConfirmacaoColeta} — informe ao entregador quando ele for retirar os pacotes.`
          : `${entregadorNome} aceitou a rota #${rotaId}.`,
        rotaId: String(rotaId),
        lida: false,
        criadoEm: agora
      });

      return res.status(200).json({ aceito: true, rota: rotaNoEntregador });
    }

    // path === '/check-pix'
    const { tenantId, paymentId } = req.body || {};
    if (!tenantId || !paymentId) {
      return res.status(400).json({ error: 'Missing required fields', required: ['tenantId', 'paymentId'] });
    }

    const allowed = await canAccessTenant(requester, tenantId);
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden tenant access' });
    }

    const registroSnap = await db.ref(`mp_payments/${paymentId}`).once('value');
    const registro = registroSnap.val();
    if (!registro || String(registro.tenantId) !== String(tenantId)) {
      return res.status(404).json({ error: 'Pagamento não encontrado para este tenant' });
    }

    const data = await consultarPagamentoPixMp(token, paymentId);
    return res.status(200).json({
      paymentId,
      status: data?.status || 'pending',
      statusDetail: data?.status_detail || '',
      ambiente
    });
  } catch (error) {
    logger.error('payments_error', error);
    return res.status(500).json({ error: 'Internal error', message: error.message, ambiente });
  }
});
