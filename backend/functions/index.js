const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.database();

const ROUTING_REGION = process.env.ROUTING_REGION || 'southamerica-east1';
const PAYMENTS_REGION = process.env.PAYMENTS_REGION || 'southamerica-east1';
const REQUIRE_AUTH = String(process.env.REQUIRE_AUTH || 'true').toLowerCase() === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const GOOGLE_SERVER_KEY = process.env.GOOGLE_MAPS_SERVER_KEY || 'AIzaSyCOgFqFbI1U8DPYt_UWyc5_lwft-5PlULQ';

// Segredo do Mercado Pago: NUNCA hardcoded. Definido via:
//   firebase functions:secrets:set MP_ACCESS_TOKEN
// (o valor é digitado direto no terminal do dono da conta, nunca passa pelo código-fonte)
const MP_ACCESS_TOKEN = defineSecret('MP_ACCESS_TOKEN');

function setCors(res) {
  res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
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

async function geocodeGoogle(address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&components=country:BR&key=${GOOGLE_SERVER_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google Geocoding HTTP ${response.status}`);
  const json = await response.json();
  const loc = json?.results?.[0]?.geometry?.location;
  if (json?.status !== 'OK' || !loc) return null;
  return { lat: Number(loc.lat), lon: Number(loc.lng) };
}

async function routeGoogleDistanceMatrix(origin, destination) {
  const origins = `${origin.lat},${origin.lon}`;
  const destinations = `${destination.lat},${destination.lon}`;
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origins)}&destinations=${encodeURIComponent(destinations)}&mode=driving&region=br&language=pt-BR&key=${GOOGLE_SERVER_KEY}`;
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

async function canAccessTenant(requester, tenantId) {
  if (!requester) return false;

  if (requester.uid === tenantId) return true;

  if (requester.admin === true || requester.role === 'admin') return true;

  // fallback: check user type in database
  const snap = await db.ref(`usuarios/${requester.uid}/tipo`).once('value');
  return snap.val() === 'admin';
}

exports.routing = onRequest({ region: ROUTING_REGION, timeoutSeconds: 20 }, async (req, res) => {
  setCors(res);

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

    const [originGeo, destinationGeo] = await Promise.all([
      geoOrigemPreferida ? Promise.resolve(geoOrigemPreferida) : geocodeGoogle(origemResolvida),
      geoDestinoPreferida ? Promise.resolve(geoDestinoPreferida) : geocodeGoogle(destinoEndereco)
    ]);

    if (!originGeo || !destinationGeo) {
      return res.status(422).json({ error: 'Não foi possível geocodificar origem/destino' });
    }

    const route = await routeGoogleDistanceMatrix(originGeo, destinationGeo);
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
exports.payments = onRequest({ region: PAYMENTS_REGION, timeoutSeconds: 20, secrets: [MP_ACCESS_TOKEN] }, async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const path = (req.path || '/').replace(/\/+$/, '') || '/';
  const rotasValidas = ['/create-pix', '/check-pix', '/create-pix-cobranca', '/check-pix-cobranca', '/create-pix-devolucao', '/check-pix-devolucao'];
  if (!rotasValidas.includes(path)) {
    return res.status(404).json({ error: 'Not found' });
  }

  let ambiente = null;
  try {
    const requester = await resolveRequester(req);
    if (!requester) {
      return res.status(401).json({ error: 'Unauthorized' });
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
      const nomeCompleto = String(usuario?.nome || 'Lojista Flexa').trim() || 'Lojista Flexa';
      const [firstName, ...restoNome] = nomeCompleto.split(' ');
      const lastName = restoNome.join(' ') || 'Flexa';
      const payerEmail = String(usuario?.email || requester.email || 'pagador@flexa.app');

      const mpData = await criarPagamentoPixMp(token, {
        valor: total,
        descricao: `Flexa Rota ${rotaId} (${envioIds.length} pacote(s))`,
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

      const nomeCliente = String(pacote?.destinatario || 'Cliente Flexa').trim() || 'Cliente Flexa';
      const [firstNameCliente, ...restoNomeCliente] = nomeCliente.split(' ');
      const lastNameCliente = restoNomeCliente.join(' ') || 'Flexa';

      const mpData = await criarPagamentoPixMp(token, {
        valor: valorCobranca,
        descricao: `Flexa - cobrança na entrega (pedido ${envioId})`,
        payerEmail: `cliente-${envioId}@flexa.app`,
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
              tipo: 'CREDITO',
              valor: registro.total,
              descricao: `Cobrança na entrega recebida via Pix (pedido #${registro.envioId})`,
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
      const nomeLojista = String(usuario?.nome || 'Lojista Flexa').trim() || 'Lojista Flexa';
      const [firstNameLojista, ...restoNomeLojista] = nomeLojista.split(' ');
      const lastNameLojista = restoNomeLojista.join(' ') || 'Flexa';
      const payerEmailLojista = String(usuario?.email || requester.email || 'pagador@flexa.app');

      const mpData = await criarPagamentoPixMp(token, {
        valor: valorFreteVolta,
        descricao: `Flexa - frete de devolução (pedido ${envioId})`,
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
