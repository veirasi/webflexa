// ===================== [CONFIG & ESTADO GLOBAL] =====================
const firebaseConfig = {
  apiKey: "AIzaSyBNsTcLawc8VaILryw36F5Iv6tIK0N41Og",
  authDomain: "flexa-app-41205.firebaseapp.com",
  projectId: "flexa-app-41205",
  storageBucket: "flexa-app-41205.firebasestorage.app",
  messagingSenderId: "1008393678489",
  appId: "1:1008393678489:web:8b9df090ef4695d6d6d208"
};
// Inicializa o Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

// VariÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡vel para controle do usuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio logado
let usuarioLogado = null;
let envioStepAtual = 1;
let clientes = [];
let clienteEmEdicaoId = null;
let clienteSelecionadoId = null;
let editRevealTimeout = null;
let cepLojaDebounceTimer = null;
let ultimoCepLojaConsultado = '';
let ultimoErroRota = null;
let googleMapsLoaderPromise = null;

function getUsuarioIdAtual() {
    return usuarioLogado?.id || (firebase.auth().currentUser ? firebase.auth().currentUser.uid : null);
}

async function loadClientes() {
    const uid = getUsuarioIdAtual();
    if (uid) {
        const snap = await db.ref(`usuarios/${uid}/clientes`).once('value');
        const data = snap.val();
        if (data) {
            return Object.keys(data).map((id) => {
                const c = { id, ...data[id] };
                if (!c.geo && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon))) {
                    c.geo = { lat: Number(c.lat), lon: Number(c.lon), updatedAt: Date.now() };
                }
                return c;
            });
        }
    }
    return [
        {
            id: 'maria-silva',
            nome: 'Maria Silva',
            endereco: 'Rua das Flores, 123 - Aldeota',
            whatsapp: '(85) 99876-5432',
            frequente: true,
            envios: 5
        }
    ];
}

async function saveClientes() {
    const uid = getUsuarioIdAtual();
    if (!uid) return;
    const map = clientes.reduce((acc, c) => {
        const { id, ...rest } = c;
        acc[id] = rest;
        return acc;
    }, {});
    await db.ref(`usuarios/${uid}/clientes`).set(map);
}

function normalizarTexto(valor) {
    return (valor || '')
        .toString()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function renderClientes(filtro = '') {
    const container = document.getElementById('clientes-list');
    if (!container) return;

    const filtroTexto = normalizarTexto(filtro);
    const filtroNumero = (filtro || '').replace(/\D/g, '');

    const lista = clientes.filter((c) => {
        const texto = normalizarTexto(`${c.nome} ${c.endereco} ${c.whatsapp}`);
        if (!filtroTexto) return true;
        if (filtroNumero && c.whatsapp) {
            return c.whatsapp.replace(/\D/g, '').includes(filtroNumero);
        }
        return texto.includes(filtroTexto);
    }).sort((a, b) => {
        const fa = a.frequente ? 1 : 0;
        const fb = b.frequente ? 1 : 0;
        if (fb !== fa) return fb - fa;
        return (a.nome || '').localeCompare(b.nome || '');
    });

    if (!lista.length) {
        container.innerHTML = `<div style="text-align:center; color: var(--text-sub); font-size: 13px; padding: 10px 0;">Nenhum cliente encontrado.</div>`;
        return;
    }

    container.innerHTML = lista.map((c) => {
        const badge = c.frequente ? '<span class="badge-freq">Frequente</span>' : '';
        return `
        <div class="swipe-container" id="container-${c.id}">
            <div class="swipe-action-delete">
                <i data-lucide="trash-2" size="20"></i>
                <span>Excluir</span>
            </div>

            <div class="cliente-card-simples"
                 id="card-${c.id}"
                 data-client-id="${c.id}"
                 onclick="irParaPasso2('${c.id}', '${c.nome.replace(/'/g, "\\'")}', '${c.endereco.replace(/'/g, "\\'")}', '${c.whatsapp.replace(/'/g, "\\'")}'); revealEditButton(this);"
                 ontouchstart="handleTouchStart(event)"
                 ontouchmove="handleTouchMove(event)"
                 ontouchend="handleTouchEnd(event)"
                 style="position: relative; z-index: 2; margin-bottom: 0 !important;">

                ${badge}
                <button class="cliente-edit-btn" onclick="abrirEditarCliente('${c.id}'); event.stopPropagation();">
                    <i data-lucide="pencil" size="14"></i>
                </button>
                <button class="cliente-history-btn" onclick="verHistoricoCliente('${c.id}'); event.stopPropagation();">Ver histÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³rico</button>
                <strong style="font-size: 17px; font-weight: 800; display: block; margin-bottom: 2px;">${c.nome}</strong>
                <span class="cliente-endereco">${formatEnderecoDisplay(c.endereco)}</span>

                <span style="color: var(--brand-orange); font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 6px; margin-top: 6px;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 448 512" fill="currentColor"><path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.1 0-65.6-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-5.5-2.8-23.2-8.5-44.2-27.1-16.4-14.6-27.4-32.7-30.6-38.2-3.2-5.6-.3-8.6 2.5-11.3 2.5-2.5 5.6-6.5 8.3-9.7 2.8-3.3 3.7-5.6 5.6-9.3 1.9-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 13.2 5.8 23.5 9.2 31.5 11.8 13.3 4.2 25.4 3.6 35 2.2 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z"/></svg>
                    ${c.whatsapp}
                </span>
            </div>
        </div>
        `;
    }).join('');

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function formatEnderecoDisplay(endereco) {
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

function normalizarUf(valor) {
    const letras = (valor || '').toString().toUpperCase().replace(/[^A-Z]/g, '');
    return letras.slice(0, 2);
}

function formatarCep(valor) {
    const digits = (valor || '').toString().replace(/\D/g, '').slice(0, 8);
    if (digits.length !== 8) return '';
    return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

function montarEnderecoCliente({ rua, num, bairro, cidade, estado, comp }) {
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

function assinaturaEndereco(campos = {}) {
    const cep = formatarCep(campos.cep || '');
    const rua = (campos.rua || '').toString().trim().toLowerCase();
    const num = (campos.num || '').toString().trim().toLowerCase();
    const bairro = (campos.bairro || '').toString().trim().toLowerCase();
    const cidade = (campos.cidade || '').toString().trim().toLowerCase();
    const uf = normalizarUf(campos.uf || campos.estado || '');
    return [cep, rua, num, bairro, cidade, uf].join('|');
}

function geoNoBrasil(geo) {
    const g = normalizarGeo(geo);
    if (!g) return false;
    return g.lat >= -35 && g.lat <= 6 && g.lon >= -75 && g.lon <= -30;
}

function extrairCamposEnderecoCliente(cliente) {
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

function montarEnderecoParaCalculo(cliente, fallbackEndereco = '') {
    const campos = extrairCamposEnderecoCliente(cliente || {});
    const base = montarEnderecoCliente(campos);
    const cep = formatarCep(campos.cep);
    if (base && cep) return `${base} - CEP ${cep}`;
    return base || fallbackEndereco || '';
}

function normalizarGeo(geo) {
    if (!geo) return null;
    const lat = Number(geo.lat);
    const lon = Number(geo.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, updatedAt: geo.updatedAt || Date.now() };
}

async function geocodificarPorCampos(campos = {}) {
    if (!GOOGLE_MAPS_KEY) return null;
    const rua = (campos.rua || '').toString().trim();
    const num = (campos.num || '').toString().trim();
    const bairro = (campos.bairro || '').toString().trim();
    const cidade = (campos.cidade || '').toString().trim();
    const estado = normalizarUf(campos.uf || campos.estado || '');
    const cep = formatarCep(campos.cep || '');
    const enderecoGoogle = [rua, num, bairro, cidade, estado, cep, 'Brasil'].filter(Boolean).join(', ');

    try {
        const maps = await carregarGoogleMapsJs();
        const geocoder = new maps.Geocoder();
        const resultado = await new Promise((resolve) => {
            geocoder.geocode(
                {
                    address: enderecoGoogle,
                    componentRestrictions: { country: 'BR' }
                },
                (results, status) => resolve({ results, status })
            );
        });
        const primeiro = resultado?.results?.[0] || null;
        const loc = primeiro?.geometry?.location;
        if (resultado?.status === 'OK' && loc) {
            const geo = { lat: Number(loc.lat()), lon: Number(loc.lng()) };
            if (!geoNoBrasil(geo)) {
                setUltimoErroRota('Geocode retornou coordenada fora do Brasil.', { status: resultado?.status, enderecoGoogle, geo });
                return null;
            }
            const cityEsperada = normalizarTexto(cidade || '');
            const ufEsperada = normalizarUf(estado || '');
            if (cityEsperada || ufEsperada) {
                const comps = Array.isArray(primeiro?.address_components) ? primeiro.address_components : [];
                const cityComp = normalizarTexto((comps.find(c => c.types?.includes('administrative_area_level_2'))?.long_name || comps.find(c => c.types?.includes('locality'))?.long_name || ''));
                const ufComp = normalizarUf(comps.find(c => c.types?.includes('administrative_area_level_1'))?.short_name || '');
                const cidadeOk = !cityEsperada || (cityComp && (cityComp.includes(cityEsperada) || cityEsperada.includes(cityComp)));
                const ufOk = !ufEsperada || (ufComp === ufEsperada);
                if (!cidadeOk || !ufOk) {
                    setUltimoErroRota('Geocode retornou local divergente do endereco informado.', {
                        enderecoGoogle,
                        cityEsperada,
                        ufEsperada,
                        cityComp,
                        ufComp,
                        formatted: primeiro?.formatted_address || null
                    });
                    return null;
                }
            }
            return geo;
        }
        setUltimoErroRota('Google Geocoding por campos falhou.', { status: resultado?.status || null, enderecoGoogle });
        return null;
    } catch (erro) {
        setUltimoErroRota('Falha no Google Geocoding por campos.', erro?.message || String(erro));
        return null;
    }
}

function getClienteById(id) {
    return clientes.find((c) => c.id === id) || null;
}

function getGeoCliente(cliente) {
    return normalizarGeo(cliente?.geo);
}

function revealEditButton(cardEl) {
    if (!cardEl) return;
    document.querySelectorAll('.cliente-card-simples.show-edit').forEach(el => el.classList.remove('show-edit'));
    cardEl.classList.add('show-edit');
    if (editRevealTimeout) clearTimeout(editRevealTimeout);
    editRevealTimeout = setTimeout(() => {
        cardEl.classList.remove('show-edit');
    }, 2200);
}

async function initClientes() {
    clientes = await loadClientes();
    renderClientes(document.getElementById('buscar-cliente')?.value || '');
}

        lucide.createIcons();

        // ===================== [NAVEGA - fO & UI GLOBAL] =====================
function navegar(idTela) {
		if (idTela === 'view-perfil' && window.usuarioLogado) {
        const dados = window.usuarioLogado;
        if (document.getElementById('perfil-nome-display')) {
            document.getElementById('perfil-nome-display').innerText = dados.nome || 'UsuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio';
            document.getElementById('perfil-insta-display').innerText = dados.instagram || '@seuinsta';
            document.getElementById('perfil-foto-display').src = dados.foto || 'https://via.placeholder.com/110';
        }
    }
    // --------------------------------
    
    
    // 1. Troca de telas
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(idTela);
    if(target) target.classList.add('active');
    
    // 2. Limpeza do formulÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio de envio (Regra do Flexa)
    if (idTela !== 'view-novo-envio') {
        const passos = ['envio-p1', 'envio-p2', 'envio-p3', 'envio-p4', 'envio-p5', 'envio-v-veiculo'];
        passos.forEach(id => {
            const el = document.getElementById(id);
            if(el) el.classList.add('hidden');
        });
        const p1 = document.getElementById('envio-p1');
        if(p1) p1.classList.remove('hidden');
        // Fecha sheets de envio se estiverem abertos
        fecharModalEnvioDetalhes();
        fecharModalNovoCliente();
    }
    if (idTela === 'view-novo-envio') {
        initClienteSearch();
        initClientes();
    }

    // 3. Controle do Menu Inferior
    // MUDANÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡A: Use o ID exato que estÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ no seu HTML (ex: main-nav)
    const nav = document.getElementById('main-nav'); 
    const telasComMenu = ['view-dash-loja', 'view-novo-envio', 'view-rotas', 'view-perfil'];
    
    if(nav) {
        nav.style.display = telasComMenu.includes(idTela) ? 'flex' : 'none';
    }

    // 4. Marcar ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âcone Ativo
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    
    // Mapeamento simples
    const menuMap = {
        'view-dash-loja': 1,
        'view-rotas': 2,
        'view-chat': 4,
        'view-perfil': 5
    };

    if(menuMap[idTela]) {
        const activeItem = document.querySelector(`.nav-item:nth-child(${menuMap[idTela]})`);
        if(activeItem) activeItem.classList.add('active');
    }
    
    window.scrollTo(0,0);
    if(typeof lucide !== 'undefined') lucide.createIcons();
}

// FunÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o de Preview da Foto (Ponto 1)
function previewImage(event) {
    const reader = new FileReader();
    reader.onload = function() {
        document.getElementById('preview-foto').src = reader.result;
    }
    reader.readAsDataURL(event.target.files[0]);
}

async function buscarEndereco() {
    const cepField = document.getElementById('new-cli-cep');
    const cep = cepField.value.replace(/\D/g, '');

    if (cep.length === 8) {
        try {
            const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
            const data = await response.json();

            if (!data.erro) {
                document.getElementById('new-cli-rua').value = data.logradouro || '';
                document.getElementById('new-cli-bairro').value = data.bairro || '';
                document.getElementById('new-cli-cidade').value = data.localidade || '';
                document.getElementById('new-cli-estado').value = data.uf || '';
                // Foca no nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âºmero automaticamente para agilizar
                document.getElementById('new-cli-num').focus();
            } else {
                alert("CEP nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o encontrado.");
            }
        } catch (error) {
            console.error("Erro na busca:", error);
        }
    }
}




        function irParaCadastro(tipo) {
            navegar('view-auth');
            const groupCNH = document.getElementById('group-cnh');
            const inputNome = document.getElementById('input-nome');
            document.getElementById('label-nome').innerText = tipo === 'loja' ? "Nome da loja" : "Nome completo";
            inputNome.placeholder = tipo === 'loja' ? "Digite o nome da loja" : "Seu nome completo";
            tipo === 'loja' ? groupCNH.classList.add('hidden') : groupCNH.classList.remove('hidden');
            alternarAuth('entrar');
}

function initClienteSearch() {
    const input = document.getElementById('buscar-cliente');
    if (!input || input.dataset.bound === 'true') return;
    input.dataset.bound = 'true';
    input.addEventListener('input', (e) => {
        renderClientes(e.target.value || '');
    });
}

// --- MODAIS (SHEETS) DO ENVIO ---
function abrirModalEnvioDetalhes() {
    const modal = document.getElementById('modal-envio-detalhes');
    if (!modal) return;
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('is-open'));
    setModalEnvioStep(1);
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function fecharModalEnvioDetalhes() {
    const modal = document.getElementById('modal-envio-detalhes');
    if (!modal) return;
    modal.classList.remove('is-open');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 250);
    setModalEnvioStep(1);
}

function abrirModalNovoCliente() {
    const modal = document.getElementById('modal-novo-cliente');
    if (!modal) return;
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('is-open'));
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function fecharModalNovoCliente() {
    const modal = document.getElementById('modal-novo-cliente');
    if (!modal) return;
    modal.classList.remove('is-open');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 250);
}

function abrirEditarCliente(id) {
    const cliente = clientes.find(c => c.id === id);
    if (!cliente) return;
    clienteEmEdicaoId = id;
    document.getElementById('new-cli-nome').value = cliente.nome || '';
    document.getElementById('new-cli-tel').value = cliente.whatsapp || '';
    const campos = extrairCamposEnderecoCliente(cliente);
    document.getElementById('new-cli-cep').value = campos.cep || '';
    document.getElementById('new-cli-rua').value = campos.rua || '';
    document.getElementById('new-cli-num').value = campos.num || '';
    document.getElementById('new-cli-bairro').value = campos.bairro || '';
    document.getElementById('new-cli-cidade').value = campos.cidade || '';
    document.getElementById('new-cli-estado').value = campos.estado || '';
    document.getElementById('new-cli-comp').value = campos.comp || '';

    document.getElementById('novo-cliente-title').innerText = 'Editar Cliente';
    document.getElementById('btn-salvar-cliente').innerText = 'Salvar AlteraÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âµes';
    abrirModalNovoCliente();
}

function resetClienteForm() {
    document.querySelectorAll('#modal-novo-cliente input').forEach(input => input.value = '');
    clienteEmEdicaoId = null;
    document.getElementById('novo-cliente-title').innerText = 'Novo Cliente';
    document.getElementById('btn-salvar-cliente').innerText = 'Salvar e Continuar';
}

function verHistoricoCliente(id) {
    const cliente = clientes.find(c => c.id === id);
    if (!cliente) return;
    const historico = Array.isArray(cliente.historico) ? cliente.historico : [];
    document.getElementById('historico-title').innerText = `HistÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³rico  -  ${cliente.nome}`;
    const list = document.getElementById('historico-list');
    if (!historico.length) {
        list.innerHTML = `<div style="text-align:center; color: var(--text-sub); font-size: 13px; padding: 20px 0;">Este cliente ainda nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o possui envios.</div>`;
    } else {
        list.innerHTML = historico.map((h) => {
            const data = new Date(h.criadoEm || Date.now()).toLocaleDateString('pt-BR');
            return `
                <div class="historico-item">
                    <h4>${h.descricao ? h.descricao : 'Envio'}</h4>
                    <p>${data}  -  ${h.servico || '-'}  -  ${h.tamanho || '-'}</p>
                    <div class="historico-meta">
                        <span>${h.veiculo || '-'}</span>
                        <span>R$ ${h.valor || '-'}</span>
                    </div>
                </div>
            `;
        }).join('');
    }
    abrirModalHistorico();
}

function abrirModalHistorico() {
    const modal = document.getElementById('modal-historico');
    if (!modal) return;
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('is-open'));
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function fecharModalHistorico() {
    const modal = document.getElementById('modal-historico');
    if (!modal) return;
    modal.classList.remove('is-open');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 250);
}

function setModalEnvioStep(step) {
    envioStepAtual = step;
    const steps = [
        document.getElementById('modal-envio-step-1'),
        document.getElementById('modal-envio-step-2'),
        document.getElementById('modal-envio-step-3'),
        document.getElementById('modal-envio-step-4')
    ];
    const footerStep1 = document.getElementById('modal-envio-footer-step-1');
    steps.forEach((el, idx) => {
        if (!el) return;
        if (idx === step - 1) {
            el.classList.remove('hidden');
            el.classList.add('fade-step');
            setTimeout(() => el.classList.remove('fade-step'), 400);
        } else {
            el.classList.add('hidden');
        }
    });
    if (footerStep1) {
        footerStep1.style.display = step === 1 ? 'block' : 'none';
    }

    const titles = {
        1: 'Detalhes do Envio',
        2: 'Escolha o transporte',
        3: 'Revisar Envio',
        4: 'Pedido solicitado'
    };
    const titleEl = document.getElementById('envio-sheet-title');
    if (titleEl) titleEl.innerText = titles[step] || 'Detalhes do Envio';

    const dots = document.querySelectorAll('#envio-progress-dots .dot');
    dots.forEach((dot) => {
        const dotStep = Number(dot.getAttribute('data-step'));
        if (dotStep === step) {
            dot.classList.add('active');
            dot.classList.remove('pulse');
            void dot.offsetWidth;
            dot.classList.add('pulse');
        } else {
            dot.classList.remove('active');
            dot.classList.remove('pulse');
        }
    });

    if (navigator.vibrate && step > 1) {
        navigator.vibrate(6);
    }
}

function handleEnvioBack() {
    if (envioStepAtual > 1) {
        setModalEnvioStep(envioStepAtual - 1);
    } else {
        fecharModalEnvioDetalhes();
    }
}

        /* L?"GICA DE PASSOS DO ENVIO */
        function irParaPasso2(id, nome, endereco, whats) {
    clienteSelecionadoId = id;
    const cliente = getClienteById(id);
    // Preenche os dados
    document.getElementById('card-nome').innerText = nome;
    document.getElementById('card-endereco').innerText = endereco;
    document.getElementById('card-whatsapp').innerText = whats;
    resumoRevisaoAtual.destino = montarEnderecoParaCalculo(cliente, endereco);
    resumoRevisaoAtual.destinoGeo = getGeoCliente(cliente);
    resumoRevisaoAtual.origemGeo = normalizarGeo(window.usuarioLogado?.endereco?.geo);
    resumoRevisaoAtual.distanciaKm = null;
    resumoRevisaoAtual.duracaoMin = null;

    // Para base legada sem coordenadas, tenta geocodificar em segundo plano.
    if (cliente && !resumoRevisaoAtual.destinoGeo) {
        garantirGeoClienteSelecionado().catch(() => {});
    }

    // Abre o modal sheet de detalhes (passo 1)
    abrirModalEnvioDetalhes();
}

function voltarParaPasso(p) {
    // Esconde absolutamente todos os passos de envio para nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o encavalar
    const todosPassos = ['envio-p1', 'envio-p2', 'envio-p3', 'envio-p4', 'envio-p5', 'envio-v-veiculo'];
    todosPassos.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.classList.add('hidden');
    });

    // Mostra apenas o destino solicitado
    const destino = document.getElementById('envio-p' + p);
    if(destino) {
        destino.classList.remove('hidden');
        destino.classList.add('fade-step'); 
        setTimeout(() => destino.classList.remove('fade-step'), 400);
    }
    window.scrollTo(0,0);
}

        function selecionarServico(tipo) {
            document.getElementById('srv-std').classList.remove('active');
            document.getElementById('srv-flash').classList.remove('active');
            const id = tipo === 'Standard' ? 'srv-std' : 'srv-flash';
            document.getElementById(id).classList.add('active');
            atualizarPrecoEstimadoAtual();
        }

        function selecionarTamanho(tam) {
            document.getElementById('sz-p').classList.remove('active');
            document.getElementById('sz-m').classList.remove('active');
            document.getElementById('sz-g').classList.remove('active');
            document.getElementById('sz-' + tam.toLowerCase()).classList.add('active');
        }

        /* L?"GICA AUTH ORIGINAL */
        function togglePass(id) {
            const input = document.getElementById(id);
            input.type = input.type === 'password' ? 'text' : 'password';
        }
        function alternarAuth(modo) {
            const fCad = document.getElementById('form-cadastrar'), fEnt = document.getElementById('form-entrar');
            const tCad = document.getElementById('tab-cadastrar'), tEnt = document.getElementById('tab-entrar');
            if (modo === 'cadastrar') {
                fCad.classList.remove('hidden'); fEnt.classList.add('hidden');
                tCad.classList.add('active'); tEnt.classList.remove('active');
            } else {
                fEnt.classList.remove('hidden'); fCad.classList.add('hidden');
                tEnt.classList.add('active'); tCad.classList.remove('active');
            }
        }

function confirmarEnvioFinal() {
    setModalEnvioStep(4);
    if (typeof lucide !== 'undefined') lucide.createIcons();

    if (clienteSelecionadoId) {
        const idx = clientes.findIndex(c => c.id === clienteSelecionadoId);
        if (idx >= 0) {
            const enviosAtual = Number(clientes[idx].envios || 0) + 1;
            clientes[idx].envios = enviosAtual;
            if (enviosAtual >= 5) clientes[idx].frequente = true;

            const historico = Array.isArray(clientes[idx].historico) ? clientes[idx].historico : [];
            const desc = document.getElementById('input-desc')?.value || '';
            const servico = resumoRevisaoAtual.servico || getServicoSelecionadoAtual();
            const tamanho = document.querySelector('#modal-envio-detalhes .selection-grid-3 .select-box.active strong')?.innerText || '';
            const totalFrete = Number.isFinite(resumoRevisaoAtual.totalFrete)
                ? resumoRevisaoAtual.totalFrete
                : parseMoedaParaNumero(document.getElementById('input-valor')?.value || 0);

            historico.unshift({
                id: `envio-${Date.now()}` ,
                criadoEm: Date.now(),
                descricao: desc,
                valorFrete: Number(totalFrete.toFixed(2)),
                servico,
                tamanho,
                veiculo: resumoRevisaoAtual.veiculo || veiculoSelecionado,
                distanciaKm: Number.isFinite(resumoRevisaoAtual.distanciaKm) ? Number(resumoRevisaoAtual.distanciaKm.toFixed(2)) : null,
                duracaoMin: Number.isFinite(resumoRevisaoAtual.duracaoMin) ? Math.round(resumoRevisaoAtual.duracaoMin) : null,
                origemEndereco: resumoRevisaoAtual.origem || obterEnderecoLojaTexto(),
                destinoEndereco: resumoRevisaoAtual.destino || document.getElementById('card-endereco')?.innerText || ''
            });

            clientes[idx].historico = historico.slice(0, 50);
            saveClientes();
            renderClientes(document.getElementById('buscar-cliente')?.value || '');
        }
    }
}

function abrirNovoCliente() {
    resetClienteForm();
    abrirModalNovoCliente();
}

// --- MÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂSCARAS DE INPUT ---
document.getElementById('new-cli-tel').addEventListener('input', function (e) {
    let x = e.target.value.replace(/\D/g, '').match(/(\d{0,2})(\d{0,5})(\d{0,4})/);
    e.target.value = !x[2] ? x[1] : '(' + x[1] + ') ' + x[2] + (x[3] ? '-' + x[3] : '');
});

document.getElementById('new-cli-cep').addEventListener('input', function (e) {
    let x = e.target.value.replace(/\D/g, '').match(/(\d{0,5})(\d{0,3})/);
    e.target.value = !x[2] ? x[1] : x[1] + '-' + x[2];
});

// --- FUN - fO SALVAR ?sNICA E CORRIGIDA ---
async function salvarNovoCliente() {
    const nome = document.getElementById('new-cli-nome').value;
    const tel = document.getElementById('new-cli-tel').value;
    const cep = document.getElementById('new-cli-cep').value;
    const rua = document.getElementById('new-cli-rua').value;
    const num = document.getElementById('new-cli-num').value;
    const bairro = document.getElementById('new-cli-bairro').value;
    const cidade = document.getElementById('new-cli-cidade').value;
    const estado = document.getElementById('new-cli-estado').value;
    const comp = document.getElementById('new-cli-comp').value;

    if(nome && tel && rua && num) {
        const enderecoCompleto = montarEnderecoCliente({ rua, num, bairro, cidade, estado, comp });
        const ufNormalizada = normalizarUf(estado);
        const cepLimpo = formatarCep(cep);

        if (clienteEmEdicaoId) {
            const idx = clientes.findIndex(c => c.id === clienteEmEdicaoId);
            if (idx >= 0) {
                clientes[idx] = {
                    ...clientes[idx],
                    nome: nome.trim(),
                    endereco: enderecoCompleto,
                    whatsapp: tel.trim(),
                    cep: cepLimpo,
                    rua: (rua || '').trim(),
                    num: (num || '').trim(),
                    bairro: (bairro || '').trim(),
                    cidade: (cidade || '').trim(),
                    uf: ufNormalizada,
                estado: ufNormalizada,
                    comp: (comp || '').trim()
                };
                const geo = await geocodificarCliente(clientes[idx]).catch(() => null);
                if (geo) {
                    clientes[idx].geo = normalizarGeo(geo);
                    clientes[idx].geoSig = assinaturaEndereco(clientes[idx]);
                }
            }
            await saveClientes();
            renderClientes(document.getElementById('buscar-cliente')?.value || '');
            clienteSelecionadoId = clienteEmEdicaoId;
        } else {
            const novoCliente = {
                id: `cli-${Date.now()}`,
                nome: nome.trim(),
                endereco: enderecoCompleto,
                whatsapp: tel.trim(),
                cep: cepLimpo,
                rua: (rua || '').trim(),
                num: (num || '').trim(),
                bairro: (bairro || '').trim(),
                cidade: (cidade || '').trim(),
                uf: ufNormalizada,
                estado: ufNormalizada,
                comp: (comp || '').trim(),
                frequente: false,
                envios: 0
            };
            const geo = await geocodificarCliente(novoCliente).catch(() => null);
            if (geo) {
                novoCliente.geo = normalizarGeo(geo);
                novoCliente.geoSig = assinaturaEndereco(novoCliente);
            }
            clientes.unshift(novoCliente);
            await saveClientes();
            renderClientes(document.getElementById('buscar-cliente')?.value || '');
            clienteSelecionadoId = novoCliente.id;
        }
        
        // Abre o modal de detalhes com os dados
        irParaPasso2(clienteSelecionadoId, nome, enderecoCompleto, tel);
        
        // Fecha o modal de novo cliente
        fecharModalNovoCliente();
        
        // Limpa os campos
        resetClienteForm();
    } else {
        alert("Por favor, preencha Nome, WhatsApp, Rua e NÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âºmero.");
    }
}


        function simularLogin() {
            navegar('view-dash-loja');
                        setTimeout(() => {
                document.getElementById('dash-loader-content').innerHTML = `
                    <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 25px;">OlÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡, Express Imports! </h2>
                    <div class="promo-banner"><h3>EstÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ com pressa?</h3><p>Experimente o envio <b>Flash</b>.</p></div>
                    
                    <div class="grid-stats">
                        <div class="stat-card"><span>Entregas hoje</span><h4>12</h4></div>
                        <div class="stat-card"><span>Em trÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢nsito</span><h4>4</h4></div>
                    </div>

                    <div class="filter-container">
                        <div class="chip active">Todas</div>
                        <div class="chip">Em rota</div>
                        <div class="chip">Pendentes</div>
                    </div>

                    <div class="rota-card">
                        <div class="rota-icon"><i data-lucide="package" size="22"></i></div>
                        <div class="rota-info">
                            <h5>Rota #8829</h5>
                            <p>4 pacotes  -  Fortaleza</p>
                        </div>
                        <span class="status-pill pill-em-rota">Em rota</span>
                    </div>
                `;
                lucide.createIcons();
            }, 1200);
        }
        // --- C?"DIGO DO SWIPE (DESLIZAR) ---
        let touchStartX = 0;
        let activeCard = null;
        let pendingDeleteClientId = null;

        function handleTouchStart(e) {
            // Se o toque for no card da Maria, vamos rastrear
            touchStartX = e.touches[0].clientX;
            activeCard = e.currentTarget;
            activeCard.style.transition = 'none'; // Tira a animaÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o enquanto o dedo move
            revealEditButton(activeCard);
        }

        function handleTouchMove(e) {
            if (!activeCard) return;
            let touchX = e.touches[0].clientX;
            let diff = touchX - touchStartX;
            
            // SÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ deixa arrastar para a esquerda (diff negativo)
            // Limitamos em -150px para o card nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o sair da tela totalmente sem querer
            if (diff < 0 && diff > -150) {
                activeCard.style.transform = `translateX(${diff}px)`;
            }
        }

                function handleTouchEnd(e) {
            if (!activeCard) return;
            activeCard.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
            
            let touchX = e.changedTouches[0].clientX;
            let diff = touchX - touchStartX;

            // Se deslizou mais de 70px para a esquerda
            if (diff < -70) {
                // Faz o card sair da tela
                activeCard.style.transform = 'translateX(-120%)';
                
                // Guarda o ID para saber quem excluir
                const idParaDeletar = activeCard.id;
                
                // Chama a confirmaÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o apÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³s o movimento de saÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­da
                setTimeout(() => {
                    confirmarExclusao(idParaDeletar);
                }, 300);
            } else {
                // Volta para o lugar se deslizou pouco
                activeCard.style.transform = 'translateX(0)';
            }
            activeCard = null;
        }


        function confirmarExclusao(cardId) {
            const card = document.getElementById(cardId);
            const container = card.parentElement;
            container.style.display = 'none';
            pendingDeleteClientId = card.dataset?.clientId || null;

            const toastAntigo = document.getElementById('toast-desfazer');
            if (toastAntigo) toastAntigo.remove();

            const toast = document.createElement('div');
            toast.className = 'undo-toast';
            toast.id = 'toast-desfazer';
            
            // Agora o clique funciona em qualquer lugar do toast
            toast.onclick = () => desfazerExclusao(cardId);

            let segundosRestantes = 10;

            toast.innerHTML = `
                <div class="undo-content">
                    <div class="undo-timer" id="timer-count">${segundosRestantes}</div>
                    <span style="font-size: 14px;">Cliente removido</span>
                </div>
                <div class="undo-btn">Desfazer</div>
            `;
            
            document.body.appendChild(toast);

            // LÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³gica do contador visual
            const interval = setInterval(() => {
                segundosRestantes--;
                const timerElement = document.getElementById('timer-count');
                if (timerElement) {
                    timerElement.innerText = segundosRestantes;
                }
                
                if (segundosRestantes <= 0) {
                    clearInterval(interval);
                    fecharToastSuave(toast);
                    if (pendingDeleteClientId) {
                        clientes = clientes.filter(c => c.id !== pendingDeleteClientId);
                        saveClientes();
                        renderClientes(document.getElementById('buscar-cliente')?.value || '');
                        pendingDeleteClientId = null;
                    }
                }
            }, 1000);

            // Guardamos o intervalo no elemento para limpar se o usuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio clicar antes
            toast.dataset.intervalId = interval;
        }

        function fecharToastSuave(elemento) {
            if (elemento) {
                elemento.style.opacity = '0';
                elemento.style.transition = 'opacity 0.5s ease-out';
                setTimeout(() => elemento.remove(), 1000);
            }
        }

        // Ajuste na funÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o de desfazer para limpar o contador
        function desfazerExclusao(cardId) {
            const toast = document.getElementById('toast-desfazer');
            if (toast) {
                clearInterval(toast.dataset.intervalId);
                toast.remove();
            }

            const card = document.getElementById(cardId);
            const container = card.parentElement;
            container.style.display = 'block';
            card.style.transform = 'translateX(0)';
            pendingDeleteClientId = null;
        }



        // VERSÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢O LEGADA: mantida para comparaÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o de comportamento.
        // A versÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o ativa de `desfazerExclusao` ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© a primeira (com limpeza de intervalo do timer).
        function desfazerExclusao_legacy(cardId) {
            const card = document.getElementById(cardId);
            const container = card.parentElement;
            
            // Traz o container de volta e reseta o card para a posiÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o original
            container.style.display = 'block';
            card.style.transform = 'translateX(0)';
            
            // Remove o aviso preto da tela imediatamente
            const aviso = document.getElementById('toast-desfazer');
            if (aviso) aviso.remove();
        }

let veiculoSelecionado = "Moto";
let veiculoPrecoSelecionado = "R$ 12,50";
let resumoRevisaoAtual = {
    origem: '',
    destino: '',
    origemGeo: null,
    destinoGeo: null,
    distanciaKm: null,
    duracaoMin: null,
    totalFrete: null,
    servico: 'Standard',
    veiculo: 'Moto'
};


const TAXA_MINIMA = { Standard: 5.0, Flash: 9.0 };
const TAXA_POR_KM = { Standard: 1.10, Flash: 1.99 };
const DISTANCIA_MINIMA_KM = 4;
const AJUSTE_VEICULO_POR_SERVICO = {
    Standard: {
        Patinete: -0.8,
        Bicicleta: -0.6,
        Moto: 0,
        Carro: 5,
        Van: 8
    },
    Flash: {
        Patinete: 0,
        Bicicleta: 0,
        Moto: 0,
        Carro: 8,
        Van: 12
    }
};
const DISTANCIA_MAX_CURTA = 3;
const VEICULOS_CURTOS = ['Patinete', 'Bicicleta'];

function getServicoSelecionadoAtual() {
    return document.querySelector('#modal-envio-detalhes .selection-grid .select-box.active strong')?.innerText || 'Standard';
}

function parseMoedaParaNumero(valor) {
    if (valor === null || valor === undefined) return 0;
    if (typeof valor === 'number') return valor;
    const limpo = valor.toString().replace('R$', '').trim().replace(/\./g, '').replace(',','.');
    const numero = Number(limpo);
    return Number.isFinite(numero) ? numero : 0;
}

function precoParaInput(preco) {
    const numero = parseMoedaParaNumero(preco);
    return numero ? numero.toFixed(2) : '';
}

function precoParaMoeda(preco) {
    const numero = parseMoedaParaNumero(preco);
    return 'R$ ' + numero.toFixed(2).replace('.', ',');
}

const GOOGLE_MAPS_KEY = (window.FLEXA_GOOGLE_MAPS_KEY || '').trim();

function formatarEnderecoEstruturado(end) {
    if (!end) return '';
    const ruaNum = [end.rua, end.num].filter(Boolean).join(', ');
    const cidadeUf = [end.cidade, end.uf].filter(Boolean).join('/');
    const bairro = end.bairro ? ` - ${end.bairro}` : '';
    return `${ruaNum}${bairro}${cidadeUf ? ` - ${cidadeUf}` : ''}`.trim();
}

function formatarEnderecoLojaParaCalculo(end) {
    const base = formatarEnderecoEstruturado(end);
    const cep = formatarCep(end?.cep);
    if (base && cep) return `${base} - CEP ${cep}`;
    return base;
}


function obterEnderecoLojaTexto() {
    return formatarEnderecoEstruturado(window.usuarioLogado?.endereco);
}

async function obterEnderecoLojaAtual() {
    const uid = getUsuarioIdAtual();
    if (!uid) return '';

    try {
        const snap = await db.ref(`usuarios/${uid}/endereco`).once('value');
        const enderecoDb = snap.val();
        if (enderecoDb) {
            if (!window.usuarioLogado) window.usuarioLogado = { id: uid };
            window.usuarioLogado.endereco = enderecoDb;
            return formatarEnderecoEstruturado(enderecoDb);
        }
    } catch (erro) {
        console.warn('Falha ao carregar endereco do lojista no BD:', erro);
    }

    return formatarEnderecoEstruturado(window.usuarioLogado?.endereco);
}

function calcularFreteBaseServico({ servico, distanciaKm }) {
    const minimo = TAXA_MINIMA[servico] || TAXA_MINIMA.Standard;
    const taxaKm = TAXA_POR_KM[servico] || TAXA_POR_KM.Standard;
    const distancia = Number.isFinite(distanciaKm) ? Math.max(0, distanciaKm) : 0;
    if (distancia <= DISTANCIA_MINIMA_KM) return minimo;
    return Number((distancia * taxaKm).toFixed(2));
}

function calcularFreteEstimado({ servico, veiculo, distanciaKm }) {
    const base = calcularFreteBaseServico({ servico, distanciaKm });
    const mapaAjusteServico = AJUSTE_VEICULO_POR_SERVICO[servico] || AJUSTE_VEICULO_POR_SERVICO.Standard;
    const ajuste = mapaAjusteServico?.[veiculo] || 0;
    const minimoServico = TAXA_MINIMA[servico] || TAXA_MINIMA.Standard;
    return Number(Math.max(0, minimoServico, base + ajuste).toFixed(2));
}

function formatarDistancia(distanciaKm) {
    if (!Number.isFinite(distanciaKm)) return '--';
    return `${distanciaKm.toFixed(1).replace('.', ',')} km`;
}

function formatarDuracao(duracaoMin) {
    if (!Number.isFinite(duracaoMin)) return '--';
    if (duracaoMin < 60) return `${Math.max(1, Math.round(duracaoMin))} min`;
    const horas = Math.floor(duracaoMin / 60);
    const mins = Math.round(duracaoMin % 60);
    return mins ? `${horas}h ${mins}min` : `${horas}h`;
}

async function geocodificarEndereco(endereco) {
    if (!endereco) return null;
    if (!GOOGLE_MAPS_KEY) return null;
    const textoBase = endereco.toString().trim();
    try {
        const maps = await carregarGoogleMapsJs();
        const geocoder = new maps.Geocoder();
        const resultado = await new Promise((resolve) => {
            geocoder.geocode(
                {
                    address: `${textoBase}, Brasil`,
                    componentRestrictions: { country: 'BR' }
                },
                (results, status) => resolve({ results, status })
            );
        });
        const loc = resultado?.results?.[0]?.geometry?.location;
        if (resultado?.status === 'OK' && loc) {
            const geo = { lat: Number(loc.lat()), lon: Number(loc.lng()) };
            if (geoNoBrasil(geo)) return geo;
            setUltimoErroRota('Geocode por endereco retornou coordenada fora do Brasil.', { status: resultado?.status, textoBase, geo });
            return null;
        }
        setUltimoErroRota('Google Geocoding por endereco falhou.', { status: resultado?.status || null, textoBase });
        return null;
    } catch (erro) {
        setUltimoErroRota('Falha no Google Geocoding por endereco.', erro?.message || String(erro));
        return null;
    }
}

async function geocodificarCliente(cliente) {
    if (!cliente) return null;
    const campos = extrairCamposEnderecoCliente(cliente);
    const porCampos = await geocodificarPorCampos(campos).catch(() => null);
    if (porCampos) return porCampos;
    const enderecoCalculo = montarEnderecoParaCalculo(cliente, cliente.endereco || '');
    return await geocodificarEndereco(enderecoCalculo);
}

async function garantirGeoClienteSelecionado() {
    const cliente = getClienteById(clienteSelecionadoId);
    if (!cliente) return null;
    const geoAtual = getGeoCliente(cliente);
    const assinaturaAtual = assinaturaEndereco(extrairCamposEnderecoCliente(cliente));
    const precisaRegeocodificar =
        !geoAtual ||
        !geoNoBrasil(geoAtual) ||
        (!cliente.geoSig) || (cliente.geoSig !== assinaturaAtual);
    if (!precisaRegeocodificar) return geoAtual;

    const geo = await geocodificarCliente(cliente);
    if (!geo) return null;
    const geoNorm = normalizarGeo(geo);
    if (!geoNorm) return null;

    cliente.geo = geoNorm;
    cliente.geoSig = assinaturaAtual;
    await saveClientes();
    resumoRevisaoAtual.destinoGeo = geoNorm;
    return geoNorm;
}

function setUltimoErroRota(msg, detalhe = null) {
    ultimoErroRota = { msg, detalhe, at: Date.now() };
}

function limparUltimoErroRota() {
    ultimoErroRota = null;
}

function detalheRotaParaTexto(detalhe) {
    if (!detalhe) return '';
    if (typeof detalhe === 'string') return detalhe;
    try { return JSON.stringify(detalhe); } catch (_) { return String(detalhe); }
}

function carregarGoogleMapsJs() {
    if (!GOOGLE_MAPS_KEY) return Promise.reject(new Error('GOOGLE_MAPS_KEY ausente'));
    if (window.google?.maps?.DistanceMatrixService) return Promise.resolve(window.google.maps);
    if (googleMapsLoaderPromise) return googleMapsLoaderPromise;

    googleMapsLoaderPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&libraries=places`;
        script.async = true;
        script.defer = true;
        script.onload = () => resolve(window.google.maps);
        script.onerror = () => reject(new Error('Falha ao carregar Google Maps JS'));
        document.head.appendChild(script);
    });

    return googleMapsLoaderPromise;
}

async function estimarRotaGoogleMapsJs(origem, destino) {
    try {
        const maps = await carregarGoogleMapsJs();
        return await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 9000);
            const service = new maps.DistanceMatrixService();
            service.getDistanceMatrix(
                {
                    origins: [new maps.LatLng(origem.lat, origem.lon)],
                    destinations: [new maps.LatLng(destino.lat, destino.lon)],
                    travelMode: maps.TravelMode.DRIVING,
                    unitSystem: maps.UnitSystem.METRIC,
                    region: 'BR'
                },
                (response, status) => {
                    clearTimeout(timeout);
                    if (status !== 'OK') {
                        setUltimoErroRota('Google DistanceMatrix falhou.', { status, response });
                        return resolve(null);
                    }
                    const el = response?.rows?.[0]?.elements?.[0];
                    if (!el || el.status !== 'OK') {
                        setUltimoErroRota('Google DistanceMatrix retornou elemento invÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡lido.', { status, elementStatus: el?.status || null, response });
                        return resolve(null);
                    }
                    resolve({
                        distanciaKm: Number(el.distance.value) / 1000,
                        duracaoMin: Number(el.duration.value) / 60
                    });
                }
            );
        });
    } catch (_) {
        return null;
    }
}

function estimativaPlausivel(estimativa) {
    if (!estimativa) return false;
    const km = Number(estimativa.distanciaKm);
    const min = Number(estimativa.duracaoMin);
    if (!Number.isFinite(km) || !Number.isFinite(min)) return false;
    if (km <= 0 || min <= 0) return false;
    if (km > 120 || min > 300) return false;
    return true;
}

async function estimarRotaGoogle(origemEndereco, destinoEndereco, origemGeo = null, destinoGeo = null) {
    const origem = normalizarGeo(origemGeo) || await geocodificarEndereco(origemEndereco);
    const destino = normalizarGeo(destinoGeo) || await geocodificarEndereco(destinoEndereco);
    if (!origem || !destino) {
        setUltimoErroRota('Endereco de origem ou destino invalido/incompleto para roteamento.', {
            origemEndereco,
            destinoEndereco,
            origemGeo: origem || null,
            destinoGeo: destino || null
        });
        return null;
    }

    const estimativaJs = await estimarRotaGoogleMapsJs(origem, destino);
    if (estimativaJs && estimativaPlausivel(estimativaJs)) return estimativaJs;
    if (estimativaJs) {
        setUltimoErroRota('Rota calculada fora da faixa plausivel para entrega local.', {
            origem,
            destino,
            distanciaKm: estimativaJs.distanciaKm,
            duracaoMin: estimativaJs.duracaoMin
        });
    }
    return null;
}

async function garantirEstimativaAtual() {
    const destino = (resumoRevisaoAtual.destino || document.getElementById('card-endereco')?.innerText || '').trim();
    await obterEnderecoLojaAtual();
    const origem = formatarEnderecoLojaParaCalculo(window.usuarioLogado?.endereco) || '';
    let origemGeo = normalizarGeo(window.usuarioLogado?.endereco?.geo);
    const assinaturaOrigemAtual = assinaturaEndereco(window.usuarioLogado?.endereco || {});
    const origemGeoSig = window.usuarioLogado?.endereco?.geoSig || '';
    const origemPrecisaRegeocodificar =
        !origemGeo ||
        !geoNoBrasil(origemGeo) ||
        (!origemGeoSig) || (origemGeoSig !== assinaturaOrigemAtual);
    if (origemPrecisaRegeocodificar && window.usuarioLogado?.endereco) {
        const geoLoja = await geocodificarPorCampos(window.usuarioLogado.endereco).catch(() => null);
        origemGeo = normalizarGeo(geoLoja);
        if (origemGeo) {
            window.usuarioLogado.endereco.geo = origemGeo;
            window.usuarioLogado.endereco.geoSig = assinaturaOrigemAtual;
            const uid = getUsuarioIdAtual();
            if (uid) db.ref(`usuarios/${uid}/endereco`).update({ geo: origemGeo, geoSig: assinaturaOrigemAtual }).catch(() => {});
        }
    }
    let destinoGeo = resumoRevisaoAtual.destinoGeo;
    if (!destinoGeo) destinoGeo = await garantirGeoClienteSelecionado().catch(() => null);

    if (origem) resumoRevisaoAtual.origem = origem;
    if (destino) resumoRevisaoAtual.destino = destino;
    if (origemGeo) resumoRevisaoAtual.origemGeo = origemGeo;
    if (destinoGeo) resumoRevisaoAtual.destinoGeo = destinoGeo;

    if (!origem || !destino) return null;

    const estimativa = await estimarRotaEntrega(origem, destino, origemGeo, destinoGeo);
    if (estimativa) {
        resumoRevisaoAtual.distanciaKm = Number(estimativa.distanciaKm);
        resumoRevisaoAtual.duracaoMin = Number(estimativa.duracaoMin);
    } else {
        resumoRevisaoAtual.distanciaKm = null;
        resumoRevisaoAtual.duracaoMin = null;
    }
    return estimativa;
}

async function estimarRotaEntrega(origemEndereco, destinoEndereco, origemGeo = null, destinoGeo = null) {
    limparUltimoErroRota();
    if (!GOOGLE_MAPS_KEY) {
        setUltimoErroRota('Google Maps API key ausente.');
        return null;
    }
    try {
        const estimativa = await estimarRotaGoogle(origemEndereco, destinoEndereco, origemGeo, destinoGeo);
        if (estimativa) return estimativa;
        if (!ultimoErroRota) setUltimoErroRota('Google Maps nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o conseguiu calcular a rota com os endereÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§os informados.');
        return null;
    } catch (erro) {
        setUltimoErroRota('Falha ao consultar Google Maps.', erro?.message || String(erro));
        return null;
    }
}
function atualizarPrecoEstimadoAtual() {
    const servico = getServicoSelecionadoAtual();
    const distanciaKm = Number.isFinite(resumoRevisaoAtual.distanciaKm) ? resumoRevisaoAtual.distanciaKm : 0;
    const total = calcularFreteEstimado({ servico, veiculo: veiculoSelecionado, distanciaKm });
    resumoRevisaoAtual.servico = servico;
    resumoRevisaoAtual.veiculo = veiculoSelecionado;
    resumoRevisaoAtual.totalFrete = total;
    const inputValor = document.getElementById('input-valor');
    if (inputValor) inputValor.value = total.toFixed(2);
    const revTotal = document.getElementById('rev-total');
    if (revTotal) revTotal.innerText = precoParaMoeda(total);
    atualizarPrecosCardsVeiculo(servico, distanciaKm);
    atualizarDisponibilidadeVeiculos(distanciaKm);
}

function atualizarPrecosCardsVeiculo(servico, distanciaKm) {
    const mapa = {
        Patinete: 'v-patinete',
        Bicicleta: 'v-bike',
        Moto: 'v-moto',
        Carro: 'v-carro',
        Van: 'v-van'
    };

    Object.entries(mapa).forEach(([veiculo, id]) => {
        const card = document.getElementById(id);
        if (!card) return;
        const precoEl = card.querySelector('.veiculo-preco');
        if (!precoEl) return;
        const valor = calcularFreteEstimado({ servico, veiculo, distanciaKm });
        precoEl.innerText = precoParaMoeda(valor);
    });
}

function atualizarDisponibilidadeVeiculos(distanciaKm) {
    const distancia = Number.isFinite(distanciaKm) ? distanciaKm : 0;
    const precisaBloquearCurtos = distancia > DISTANCIA_MAX_CURTA;
    const mapa = {
        Patinete: 'v-patinete',
        Bicicleta: 'v-bike'
    };

    VEICULOS_CURTOS.forEach((veiculo) => {
        const id = mapa[veiculo];
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('disabled', precisaBloquearCurtos);
    });

    if (precisaBloquearCurtos && VEICULOS_CURTOS.includes(veiculoSelecionado)) {
        selecionarVeiculo('Moto', null);
    }
}

function selecionarVeiculo(tipo, preco) {
    const mapaIds = { Patinete: 'v-patinete', Bicicleta: 'v-bike', Moto: 'v-moto', Carro: 'v-carro', Van: 'v-van' };
    const alvo = document.getElementById(mapaIds[tipo]);
    if (alvo?.classList.contains('disabled')) return;
    ['v-patinete', 'v-bike', 'v-moto', 'v-carro', 'v-van'].forEach((id) => document.getElementById(id)?.classList.remove('active'));
    if (alvo) alvo.classList.add('active');
    veiculoSelecionado = tipo;
    if (preco) veiculoPrecoSelecionado = preco;
    atualizarPrecoEstimadoAtual();
    const servico = getServicoSelecionadoAtual();
    const distanciaKm = Number.isFinite(resumoRevisaoAtual.distanciaKm) ? resumoRevisaoAtual.distanciaKm : 0;
    veiculoPrecoSelecionado = precoParaMoeda(calcularFreteEstimado({ servico, veiculo: tipo, distanciaKm }));
}

async function irParaVeiculos() {
    setModalEnvioStep(2);
    await garantirEstimativaAtual();
    atualizarPrecoEstimadoAtual();
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function voltarParaDetalhes() {
    setModalEnvioStep(1);
}

// Revisao com distancia/tempo e valor estimado
async function irParaRevisao() {
    const nome = document.getElementById('card-nome').innerText;
    const enderecoDestinoExibicao = document.getElementById('card-endereco').innerText;
    const servico = document.querySelector('#modal-envio-detalhes .selection-grid .select-box.active strong')?.innerText || 'Standard';
    const tamanho = document.querySelector('#modal-envio-detalhes .selection-grid-3 .select-box.active strong')?.innerText || 'P';
    const estimativa = await garantirEstimativaAtual();
    const enderecoOrigem = resumoRevisaoAtual.origem || '';
    const enderecoDestino = (resumoRevisaoAtual.destino || enderecoDestinoExibicao || '').trim();
    const distanciaKm = Number.isFinite(resumoRevisaoAtual.distanciaKm) ? resumoRevisaoAtual.distanciaKm : null;
    const duracaoMin = Number.isFinite(resumoRevisaoAtual.duracaoMin) ? resumoRevisaoAtual.duracaoMin : null;
    const totalFrete = calcularFreteEstimado({ servico, veiculo: veiculoSelecionado, distanciaKm: Number.isFinite(distanciaKm) ? distanciaKm : 0 });
    resumoRevisaoAtual = {
        origem: enderecoOrigem,
        destino: enderecoDestino,
        origemGeo: resumoRevisaoAtual.origemGeo || null,
        destinoGeo: resumoRevisaoAtual.destinoGeo || null,
        distanciaKm,
        duracaoMin,
        totalFrete,
        servico,
        veiculo: veiculoSelecionado
    };
    document.getElementById('rev-nome').innerText = nome;
    document.getElementById('rev-end').innerText = enderecoDestinoExibicao;
    document.getElementById('rev-servico').innerText = servico;
    document.getElementById('rev-tamanho').innerText = `Pacote ${tamanho} - ${veiculoSelecionado}`;
    document.getElementById('rev-total').innerText = precoParaMoeda(totalFrete);
    const revDist = document.getElementById('rev-distancia'); if (revDist) revDist.innerText = formatarDistancia(distanciaKm);
    const revTempo = document.getElementById('rev-tempo'); if (revTempo) revTempo.innerText = formatarDuracao(duracaoMin);
    const revOrigem = document.getElementById('rev-origem'); if (revOrigem) revOrigem.innerText = enderecoOrigem || 'Defina o endereco da loja no Perfil';
    const inputValor = document.getElementById('input-valor'); if (inputValor) inputValor.value = totalFrete.toFixed(2);
    if (!estimativa) {
        const detalheTxt = detalheRotaParaTexto(ultimoErroRota?.detalhe);
        alert(`Endereco invalido ou incompleto para rota.\n\nRetorno da API:\n${detalheTxt || (ultimoErroRota?.msg || 'Sem detalhe de erro.')}`);
    }
    setModalEnvioStep(3);
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Ativa o link de Rotas no menu inferior
document.querySelector('.nav-item:nth-child(2)').onclick = () => navegar('view-rotas');

function abrirCriarRota() {
    // Aqui simulamos que existem 3 envios pendentes no seu banco/memÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ria
    const pendentes = [
        { id: 1, cliente: "Maria Silva", preco: 12.50, flash: false },
        { id: 2, cliente: "JoÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o Paulo", preco: 25.00, flash: true }, // Regra do Flash
        { id: 3, cliente: "Ana Beatriz", preco: 12.50, flash: false }
    ];

    const container = document.getElementById('selecao-envios');
    container.innerHTML = '';

    pendentes.forEach(envio => {
        const div = document.createElement('div');
        div.className = 'checkbox-envio';
        div.onclick = function() { 
            this.classList.toggle('selected');
            atualizarResumoRota();
        };
        div.innerHTML = `
            <div style="flex:1">
                <strong style="display:block">${envio.cliente}</strong>
                <span style="font-size:12px; color:var(--text-sub)">R$ ${envio.preco.toFixed(2)}</span>
                ${envio.flash ? '<span class="badge-flash">FLASH</span>' : ''}
            </div>
            <i data-lucide="circle"></i>
        `;
        container.appendChild(div);
    });
    
    document.getElementById('modal-criar-rota').classList.add('active');
    lucide.createIcons();
}

function fecharModalRota() {
    document.getElementById('modal-criar-rota').classList.remove('active');
}

function pagarComPix() {
    // Passo 3: SimulaÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o de Sucesso
    alert("Simulando Pagamento PIX...");
    setTimeout(() => {
        alert("Pagamento Confirmado!");
        fecharModalRota();
        navegar('view-rotas');
        // Aqui vocÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âª adicionaria a lÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³gica de inserir na lista de rotas reais
    }, 1500);
}

function atualizarResumoRota() {
    const selecionados = document.querySelectorAll('.checkbox-envio.selected').length;
    document.getElementById('rota-qtd').innerText = selecionados;
    document.getElementById('rota-total').innerText = "R$ " + (selecionados * 12.50).toFixed(2); // SimulaÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o de preÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§o
}

async function cadastrarReal() {
    const nome = document.getElementById('input-nome').value;
    const email = document.querySelector('#form-cadastrar input[type="email"]').value;
    const senha = document.getElementById('pass-cad').value;

    if (!nome || !email || !senha) return alert("Preencha todos os campos!");

    try {
        const cred = await auth.createUserWithEmailAndPassword(email, senha);
        
        // Salva os dados extras no Realtime Database
        await db.ref('usuarios/' + cred.user.uid).set({
            nome: nome,
            email: email,
            tipo: 'loja',
            criadoEm: Date.now()
        });

        alert("Conta criada com sucesso!");
        alternarAuth('entrar');
    } catch (error) {
        alert("Erro ao cadastrar: " + error.message);
    }
}    
// ===================== [AUTENTICA - fO - VERSÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢O ATIVA] =====================
async function loginReal() {
    const email = document.getElementById('email-login').value;
    const senha = document.getElementById('pass-login').value;

    if (!email || !senha) return alert("Preencha e-mail e senha!");

    try {
        const cred = await auth.signInWithEmailAndPassword(email, senha);
        const snapshot = await db.ref('usuarios/' + cred.user.uid).once('value');
        const dadosUser = snapshot.val();

        if (dadosUser) {
            usuarioLogado = { id: cred.user.uid, ...dadosUser };
            localStorage.setItem('flexa_session', JSON.stringify(usuarioLogado));
            
            // 1. Muda para a tela de Dash
            navegar('view-dash-loja');
            
            // 2. Preenche o Dashboard IMEDIATAMENTE (Parando o efeito de carregar)
            renderizarDashboard(usuarioLogado);
        }
    } catch (error) {
        alert("Erro ao entrar: " + error.message);
    }
}
// --- FUN - fO PARA IR AO PERFIL E CARREGAR DADOS ---
function irParaPerfil() {
    // 1. Ativa a visualizaÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o
    navegar('view-perfil');
    
    // 2. Preenche os dados se o usuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio estiver logado
    if (usuarioLogado) {
        document.getElementById('perfil-nome-loja').innerText = usuarioLogado.nome || "Minha Loja";
        document.getElementById('perfil-email-loja').innerText = usuarioLogado.email || "";
        
        if (usuarioLogado.logo) {
            document.getElementById('img-perfil-display').src = usuarioLogado.logo;
        }
    }
    
    // 3. Renderiza os ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âcones da Lucide que acabaram de aparecer
    lucide.createIcons();
}
// --- FUN - fO DE LOGOUT ---
// 1. FUN - fO PARA LOGOUT
function logoutReal() {
    if (confirm("Tem certeza que deseja sair?")) {
        firebase.auth().signOut().then(() => {
            alert("SessÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o encerrada!");
            // Limpa dados locais se houver e volta para a tela inicial
            localStorage.removeItem('flexa_user_data'); 
            window.location.reload(); // Recarrega para limpar o estado da aplicaÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o
        }).catch((error) => {
            alert("Erro ao sair: " + error.message);
        });
    }
}

// 2. MONITOR DE ESTADO DE AUTENTICA - fO (PersistÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âªncia)
// Esta funÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o roda automaticamente sempre que a pÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡gina abre ou o estado muda
// MONITOR DE ESTADO DE AUTENTICA - fO
firebase.auth().onAuthStateChanged((user) => {
    const tabbar = document.getElementById('main-nav');
    const splash = document.getElementById('splash-screen');

    if (user) {
        // UsuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio Logado
        firebase.database().ref('usuarios/' + user.uid).once('value')
            .then((snapshot) => {
                const userData = snapshot.val();
                if (userData) {
                    window.usuarioLogado = { id: user.uid, ...userData };
                    renderizarDashboard(userData);
                    navegar('view-dash-loja');
                    if (tabbar) tabbar.style.display = 'flex';
                    initClientes();
                }
                finalizarSplash(splash);
            }).catch(() => finalizarSplash(splash));
    } else {
        // UsuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio Deslogado
        navegar('view-inicio');
        if (tabbar) tabbar.style.display = 'none';
        initClientes();
        finalizarSplash(splash);
    }
});

document.addEventListener('DOMContentLoaded', () => {
    initClienteSearch();
    initClientes();
});

// ===================== [BLOCO LEGADO - N?fO REMOVER SEM VALIDAR] =====================
// FunÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o suave para esconder o splash
// VERSÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢O LEGADA DUPLICADA: mantida para histÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³rico. A versÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o ativa estÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ na definiÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o logo abaixo.
function finalizarSplash_legacy(elemento) {
    if (elemento) {
        elemento.style.opacity = '0';
        setTimeout(() => {
            elemento.style.display = 'none';
        }, 500); // Tempo da transiÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o CSS
    }
}

// FunÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o suave para esconder o splash
function finalizarSplash(elemento) {
    if (elemento) {
        elemento.style.opacity = '0';
        setTimeout(() => {
            elemento.style.display = 'none';
        }, 500); // Tempo da transiÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o CSS
    }
}

// 3. ATUALIZA - fO DA FUN - fO DE LOGIN EXISTENTE
// Certifique-se que sua funÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o loginReal() use o Firebase Auth corretamente
// O Firebase por padrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o jÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ usa 'local' persistence no browser.
// VERSÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢O LEGADA: mantida para auditoria. A versÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o ativa ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© a implementaÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o assÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­ncrona acima.
function loginReal_legacy() {
    const email = document.getElementById('email-login').value;
    const senha = document.querySelector('#pass-login').value;

    if (!email || !senha) {
        alert("Preencha todos os campos!");
        return;
    }

    firebase.auth().signInWithEmailAndPassword(email, senha)
        .then((userCredential) => {
            // O onAuthStateChanged acima cuidarÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ do redirecionamento
           
        })
        .catch((error) => {
            alert("Erro no login: " + error.message);
        });
}


// --- UPLOAD DE LOGO (BASE64) ---
function uploadLogo(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = async function(e) {
            const base64Image = e.target.result;
            document.getElementById('logo-perfil-display').src = base64Image;
            
            try {
                await db.ref('usuarios/' + usuarioLogado.id).update({ logo: base64Image });
                // Atualiza tambÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©m no Dashboard
                const logoDash = document.querySelector('.profile-img');
                if(logoDash) logoDash.src = base64Image;
                alert("Logo atualizada!");
            } catch (err) {
                alert("Erro ao salvar: " + err.message);
            }
        };
        reader.readAsDataURL(input.files[0]);
    }
}

function renderizarDashboard(user) {
    // 1. Define o container onde o conteÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âºdo serÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ injetado
    const container = document.getElementById('dash-loader-content');
    if (!container) return;

    // 2. Define a foto (Prioriza 'foto', depois 'logo', e por fim o placeholder)
    const fotoUrl = user.foto || user.logo || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100';
    

    // 4. Monta o HTML dinÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢mico
    container.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 25px;">
            <img src="${fotoUrl}" style="width: 45px; height: 45px; border-radius: 50%; object-fit: cover; border: 2px solid var(--brand-orange);">
            <div>
                <p style="color: var(--text-sub); font-size: 12px; margin: 0;">Bem-vindo,</p>
                <h2 style="font-size: 20px; font-weight: 800; margin: 0;">${user.nome || 'UsuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio'}! </h2>
            </div>
        </div>

        <div class="promo-banner">
            <h3>EstÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ com pressa?</h3>
            <p>Experimente o envio <b>Flash</b>.</p>
        </div>
        
        <div class="grid-stats">
            <div class="stat-card"><span>Entregas hoje</span><h4>0</h4></div>
            <div class="stat-card"><span>Em trÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢nsito</span><h4>0</h4></div>
        </div>

        <div class="filter-container">
            <div style="background: var(--brand-orange)" class="chip active">Todas</div>
            <div class="chip">Em rota</div>
            <div class="chip">Pendentes</div>
        </div>

        <div id="lista-vazia-dash" style="text-align:center; padding:20px; color:var(--text-sub);">
            <p>Nenhuma atividade recente.</p>
        </div>
    `;
    
    // 5. Renderiza os ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âcones do Lucide
    if(typeof lucide !== 'undefined') lucide.createIcons();
}
function buscarDadosDoBanco(uid) {
    // Usamos .on para que qualquer alteraÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o no banco reflita no app em tempo real
    db.ref('usuarios/' + uid).on('value', (snapshot) => {
        const dados = snapshot.val();
        if (dados) {
            // Salva os dados na memÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ria global do app
            window.usuarioLogado = { id: uid, ...dados }; 
            
            // Atualiza os elementos da tela de Perfil se eles existirem na pÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡gina
            const nomeDisplay = document.getElementById('perfil-nome-display');
            const instaDisplay = document.getElementById('perfil-insta-display');
            const fotoDisplay = document.getElementById('perfil-foto-display');

            if (nomeDisplay) nomeDisplay.innerText = dados.nome || 'UsuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio';
            if (instaDisplay) instaDisplay.innerText = dados.instagram || '@seuinsta';
            if (fotoDisplay) fotoDisplay.src = dados.foto || 'https://via.placeholder.com/110';
            
            // Renderiza o dash e navega (apenas na primeira carga)
            renderizarDashboard(dados); 
            // Se estiver na tela de login, manda para o dash
            if(document.getElementById('view-auth').classList.contains('active')) {
                navegar('view-dash-loja');
            }
        } else {
            navegar('view-auth'); 
        }
    });
}
// Adicione ou substitua no seu <script>
const overlayRota = document.getElementById('overlay-rota');
const sheetRota = document.getElementById('sheet-rota');

function openModal() {
    overlayRota.style.display = 'flex';
    // Pequeno delay para permitir a transiÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o CSS
    setTimeout(() => {
        sheetRota.classList.add('show');
    }, 10);
}

function closeModal() {
    sheetRota.classList.remove('show');
    setTimeout(() => {
        overlayRota.style.display = 'none';
    }, 400); // Tempo igual ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  transiÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o CSS
}

// Atualize a inicializaÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o dos ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âcones caso necessÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio
lucide.createIcons();

// Abrir Modal de Perfil e carregar dados atuais
function abrirModalPerfil() {
    const user = window.usuarioLogado;
    if (user) {
        document.getElementById('edit-nome').value = user.nome || '';
        document.getElementById('edit-instagram').value = user.instagram || '';
        document.getElementById('edit-whatsapp').value = user.whatsapp || '';
        if (user.foto) document.getElementById('edit-preview-img').src = user.foto;
    }
    
    const overlay = document.getElementById('overlay-perfil');
    const sheet = document.getElementById('sheet-perfil');
    overlay.style.display = 'flex';
    setTimeout(() => sheet.style.transform = 'translateY(0)', 10);
}

function fecharModalPerfil() {
    const sheet = document.getElementById('sheet-perfil');
    sheet.style.transform = 'translateY(100%)';
    setTimeout(() => document.getElementById('overlay-perfil').style.display = 'none', 400);
}

// Preview da imagem selecionada
function previewImagem(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('edit-preview-img').src = e.target.result;
        }
        reader.readAsDataURL(input.files[0]);
    }
}

// Salvar no Firebase
function salvarPerfil() {
    // 1. Verifica se temos o ID do usuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio
    const uid = window.usuarioLogado ? window.usuarioLogado.id : (firebase.auth().currentUser ? firebase.auth().currentUser.uid : null);
    
    if (!uid) {
        alert("Erro: UsuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o identificado. Tente fazer login novamente.");
        return;
    }

    const novosDados = {
        nome: document.getElementById('edit-nome').value,
        instagram: document.getElementById('edit-instagram').value,
        whatsapp: document.getElementById('edit-whatsapp').value,
        foto: document.getElementById('edit-preview-img').src // Imagem em Base64
    };

    // 2. Salva no Firebase
    db.ref('usuarios/' + uid).update(novosDados)
        .then(() => {
            // 3. Atualiza o objeto na memÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ria do app
            window.usuarioLogado = { ...window.usuarioLogado, ...novosDados };
            
            // 4. Atualiza os textos na tela de perfil usando os IDs corretos
            const nomeDisp = document.getElementById('perfil-nome-display');
            const instaDisp = document.getElementById('perfil-insta-display');
            const fotoDisp = document.getElementById('perfil-foto-display');

            if (nomeDisp) nomeDisp.innerText = novosDados.nome;
            if (instaDisp) instaDisp.innerText = novosDados.instagram;
            if (fotoDisp) fotoDisp.src = novosDados.foto;
            
            fecharModalPerfil();
            
            // 5. Renderiza novamente os ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âcones (importante para o ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âcone do Insta)
            if(typeof lucide !== 'undefined') lucide.createIcons();
            
            alert("Perfil atualizado com sucesso!");
        })
        .catch(error => {
            console.error("Erro ao salvar:", error);
            alert("Erro ao salvar: " + error.message);
        });
}

// 1. ABRE O MODAL E PREENCHE OS DADOS SE EXISTIREM
function abrirModalEndereco() {
    const modal = document.getElementById('modal-endereco');
    if (!modal) return;
    
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('is-open'));
    
    // Atualiza ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âcones Lucide (como o ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âcone de fechar e map-pin)
    if(typeof lucide !== 'undefined') lucide.createIcons();
    
    // Tenta pegar os dados salvos no objeto global
    const end = window.usuarioLogado?.endereco;
    if (end) {
        document.getElementById('end-cep').value = end.cep || '';
        document.getElementById('end-rua').value = end.rua || '';
        document.getElementById('end-num').value = end.num || '';
        document.getElementById('end-bairro').value = end.bairro || '';
        document.getElementById('end-cidade').value = end.cidade || '';
        document.getElementById('end-uf').value = end.uf || '';
        document.getElementById('end-comp').value = end.comp || '';
        const cep = formatarCep(end.cep || '');
        const faltandoCamposBase = !end.rua || !end.bairro || !end.cidade || !end.uf;
        if (cep && faltandoCamposBase) buscarCEP(cep, { silencioso: true });
    }
}

// 2. FECHA O MODAL
function fecharModalEndereco() {
    const modal = document.getElementById('modal-endereco');
    if (!modal) return;
    modal.classList.remove('is-open');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 250);
}

// 3. BUSCA CEP (VERSÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢O ?sNICA E COMPLETA)
async function buscarCEP(valor, opts = {}) {
    const silencioso = Boolean(opts?.silencioso);
    const cep = valor.replace(/\D/g, '');
    if (cep.length !== 8) return null;
    if (cep === ultimoCepLojaConsultado && document.getElementById('end-rua')?.value) return null;
    ultimoCepLojaConsultado = cep;

    // Feedback visual nos campos
    const campoRua = document.getElementById('end-rua');
    campoRua.placeholder = "Buscando endereÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§o...";

    try {
        const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
        const dados = await res.json();
        if (!dados.erro) {
            document.getElementById('end-rua').value = dados.logradouro || '';
            document.getElementById('end-bairro').value = dados.bairro || '';
            document.getElementById('end-cidade').value = dados.localidade || '';
            document.getElementById('end-uf').value = dados.uf || '';
            document.getElementById('end-num').focus();
            return dados;
        }
        if (!silencioso) alert("CEP nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o encontrado.");
    } catch (_) {
        if (!silencioso) alert("Erro ao buscar CEP. Verifique sua conexÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o.");
    } finally {
        campoRua.placeholder = "Nome da rua";
    }
    return null;
}

function agendarBuscaCepLoja(valor) {
    const cep = (valor || '').replace(/\D/g, '');
    if (cepLojaDebounceTimer) clearTimeout(cepLojaDebounceTimer);
    if (cep.length !== 8) return;
    cepLojaDebounceTimer = setTimeout(() => {
        buscarCEP(cep, { silencioso: true });
    }, 260);
}

document.getElementById('end-cep')?.addEventListener('input', function (e) {
    agendarBuscaCepLoja(e.target.value);
});

// 4. SALVA NO FIREBASE
async function salvarEndereco() {
    // Identifica o UID de forma segura
    const uid = window.usuarioLogado?.id || (firebase.auth().currentUser ? firebase.auth().currentUser.uid : null);
    
    if (!uid) {
        alert("Erro: UsuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o identificado.");
        return;
    }

    const endereco = {
        cep: formatarCep(document.getElementById('end-cep').value),
        rua: (document.getElementById('end-rua').value || '').trim(),
        num: (document.getElementById('end-num').value || '').trim(),
        bairro: (document.getElementById('end-bairro').value || '').trim(),
        cidade: (document.getElementById('end-cidade').value || '').trim(),
        uf: normalizarUf(document.getElementById('end-uf').value),
        comp: (document.getElementById('end-comp').value || '').trim()
    };
    endereco.estado = endereco.uf;

    try {
        const geo = await geocodificarPorCampos(endereco);
        if (geo) {
            endereco.geo = normalizarGeo(geo);
            endereco.geoSig = assinaturaEndereco(endereco);
        }
    } catch (_) {
        // segue sem travar salvamento do endereco
    }

    // Salva no nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â³ 'endereco' dentro do perfil do usuÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡rio
    db.ref('usuarios/' + uid + '/endereco').update(endereco)
        .then(() => {
            // Atualiza o objeto local para refletir as mudanÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§as sem recarregar
            if (!window.usuarioLogado) window.usuarioLogado = {};
            window.usuarioLogado.endereco = endereco;
            
            fecharModalEndereco();
            alert("EndereÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§o atualizado com sucesso!");
        })
        .catch(error => {
            console.error("Erro ao salvar endereÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§o:", error);
            alert("Erro ao salvar: " + error.message);
        });
}







/* ===== New Envio Home + Client Sheet ===== */
function abrirSeletorCliente() {
    const modal = document.getElementById('modal-seletor-cliente');
    if (!modal) return;
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('is-open'));
    renderClientesSelector(document.getElementById('buscar-cliente')?.value || '');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function fecharSeletorCliente() {
    const modal = document.getElementById('modal-seletor-cliente');
    if (!modal) return;
    fecharSwipesClientesSelector();
    modal.classList.remove('is-open');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 220);
}

function abrirNovoClientePeloSeletor() {
    fecharSeletorCliente();
    setTimeout(() => abrirNovoCliente(), 180);
}

let selectorTouchStartX = 0;
let selectorActiveCard = null;
let selectorActiveRow = null;
let clienteAcaoAtualId = null;
let clientePendenteExclusao = null;

function fecharSwipesClientesSelector(exceptId = null) {
    document.querySelectorAll('.selector-swipe-row').forEach((row) => {
        if (exceptId && row.id === exceptId) return;
        const card = row.querySelector('.selector-cliente-card');
        if (card) card.style.transform = 'translateX(0)';
        row.classList.remove('is-open');
    });
}

function handleSelectorTouchStart(e) {
    selectorTouchStartX = e.touches[0].clientX;
    selectorActiveCard = e.currentTarget;
    selectorActiveRow = selectorActiveCard.closest('.selector-swipe-row');
    selectorActiveCard.style.transition = 'none';
    selectorActiveCard.dataset.cancelClick = '0';
    if (selectorActiveRow) fecharSwipesClientesSelector(selectorActiveRow.id);
}

function handleSelectorTouchMove(e) {
    if (!selectorActiveCard) return;
    const touchX = e.touches[0].clientX;
    const diff = touchX - selectorTouchStartX;
    if (Math.abs(diff) > 8) selectorActiveCard.dataset.cancelClick = '1';
    if (diff < 0) {
        const limitado = Math.max(diff, -148);
        selectorActiveCard.style.transform = `translateX(${limitado}px)`;
    }
}

function handleSelectorTouchEnd(e) {
    if (!selectorActiveCard || !selectorActiveRow) return;
    selectorActiveCard.style.transition = 'transform 0.22s ease';
    const touchX = e.changedTouches[0].clientX;
    const diff = touchX - selectorTouchStartX;
    if (diff < -58) {
        selectorActiveCard.style.transform = 'translateX(-148px)';
        selectorActiveRow.classList.add('is-open');
    } else {
        selectorActiveCard.style.transform = 'translateX(0)';
        selectorActiveRow.classList.remove('is-open');
    }
    selectorActiveCard = null;
    selectorActiveRow = null;
}

function handleSelectorCardClick(event, id, nome, endereco, whats) {
    const card = event.currentTarget;
    const row = card.closest('.selector-swipe-row');
    if (card.dataset.cancelClick === '1') {
        card.dataset.cancelClick = '0';
        return;
    }
    if (row?.classList.contains('is-open')) {
        fecharSwipesClientesSelector();
        return;
    }
    selecionarClienteNoSheet(id, nome, endereco, whats);
}

function abrirModalAcoesCliente(id) {
    const cliente = clientes.find((c) => c.id === id);
    if (!cliente) return;
    clienteAcaoAtualId = id;
    const modal = document.getElementById('modal-acoes-cliente');
    const title = document.getElementById('cliente-actions-name');
    if (!modal || !title) return;
    title.innerText = cliente.nome || 'Cliente';
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('is-open'));
}

function fecharModalAcoesCliente() {
    const modal = document.getElementById('modal-acoes-cliente');
    if (!modal) return;
    modal.classList.remove('is-open');
    setTimeout(() => { modal.style.display = 'none'; }, 220);
}

function abrirHistoricoDoClienteAtual() {
    if (!clienteAcaoAtualId) return;
    const id = clienteAcaoAtualId;
    clienteAcaoAtualId = null;
    fecharModalAcoesCliente();
    setTimeout(() => verHistoricoCliente(id), 150);
}

function excluirClienteAtualComConfirmacao() {
    if (!clienteAcaoAtualId) return;
    const id = clienteAcaoAtualId;
    clienteAcaoAtualId = null;
    fecharModalAcoesCliente();
    excluirClienteComDesfazer(id);
}

function atualizarListasClientesUI() {
    renderClientes(document.getElementById('buscar-cliente')?.value || '');
    renderClientesSelector(document.getElementById('buscar-cliente')?.value || '');
    renderEnviosHome();
}

function excluirClienteComDesfazer(clienteId) {
    const idx = clientes.findIndex((c) => c.id === clienteId);
    if (idx < 0) return;

    clientePendenteExclusao = { cliente: clientes[idx], idx };
    clientes.splice(idx, 1);
    saveClientes();
    atualizarListasClientesUI();
    fecharSwipesClientesSelector();

    const toastAnterior = document.getElementById('toast-desfazer');
    if (toastAnterior) {
        clearInterval(toastAnterior.dataset.intervalId);
        toastAnterior.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'undo-toast';
    toast.id = 'toast-desfazer';

    let segundosRestantes = 10;
    toast.innerHTML = `
        <div class="undo-content">
            <div class="undo-timer" id="timer-count">${segundosRestantes}</div>
            <span style="font-size: 14px;">Contato excluÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­do</span>
        </div>
        <div class="undo-btn">Desfazer</div>
    `;
    toast.onclick = () => desfazerExclusaoCliente();
    document.body.appendChild(toast);

    const interval = setInterval(() => {
        segundosRestantes--;
        const timerElement = document.getElementById('timer-count');
        if (timerElement) timerElement.innerText = segundosRestantes;
        if (segundosRestantes <= 0) {
            clearInterval(interval);
            clientePendenteExclusao = null;
            fecharToastSuave(toast);
        }
    }, 1000);

    toast.dataset.intervalId = interval;
}

function desfazerExclusaoCliente() {
    const toast = document.getElementById('toast-desfazer');
    if (toast) {
        clearInterval(toast.dataset.intervalId);
        toast.remove();
    }
    if (!clientePendenteExclusao) return;
    const { cliente, idx } = clientePendenteExclusao;
    const pos = Math.max(0, Math.min(idx, clientes.length));
    clientes.splice(pos, 0, cliente);
    saveClientes();
    atualizarListasClientesUI();
    clientePendenteExclusao = null;
}

function renderClientesSelector(filtro = '') {
    const container = document.getElementById('clientes-sheet-list');
    if (!container) return;

    const filtroTexto = normalizarTexto(filtro);
    const filtroNumero = (filtro || '').replace(/\D/g, '');

    const lista = clientes.filter((c) => {
        const texto = normalizarTexto(`${c.nome} ${c.endereco} ${c.whatsapp}`);
        if (!filtroTexto) return true;
        if (filtroNumero && c.whatsapp) {
            return c.whatsapp.replace(/\D/g, '').includes(filtroNumero);
        }
        return texto.includes(filtroTexto);
    }).sort((a, b) => {
        const fa = a.frequente ? 1 : 0;
        const fb = b.frequente ? 1 : 0;
        if (fb !== fa) return fb - fa;
        return (a.nome || '').localeCompare(b.nome || '');
    });

    if (!lista.length) {
        container.innerHTML = '<div class="selector-empty">Nenhum cliente encontrado.</div>';
        return;
    }

    container.innerHTML = lista.map((c) => {
        const badge = c.frequente ? '<span class="badge-freq selector-freq-badge">Frequente</span>' : '';
        const iniciais = (c.nome || 'C').split(' ').filter(Boolean).map((n) => n[0]).join('').slice(0, 2).toUpperCase();
        const foto = c.foto || c.avatar || '';
        const avatar = foto
            ? `<img class="selector-avatar-img" src="${foto}" alt="${c.nome || 'Cliente'}">`
            : `<span class="selector-avatar-iniciais">${iniciais}</span>`;

        const nomeEsc = (c.nome || '').replace(/'/g, "\\'");
        const endEsc = (c.endereco || '').replace(/'/g, "\\'");
        const whatsEsc = (c.whatsapp || '').replace(/'/g, "\\'");
        return `
            <div class="selector-swipe-row" id="selector-row-${c.id}">
                <div class="selector-swipe-actions">
                    <button type="button" class="selector-action-more" onclick="event.stopPropagation(); abrirModalAcoesCliente('${c.id}')">Mais</button>
                    <button type="button" class="selector-action-edit" onclick="event.stopPropagation(); abrirEditarCliente('${c.id}')">Editar</button>
                </div>
                <button type="button"
                        class="selector-cliente-card"
                        data-client-id="${c.id}"
                        ontouchstart="handleSelectorTouchStart(event)"
                        ontouchmove="handleSelectorTouchMove(event)"
                        ontouchend="handleSelectorTouchEnd(event)"
                        onclick="handleSelectorCardClick(event, '${c.id}', '${nomeEsc}', '${endEsc}', '${whatsEsc}')">
                    ${badge}
                    <div class="selector-avatar">${avatar}</div>
                    <div class="selector-info">
                        <strong class="selector-nome">${c.nome}</strong>
                        <span class="selector-endereco">${formatEnderecoDisplay(c.endereco)}</span>
                        <span class="selector-whatsapp">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 448 512" fill="currentColor"><path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.1 0-65.6-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-5.5-2.8-23.2-8.5-44.2-27.1-16.4-14.6-27.4-32.7-30.6-38.2-3.2-5.6-.3-8.6 2.5-11.3 2.5-2.5 5.6-6.5 8.3-9.7 2.8-3.3 3.7-5.6 5.6-9.3 1.9-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 13.2 5.8 23.5 9.2 31.5 11.8 13.3 4.2 25.4 3.6 35 2.2 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z"/></svg>
                            ${c.whatsapp}
                        </span>
                    </div>
                </button>
            </div>
        `;
    }).join('');
}
function selecionarClienteNoSheet(id, nome, endereco, whats) {
    fecharSeletorCliente();
    setTimeout(() => {
        irParaPasso2(id, nome, endereco, whats);
    }, 200);
}

function coletarEnviosDaBase() {
    const envios = [];
    clientes.forEach((c) => {
        const historico = Array.isArray(c.historico) ? c.historico : [];
        historico.forEach((h, idx) => {
            envios.push({
                id: h.id || `envio-${c.id}-${idx}`,
                codigo: h.id ? h.id.replace('envio-', '').slice(-4) : String(idx + 1).padStart(4, '0'),
                destinatario: c.nome || 'Cliente',
                endereco: formatEnderecoDisplay(c.endereco || ''),
                status: (h.servico || '').toLowerCase().includes('flash') ? 'Expresso' : 'Pendente',
                valor: Number.isFinite(Number(h.valorFrete)) ? Number(h.valorFrete) : parseMoedaParaNumero(h.valor || 0),
                servico: h.servico || 'Standard',
                veiculo: h.veiculo || 'Moto',
                distanciaKm: Number.isFinite(Number(h.distanciaKm)) ? Number(h.distanciaKm) : null,
                duracaoMin: Number.isFinite(Number(h.duracaoMin)) ? Number(h.duracaoMin) : null,
                criadoEm: h.criadoEm || Date.now()
            });
        });
    });

    if (!envios.length) return [];

    return envios.sort((a, b) => b.criadoEm - a.criadoEm);
}

function renderEnviosHome() {
    const container = document.getElementById('envios-list');
    if (!container) return;

    const envios = coletarEnviosDaBase();
    if (!envios.length) {
        container.innerHTML = `
            <div class="envios-empty">
                <h3>Voce ainda nao tem pacotes para enviar</h3>
                <button type="button" class="envios-empty-btn" onclick="abrirSeletorCliente()">Criar envio</button>
            </div>
        `;
        return;
    }

    container.innerHTML = envios.map((envio) => {
        const data = new Date(envio.criadoEm || Date.now()).toLocaleDateString('pt-BR');
        const valor = Number(envio.valor || 0).toFixed(2).replace('.', ',');
        const distanciaTxt = Number.isFinite(envio.distanciaKm) ? `${envio.distanciaKm.toFixed(1).replace('.', ',')} km` : '--';
        const tempoTxt = Number.isFinite(envio.duracaoMin) ? `${Math.max(1, Math.round(envio.duracaoMin))} min` : '--';
        return `
            <div class="envio-swipe-container" id="envio-wrap-${envio.id}">
                <div class="envio-swipe-delete">
                    <button type="button" onclick="confirmarExclusaoEnvio('${envio.id}')">Excluir</button>
                </div>
                <article class="envio-item-card envio-swipe-content"
                         id="envio-card-${envio.id}"
                         data-envio-id="${envio.id}"
                         ontouchstart="handleEnvioTouchStart(event)"
                         ontouchmove="handleEnvioTouchMove(event)"
                         ontouchend="handleEnvioTouchEnd(event)">
                    <button class="envio-delete-btn" type="button" onclick="confirmarExclusaoEnvio('${envio.id}'); event.stopPropagation();">
                        <i data-lucide="trash-2" size="14"></i>
                    </button>
                    <div class="envio-item-top">
                        <div>
                            <div class="envio-item-kicker">Pedido #${envio.codigo}</div>
                            <div class="envio-item-name">${envio.destinatario}</div>
                        </div>
                        <div>
                            <div class="envio-item-status">${envio.status}</div>
                        </div>
                    </div>
                    <div class="envio-item-meta">${envio.endereco}</div>
                    <div class="envio-item-route">${envio.servico} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ ${envio.veiculo} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ ${distanciaTxt} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ ${tempoTxt}</div>
                    <div class="envio-item-top" style="margin-bottom:0; align-items:flex-end; margin-top:8px;">
                        <div class="envio-item-meta">Atualizado ${data}</div>
                        <div>
                            <div class="envio-item-price">R$ ${valor}</div>
                        </div>
                    </div>
                </article>
            </div>
        `;
    }).join('');

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function excluirEnvioPorId(envioId) {
    for (const cliente of clientes) {
        const historico = Array.isArray(cliente.historico) ? cliente.historico : [];
        const idx = historico.findIndex((h) => h.id === envioId);
        if (idx >= 0) {
            historico.splice(idx, 1);
            cliente.historico = historico;
            cliente.envios = Math.max(0, Number(cliente.envios || 0) - 1);
            return true;
        }
    }
    return false;
}

function confirmarExclusaoEnvio(envioId) {
    if (!envioId) return;
    const ok = window.confirm('Deseja excluir este envio?');
    if (!ok) return;
    const removido = excluirEnvioPorId(envioId);
    if (!removido) {
        alert('NÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â£o foi possÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â­vel excluir este envio.');
        return;
    }
    saveClientes();
    renderEnviosHome();
}

let envioTouchStartX = 0;
let envioCardAtivo = null;

function handleEnvioTouchStart(e) {
    envioCardAtivo = e.currentTarget;
    envioTouchStartX = e.touches[0].clientX;
    fecharSwipesEnvio(envioCardAtivo.id);
}

function handleEnvioTouchMove(e) {
    if (!envioCardAtivo) return;
    const diff = e.touches[0].clientX - envioTouchStartX;
    if (diff > 0) {
        envioCardAtivo.style.transform = 'translateX(0)';
        return;
    }
    const limitado = Math.max(diff, -92);
    envioCardAtivo.style.transform = `translateX(${limitado}px)`;
}

function handleEnvioTouchEnd(e) {
    if (!envioCardAtivo) return;
    const diff = e.changedTouches[0].clientX - envioTouchStartX;
    envioCardAtivo.style.transition = 'transform 0.22s ease';
    envioCardAtivo.style.transform = diff < -52 ? 'translateX(-92px)' : 'translateX(0)';
    setTimeout(() => {
        if (envioCardAtivo) envioCardAtivo.style.transition = '';
    }, 220);
    envioCardAtivo = null;
}

function fecharSwipesEnvio(exceptId = null) {
    document.querySelectorAll('.envio-swipe-content').forEach((el) => {
        if (exceptId && el.id === exceptId) return;
        el.style.transform = 'translateX(0)';
        el.style.transition = 'transform 0.2s ease';
        setTimeout(() => { el.style.transition = ''; }, 220);
    });
}

const _initClientesOriginal = initClientes;
initClientes = async function initClientesNovaHome() {
    await _initClientesOriginal();
    renderClientesSelector(document.getElementById('buscar-cliente')?.value || '');
    renderEnviosHome();
};

const _confirmarEnvioFinalOriginal = confirmarEnvioFinal;
confirmarEnvioFinal = function confirmarEnvioFinalNovaHome() {
    _confirmarEnvioFinalOriginal();
    renderEnviosHome();
};

const _abrirNovoClienteOriginal = abrirNovoCliente;
abrirNovoCliente = function abrirNovoClienteComSheet() {
    fecharSeletorCliente();
    _abrirNovoClienteOriginal();
};

renderClientes = function renderClientesRedirect(filtro = '') {
    renderClientesSelector(filtro);
};



