const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.database();

const ROUTING_REGION = process.env.ROUTING_REGION || 'southamerica-east1';
const REQUIRE_AUTH = String(process.env.REQUIRE_AUTH || 'true').toLowerCase() === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const GOOGLE_SERVER_KEY = process.env.GOOGLE_MAPS_SERVER_KEY || 'AIzaSyCOgFqFbI1U8DPYt_UWyc5_lwft-5PlULQ';

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
