// ============================================================================
// core/format.js — helpers puros de formatação/normalização (texto, endereço,
// moeda, distância/duração). Sem DOM, sem Firebase, sem estado — só entrada
// e saída. Reutilizados por praticamente todos os domínios da app.
// ============================================================================

/** minúsculas, sem acento, string vazia se nulo — usado em toda busca/filtro por texto. */
export function normalizarTexto(valor) {
    return (valor || '')
        .toString()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

/** "Rua X, 123 - Bairro, Cidade/UF" → "Rua X, 123 - Cidade" (versão curta pra cards). */
export function formatEnderecoDisplay(endereco) {
    if (!endereco) return '';
    const parts = endereco.split(' - ');
    const ruaNum = parts[0] || endereco;
    const resto = parts[1] || '';

    const cidadeUf = resto.split(',').pop() || '';
    if (cidadeUf.includes('/')) {
        const [cidade] = cidadeUf.split('/');
        return `${ruaNum} - ${cidade.trim()}`;
    }
    return ruaNum;
}

/** Só letras, maiúsculas, máximo 2 caracteres (sigla de UF). */
export function normalizarUf(valor) {
    const letras = (valor || '').toString().toUpperCase().replace(/[^A-Z]/g, '');
    return letras.slice(0, 2);
}

/** 8 dígitos → "00000-000"; qualquer outra coisa → string vazia. */
export function formatarCep(valor) {
    const digits = (valor || '').toString().replace(/\D/g, '').slice(0, 8);
    if (digits.length !== 8) return '';
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

/** Monta "Rua, Num - Bairro, Cidade/UF (Complemento)" a partir dos campos estruturados. */
export function montarEnderecoCliente({ rua, num, bairro, cidade, estado, comp }) {
    const uf = normalizarUf(estado);
    const partes = [];
    const ruaNum = [rua, num].map((v) => (v || '').trim()).filter(Boolean).join(', ');
    if (ruaNum) partes.push(ruaNum);
    const bairroCidade = [(bairro || '').trim(), (cidade || '').trim()].filter(Boolean).join(', ');
    if (bairroCidade || uf) partes.push(`${bairroCidade}${uf ? `/${uf}` : ''}`.trim());
    let endereco = partes.join(' - ');
    const complemento = (comp || '').trim();
    if (complemento) endereco += ` (${complemento})`;
    return endereco.trim();
}

/** Chave estável (cep|rua|num|bairro|cidade|uf) usada pra saber se dois endereços "são o mesmo". */
export function assinaturaEndereco(campos = {}) {
    const cep = formatarCep(campos.cep || '');
    const rua = (campos.rua || '').toString().trim().toLowerCase();
    const num = (campos.num || '').toString().trim().toLowerCase();
    const bairro = (campos.bairro || '').toString().trim().toLowerCase();
    const cidade = (campos.cidade || '').toString().trim().toLowerCase();
    const uf = normalizarUf(campos.uf || campos.estado || '');
    return [cep, rua, num, bairro, cidade, uf].join('|');
}

/** Normaliza um objeto de geolocalização bruto ({lat, lon, ...}) ou retorna null se inválido. */
export function normalizarGeo(geo) {
    if (!geo) return null;
    const lat = Number(geo.lat);
    const lon = Number(geo.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, updatedAt: geo.updatedAt || Date.now() };
}

/** true se a geolocalização cai dentro do bounding box aproximado do Brasil. */
export function geoNoBrasil(geo) {
    const g = normalizarGeo(geo);
    if (!g) return false;
    return g.lat >= -35 && g.lat <= 6 && g.lon >= -75 && g.lon <= -30;
}

/**
 * Extrai {cep, rua, num, bairro, cidade, estado, comp} de um cliente, priorizando
 * os campos estruturados já salvos e caindo pra um parse do campo `endereco`
 * (string livre) só quando faltam rua/num.
 */
export function extrairCamposEnderecoCliente(cliente) {
    const campos = {
        cep: formatarCep(cliente?.cep),
        rua: (cliente?.rua || '').trim(),
        num: (cliente?.num || '').trim(),
        bairro: (cliente?.bairro || '').trim(),
        cidade: (cliente?.cidade || '').trim(),
        estado: normalizarUf(cliente?.estado || cliente?.uf || ''),
        comp: (cliente?.comp || '').trim()
    };
    if (campos.rua && campos.num) return campos;

    const txt = (cliente?.endereco || '').toString().trim();
    if (!txt) return campos;

    const regex = /^(.*?),\s*(.*?)\s*-\s*(.*?),\s*(.*?)\/([A-Za-z]{2})(?:\s*\((.*?)\))?$/;
    const m = txt.match(regex);
    if (m) {
        campos.rua = campos.rua || (m[1] || '').trim();
        campos.num = campos.num || (m[2] || '').trim();
        campos.bairro = campos.bairro || (m[3] || '').trim();
        campos.cidade = campos.cidade || (m[4] || '').trim();
        campos.estado = campos.estado || normalizarUf(m[5] || '');
        campos.comp = campos.comp || (m[6] || '').trim();
        return campos;
    }

    const primeiraParte = txt.split(' - ')[0] || '';
    const ruaNum = primeiraParte.split(',');
    if (!campos.rua) campos.rua = (ruaNum[0] || '').trim();
    if (!campos.num) campos.num = (ruaNum[1] || '').trim();
    return campos;
}

/** Endereço formatado pronto pra geocodificação/cálculo de rota, com fallback. */
export function montarEnderecoParaCalculo(cliente, fallbackEndereco = '') {
    const campos = extrairCamposEnderecoCliente(cliente || {});
    const base = montarEnderecoCliente(campos);
    const cep = formatarCep(campos.cep);
    if (base && cep) return `${base} - CEP ${cep}`;
    return base || fallbackEndereco || '';
}

/** "Rua X, 123 - Bairro - Cidade/UF" a partir de um endereço estruturado de loja. */
export function formatarEnderecoEstruturado(end) {
    if (!end) return '';
    const ruaNum = [end.rua, end.num].filter(Boolean).join(', ');
    const cidadeUf = [end.cidade, end.uf].filter(Boolean).join('/');
    const bairro = end.bairro ? ` - ${end.bairro}` : '';
    return `${ruaNum}${bairro}${cidadeUf ? ` - ${cidadeUf}` : ''}`.trim();
}

/** Endereço da loja formatado pra cálculo (igual ao de exibição + CEP). */
export function formatarEnderecoLojaParaCalculo(end) {
    const base = formatarEnderecoEstruturado(end);
    const cep = formatarCep(end?.cep);
    if (base && cep) return `${base} - CEP ${cep}`;
    return base;
}

/** Endereço da loja formatado como string única pra geocodificação/API de rotas. */
export function formatarEnderecoLojaParaRota(end) {
    if (!end) return '';
    const cep = formatarCep(end.cep || '');
    return [end.rua, end.num, end.bairro, end.cidade, normalizarUf(end.uf || end.estado), cep, 'Brasil']
        .map((v) => (v || '').toString().trim())
        .filter(Boolean)
        .join(', ');
}

/** Endereço do cliente formatado como string única pra geocodificação/API de rotas. */
export function formatarEnderecoClienteParaRota(cliente, fallbackEndereco = '') {
    const campos = extrairCamposEnderecoCliente(cliente || {});
    const cep = formatarCep(campos.cep || '');
    const enderecoRota = [campos.rua, campos.num, campos.bairro, campos.cidade, normalizarUf(campos.estado || campos.uf), cep, 'Brasil']
        .map((v) => (v || '').toString().trim())
        .filter(Boolean)
        .join(', ');
    if (enderecoRota) return enderecoRota;
    const fallback = (fallbackEndereco || '').toString().trim();
    return fallback ? `${fallback}, Brasil` : '';
}

/** "R$ 1.234,56" → 1234.56 (aceita número, string com "R$", separador BR ou já numérico). */
export function parseMoedaParaNumero(valor) {
    if (valor === null || valor === undefined) return 0;
    if (typeof valor === 'number') return valor;
    const limpo = valor.toString().replace('R$', '').trim().replace(/\./g, '').replace(',', '.');
    const numero = Number(limpo);
    return Number.isFinite(numero) ? numero : 0;
}

/** Valor monetário pronto pra um <input> (ex.: "12.50"), vazio se zero/inválido. */
export function precoParaInput(preco) {
    const numero = parseMoedaParaNumero(preco);
    return numero ? numero.toFixed(2) : '';
}

/** Valor monetário formatado pra exibição, padrão BR (ex.: "R$ 12,50"). */
export function precoParaMoeda(preco) {
    const numero = parseMoedaParaNumero(preco);
    return 'R$ ' + numero.toFixed(2).replace('.', ',');
}

/** "12,3 km" (ou "--" se inválido). */
export function formatarDistancia(distanciaKm) {
    if (!Number.isFinite(distanciaKm)) return '--';
    return `${distanciaKm.toFixed(1).replace('.', ',')} km`;
}

/** "45 min" / "1h 20min" / "2h" (ou "--" se inválido). */
export function formatarDuracao(duracaoMin) {
    if (!Number.isFinite(duracaoMin)) return '--';
    if (duracaoMin < 60) return `${Math.max(1, Math.round(duracaoMin))} min`;
    const horas = Math.floor(duracaoMin / 60);
    const mins = Math.round(duracaoMin % 60);
    return mins ? `${horas}h ${mins}min` : `${horas}h`;
}
