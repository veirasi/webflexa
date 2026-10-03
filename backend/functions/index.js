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
const TAXA_ESPERA_GRACE_MIN = 4;
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
const ALLOWLIST_ROTA_MARKETPLACE = ['status', 'pagamentoStatus', 'totalFrete', 'pacoteIds', 'pacotes', 'quantidade', 'entregadorId', 'aceitoPor', 'criadoEm'];

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
  const rotasValidas = ['/create-pix', '/check-pix', '/create-pix-cobranca', '/check-pix-cobranca', '/create-pix-devolucao', '/check-pix-devolucao', '/create-pix-quitacao-divida', '/check-pix-quitacao-divida', '/resolver-taxa-espera', '/confirmar-taxa-espera-recebida', '/confirmar-cobranca-dinheiro', '/creditar-rota-finalizada', '/admin-atualizar-status-rota', '/admin-excluir-rota', '/aceitar-rota-marketplace', '/gerar-login-cliente', '/consumir-login-cliente'];
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

    // Cobranca na entrega: o ENTREGADOR gera o Pix pro cliente pagar no ato da
    // entrega (nunca passa pela mao dele — vai direto pro lojista/plataforma via
    // MP, por isso nao cria divida nenhuma). Ver project-flexa-cobranca-entrega-dinheiro.
    if (path === '/create-pix-cobranca') {
      const { tenantId, rotaId, envioId, valor: valorSolicitado } = req.body || {};
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

      // valor-teto sempre recalculado a partir do envio persistido, nunca do que
      // o app mandar. O app PODE pedir um valor menor (pagamento misto — parte já
      // recebida em dinheiro, ver project-flexa-cobranca-entrega-dinheiro), nunca maior.
      const { dados: pacote, path: pacotePath } = await resolverEnvioLojista(tenantId, envioId);
      const cobranca = pacote?.cobrancaEntrega;
      const valorTotalCobranca = Number(cobranca?.valor);
      if (!pacote || !cobranca?.ativa || !Number.isFinite(valorTotalCobranca) || valorTotalCobranca <= 0) {
        return res.status(422).json({ error: 'Envio sem cobrança na entrega ativa' });
      }
      if (!Array.isArray(cobranca.formasAceitas) || !cobranca.formasAceitas.includes('pix')) {
        return res.status(422).json({ error: 'Pix não habilitado para este envio' });
      }
      if (cobranca.status && cobranca.status !== 'pendente') {
        return res.status(409).json({ error: 'Cobrança já processada para este envio' });
      }
      const valorPedido = Number(valorSolicitado);
      const valorCobranca = Number.isFinite(valorPedido) && valorPedido > 0 && valorPedido <= valorTotalCobranca
        ? valorPedido
        : valorTotalCobranca;

      const nomeCliente = String(pacote?.destinatario || 'Cliente Flex').trim() || 'Cliente Flex';
      const [firstNameCliente, ...restoNomeCliente] = nomeCliente.split(' ');
      const lastNameCliente = restoNomeCliente.join(' ') || 'Flex';

      const mpData = await criarPagamentoPixMp(token, {
        valor: valorCobranca,
        descricao: `Flex - cobrança na entrega (pedido ${envioId})`,
        payerEmail: `cliente-${envioId}@flex.app`,
        payerFirstName: firstNameCliente || 'Cliente',
        payerLastName: lastNameCliente,
        externalReference: `${rotaId}:${envioId}`,
        idempotencyKey: `${tenantId}-${rotaId}-${envioId}-${Date.now()}`
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
        tipo: 'cobranca_entrega',
        total: valorCobranca,
        ambiente,
        criadoEm: Date.now()
      });
      await db.ref(`${pacotePath}/cobrancaEntrega/pixPaymentId`).set(paymentId);

      return res.status(200).json({
        paymentId,
        status: mpData?.status || 'pending',
        statusDetail: mpData?.status_detail || '',
        pixCode,
        ticketUrl: tx.ticket_url || '',
        qrCodeBase64: tx.qr_code_base64 || '',
        valor: valorCobranca,
        ambiente
      });
    }

    if (path === '/check-pix-cobranca') {
      const { tenantId, paymentId } = req.body || {};
      if (!tenantId || !paymentId) {
        return res.status(400).json({ error: 'Missing required fields', required: ['tenantId', 'paymentId'] });
      }

      const registroSnap = await db.ref(`mp_payments/${paymentId}`).once('value');
      const registro = registroSnap.val();
      if (!registro || String(registro.tenantId) !== String(tenantId) || registro.tipo !== 'cobranca_entrega') {
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
        // O Pix da cobrança na entrega é pago pelo cliente e vira CRÉDITO NA
        // CARTEIRA DO LOJISTA (tenantId) — o produto é dele, o entregador só
        // intermediou a cobrança e nunca chega a segurar esse dinheiro (por isso
        // não gera dívida, diferente do dinheiro em espécie). O lojista depois
        // solicita separadamente que a plataforma repasse esse saldo pro Pix dele
        // (fluxo de saque, fora deste endpoint). Decisão do dono, 2026-08-16 —
        // ver project-flexa-cobranca-entrega-dinheiro. Protegido por marcador pra
        // não creditar duas vezes se o polling chamar de novo depois de aprovado.
        const { path: envioPath } = await resolverEnvioLojista(tenantId, registro.envioId);
        if (envioPath) {
          const marcadorRef = db.ref(`${envioPath}/cobrancaEntrega/creditoEfetuadoEm`);
          const marcadorSnap = await marcadorRef.once('value');
          if (!marcadorSnap.val()) {
            const saldoRef = db.ref(`usuarios/${tenantId}/financeiro/saldo`);
            const saldoSnap = await saldoRef.once('value');
            const saldoAntes = Number(saldoSnap.val() || 0);
            const saldoDepois = Number((saldoAntes + registro.total).toFixed(2));
            await saldoRef.set(saldoDepois);
            await marcadorRef.set(Date.now());
            await db.ref(`usuarios/${tenantId}/financeiro/transacoes`).push({
              protocolo: gerarProtocoloTransacaoServer(),
              tipo: 'CREDITO',
              metodo: 'pix',
              valor: registro.total,
              descricao: `Cobrança na entrega recebida via Pix (pedido #${registro.envioId})`,
              remetente: 'Cliente (Pix)',
              destinatario: 'Carteira da loja',
              paymentIdMp: String(paymentId),
              criadoEm: Date.now()
            });
            await db.ref(`${envioPath}/cobrancaEntrega`).update({
              status: 'pago',
              pagoEm: Date.now()
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

    // Taxa de espera/subida (plano de segurança 2026-09-27): antes o valor
    // era calculado no navegador do entregador e a dívida gravada direto do
    // cliente, sem nenhuma validação — um cliente adulterado podia mandar
    // qualquer valor pra qualquer lojistaUid. Agora o servidor recalcula tudo
    // a partir de esperaEntrega.chegouEm/subirStatus (já persistidos por
    // confirmarCheguei/responderSolicitacaoSubida) e só aceita se quem chama
    // é de fato o entregador desta rota.
    if (path === '/resolver-taxa-espera') {
      const { tenantId, rotaId, envioId, recebeuEmDinheiro } = req.body || {};
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

      const espera = pacote.esperaEntrega || {};
      if (espera.finalizada) {
        return res.status(200).json({ jaResolvido: true, valorTaxaTotal: Number(espera.valorTaxaTotal || 0) });
      }

      const chegouEm = Number(espera.chegouEm) || 0;
      const minutosEspera = chegouEm ? Math.max(0, Math.round((Date.now() - chegouEm) / 60000) - TAXA_ESPERA_GRACE_MIN) : 0;
      const valorEspera = Number((minutosEspera * TAXA_ESPERA_POR_MIN).toFixed(2));
      const valorSubir = espera.subirStatus === 'aceito' ? TAXA_SUBIR_FIXA : 0;
      const valorTaxaTotal = Number((valorEspera + valorSubir).toFixed(2));

      if (valorTaxaTotal <= 0) {
        if (chegouEm) {
          await syncEnvioFields(tenantId, envioId, {
            'esperaEntrega/finalizada': true,
            'esperaEntrega/minutosEspera': minutosEspera,
            'esperaEntrega/valorEspera': 0,
            'esperaEntrega/valorSubir': 0,
            'esperaEntrega/valorTaxaTotal': 0
          });
        }
        return res.status(200).json({ valorTaxaTotal: 0, minutosEspera, valorEspera: 0, valorSubir: 0 });
      }

      if (recebeuEmDinheiro) {
        await syncEnvioFields(tenantId, envioId, {
          'esperaEntrega/finalizada': true,
          'esperaEntrega/minutosEspera': minutosEspera,
          'esperaEntrega/valorEspera': valorEspera,
          'esperaEntrega/valorSubir': valorSubir,
          'esperaEntrega/valorTaxaTotal': valorTaxaTotal,
          'esperaEntrega/formaCobranca': 'dinheiro_direto',
          'esperaEntrega/taxaPaga': true,
          'esperaEntrega/taxaPagoEm': Date.now()
        });
        return res.status(200).json({ valorTaxaTotal, minutosEspera, valorEspera, valorSubir, formaCobranca: 'dinheiro_direto' });
      }

      const entregadorNomeSnap = await db.ref(`usuarios/${entregadorId}/nome`).once('value');
      const partes = [];
      if (valorEspera > 0) partes.push(`${minutosEspera} min de espera (R$ ${valorEspera.toFixed(2)})`);
      if (valorSubir > 0) partes.push(`subida no local (R$ ${valorSubir.toFixed(2)})`);
      const motivo = partes.join(' + ');

      await criarDividaLojistaEntregador({
        lojistaUid: tenantId,
        uidEntregador: entregadorId,
        entregadorNome: entregadorNomeSnap.val() || 'Entregador',
        rotaId,
        envioId,
        valor: valorTaxaTotal,
        motivo
      });

      await syncEnvioFields(tenantId, envioId, {
        'esperaEntrega/finalizada': true,
        'esperaEntrega/minutosEspera': minutosEspera,
        'esperaEntrega/valorEspera': valorEspera,
        'esperaEntrega/valorSubir': valorSubir,
        'esperaEntrega/valorTaxaTotal': valorTaxaTotal,
        'esperaEntrega/formaCobranca': 'divida_lojista',
        'esperaEntrega/taxaPaga': false
      });

      return res.status(200).json({ valorTaxaTotal, minutosEspera, valorEspera, valorSubir, formaCobranca: 'divida_lojista' });
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
    // de qualquer lojista como "pago". Agora o teto vem sempre do
    // cobrancaEntrega.valor já persistido (mesma validação que
    // /create-pix-cobranca já faz pro Pix), nunca do que o app manda.
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

      const { dados: pacote } = await resolverEnvioLojista(tenantId, envioId);
      const cobranca = pacote?.cobrancaEntrega;
      const valor = Number(cobranca?.valor);
      if (!pacote || !cobranca?.ativa || !Number.isFinite(valor) || valor <= 0) {
        return res.status(422).json({ error: 'Envio sem cobrança na entrega ativa' });
      }
      if (cobranca.status !== 'pendente') {
        return res.status(409).json({ error: 'Cobrança já processada para este envio' });
      }

      await ajustarDividaUsuarioServer(entregadorId, valor);
      await syncEnvioFields(tenantId, envioId, {
        'cobrancaEntrega/status': 'pago',
        'cobrancaEntrega/valorDinheiro': valor,
        'cobrancaEntrega/valorPix': 0,
        'cobrancaEntrega/pagoEm': Date.now()
      });

      return res.status(200).json({ valor });
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
          return res.status(403).json({ error: 'Capacidade de cobrança insuficiente', motivo: 'capacidade_insuficiente' });
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

      const rotaRef = db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}`);
      const tx = await rotaRef.transaction((atual) => {
        if (!atual) return atual;
        const statusAtual = normalizarStatusRotaServer(atual?.status || atual?.pagamentoStatus || 'CRIADA');
        const jaTemEntregador = Boolean(atual?.entregadorId || atual?.aceitoPor);
        if (statusAtual !== 'BUSCANDO' || jaTemEntregador) return;
        return { ...atual, ...metaEntregador };
      });

      if (!tx.committed || !tx.snapshot.exists()) {
        return res.status(409).json({ error: 'Essa rota já foi aceita por outro entregador', motivo: 'ja_aceita' });
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
