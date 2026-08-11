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
  if (path !== '/create-pix' && path !== '/check-pix') {
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
