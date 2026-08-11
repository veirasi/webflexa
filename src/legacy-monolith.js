// ============================================================================
// STAGE 2 do refactor: os helpers puros/genéricos abaixo já saíram deste
// arquivo e moram em core/*. Este import existe só pra manter todo o resto
// (ainda não fatiado) funcionando sem mudar nenhum call-site por enquanto —
// vai encolher a cada novo domínio extraído nas próximas etapas.
// ============================================================================
import { db, auth } from './core/firebase.js';
import {
  normalizarTexto, formatEnderecoDisplay, normalizarUf, formatarCep,
  montarEnderecoCliente, assinaturaEndereco, geoNoBrasil, extrairCamposEnderecoCliente,
  montarEnderecoParaCalculo, normalizarGeo, parseMoedaParaNumero, precoParaInput,
  precoParaMoeda, formatarEnderecoEstruturado, formatarEnderecoLojaParaCalculo,
  formatarEnderecoLojaParaRota, formatarEnderecoClienteParaRota, formatarDistancia,
  formatarDuracao,
} from './core/format.js';
import { escapeHtml, escapeHtmlChat, escaparHtmlMarketplace, sanitizeFirebaseKey } from './core/sanitize.js';
import {
  AVATAR_PLACEHOLDER_SRC, aplicarFotoComPlaceholder, normalizarHandleInstagram,
  aplicarLinkInstagram, obterLayerSnackbar, notificarApp, notificarErro, notificarSucesso,
  abrirModalSheetGenerico, fecharModalSheetGenerico,
} from './core/ui-sheet.js';

// Variável para controle do usuário logado
let usuarioLogado = null;
let envioStepAtual = 1;
let clientes = [];
let clienteEmEdicaoId = null;
let clienteSelecionadoId = null;
let cepLojaDebounceTimer = null;
let cepClienteDebounceTimer = null;
let ultimoCepLojaConsultado = '';
let ultimoErroRota = null;
let googleMapsLoaderPromise = null;
const FORCAR_REGEOCODIFICACAO = true;
let envioDetalheAtualId = null;

let mostrarTodasRotasHome = false;
let rotasHomeCache = [];
let rotaDetalheAtual = null;
let rotaDetalhePacotes = [];
let rotaDetalhePaginaAtual = 0;
let rotaDetalheSwipeStartX = 0;
let rotaDetalheSwipeEndX = 0;
// Sheet rota entregador com paginação por pacote
let rotaEntSheetPacotes = [];
let rotaEntSheetIndex = 0;
let rotaEntSheetRotaAtual = null;
let rotaEntSheetTouchStartX = 0;
let rotaEntSheetTouchStartY = 0;
let lojistaLogoCache = {};
let rotaEntregadorProgresso = {};
let rotaSwipeStartX = 0;
let rotaSwipeCardAtivo = null;
let filtroEnviosAtivo = 'TODOS';
let filtroRotasAtivo = 'BUSCANDO';
let dashboardRotasSincronizadas = false;
let adminUsersCache = null;
let modoAdmin = false;
let presencaRef = null;
let presencaInterval = null;
let adminChartsState = null;
let entregadorHomeListenerRef = null;
let entregadorHomeListenerCb = null;
let entregadorHomeListenerUid = null;
let entregadorHomeCache = null;
let entregadorMetaDiaCache = null;
let rotasMarketplaceEntregadorCache = [];
let marketplaceEntregadorListenerRef = null;
let marketplaceEntregadorListenerCb = null;
let filtroRotaEntregadorOrigem = 'TODAS';
let filtroRotaEntregadorDestino = 'TODAS';
let modoRotasEntregador = 'HISTORICO';

function mostrarTelaAdminLogin() {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const nav = document.getElementById('main-nav');
    if (nav) nav.style.display = 'none';
    const v = document.getElementById('view-admin-login');
    if (v) v.classList.add('active');
}

function mostrarTelaAdminDashboard() {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const nav = document.getElementById('main-nav');
    if (nav) nav.style.display = 'none';
    const v = document.getElementById('view-admin-dashboard');
    if (v) v.classList.add('active');
    switchAdminTab('overview');
}

function mostrarTelaAdminSignup() {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const nav = document.getElementById('main-nav');
    if (nav) nav.style.display = 'none';
    const v = document.getElementById('view-admin-signup');
    if (v) v.classList.add('active');
}

function ativarModoAdminSeNecessario() {
    const path = (window.location.pathname || '').toLowerCase();
    const hash = (window.location.hash || '').toLowerCase();
    if (path.includes('/admin') || hash.includes('/admin')) {
        modoAdmin = true;
        document.body.classList.add('admin-mode');
        mostrarTelaAdminLogin();
    }
}

document.addEventListener('DOMContentLoaded', ativarModoAdminSeNecessario);
window.addEventListener('hashchange', ativarModoAdminSeNecessario);
// garante detecção antes do primeiro onAuthStateChanged
ativarModoAdminSeNecessario();

function getUsuarioIdAtual() {
    return usuarioLogado?.id || (firebase.auth().currentUser ? firebase.auth().currentUser.uid : null);
}

function obterTipoUsuarioAtual() {
    const tipoRaw = normalizarTexto(window.usuarioLogado?.tipo || usuarioLogado?.tipo || 'loja');
    if (tipoRaw === 'master' || tipoRaw === 'admin') return 'master';
    return (tipoRaw === 'entregador' || tipoRaw === 'entrega') ? 'entregador' : 'loja';
}

function usuarioEhEntregador() {
    return obterTipoUsuarioAtual() === 'entregador';
}

function usuarioEhMaster() {
    return obterTipoUsuarioAtual() === 'master';
}

function switchAdminTab(tab) {
    document.querySelectorAll('.admin-nav-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.admin-tab').forEach((pane) => {
        const ativo = pane.dataset.tab === tab;
        pane.classList.toggle('active', ativo);
        pane.style.display = ativo ? 'block' : 'none';
    });
    const main = document.querySelector('.admin-main');
    if (main) main.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (tab === 'packages') adminCarregarPacotes();
    if (tab === 'routes') renderDashboardMaster();
    if (tab === 'database') adminListTables();
}

function telaInicialPorTipoUsuario(tipo) {
    return tipo === 'entregador' ? 'view-dash-entregador' : 'view-dash-loja';
}

function telaPerfilPorTipoUsuario(tipo) {
    return tipo === 'entregador' ? 'view-perfil-entregador' : 'view-perfil';
}

function aplicarPermissoesPorTipoUsuario() {
    const tipo = obterTipoUsuarioAtual();
    const ehEntregador = tipo === 'entregador';

    if (document.body) {
        document.body.classList.toggle('usuario-entregador', ehEntregador);
    }

    const tituloRotas = document.getElementById('rotas-main-title');
    if (tituloRotas) {
        tituloRotas.innerText = ehEntregador ? 'Rotas disponíveis' : 'Rotas aguardando';
    }
}


function preencherPerfilLojista() {
    const dados = window.usuarioLogado || {};
    const nomeEl = document.getElementById('perfil-nome-display');
    const instaEl = document.getElementById('perfil-insta-display');
    const fotoEl = document.getElementById('perfil-foto-display');

    if (nomeEl) nomeEl.innerText = dados.nome || 'Usuário';
    aplicarLinkInstagram(instaEl, dados.instagram || '');
    aplicarFotoComPlaceholder(fotoEl, dados.foto || '');
}

function preencherPerfilEntregador() {
    const dados = window.usuarioLogado || {};
    const nomeEl = document.getElementById('perfil-entregador-nome-display');
    const instaEl = document.getElementById('perfil-entregador-insta-display');
    const fotoEl = document.getElementById('perfil-entregador-foto-display');
    const cnhEl = document.getElementById('perfil-entregador-cnh-display');

    if (nomeEl) nomeEl.innerText = dados.nome || 'Entregador';
    aplicarLinkInstagram(instaEl, dados.instagram || '');
    aplicarFotoComPlaceholder(fotoEl, dados.foto || '');
    if (cnhEl) cnhEl.innerText = (dados.cnh || '--').toString();
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
    return [];
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
            const restricoes = { country: 'BR' };
            if (cep) restricoes.postalCode = cep;
            if (cidade) restricoes.locality = cidade;
            if (estado) restricoes.administrativeArea = estado;
            geocoder.geocode(
                {
                    address: enderecoGoogle,
                    componentRestrictions: restricoes
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

async function initClientes() {
    clientes = await loadClientes();
    renderClientes(document.getElementById('buscar-cliente')?.value || '');
}

function initClienteSearch() {
    const input = document.getElementById('buscar-cliente');
    if (!input || input.dataset.bound === 'true') return;
    input.dataset.bound = 'true';
    input.addEventListener('input', (e) => {
        const termo = e.target.value || '';
        renderClientes(termo);
        if (typeof renderClientesSelector === 'function') renderClientesSelector(termo);
    });
}

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
    const cliente = clientes.find((c) => c.id === id);
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
    document.getElementById('new-cli-obs').value = cliente.obs || '';

    document.getElementById('novo-cliente-title').innerText = 'Editar Cliente';
    document.getElementById('btn-salvar-cliente').innerText = 'Salvar Alterações';
    abrirModalNovoCliente();
}

function resetClienteForm() {
    document.querySelectorAll('#modal-novo-cliente input').forEach((input) => {
        input.value = '';
    });
    clienteEmEdicaoId = null;
    document.getElementById('novo-cliente-title').innerText = 'Novo Cliente';
    document.getElementById('btn-salvar-cliente').innerText = 'Salvar e Continuar';
}

function verHistoricoCliente(id) {
    const cliente = clientes.find((c) => c.id === id);
    if (!cliente) return;

    const historico = Array.isArray(cliente.historico) ? cliente.historico : [];
    const title = document.getElementById('historico-title');
    const list = document.getElementById('historico-list');
    if (!list) return;

    if (title) title.innerText = `Histórico - ${cliente.nome || 'Cliente'}`;

    if (!historico.length) {
        list.innerHTML = '<div style="text-align:center; color: var(--text-sub); font-size: 13px; padding: 20px 0;">Este cliente ainda não possui envios.</div>';
    } else {
        list.innerHTML = historico.map((h) => {
            const data = new Date(h.criadoEm || Date.now()).toLocaleDateString('pt-BR');
            const valor = Number.isFinite(Number(h.valorFrete)) ? precoParaMoeda(Number(h.valorFrete)) : precoParaMoeda(parseMoedaParaNumero(h.valor || 0));
            return `
                <div class="historico-item">
                    <h4>${h.descricao || 'Envio'}</h4>
                    <p>${data} - ${h.servico || '-'} - ${h.tamanho || '-'}</p>
                    <div class="historico-meta">
                        <span>${h.veiculo || '-'}</span>
                        <span>${valor}</span>
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
        } else {
            el.classList.add('hidden');
        }
    });

    if (footerStep1) footerStep1.style.display = step === 1 ? 'block' : 'none';

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
        dot.classList.toggle('active', dotStep === step);
    });
}

function handleEnvioBack() {
    if (envioStepAtual > 1) {
        setModalEnvioStep(envioStepAtual - 1);
    } else {
        fecharModalEnvioDetalhes();
    }
}

function irParaPasso2(id, nome, endereco, whats) {
    clienteSelecionadoId = id;
    const cliente = getClienteById(id);

    const nomeEl = document.getElementById('card-nome');
    const enderecoEl = document.getElementById('card-endereco');
    const whatsEl = document.getElementById('card-whatsapp');

    if (nomeEl) nomeEl.innerText = nome || 'Cliente';
    if (enderecoEl) enderecoEl.innerText = endereco || '--';
    if (whatsEl) whatsEl.innerText = whats || '--';

    resumoRevisaoAtual.destino = montarEnderecoParaCalculo(cliente, endereco || '');
    resumoRevisaoAtual.destinoGeo = getGeoCliente(cliente);
    resumoRevisaoAtual.origemGeo = normalizarGeo(window.usuarioLogado?.endereco?.geo);
    resumoRevisaoAtual.distanciaKm = null;
    resumoRevisaoAtual.duracaoMin = null;
    resumoRevisaoAtual.valorConteudo = null;
    resumoRevisaoAtual.descricao = '';
    resumoRevisaoAtual.observacoes = '';

    const inputDesc = document.getElementById('input-desc');
    const inputValor = document.getElementById('input-valor');
    const inputObs = document.getElementById('input-obs-envio');
    if (inputDesc) inputDesc.value = '';
    if (inputValor) inputValor.value = '';
    if (inputObs) inputObs.value = '';

    if (cliente && !resumoRevisaoAtual.destinoGeo) {
        garantirGeoClienteSelecionado().catch(() => {});
    }

    abrirModalEnvioDetalhes();
}

function selecionarServico(tipo) {
    const std = document.getElementById('srv-std');
    const flash = document.getElementById('srv-flash');
    if (!std || !flash) return;
    std.classList.remove('active');
    flash.classList.remove('active');
    (tipo === 'Standard' ? std : flash).classList.add('active');
    atualizarPrecoEstimadoAtual();
}

function selecionarTamanho(tam) {
    ['p', 'm', 'g'].forEach((k) => {
        const el = document.getElementById('sz-' + k);
        if (el) el.classList.remove('active');
    });
    const alvo = document.getElementById('sz-' + String(tam || '').toLowerCase());
    if (alvo) alvo.classList.add('active');
}

function togglePass(id) {
    const input = document.getElementById(id);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
}

function alternarAuth(modo) {
    const fCad = document.getElementById('form-cadastrar');
    const fEnt = document.getElementById('form-entrar');
    const tCad = document.getElementById('tab-cadastrar');
    const tEnt = document.getElementById('tab-entrar');
    if (!fCad || !fEnt || !tCad || !tEnt) return;

    if (modo === 'cadastrar') {
        fCad.classList.remove('hidden');
        fEnt.classList.add('hidden');
        tCad.classList.add('active');
        tEnt.classList.remove('active');
    } else {
        fEnt.classList.remove('hidden');
        fCad.classList.add('hidden');
        tEnt.classList.add('active');
        tCad.classList.remove('active');
    }
}

function confirmarEnvioFinal() {
    setModalEnvioStep(4);
    if (typeof lucide !== 'undefined') lucide.createIcons();

    const pedidoId = `envio-${Date.now()}`;
    const codigoConfirmacaoEntrega = gerarCodigoConfirmacaoEntrega();
    const codigoPedido = `#${codigoConfirmacaoEntrega}`;
    const codigoEl = document.getElementById('codigo-pedido-solicitado');
    if (codigoEl) codigoEl.innerText = codigoPedido;

    if (clienteSelecionadoId) {
        const idx = clientes.findIndex((c) => c.id === clienteSelecionadoId);
        if (idx >= 0) {
            const enviosAtual = Number(clientes[idx].envios || 0) + 1;
            clientes[idx].envios = enviosAtual;
            if (enviosAtual >= 5) clientes[idx].frequente = true;

            const historico = Array.isArray(clientes[idx].historico) ? clientes[idx].historico : [];
            const desc = (resumoRevisaoAtual.descricao || document.getElementById('input-desc')?.value || '').trim();
            const servico = resumoRevisaoAtual.servico || getServicoSelecionadoAtual();
            const tamanho = document.querySelector('#modal-envio-detalhes .selection-grid-3 .select-box.active strong')?.innerText || '';
            const totalFrete = Number.isFinite(resumoRevisaoAtual.totalFrete)
                ? resumoRevisaoAtual.totalFrete
                : parseMoedaParaNumero(document.getElementById('input-valor')?.value || 0);
            const valorConteudo = Number.isFinite(resumoRevisaoAtual.valorConteudo)
                ? resumoRevisaoAtual.valorConteudo
                : parseMoedaParaNumero(document.getElementById('input-valor')?.value || 0);
            const observacoes = (resumoRevisaoAtual.observacoes || document.getElementById('input-obs-envio')?.value || clientes[idx].obs || '').trim();

            const pacoteObj = {
                id: pedidoId,
                codigoConfirmacaoEntrega,
                criadoEm: Date.now(),
                descricao: desc,
                observacoes,
                valorConteudo: Number(valorConteudo.toFixed(2)),
                valorFrete: Number(totalFrete.toFixed(2)),
                servico,
                tamanho,
                veiculo: resumoRevisaoAtual.veiculo || veiculoSelecionado,
                distanciaKm: Number.isFinite(resumoRevisaoAtual.distanciaKm) ? Number(resumoRevisaoAtual.distanciaKm.toFixed(2)) : null,
                duracaoMin: Number.isFinite(resumoRevisaoAtual.duracaoMin) ? Math.round(resumoRevisaoAtual.duracaoMin) : null,
                origemEndereco: resumoRevisaoAtual.origem || obterEnderecoLojaTexto(),
                destinoEndereco: resumoRevisaoAtual.destino || document.getElementById('card-endereco')?.innerText || '',
                origemGeo: resumoRevisaoAtual.origemGeo || null,
                destinoGeo: resumoRevisaoAtual.destinoGeo || null,
                status: 'PACOTE_NOVO',
                clienteId: clientes[idx].id,
                destinatario: clientes[idx].nome || 'Cliente',
                whatsapp: clientes[idx].whatsapp || '',
                cepDestino: clientes[idx].cep || '',
                cidadeDestino: clientes[idx].cidade || '',
                bairroDestino: clientes[idx].bairro || '',
                complemento: clientes[idx].comp || '',
                numero: clientes[idx].num || '',
                lojistaUid: getUsuarioIdAtual() || ''
            };

            historico.unshift(pacoteObj);

            clientes[idx].historico = historico.slice(0, 80);
            saveClientes();
            renderClientes(document.getElementById('buscar-cliente')?.value || '');

            // Persistir no modelo novo /pacotes/{uid}/<pedidoId>
            const uidAtual = getUsuarioIdAtual();
            if (uidAtual) {
                const pacoteFirebase = {
                    ...pacoteObj,
                    destinoCompleto: pacoteObj.destinoEndereco,
                    origemCompleta: pacoteObj.origemEndereco,
                    pagamentoStatus: pacoteObj.pagamentoStatus || 'PENDENTE',
                    statusRaw: 'PACOTE_NOVO'
                };
                // grava apenas dentro do usuário (modelo que você sinalizou)
                db.ref(`usuarios/${uidAtual}/pacotes/${pedidoId}`).set(pacoteFirebase).catch(() => {});
                // mantém cache local alinhado à mesma estrutura
                window.pacotesRaizCache = window.pacotesRaizCache || {};
                if (!window.pacotesRaizCache[uidAtual]) window.pacotesRaizCache[uidAtual] = {};
                window.pacotesRaizCache[uidAtual][pedidoId] = pacoteFirebase;
            }
        }
    }
}

function abrirNovoCliente() {
    resetClienteForm();
    abrirModalNovoCliente();
}

async function buscarEndereco(opts = {}) {
    const silencioso = Boolean(opts?.silencioso);
    const cepInput = document.getElementById('new-cli-cep');
    const ruaInput = document.getElementById('new-cli-rua');
    if (!cepInput || !ruaInput) return null;

    const cep = (cepInput.value || '').replace(/\D/g, '');
    if (cep.length !== 8) {
        if (!silencioso) alert('Digite um CEP válido com 8 números.');
        return null;
    }

    const placeholderOriginal = ruaInput.placeholder;
    ruaInput.placeholder = 'Buscando endereço...';

    try {
        const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
        const dados = await res.json();
        if (dados?.erro) {
            if (!silencioso) alert('CEP não encontrado.');
            return null;
        }

        document.getElementById('new-cli-rua').value = dados.logradouro || '';
        document.getElementById('new-cli-bairro').value = dados.bairro || '';
        document.getElementById('new-cli-cidade').value = dados.localidade || '';
        document.getElementById('new-cli-estado').value = dados.uf || '';
        document.getElementById('new-cli-num')?.focus();
        return dados;
    } catch (err) {
        if (!silencioso) alert('Erro ao buscar CEP. Verifique sua conexão.');
        return null;
    } finally {
        ruaInput.placeholder = placeholderOriginal || 'Ex: Av. Paulista';
    }
}

function agendarBuscaCepCliente(valor) {
    const cep = (valor || '').replace(/\D/g, '');
    if (cepClienteDebounceTimer) clearTimeout(cepClienteDebounceTimer);
    if (cep.length !== 8) return;
    cepClienteDebounceTimer = setTimeout(() => {
        buscarEndereco({ silencioso: true });
    }, 260);
}

const telInput = document.getElementById('new-cli-tel');
if (telInput && !telInput.dataset.maskBound) {
    telInput.dataset.maskBound = 'true';
    telInput.addEventListener('input', function (e) {
        const x = e.target.value.replace(/\D/g, '').match(/(\d{0,2})(\d{0,5})(\d{0,4})/);
        e.target.value = !x[2] ? x[1] : '(' + x[1] + ') ' + x[2] + (x[3] ? '-' + x[3] : '');
    });
}

const cepInputCliente = document.getElementById('new-cli-cep');
if (cepInputCliente && !cepInputCliente.dataset.maskBound) {
    cepInputCliente.dataset.maskBound = 'true';
    cepInputCliente.addEventListener('input', function (e) {
        const x = e.target.value.replace(/\D/g, '').match(/(\d{0,5})(\d{0,3})/);
        e.target.value = !x[2] ? x[1] : x[1] + '-' + x[2];
    });
}

async function salvarNovoCliente() {
    const nome = document.getElementById('new-cli-nome')?.value || '';
    const tel = document.getElementById('new-cli-tel')?.value || '';
    const cep = document.getElementById('new-cli-cep')?.value || '';
    const rua = document.getElementById('new-cli-rua')?.value || '';
    const num = document.getElementById('new-cli-num')?.value || '';
    const bairro = document.getElementById('new-cli-bairro')?.value || '';
    const cidade = document.getElementById('new-cli-cidade')?.value || '';
    const estado = document.getElementById('new-cli-estado')?.value || '';
    const comp = document.getElementById('new-cli-comp')?.value || '';
    const obs = document.getElementById('new-cli-obs')?.value || '';

    if (!nome || !tel || !rua || !num) {
        alert('Por favor, preencha Nome, WhatsApp, Rua e Número.');
        return;
    }

    const enderecoCompleto = montarEnderecoCliente({ rua, num, bairro, cidade, estado, comp });
    const ufNormalizada = normalizarUf(estado);
    const cepLimpo = formatarCep(cep);

    if (clienteEmEdicaoId) {
        const idx = clientes.findIndex((c) => c.id === clienteEmEdicaoId);
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
                comp: (comp || '').trim(),
                obs: (obs || '').trim()
            };
            const geo = await geocodificarCliente(clientes[idx]).catch(() => null);
            if (geo) {
                clientes[idx].geo = normalizarGeo(geo);
                clientes[idx].geoSig = assinaturaEndereco(clientes[idx]);
            }
        }
        await saveClientes();
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
            obs: (obs || '').trim(),
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
        clienteSelecionadoId = novoCliente.id;
    }

    renderClientes(document.getElementById('buscar-cliente')?.value || '');
    if (typeof renderClientesSelector === 'function') {
        renderClientesSelector(document.getElementById('buscar-cliente')?.value || '');
    }

    irParaPasso2(clienteSelecionadoId, nome, enderecoCompleto, tel);
    fecharModalNovoCliente();
    resetClienteForm();
}

function atualizarIndicadorMenuInferior() {
    const nav = document.getElementById('main-nav');
    const indicador = document.getElementById('nav-active-indicator');
    const ativo = nav
        ? (nav.querySelector('.nav-item.active') || nav.querySelector('.nav-center-plus.is-active'))
        : null;

    if (!nav || !indicador || nav.style.display === 'none' || !ativo) return;

    const navRect = nav.getBoundingClientRect();
    const ativoRect = ativo.getBoundingClientRect();
    const isCentro = ativo.classList.contains('nav-center-plus');
    const largura = isCentro ? 30 : 24;
    const targetX = (ativoRect.left - navRect.left) + (ativoRect.width / 2) - (largura / 2);

    indicador.style.width = `${largura}px`;
    indicador.style.transform = `translate3d(${targetX}px, 0, 0)`;
    nav.classList.add('nav-ready');
}

function ativarMenuInferior(targetTela) {
    const nav = document.getElementById('main-nav');
    if (!nav) return;

    nav.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'));
    const ativo = nav.querySelector(`.nav-item[data-nav-target="${targetTela}"]`);
    if (ativo) {
        ativo.classList.add('active');
        animarAtivacaoItemMenu(ativo);
    }

    atualizarEstadoBotaoCentralMenu(targetTela);
    requestAnimationFrame(atualizarIndicadorMenuInferior);
}
function irParaBuscarEntregador() {
    modoRotasEntregador = 'BUSCAR';
    navegar('view-rotas');
}

function irParaHistoricoRotasEntregador() {
    modoRotasEntregador = 'HISTORICO';
    navegar('view-rotas');
}
function ativarAbaChat() {
    ativarMenuInferior('view-chat');
    alert('Chat em breve');
}
function animarAtivacaoItemMenu(item) {
    if (!item) return;
    item.classList.remove('nav-just-activated');
    // força reflow para reiniciar a animação em trocas rápidas
    void item.offsetWidth;
    item.classList.add('nav-just-activated');
    setTimeout(() => item.classList.remove('nav-just-activated'), 280);
}

function atualizarEstadoBotaoCentralMenu(idTela) {
    const plusBtn = document.querySelector('.nav-center-plus');
    if (!plusBtn) return;

    const ativo = (!usuarioEhEntregador() && idTela === 'view-novo-envio');
    plusBtn.classList.toggle('is-active', ativo);

    if (ativo) {
        plusBtn.classList.remove('nav-just-activated');
        void plusBtn.offsetWidth;
        plusBtn.classList.add('nav-just-activated');
        setTimeout(() => plusBtn.classList.remove('nav-just-activated'), 280);
    }
}

window.addEventListener('resize', () => {
    requestAnimationFrame(atualizarIndicadorMenuInferior);
});

function navegar(idTela) {
    if (usuarioEhMaster()) {
        mostrarTelaAdminDashboard();
        return;
    }
    const tipo = obterTipoUsuarioAtual();
    let telaAlvo = idTela;

    if (telaAlvo === 'view-buscar' && tipo !== 'entregador') {
        telaAlvo = telaInicialPorTipoUsuario(tipo);
    }

    if (tipo === 'entregador') {
        if (telaAlvo === 'view-dash-loja') {
            telaAlvo = 'view-dash-entregador';
        }
        if (telaAlvo === 'view-novo-envio') {
            telaAlvo = 'view-rotas';
        }
        if (telaAlvo === 'view-perfil') {
            telaAlvo = 'view-perfil-entregador';
        }
    } else {
        if (telaAlvo === 'view-perfil-entregador') {
            telaAlvo = 'view-perfil';
        }
    }

    if (telaAlvo === 'view-perfil' && window.usuarioLogado) {
        preencherPerfilLojista();
    }

    if (telaAlvo === 'view-perfil-entregador' && window.usuarioLogado) {
        preencherPerfilEntregador();
    }

    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const target = document.getElementById(telaAlvo);
    if (target) target.classList.add('active');

    if (telaAlvo !== 'view-novo-envio') {
        const passos = ['envio-p1', 'envio-p2', 'envio-p3', 'envio-p4', 'envio-p5', 'envio-v-veiculo'];
        passos.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
        const p1 = document.getElementById('envio-p1');
        if (p1) p1.classList.remove('hidden');

        if (typeof fecharModalEnvioDetalhes === 'function') fecharModalEnvioDetalhes();
        if (typeof fecharModalNovoCliente === 'function') fecharModalNovoCliente();
        if (typeof fecharSeletorCliente === 'function') fecharSeletorCliente();
    }

    if (telaAlvo === 'view-novo-envio') {
        if (typeof initClienteSearch === 'function') initClienteSearch();
        if (typeof initClientes === 'function') initClientes();
    }

    if (telaAlvo === 'view-dash-loja' && tipo !== 'entregador') {
        renderizarDashboard(window.usuarioLogado || {});
    }

    if (telaAlvo === 'view-dash-entregador' && tipo === 'entregador') {
        renderizarDashboardEntregador(window.usuarioLogado || {});
        iniciarListenerHomeEntregador();
    } else if (tipo === 'entregador') {
        pararListenerHomeEntregador();
    }

    if (telaAlvo === 'view-rotas') {
        if (typeof atualizarLocalColetaDinamico === 'function') atualizarLocalColetaDinamico();
        if (typeof renderRotasTelaPrincipal === 'function') renderRotasTelaPrincipal();
    }
    if (telaAlvo === 'view-buscar') {
        renderTelaBuscarEntregador(true);
        iniciarListenerMarketplaceEntregador();
    } else if (tipo === 'entregador') {
        pararListenerMarketplaceEntregador();
    }

    if (telaAlvo === 'view-chat' || telaAlvo === 'view-novo-envio' || (telaAlvo === 'view-rotas' && tipo !== 'entregador')) {
        aplicarHeaderGlobalEmViewEstatica(telaAlvo, tipo);
    }
    if (telaAlvo === 'view-perfil' || telaAlvo === 'view-perfil-entregador') {
        limparHeaderGlobalEmView(telaAlvo);
    }



    const nav = document.getElementById('main-nav');
    const telasComMenu = (tipo === 'entregador')
        ? ['view-dash-entregador', 'view-rotas', 'view-buscar', 'view-chat', 'view-perfil-entregador']
        : ['view-dash-loja', 'view-novo-envio', 'view-rotas', 'view-chat', 'view-perfil'];

    if (nav) {
        const mostrarMenu = telasComMenu.includes(telaAlvo);
        nav.style.display = mostrarMenu ? 'flex' : 'none';

        if (mostrarMenu) {
            const navTarget = telaAlvo === 'view-perfil-entregador'
                ? 'view-perfil'
                : (telaAlvo === 'view-dash-entregador' ? 'view-dash-loja' : telaAlvo);
            ativarMenuInferior(navTarget);
        }
    }

    aplicarPermissoesPorTipoUsuario();

    window.scrollTo(0, 0);
    if (typeof lucide !== 'undefined') lucide.createIcons();
}
        function fecharToastSuave(elemento) {
            if (elemento) {
                elemento.style.opacity = '0';
                elemento.style.transition = 'opacity 0.5s ease-out';
                setTimeout(() => elemento.remove(), 1000);
            }
        }

        // Ajuste na função de desfazer para limpar o contador
let resumoRevisaoAtual = {
    origem: '',
    destino: '',
    origemGeo: null,
    destinoGeo: null,
    distanciaKm: null,
    duracaoMin: null,
    totalFrete: null,
    servico: 'Standard',
    veiculo: 'Moto',
    valorConteudo: null,
    descricao: '',
    observacoes: '',
    freteTesteOverride: null
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

function obterFreteTesteDasObservacoes(texto = '') {
    const t = (texto || '').toString();
    const match = t.match(/TESTE_FRETE\s*=\s*([0-9]+(?:[\.,][0-9]{1,2})?)/i);
    if (!match) return null;
    const valor = parseMoedaParaNumero(match[1]);
    if (!Number.isFinite(valor) || valor <= 0) return null;
    return Number(valor.toFixed(2));
}

function aplicarFreteTesteSeConfigurado(totalCalculado) {
    const obsAtual = (document.getElementById('input-obs-envio')?.value || resumoRevisaoAtual.observacoes || '').trim();
    const override = obterFreteTesteDasObservacoes(obsAtual);
    if (!Number.isFinite(override)) {
        resumoRevisaoAtual.freteTesteOverride = null;
        return Number(totalCalculado.toFixed(2));
    }
    resumoRevisaoAtual.freteTesteOverride = override;
    return override;
}

const GOOGLE_MAPS_KEY = (window.FLEXA_GOOGLE_MAPS_KEY || '').trim();
const FLEXA_PAYMENTS_PROXY_URL = (window.FLEXA_PAYMENTS_PROXY_URL || '').trim();
// Caminho TEMPORÁRIO só pra desenvolvimento local, enquanto o plano Blaze não é
// ativado e a Cloud Function "payments" não pode ser deployada. Só aceita token
// de TESTE — nunca deve receber uma credencial de produção. Assim que
// FLEXA_PAYMENTS_PROXY_URL estiver configurada, esse caminho deixa de ser usado.
const FLEXA_MP_TEST_TOKEN = (window.FLEXA_MP_TEST_TOKEN || '').trim();
if (FLEXA_MP_TEST_TOKEN && !FLEXA_MP_TEST_TOKEN.startsWith('TEST-')) {
    throw new Error('FLEXA_MP_TEST_TOKEN precisa começar com "TEST-". Nunca coloque uma credencial de produção do Mercado Pago no navegador — use a Cloud Function "payments" (FLEXA_PAYMENTS_PROXY_URL) para produção.');
}
// O ambiente (teste/produção) depende de qual token está configurado no servidor
// (Cloud Function "payments") — o cliente não tem mais acesso a esse token, então só
// sabe o ambiente depois da primeira resposta do servidor (ou de imediato, se estiver
// usando o caminho de teste local acima).
let mercadoPagoAmbienteAtual = FLEXA_MP_TEST_TOKEN ? 'teste' : 'desconhecido';
let rotaPixCodigoRawAtual = '';

function normalizarCodigoPix(codigo = '') {
    return (codigo || '').toString().replace(/\s+/g, '').trim();
}

function setStatusPagamentoPixRota(texto, tipo = 'pending') {
    const statusEl = document.getElementById('rota-pix-status');
    if (!statusEl) return;
    statusEl.innerText = texto || '--';
    statusEl.classList.remove(
        'rota-pix-status-pending',
        'rota-pix-status-approved',
        'rota-pix-status-warning',
        'rota-pix-status-loading'
    );
    statusEl.classList.add('rota-pix-status-' + tipo);
}

function setTicketPagamentoPixRota(url = '') {
    const link = document.getElementById('rota-pix-ticket-link');
    if (!link) return;
    if (url) {
        link.href = url;
        link.style.display = 'inline-flex';
    } else {
        link.removeAttribute('href');
        link.style.display = 'none';
    }
}


function atualizarAvisoAmbientePix() {
    const aviso = document.getElementById('rota-pix-ambiente');
    if (!aviso) return;

    if (!FLEXA_PAYMENTS_PROXY_URL && FLEXA_MP_TEST_TOKEN) {
        aviso.className = 'rota-pix-env rota-pix-env-warning';
        aviso.innerText = 'Modo TESTE LOCAL (temporário, sem Cloud Function — não usar em produção).';
        return;
    }

    if (!FLEXA_PAYMENTS_PROXY_URL) {
        aviso.className = 'rota-pix-env rota-pix-env-warning';
        aviso.innerText = 'Pagamento não configurado (defina FLEXA_PAYMENTS_PROXY_URL ou FLEXA_MP_TEST_TOKEN).';
        return;
    }

    if (mercadoPagoAmbienteAtual === 'teste') {
        aviso.className = 'rota-pix-env rota-pix-env-warning';
        aviso.innerText = 'Ambiente TESTE: alguns bancos podem recusar o Pix. Para pagamento real, use credencial PROD.';
        return;
    }

    if (mercadoPagoAmbienteAtual === 'producao') {
        aviso.className = 'rota-pix-env rota-pix-env-ok';
        aviso.innerText = 'Ambiente PRODUÇÃO ativo para cobrança Pix.';
        return;
    }

    aviso.className = 'rota-pix-env rota-pix-env-warning';
    aviso.innerText = 'Ambiente definido pelo servidor ao gerar o Pix.';
}
function obterEnderecoLojaTexto() {
    return formatarEnderecoEstruturado(window.usuarioLogado?.endereco);
}

function obterCidadeUfUsuarioLogado() {
    const end = window.usuarioLogado?.endereco || {};
    const cidade = (end.cidade || '').toString().trim();
    const uf = normalizarUf(end.uf || end.estado || '');

    if (cidade && uf) return `${cidade}, ${uf}`;
    if (cidade) return cidade;

    const textoEndereco = formatarEnderecoEstruturado(end);
    if (textoEndereco.includes('/')) {
        const pos = textoEndereco.lastIndexOf('-');
        const cidadeUf = pos >= 0 ? textoEndereco.slice(pos + 1).trim() : textoEndereco;
        const [cidadeTxt, ufTxt] = cidadeUf.split('/');
        if (cidadeTxt && ufTxt) return `${cidadeTxt.trim()}, ${normalizarUf(ufTxt)}`;
    }

    return '';
}

async function atualizarLocalColetaDinamico() {
    const el = document.getElementById('local-coleta-cidade-uf');
    if (!el) return;

    let cidadeUf = obterCidadeUfUsuarioLogado();
    if (!cidadeUf) {
        await obterEnderecoLojaAtual();
        cidadeUf = obterCidadeUfUsuarioLogado();
    }

    el.textContent = cidadeUf || 'Defina endereco';
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
    const precisaRegeocodificar = FORCAR_REGEOCODIFICACAO ||
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
    if (window.google?.maps?.Geocoder) return Promise.resolve(window.google.maps);
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

function parseDurationSecondsGoogle(valor) {
    if (!valor) return NaN;
    if (typeof valor === 'number') return Number(valor);
    const txt = String(valor).trim();
    const m = txt.match(/^([0-9]+(?:\.[0-9]+)?)s$/);
    if (!m) return NaN;
    return Number(m[1]);
}

function montarWaypointRota(endereco, geo = null) {
    const g = normalizarGeo(geo);
    if (g) {
        return {
            location: {
                latLng: {
                    latitude: g.lat,
                    longitude: g.lon
                }
            }
        };
    }
    return { address: (endereco || '').toString().trim() };
}

async function estimarRotaRoutesApi(origemEndereco, destinoEndereco, origemGeo = null, destinoGeo = null) {
    if (!GOOGLE_MAPS_KEY) return null;

    const body = {
        origin: montarWaypointRota(origemEndereco, origemGeo),
        destination: montarWaypointRota(destinoEndereco, destinoGeo),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        languageCode: 'pt-BR',
        units: 'METRIC'
    };

    try {
        const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
                'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration'
            },
            body: JSON.stringify(body)
        });

        const raw = await resp.text();
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) {}

        if (!resp.ok) {
            setUltimoErroRota('Google Routes API falhou.', {
                status: resp.status,
                body: json || raw || null
            });
            return null;
        }

        const route = json?.routes?.[0] || null;
        const distanceMeters = Number(route?.distanceMeters || NaN);
        const durationSec = parseDurationSecondsGoogle(route?.duration);

        if (!route || !Number.isFinite(distanceMeters) || !Number.isFinite(durationSec)) {
            setUltimoErroRota('Google Routes API retornou dados invalidos.', {
                response: json || raw || null
            });
            return null;
        }

        return {
            distanciaKm: distanceMeters / 1000,
            duracaoMin: durationSec / 60,
            originAddress: origemEndereco || null,
            destinationAddress: destinoEndereco || null
        };
    } catch (erro) {
        setUltimoErroRota('Falha ao chamar Google Routes API.', erro?.message || String(erro));
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
    // 100% Routes API: tentativa por endereco + fallback Routes por coordenadas.
    const estimativaRoutes = await estimarRotaRoutesApi(origemEndereco, destinoEndereco, origemGeo, destinoGeo);
    if (estimativaRoutes) {
        if (estimativaPlausivel(estimativaRoutes)) return estimativaRoutes;
        setUltimoErroRota('Rota por endereco fora da faixa plausivel.', {
            origemEndereco,
            destinoEndereco,
            distanciaKm: estimativaRoutes.distanciaKm,
            duracaoMin: estimativaRoutes.duracaoMin,
            originAddress: estimativaRoutes.originAddress || null,
            destinationAddress: estimativaRoutes.destinationAddress || null
        });
        return null;
    }

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

    const estimativaRoutesPorGeo = await estimarRotaRoutesApi(origemEndereco, destinoEndereco, origem, destino);
    if (estimativaRoutesPorGeo) {
        if (estimativaPlausivel(estimativaRoutesPorGeo)) return estimativaRoutesPorGeo;
        setUltimoErroRota('Rota por coordenadas fora da faixa plausivel.', {
            origem,
            destino,
            distanciaKm: estimativaRoutesPorGeo.distanciaKm,
            duracaoMin: estimativaRoutesPorGeo.duracaoMin,
            originAddress: estimativaRoutesPorGeo.originAddress || null,
            destinationAddress: estimativaRoutesPorGeo.destinationAddress || null
        });
    }
    return null;
}

async function garantirEstimativaAtual() {
    const destino = (resumoRevisaoAtual.destino || document.getElementById('card-endereco')?.innerText || '').trim();
    await obterEnderecoLojaAtual();
    const origemDisplay = formatarEnderecoLojaParaCalculo(window.usuarioLogado?.endereco) || '';
    const origemRota = formatarEnderecoLojaParaRota(window.usuarioLogado?.endereco) || '';
    const clienteSelecionado = getClienteById(clienteSelecionadoId);
    const destinoRota = formatarEnderecoClienteParaRota(clienteSelecionado, destino);
    let origemGeo = normalizarGeo(window.usuarioLogado?.endereco?.geo);
    const assinaturaOrigemAtual = assinaturaEndereco(window.usuarioLogado?.endereco || {});
    const origemGeoSig = window.usuarioLogado?.endereco?.geoSig || '';
    const origemPrecisaRegeocodificar = FORCAR_REGEOCODIFICACAO ||
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
    if (FORCAR_REGEOCODIFICACAO || !destinoGeo) destinoGeo = await garantirGeoClienteSelecionado().catch(() => null);

    if (origemDisplay) resumoRevisaoAtual.origem = origemDisplay;
    if (destino) resumoRevisaoAtual.destino = destino;
    if (origemGeo) resumoRevisaoAtual.origemGeo = origemGeo;
    if (destinoGeo) resumoRevisaoAtual.destinoGeo = destinoGeo;

    if (!origemRota || !destinoRota) return null;

    const estimativa = await estimarRotaEntrega(origemRota, destinoRota, origemGeo, destinoGeo);
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
        if (!ultimoErroRota) setUltimoErroRota('Google Maps não conseguiu calcular a rota com os endereços informados.');
        return null;
    } catch (erro) {
        setUltimoErroRota('Falha ao consultar Google Maps.', erro?.message || String(erro));
        return null;
    }
}
function atualizarPrecoEstimadoAtual() {
    const servico = getServicoSelecionadoAtual();
    const distanciaKm = Number.isFinite(resumoRevisaoAtual.distanciaKm) ? resumoRevisaoAtual.distanciaKm : 0;
    const totalCalculado = calcularFreteEstimado({ servico, veiculo: veiculoSelecionado, distanciaKm });
    const total = aplicarFreteTesteSeConfigurado(totalCalculado);
    resumoRevisaoAtual.servico = servico;
    resumoRevisaoAtual.veiculo = veiculoSelecionado;
    resumoRevisaoAtual.totalFrete = total;
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
    const inputDesc = (document.getElementById('input-desc')?.value || '').trim();
    const inputValorConteudo = parseMoedaParaNumero(document.getElementById('input-valor')?.value || 0);
    resumoRevisaoAtual.descricao = inputDesc;
    resumoRevisaoAtual.valorConteudo = Number.isFinite(inputValorConteudo) ? inputValorConteudo : 0;
    resumoRevisaoAtual.observacoes = (document.getElementById('input-obs-envio')?.value || '').trim();

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
    const totalFreteCalculado = calcularFreteEstimado({ servico, veiculo: veiculoSelecionado, distanciaKm: Number.isFinite(distanciaKm) ? distanciaKm : 0 });
    const totalFrete = aplicarFreteTesteSeConfigurado(totalFreteCalculado);
    resumoRevisaoAtual = {
        origem: enderecoOrigem,
        destino: enderecoDestino,
        origemGeo: resumoRevisaoAtual.origemGeo || null,
        destinoGeo: resumoRevisaoAtual.destinoGeo || null,
        distanciaKm,
        duracaoMin,
        totalFrete,
        servico,
        veiculo: veiculoSelecionado,
        descricao: resumoRevisaoAtual.descricao || '',
        observacoes: (document.getElementById('input-obs-envio')?.value || resumoRevisaoAtual.observacoes || '').trim(),
        freteTesteOverride: resumoRevisaoAtual.freteTesteOverride || null
    };
    document.getElementById('rev-nome').innerText = nome;
    document.getElementById('rev-end').innerText = enderecoDestinoExibicao;
    document.getElementById('rev-servico').innerText = servico;
    document.getElementById('rev-tamanho').innerText = `Pacote ${tamanho} - ${veiculoSelecionado}`;
    document.getElementById('rev-total').innerText = precoParaMoeda(totalFrete);
    const revDist = document.getElementById('rev-distancia'); if (revDist) revDist.innerText = formatarDistancia(distanciaKm);
    const revTempo = document.getElementById('rev-tempo'); if (revTempo) revTempo.innerText = formatarDuracao(duracaoMin);
    const revOrigem = document.getElementById('rev-origem'); if (revOrigem) revOrigem.innerText = enderecoOrigem || 'Defina o endereco da loja no Perfil';
    if (!estimativa) {
        const detalheTxt = detalheRotaParaTexto(ultimoErroRota?.detalhe);
        alert(`Endereco invalido ou incompleto para rota.\n\nRetorno da API:\n${detalheTxt || (ultimoErroRota?.msg || 'Sem detalhe de erro.')}`);
    }
    setModalEnvioStep(3);
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function abrirCriarRota() {
    // Aqui simulamos que existem 3 envios pendentes no seu banco/memória
    const pendentes = [
        { id: 1, cliente: "Maria Silva", preco: 12.50, flash: false },
        { id: 2, cliente: "João Paulo", preco: 25.00, flash: true }, // Regra do Flash
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
    // Passo 3: Simulação de Sucesso
    alert("Simulando Pagamento PIX...");
    setTimeout(() => {
        alert("Pagamento Confirmado!");
        fecharModalRota();
        navegar('view-rotas');
        // Aqui você adicionaria a lógica de inserir na lista de rotas reais
    }, 1500);
}

function atualizarResumoRota() {
    const selecionados = document.querySelectorAll('.checkbox-envio.selected').length;
    document.getElementById('rota-qtd').innerText = selecionados;
    document.getElementById('rota-total').innerText = "R$ " + (selecionados * 12.50).toFixed(2); // Simulação de preço
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
// ===================== [AUTENTICA - fO - VERSÃO ATIVA] =====================
async function loginReal() {
    const email = document.getElementById('email-login').value;
    const senha = document.getElementById('pass-login').value;

    if (!email || !senha) return alert('Preencha e-mail e senha!');

    try {
        const cred = await auth.signInWithEmailAndPassword(email, senha);
        const snapshot = await db.ref('usuarios/' + cred.user.uid).once('value');
        const dadosUser = snapshot.val();

        if (!dadosUser) {
            alert('Conta sem perfil no banco. Fale com o suporte.');
            return;
        }

        const tipoContaRaw = normalizarTexto(dadosUser?.tipo || 'loja');
        const contaEhEntregador = (tipoContaRaw === 'entregador' || tipoContaRaw === 'entrega');
        const esperadoEhEntregador = tipoCadastroSelecionado === 'entrega';

        if (contaEhEntregador !== esperadoEhEntregador) {
            await auth.signOut();
            alert(contaEhEntregador
                ? 'Essa conta e de entregador. Entre pela opcao Fazer entregas.'
                : 'Essa conta e de lojista. Entre pela opcao Enviar pacotes.');
            return;
        }

        usuarioLogado = { id: cred.user.uid, ...dadosUser };
        window.usuarioLogado = usuarioLogado;
        // limpa caches locais para evitar vazamento entre tenants
        clientes = [];
        rotasMarketplaceEntregadorCache = [];
        rotasHomeCache = [];
        entregadorHomeCache = {};
        rotaPendentesCache = [];
        rotaSelecaoIds = new Set();
        filtroRotaEntregadorOrigem = 'TODAS';
        filtroRotaEntregadorDestino = 'TODAS';
        localStorage.setItem('flexa_session', JSON.stringify(usuarioLogado));

        const tipo = obterTipoUsuarioAtual();
        aplicarPermissoesPorTipoUsuario();
        navegar(telaInicialPorTipoUsuario(tipo));
        iniciarListenerNotificacoes();

        if (tipo !== 'entregador') {
            pararListenerHomeEntregador();
            pararListenerMarketplaceEntregador();
            renderizarDashboard(usuarioLogado);
        } else {
            renderizarDashboardEntregador(usuarioLogado);
            iniciarListenerHomeEntregador();
        }
    } catch (error) {
        alert('Erro ao entrar: ' + error.message);
    }
}

// abre Pacotes por padrão ao entrar no /admin
document.addEventListener('DOMContentLoaded', () => {
    if (window.location.hash.includes('/admin')) {
        switchAdminTab('packages');
    }
});

async function loginAdmin() {
    const email = document.getElementById('admin-email')?.value || '';
    const senha = document.getElementById('admin-pass')?.value || '';
    if (!email || !senha) return alert('Informe email e senha.');
    try {
        const cred = await auth.signInWithEmailAndPassword(email, senha);
        const snap = await db.ref('usuarios/' + cred.user.uid).once('value');
        const dadosUser = snap.val();
        if (!dadosUser || normalizarTexto(dadosUser.tipo) !== 'master') {
            await auth.signOut();
            alert('Conta sem permissão de administrador.');
            return;
        }
        modoAdmin = true;
        document.body.classList.add('admin-mode');
        usuarioLogado = { id: cred.user.uid, ...dadosUser };
        window.usuarioLogado = usuarioLogado;
        document.getElementById('admin-user-email').innerText = dadosUser.email || email;
        mostrarTelaAdminDashboard();
        await renderDashboardMaster();
        const splash = document.getElementById('splash-screen');
        finalizarSplash(splash);
    } catch (err) {
        alert('Falha no login admin: ' + err.message);
    }
}

async function criarContaMaster() {
    const nome = document.getElementById('admin-nome')?.value || '';
    const email = document.getElementById('admin-email-cad')?.value || '';
    const senha = document.getElementById('admin-pass-cad')?.value || '';
    const chave = document.getElementById('admin-key')?.value || '';
    if (!nome || !email || !senha) return alert('Preencha todos os campos obrigatórios.');
    // Chave é opcional; se quiser exigir algo, edite aqui
    try {
        const cred = await auth.createUserWithEmailAndPassword(email, senha);
        const payload = {
            nome,
            email,
            tipo: 'master',
            status: 'ativo',
            criadoEm: Date.now()
        };
        await db.ref('usuarios/' + cred.user.uid).set(payload);
        modoAdmin = true;
        document.body.classList.add('admin-mode');
        usuarioLogado = { id: cred.user.uid, ...payload };
        window.usuarioLogado = usuarioLogado;
        document.getElementById('admin-user-email').innerText = email;
        mostrarTelaAdminDashboard();
        await renderDashboardMaster();
        const splash = document.getElementById('splash-screen');
        finalizarSplash(splash);
        alert('Conta master criada com sucesso.');
    } catch (err) {
        alert('Falha ao criar conta master: ' + err.message);
    }
}

// --- FUN - fO PARA IR AO PERFIL E CARREGAR DADOS ---
function irParaPerfil() {
    const tipo = obterTipoUsuarioAtual();
    if (tipo === 'entregador') {
        preencherPerfilEntregador();
        navegar('view-perfil-entregador');
    } else {
        preencherPerfilLojista();
        navegar('view-perfil');
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// --- FUN - fO DE LOGOUT ---
// 1. FUN - fO PARA LOGOUT
function logoutReal() {
    if (confirm("Tem certeza que deseja sair?")) {
        firebase.auth().signOut().then(() => {
            alert("Sessão encerrada!");
            // Limpa dados locais se houver e volta para a tela inicial
            localStorage.removeItem('flexa_user_data'); 
            window.location.reload(); // Recarrega para limpar o estado da aplicação
        }).catch((error) => {
            alert("Erro ao sair: " + error.message);
        });
    }
}

// 2. MONITOR DE ESTADO DE AUTENTICA - fO (Persistência)
// Esta função roda automaticamente sempre que a página abre ou o estado muda
// MONITOR DE ESTADO DE AUTENTICA - fO
firebase.auth().onAuthStateChanged((user) => {
    const tabbar = document.getElementById('main-nav');
    const splash = document.getElementById('splash-screen');

    if (user) {
        firebase.database().ref('usuarios/' + user.uid).once('value')
            .then((snapshot) => {
                const userData = snapshot.val();
                if (userData) {
                    window.usuarioLogado = { id: user.uid, ...userData };
                    usuarioLogado = window.usuarioLogado;

                    // pré-carrega pacotes no modelo novo para este usuário
                    carregarPacotesRaizDoUid(user.uid).catch(() => {});

                    dashboardRotasSincronizadas = false;
                    rotasHomeCache = [];
                    entregadorHomeCache = {};
                    rotasMarketplaceEntregadorCache = [];
                    filtroRotaEntregadorOrigem = 'TODAS';
                    filtroRotaEntregadorDestino = 'TODAS';
                    aplicarPermissoesPorTipoUsuario();

                    if (!usuarioEhMaster()) {
                        registrarPresencaUsuario(user.uid);
                    }

                    const tipo = obterTipoUsuarioAtual();
                    if (tipo === 'master' || modoAdmin) {
                        modoAdmin = true;
                        document.body.classList.add('admin-mode');
                        document.getElementById('admin-user-email').innerText = userData.email || user.email || '--';
                        mostrarTelaAdminDashboard();
                        renderDashboardMaster();
                        if (tabbar) tabbar.style.display = 'none';
                        finalizarSplash(splash);
                        return;
                    }

                    const telaInicial = telaInicialPorTipoUsuario(tipo);
                    iniciarListenerNotificacoes();

                    if (tipo !== 'entregador') {
                        pararListenerHomeEntregador();
                        pararListenerMarketplaceEntregador();
                        renderizarDashboard(userData);
                    } else {
                        renderizarDashboardEntregador(window.usuarioLogado || userData);
                        iniciarListenerHomeEntregador();
                    }

                    atualizarLocalColetaDinamico();
                    navegar(telaInicial);

                    if (tabbar) tabbar.style.display = 'flex';
                    initClientes();
                }
                finalizarSplash(splash);
            })
            .catch(() => finalizarSplash(splash));
    } else {
        dashboardRotasSincronizadas = false;
        rotasHomeCache = [];
        rotasMarketplaceEntregadorCache = [];
        filtroRotaEntregadorOrigem = 'TODAS';
        filtroRotaEntregadorDestino = 'TODAS';
        window.usuarioLogado = null;
        usuarioLogado = null;
        pararListenerHomeEntregador();
        pararListenerMarketplaceEntregador();
        pararListenerNotificacoes();
        pararRastreioGpsEntregador();
        if (document.body) document.body.classList.remove('usuario-entregador');
        pararPresencaUsuarioAtual();

        if (modoAdmin) {
            mostrarTelaAdminLogin();
            if (tabbar) tabbar.style.display = 'none';
            finalizarSplash(splash);
            return;
        }

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


// Função suave para esconder o splash
function finalizarSplash(elemento) {
    if (elemento) {
        elemento.style.opacity = '0';
        setTimeout(() => {
            elemento.style.display = 'none';
        }, 500); // Tempo da transição CSS
    }
}

function renderizarDashboard(user) {
    const container = document.getElementById('dash-loader-content');
    if (!container) return;

    const tipoUser = obterTipoUsuarioAtual();
    const saldoUser = Number(user?.financeiro?.saldo || 0);
    const headerHtml = renderHeaderGlobal(tipoUser, saldoUser);

    const localColeta = obterCidadeUfUsuarioLogado() || 'Defina o endereco';

    const envios = typeof coletarEnviosDaBase === 'function' ? coletarEnviosDaBase() : [];
    const recentes = envios.slice(0, 4);

    const rotas = Array.isArray(rotasHomeCache) ? rotasHomeCache : [];
    const rotasOrdenadas = [...rotas].sort((a, b) => Number(b?.atualizadoEm || b?.criadoEm || 0) - Number(a?.atualizadoEm || a?.criadoEm || 0));
    const rotasRecentes = rotasOrdenadas.slice(0, 3);
    const rotaAtual = rotasOrdenadas.find((r) => {
        const st = normalizarStatusRotaFiltro(r?.status || r?.pagamentoStatus || 'CRIADA');
        return st === 'EM_ROTA' || st === 'BUSCANDO';
    }) || null;

    let pacoteAtual = null;
    let distanciaTotal = 0;
    let duracaoTotal = 0;
    let cidadeDestino = '--';
    let statusRotaVisual = getStatusVisualRota('CRIADA');
    let etapaAtual = 1;
    let progressoPctRota = 0;
    let timelineHtml = '';

    if (rotaAtual) {
        const pacotes = getPacotesDaRota(rotaAtual);
        pacoteAtual = pacotes[0] || null;
        distanciaTotal = pacotes.reduce((acc, p) => acc + (Number.isFinite(Number(p?.distanciaKm)) ? Number(p.distanciaKm) : 0), 0);
        duracaoTotal = pacotes.reduce((acc, p) => acc + (Number.isFinite(Number(p?.duracaoMin)) ? Number(p.duracaoMin) : 0), 0);
        const totalPacotes = pacotes.length || Math.max(1, Number(rotaAtual?.quantidade || 0));
        const concluidosP = pacotes.filter((p) => normalizarStatusEnvioFiltro(p?.status || p?.statusRaw || '') === 'ENTREGUE').length;
        const canceladosP = pacotes.filter((p) => normalizarStatusEnvioFiltro(p?.status || p?.statusRaw || '') === 'CANCELADO').length;
        const feitos = concluidosP + canceladosP;
        progressoPctRota = totalPacotes > 0 ? Math.max(0, Math.min(100, Math.round((feitos / totalPacotes) * 100))) : 0;

        const resumoCidades = resumirCidadesRota(pacotes);
        cidadeDestino = resumoCidades?.principal || '--';

        const statusNorm = normalizarStatusRotaFiltro(rotaAtual?.status || rotaAtual?.pagamentoStatus || 'CRIADA');
        statusRotaVisual = getStatusVisualRota(statusNorm);
        etapaAtual = statusNorm === 'CONCLUIDO' ? 4 : statusNorm === 'EM_ROTA' ? 3 : statusNorm === 'BUSCANDO' ? 2 : 1;

        if (statusNorm === 'CONCLUIDO') progressoPctRota = 100;
        if (statusNorm === 'BUSCANDO') progressoPctRota = 0;
        if (statusNorm === 'EM_ROTA' && progressoPctRota === 0) progressoPctRota = 0;

        // pontos da timeline: 1 bolinha por envio da rota, preenchendo conforme cada envio é entregue/cancelado
        const CAP_DOTS_VISIVEIS = 6;
        const totalPontos = Math.max(1, totalPacotes || 1);
        const pacotesOrdenados = pacotes.length ? pacotes : Array.from({ length: totalPontos });
        const pacoteEstaConcluido = (p) => {
            if (!p) return false;
            const st = normalizarStatusEnvioFiltro(p?.status || p?.statusRaw || '');
            return st === 'ENTREGUE' || st === 'CANCELADO';
        };

        if (totalPontos <= CAP_DOTS_VISIVEIS) {
            timelineHtml = pacotesOrdenados.slice(0, totalPontos).map((p) =>
                `<span class="home-route-dot ${pacoteEstaConcluido(p) ? 'done' : ''}"></span>`
            ).join('');
        } else {
            const visiveis = pacotesOrdenados.slice(0, CAP_DOTS_VISIVEIS - 1);
            const restantes = pacotesOrdenados.slice(CAP_DOTS_VISIVEIS - 1);
            const restantesDoneCount = restantes.filter(pacoteEstaConcluido).length;
            const restantesPct = restantes.length ? Math.round((restantesDoneCount / restantes.length) * 100) : 0;
            const dotsVisiveisHtml = visiveis.map((p) =>
                `<span class="home-route-dot ${pacoteEstaConcluido(p) ? 'done' : ''}"></span>`
            ).join('');
            const moreHtml = `<span class="home-route-more" style="background:linear-gradient(90deg, #da6f18 ${restantesPct}%, #d6deea ${restantesPct}%);" title="${restantesDoneCount}/${restantes.length} entregues">+${restantes.length}</span>`;
            timelineHtml = dotsVisiveisHtml + moreHtml;
        }
    }

    const statusTagHome = statusRotaVisual.label === 'BUSCANDO'
        ? 'Buscando'
        : statusRotaVisual.label === 'EM ROTA'
            ? 'Em rota'
            : statusRotaVisual.label === 'CONCLUIDA'
                ? 'Concluida'
                : statusRotaVisual.label;

    const statusRecenteClass = (statusTxt) => {
        const s = normalizarStatusRotaFiltro(statusTxt);
        if (s === 'CONCLUIDO') return 'home-recent-status-entregue';
        if (s === 'EM_ROTA') return 'home-recent-status-processo';
        if (s === 'CANCELADO') return 'home-recent-status-cancelado';
        return 'home-recent-status-processo';
    };
    const listaRotasRecentes = rotasRecentes.length
        ? rotasRecentes.map((rota) => {
            const statusNorm = normalizarStatusRotaFiltro(rota?.status || rota?.pagamentoStatus || 'CRIADA');
            const statusVisual = getStatusVisualRota(statusNorm);
            const pacotes = getPacotesDaRota(rota);
            const qtdPacotes = pacotes.length;
            return `
                <button type="button" class="home-recent-item" onclick="abrirModalDetalheRota('${String(rota.id).replace(/'/g, "\\'")}')">
                    <span class="home-recent-avatar"><i data-lucide="map"></i></span>
                    <span class="home-recent-main">
                        <strong>Rota #${rota.id || '--'}</strong>
                        <small>${qtdPacotes} pacote(s)</small>
                    </span>
                    <span class="home-recent-status ${statusRecenteClass(statusNorm)}">${statusVisual.label}</span>
                </button>
            `;
        }).join('')
        : '<div class="home-empty-inline">Nenhuma rota recente para exibir.</div>';

    const cardEmRota = rotaAtual
        ? `
            <button type="button" class="home-current-card" onclick="abrirModalTrackingLoja('${String(rotaAtual.id).replace(/'/g, "\\'")}')">
                <div class="home-current-main">
                    <div class="home-current-head">
                        <span class="home-current-avatar"><i data-lucide="package"></i></span>
                        <div class="home-current-title-wrap">
                            <strong>ID: ${rotaAtual.id || '--'}</strong>
                            <small>${formatarDistancia(distanciaTotal)} · ${formatarDuracao(duracaoTotal)}</small>
                        </div>
                        <span class="home-current-badge home-current-status-tag ${statusRotaVisual.className}" style="margin-left:auto; align-self:flex-start;">${statusTagHome}</span>
                    </div>

                    <div class="home-current-timeline-wrap">
                        <span class="home-current-time">${etapaAtual >= 4 ? 'Concluida' : (etapaAtual === 3 ? 'Em andamento' : 'Aguardando entregador')}</span>
                        <div class="home-current-track">
                            <div class="home-current-track-fill" style="width:${progressoPctRota}%;"></div>
                            <div class="home-current-track-line"></div>
                            <div class="home-current-dots">${timelineHtml}</div>
                            <span class="home-current-bike" style="left: clamp(0px, calc(${progressoPctRota}% - 18px), calc(100% - 36px));"><img src="img/timeline-icon.png" alt="Em rota"></span>
                        </div>
                    </div>

                    <div class="home-current-footer">
                        <span><small>Origem</small><strong>${localColeta}</strong></span>
                        <span><small>Destino</small><strong>${resumirCidadesRota(getPacotesDaRota(rotaAtual))?.display || cidadeDestino}</strong></span>
                    </div>
                </div>

                <img src="img/box2.png" alt="Pacote em rota" class="home-current-box-image">
            </button>
        `
        : '';

    // A seção "Em Rota" só aparece quando existe alguma rota realmente em andamento
    // (Buscando/Em rota) — sem rota ativa, a seção inteira fica invisível, não só o card.
    const secaoEmRotaHtml = rotaAtual
        ? `
            <section class="home-section">
                <div class="home-section-head">
                    <h3>Em Rota</h3>
                    <button type="button" onclick="navegar('view-rotas')">Ver todas</button>
                </div>
                ${cardEmRota}
            </section>
        `
        : '';

    container.innerHTML = `
        ${headerHtml}
        <div class="home-screen">
            <div class="home-location-strip">
                <span class="home-truck-icon"><i data-lucide="truck"></i></span>
                <div class="home-address-text">
                    <small>Local de coleta</small>
                    <strong>${localColeta}</strong>
                </div>
            </div>

            <div class="home-search-row">
                <button type="button" class="home-search-pill" onclick="navegar('view-novo-envio')">
                    <i data-lucide="search"></i>
                    <span>Buscar cliente ou pedido</span>
                </button>
                <button type="button" class="home-search-action" onclick="abrirModalRastrearRotas()">
                    <i data-lucide="scan-line"></i>
                </button>
            </div>

            <div class="home-quick-grid">
                <button type="button" class="home-quick-card" onclick="navegar('view-rotas')">
                    <strong class="home-quick-title">Nova Rota</strong>
                    <img src="img/moto.png" alt="Nova Rota" class="home-quick-image home-quick-image-moto">
                </button>
                <button type="button" class="home-quick-card" onclick="abrirSeletorCliente()">
                    <strong class="home-quick-title">Novo Envio</strong>
                    <img src="img/box1.png" alt="Novo Envio" class="home-quick-image home-quick-image-box">
                </button>
            </div>

            ${secaoEmRotaHtml}

            <section class="home-section">
                <div class="home-section-head">
                    <h3>Rotas Recentes</h3>
                    <button type="button" onclick="navegar('view-rotas')">Ver todas</button>
                </div>
                <div class="home-recent-list">${listaRotasRecentes}</div>
            </section>
        </div>
    `;

    if (typeof lucide !== 'undefined') lucide.createIcons();

    if (!dashboardRotasSincronizadas && getUsuarioIdAtual()) {
        dashboardRotasSincronizadas = true;
        carregarRotasDoBanco()
            .then((rotasDb) => {
                rotasHomeCache = Array.isArray(rotasDb) ? rotasDb : [];
                if (document.getElementById('view-dash-loja')?.classList.contains('active')) {
                    renderizarDashboard(window.usuarioLogado || user || {});
                }
            })
            .catch(() => {});
    }
}
function buscarDadosDoBanco(uid) {
    // Usamos .on para que qualquer alteração no banco reflita no app em tempo real
    db.ref('usuarios/' + uid).on('value', (snapshot) => {
        const dados = snapshot.val();
        if (dados) {
            // Salva os dados na memória global do app
            window.usuarioLogado = { id: uid, ...dados }; 
            
            // Atualiza os elementos da tela de Perfil se eles existirem na página
            const nomeDisplay = document.getElementById('perfil-nome-display');
            const instaDisplay = document.getElementById('perfil-insta-display');
            const nomeEntDisplay = document.getElementById('perfil-entregador-nome-display');
            const instaEntDisplay = document.getElementById('perfil-entregador-insta-display');
            const fotoDisplay = document.getElementById('perfil-foto-display');
            const fotoEntDisplay = document.getElementById('perfil-entregador-foto-display');

            if (nomeDisplay) nomeDisplay.innerText = dados.nome || 'Usuário';
            aplicarLinkInstagram(instaDisplay, dados.instagram || '');
            if (nomeEntDisplay) nomeEntDisplay.innerText = dados.nome || 'Entregador';
            aplicarLinkInstagram(instaEntDisplay, dados.instagram || '');
            aplicarFotoComPlaceholder(fotoDisplay, dados.foto || '');
            aplicarFotoComPlaceholder(fotoEntDisplay, dados.foto || '');
            
            // Renderiza o dash e navega (apenas na primeira carga)
            renderizarDashboard(dados);
            atualizarLocalColetaDinamico();
            // Se estiver na tela de login, manda para o dash
            if(document.getElementById('view-auth').classList.contains('active')) {
                navegar('view-dash-loja');
            }
        } else {
            navegar('view-auth'); 
        }
    });
}
function normalizarStatusRotaFiltro(status) {
    const s = normalizarTexto((status || '').toString()).toUpperCase().replace(/\s+/g, '_');
    if (!s) return 'BUSCANDO';
    if (s === 'EM_ROTA') return 'EM_ROTA';
    if (s === 'CONCLUIDO' || s === 'CONCLUIDA' || s === 'FINALIZADA' || s === 'FINALIZADO' || s === 'ENTREGUE') return 'CONCLUIDO';
    if (s === 'CANCELADO' || s === 'CANCELADA') return 'CANCELADO';
    if (s === 'CRIADA' || s === 'BUSCANDO' || s === 'PENDENTE' || s.startsWith('AGUARD')) return 'BUSCANDO';
    return 'BUSCANDO';
}

function getStatusVisualRota(status) {
    const s = normalizarStatusRotaFiltro(status);
    if (s === 'EM_ROTA') return { label: 'EM ROTA', className: 'status-em-rota' };
    if (s === 'CONCLUIDO') return { label: 'CONCLUÍDA', className: 'status-finalizada' };
    if (s === 'CANCELADO') return { label: 'CANCELADA', className: 'status-cancelado' };
    return { label: 'BUSCANDO', className: 'status-buscando' };
}

function rotuloStatusEnvio(statusRaw) {
    const s = normalizarTexto((statusRaw || '').toString()).toUpperCase().replace(/\s+/g, '_');
    if (s === 'EM_ROTA') return 'Em rota';
    if (s === 'ENTREGUE' || s === 'CONCLUIDO' || s === 'CONCLUIDA' || s === 'FINALIZADO' || s === 'FINALIZADA') return 'Concluido';
    if (s === 'CANCELADO' || s === 'CANCELADA') return 'Cancelado';
    return 'Pendente';
}

function normalizarStatusEnvioFiltro(statusRaw) {
    const s = normalizarTexto((statusRaw || '').toString()).toUpperCase().replace(/\s+/g, '_');
    if (s === 'PACOTE_NOVO') return 'PACOTE_NOVO';
    if (s === 'BUSCANDO' || s === 'PAGAMENTO_PENDENTE') return 'BUSCANDO';
    if (s === 'EM_ROTA') return 'EM_ROTA';
    if (s === 'ENTREGUE' || s === 'CONCLUIDO' || s === 'CONCLUIDA' || s === 'FINALIZADO' || s === 'FINALIZADA') return 'ENTREGUE';
    if (s === 'CANCELADO' || s === 'CANCELADA') return 'CANCELADO';
    return 'PACOTE_NOVO';
}

function mapearCategoriaEnvio(envio) {
    const statusBase = normalizarStatusEnvioFiltro(envio?.statusRaw || envio?.status || 'PACOTE_NOVO');
    if (statusBase === 'EM_ROTA') return 'EM_ROTA';
    if (statusBase === 'ENTREGUE') return 'ENTREGUE';
    if (statusBase === 'CANCELADO') return 'CANCELADO';
    if (statusBase === 'BUSCANDO') return 'BUSCANDO';

    const pagamento = normalizarTexto(envio?.pagamentoStatusRaw || envio?.pagamentoStatus || envio?.pagamento || '')
        .toUpperCase()
        .replace(/\s+/g, '_');

    if (pagamento === 'PENDENTE' || pagamento === 'PAGAMENTO_PENDENTE') return 'PACOTE_NOVO';
    if (pagamento === 'CANCELADO') return 'CANCELADO';

    return 'PACOTE_NOVO';
}

function normalizarFiltroChipEnvio(filtro = 'TODOS') {
    const raw = normalizarTexto((filtro || 'TODOS').toString()).toUpperCase().replace(/\s+/g, '_');
    if (raw === 'CONCLUIDO' || raw === 'CONCLUIDA' || raw === 'ENTREGUE' || raw === 'FINALIZADO' || raw === 'FINALIZADA') return 'ENTREGUE';
    if (raw === 'CANCELADO' || raw === 'CANCELADA') return 'CANCELADO';
    if (raw === 'EM_ROTA') return 'EM_ROTA';
    if (raw === 'BUSCANDO') return 'BUSCANDO';
    if (raw === 'PAGAMENTO_PENDENTE' || raw === 'PACOTE_NOVO') return 'PACOTE_NOVO';
    if (raw === 'TODOS') return 'TODOS';
    return raw || 'TODOS';
}

function envioPassaNoFiltro(envio) {
    const filtro = normalizarFiltroChipEnvio(filtroEnviosAtivo);
    if (!filtro || filtro === 'TODOS') return true;
    return mapearCategoriaEnvio(envio) === filtro;
}

function obterClasseCorStatusEnvioCard(envio) {
    const categoria = mapearCategoriaEnvio(envio);
    if (categoria === 'EM_ROTA') return 'status-blue';
    if (categoria === 'ENTREGUE') return 'status-green';
    if (categoria === 'BUSCANDO' || categoria === 'CANCELADO') return 'status-yellow';
    return 'status-orange';
}

function rotaPassaNoFiltro(rota) {
    if (!filtroRotasAtivo || filtroRotasAtivo === 'TODOS') return true;
    const status = normalizarStatusRotaFiltro(rota?.status || rota?.pagamentoStatus || 'CRIADA');
    return status === filtroRotasAtivo;
}

function montarMapaEnviosPorId() {
    const mapa = new Map();
    // modelo antigo: clientes/historico
    clientes.forEach((cliente) => {
        const historico = Array.isArray(cliente?.historico) ? cliente.historico : [];
        const cidadeCliente = (cliente?.cidade || extrairCamposEnderecoCliente(cliente || {}).cidade || '').trim();
        historico.forEach((h, idx) => {
            const idAtual = h?.id || ('envio-' + cliente.id + '-' + idx);
            const codigo = idAtual.replace('envio-', '').slice(-4);
            mapa.set(idAtual, {
                id: idAtual,
                codigo,
                clienteId: cliente.id,
                destinatario: cliente.nome || 'Cliente',
                whatsapp: cliente.whatsapp || '--',
                cidade: cidadeCliente || '',
                servico: h?.servico || 'Standard',
                veiculo: h?.veiculo || 'Moto',
                tamanho: h?.tamanho || '--',
                valorFrete: Number.isFinite(Number(h?.valorFrete)) ? Number(h.valorFrete) : parseMoedaParaNumero(h?.valor || 0),
                distanciaKm: Number.isFinite(Number(h?.distanciaKm)) ? Number(h.distanciaKm) : null,
                duracaoMin: Number.isFinite(Number(h?.duracaoMin)) ? Number(h.duracaoMin) : null,
                valorConteudo: Number.isFinite(Number(h?.valorConteudo)) ? Number(h.valorConteudo) : null,
                descricao: (h?.descricao || '').toString().trim(),
                observacoes: (h?.observacoes || '').toString().trim(),
                origemEndereco: h?.origemEndereco || '--',
                destinoEndereco: h?.destinoEndereco || cliente.endereco || '--',
                status: (h?.status || 'PENDENTE').toUpperCase(),
                criadoEm: Number(h?.criadoEm || Date.now())
            });
        });
    });
    // modelo novo: /pacotes/{uid}/{envioId}
    if (window.pacotesRaizCache && typeof window.pacotesRaizCache === 'object') {
        Object.keys(window.pacotesRaizCache).forEach((uid) => {
            const pacs = window.pacotesRaizCache[uid] || {};
            Object.keys(pacs).forEach((pid) => {
                const p = pacs[pid] || {};
                const idAtual = pid;
                if (mapa.has(idAtual)) return; // evita duplicar
                const codigo = idAtual.replace('envio-', '').slice(-4);
                mapa.set(idAtual, {
                    id: idAtual,
                    codigo,
                    clienteId: p.clienteId || uid,
                    destinatario: p.destinatario || p.cliente || 'Cliente',
                    whatsapp: p.whatsapp || '--',
                    cidade: (p.cidadeDestino || p.cidade || extrairCidadeEnderecoSimples(p.destinoEndereco || p.destino || '')).toString(),
                    servico: p.servico || 'Standard',
                    veiculo: p.veiculo || 'Moto',
                    tamanho: p.tamanho || '--',
                    valorFrete: Number.isFinite(Number(p.valorFrete)) ? Number(p.valorFrete) : parseMoedaParaNumero(p.valor || 0),
                    distanciaKm: Number.isFinite(Number(p.distanciaKm)) ? Number(p.distanciaKm) : null,
                    duracaoMin: Number.isFinite(Number(p.duracaoMin)) ? Number(p.duracaoMin) : null,
                    valorConteudo: Number.isFinite(Number(p.valorConteudo)) ? Number(p.valorConteudo) : null,
                    descricao: (p.descricao || '').toString().trim(),
                    observacoes: (p.observacoes || '').toString().trim(),
                    origemEndereco: p.origemEndereco || p.origem || '--',
                    destinoEndereco: p.destinoEndereco || p.destino || '--',
                    status: (p.status || p.statusRaw || 'PACOTE_NOVO').toUpperCase(),
                    criadoEm: Number(p.criadoEm || Date.now())
                });
            });
        });
    }
    return mapa;
}

function getPacotesDaRota(rota) {
    const ids = Array.isArray(rota?.pacoteIds) ? rota.pacoteIds : (Array.isArray(rota?.pacotes) ? rota.pacotes : []);
    const mapa = montarMapaEnviosPorId();
    return ids.map((id) => mapa.get(id)).filter(Boolean);
}

async function carregarRotasDoBanco() {
    const uid = getUsuarioIdAtual();
    if (!uid) return [];
    try {
        const snap = await db.ref('usuarios/' + uid + '/rotas').once('value');
        const data = snap.val() || {};
        return Object.keys(data).map((id) => ({ id, ...data[id] })).sort((a, b) => Number(b.criadoEm || 0) - Number(a.criadoEm || 0));
    } catch (err) {
        console.warn('Falha ao carregar rotas:', err);
        return [];
    }
}
function montarCidadeUfMarketplace(cidade, uf) {
    const c = (cidade || '').toString().trim();
    const u = normalizarUf(uf || '');
    if (c && u) return `${c}, ${u}`;
    return c || '--';
}

function obterCidadeDestinoPacoteMarketplace(pacote = {}) {
    const cidadeDireta = (pacote?.cidade || '').toString().trim();
    if (cidadeDireta) return cidadeDireta;

    const destino = (pacote?.destino || pacote?.destinoEndereco || '').toString().trim();
    if (!destino) return '';

    const antesUf = destino.includes('/') ? destino.split('/')[0] : destino;
    const partesVirgula = antesUf.split(',').map((p) => p.trim()).filter(Boolean);
    if (partesVirgula.length) {
        const ultima = partesVirgula[partesVirgula.length - 1];
        if (ultima) return ultima.replace(/\)$/g, '').trim();
    }

    const partesTraco = destino.split('-').map((p) => p.trim()).filter(Boolean);
    return partesTraco.length ? partesTraco[partesTraco.length - 1] : '';
}

function extrairCidadeEnderecoSimples(destino = '') {
    let txt = (destino || '').toString().trim();
    if (!txt) return '';
    // remove complemento entre parênteses
    txt = txt.replace(/\(.*?\)/g, '').trim();
    // se tiver UF com slash, mantém só antes do slash
    if (txt.includes('/')) txt = txt.split('/')[0].trim();
    // se tiver vírgula, fica com a parte antes da primeira vírgula (cidade)
    if (txt.includes(',')) txt = txt.split(',')[0].trim();
    // se tiver traço, pega o último segmento (geralmente cidade quando endereço tem "Rua - Bairro - Cidade")
    if (txt.includes('-')) {
        const partes = txt.split('-').map((p) => p.trim()).filter(Boolean);
        if (partes.length) txt = partes[partes.length - 1];
    }
    // remove códigos/UF de 2 letras no fim
    txt = txt.replace(/\b[A-Z]{2}\b$/g, '').trim();
    return txt;
}

async function carregarPacotesRaizDoUid(uid) {
    if (!uid) return;
    try {
        const snap = await db.ref(`pacotes/${uid}`).once('value');
        if (!window.pacotesRaizCache) window.pacotesRaizCache = {};
        window.pacotesRaizCache[uid] = snap.exists() ? (snap.val() || {}) : {};
    } catch (err) {
        console.warn('Falha ao carregar pacotes raiz', err);
    }
}

function montarMapaPacotesUsuarioMarketplace(clientesNo = {}) {
    const mapa = new Map();
    const listaClientes = Object.keys(clientesNo || {}).map((id) => ({ id, ...(clientesNo[id] || {}) }));

    listaClientes.forEach((cliente) => {
        const historico = Array.isArray(cliente?.historico) ? cliente.historico : [];
        const cidadeCliente = (cliente?.cidade || extrairCamposEnderecoCliente(cliente || {}).cidade || '').trim();

        historico.forEach((h, idx) => {
            const idEnvio = h?.id || ('envio-' + cliente.id + '-' + idx);
            mapa.set(idEnvio, {
                id: idEnvio,
                clienteNome: (h?.destinatario || cliente?.nome || 'Cliente').toString().trim(),
                cidade: (h?.cidadeDestino || h?.cidade || cidadeCliente || '').toString().trim(),
                destino: (h?.destinoEndereco || montarEnderecoParaCalculo(cliente, cliente?.endereco || '') || '').toString().trim(),
                servico: (h?.servico || 'Standard').toString().trim(),
                status: normalizarStatusPacoteEntrega(h?.status || 'PENDENTE'),
                distanciaKm: Number.isFinite(Number(h?.distanciaKm)) ? Number(h.distanciaKm) : 0,
                duracaoMin: Number.isFinite(Number(h?.duracaoMin)) ? Number(h.duracaoMin) : 0,
                valorFrete: Number.isFinite(Number(h?.valorFrete)) ? Number(h.valorFrete) : parseMoedaParaNumero(h?.valor || 0)
            });
        });
    });

    // modelo novo: /pacotes/{uid}/...
    if (window.pacotesRaizCache && typeof window.pacotesRaizCache === 'object') {
        Object.keys(window.pacotesRaizCache).forEach((uid) => {
            const pacs = window.pacotesRaizCache[uid] || {};
            Object.keys(pacs).forEach((pid) => {
                const p = pacs[pid] || {};
                mapa.set(pid, {
                    id: pid,
                    clienteNome: (p.destinatario || p.cliente || 'Cliente').toString().trim(),
                    cidade: (p.cidadeDestino || p.cidade || '').toString().trim(),
                    destino: (p.destinoEndereco || p.destino || '').toString().trim(),
                    servico: (p.servico || 'Standard').toString().trim(),
                    status: normalizarStatusPacoteEntrega(p.status || 'PENDENTE'),
                    distanciaKm: Number.isFinite(Number(p.distanciaKm)) ? Number(p.distanciaKm) : 0,
                    duracaoMin: Number.isFinite(Number(p.duracaoMin)) ? Number(p.duracaoMin) : 0,
                    valorFrete: Number.isFinite(Number(p.valorFrete)) ? Number(p.valorFrete) : parseMoedaParaNumero(p.valor || 0)
                });
            });
        });
    }

    return mapa;
}

async function carregarMarketplaceRotasEntregador() {
    try {
        const snap = await db.ref('usuarios').once('value');
        const usuariosNo = snap.val() || {};
        // carrega /pacotes raiz uma vez para composição
        try {
            const snapPac = await db.ref('pacotes').once('value');
            window.pacotesRaizCache = snapPac?.val ? (snapPac.val() || {}) : {};
        } catch (_) {
            window.pacotesRaizCache = window.pacotesRaizCache || {};
        }
        const lista = [];

        Object.keys(usuariosNo).forEach((uid) => {
            const usuario = usuariosNo[uid] || {};
            const tipo = normalizarTexto(usuario?.tipo || 'loja');
            if (tipo === 'entregador' || tipo === 'entrega') return;

            const rotasNo = usuario?.rotas || {};
            const rotaIds = Object.keys(rotasNo || {});
            if (!rotaIds.length) return;

            const lojistaNome = (usuario?.nome || usuario?.loja || 'Lojista').toString().trim() || 'Lojista';
            const origemCidade = (usuario?.endereco?.cidade || '').toString().trim();
            const origemUf = normalizarUf(usuario?.endereco?.uf || usuario?.endereco?.estado || '');
            const origemLabel = montarCidadeUfMarketplace(origemCidade, origemUf);

            const mapaPacotes = montarMapaPacotesUsuarioMarketplace(usuario?.clientes || {});

            rotaIds.forEach((rotaId) => {
            const rota = { id: rotaId, ...(rotasNo[rotaId] || {}) };
            const statusNorm = normalizarStatusRotaFiltro(rota?.status || rota?.pagamentoStatus || 'CRIADA');
            const statusVisual = getStatusVisualRota(statusNorm);

                const pacoteIds = Array.isArray(rota?.pacoteIds)
                    ? rota.pacoteIds
                    : (Array.isArray(rota?.pacotes) ? rota.pacotes : []);
                const pacotes = pacoteIds.map((idEnvio) => mapaPacotes.get(idEnvio)).filter(Boolean);

                const destinos = [...new Set(
                    pacotes
                        .map((p) => obterCidadeDestinoPacoteMarketplace(p))
                        .filter(Boolean)
                        .map((c) => c.trim())
                )];

                const qtdDestinos = destinos.length;
                const destinoPrincipal = qtdDestinos > 1 ? 'Multi-cidades' : (destinos[0] || '--');
                const totalPacotes = Number(rota?.quantidade || pacotes.length || 0);

                const totalFrete = Number.isFinite(Number(rota?.totalFrete))
                    ? Number(rota.totalFrete)
                    : pacotes.reduce((acc, p) => acc + Number(p?.valorFrete || 0), 0);
                const distanciaTotal = pacotes.reduce((acc, p) => acc + Number(p?.distanciaKm || 0), 0);
                const duracaoTotal = pacotes.reduce((acc, p) => acc + Number(p?.duracaoMin || 0), 0);

                const temFlash = pacotes.some((p) => {
                    const serv = normalizarTexto(p?.servico || '');
                    return serv.includes('flash') || serv.includes('expresso');
                });
                const servicoLabel = temFlash ? 'Expresso' : 'Padrao';

                lista.push({
                    id: rota.id,
                    lojistaUid: uid,
                    lojistaNome,
                    lojistaLogo: (usuario?.logo || usuario?.foto || ''),
                    origemCidade: origemCidade || '--',
                    origemLabel,
                    destinoPrincipal,
                    destinos,
                    totalPacotes,
                    totalFrete,
                    distanciaTotal,
                    duracaoTotal,
                    statusNorm,
                    statusVisual,
                    servicoLabel,
                    entregadorId: String(rota?.entregadorId || rota?.aceitoPor || ''),
                    pacoteIds,
                    criadoEm: Number(rota?.criadoEm || 0)
                });
            });
        });

        const ordemStatus = { BUSCANDO: 0, EM_ROTA: 1, CONCLUIDO: 2, CANCELADO: 3 };
        return lista.sort((a, b) => {
            const oa = ordemStatus[a.statusNorm] ?? 99;
            const ob = ordemStatus[b.statusNorm] ?? 99;
            if (oa !== ob) return oa - ob;
            return Number(b.criadoEm || 0) - Number(a.criadoEm || 0);
        }).map((r) => ({ ...r }));
    } catch (err) {
        console.warn('Falha ao carregar marketplace de rotas para entregador:', err);
        return [];
    }
}

function pararListenerMarketplaceEntregador() {
    if (marketplaceEntregadorListenerRef && marketplaceEntregadorListenerCb) {
        marketplaceEntregadorListenerRef.off('value', marketplaceEntregadorListenerCb);
    }
    marketplaceEntregadorListenerRef = null;
    marketplaceEntregadorListenerCb = null;
}

function iniciarListenerMarketplaceEntregador() {
    if (!usuarioEhEntregador()) return;
    if (marketplaceEntregadorListenerRef) return;

    const ref = db.ref('usuarios');
    const callback = async () => {
        rotasMarketplaceEntregadorCache = await carregarMarketplaceRotasEntregador();
        if (document.getElementById('view-buscar')?.classList.contains('active')) {
            atualizarListaBuscaEntregador();
        }
    };

    ref.on('value', callback);
    marketplaceEntregadorListenerRef = ref;
    marketplaceEntregadorListenerCb = callback;
}

function rotaMarketplacePassaNoFiltro(rota) {
    const origemAlvo = normalizarTexto(filtroRotaEntregadorOrigem || 'TODAS');
    const destinoAlvo = normalizarTexto(filtroRotaEntregadorDestino || 'TODAS');

    const passouOrigem = origemAlvo === 'todas' || normalizarTexto(rota?.origemCidade || '') === origemAlvo;
    const passouDestino = destinoAlvo === 'todas'
        || normalizarTexto(rota?.destinoPrincipal || '') === destinoAlvo
        || (Array.isArray(rota?.destinos) && rota.destinos.some((c) => normalizarTexto(c) === destinoAlvo));

    return passouOrigem && passouDestino;
}

// Cabeçalho global (logo + chip + sino) a partir do template em index.html.
// Usa chip só para entregador.
function renderHeaderGlobal(tipoUsuario = '', saldo = 0) {
    const tpl = document.getElementById('ui-global-header-template');
    const isEntregador = normalizarTexto(tipoUsuario) === 'entregador';

    const buildInline = () => {
        const chipHtml = isEntregador
            ? `<button type="button" class="entregador-wallet-chip gh-chip"><span>${precoParaMoeda(Number(saldo) || 0)}</span></button>`
            : '';
        return `
            <div class="global-header">
                <div class="gh-left">
                    <img src="img/logoflexa.png" alt="Flexa" class="gh-logo">
                </div>
                <div class="gh-actions">
                    ${chipHtml}
                    <div class="entregador-bell gh-bell" onclick="abrirPainelNotificacoes()">
                        <i data-lucide="bell" size="18"></i>
                        <span class="dot"></span>
                    </div>
                </div>
            </div>
        `;
    };

    if (!tpl || !tpl.content || !tpl.content.firstElementChild) {
        return buildInline();
    }

    const node = tpl.content.firstElementChild.cloneNode(true);
    const chip = node.querySelector('.gh-chip');
    if (!isEntregador && chip) {
        chip.remove();
    } else if (isEntregador && chip) {
        const span = chip.querySelector('span');
        if (span) span.textContent = precoParaMoeda(Number(saldo) || 0);
    }
    return node.outerHTML || buildInline();
}

// ===== [NOTIFICAÇÕES] =====
let notificacoesCache = [];
let notificacoesListenerRef = null;
let notificacoesListenerCb = null;

async function criarNotificacao(destinoUid, { tipo = 'info', titulo = '', mensagem = '', rotaId = '' } = {}) {
    if (!destinoUid) return;
    try {
        const ref = db.ref(`usuarios/${destinoUid}/notificacoes`).push();
        await ref.set({
            id: ref.key,
            tipo,
            titulo,
            mensagem,
            rotaId: rotaId || '',
            lida: false,
            criadoEm: Date.now()
        });
    } catch (err) {
        console.warn('Falha ao criar notificação:', err);
    }
}

function pararListenerNotificacoes() {
    if (notificacoesListenerRef && notificacoesListenerCb) {
        notificacoesListenerRef.off('value', notificacoesListenerCb);
    }
    notificacoesListenerRef = null;
    notificacoesListenerCb = null;
    notificacoesCache = [];
}

function iniciarListenerNotificacoes() {
    const uid = getUsuarioIdAtual();
    if (!uid || notificacoesListenerRef) return;

    // Mostra sempre as 10 notificações mais recentes (lidas ou não) — as mais antigas
    // somem da lista sozinhas conforme novas chegam, sem precisar marcar/limpar nada.
    const ref = db.ref(`usuarios/${uid}/notificacoes`).limitToLast(10);
    const callback = (snap) => {
        const data = snap.val() || {};
        notificacoesCache = Object.keys(data)
            .map((id) => ({ id, ...data[id] }))
            .sort((a, b) => Number(b?.criadoEm || 0) - Number(a?.criadoEm || 0));
        atualizarBadgeNotificacoes();
        const overlay = document.getElementById('overlay-notificacoes');
        if (overlay && overlay.style.display === 'flex') {
            renderListaNotificacoes();
        }
    };
    ref.on('value', callback);
    notificacoesListenerRef = ref;
    notificacoesListenerCb = callback;
}

function atualizarBadgeNotificacoes() {
    const naoLidas = notificacoesCache.filter((n) => !n?.lida).length;
    document.querySelectorAll('.gh-bell').forEach((bell) => {
        bell.classList.toggle('has-unread', naoLidas > 0);
    });
}

function formatarHoraNotificacao(ts) {
    const n = Number(ts || 0);
    if (!n) return '';
    const d = new Date(n);
    const hoje = new Date();
    const mesmoDia = d.toDateString() === hoje.toDateString();
    return mesmoDia
        ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function renderListaNotificacoes() {
    const lista = document.getElementById('notificacoes-lista');
    if (!lista) return;

    if (!notificacoesCache.length) {
        lista.innerHTML = '<div class="notificacoes-empty">Nenhuma notificação por enquanto.</div>';
        return;
    }

    lista.innerHTML = notificacoesCache.map((n) => `
        <button type="button" class="notificacao-item ${n.lida ? '' : 'nao-lida'}" onclick="abrirNotificacao('${String(n.id).replace(/'/g, "\\'")}')">
            <strong>${escapeHtmlChat(n.titulo || 'Notificação')}</strong>
            <p>${escapeHtmlChat(n.mensagem || '')}</p>
            <small>${formatarHoraNotificacao(n.criadoEm)}</small>
        </button>
    `).join('');

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function marcarNotificacaoLida(notifId) {
    const uid = getUsuarioIdAtual();
    if (!uid || !notifId) return;
    try {
        await db.ref(`usuarios/${uid}/notificacoes/${notifId}/lida`).set(true);
    } catch (err) {
        console.warn('Falha ao marcar notificação como lida:', err);
    }
}

async function marcarTodasNotificacoesLidas() {
    const uid = getUsuarioIdAtual();
    if (!uid) return;
    const naoLidas = notificacoesCache.filter((n) => !n?.lida);
    if (!naoLidas.length) return;
    const updates = {};
    naoLidas.forEach((n) => {
        updates[`usuarios/${uid}/notificacoes/${n.id}/lida`] = true;
    });
    try {
        await db.ref().update(updates);
    } catch (err) {
        console.warn('Falha ao marcar notificações como lidas:', err);
    }
}

function abrirNotificacao(notifId) {
    const notif = notificacoesCache.find((n) => String(n.id) === String(notifId));
    if (!notif) return;
    marcarNotificacaoLida(notifId);
    if (notif.rotaId) {
        fecharPainelNotificacoes();
        if (usuarioEhEntregador()) {
            if (typeof abrirSheetRotaEntregadorHome === 'function') abrirSheetRotaEntregadorHome(notif.rotaId);
        } else if (typeof abrirModalTrackingLoja === 'function') {
            abrirModalTrackingLoja(notif.rotaId);
        }
    }
}

function abrirPainelNotificacoes() {
    const overlay = document.getElementById('overlay-notificacoes');
    if (!overlay) return;
    renderListaNotificacoes();
    overlay.style.display = 'flex';
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function fecharPainelNotificacoes() {
    const overlay = document.getElementById('overlay-notificacoes');
    if (overlay) overlay.style.display = 'none';
}

function limparHeaderGlobalEmView(viewId) {
    const view = document.getElementById(viewId);
    if (!view) return;
    view.querySelectorAll('.global-header.global-header-live').forEach((el) => el.remove());
}

function aplicarHeaderGlobalEmViewEstatica(viewId, tipoUsuario = '') {
    if (viewId === 'view-perfil' || viewId === 'view-perfil-entregador') {
        limparHeaderGlobalEmView(viewId);
        return;
    }

    const view = document.getElementById(viewId);
    if (!view) return;

    limparHeaderGlobalEmView(viewId);

    const saldo = Number(window.usuarioLogado?.financeiro?.saldo || 0);
    const html = renderHeaderGlobal(tipoUsuario, saldo);
    if (!html) return;

    view.insertAdjacentHTML('afterbegin', html);
    const header = view.querySelector('.global-header');
    if (header) header.classList.add('global-header-live');
}

function montarCardBuscaEntregador(rota) {
    const destinos = Array.isArray(rota?.destinos) ? rota.destinos : [];
    const qtdDestinos = Math.max(1, destinos.length);
    const badgeTxt = `${rota.servicoLabel || "Servico"} • ${qtdDestinos} destino${qtdDestinos > 1 ? "s" : ""}`;
    const precoTxt = precoParaMoeda(Number(rota?.totalFrete || 0));
    const logo = (rota?.lojistaLogo || "").toString().trim();
    const rotaIdEsc = escaparHtmlMarketplace(String(rota?.id || ''));
    const lojistaUidEsc = escaparHtmlMarketplace(String(rota?.lojistaUid || ''));
    const avatar = logo
        ? `<img src="${escaparHtmlMarketplace(logo)}" alt="${escaparHtmlMarketplace(rota?.lojistaNome || "Loja")}" class="buscar-rota-avatar-img">`
        : `<div class="buscar-rota-avatar-fallback">${escaparHtmlMarketplace((rota?.lojistaNome || "L").slice(0, 1).toUpperCase())}</div>`;
    return `
        <article class="buscar-rota-card" onclick="abrirSheetBuscaRota('${rotaIdEsc}', '${lojistaUidEsc}')">
            <div class="buscar-rota-left">
                <div class="buscar-rota-avatar">${avatar}</div>
                <div>
                    <div class="buscar-rota-title">${escaparHtmlMarketplace(rota?.lojistaNome || "Loja")}</div>
                    <div class="buscar-rota-meta">${escaparHtmlMarketplace(badgeTxt)}</div>
                </div>
            </div>
            <div class="buscar-rota-price">${escaparHtmlMarketplace(precoTxt)}</div>
        </article>
    `;
}

function abrirSheetBuscaRota(rotaId, lojistaUid) {
    const overlay = document.getElementById('buscar-sheet-overlay');
    const content = document.getElementById('buscar-sheet-content');
    if (!overlay || !content) return;

    const rota = (rotasMarketplaceEntregadorCache || []).find((r) => String(r.id) === String(rotaId) && String(r.lojistaUid) === String(lojistaUid));
    if (!rota) {
        content.innerHTML = '<div class="buscar-empty">Rota não encontrada.</div>';
        overlay.classList.remove('hidden');
        return;
    }

    const destinos = Array.isArray(rota.destinos) ? rota.destinos : [];
    const qtdDestinos = Math.max(1, destinos.length);
    const badgeTxt = rota.servicoLabel || 'Padrão';
    const precoTxt = precoParaMoeda(Number(rota.totalFrete || 0));
    const distanciaTxt = formatarDistancia(Number(rota.distanciaTotal || 0));
    const duracaoTxt = formatarDuracao(Number(rota.duracaoTotal || 0));
    const pacotesTxt = `${Number(rota.totalPacotes || 0)} Pacotes`;
    const paradasTxt = `${qtdDestinos} Parada${qtdDestinos > 1 ? 's' : ''}`;
    const origemTxt = rota.origemLabel || 'Origem não informada';
    const destinoTxt = rota.destinoPrincipal || (destinos[0] || 'Destino não informado');
    const logo = (rota?.lojistaLogo || "").toString().trim();
    const avatar = logo
        ? `<img src="${escaparHtmlMarketplace(logo)}" alt="${escaparHtmlMarketplace(rota?.lojistaNome || "Loja")}" />`
        : `<span>${escaparHtmlMarketplace((rota?.lojistaNome || 'L').slice(0,1).toUpperCase())}</span>`;

    content.innerHTML = `
        <div class="sheet-header">
        <div class="sheet-merchant">
            <div class="sheet-merchant-logo">${avatar}</div>
            <div class="sheet-merchant-info">
                <strong>${escaparHtmlMarketplace(rota?.lojistaNome || 'Lojista')}</strong>
                <small>Rota #${escaparHtmlMarketplace(String(rota.id || ''))}</small>
                <div class="sheet-badge"><i data-lucide="badge-check" size="14"></i>${escaparHtmlMarketplace(badgeTxt)}</div>
            </div>
        </div>
        <div class="sheet-price">
            ${escaparHtmlMarketplace(precoTxt)}
        </div>
        <button class="sheet-close-btn" onclick="fecharSheetBuscar()">×</button>
    </div>

    <div class="sheet-meta-grid">
            <div class="sheet-meta-item"><i data-lucide="navigation" size="16"></i> ${escaparHtmlMarketplace(distanciaTxt)}</div>
        <div class="sheet-meta-item"><i data-lucide="clock-3" size="16"></i> ${escaparHtmlMarketplace(duracaoTxt)}</div>
        <div class="sheet-meta-item"><i data-lucide="package" size="16"></i> ${escaparHtmlMarketplace(pacotesTxt)}</div>
        <div class="sheet-meta-item"><i data-lucide="map" size="16"></i> ${escaparHtmlMarketplace(paradasTxt)}</div>
    </div>

    <div class="sheet-block">
        <strong><i data-lucide="map-pin" size="16"></i> Origem → Destino</strong>
        <p>${escaparHtmlMarketplace(origemTxt)} → ${escaparHtmlMarketplace(destinoTxt)}</p>
    </div>

    <div class="sheet-actions">
            <button class="sheet-accept-btn" onclick="fecharSheetBuscar(); aceitarRotaMarketplaceEntregador('${escaparHtmlMarketplace(String(rota.lojistaUid || ''))}', '${escaparHtmlMarketplace(String(rota.id || ''))}')">
                ✓ Aceitar
            </button>
        </div>
    `;

    overlay.classList.remove('hidden');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function fecharSheetBuscar() {
    const overlay = document.getElementById('buscar-sheet-overlay');
    const content = document.getElementById('buscar-sheet-content');
    if (overlay) overlay.classList.add('hidden');
    if (content) content.innerHTML = '';
}

function montarOptionsDropdownBusca(cidades, valorAtual, labelPadrao) {
    const atualNorm = (valorAtual || 'TODAS').toString();
    const opcoes = ['TODAS', ...cidades];
    return opcoes.map((cidade) => {
        const label = cidade === 'TODAS' ? labelPadrao : cidade;
        const ativo = cidade === atualNorm ? 'is-active' : '';
        return `<div class="buscar-dropdown-option ${ativo}" data-value="${escaparHtmlMarketplace(cidade)}" role="option">${escaparHtmlMarketplace(label)}</div>`;
    }).join('');
}

function montarDropdownFiltroMarketplace(id, tipo, cidades, valorAtual, labelPadrao) {
    const atualNorm = (valorAtual || 'TODAS').toString();
    const labelAtual = atualNorm === 'TODAS' ? labelPadrao : atualNorm;
    return `
        <div class="buscar-dropdown" data-filter="${tipo}" data-target="${id}">
            <button type="button" class="buscar-dropdown-toggle" aria-haspopup="listbox" aria-expanded="false">
                <span class="buscar-dropdown-value">${escaparHtmlMarketplace(labelAtual)}</span>
                <span class="buscar-dropdown-arrow" aria-hidden="true"></span>
            </button>
            <div class="buscar-dropdown-menu" role="listbox">
                ${montarOptionsDropdownBusca(cidades, valorAtual, labelPadrao)}
            </div>
        </div>
        <select id="${id}" class="buscar-select buscar-select-native" onchange="aplicarFiltroRotaEntregador('${tipo}', this.value)">
            ${montarOptionsFiltroMarketplace(cidades, valorAtual, labelPadrao)}
        </select>
    `;
}

function montarCardMarketplaceRotaEntregador(rota) {
    const qtdDestinos = Math.max(1, Number(rota?.destinos?.length || 0));
    const badgeTxt = `${rota.servicoLabel} • ${qtdDestinos} destino${qtdDestinos > 1 ? 's' : ''}`;
    const precoTxt = precoParaMoeda(Number(rota?.totalFrete || 0));
    const statusClass = String(rota?.statusVisual?.className || '').replace('rota-main-status ', '');

    const idEsc = String(rota?.id || '').replace(/'/g, "\\'");
    const lojistaUidEsc = String(rota?.lojistaUid || '').replace(/'/g, "\\'");
    const rotaDisponivel = rota?.statusNorm === 'BUSCANDO' && !String(rota?.entregadorId || '').trim();
    const textoBotao = rotaDisponivel ? 'Aceitar' : (rota?.statusNorm === 'EM_ROTA' ? 'Em rota' : 'Indisponivel');

    return `
        <article class="entregador-rota-card">
            <div class="entregador-rota-avatar"><i data-lucide="package"></i></div>
            <div class="entregador-rota-info">
                <div class="entregador-rota-lojista">${escaparHtmlMarketplace(rota.lojistaNome)}</div>
                <span class="entregador-rota-badge">${escaparHtmlMarketplace(badgeTxt)}</span>
                <div class="entregador-rota-meta">${escaparHtmlMarketplace(rota.origemLabel)} → ${escaparHtmlMarketplace(rota.destinoPrincipal)} • ${formatarDistancia(rota.distanciaTotal)} • ${formatarDuracao(rota.duracaoTotal)}</div>
                <div class="entregador-rota-meta">Rota ${escaparHtmlMarketplace(rota.id)} • ${Number(rota.totalPacotes || 0)} pacote(s)</div>
            </div>
            <div class="entregador-rota-actions">
                <span class="entregador-rota-status ${escaparHtmlMarketplace(statusClass)}">${escaparHtmlMarketplace(rota?.statusVisual?.label || 'BUSCANDO')}</span>
                <div class="entregador-rota-preco">${escaparHtmlMarketplace(precoTxt)}</div>
                <button type="button" class="entregador-rota-accept-btn" ${rotaDisponivel ? '' : 'disabled'} onclick="aceitarRotaMarketplaceEntregador('${lojistaUidEsc}', '${idEsc}', this)">${textoBotao}</button>
            </div>
        </article>
    `;
}

function montarCardHistoricoRotaEntregador(rota) {
    const logo = (rota?.lojistaLogo || rota?.foto || '').toString().trim();
    const avatar = logo
        ? `<img src="${escaparHtmlMarketplace(logo)}" alt="${escaparHtmlMarketplace(rota?.lojistaNome || 'Loja')}" />`
        : `<span>${escaparHtmlMarketplace((rota?.lojistaNome || 'L').slice(0,1).toUpperCase())}</span>`;
    const statusClass = rota?.statusVisual?.className || '';
    const statusLabel = rota?.statusVisual?.label || rota?.statusNorm || '';
    const precoTxt = precoParaMoeda(Number(rota?.totalFrete || 0));
    const dataTxt = rota?.atualizadoEm
        ? new Date(rota.atualizadoEm).toLocaleDateString('pt-BR')
        : (rota?.criadoEm ? new Date(rota.criadoEm).toLocaleDateString('pt-BR') : '--');
    const rotaIdEsc = escaparHtmlMarketplace(String(rota.id || ''));
    return `
        <article class="rotas-ent-card" onclick="abrirSheetRotaEntregador('${rotaIdEsc}')">
            <div class="rotas-ent-left">
                <div class="rotas-ent-logo">${avatar}</div>
                <div class="rotas-ent-info">
                    <strong>${escaparHtmlMarketplace(rota?.lojistaNome || 'Lojista')}</strong>
                    <small>${escaparHtmlMarketplace(dataTxt)}</small>
                </div>
            </div>
            <div class="rotas-ent-right">
                <span class="rotas-ent-status ${escaparHtmlMarketplace(statusClass)}">${escaparHtmlMarketplace(statusLabel)}</span>
                <div class="rotas-ent-price">
                    ${escaparHtmlMarketplace(precoTxt)}
                </div>
            </div>
        </article>
    `;
}

async function garantirPacotesDaRota(rotaObj) {
    try {
        const ids = Array.isArray(rotaObj?.pacoteIds)
            ? rotaObj.pacoteIds
            : (Array.isArray(rotaObj?.pacotes) ? rotaObj.pacotes : []);
        const lojistaUid = rotaObj?.origemLojistaUid || rotaObj?.lojistaUid || rotaObj?.lojistaId || rotaObj?.uidLojista;
        if (!ids.length || !lojistaUid) return getPacotesDaRota(rotaObj);

        // carrega /usuarios/{lojistaUid}/pacotes se necessário
        if (!window.pacotesRaizCache || !window.pacotesRaizCache[lojistaUid]) {
            const snap = await db.ref(`usuarios/${lojistaUid}/pacotes`).once('value');
            window.pacotesRaizCache = window.pacotesRaizCache || {};
            window.pacotesRaizCache[lojistaUid] = snap.exists() ? (snap.val() || {}) : {};
        }

        // monta mapa com dados recém-carregados
        const mapa = new Map();
        const pacsLojista = window.pacotesRaizCache?.[lojistaUid] || {};
        Object.keys(pacsLojista).forEach((pid) => mapa.set(pid, pacsLojista[pid]));

        // também inclui mapa global que já existe
        const mapaGlobal = montarMapaEnviosPorId();
        mapaGlobal.forEach((v, k) => { if (!mapa.has(k)) mapa.set(k, v); });

        let pacotes = ids.map((id) => mapa.get(String(id))).filter(Boolean);

        // fallback: fetch individual pacotes se ainda não veio
        if (pacotes.length !== ids.length) {
            const restantes = ids.filter((id) => !mapa.get(String(id)));
            const fetched = await Promise.all(restantes.map(async (pid) => {
                try {
                    const snap = await db.ref(`usuarios/${lojistaUid}/pacotes/${pid}`).once('value');
                    return snap.exists() ? { id: pid, ...(snap.val() || {}) } : null;
                } catch (e) {
                    return null;
                }
            }));
            pacotes = pacotes.concat(fetched.filter(Boolean));
        }

        if (pacotes.length) return pacotes;
        // fallback final: se rota embute detalhes em rota.pacotesDetalhes
        if (Array.isArray(rotaObj?.pacotesDetalhes) && rotaObj.pacotesDetalhes.length) {
            return rotaObj.pacotesDetalhes;
        }
        return getPacotesDaRota(rotaObj);
    } catch (err) {
        console.warn('Falha ao garantir pacotes da rota', err);
        return getPacotesDaRota(rotaObj);
    }
}

async function garantirCodigosConfirmacaoEntrega(rotaObj, pacotes = []) {
    const lojistaUid = obterLojistaUidDaRota(rotaObj);
    if (!lojistaUid || !pacotes.length) return;

    const updates = {};
    pacotes.forEach((pac) => {
        if (obterCodigoConfirmacaoEsperado(pac)) return;
        const pacoteId = obterIdPacoteConfirmacao(pac);
        if (!pacoteId) return;
        const novoCodigo = gerarCodigoConfirmacaoEntrega();
        pac.codigoConfirmacaoEntrega = novoCodigo;
        updates[`usuarios/${lojistaUid}/pacotes/${pacoteId}/codigoConfirmacaoEntrega`] = novoCodigo;
    });

    if (Object.keys(updates).length) {
        try {
            await db.ref().update(updates);
        } catch (err) {
            console.warn('Falha ao gerar código de confirmação para pacote legado:', err);
        }
    }
}

async function obterLogoLojista(lojistaUid) {
    if (!lojistaUid) return '';
    if (lojistaLogoCache[lojistaUid]) return lojistaLogoCache[lojistaUid];
    try {
        const snap = await db.ref(`usuarios/${lojistaUid}/foto`).once('value');
        const foto = snap.exists() ? (snap.val() || '').toString() : '';
        lojistaLogoCache[lojistaUid] = foto;
        return foto;
    } catch (e) {
        return '';
    }
}

async function abrirSheetRotaEntregador(rotaId, opts = {}) {
    const overlay = document.getElementById('rotas-entregador-sheet-overlay');
    const content = document.getElementById('rotas-entregador-sheet-content');
    if (!overlay || !content) return;

    const rota = Object.entries(window.usuarioLogado?.rotas || {}).find(([id]) => String(id) === String(rotaId));
    if (!rota) {
        content.innerHTML = '<div class="buscar-empty">Rota não encontrada.</div>';
        overlay.classList.remove('hidden');
        return;
    }
    let rotaObj = { id: rota[0], ...(rota[1] || {}) };
    const lojistaUid = rotaObj?.origemLojistaUid || rotaObj?.lojistaUid || rotaObj?.lojistaId || rotaObj?.uidLojista;
    if (!rotaObj.lojistaLogo && lojistaUid) {
        const logo = await obterLogoLojista(lojistaUid);
        if (logo) rotaObj.lojistaLogo = logo;
    }
    rotaEntSheetRotaAtual = rotaObj;

    let pacotes = [];
    if (opts.refetchPacotes) {
        pacotes = await garantirPacotesDaRota(rotaObj);
    }
    if (!pacotes || !pacotes.length) {
        pacotes = prepararPacotesRotaEntregador(rotaObj);
    }
    rotaEntSheetPacotes = pacotes;
    await garantirCodigosConfirmacaoEntrega(rotaObj, rotaEntSheetPacotes);

    registrarEstadosPacotesRota(rotaObj.id, rotaEntSheetPacotes);
    const primeiroPendente = obterProximoIndicePacotePendente(rotaObj.id, rotaEntSheetPacotes, 0);
    rotaEntSheetIndex = primeiroPendente >= 0 ? primeiroPendente : 0;

    overlay.classList.remove('hidden');
    requestAnimationFrame(() => overlay.classList.add('show'));
    renderSheetRotaEntregadorConteudo();

    const statusAtual = normalizarStatusRotaFiltro(rotaObj?.status || rotaObj?.pagamentoStatus || 'CRIADA');
    if (statusAtual === 'EM_ROTA') {
        iniciarRastreioGpsEntregador(rotaObj);
    }
}

function fecharSheetRotaEntregador() {
    const overlay = document.getElementById('rotas-entregador-sheet-overlay');
    const content = document.getElementById('rotas-entregador-sheet-content');
    if (overlay) {
        overlay.classList.remove('show');
        setTimeout(() => overlay.classList.add('hidden'), 320);
    }
    if (content) content.innerHTML = '';
    rotaEntSheetPacotes = [];
    rotaEntSheetIndex = 0;
    rotaEntSheetRotaAtual = null;
    pararRastreioGpsEntregador();
}

// ===== [RASTREIO GPS DO ENTREGADOR] =====
// Enquanto o entregador está com a rota aberta (EM_ROTA), envia a localização real
// pro lojista acompanhar. Se o navegador/usuário não permitir geolocalização, falha
// em silêncio — o resto do app continua funcionando normalmente sem GPS.
let geoRastreioWatchId = null;
let geoRastreioUltimoEnvio = 0;
const GEO_RASTREIO_INTERVALO_MS = 15000;

function pararRastreioGpsEntregador() {
    if (geoRastreioWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(geoRastreioWatchId);
    }
    geoRastreioWatchId = null;
}

function iniciarRastreioGpsEntregador(rotaObj) {
    if (!navigator.geolocation || !usuarioEhEntregador()) return;

    const lojistaUid = obterLojistaUidDaRota(rotaObj, {});
    const rotaId = String(rotaObj?.id || '').trim();
    const uidEntregador = getUsuarioIdAtual();
    if (!lojistaUid || !rotaId || !uidEntregador) return;

    pararRastreioGpsEntregador();

    geoRastreioWatchId = navigator.geolocation.watchPosition(
        (pos) => {
            const agora = Date.now();
            if (agora - geoRastreioUltimoEnvio < GEO_RASTREIO_INTERVALO_MS) return;
            geoRastreioUltimoEnvio = agora;

            const payload = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                precisaoM: Math.round(pos.coords.accuracy || 0),
                atualizadoEm: agora
            };
            db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}/entregadorGeo`).set(payload).catch(() => {});
            db.ref(`usuarios/${uidEntregador}/rotas/${rotaId}/entregadorGeo`).set(payload).catch(() => {});
        },
        (err) => {
            console.warn('Geolocalização indisponível:', err?.message || err);
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
}

function prepararPacotesRotaEntregador(rotaObj = {}) {
    const pacotesMapa = getPacotesDaRota(rotaObj);
    if (pacotesMapa.length) return pacotesMapa;

    const destinos = Array.isArray(rotaObj.destinos) ? rotaObj.destinos.filter(Boolean) : [];
    const baseDestino = rotaObj.destinoPrincipal || destinos[0] || rotaObj.destino || '';
    const lista = destinos.length ? destinos : [baseDestino || '--'];

    return lista.map((dest, idx) => ({
        id: rotaObj.pacoteIds?.[idx] || rotaObj.pacotes?.[idx] || `pac-${rotaObj.id || 'local'}-${idx + 1}`,
        codigo: rotaObj.codigo || rotaObj.id || rotaObj.referencia || idx + 1,
        destinatario: rotaObj.destinatario || rotaObj.clienteNome || rotaObj.destinatarioNome || rotaObj.nomeCliente || 'Destinatário',
        destinoEndereco: rotaObj.destinoEndereco || dest,
        destinoCompleto: rotaObj.destinoCompleto || rotaObj.destinoEndereco || dest,
        destinoCep: rotaObj.destinoCep || rotaObj.cep || rotaObj.cepDestino || '',
        complemento: rotaObj.destinoComplemento || rotaObj.complemento || rotaObj.comp || '',
        cidade: rotaObj.destinoCidade || extrairCidadeEnderecoSimples(dest),
        bairro: rotaObj.destinoBairro || rotaObj.bairro || '',
        numero: rotaObj.destinoNumero || rotaObj.numero || '',
        uf: rotaObj.destinoUf || rotaObj.uf || rotaObj.estado || '',
        servico: rotaObj.servicoLabel || 'standard',
        distanciaKm: rotaObj.distanciaTotal || 0,
        duracaoMin: rotaObj.duracaoTotal || 0,
        observacoes: rotaObj.observacoes || '',
        destinoGeo: rotaObj.destinoGeo || rotaObj.destinoCoords || rotaObj.destinoLocalizacao || null
    }));
}

function montarEnderecoCompletoPacote(pac = {}, rotaObj = {}) {
    const candidatos = [
        pac.destinoCompleto,
        pac.enderecoCompleto,
        pac.enderecoEntrega,
        pac.enderecoDestino,
        pac.destinoEndereco,
        pac.destino,
        pac.endereco,
        pac.logradouro,
        rotaObj.destinoCompleto,
        rotaObj.destinoEndereco,
        rotaObj.endereco
    ].filter(Boolean);
    if (candidatos.length) return candidatos[0];

    const partes = [];
    const ruaNum = [
        pac.rua,
        pac.logradouro,
        rotaObj.rua,
        rotaObj.logradouro
    ].filter(Boolean).join(' ') || '';
    const numero = pac.numero || pac.destinoNumero || rotaObj.destinoNumero || pac.num || pac.houseNumber || '';
    const ruaNumFmt = [ruaNum.trim(), numero].filter(Boolean).join(', ');
    if (ruaNumFmt) partes.push(ruaNumFmt);

    const bairro = pac.bairro || pac.destinoBairro || rotaObj.destinoBairro || pac.bairroDestino || '';
    const cidade = pac.cidade || pac.destinoCidade || rotaObj.destinoCidade || pac.cidadeDestino || rotaObj.destinoPrincipal || '';
    const uf = normalizarUf(pac.uf || pac.destinoUf || rotaObj.destinoUf || pac.estado || '');
    const linhaCidade = [bairro, cidade].filter(Boolean).join(' - ');
    if (linhaCidade || uf) partes.push(`${linhaCidade}${uf ? `/${uf}` : ''}`.trim());
    const cepRaw = pac.cep || pac.destinoCep || rotaObj.destinoCep || rotaObj.cep || '';
    const cepFmt = formatarCep(cepRaw);
    if (cepFmt) partes.push(`CEP ${cepFmt}`);
    const comp = pac.complemento || pac.destinoComplemento || rotaObj.destinoComplemento || rotaObj.complemento || '';
    if (comp) partes.push(comp);
    return partes.filter(Boolean).join(' - ');
}

function getChavePacoteRota(rotaId, pac, fallbackIdx = 0) {
    return `${rotaId}-${pac?.id || pac?.codigo || pac?.codigoPacote || pac?.codigoEntrega || fallbackIdx}`;
}

function registrarEstadosPacotesRota(rotaId, pacotes = []) {
    if (!rotaId) return;
    if (!rotaEntregadorProgresso[rotaId]) rotaEntregadorProgresso[rotaId] = { pacotes: {} };
    const estado = rotaEntregadorProgresso[rotaId];
    pacotes.forEach((p, idx) => {
        const chave = getChavePacoteRota(rotaId, p, idx);
        const statusPacote = normalizarStatusEnvioFiltro(p?.statusRaw || p?.status || '');
        const concluido = statusPacote === 'ENTREGUE' || statusPacote === 'CANCELADO';
        const codigoPersistido = String(p?.codigoConfirmacaoEntrega || p?.codigoConfirmacao || '').trim();
        if (!estado.pacotes[chave]) {
            estado.pacotes[chave] = {
                status: concluido ? 'concluido' : 'pendente',
                codigoConfirmacao: codigoPersistido
            };
        } else if (concluido && estado.pacotes[chave].status !== 'concluido') {
            estado.pacotes[chave] = {
                ...estado.pacotes[chave],
                status: 'concluido',
                codigoConfirmacao: estado.pacotes[chave].codigoConfirmacao || codigoPersistido
            };
        }
    });
}

function obterEstadoPacoteRota(rotaId, pac, fallbackIdx = 0) {
    registrarEstadosPacotesRota(rotaId, [pac]);
    const chave = getChavePacoteRota(rotaId, pac, fallbackIdx);
    return rotaEntregadorProgresso[rotaId]?.pacotes?.[chave] || { status: 'pendente', codigoConfirmacao: '' };
}

function setEstadoPacoteRota(rotaId, pac, dados, fallbackIdx = 0) {
    registrarEstadosPacotesRota(rotaId, [pac]);
    const chave = getChavePacoteRota(rotaId, pac, fallbackIdx);
    const atual = rotaEntregadorProgresso[rotaId]?.pacotes?.[chave] || { status: 'pendente', codigoConfirmacao: '' };
    rotaEntregadorProgresso[rotaId].pacotes[chave] = { ...atual, ...dados };
}

function obterIdPacoteConfirmacao(pac = {}) {
    return String(pac?.id || pac?.codigo || pac?.codigoPacote || pac?.codigoEntrega || '').trim();
}

// Nome do destinatário do pacote — usado nas notificações em vez do ID do envio
// (mesma cadeia de fallback usada na tela de entrega, ver renderSheetRotaEntregadorConteudo).
function obterNomeDestinatarioPacote(pac = {}, rotaObj = {}) {
    return String(
        pac?.destinatario
        || pac?.destinatarioNome
        || pac?.cliente
        || pac?.nomeCliente
        || rotaObj?.destinatario
        || rotaObj?.destinatarioNome
        || rotaObj?.clienteNome
        || 'Destinatário'
    ).trim() || 'Destinatário';
}

function gerarCodigoConfirmacaoEntrega() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

function obterCodigoConfirmacaoEsperado(pac = {}) {
    return String(pac?.codigoConfirmacaoEntrega || '').trim();
}

function normalizarCodigoConfirmacaoEntrega(valor = '') {
    return String(valor || '')
        .trim()
        .replace(/^#/, '')
        .replace(/\s+/g, '')
        .toLowerCase();
}

function pacoteConcluidoOuCanceladoNoSheet(rotaId, pac, idx = 0) {
    const estado = obterEstadoPacoteRota(rotaId, pac, idx);
    if (estado.status === 'concluido') return true;
    const statusPac = normalizarStatusEnvioFiltro(pac?.statusRaw || pac?.status || '');
    return statusPac === 'ENTREGUE' || statusPac === 'CANCELADO';
}

function obterProximoIndicePacotePendente(rotaId, pacotes = [], startIdx = 0) {
    for (let i = startIdx; i < pacotes.length; i += 1) {
        if (!pacoteConcluidoOuCanceladoNoSheet(rotaId, pacotes[i], i)) return i;
    }
    for (let i = 0; i < startIdx; i += 1) {
        if (!pacoteConcluidoOuCanceladoNoSheet(rotaId, pacotes[i], i)) return i;
    }
    return -1;
}

function obterLojistaUidDaRota(rotaObj = {}, pac = {}) {
    return String(
        rotaObj?.origemLojistaUid
        || rotaObj?.lojistaUid
        || rotaObj?.lojistaId
        || rotaObj?.uidLojista
        || pac?.lojistaUid
        || pac?.usuarioUid
        || ''
    ).trim();
}

function obterEntregadorUidDaRota(rotaObj = {}) {
    return String(
        getUsuarioIdAtual()
        || rotaObj?.entregadorId
        || rotaObj?.aceitoPor
        || rotaObj?.entregadorUid
        || ''
    ).trim();
}

function calcularValorCreditoRota(rotaObj = {}, pacotes = []) {
    const candidatos = [
        rotaObj?.totalFrete,
        rotaObj?.valorTotal,
        rotaObj?.valor,
        rotaObj?.preco
    ];
    for (const v of candidatos) {
        const num = Number(v);
        if (Number.isFinite(num) && num > 0) return Number(num.toFixed(2));
        const moeda = parseMoedaParaNumero(v);
        if (Number.isFinite(moeda) && moeda > 0) return Number(moeda.toFixed(2));
    }

    const somaPacotes = (Array.isArray(pacotes) ? pacotes : []).reduce((acc, p) => {
        const freteNum = Number(p?.valorFrete);
        if (Number.isFinite(freteNum) && freteNum > 0) return acc + freteNum;
        const freteMoeda = parseMoedaParaNumero(p?.valor || p?.frete || 0);
        return acc + (Number.isFinite(freteMoeda) ? freteMoeda : 0);
    }, 0);
    return Number(somaPacotes.toFixed(2));
}

function atualizarWalletChipEntregadorUI(saldo = 0) {
    document.querySelectorAll('.entregador-wallet-chip span').forEach((el) => {
        el.textContent = precoParaMoeda(Number(saldo) || 0);
    });
}

async function creditarCarteiraEntregadorRotaFinalizada(rotaObj = {}, valorCredito = 0) {
    const rotaId = String(rotaObj?.id || '').trim();
    const uidEntregador = obterEntregadorUidDaRota(rotaObj);
    const lojistaUid = obterLojistaUidDaRota(rotaObj, {});
    const valor = Number(valorCredito || 0);
    if (!rotaId || !uidEntregador || !Number.isFinite(valor) || valor <= 0) {
        return { creditado: false, saldoAtualizado: Number(window.usuarioLogado?.financeiro?.saldo || 0) };
    }

    const agora = Date.now();
    // Trava contra crédito duplicado: lê-e-grava em vez de .transaction() (mesmo
    // motivo documentado em ajustarSaldoUsuario — .transaction() nesse app recebe
    // `null` mesmo quando já existe valor real, o que faria essa trava achar que
    // "ainda não foi creditado" e liberar um crédito duplicado). Ainda existe uma
    // janela pequena de corrida entre ler e gravar, mas esse evento (finalizar rota)
    // só dispara uma vez por ação do entregador, risco baixo na prática.
    const markerRef = db.ref(`usuarios/${uidEntregador}/rotas/${rotaId}/creditoEntregadorEfetuadoEm`);
    let markerJaExistia = false;
    try {
        const markerSnap = await markerRef.once('value');
        markerJaExistia = Boolean(markerSnap.val());
    } catch (err) {
        console.warn('Falha ao checar marcador de crédito da rota:', err);
        return { creditado: false, saldoAtualizado: Number(window.usuarioLogado?.financeiro?.saldo || 0) };
    }

    if (markerJaExistia) {
        return { creditado: false, saldoAtualizado: Number(window.usuarioLogado?.financeiro?.saldo || 0) };
    }

    await markerRef.set(agora);

    const resultadoSaldo = await ajustarSaldoUsuario(uidEntregador, valor);
    let saldoAtualizado = resultadoSaldo.ok ? resultadoSaldo.saldoDepois : Number(window.usuarioLogado?.financeiro?.saldo || 0);

    const updates = {
        [`usuarios/${uidEntregador}/financeiro/atualizadoEm`]: agora,
        [`usuarios/${uidEntregador}/rotas/${rotaId}/creditoEntregadorValor`]: valor,
        [`usuarios/${uidEntregador}/rotas/${rotaId}/creditoEntregadorEfetuadoEm`]: agora,
        [`usuarios/${uidEntregador}/rotas/${rotaId}/atualizadoEm`]: agora
    };
    if (lojistaUid) {
        updates[`usuarios/${lojistaUid}/rotas/${rotaId}/creditoEntregadorValor`] = valor;
        updates[`usuarios/${lojistaUid}/rotas/${rotaId}/creditoEntregadorEfetuadoEm`] = agora;
        updates[`usuarios/${lojistaUid}/rotas/${rotaId}/atualizadoEm`] = agora;
    }
    await db.ref().update(updates);
    await registrarTransacaoFinanceira('CREDITO', valor, `Rota ${rotaId} finalizada`);

    if (!window.usuarioLogado) window.usuarioLogado = {};
    window.usuarioLogado.financeiro = {
        ...(window.usuarioLogado.financeiro || {}),
        saldo: saldoAtualizado,
        atualizadoEm: agora
    };
    if (entregadorHomeCache) {
        entregadorHomeCache.financeiro = {
            ...(entregadorHomeCache.financeiro || {}),
            saldo: saldoAtualizado,
            atualizadoEm: agora
        };
    }
    pagamentoPerfilCache.saldo = saldoAtualizado;
    atualizarWalletChipEntregadorUI(saldoAtualizado);

    return { creditado: true, saldoAtualizado, valorCreditado: valor };
}

async function persistirEntregaPacoteAtual(rotaObj = {}, pac = {}, codigoConfirmacao = '') {
    const rotaId = String(rotaObj?.id || '').trim();
    const pacoteId = obterIdPacoteConfirmacao(pac);
    const lojistaUid = obterLojistaUidDaRota(rotaObj, pac);
    const uidEntregador = getUsuarioIdAtual();
    const agora = Date.now();
    const updates = {};

    if (!rotaId || !pacoteId) {
        throw new Error('Rota ou pacote inválido para confirmação.');
    }

    if (lojistaUid) {
        const basePacoteUsuario = `usuarios/${lojistaUid}/pacotes/${pacoteId}`;
        updates[`${basePacoteUsuario}/status`] = 'ENTREGUE';
        updates[`${basePacoteUsuario}/statusRaw`] = 'ENTREGUE';
        updates[`${basePacoteUsuario}/rotaId`] = rotaId;
        updates[`${basePacoteUsuario}/codigoConfirmacaoEntrega`] = codigoConfirmacao;
        updates[`${basePacoteUsuario}/entregueEm`] = agora;
        updates[`${basePacoteUsuario}/atualizadoEm`] = agora;
    }

    const todosPacotesConcluidos = rotaEntSheetPacotes.every((p, idx) => {
        if (idx === rotaEntSheetIndex) return true;
        return pacoteConcluidoOuCanceladoNoSheet(rotaId, p, idx);
    });

    const statusRota = todosPacotesConcluidos ? 'CONCLUIDO' : 'EM_ROTA';
    if (lojistaUid) {
        const rotaLojistaPath = `usuarios/${lojistaUid}/rotas/${rotaId}`;
        updates[`${rotaLojistaPath}/status`] = statusRota;
        updates[`${rotaLojistaPath}/pagamentoStatus`] = statusRota;
        updates[`${rotaLojistaPath}/atualizadoEm`] = agora;
        if (todosPacotesConcluidos) updates[`${rotaLojistaPath}/concluidaEm`] = agora;
    }
    if (uidEntregador) {
        const rotaEntregadorPath = `usuarios/${uidEntregador}/rotas/${rotaId}`;
        updates[`${rotaEntregadorPath}/status`] = statusRota;
        updates[`${rotaEntregadorPath}/pagamentoStatus`] = statusRota;
        updates[`${rotaEntregadorPath}/atualizadoEm`] = agora;
        if (todosPacotesConcluidos) updates[`${rotaEntregadorPath}/concluidaEm`] = agora;
    }

    if (lojistaUid) {
        try {
            const clientesSnap = await db.ref(`usuarios/${lojistaUid}/clientes`).once('value');
            const clientesNo = clientesSnap.val() || {};
            Object.keys(clientesNo).forEach((clienteId) => {
                const historico = Array.isArray(clientesNo[clienteId]?.historico) ? clientesNo[clienteId].historico : [];
                historico.forEach((h, idx) => {
                    const idAtual = String(h?.id || (`envio-${clienteId}-${idx}`));
                    if (idAtual !== pacoteId) return;
                    const baseHistorico = `usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}`;
                    updates[`${baseHistorico}/id`] = idAtual;
                    updates[`${baseHistorico}/status`] = 'ENTREGUE';
                    updates[`${baseHistorico}/statusRaw`] = 'ENTREGUE';
                    updates[`${baseHistorico}/rotaId`] = rotaId;
                    updates[`${baseHistorico}/codigoConfirmacaoEntrega`] = codigoConfirmacao;
                    updates[`${baseHistorico}/entregueEm`] = agora;
                    updates[`${baseHistorico}/atualizadoEm`] = agora;
                });
            });
        } catch (err) {
            console.warn('Falha ao sincronizar histórico do cliente na confirmação de entrega:', err);
        }
    }

    if (Object.keys(updates).length) {
        await db.ref().update(updates);
    }

    window.pacotesRaizCache = window.pacotesRaizCache || {};
    if (lojistaUid) {
        window.pacotesRaizCache[lojistaUid] = window.pacotesRaizCache[lojistaUid] || {};
        const atual = window.pacotesRaizCache[lojistaUid][pacoteId] || {};
        window.pacotesRaizCache[lojistaUid][pacoteId] = {
            ...atual,
            ...pac,
            id: pacoteId,
            status: 'ENTREGUE',
            statusRaw: 'ENTREGUE',
            rotaId,
            codigoConfirmacaoEntrega: codigoConfirmacao,
            entregueEm: agora,
            atualizadoEm: agora
        };
    }

    if (window.usuarioLogado?.rotas?.[rotaId]) {
        window.usuarioLogado.rotas[rotaId] = {
            ...(window.usuarioLogado.rotas[rotaId] || {}),
            status: statusRota,
            pagamentoStatus: statusRota,
            atualizadoEm: agora,
            ...(todosPacotesConcluidos ? { concluidaEm: agora } : {})
        };
    }
    if (entregadorHomeCache?.rotas?.[rotaId]) {
        entregadorHomeCache.rotas[rotaId] = {
            ...(entregadorHomeCache.rotas[rotaId] || {}),
            status: statusRota,
            pagamentoStatus: statusRota,
            atualizadoEm: agora,
            ...(todosPacotesConcluidos ? { concluidaEm: agora } : {})
        };
    }

    let creditoResumo = { creditado: false, saldoAtualizado: Number(window.usuarioLogado?.financeiro?.saldo || 0), valorCreditado: 0 };
    if (todosPacotesConcluidos) {
        const valorCredito = calcularValorCreditoRota(rotaObj, rotaEntSheetPacotes);
        try {
            creditoResumo = await creditarCarteiraEntregadorRotaFinalizada(rotaObj, valorCredito);
        } catch (err) {
            console.warn('Falha ao creditar carteira do entregador na conclusão da rota:', err);
        }
    }

    return { todosPacotesConcluidos, statusRota, ...creditoResumo };
}

function rotaSheetBloqueada() {
    if (!rotaEntSheetRotaAtual || !rotaEntSheetPacotes.length) return false;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    const estado = obterEstadoPacoteRota(rotaEntSheetRotaAtual.id, pac, rotaEntSheetIndex);
    const statusPac = normalizarStatusEnvioFiltro(pac?.statusRaw || pac?.status || '');
    if (statusPac === 'ENTREGUE' || statusPac === 'CANCELADO' || estado.status === 'concluido') return false;
    return estado.status === 'em_corrida' || statusPac === 'EM_ROTA';
}

// Nova versão do sheet de rota do entregador com paginação por pacote
function renderSheetRotaEntregadorConteudo() {
    const content = document.getElementById('rotas-entregador-sheet-content');
    if (!content || !rotaEntSheetRotaAtual) return;
    if (!rotaEntSheetPacotes.length) {
        content.innerHTML = '<div class=\"buscar-empty\">Nenhum pacote associado a esta rota.</div>';
        return;
    }
    const rotaObj = rotaEntSheetRotaAtual;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    const total = Math.max(1, rotaEntSheetPacotes.length);
    const statusNorm = normalizarStatusRotaFiltro(rotaObj?.status || rotaObj?.pagamentoStatus || 'CRIADA');
    const statusVisual = getStatusVisualRota(statusNorm);

    const logo = (pac?.lojistaLogo
        || rotaObj?.lojistaLogo
        || rotaObj?.foto
        || rotaObj?.lojistaFoto
        || rotaObj?.fotoLoja
        || '').toString().trim();
    const avatar = logo
        ? `<img src=\"${escaparHtmlMarketplace(logo)}\" alt=\"${escaparHtmlMarketplace(rotaObj?.lojistaNome || 'Loja')}\" />`
        : `<span>${escaparHtmlMarketplace((rotaObj?.lojistaNome || 'L').slice(0,1).toUpperCase())}</span>`;

    const servicoLabel = (pac?.servico || pac?.servicoLabel || rotaObj?.servicoLabel || 'standard').toString();
    const distanciaTxt = formatarDistancia(pac?.distanciaKm || rotaObj?.distanciaTotal || 0);
    const duracaoTxt = formatarDuracao(pac?.duracaoMin || rotaObj?.duracaoTotal || 0);
    const enderecoCompleto = montarEnderecoCompletoPacote(pac, rotaObj) || '--';
    const cidadeTxt = extrairCidadeEnderecoSimples(enderecoCompleto || pac?.cidade || rotaObj?.destinoPrincipal || pac?.cidadeDestino || '');
    const complemento = pac?.complemento || pac?.destinoComplemento || '';
    const cep = formatarCep(pac?.destinoCep || pac?.cep || pac?.cepDestino || rotaObj?.destinoCep || rotaObj?.cep);
    const obs = (pac?.observacoes || pac?.obs || '').trim();
    const pedidoId = pac?.id || pac?.codigo || pac?.codigoEntrega || pac?.codigoPacote || rotaObj?.codigo || rotaObj?.id || '-';
    const destinatarioNome = pac?.destinatario
        || pac?.destinatarioNome
        || pac?.cliente
        || pac?.nomeCliente
        || rotaObj?.destinatario
        || rotaObj?.destinatarioNome
        || rotaObj?.clienteNome
        || 'Destinatário';

    const estadoAtual = obterEstadoPacoteRota(rotaObj.id, pac, rotaEntSheetIndex);
    const bloqueado = rotaSheetBloqueada();
    const finalizado = estadoAtual.status === 'concluido';

    const dots = Array.from({ length: total }).map((_, idx) =>
        `<span class=\"ent-sheet-dot ${idx === rotaEntSheetIndex ? 'active' : ''} ${bloqueado ? 'locked' : ''}\"></span>`
    ).join('');

    const enderecoExtra = [complemento].filter(Boolean).join(' • ');
    const codeBox = `
        <div class=\"ent-sheet-code-box\">
            <label for=\"ent-sheet-code-input\">Confirme a entrega</label>
            <input id=\"ent-sheet-code-input\" type=\"text\" placeholder=\"Código de confirmação\" value=\"${escaparHtmlMarketplace(estadoAtual.codigoConfirmacao || '')}\" oninput=\"atualizarCodigoConfirmacaoAtual(this.value)\">
            <div class=\"ent-sheet-actions-inline\">
                <button type=\"button\" class=\"ent-sheet-primary small\" onclick=\"confirmarEntregaPacoteAtual()\">Confirmar entrega</button>
                <button type=\"button\" class=\"ent-sheet-btn-ghost\" onclick=\"cancelarCorridaPacoteAtual()\">Cancelar</button>
            </div>
        </div>
    `;

    const statusOk = `
        <div class=\"ent-sheet-status-ok\"><i data-lucide=\"check-circle-2\"></i> Entrega confirmada</div>
        ${estadoAtual.codigoConfirmacao ? `<div class=\"ent-sheet-code-pill\">Código ${escaparHtmlMarketplace(estadoAtual.codigoConfirmacao)}</div>` : ''}
    `;

    content.innerHTML = `
    <div class=\"sheet-buscar modal-ent-sheet\" style=\"background:#fff; border-radius:22px 22px 0 0; padding:18px 18px 20px 18px; box-shadow: 0 18px 36px rgba(0,0,0,0.20); width:100%;\" ontouchstart=\"iniciarSwipeEntSheet(event)\" ontouchend=\"finalizarSwipeEntSheet(event)\">
        <div class=\"ent-sheet-handle\"></div>
        <div class=\"ent-sheet-header\">
            <div class=\"ent-sheet-loja\">
                <div class=\"ent-sheet-avatar\">${avatar}</div>
                <div>
                    <div class=\"ent-sheet-loja-nome\">${escaparHtmlMarketplace(rotaObj?.lojistaNome || 'Lojista')}</div>
                    <div class=\"ent-sheet-loja-id\">Rota #${escaparHtmlMarketplace(String(rotaObj.id || ''))}</div>
                </div>
            </div>
            <div class=\"ent-sheet-servico\">${escaparHtmlMarketplace(servicoLabel)}</div>
        </div>
        <div class=\"ent-sheet-meta-row\">
            <div class=\"ent-sheet-meta-pill\"><i data-lucide=\"navigation\"></i><span>${escaparHtmlMarketplace(distanciaTxt)}</span></div>
            <div class=\"ent-sheet-meta-pill\"><i data-lucide=\"clock\"></i><span>${escaparHtmlMarketplace(duracaoTxt)}</span></div>
        </div>

        <div class=\"ent-sheet-destino\">
            <strong>${escaparHtmlMarketplace(destinatarioNome)}</strong>
            <div class=\"ent-sheet-pedido\">Pedido: #${escaparHtmlMarketplace(String(pedidoId))}</div>
            <div class=\"ent-sheet-endereco\">${escaparHtmlMarketplace(enderecoCompleto)}</div>
            ${enderecoExtra ? `<div class=\"ent-sheet-endereco-extra\">${escaparHtmlMarketplace(enderecoExtra)}</div>` : ''}
            ${obs ? `<div class=\"ent-sheet-obs\">Obs: ${escaparHtmlMarketplace(obs)}</div>` : ''}
        </div>

        <div class=\"ent-sheet-footer\">
            ${bloqueado ? codeBox : (finalizado ? statusOk : `<button class=\"ent-sheet-primary\" onclick=\"iniciarCorridaPacoteAtual(this)\"><span>Iniciar Corrida</span><span class=\"ent-sheet-arrow\" style=\"font-size:22px;\">›</span></button>`)}
            <button class=\"ent-sheet-link\" onclick=\"relatarProblemaRota()\">Relatar Problema</button>
            <div class=\"ent-sheet-nav-row\">
                <div class=\"ent-sheet-dots\">${dots}</div>
            </div>
        </div>
    </div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function entSheetPrev() {
    if (rotaEntSheetIndex <= 0) return;
    rotaEntSheetIndex -= 1;
    renderSheetRotaEntregadorConteudo();
}
function entSheetNext() {
    if (rotaSheetBloqueada()) return;
    if (rotaEntSheetIndex >= rotaEntSheetPacotes.length - 1) return;
    rotaEntSheetIndex += 1;
    renderSheetRotaEntregadorConteudo();
}

function iniciarSwipeEntSheet(event) {
    const touch = event?.touches?.[0];
    if (!touch) return;
    rotaEntSheetTouchStartX = Number(touch.clientX || 0);
    rotaEntSheetTouchStartY = Number(touch.clientY || 0);
}

function finalizarSwipeEntSheet(event) {
    const touch = event?.changedTouches?.[0];
    if (!touch) return;
    const endX = Number(touch.clientX || 0);
    const endY = Number(touch.clientY || 0);
    const dx = endX - rotaEntSheetTouchStartX;
    const dy = endY - rotaEntSheetTouchStartY;
    const movHorizontal = Math.abs(dx);
    const movVertical = Math.abs(dy);
    if (movHorizontal < 30 || movHorizontal <= movVertical) return;
    if (dx < 0) entSheetNext(); // próximo pacote
    else entSheetPrev(); // pacote anterior
}

function iniciarCorridaPacoteAtual(btn) {
    const rotaId = rotaEntSheetRotaAtual?.id;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    if (!rotaId || !pac) return;

    setEstadoPacoteRota(rotaId, pac, { status: 'em_corrida' }, rotaEntSheetIndex);

    // Persiste "corrida iniciada" no pacote (não só na memória local) — é essa marca
    // que decide se a exclusão desse envio depois cobra taxa de cancelamento do lojista.
    const lojistaUidCorrida = obterLojistaUidDaRota(rotaEntSheetRotaAtual, pac);
    const pacoteIdCorrida = obterIdPacoteConfirmacao(pac);
    if (lojistaUidCorrida && pacoteIdCorrida) {
        db.ref(`usuarios/${lojistaUidCorrida}/pacotes/${pacoteIdCorrida}/corridaIniciadaEm`).set(Date.now()).catch(() => {});
        criarNotificacao(lojistaUidCorrida, {
            tipo: 'corrida_iniciada',
            titulo: 'Entrega iniciada',
            mensagem: `${window.usuarioLogado?.nome || 'O entregador'} iniciou a entrega do pedido de ${obterNomeDestinatarioPacote(pac, rotaEntSheetRotaAtual)}.`,
            rotaId: String(rotaId)
        });
    }

    if (btn) {
        btn.classList.add('sliding');
        setTimeout(() => btn.classList.remove('sliding'), 800);
    }

    let destino = '';
    if (pac.destinoGeo?.lat && pac.destinoGeo?.lon) {
        destino = `${pac.destinoGeo.lat},${pac.destinoGeo.lon}`;
    } else {
        destino = encodeURIComponent(pac.destinoEndereco || pac.destinoCompleto || pac.destino || pac.cidade || '');
    }
    if (!destino) {
        alert('Destino não informado.');
        setEstadoPacoteRota(rotaId, pac, { status: 'pendente' }, rotaEntSheetIndex);
        return renderSheetRotaEntregadorConteudo();
    }
    const url = `https://www.google.com/maps/dir/?api=1&destination=${destino}`;
    setTimeout(() => window.open(url, '_blank'), 250);
    renderSheetRotaEntregadorConteudo();
}

async function confirmarEntregaPacoteAtual() {
    const rotaId = rotaEntSheetRotaAtual?.id;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    if (!rotaId || !pac) return;

    const estado = obterEstadoPacoteRota(rotaId, pac, rotaEntSheetIndex);
    const codigo = (estado.codigoConfirmacao || '').trim();
    if (!codigo) {
        alert('Digite o código de confirmação.');
        return;
    }

    const codigoEsperado = obterCodigoConfirmacaoEsperado(pac);
    if (!codigoEsperado) {
        alert('Pacote sem código de confirmação gerado. Feche e reabra a rota para gerar um.');
        return;
    }

    if (normalizarCodigoConfirmacaoEntrega(codigo) !== normalizarCodigoConfirmacaoEntrega(codigoEsperado)) {
        alert('Código inválido para este pacote. Peça o código de confirmação ao destinatário.');
        return;
    }

    let resultadoPersist = null;
    try {
        resultadoPersist = await persistirEntregaPacoteAtual(rotaEntSheetRotaAtual, pac, codigo);
    } catch (err) {
        console.warn('Falha ao confirmar entrega do pacote:', err);
        alert('Não foi possível confirmar a entrega agora. Tente novamente.');
        return;
    }

    setEstadoPacoteRota(rotaId, pac, { status: 'concluido', codigoConfirmacao: codigo }, rotaEntSheetIndex);
    rotaEntSheetPacotes[rotaEntSheetIndex] = {
        ...pac,
        status: 'ENTREGUE',
        statusRaw: 'ENTREGUE',
        codigoConfirmacaoEntrega: codigo,
        entregueEm: Date.now()
    };

    const lojistaUidEntrega = obterLojistaUidDaRota(rotaEntSheetRotaAtual, pac);
    if (lojistaUidEntrega) {
        if (resultadoPersist?.todosPacotesConcluidos) {
            criarNotificacao(lojistaUidEntrega, {
                tipo: 'rota_concluida',
                titulo: 'Rota concluída',
                mensagem: `Todos os pacotes da rota #${rotaId} foram entregues.`,
                rotaId: String(rotaId)
            });
        } else {
            criarNotificacao(lojistaUidEntrega, {
                tipo: 'pacote_entregue',
                titulo: 'Pacote entregue',
                mensagem: `O pedido de ${obterNomeDestinatarioPacote(pac, rotaEntSheetRotaAtual)} foi entregue.`,
                rotaId: String(rotaId)
            });
        }
    }

    if (resultadoPersist?.todosPacotesConcluidos && resultadoPersist?.creditado && Number(resultadoPersist?.valorCreditado || 0) > 0) {
        alert(`Entrega confirmada. Rota finalizada e ${precoParaMoeda(resultadoPersist.valorCreditado)} creditado na wallet.`);
    } else {
        alert('Entrega confirmada.');
    }

    const proximoIndice = obterProximoIndicePacotePendente(rotaId, rotaEntSheetPacotes, rotaEntSheetIndex + 1);
    if (proximoIndice >= 0) rotaEntSheetIndex = proximoIndice;

    renderSheetRotaEntregadorConteudo();
}

function cancelarCorridaPacoteAtual() {
    const rotaId = rotaEntSheetRotaAtual?.id;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    if (!rotaId || !pac) return;
    setEstadoPacoteRota(rotaId, pac, { status: 'pendente', codigoConfirmacao: '' }, rotaEntSheetIndex);
    renderSheetRotaEntregadorConteudo();
}

function atualizarCodigoConfirmacaoAtual(valor) {
    const rotaId = rotaEntSheetRotaAtual?.id;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    if (!rotaId || !pac) return;
    setEstadoPacoteRota(rotaId, pac, { codigoConfirmacao: valor }, rotaEntSheetIndex);
}

async function relatarProblemaRota() {
    const rotaObj = rotaEntSheetRotaAtual;
    const rotaId = rotaObj?.id;
    if (!rotaId) {
        alert('Abra a rota para relatar um problema.');
        return;
    }

    const descricao = (window.prompt('Descreva o problema com esta rota:') || '').trim();
    if (!descricao) return;

    const lojistaUid = obterLojistaUidDaRota(rotaObj, {});
    if (!lojistaUid) {
        alert('Não foi possível identificar o lojista desta rota.');
        return;
    }

    try {
        const ref = db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}/problemasReportados`).push();
        await ref.set({
            id: ref.key,
            descricao,
            entregadorId: getUsuarioIdAtual() || '',
            entregadorNome: window.usuarioLogado?.nome || 'Entregador',
            criadoEm: Date.now()
        });

        await criarNotificacao(lojistaUid, {
            tipo: 'problema_relatado',
            titulo: 'Problema relatado na rota',
            mensagem: `${window.usuarioLogado?.nome || 'O entregador'} relatou: ${descricao}`,
            rotaId: String(rotaId)
        });

        alert('Problema relatado ao lojista.');
    } catch (err) {
        console.warn('Falha ao relatar problema da rota:', err);
        alert('Não foi possível registrar o problema agora. Tente novamente.');
    }
}
function montarOptionsFiltroMarketplace(cidades, valorAtual, labelPadrao) {
    const atualNorm = (valorAtual || 'TODAS').toString();
    const opcoes = ['TODAS', ...cidades];
    return opcoes.map((cidade) => {
        const selecionado = cidade === atualNorm ? 'selected' : '';
        const label = cidade === 'TODAS' ? labelPadrao : cidade;
        return `<option value="${escaparHtmlMarketplace(cidade)}" ${selecionado}>${escaparHtmlMarketplace(label)}</option>`;
    }).join('');
}

function atualizarListaMarketplaceRotasEntregador() {
    const list = document.getElementById('entregador-rotas-list');
    if (!list) return;

    const filtradas = rotasMarketplaceEntregadorCache.filter((rota) => rotaMarketplacePassaNoFiltro(rota));

    if (!filtradas.length) {
        list.innerHTML = '<div class="entregador-rotas-empty">Nenhuma rota encontrada para esse filtro.</div>';
        return;
    }

    list.innerHTML = filtradas.map((rota) => montarCardMarketplaceRotaEntregador(rota)).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}


function atualizarListaBuscaEntregador() {
    const list = document.getElementById('buscar-entregador-list');
    if (!list) return;

    try {
        const base = Array.isArray(rotasMarketplaceEntregadorCache) ? rotasMarketplaceEntregadorCache : [];
        const enriquecidas = base.map((rota) => {
            const statusNorm = normalizarStatusRotaFiltro(rota?.statusNorm || rota?.status || rota?.pagamentoStatus || 'CRIADA');
            return { ...rota, statusNorm, statusVisual: getStatusVisualRota(statusNorm) };
        });
        rotasMarketplaceEntregadorCache = enriquecidas;

        const filtradas = enriquecidas.filter((rota) => {
            const statusNorm = rota?.statusNorm || 'BUSCANDO';
            const semEntregador = !String(rota?.entregadorId || '').trim();
            return rotaMarketplacePassaNoFiltro(rota) && statusNorm === 'BUSCANDO' && semEntregador;
        });

        if (!filtradas.length) {
            list.innerHTML = '<div class="buscar-empty">Nenhuma rota disponivel no momento.</div>';
        } else {
            list.innerHTML = filtradas.map((rota) => montarCardBuscaEntregador(rota)).join('');
        }
    } catch (err) {
        console.warn('Falha ao listar rotas de busca:', err);
        list.innerHTML = '<div class="buscar-empty">Nenhuma rota disponivel no momento.</div>';
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function aplicarFiltroRotaEntregador(tipo, valor) {
    if (tipo === 'origem') filtroRotaEntregadorOrigem = (valor || 'TODAS').toString();
    if (tipo === 'destino') filtroRotaEntregadorDestino = (valor || 'TODAS').toString();
    sincronizarDropdownBuscaEntregador();
    atualizarListaMarketplaceRotasEntregador();
    atualizarListaBuscaEntregador();
}

function limparFiltrosRotaEntregador() {
    filtroRotaEntregadorOrigem = 'TODAS';
    filtroRotaEntregadorDestino = 'TODAS';

    sincronizarDropdownBuscaEntregador();
    atualizarListaMarketplaceRotasEntregador();
    atualizarListaBuscaEntregador();
}

function sincronizarDropdownBuscaEntregador() {
    const mapa = [
        { id: 'buscar-filtro-origem', filtro: filtroRotaEntregadorOrigem, padrao: 'Qualquer origem' },
        { id: 'buscar-filtro-destino', filtro: filtroRotaEntregadorDestino, padrao: 'Qualquer destino' },
    ];

    mapa.forEach(({ id, filtro }) => {
        const select = document.getElementById(id);
        if (select) select.value = filtro;
        const dropdown = document.querySelector(`.buscar-dropdown[data-target="${id}"]`);
        if (!dropdown) return;
        const valueSpan = dropdown.querySelector('.buscar-dropdown-value');
        const options = dropdown.querySelectorAll('.buscar-dropdown-option');
        options.forEach((opt) => {
            const isActive = (opt.dataset.value || 'TODAS') === filtro;
            opt.classList.toggle('is-active', isActive);
            if (isActive && valueSpan) valueSpan.textContent = opt.textContent.trim();
        });
    });

    const origemSel = document.getElementById('entregador-filtro-origem');
    const destinoSel = document.getElementById('entregador-filtro-destino');
    if (origemSel) origemSel.value = filtroRotaEntregadorOrigem;
    if (destinoSel) destinoSel.value = filtroRotaEntregadorDestino;
}

function initDropdownBuscaEntregador() {
    const dropdowns = Array.from(document.querySelectorAll('.buscar-dropdown'));
    const closeOthers = (current) => {
        dropdowns.forEach((dd) => {
            if (dd !== current) {
                dd.classList.remove('is-open');
                const toggle = dd.querySelector('.buscar-dropdown-toggle');
                if (toggle) toggle.setAttribute('aria-expanded', 'false');
            }
        });
    };

    dropdowns.forEach((dd) => {
        const tipo = dd.dataset.filter || '';
        const toggle = dd.querySelector('.buscar-dropdown-toggle');
        const valueSpan = dd.querySelector('.buscar-dropdown-value');
        const options = Array.from(dd.querySelectorAll('.buscar-dropdown-option'));

        if (toggle) {
            toggle.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const isOpen = dd.classList.toggle('is-open');
                toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                if (isOpen) closeOthers(dd);
            });
        }

        options.forEach((opt) => {
            opt.addEventListener('click', (ev) => {
                ev.stopPropagation();
                options.forEach((o) => o.classList.remove('is-active'));
                opt.classList.add('is-active');
                if (valueSpan) valueSpan.textContent = opt.textContent.trim();
                dd.classList.remove('is-open');
                if (toggle) toggle.setAttribute('aria-expanded', 'false');
                const val = opt.dataset.value || 'TODAS';
                if (tipo === 'origem' || tipo === 'destino') {
                    aplicarFiltroRotaEntregador(tipo, val);
                }
            });
        });
    });

    if (!window._buscarDropdownOutsideHandler) {
        window._buscarDropdownOutsideHandler = (evt) => {
            document.querySelectorAll('.buscar-dropdown').forEach((dd) => {
                if (!dd.contains(evt.target)) {
                    dd.classList.remove('is-open');
                    const toggle = dd.querySelector('.buscar-dropdown-toggle');
                    if (toggle) toggle.setAttribute('aria-expanded', 'false');
                }
            });
        };
        document.addEventListener('click', window._buscarDropdownOutsideHandler);
    }
}

async function aceitarRotaMarketplaceEntregador(lojistaUid, rotaId, btn = null) {
    if (!usuarioEhEntregador()) {
        alert('Somente entregador pode aceitar rota.');
        return;
    }

    const uidEntregador = getUsuarioIdAtual();
    if (!uidEntregador) {
        alert('Sessao expirada. Faca login novamente.');
        return;
    }

    if (!lojistaUid || !rotaId) return;

    const textoOriginal = btn ? btn.innerText : '';
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Aceitando...';
    }

    try {
        const rotaRef = db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}`);
        const metaEntregador = {
            entregadorId: uidEntregador,
            entregadorNome: (window.usuarioLogado?.nome || 'Entregador').toString(),
            entregadorFoto: (window.usuarioLogado?.foto || '').toString(),
            aceitoPor: uidEntregador,
            aceitoEm: Date.now(),
            status: 'EM_ROTA',
            atualizadoEm: Date.now()
        };

        const tx = await rotaRef.transaction((atual) => {
            if (!atual) return atual;
            const statusAtual = normalizarStatusRotaFiltro(atual?.status || atual?.pagamentoStatus || 'CRIADA');
            const jaTemEntregador = Boolean(atual?.entregadorId || atual?.aceitoPor);
            if (statusAtual !== 'BUSCANDO' || jaTemEntregador) return;
            return { ...atual, ...metaEntregador };
        });

        if (!tx.committed || !tx.snapshot.exists()) {
            alert('Essa rota ja foi aceita por outro entregador.');
            await renderRotasMarketplaceEntregador(true);
            return;
        }

        const rotaAtualizada = tx.snapshot.val() || {};
        const pacoteIds = Array.isArray(rotaAtualizada?.pacoteIds)
            ? rotaAtualizada.pacoteIds
            : (Array.isArray(rotaAtualizada?.pacotes) ? rotaAtualizada.pacotes : []);

        if (pacoteIds.length) {
            const clientesSnap = await db.ref(`usuarios/${lojistaUid}/clientes`).once('value');
            const clientesNo = clientesSnap.val() || {};
            const idsSet = new Set(pacoteIds.map((id) => String(id)));
            const updates = {};

            Object.keys(clientesNo).forEach((clienteId) => {
                const historico = Array.isArray(clientesNo[clienteId]?.historico) ? clientesNo[clienteId].historico : [];
                historico.forEach((h, idx) => {
                    const idAtual = String(h?.id || ('envio-' + clienteId + '-' + idx));
                    if (!idsSet.has(idAtual)) return;
                    updates[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/id`] = idAtual;
                    updates[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/status`] = 'EM_ROTA';
                    updates[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/rotaId`] = String(rotaId);
                    updates[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/atualizadoEm`] = Date.now();
                });
            });

            if (Object.keys(updates).length) {
                await db.ref().update(updates);
            }
        }

        const rotaMarketplaceAtual = rotasMarketplaceEntregadorCache.find((r) => String(r.id) === String(rotaId) && String(r.lojistaUid) === String(lojistaUid));
        const rotaNoEntregador = {
            id: String(rotaId),
            ...rotaAtualizada,
            origemLojistaUid: String(lojistaUid),
            lojistaId: String(lojistaUid),
            lojistaNome: String(rotaAtualizada?.lojistaNome || rotaMarketplaceAtual?.lojistaNome || 'Lojista'),
            lojistaFoto: String(rotaAtualizada?.lojistaFoto || rotaMarketplaceAtual?.lojistaFoto || ''),
            sincronizadaDoLojista: true,
            atualizadoEm: Date.now(),
            destinoPrincipal: rotaAtualizada?.destinoPrincipal || rotaMarketplaceAtual?.destinoPrincipal || '',
            destinos: rotaAtualizada?.destinos || rotaMarketplaceAtual?.destinos || [],
            distanciaTotal: rotaAtualizada?.distanciaTotal || rotaMarketplaceAtual?.distanciaTotal || 0,
            duracaoTotal: rotaAtualizada?.duracaoTotal || rotaMarketplaceAtual?.duracaoTotal || 0,
            totalPacotes: rotaAtualizada?.totalPacotes || rotaMarketplaceAtual?.totalPacotes || pacoteIds.length || 0,
            totalFrete: rotaAtualizada?.totalFrete || rotaMarketplaceAtual?.totalFrete || 0
        };
        await db.ref(`usuarios/${uidEntregador}/rotas/${rotaId}`).set(rotaNoEntregador);

        criarNotificacao(lojistaUid, {
            tipo: 'rota_aceita',
            titulo: 'Rota aceita',
            mensagem: `${window.usuarioLogado?.nome || 'Um entregador'} aceitou a rota #${rotaId}.`,
            rotaId: String(rotaId)
        });

        rotasMarketplaceEntregadorCache = rotasMarketplaceEntregadorCache.map((r) => {
            if (String(r.id) !== String(rotaId) || String(r.lojistaUid) !== String(lojistaUid)) return r;
            return {
                ...r,
                statusNorm: 'EM_ROTA',
                statusVisual: getStatusVisualRota('EM_ROTA'),
                entregadorId: uidEntregador
            };
        });

        atualizarListaMarketplaceRotasEntregador();
        iniciarListenerHomeEntregador();
        alert('Rota aceita com sucesso.');
    } catch (err) {
        console.warn('Erro ao aceitar rota marketplace:', err);
        alert('Nao foi possivel aceitar essa rota agora. Tente novamente.');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = textoOriginal || 'Aceitar';
        }
    }
}
async function renderRotasMarketplaceEntregador(forceReload = false) {
    const shell = document.getElementById('entregador-rotas-shell');
    if (!shell || !usuarioEhEntregador()) return;

    shell.classList.remove('hidden');
    shell.innerHTML = '';
}
function resumirCidadesRota(pacotes) {
    const cidades = [...new Set(pacotes.map((p) => (p.cidade || '').trim()).filter(Boolean))];
    if (!cidades.length) return { principal: 'Sem cidade', extras: 0, total: 0, display: 'Sem cidade' };
    const extras = Math.max(0, cidades.length - 1);
    const display = extras > 0 ? 'Multi-cidades' : cidades[0];
    return { principal: cidades[0], extras, total: cidades.length, display };
}

function calcularPesoTotalRota(pacotes) {
    const pesoPorTamanho = { P: 1, M: 2, G: 5 };
    return pacotes.reduce((acc, p) => {
        const tam = (p.tamanho || '').toString().trim().toUpperCase();
        return acc + (pesoPorTamanho[tam] || 1);
    }, 0);
}

function formatarTamanhoTotalRota(pacotes) {
    const counts = { P: 0, M: 0, G: 0 };
    pacotes.forEach((p) => {
        const t = (p.tamanho || '').toString().trim().toUpperCase();
        if (counts[t] !== undefined) counts[t] += 1;
    });
    const partes = Object.keys(counts).filter((k) => counts[k] > 0).map((k) => `${counts[k]}x ${k}`);
    return partes.length ? partes.join(' ') : '--';
}


async function renderTelaBuscarEntregador(forceReload = false) {
    const shell = document.getElementById('buscar-entregador-shell');
    if (!shell) return;

    if (!usuarioEhEntregador()) {
        shell.innerHTML = '<div class="buscar-empty">Disponivel apenas para entregadores.</div>';
        return;
    }

    if (forceReload) {
        filtroRotaEntregadorOrigem = 'TODAS';
        filtroRotaEntregadorDestino = 'TODAS';
    }

    if (forceReload || !Array.isArray(rotasMarketplaceEntregadorCache) || !rotasMarketplaceEntregadorCache.length) {
        shell.innerHTML = '<div class="buscar-empty">Carregando rotas disponiveis...</div>';
        rotasMarketplaceEntregadorCache = await carregarMarketplaceRotasEntregador();
    }

    const cidadesOrigem = [...new Set(rotasMarketplaceEntregadorCache.map((r) => (r.origemCidade || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const cidadesDestino = [...new Set(rotasMarketplaceEntregadorCache.flatMap((r) => Array.isArray(r.destinos) ? r.destinos : []).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));

        const headerHtml = renderHeaderGlobal('entregador', Number(window.usuarioLogado?.financeiro?.saldo || 0));
        shell.innerHTML = `
        ${headerHtml}
        <div class="buscar-card-field">
            <label><i data-lucide="map-pin" size="14"></i> Cidade de origem (onde você está)</label>
            ${montarDropdownFiltroMarketplace('buscar-filtro-origem', 'origem', cidadesOrigem, filtroRotaEntregadorOrigem, 'Qualquer origem')}
        </div>

        <div class="buscar-card-field">
            <label><i data-lucide="navigation" size="14"></i> Cidade de destino (para onde vai)</label>
            ${montarDropdownFiltroMarketplace('buscar-filtro-destino', 'destino', cidadesDestino, filtroRotaEntregadorDestino, 'Qualquer destino')}
        </div>

        <div id="buscar-entregador-list" class="buscar-rota-list"></div>
    `;

    const origemSel = document.getElementById('buscar-filtro-origem');
    const destinoSel = document.getElementById('buscar-filtro-destino');
    if (origemSel) origemSel.value = 'TODAS';
    if (destinoSel) destinoSel.value = 'TODAS';

    atualizarListaBuscaEntregador();
    initDropdownBuscaEntregador();
    sincronizarDropdownBuscaEntregador();
    if (typeof lucide !== "undefined") lucide.createIcons();
}
async function renderHistoricoRotasEntregador() {
    const shell = document.getElementById('entregador-rotas-shell');
    if (!shell || !usuarioEhEntregador()) return;

    shell.classList.remove('hidden');

    let rotasNo = window.usuarioLogado?.rotas || {};
    if (!rotasNo || !Object.keys(rotasNo).length) {
        const uid = getUsuarioIdAtual();
        if (uid) {
            const snap = await db.ref(`usuarios/${uid}/rotas`).once('value');
            rotasNo = snap.val() || {};
            window.usuarioLogado = { ...(window.usuarioLogado || {}), rotas: rotasNo };
        }
    }
    const listaRotas = Object.keys(rotasNo).map((id) => ({ id, ...(rotasNo[id] || {}) }))
        .map((r) => {
            const statusNorm = normalizarStatusRotaFiltro(r?.status || r?.pagamentoStatus || 'CRIADA');
            const statusVisual = getStatusVisualRota(statusNorm);
            return {
                ...r,
                id: r.id,
                statusNorm,
                statusVisual
            };
        })
        .filter((r) => ['EM_ROTA', 'CONCLUIDO', 'CANCELADO'].includes(r.statusNorm))
        .sort((a, b) => Number(b?.atualizadoEm || b?.criadoEm || 0) - Number(a?.atualizadoEm || a?.criadoEm || 0));

    const cards = listaRotas.length
        ? listaRotas.map((r) => montarCardHistoricoRotaEntregador(r)).join('')
        : '<div class="rotas-ent-empty">Nenhuma rota em andamento ou finalizada.</div>';

    const headerHtml = renderHeaderGlobal('entregador', Number(window.usuarioLogado?.financeiro?.saldo || 0));
    shell.innerHTML = `
        ${headerHtml}
        <div class="rotas-entregador-list">
            ${cards}
        </div>
    `;

    if (typeof lucide !== 'undefined') lucide.createIcons();
}
async function renderRotasTelaPrincipal() {
    if (usuarioEhEntregador()) {
        await renderHistoricoRotasEntregador();
        return;
    }
    const container = document.getElementById('rotas-main-list');
    const link = document.getElementById('rotas-ver-todas');
    if (!container) return;

    const msgSemRota = usuarioEhEntregador()
        ? 'Nenhuma rota disponivel no momento.'
        : 'Voce ainda nao criou nenhuma rota.';

    container.innerHTML = '<div class="rota-main-empty">Carregando rotas...</div>';

    const rotas = await carregarRotasDoBanco();
    rotasHomeCache = rotas;
    const hero = document.getElementById('rotas-hero-card');

    const filterRow = document.getElementById('rotas-filter-row');
    if (filterRow) {
        filterRow.querySelectorAll('[data-rota-filter]').forEach((btn) => {
            const alvo = (btn.dataset.rotaFilter || '').toUpperCase();
            btn.classList.toggle('active', alvo === filtroRotasAtivo);
        });
    }

    if (!rotas.length) {
        container.innerHTML = `<div class="rota-main-empty">${msgSemRota}</div>`;
        if (link) link.style.display = 'none';
        if (hero) hero.style.display = 'block';
        return;
    }
    if (hero) hero.style.display = 'none';

    const rotasFiltradas = rotas.filter((rota) => rotaPassaNoFiltro(rota));
    if (!rotasFiltradas.length) {
        container.innerHTML = '<div class="rota-main-empty">Nenhuma rota neste filtro.</div>';
        if (link) link.style.display = 'none';
        return;
    }

    const grupos = [
        { chave: 'BUSCANDO', titulo: 'Buscando' },
        { chave: 'EM_ROTA', titulo: 'Em rota' },
        { chave: 'CONCLUIDO', titulo: 'Entregues' },
        { chave: 'CANCELADO', titulo: 'Canceladas' }
    ];

    const blocos = grupos.map((g) => {
        const subset = rotasFiltradas.filter((rota) => normalizarStatusRotaFiltro(rota?.status || rota?.pagamentoStatus || 'CRIADA') === g.chave);
        if (!subset.length) return '';

        const cards = subset.map((rota) => {
            const pacotes = getPacotesDaRota(rota);
            const resumo = resumirCidadesRota(pacotes);
            const status = getStatusVisualRota(rota?.status || rota?.pagamentoStatus || 'CRIADA');
            const total = Number.isFinite(Number(rota?.totalFrete))
                ? Number(rota.totalFrete)
                : pacotes.reduce((acc, p) => acc + Number(p.valorFrete || 0), 0);
            const qtd = Number(rota?.quantidade || pacotes.length || 0);
            const cidadeLabel = resumo.extras > 0 ? `${resumo.principal} +${resumo.extras}` : resumo.principal;

            return `
                <div class="rota-swipe-wrap" id="rota-wrap-${rota.id}">
                    <div class="rota-swipe-actions">
                        <button type="button" class="rota-swipe-btn btn-more" onclick="event.stopPropagation(); abrirModalDetalheRota('${String(rota.id).replace(/'/g, "\\'")}')">Mais</button>
                        <button type="button" class="rota-swipe-btn btn-delete" onclick="event.stopPropagation(); confirmarExclusaoRota('${String(rota.id).replace(/'/g, "\\'")}')">Excluir</button>
                    </div>
                    <button type="button"
                            class="rota-main-card rota-swipe-card"
                            id="rota-card-${rota.id}"
                            data-rota-id="${rota.id}"
                            ontouchstart="handleRotaTouchStart(event)"
                            ontouchmove="handleRotaTouchMove(event)"
                            ontouchend="handleRotaTouchEnd(event)"
                            onclick="handleRotaCardClick(event, '${String(rota.id).replace(/'/g, "\\'")}')">
                        <div class="rota-main-icon"><i data-lucide="package"></i></div>
                        <div class="rota-main-info">
                            <div class="rota-main-top-row">
                                <span class="rota-main-id">ID: ${rota.id}</span>
                                <div class="rota-main-badges">
                                    <span class="rota-main-status ${status.className}">${status.label}</span>
                                </div>
                            </div>
                            <div class="rota-main-city"><strong>${cidadeLabel}</strong></div>
                            <div class="rota-main-meta">${qtd} pacote(s) • ${precoParaMoeda(total)}</div>
                        </div>
                    </button>
                </div>
            `;
        }).join('');

        return `<div class="rota-group"><div class="rota-group-title">${g.titulo}</div>${cards}</div>`;
    }).join('');

    const temAlgumGrupo = blocos.replace(/\s/g, '').length > 0;
    if (!temAlgumGrupo) {
        container.innerHTML = `<div class="rota-main-empty">${msgSemRota}</div>`;
        if (link) link.style.display = 'none';
    } else {
        container.innerHTML = blocos;
        if (link) link.style.display = 'none';
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function verTodasAsRotas(event) {
    if (event) event.preventDefault();
    mostrarTodasRotasHome = !mostrarTodasRotasHome;
    renderRotasTelaPrincipal();
    return false;
}

function selecionarFiltroEnvios(filtro = 'TODOS', btn = null) {
    filtroEnviosAtivo = normalizarFiltroChipEnvio(filtro || 'TODOS');
    const row = document.getElementById('envio-filter-row');
    if (row) {
        row.querySelectorAll('[data-envio-filter]').forEach((chip) => {
            const alvo = normalizarFiltroChipEnvio(chip.dataset.envioFilter || '');
            chip.classList.toggle('active', alvo === filtroEnviosAtivo);
        });
    }
    if (btn && btn.classList) btn.classList.add('active');
    renderEnviosHome();
}

function selecionarFiltroRotas(filtro = 'BUSCANDO', btn = null) {
    filtroRotasAtivo = (filtro || 'BUSCANDO').toString().toUpperCase();
    const row = document.getElementById('rotas-filter-row');
    if (row) {
        row.querySelectorAll('[data-rota-filter]').forEach((chip) => {
            const alvo = (chip.dataset.rotaFilter || '').toUpperCase();
            chip.classList.toggle('active', alvo === filtroRotasAtivo);
        });
    }
    if (btn && btn.classList) btn.classList.add('active');
    mostrarTodasRotasHome = false;
    renderRotasTelaPrincipal();
}

function abrirNovaRotaPeloChip(btn) {
    if (btn) {
        btn.classList.add('is-pressed');
        setTimeout(() => btn.classList.remove('is-pressed'), 180);
    }
    openModal();
}

function getEtapaRastreamento(statusNorm) {
    if (statusNorm === 'CONCLUIDO') return 4;
    if (statusNorm === 'EM_ROTA') return 3;
    if (statusNorm === 'BUSCANDO') return 2;
    if (statusNorm === 'CANCELADO') return 1;
    return 1;
}

function montarTimelineRastreamento(statusNorm) {
    const etapaAtual = getEtapaRastreamento(statusNorm);
    return [1, 2, 3, 4].map((etapa) => {
        const done = etapa <= etapaAtual;
        const current = etapa === etapaAtual;
        return `<span class="rastrear-dot ${done ? 'done' : ''} ${current ? 'current' : ''}"></span>`;
    }).join('');
}

async function renderListaModalRastrearRotas() {
    const list = document.getElementById('rastrear-rota-list');
    if (!list) return;

    list.innerHTML = '<div class="rastrear-empty">Carregando rotas...</div>';

    let rotas = Array.isArray(rotasHomeCache) ? rotasHomeCache : [];
    if (!rotas.length) {
        rotas = await carregarRotasDoBanco();
        rotasHomeCache = rotas;
    }

    if (!rotas.length) {
        list.innerHTML = '<div class="rastrear-empty">Nenhuma rota criada ainda.</div>';
        return;
    }

    const cards = rotas.map((rota) => {
        const pacotes = getPacotesDaRota(rota);
        const resumoCidade = resumirCidadesRota(pacotes);
        const statusNorm = normalizarStatusRotaFiltro(rota?.status || rota?.pagamentoStatus || 'CRIADA');
        const statusVisual = getStatusVisualRota(statusNorm);

        const dist = pacotes.reduce((acc, p) => acc + (Number.isFinite(Number(p?.distanciaKm)) ? Number(p.distanciaKm) : 0), 0);
        const dur = pacotes.reduce((acc, p) => acc + (Number.isFinite(Number(p?.duracaoMin)) ? Number(p.duracaoMin) : 0), 0);
        const qtd = Number(rota?.quantidade || pacotes.length || 0);

        const tempoHint = statusNorm === 'CONCLUIDO'
            ? 'Rota concluida'
            : statusNorm === 'EM_ROTA'
                ? `${Math.max(1, Math.round((dur || 0) * 0.5))} min restantes`
                : statusNorm === 'CANCELADO'
                    ? 'Rota cancelada'
                    : 'Aguardando entregador';

        return `
            <button type="button" class="rastrear-card" onclick="abrirModalDetalheRota('${String(rota.id).replace(/'/g, "\\'")}')">
                <div class="rastrear-card-head">
                    <strong>${rota.id}</strong>
                    <span class="rota-main-status ${statusVisual.className}">${statusVisual.label}</span>
                </div>
                <div class="rastrear-card-meta">${qtd} pacote(s) • ${resumoCidade.principal || '--'} • ${precoParaMoeda(Number(rota?.totalFrete || 0))}</div>
                <div class="rastrear-track-wrap">
                    <span class="rastrear-track-time">${tempoHint}</span>
                    <div class="rastrear-track-line"></div>
                    <div class="rastrear-track-dots">${montarTimelineRastreamento(statusNorm)}</div>
                    <span class="rastrear-track-bike"><i data-lucide="bike"></i></span>
                </div>
                <div class="rastrear-card-footer">
                    <span>${formatarDistancia(dist)}</span>
                    <span>${formatarDuracao(dur)}</span>
                </div>
            </button>
        `;
    }).join('');

    list.innerHTML = cards;
}

function abrirModalRastrearRotas(btn = null) {
    if (btn) {
        btn.classList.add('is-pressed');
        setTimeout(() => btn.classList.remove('is-pressed'), 180);
    }

    const overlay = document.getElementById('overlay-rastrear-rota');
    if (!overlay) return;

    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('is-open'));

    renderListaModalRastrearRotas().then(() => {
        if (typeof lucide !== 'undefined') lucide.createIcons();
    });
}

function fecharModalRastrearRotas() {
    const overlay = document.getElementById('overlay-rastrear-rota');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    setTimeout(() => {
        overlay.style.display = 'none';
    }, 220);
}


function fecharSwipesRota(exceptId = null) {
    document.querySelectorAll('.rota-swipe-card').forEach((card) => {
        if (exceptId && card.id === exceptId) return;
        card.style.transform = 'translateX(0)';
        card.dataset.swipeOpen = '0';
    });
}

function handleRotaTouchStart(event) {
    if (usuarioEhEntregador()) return;
    rotaSwipeStartX = event.touches[0].clientX;
    rotaSwipeCardAtivo = event.currentTarget;
    if (!rotaSwipeCardAtivo) return;
    rotaSwipeCardAtivo.style.transition = 'none';
    rotaSwipeCardAtivo.dataset.cancelClick = '0';
    fecharSwipesRota(rotaSwipeCardAtivo.id);
}

function handleRotaTouchMove(event) {
    if (!rotaSwipeCardAtivo) return;
    const touchX = event.touches[0].clientX;
    const diff = touchX - rotaSwipeStartX;
    if (Math.abs(diff) > 8) rotaSwipeCardAtivo.dataset.cancelClick = '1';
    if (diff < 0) {
        const limite = Math.max(diff, -156);
        rotaSwipeCardAtivo.style.transform = `translateX(${limite}px)`;
    }
}

function handleRotaTouchEnd(event) {
    if (!rotaSwipeCardAtivo) return;
    const card = rotaSwipeCardAtivo;
    const touchX = event.changedTouches[0].clientX;
    const diff = touchX - rotaSwipeStartX;

    card.style.transition = 'transform 0.22s ease';
    if (diff < -60) {
        card.style.transform = 'translateX(-156px)';
        card.dataset.swipeOpen = '1';
    } else {
        card.style.transform = 'translateX(0)';
        card.dataset.swipeOpen = '0';
    }

    setTimeout(() => {
        card.style.transition = '';
    }, 220);

    rotaSwipeCardAtivo = null;
}

function handleRotaCardClick(event, rotaId) {
    const card = event.currentTarget;
    if (!card) return;

    if (card.dataset.cancelClick === '1') {
        card.dataset.cancelClick = '0';
        return;
    }

    if (card.dataset.swipeOpen === '1') {
        fecharSwipesRota();
        return;
    }

    abrirModalDetalheRota(rotaId);
}

// Ajusta usuarios/{uid}/financeiro/saldo lendo o valor real com .once('value') e
// gravando o resultado com .set() — NÃO usa .transaction().
//
// Motivo (descoberto e confirmado com logs em 2026-08-11): nesse app, .transaction()
// nesse caminho específico chama o callback UMA vez com valor `null`, mesmo quando
// .once('value') no mesmo instante lê o valor real corretamente (ex.: saldo real de
// R$300 chegando como null dentro da transação) — e nunca tenta de novo com o valor
// do servidor. Resultado: débitos abortavam sempre ("saldo insuficiente" mesmo tendo
// saldo), e créditos gravavam por cima do saldo real com `0 + valor`, apagando o que
// já existia. Ler-e-gravar não é perfeitamente atômico (janela pequena entre leitura
// e escrita), mas nesse app o cenário de risco real — o mesmo usuário pagando/
// recebendo crédito ao mesmo tempo em duas abas — é raro; a confiabilidade ganha aqui
// compensa a perda de atomicidade estrita. Não trocar de volta para .transaction()
// nesse caminho sem entender por que ela se comporta assim primeiro.
async function ajustarSaldoUsuario(uid, delta, { permitirNegativo = true } = {}) {
    if (!uid || !Number.isFinite(delta) || delta === 0) {
        return { ok: false, saldoAntes: 0, saldoDepois: 0 };
    }

    const saldoRef = db.ref(`usuarios/${uid}/financeiro/saldo`);
    let saldoAntes = 0;
    try {
        const snap = await saldoRef.once('value');
        saldoAntes = Number(snap.val() || 0);
    } catch (err) {
        console.warn('Falha ao ler saldo atual:', err);
        return { ok: false, saldoAntes: 0, saldoDepois: 0 };
    }

    const saldoDepois = Number((saldoAntes + delta).toFixed(2));
    if (!permitirNegativo && saldoDepois < 0) {
        return { ok: false, saldoAntes, saldoDepois: saldoAntes, saldoInsuficiente: true };
    }

    try {
        await saldoRef.set(saldoDepois);
    } catch (err) {
        console.warn('Falha ao gravar novo saldo:', err);
        return { ok: false, saldoAntes, saldoDepois: saldoAntes };
    }

    return { ok: true, saldoAntes, saldoDepois };
}

async function creditarSaldoUsuarioAtual(valor, descricao) {
    const uid = getUsuarioIdAtual();
    if (!uid || !Number.isFinite(valor) || valor <= 0) return;

    const resultado = await ajustarSaldoUsuario(uid, valor);
    if (!resultado.ok) return;

    if (!window.usuarioLogado) window.usuarioLogado = {};
    window.usuarioLogado.financeiro = { ...(window.usuarioLogado.financeiro || {}), saldo: resultado.saldoDepois, atualizadoEm: Date.now() };
    await registrarTransacaoFinanceira('CREDITO', valor, descricao);
    if (typeof atualizarSaldoPagamentoUI === 'function') atualizarSaldoPagamentoUI();
}

// Débito voluntário (pagamento com saldo) — diferente da taxa de cancelamento
// (que é uma penalidade e pode deixar o saldo negativo), esse débito é bloqueado
// se não houver saldo suficiente na hora da leitura.
// Retorna { ok, saldoEncontrado, novoSaldo } em vez de só true/false — assim quem
// chama consegue mostrar exatamente qual saldo foi encontrado no banco quando o
// débito falha por saldo insuficiente, em vez de uma mensagem genérica.
async function debitarSaldoUsuarioAtual(valor, descricao) {
    const uid = getUsuarioIdAtual();
    if (!uid || !Number.isFinite(valor) || valor <= 0) return { ok: false, saldoEncontrado: 0 };

    const resultado = await ajustarSaldoUsuario(uid, -valor, { permitirNegativo: false });
    if (!resultado.ok) return { ok: false, saldoEncontrado: resultado.saldoAntes };

    if (!window.usuarioLogado) window.usuarioLogado = {};
    window.usuarioLogado.financeiro = { ...(window.usuarioLogado.financeiro || {}), saldo: resultado.saldoDepois, atualizadoEm: Date.now() };
    await registrarTransacaoFinanceira('DEBITO', valor, descricao);
    if (typeof atualizarSaldoPagamentoUI === 'function') atualizarSaldoPagamentoUI();
    return { ok: true, saldoEncontrado: resultado.saldoAntes, novoSaldo: resultado.saldoDepois };
}

// Uma rota só pode ser excluída por inteiro enquanto nenhum entregador aceitou (status
// Buscando) e ela já está vazia (todos os envios já foram excluídos individualmente
// antes — ver confirmarExclusaoEnvio, que já devolve o valor de cada envio removido).
// Por isso NÃO estorna nada aqui: quando chega vazia, o valor já foi todo devolvido
// envio por envio. Depois que um entregador aceita, a rota deixa de poder ser excluída
// por inteiro — só dá para remover envios um a um (e ela vira CANCELADA sozinha ao
// esvaziar, ver marcarRotaCanceladaSeVazia).
async function excluirRotaPorId(rotaId, opts = {}) {
    if (usuarioEhEntregador()) {
        alert('Perfil entregador nao pode excluir rotas.');
        return;
    }
    const confirmar = opts?.confirmar !== false;
    if (!rotaId) return;

    const rota = rotasHomeCache.find((r) => String(r.id) === String(rotaId));
    if (!rota) return;

    const temEntregador = Boolean(rota.entregadorId || rota.aceitoPor);
    if (temEntregador) {
        alert('Esta rota já foi aceita por um entregador e não pode mais ser excluída por inteiro. Remova os envios um a um, se necessário.');
        return;
    }

    let pacoteIds = [];
    if (Array.isArray(rota.pacoteIds)) pacoteIds = rota.pacoteIds;
    else if (Array.isArray(rota.pacotes)) pacoteIds = rota.pacotes.map((p) => (typeof p === 'object' ? p.id || p.codigo || p : p));

    if (pacoteIds.length) {
        alert('Exclua todos os envios desta rota antes de excluir a rota.');
        return;
    }

    if (confirmar && !window.confirm(`Deseja excluir a rota ${rota.id}?`)) return;

    const uid = getUsuarioIdAtual();
    if (uid) {
        await db.ref('usuarios/' + uid + '/rotas/' + rota.id).remove();
    }

    if (rotaDetalheAtual && String(rotaDetalheAtual.id) === String(rota.id)) {
        fecharModalDetalheRota();
        rotaDetalheAtual = null;
        rotaDetalhePacotes = [];
    }

    fecharSwipesRota();
    await renderRotasTelaPrincipal();
    renderEnviosHome();

    // repõe pacotes na lista de pendentes para nova rota
    rotaPendentesCache = coletarEnviosPendentesParaRota();
    renderListaPendentesRota();
}

function setStatusPacotes(ids = [], status = 'PACOTE_NOVO', salvar = false) {
    const alvos = new Set(ids.map((x) => normalizarIdPacoteBusca(x)));
    if (!alvos.size) return;

    const uid = getUsuarioIdAtual();

    clientes.forEach((cliente) => {
        const historico = Array.isArray(cliente.historico) ? cliente.historico : [];
        historico.forEach((h, idx) => {
            const idAtual = h.id || ('envio-' + cliente.id + '-' + idx);
            if (alvos.has(normalizarIdPacoteBusca(idAtual))) {
                h.id = idAtual;
                h.status = status;
                if (status === 'PACOTE_NOVO') delete h.rotaId;
                h.atualizadoEm = Date.now();
            }
        });
        cliente.historico = historico;
    });

    if (salvar) saveClientes();

    // atualiza também no modelo novo /pacotes
    if (salvar && uid) {
        alvos.forEach((id) => {
            db.ref(`pacotes/${uid}/${id}/status`).set(status).catch(() => {});
        });
    }

    rotaPendentesCache = coletarEnviosPendentesParaRota();
    renderListaPendentesRota();
    renderEnviosHome();
}

function normalizarIdPacoteBusca(val) {
    return String(val || '').replace(/\s+/g, '').toLowerCase();
}

// util admin: window.adminSetStatusPacote(['pedido #7747'], 'PACOTE_NOVO')
window.adminSetStatusPacote = (ids, status) => setStatusPacotes(ids, status || 'PACOTE_NOVO', true);

async function confirmarExclusaoRota(rotaId) {
    await excluirRotaPorId(rotaId, { confirmar: true });
}

async function excluirRotaAtualComConfirmacao() {
    if (!rotaDetalheAtual?.id) return;
    if (usuarioEhEntregador()) {
        await desistirRotaEntregador(rotaDetalheAtual);
    } else {
        await excluirRotaPorId(rotaDetalheAtual.id, { confirmar: true });
    }
}

function atualizarResumoModalDetalheRota() {
    if (!rotaDetalheAtual) return;

    const pacotes = rotaDetalhePacotes;
    const distanciaPacotes = pacotes.reduce((acc, p) => acc + (Number.isFinite(p.distanciaKm) ? Number(p.distanciaKm) : 0), 0);
    const duracaoPacotes = pacotes.reduce((acc, p) => acc + (Number.isFinite(p.duracaoMin) ? Number(p.duracaoMin) : 0), 0);
    const distanciaTotal = Number.isFinite(Number(rotaDetalheAtual?.distanciaTotal))
        ? Number(rotaDetalheAtual.distanciaTotal)
        : distanciaPacotes;
    const duracaoTotal = Number.isFinite(Number(rotaDetalheAtual?.duracaoTotal))
        ? Number(rotaDetalheAtual.duracaoTotal)
        : duracaoPacotes;
    const valorTotal = Number.isFinite(Number(rotaDetalheAtual?.totalFrete))
        ? Number(rotaDetalheAtual.totalFrete)
        : pacotes.reduce((acc, p) => acc + Number(p.valorFrete || 0), 0);
    const pesoTotal = pacotes.length ? calcularPesoTotalRota(pacotes) : 0;
    const tamanhoTotal = pacotes.length ? formatarTamanhoTotalRota(pacotes) : '--';

    const destinos = Array.isArray(rotaDetalheAtual?.destinos) ? rotaDetalheAtual.destinos : [];
    const destinoPrincipal = rotaDetalheAtual?.destinoPrincipal || destinos[0] || '--';
    const totalParadas = pacotes.length ? pacotes.length : Math.max(1, destinos.length || 1);

    const status = getStatusVisualRota(rotaDetalheAtual?.status || rotaDetalheAtual?.pagamentoStatus || 'CRIADA');

    const idEl = document.getElementById('rota-detalhe-id');
    const statusEl = document.getElementById('rota-detalhe-status');
    const distEl = document.getElementById('rota-detalhe-distancia');
    const durEl = document.getElementById('rota-detalhe-duracao');
    const paradasEl = document.getElementById('rota-detalhe-paradas');
    const valorEl = document.getElementById('rota-detalhe-valor-total');
    const pesoEl = document.getElementById('rota-detalhe-peso-total');
    const tamEl = document.getElementById('rota-detalhe-tamanho-total');

    if (idEl) idEl.innerText = rotaDetalheAtual.id || '--';
    if (statusEl) {
        statusEl.innerText = status.label;
        statusEl.className = `rota-main-status ${status.className}`;
    }
    if (distEl) distEl.innerText = formatarDistancia(distanciaTotal);
    if (durEl) durEl.innerText = formatarDuracao(duracaoTotal);
    if (paradasEl) paradasEl.innerText = String(totalParadas).padStart(2, '0');
    if (valorEl) valorEl.innerText = precoParaMoeda(valorTotal);
    if (pesoEl) pesoEl.innerText = pacotes.length ? `${pesoTotal.toFixed(1).replace('.', ',')} kg` : '--';
    if (tamEl) tamEl.innerText = tamanhoTotal;

    const destinoLabel = document.getElementById('rota-detalhe-destino');
    if (destinoLabel) destinoLabel.innerText = destinoPrincipal;
}

async function desistirRotaEntregador(rota) {
    const uidEnt = getUsuarioIdAtual();
    if (!uidEnt || !usuarioEhEntregador()) return;

    const aceitoEm = Number(rota?.aceitoEm || rota?.aceitoPorEm || rota?.atualizadoEm || 0);
    const agora = Date.now();
    const statusNorm = normalizarStatusRotaFiltro(rota?.status || rota?.pagamentoStatus || 'CRIADA');

    if (statusNorm !== 'EM_ROTA') {
        alert('Só é possível desistir de rotas que estejam em rota.');
        return;
    }
    if (!confirm('Tem certeza que deseja desistir desta rota? Ela voltará para BUSCANDO e ficará disponível para outro entregador.')) {
        return;
    }

    const lojistaUid = rota?.origemLojistaUid || rota?.lojistaId || rota?.lojistaUid;
    if (!lojistaUid) {
        alert('Não foi possível identificar o lojista desta rota.');
        return;
    }

    const updates = {};
    updates[`usuarios/${lojistaUid}/rotas/${rota.id}/status`] = 'BUSCANDO';
    updates[`usuarios/${lojistaUid}/rotas/${rota.id}/pagamentoStatus`] = 'BUSCANDO';
    updates[`usuarios/${lojistaUid}/rotas/${rota.id}/entregadorId`] = null;
    updates[`usuarios/${lojistaUid}/rotas/${rota.id}/aceitoPor`] = null;
    updates[`usuarios/${lojistaUid}/rotas/${rota.id}/aceitoEm`] = null;
    updates[`usuarios/${lojistaUid}/rotas/${rota.id}/atualizadoEm`] = agora;

    const pacotesIds = Array.isArray(rota?.pacoteIds) ? rota.pacoteIds : (Array.isArray(rota?.pacotes) ? rota.pacotes : []);
    if (pacotesIds.length) {
        const clientesSnap = await db.ref(`usuarios/${lojistaUid}/clientes`).once('value');
        const clientesNo = clientesSnap.val() || {};
        const idsSet = new Set(pacotesIds.map((id) => String(id)));

        Object.keys(clientesNo).forEach((clienteId) => {
            const historico = Array.isArray(clientesNo[clienteId]?.historico) ? clientesNo[clienteId].historico : [];
            historico.forEach((h, idx) => {
                const idAtual = String(h?.id || ('envio-' + clienteId + '-' + idx));
                if (!idsSet.has(idAtual)) return;
                updates[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/status`] = 'BUSCANDO';
                updates[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/rotaId`] = null;
                updates[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/atualizadoEm`] = agora;
            });
        });
    }

    updates[`usuarios/${uidEnt}/rotas/${rota.id}`] = null;

    try {
        await db.ref().update(updates);
        if (window.usuarioLogado?.rotas) {
            delete window.usuarioLogado.rotas[rota.id];
        }
        // limpa caches locais
        if (Array.isArray(rotasHomeCache)) {
            rotasHomeCache = rotasHomeCache.filter((r) => String(r.id) !== String(rota.id));
        }
        entregadorHomeCache = { ...(entregadorHomeCache || {}), rotas: window.usuarioLogado?.rotas || {} };
        renderHistoricoRotasEntregador();
        renderizarDashboardEntregador(window.usuarioLogado || entregadorHomeCache || {});
        fecharModalDetalheRota();
        alert('Rota liberada e removida do seu painel.');
    } catch (err) {
        console.warn('Erro ao desistir da rota:', err);
        alert('Não foi possível desistir desta rota agora.');
    }
}

async function renderDashboardMaster() {
    if (!usuarioEhMaster()) return;

    // carrega pacotes raiz (modelo novo) uma vez por sessão admin
    if (!window.pacotesRaizCache) {
        window.pacotesRaizCache = {};
    }
    try {
        const snapPacRoot = await db.ref('pacotes').once('value');
        window.pacotesRaizCache = snapPacRoot?.val ? (snapPacRoot.val() || {}) : window.pacotesRaizCache;
    } catch (err) {
        console.warn('Falha ao carregar pacotes raiz (admin):', err);
    }

    const usersSnap = await db.ref('usuarios').once('value');
    const usersNo = usersSnap.val() || {};
    adminUsersCache = usersNo;
    const presenceSnap = await db.ref('presence').once('value').catch(() => ({ val: () => ({}) }));
    const presenceNo = presenceSnap?.val ? (presenceSnap.val() || {}) : {};

    let lojas = 0; let entregadores = 0; let masters = 0;
    let ativosL = 0; let ativosE = 0;

    const agoraTs = Date.now();
    const limiteAtivo = agoraTs - 2 * 60 * 1000; // 2 minutos

    Object.keys(usersNo).forEach((uid) => {
        const u = usersNo[uid] || {};
        const tipo = normalizarTexto(u.tipo || '');
        const pres = presenceNo[uid];
        const estaAtivo = pres && (pres.online === true || pres.online === undefined) && Number(pres.ts || 0) >= limiteAtivo;
        if (tipo === 'master' || tipo === 'admin') {
            masters += 1;
        } else if (tipo === 'entregador' || tipo === 'entrega') {
            entregadores += 1;
            if (estaAtivo) ativosE += 1;
        } else {
            lojas += 1;
            if (estaAtivo) ativosL += 1;
        }
    });

    // Pacotes
    let pacTotal = 0; let pacEmRota = 0; let pacEnt = 0; let pacCanc = 0;
    Object.keys(usersNo).forEach((uid) => {
        const clientesNo = usersNo[uid]?.clientes || {};
        Object.keys(clientesNo).forEach((cid) => {
            const hist = Array.isArray(clientesNo[cid]?.historico) ? clientesNo[cid].historico : [];
            hist.forEach((h) => {
                const st = normalizarStatusEnvioFiltro(h.status || h.statusRaw || 'PACOTE_NOVO');
                pacTotal += 1;
                if (st === 'EM_ROTA') pacEmRota += 1;
                else if (st === 'ENTREGUE') pacEnt += 1;
                else if (st === 'CANCELADO') pacCanc += 1;
            });
        });
    });

    // Rotas
    let rotTotal = 0; let rotBus = 0; let rotEm = 0; let rotCon = 0; let rotCanc = 0;
    const rotasRecuperaveis = [];
    Object.keys(usersNo).forEach((uid) => {
        const tipoUser = normalizarTexto(usersNo[uid]?.tipo || 'loja');
        if (tipoUser === 'entregador' || tipoUser === 'entrega') return; // ignora espelhos do entregador

        const rotasNo = usersNo[uid]?.rotas || {};
        // pacotes desse lojista (modelo antigo + novo)
        const pacotesLojista = [];
        const clientesNo = usersNo[uid]?.clientes || {};
        Object.keys(clientesNo).forEach((cid) => {
            const hist = Array.isArray(clientesNo[cid]?.historico) ? clientesNo[cid].historico : [];
            hist.forEach((h, idx) => {
                const idEnvio = h.id || `envio-${cid}-${idx}`;
                pacotesLojista.push({
                    id: idEnvio,
                    cidade: (h.cidadeDestino || h.cidade || extrairCamposEnderecoCliente(clientesNo[cid] || {}).cidade || '').toString().trim(),
                    destino: h.destinoEndereco || '',
                    distanciaKm: Number.isFinite(Number(h.distanciaKm)) ? Number(h.distanciaKm) : 0,
                    duracaoMin: Number.isFinite(Number(h.duracaoMin)) ? Number(h.duracaoMin) : 0
                });
            });
        });
        const pacotesRaizUid = window.pacotesRaizCache?.[uid] || {};
        Object.keys(pacotesRaizUid).forEach((pid) => {
            const p = pacotesRaizUid[pid] || {};
            pacotesLojista.push({
                id: pid,
                cidade: (p.cidadeDestino || p.cidade || extrairCidadeEnderecoSimples(p.destinoEndereco || p.destino || '')).toString().trim(),
                destino: p.destinoEndereco || p.destino || '',
                distanciaKm: Number.isFinite(Number(p.distanciaKm)) ? Number(p.distanciaKm) : 0,
                duracaoMin: Number.isFinite(Number(p.duracaoMin)) ? Number(p.duracaoMin) : 0
            });
        });
        const mapaPacotes = new Map(pacotesLojista.map((p) => [p.id, p]));

        Object.keys(rotasNo).forEach((rid) => {
            const r = rotasNo[rid] || {};
            const statusNorm = normalizarStatusRotaFiltro(r.status || r.pagamentoStatus || 'CRIADA');
            rotTotal += 1;
            if (statusNorm === 'BUSCANDO') rotBus += 1;
            else if (statusNorm === 'EM_ROTA') rotEm += 1;
            else if (statusNorm === 'CONCLUIDO') rotCon += 1;
            else if (statusNorm === 'CANCELADO') rotCanc += 1;

            const pacIds = Array.isArray(r.pacoteIds)
                ? r.pacoteIds
                : (Array.isArray(r.pacotes) ? r.pacotes : []);
            const pacotesDaRota = pacIds.map((id) => mapaPacotes.get(id)).filter(Boolean);
            const resumoCidades = resumirCidadesRota(pacotesDaRota);
            const destinoPrincipal = resumoCidades.display || resumoCidades.principal || r.destinoPrincipal || '--';
            const distSoma = pacotesDaRota.reduce((acc, p) => acc + (Number.isFinite(p?.distanciaKm) ? Number(p.distanciaKm) : 0), 0);
            const durSoma = pacotesDaRota.reduce((acc, p) => acc + (Number.isFinite(p?.duracaoMin) ? Number(p.duracaoMin) : 0), 0);

            rotasRecuperaveis.push({
                ...r,
                id: rid,
                lojistaUid: uid,
                statusNorm,
                destinoPrincipal,
                distanciaTotal: r.distanciaTotal || distSoma,
                duracaoTotal: r.duracaoTotal || durSoma
            });
        });
    });

    // Atualiza cards
    const setText = (id, txt) => {
        const el = document.getElementById(id);
        if (el) el.innerText = txt;
    };
    setText('adm-total-lojas', lojas);
    setText('adm-ativas-lojas', `Ativos agora: ${ativosL}`);
    setText('adm-total-entregas', entregadores);
    setText('adm-ativas-entregas', `Ativos agora: ${ativosE}`);
    setText('adm-pacotes-total', pacTotal);
    setText('adm-pacotes-status', `Em rota ${pacEmRota} • Entregues ${pacEnt} • Cancelados ${pacCanc}`);
    setText('adm-rotas-total', rotTotal);
    setText('adm-rotas-status', `Buscando ${rotBus} • Em rota ${rotEm} • Concluídas ${rotCon} • Canceladas ${rotCanc}`);

    // Tabela usuários
    const usersTable = document.getElementById('adm-users-table');
    if (usersTable) {
        const rows = Object.keys(usersNo).map((uid) => {
            const u = usersNo[uid] || {};
            const tipo = normalizarTexto(u.tipo || 'loja');
            const badgeClass = tipo === 'master' ? 'master' : (tipo === 'entregador' || tipo === 'entrega') ? 'entregador' : 'loja';
            const status = u.status || 'ativo';
            return `
                <div class="admin-row">
                    <div>
                        <strong>${escaparHtmlMarketplace(u.nome || 'Sem nome')}</strong>
                        <div class="admin-badge ${badgeClass}">${tipo}</div>
                    </div>
                    <div>${escaparHtmlMarketplace(u.email || '--')}</div>
                    <div>Status: ${escaparHtmlMarketplace(status)}</div>
                    <div class="admin-row-actions">
                        <button class="admin-btn reset" onclick="enviarResetSenhaMaster('${escaparHtmlMarketplace(u.email || '')}')">Reset senha</button>
                        <button class="admin-btn suspend" onclick="alternarStatusUsuarioMaster('${uid}', '${status === 'ativo' ? 'suspenso' : 'ativo'}')">${status === 'ativo' ? 'Suspender' : 'Ativar'}</button>
                    </div>
                </div>
            `;
        });
        usersTable.innerHTML = rows.length ? rows.join('') : '<div class="admin-row">Nenhum usuário cadastrado.</div>';
    }

    // Cards de rotas
    const rotasTable = document.getElementById('adm-rotas-cards');
    if (rotasTable) {
        const statusOpsRota = [
            { value: 'BUSCANDO', label: 'Buscando' },
            { value: 'EM_ROTA', label: 'Em Rota' },
            { value: 'CONCLUIDO', label: 'Concluída' },
            { value: 'CANCELADO', label: 'Cancelada' }
        ];
        const cards = rotasRecuperaveis.slice(0, 150).map((r) => {
            const lojistaNome = usersNo[r.lojistaUid]?.nome || 'Lojista';
            const idEsc = escaparHtmlMarketplace(r.id);
            const select = statusOpsRota.map((op) => {
                const sel = op.value === r.statusNorm ? 'selected' : '';
                return `<option value="${op.value}" ${sel}>${op.label}</option>`;
            }).join('');
            const destinoTxt = escaparHtmlMarketplace(r.destinoPrincipal || r.destino || r.destinoPrincipalCalculado || '--');
            return `
                <div class="adm-card" data-rota-id="${idEsc}" data-lojista-uid="${escaparHtmlMarketplace(r.lojistaUid)}">
                    <div class="adm-card-line">
                        <div class="adm-card-meta"><span class="adm-card-label">Id:</span><strong>${idEsc}</strong></div>
                        <div class="adm-card-meta"><span class="adm-card-label">User:</span><strong>${escaparHtmlMarketplace(lojistaNome)}</strong></div>
                        <div class="adm-card-meta"><span class="adm-card-label">Destino:</span><strong>${destinoTxt}</strong></div>
                        <div class="adm-card-status">
                            <label>Status:</label>
                            <select class="adm-card-select" data-rota-id="${idEsc}" data-lojista-uid="${escaparHtmlMarketplace(r.lojistaUid)}">
                                ${select}
                            </select>
                        </div>
                    </div>
                </div>
            `;
        });
        rotasTable.innerHTML = cards.length ? cards.join('') : '<div class="admin-row">Nenhuma rota encontrada.</div>';
    }

    adminChartsState = {
        usuarios: { lojas, entregadores, masters, ativosL, ativosE },
        pacotes: { total: pacTotal, emRota: pacEmRota, entregues: pacEnt, cancelados: pacCanc },
        rotas: { total: rotTotal, buscando: rotBus, emRota: rotEm, concluidas: rotCon, canceladas: rotCanc }
    };
    initAdminCharts();
    adminListTables();
}

async function enviarResetSenhaMaster(email) {
    if (!email) return alert('E-mail inválido.');
    try {
        await auth.sendPasswordResetEmail(email);
        alert('Link de redefinição enviado.');
    } catch (err) {
        alert('Falha ao enviar link: ' + err.message);
    }
}

let adminCharts = {};
function initAdminCharts() {
    if (!adminChartsState || typeof Chart === 'undefined') return;
    const makeChart = (id, cfg) => {
        const ctx = document.getElementById(id);
        if (!ctx) return;
        if (adminCharts[id]) {
            adminCharts[id].data = cfg.data;
            adminCharts[id].update();
            return;
        }
        adminCharts[id] = new Chart(ctx, cfg);
    };

    makeChart('adm-chart-usuarios', {
        type: 'doughnut',
        data: {
            labels: ['Lojistas', 'Entregadores', 'Master'],
            datasets: [{
                data: [adminChartsState.usuarios.lojas, adminChartsState.usuarios.entregadores, adminChartsState.usuarios.masters],
                backgroundColor: ['#fb923c', '#38bdf8', '#c084fc']
            }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });

    makeChart('adm-chart-pacotes', {
        type: 'bar',
        data: {
            labels: ['Total', 'Em rota', 'Entregues', 'Cancelados'],
            datasets: [{
                label: 'Pacotes',
                data: [adminChartsState.pacotes.total, adminChartsState.pacotes.emRota, adminChartsState.pacotes.entregues, adminChartsState.pacotes.cancelados],
                backgroundColor: ['#0ea5e9', '#fb923c', '#22c55e', '#ef4444']
            }]
        },
        options: { responsive: true, plugins: { legend: { display: false } } }
    });

    makeChart('adm-chart-rotas', {
        type: 'polarArea',
        data: {
            labels: ['Buscando', 'Em rota', 'Concluídas', 'Canceladas'],
            datasets: [{
                data: [adminChartsState.rotas.buscando, adminChartsState.rotas.emRota, adminChartsState.rotas.concluidas, adminChartsState.rotas.canceladas],
                backgroundColor: ['#f97316', '#38bdf8', '#22c55e', '#ef4444']
            }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });
}

async function adminListTables() {
    if (!usuarioEhMaster()) return;
    const tablesEl = document.getElementById('adm-db-tables');
    if (!tablesEl) return;
    try {
        const snap = await db.ref().limitToFirst(50).once('value');
        const val = snap.val() || {};
        const rows = Object.keys(val).map((key) => {
            const isObj = val[key] && typeof val[key] === 'object';
            const size = isObj ? Object.keys(val[key]).length : 1;
            return `
                <div class="admin-row">
                    <div><strong>${escaparHtmlMarketplace(key)}</strong></div>
                    <div>${size} item(ns)</div>
                </div>
            `;
        });
        tablesEl.innerHTML = rows.length ? rows.join('') : '<div class="admin-row">Sem tabelas encontradas.</div>';
    } catch (err) {
        tablesEl.innerHTML = '<div class="admin-row">Falha ao carregar tabelas.</div>';
    }
}

async function adminCreateTable() {
    if (!usuarioEhMaster()) return;
    const name = (document.getElementById('adm-new-table')?.value || '').trim();
    if (!name) return alert('Informe o nome da tabela.');
    await db.ref(name).set({ _createdAt: Date.now() });
    alert('Tabela criada.');
    adminListTables();
}

async function adminCreateField() {
    if (!usuarioEhMaster()) return;
    const table = (document.getElementById('adm-field-table')?.value || '').trim();
    const key = (document.getElementById('adm-field-key')?.value || '').trim();
    const val = document.getElementById('adm-field-value')?.value || '';
    if (!table || !key) return alert('Informe tabela e campo.');
    await db.ref(`${table}/${key}`).set(val);
    alert('Campo salvo.');
    adminListTables();
}

async function adminDeleteField() {
    if (!usuarioEhMaster()) return;
    const path = (document.getElementById('adm-del-path')?.value || '').trim();
    if (!path) return alert('Informe o caminho completo.');
    await db.ref(path).remove();
    alert('Campo removido.');
    adminListTables();
}

async function alternarStatusUsuarioMaster(uid, novoStatus = 'ativo') {
    if (!usuarioEhMaster() || !uid) return;
    await db.ref(`usuarios/${uid}/status`).set(novoStatus);
    renderDashboardMaster();
}

async function adminCarregarPacotes() {
    try {
        const container = document.getElementById('adm-pack-cards');
        if (!container) return;
        container.innerHTML = '<div class="admin-row">Carregando pacotes...</div>';

        const user = firebase.auth().currentUser;
        if (!user) {
            container.innerHTML = 'Autenticando...';
            firebase.auth().onAuthStateChanged((u) => {
                if (u) adminCarregarPacotes();
                else container.innerHTML = 'Sessão expirada. Faça login como master.';
            });
            return;
        }

        let linhas = [];

        // leitura global de todos os usuários
        // usa cache do dashboard se já carregou
        let dataUsers = adminUsersCache;
        if (!dataUsers) {
            let snapUsers = await db.ref('usuarios').once('value').catch(() => null);
            if (snapUsers && snapUsers.exists()) {
                dataUsers = snapUsers.val() || {};
            } else {
                snapUsers = await db.ref('users').once('value').catch(() => null);
                if (snapUsers && snapUsers.exists()) dataUsers = snapUsers.val() || {};
            }
            adminUsersCache = dataUsers;
        }

        Object.keys(dataUsers).forEach((u) => {
            const cli = dataUsers[u].clientes || {};
            Object.values(cli).forEach((cliente) => {
                const histArr = Array.isArray(cliente.historico)
                    ? cliente.historico
                    : (cliente.historico && typeof cliente.historico === 'object'
                        ? Object.values(cliente.historico)
                        : []);
                histArr.forEach((h, idx) => {
                    const envioId = h.id || h.codigo || ('envio-' + (cliente.id || u) + '-' + idx);
                    linhas.push({
                        id: envioId,
                        status: normalizarStatusEnvioFiltro(h.status || 'PACOTE_NOVO'),
                        cliente: cliente.nome || '',
                        lojista: dataUsers[u].nome || u,
                        cidade: h.cidade || cliente.cidade || ''
                    });
                });
            });
        });

        // leitura de /pacotes (novo modelo)
        let pacotesRaiz = {};
        try {
            const snapPac = await db.ref('pacotes').once('value');
            if (snapPac && snapPac.exists()) pacotesRaiz = snapPac.val() || {};
        } catch (_) {}

        Object.keys(pacotesRaiz).forEach((uid) => {
            const pacs = pacotesRaiz[uid] || {};
            Object.keys(pacs).forEach((pid) => {
                const p = pacs[pid] || {};
                linhas.push({
                    id: pid,
                    status: normalizarStatusEnvioFiltro(p.status || p.statusRaw || 'PACOTE_NOVO'),
                    cliente: (p.destinatario || p.cliente || '').toString(),
                    lojista: dataUsers?.[uid]?.nome || uid,
                    cidade: p.cidadeDestino || p.cidade || extrairCidadeEnderecoSimples(p.destinoEndereco || p.destino || '')
                });
            });
        });

        // fallback local se nada retornou (ex.: regras de leitura)
        if (!linhas.length && Array.isArray(clientes)) {
            clientes.forEach((cliente) => {
                const histArr = Array.isArray(cliente.historico)
                    ? cliente.historico
                    : (cliente.historico && typeof cliente.historico === 'object'
                        ? Object.values(cliente.historico)
                        : []);
                histArr.forEach((h, idx) => {
                    const envioId = h.id || h.codigo || ('envio-' + (cliente.id || 'local') + '-' + idx);
                    linhas.push({
                        id: envioId,
                        status: normalizarStatusEnvioFiltro(h.status || 'PACOTE_NOVO'),
                        cliente: cliente.nome || '',
                        lojista: usuarioLogado?.nome || getUsuarioIdAtual() || '',
                        cidade: h.cidade || cliente.cidade || ''
                    });
                });
            });
        }

        if (!linhas.length) {
            container.innerHTML = '<div class="admin-row">Nenhum pacote encontrado.</div>';
            return;
        }

        const statusOps = [
            { value: 'PACOTE_NOVO', label: 'Novo Pacote' },
            { value: 'BUSCANDO', label: 'Buscando' },
            { value: 'EM_ROTA', label: 'Em Rota' },
            { value: 'ENTREGUE', label: 'Entregue' },
            { value: 'CANCELADO', label: 'Cancelado' }
        ];

        linhas.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
        const html = linhas.slice(0, 150).map((l) => {
            const idEsc = escaparHtmlMarketplace(l.id);
            const select = statusOps.map((op) => {
                const sel = op.value === l.status ? 'selected' : '';
                return `<option value="${op.value}" ${sel}>${op.label}</option>`;
            }).join('');
            return `
                <div class="adm-card" data-pack-id="${idEsc}">
                    <div class="adm-card-line">
                        <div class="adm-card-meta"><span class="adm-card-label">Id:</span><strong>${idEsc}</strong></div>
                        <div class="adm-card-meta"><span class="adm-card-label">User:</span><strong>${escaparHtmlMarketplace(l.lojista || '--')}</strong></div>
                        <div class="adm-card-meta"><span class="adm-card-label">Cliente:</span><strong>${escaparHtmlMarketplace(l.cliente || '--')}</strong></div>
                        <div class="adm-card-status">
                            <label>Status:</label>
                            <select class="adm-card-select" data-pack-id="${idEsc}">
                                ${select}
                            </select>
                        </div>
                    </div>
                </div>`;
        }).join('');

        container.innerHTML = html;
        if (!linhas.length) {
            container.innerHTML = '<div class="admin-row">Nenhum pacote encontrado.</div>';
        }
        if (typeof lucide !== 'undefined') lucide.createIcons();
    } catch (err) {
        console.error('Erro ao carregar pacotes', err);
        const container = document.getElementById('adm-pack-cards');
        if (container) {
            container.innerHTML = `<div class="admin-row">Falha ao carregar: ${err?.code || ''} ${err?.message || err}</div>`;
        }
        notificarErro('Falha ao carregar pacotes.');
    }
}

function adminAlterarStatusPacotes() {
    adminSalvarPacotes();
}

function adminSalvarPacotes() {
    const container = document.getElementById('adm-pack-cards');
    if (!container) return;
    const selects = Array.from(container.querySelectorAll('select.adm-card-select'));
    if (!selects.length) return;

    const grupos = new Map();
    selects.forEach((sel) => {
        const id = sel.dataset.packId || sel.closest('[data-pack-id]')?.dataset.packId;
        const status = (sel.value || 'PACOTE_NOVO').toUpperCase();
        if (!id) return;
        if (!grupos.has(status)) grupos.set(status, []);
        grupos.get(status).push(id);
    });

    grupos.forEach((ids, status) => setStatusPacotes(ids, status, true));
    notificarErro('Status atualizado.');
    adminCarregarPacotes();
}

async function atualizarStatusRotaMaster(lojistaUid, rotaId, status = 'BUSCANDO') {
    if (!usuarioEhMaster() || !lojistaUid || !rotaId) return;
    const agora = Date.now();
    const updates = {};
    updates[`usuarios/${lojistaUid}/rotas/${rotaId}/status`] = status;
    updates[`usuarios/${lojistaUid}/rotas/${rotaId}/pagamentoStatus`] = status;
    updates[`usuarios/${lojistaUid}/rotas/${rotaId}/atualizadoEm`] = agora;
    if (status === 'BUSCANDO') {
        updates[`usuarios/${lojistaUid}/rotas/${rotaId}/entregadorId`] = null;
        updates[`usuarios/${lojistaUid}/rotas/${rotaId}/aceitoPor`] = null;
        updates[`usuarios/${lojistaUid}/rotas/${rotaId}/aceitoEm`] = null;
    }
    await db.ref().update(updates);
}

async function adminSalvarRotas() {
    const container = document.getElementById('adm-rotas-cards');
    if (!container) return;
    const selects = Array.from(container.querySelectorAll('select.adm-card-select'));
    if (!selects.length) return;
    const promessas = selects.map((sel) => {
        const rotaId = sel.dataset.rotaId || sel.closest('[data-rota-id]')?.dataset.rotaId;
        const lojistaUid = sel.dataset.lojistaUid || sel.closest('[data-lojista-uid]')?.dataset.lojistaUid;
        const status = (sel.value || 'BUSCANDO').toUpperCase();
        return atualizarStatusRotaMaster(lojistaUid, rotaId, status);
    });
    await Promise.all(promessas);
    notificarErro('Status das rotas atualizado.');
    renderDashboardMaster();
}

async function restaurarRotaMaster(lojistaUid, rotaId) {
    if (!usuarioEhMaster() || !lojistaUid || !rotaId) return;

    // pega o entregador atual (se tiver) antes de limpar, pra também remover a cópia
    // da rota do lado dele — sem isso a rota reaparecia fantasma no dashboard dele.
    let entregadorId = '';
    try {
        const snap = await db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}`).once('value');
        const atual = snap.val() || {};
        entregadorId = String(atual.entregadorId || atual.aceitoPor || '');
    } catch (_) {
        entregadorId = '';
    }

    const updates = {};
    const agora = Date.now();
    updates[`usuarios/${lojistaUid}/rotas/${rotaId}/status`] = 'BUSCANDO';
    updates[`usuarios/${lojistaUid}/rotas/${rotaId}/pagamentoStatus`] = 'BUSCANDO';
    updates[`usuarios/${lojistaUid}/rotas/${rotaId}/entregadorId`] = null;
    updates[`usuarios/${lojistaUid}/rotas/${rotaId}/aceitoPor`] = null;
    updates[`usuarios/${lojistaUid}/rotas/${rotaId}/aceitoEm`] = null;
    updates[`usuarios/${lojistaUid}/rotas/${rotaId}/entregadorGeo`] = null;
    updates[`usuarios/${lojistaUid}/rotas/${rotaId}/atualizadoEm`] = agora;
    await db.ref().update(updates);

    if (entregadorId) {
        await db.ref(`usuarios/${entregadorId}/rotas/${rotaId}`).remove().catch(() => {});
    }

    alert('Rota restaurada para BUSCANDO.');
    renderDashboardMaster();
}

function renderRotaDetalhePagina() {
    const wrap = document.getElementById('rota-detalhe-page-wrap');
    const dots = document.getElementById('rota-detalhe-dots');
    const info = document.getElementById('rota-detalhe-page-info');
    const btnPrev = document.getElementById('rota-detalhe-prev');
    const btnNext = document.getElementById('rota-detalhe-next');
    if (!wrap || !dots || !info || !btnPrev || !btnNext) return;

    if (!rotaDetalhePacotes.length) {
        wrap.innerHTML = '<div class="rota-detalhe-package-card"><p style="color:var(--text-sub); font-size:13px;">Sem pacotes vinculados a esta rota.</p></div>';
        dots.innerHTML = '';
        info.innerText = '0/0';
        btnPrev.disabled = true;
        btnNext.disabled = true;
        return;
    }

    rotaDetalhePaginaAtual = Math.max(0, Math.min(rotaDetalhePaginaAtual, rotaDetalhePacotes.length - 1));
    const p = rotaDetalhePacotes[rotaDetalhePaginaAtual];

    wrap.innerHTML = `
        <div class="rota-detalhe-package-card">
            <h4>Pacote #${p.codigo} · ${p.destinatario}</h4>
            <div class="rota-detalhe-line"><span>WhatsApp</span><strong>${p.whatsapp || '--'}</strong></div>
            <div class="rota-detalhe-line"><span>Serviço</span><strong>${p.servico || '--'}</strong></div>
            <div class="rota-detalhe-line"><span>Veículo</span><strong>${p.veiculo || '--'}</strong></div>
            <div class="rota-detalhe-line"><span>Tamanho</span><strong>${p.tamanho || '--'}</strong></div>
            <div class="rota-detalhe-line"><span>Distância</span><strong>${formatarDistancia(p.distanciaKm)}</strong></div>
            <div class="rota-detalhe-line"><span>Duração</span><strong>${formatarDuracao(p.duracaoMin)}</strong></div>
            <div class="rota-detalhe-line"><span>Valor frete</span><strong>${precoParaMoeda(p.valorFrete || 0)}</strong></div>
            <div class="rota-detalhe-line"><span>Valor conteúdo</span><strong>${Number.isFinite(p.valorConteudo) ? precoParaMoeda(p.valorConteudo) : '--'}</strong></div>
            <div class="rota-detalhe-block"><span>Descrição</span><p>${p.descricao || '--'}</p></div>
            <div class="rota-detalhe-block"><span>Observações</span><p>${p.observacoes || '--'}</p></div>
            <div class="rota-detalhe-block"><span>Origem</span><p>${p.origemEndereco || '--'}</p></div>
            <div class="rota-detalhe-block"><span>Destino</span><p>${p.destinoEndereco || '--'}</p></div>
        </div>
    `;

    dots.innerHTML = rotaDetalhePacotes.map((_, idx) => `<span class="rota-detalhe-dot ${idx === rotaDetalhePaginaAtual ? 'active' : ''}"></span>`).join('');
    info.innerText = `${rotaDetalhePaginaAtual + 1}/${rotaDetalhePacotes.length}`;
    btnPrev.disabled = rotaDetalhePaginaAtual <= 0;
    btnNext.disabled = rotaDetalhePaginaAtual >= rotaDetalhePacotes.length - 1;
}

function abrirModalDetalheRota(rotaId) {
    if (!rotaId) return;
    let rota = rotasHomeCache.find((r) => String(r.id) === String(rotaId));
    if (!rota && usuarioEhEntregador()) {
        const rotasEnt = window.usuarioLogado?.rotas || {};
        if (rotasEnt[rotaId]) {
            rota = { id: rotaId, ...(rotasEnt[rotaId] || {}) };
        }
    }
    if (!rota) return;

    rotaDetalheAtual = rota;
    rotaDetalhePacotes = getPacotesDaRota(rota);
    rotaDetalhePaginaAtual = 0;

    atualizarResumoModalDetalheRota();
    renderRotaDetalhePagina();

    const overlay = document.getElementById('overlay-rota-detalhe');
    const sheet = document.getElementById('sheet-rota-detalhe');
    if (!overlay || !sheet) return;

    overlay.style.display = 'flex';
    requestAnimationFrame(() => sheet.classList.add('show'));
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function fecharModalDetalheRota() {
    const overlay = document.getElementById('overlay-rota-detalhe');
    const sheet = document.getElementById('sheet-rota-detalhe');
    if (!overlay || !sheet) return;
    sheet.classList.remove('show');
    setTimeout(() => { overlay.style.display = 'none'; }, 240);
}

function paginaAnteriorDetalheRota() {
    if (rotaDetalhePaginaAtual <= 0) return;
    rotaDetalhePaginaAtual -= 1;
    renderRotaDetalhePagina();
}

function proximaPaginaDetalheRota() {
    if (rotaDetalhePaginaAtual >= rotaDetalhePacotes.length - 1) return;
    rotaDetalhePaginaAtual += 1;
    renderRotaDetalhePagina();
}

function iniciarSwipePaginaRota(event) {
    rotaDetalheSwipeStartX = event.touches[0].clientX;
    rotaDetalheSwipeEndX = rotaDetalheSwipeStartX;
}

function moverSwipePaginaRota(event) {
    rotaDetalheSwipeEndX = event.touches[0].clientX;
}

function finalizarSwipePaginaRota() {
    const diff = rotaDetalheSwipeEndX - rotaDetalheSwipeStartX;
    if (Math.abs(diff) < 45) return;
    if (diff < 0) {
        proximaPaginaDetalheRota();
    } else {
        paginaAnteriorDetalheRota();
    }
}

// Modal de criar rota (fluxo 3 passos)
const overlayRota = document.getElementById('overlay-rota');
const sheetRota = document.getElementById('sheet-rota');

function gerarIdRota() {
    return 'R' + Date.now().toString().slice(-8);
}

function normalizarCidadeRota(valor) {
    return (valor || '').toString().trim().toLowerCase();
}

function coletarEnviosPendentesParaRota() {
    const pendentes = [];

    clientes.forEach((cliente) => {
        const historico = Array.isArray(cliente.historico) ? cliente.historico : [];
        const camposEndereco = extrairCamposEnderecoCliente(cliente || {});

        historico.forEach((h, idx) => {
            const statusNorm = normalizarStatusEnvioFiltro(h.status || 'PACOTE_NOVO');
            if (statusNorm !== 'PACOTE_NOVO') return;

            const envioId = h.id || ('envio-' + cliente.id + '-' + idx);
            const codigo = envioId.replace('envio-', '').slice(-4);
            const servico = h.servico || 'Standard';
            const flash = servico.toLowerCase() === 'flash';
            const cidade = (camposEndereco.cidade || cliente.cidade || 'Sem cidade').toString().trim() || 'Sem cidade';
            const valorFrete = Number.isFinite(Number(h.valorFrete)) ? Number(h.valorFrete) : parseMoedaParaNumero(h.valor || 0);

            pendentes.push({
                id: envioId,
                clienteId: cliente.id,
                codigo,
                destinatario: cliente.nome || 'Cliente',
                cidade,
                servico,
                flash,
                valorFrete,
                veiculo: h.veiculo || 'Moto'
            });
        });
    });

    return pendentes.sort((a, b) => (a.codigo < b.codigo ? 1 : -1));
}

function atualizarResumoSelecaoRota() {
    const totalEl = document.getElementById('rota-selected-total');
    const cidadesEl = document.getElementById('rota-selected-cities');
    const actionBtn = document.getElementById('rota-flow-action-btn');

    const selecionados = rotaPendentesCache.filter((p) => rotaSelecaoIds.has(p.id));
    const cidades = new Set(selecionados.map((p) => normalizarCidadeRota(p.cidade)).filter(Boolean));

    if (totalEl) totalEl.innerText = selecionados.length + ' pacotes selecionados';
    if (cidadesEl) cidadesEl.innerText = cidades.size + '/3 cidades';
    if (actionBtn && rotaModalStep === 1) actionBtn.disabled = selecionados.length === 0;
}

function renderListaPendentesRota() {
    const container = document.getElementById('rota-pending-list');
    if (!container) return;

    if (!rotaPendentesCache.length) {
        container.innerHTML = '<div class="rota-flow-empty">Você não tem envios pendentes para montar rota.</div>';
        atualizarResumoSelecaoRota();
        return;
    }

    container.innerHTML = rotaPendentesCache.map((pacote) => {
        const selecionado = rotaSelecaoIds.has(pacote.id);
        const badgeClass = pacote.flash ? 'rota-badge-flash' : 'rota-badge-standard';
        const badgeText = pacote.flash ? 'FLASH' : 'STANDARD';
        const cityText = pacote.cidade || 'Sem cidade';

        return `
            <button type="button" class="rota-pending-item ${selecionado ? 'selected' : ''}" onclick="togglePacoteRota('${pacote.id}')">
                <div class="rota-pending-main">
                    <strong>Pedido #${pacote.codigo} - ${pacote.destinatario}</strong>
                    <span>${cityText} • ${pacote.veiculo}</span>
                </div>
                <div class="rota-pending-meta">
                    <span class="${badgeClass}">${badgeText}</span>
                    <strong>${precoParaMoeda(pacote.valorFrete || 0)}</strong>
                </div>
            </button>
        `;
    }).join('');

    atualizarResumoSelecaoRota();
}

function podeSelecionarPacoteRota(pacote) {
    const selecionados = rotaPendentesCache.filter((item) => rotaSelecaoIds.has(item.id));

    if (pacote.flash && selecionados.some((item) => item.flash)) {
        alert('Regra Flash: apenas 1 pacote Flash por rota.');
        return false;
    }

    const cidades = new Set(selecionados.map((item) => normalizarCidadeRota(item.cidade)).filter(Boolean));
    cidades.add(normalizarCidadeRota(pacote.cidade));

    if (cidades.size > 3) {
        alert('Esta rota permite no máximo 3 cidades diferentes.');
        return false;
    }

    return true;
}

function togglePacoteRota(envioId) {
    const pacote = rotaPendentesCache.find((item) => item.id === envioId);
    if (!pacote) return;

    if (rotaSelecaoIds.has(envioId)) {
        rotaSelecaoIds.delete(envioId);
    } else {
        if (!podeSelecionarPacoteRota(pacote)) return;
        rotaSelecaoIds.add(envioId);
    }

    renderListaPendentesRota();
}

function renderEtapaModalRota() {
    const step1 = document.getElementById('rota-flow-step-1');
    const step2 = document.getElementById('rota-flow-step-2');
    const step3 = document.getElementById('rota-flow-step-3');
    const title = document.getElementById('rota-flow-title');
    const label = document.getElementById('rota-flow-step-label');
    const btn = document.getElementById('rota-flow-action-btn');
    const backBtn = document.getElementById('rota-flow-back');

    if (!step1 || !step2 || !step3 || !title || !label || !btn || !backBtn) return;

    step1.classList.toggle('hidden', rotaModalStep !== 1);
    step2.classList.toggle('hidden', rotaModalStep !== 2);
    step3.classList.toggle('hidden', rotaModalStep !== 3);

    if (rotaModalStep === 1) {
        title.innerText = 'Criar Rota';
        label.innerText = 'Passo 1 de 3';
        btn.innerText = 'Pagamento';
        btn.disabled = rotaSelecaoIds.size === 0;
        backBtn.style.visibility = 'hidden';
    } else if (rotaModalStep === 2) {
        title.innerText = 'Pagamento Pix';
        label.innerText = 'Passo 2 de 3';
        btn.innerText = 'Verificar pagamento';
        const pagamentoMpAtual = rotaDraftAtual?.pagamentoMercadoPago;
        btn.disabled = !pagamentoMpAtual?.pixCode && pagamentoMpAtual?.status !== 'approved';
        backBtn.style.visibility = 'visible';
    } else {
        title.innerText = 'Rota Criada';
        label.innerText = 'Passo 3 de 3';
        btn.innerText = 'Concluir';
        btn.disabled = false;
        backBtn.style.visibility = 'hidden';
    }
}

async function chamarPaymentsProxy(caminho, payload) {
    if (!FLEXA_PAYMENTS_PROXY_URL) {
        throw new Error('Endpoint de pagamento (FLEXA_PAYMENTS_PROXY_URL) não configurado.');
    }
    if (!auth.currentUser) {
        throw new Error('Sessão expirada. Faça login novamente.');
    }

    const idToken = await auth.currentUser.getIdToken();
    const resp = await fetch(FLEXA_PAYMENTS_PROXY_URL + caminho, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + idToken,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const data = await resp.json().catch(() => ({}));
    if (data?.ambiente) {
        mercadoPagoAmbienteAtual = data.ambiente;
    }
    if (!resp.ok) {
        throw new Error(data?.error || data?.message || ('HTTP ' + resp.status));
    }
    return data;
}

function obterNomeLojistaSeparadoTesteLocal() {
    const nomeCompleto = (window.usuarioLogado?.nome || 'Lojista Flexa').toString().trim();
    const partes = nomeCompleto.split(/\s+/).filter(Boolean);
    const firstName = partes[0] || 'Lojista';
    const lastName = partes.slice(1).join(' ') || 'Flexa';
    return { firstName, lastName };
}

function obterEmailPagadorTesteLocal() {
    const email = (
        auth.currentUser?.email ||
        window.usuarioLogado?.email ||
        'cliente_teste@flexa.app'
    ).toString().trim().toLowerCase();
    return email.includes('@') ? email : 'cliente_teste@flexa.app';
}

function gerarIdempotencyKeyTesteLocal() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
    }
    return 'flexa-' + Date.now() + '-' + Math.random().toString(16).slice(2, 12);
}

// Caminho TEMPORÁRIO de teste local: chama o Mercado Pago direto do navegador com
// FLEXA_MP_TEST_TOKEN (validado no topo do arquivo para só aceitar token "TEST-").
// Existe só porque a Cloud Function "payments" exige plano Blaze, ainda não ativado.
// Assim que FLEXA_PAYMENTS_PROXY_URL estiver configurada, esse caminho para de ser usado
// automaticamente (ver criarPagamentoPixMercadoPago).
async function criarPagamentoPixTesteClienteLocal(rotaDraft) {
    // valorRestantePix já vem descontado do crédito de saldo aplicado (ver
    // irParaPagamentoRota) — cai pro totalFrete cheio se não tiver sido calculado.
    const valor = Number(rotaDraft?.valorRestantePix ?? rotaDraft?.totalFrete ?? 0);
    if (!Number.isFinite(valor) || valor <= 0) {
        throw new Error('Valor da rota inválido para cobrança Pix.');
    }

    const { firstName, lastName } = obterNomeLojistaSeparadoTesteLocal();
    const resp = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + FLEXA_MP_TEST_TOKEN,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': gerarIdempotencyKeyTesteLocal()
        },
        body: JSON.stringify({
            transaction_amount: Number(valor.toFixed(2)),
            description: 'Flexa Rota ' + rotaDraft.id + ' (' + rotaDraft.qtd + ' pacote(s)) [TESTE LOCAL]',
            payment_method_id: 'pix',
            payer: {
                email: obterEmailPagadorTesteLocal(),
                first_name: firstName,
                last_name: lastName
            },
            date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            external_reference: rotaDraft.id
        })
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const detalhe = data?.message || data?.error || data?.cause?.[0]?.description || ('HTTP ' + resp.status);
        throw new Error('Mercado Pago: ' + detalhe);
    }

    const tx = data?.point_of_interaction?.transaction_data || {};
    return {
        provider: 'mercadopago',
        paymentId: data?.id ? String(data.id) : '',
        status: data?.status || 'pending',
        statusDetail: data?.status_detail || '',
        pixCode: tx.qr_code || '',
        ticketUrl: tx.ticket_url || '',
        qrCodeBase64: tx.qr_code_base64 || ''
    };
}

async function consultarPagamentoPixTesteClienteLocal(paymentId) {
    const resp = await fetch('https://api.mercadopago.com/v1/payments/' + paymentId, {
        headers: { 'Authorization': 'Bearer ' + FLEXA_MP_TEST_TOKEN }
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error('Falha ao consultar pagamento: ' + (data?.message || data?.error || ('HTTP ' + resp.status)));
    }
    return {
        status: data?.status || 'pending',
        statusDetail: data?.status_detail || ''
    };
}

// Cria a cobrança Pix. Prioridade: Cloud Function "payments" (produção, token nunca
// chega ao navegador) — se não estiver configurada, cai no teste local só-TEST- acima.
async function criarPagamentoPixMercadoPago(rotaDraft) {
    const uid = getUsuarioIdAtual();
    if (!uid) {
        throw new Error('Sessão expirada. Faça login novamente.');
    }
    if (!Array.isArray(rotaDraft?.pacotes) || !rotaDraft.pacotes.length) {
        throw new Error('Rota sem pacotes selecionados.');
    }

    let data;
    if (FLEXA_PAYMENTS_PROXY_URL) {
        data = await chamarPaymentsProxy('/create-pix', {
            tenantId: uid,
            rotaId: rotaDraft.id,
            envioIds: rotaDraft.pacotes
        });
    } else if (FLEXA_MP_TEST_TOKEN) {
        data = await criarPagamentoPixTesteClienteLocal(rotaDraft);
    } else {
        throw new Error('Pagamento não configurado: defina FLEXA_PAYMENTS_PROXY_URL (produção) ou FLEXA_MP_TEST_TOKEN (só teste local) no index.html.');
    }

    const pixCode = normalizarCodigoPix(data.pixCode || '');
    if (!pixCode) {
        throw new Error('Mercado Pago não retornou código Pix Copia e Cola.');
    }

    return {
        provider: 'mercadopago',
        paymentId: data?.paymentId ? String(data.paymentId) : '',
        status: data?.status || 'pending',
        statusDetail: data?.statusDetail || '',
        pixCode,
        ticketUrl: data?.ticketUrl || '',
        qrCodeBase64: data?.qrCodeBase64 || ''
    };
}

async function consultarPagamentoPixMercadoPago(paymentId) {
    const uid = getUsuarioIdAtual();
    if (!uid || !paymentId) return null;
    if (!FLEXA_PAYMENTS_PROXY_URL && !FLEXA_MP_TEST_TOKEN) return null;

    const data = FLEXA_PAYMENTS_PROXY_URL
        ? await chamarPaymentsProxy('/check-pix', { tenantId: uid, paymentId })
        : await consultarPagamentoPixTesteClienteLocal(paymentId);

    return {
        status: data?.status || 'pending',
        statusDetail: data?.statusDetail || ''
    };
}

async function irParaPagamentoRota() {
    const selecionados = rotaPendentesCache.filter((item) => rotaSelecaoIds.has(item.id));
    if (!selecionados.length) {
        alert('Selecione pelo menos 1 pacote para continuar.');
        return;
    }

    const total = selecionados.reduce((acc, item) => acc + Number(item.valorFrete || 0), 0);

    rotaDraftAtual = {
        id: gerarIdRota(),
        pacotes: selecionados.map((item) => item.id),
        qtd: selecionados.length,
        totalFrete: Number(total.toFixed(2)),
        criadoEm: Date.now(),
        pagamento: 'PENDENTE',
        status: 'BUSCANDO',
        pagamentoMercadoPago: null
    };

    // Saldo/crédito da carteira: nunca passa pelo Mercado Pago, é um valor interno
    // do sistema (inclui crédito de estornos, ver project-flexa-notificacoes-e-exclusao).
    // Se cobre o total, mostra botão "Pagar com saldo" (sem Pix nenhum). Se cobre só
    // parte, aplica automaticamente como desconto e gera o Pix só pela diferença.
    // IMPORTANTE: busca o saldo AO VIVO no Firebase, não usa window.usuarioLogado
    // (que é só um cache carregado no login e pode estar desatualizado) — assim o
    // valor mostrado aqui sempre bate com o que a transação de débito vai encontrar.
    const saldoCard = document.getElementById('rota-saldo-pagamento-card');
    const saldoValorEl = document.getElementById('rota-saldo-disponivel-valor');
    const saldoBtnEl = document.getElementById('rota-saldo-pagar-btn');
    const saldoInfoEl = document.getElementById('rota-saldo-aplicado-info');
    const uidSaldo = getUsuarioIdAtual();
    let saldoAtualLive = 0;
    if (uidSaldo) {
        try {
            const snapSaldo = await db.ref(`usuarios/${uidSaldo}/financeiro/saldo`).once('value');
            saldoAtualLive = Number(snapSaldo.val() || 0);
        } catch (err) {
            console.warn('Erro ao ler saldo ao vivo:', err);
            saldoAtualLive = 0;
        }
    }
    rotaDraftAtual.saldoDisponivelNoMomento = saldoAtualLive;

    // Aplicação parcial automática de crédito só é feita no caminho local de teste
    // (sem Cloud Function configurada) — a Cloud Function "payments" ainda não sabe
    // recalcular o valor do Pix descontando saldo, então em produção mantemos o
    // comportamento antigo (só "pagar tudo com saldo" ou "pagar tudo no Pix") até
    // essa parte ser implementada no servidor também.
    const podeAplicarCreditoParcial = !FLEXA_PAYMENTS_PROXY_URL;
    const creditoAplicavel = podeAplicarCreditoParcial
        ? Math.max(0, Math.min(saldoAtualLive, rotaDraftAtual.totalFrete))
        : (saldoAtualLive >= rotaDraftAtual.totalFrete ? rotaDraftAtual.totalFrete : 0);
    const valorRestantePix = Number((rotaDraftAtual.totalFrete - creditoAplicavel).toFixed(2));
    rotaDraftAtual.creditoCarteiraAplicado = creditoAplicavel;
    rotaDraftAtual.valorRestantePix = valorRestantePix;

    if (saldoCard) {
        if (creditoAplicavel <= 0 || rotaDraftAtual.totalFrete <= 0) {
            saldoCard.style.display = 'none';
        } else {
            saldoCard.style.display = 'block';
            if (saldoValorEl) saldoValorEl.innerText = precoParaMoeda(saldoAtualLive);
            if (valorRestantePix <= 0) {
                if (saldoBtnEl) saldoBtnEl.style.display = '';
                if (saldoInfoEl) saldoInfoEl.style.display = 'none';
            } else {
                // cobre só parte: aplica sozinho, sem precisar clicar em nada — o botão
                // some porque o crédito já vai entrar automaticamente ao confirmar o Pix
                if (saldoBtnEl) saldoBtnEl.style.display = 'none';
                if (saldoInfoEl) {
                    saldoInfoEl.style.display = 'block';
                    saldoInfoEl.innerText = `${precoParaMoeda(creditoAplicavel)} do seu saldo serão aplicados automaticamente. Falta pagar ${precoParaMoeda(valorRestantePix)} via Pix.`;
                }
            }
        }
    }

    const pixTxt = document.getElementById('rota-pix-code');
    const pixQtd = document.getElementById('rota-pix-qtd');
    const pixTotal = document.getElementById('rota-pix-total');
    const pixFeedback = document.getElementById('rota-pix-copy-feedback');

    rotaPixCodigoRawAtual = '';
    if (pixTxt) pixTxt.textContent = 'Gerando código Pix...';
    if (pixQtd) pixQtd.innerText = String(rotaDraftAtual.qtd);
    if (pixTotal) pixTotal.innerText = precoParaMoeda(valorRestantePix > 0 ? valorRestantePix : rotaDraftAtual.totalFrete);
    if (pixFeedback) pixFeedback.innerText = '';
    setTicketPagamentoPixRota('');
    atualizarAvisoAmbientePix();

    rotaModalStep = 2;
    renderEtapaModalRota();

    if (valorRestantePix <= 0) {
        // saldo cobre o total: nem gera Pix, só espera o clique em "Pagar com saldo"
        if (pixTxt) pixTxt.textContent = '--';
        setStatusPagamentoPixRota('Saldo cobre o valor total. Use "Pagar com saldo" acima.', 'approved');
        return;
    }

    setStatusPagamentoPixRota('Gerando cobrança Pix no Mercado Pago...', 'loading');

    try {
        const pixPagamento = await criarPagamentoPixMercadoPago(rotaDraftAtual);
        const codigoPixLimpo = normalizarCodigoPix(pixPagamento.pixCode);
        rotaDraftAtual.pagamentoMercadoPago = {
            ...pixPagamento,
            pixCode: codigoPixLimpo
        };
        rotaPixCodigoRawAtual = codigoPixLimpo;

        if (pixTxt) pixTxt.textContent = codigoPixLimpo;
        setTicketPagamentoPixRota(pixPagamento.ticketUrl || '');
        if (mercadoPagoAmbienteAtual === 'teste') {
            setStatusPagamentoPixRota('Pix de teste gerado. Em banco real ele pode ser recusado.', 'warning');
        } else {
            setStatusPagamentoPixRota('Pix gerado com sucesso. Aguardando pagamento.', 'pending');
        }
        renderEtapaModalRota();
    } catch (erro) {
        console.warn('Falha ao gerar Pix no Mercado Pago:', erro);
        rotaDraftAtual.pagamentoMercadoPago = null;
        rotaPixCodigoRawAtual = '';
        if (pixTxt) pixTxt.textContent = '--';
        setTicketPagamentoPixRota('');

        const detalheErro = erro?.message || 'erro desconhecido';

        if (mercadoPagoAmbienteAtual === 'teste') {
            const simular = confirm(
                'Não foi possível gerar o Pix real no Mercado Pago (ambiente TESTE).\n\n' +
                'Detalhe: ' + detalheErro + '\n\n' +
                'Deseja simular um pagamento aprovado para continuar testando o resto do fluxo (rota, entrega, chat)?'
            );
            if (simular) {
                rotaDraftAtual.pagamentoMercadoPago = {
                    provider: 'mercadopago-simulado',
                    paymentId: 'sim_' + Date.now(),
                    status: 'approved',
                    statusDetail: 'simulado_dev',
                    pixCode: '',
                    ticketUrl: '',
                    qrCodeBase64: ''
                };
                if (pixTxt) pixTxt.textContent = 'Pagamento simulado (dev)';
                setStatusPagamentoPixRota('Pagamento simulado aprovado (ambiente TESTE). Não usar em produção.', 'approved');
                renderEtapaModalRota();
                return;
            }
        }

        setStatusPagamentoPixRota('Falha ao gerar Pix (' + detalheErro + '). Confira token/permissões e tente novamente.', 'warning');
        renderEtapaModalRota();
        alert('Não foi possível gerar o Pix agora. Verifique as credenciais do Mercado Pago.\n\nDetalhe: ' + detalheErro);
    }
}

async function copiarCodigoPixRota() {
    const pixTxt = document.getElementById('rota-pix-code');
    const feedback = document.getElementById('rota-pix-copy-feedback');
    const codigo = normalizarCodigoPix(rotaPixCodigoRawAtual || pixTxt?.textContent || '');

    if (!codigo || codigo === '--') {
        if (feedback) feedback.innerText = 'Código indisponível.';
        return;
    }

    if (!codigo.startsWith('000201')) {
        if (feedback) feedback.innerText = 'Código Pix inválido para pagamento em banco.';
        return;
    }

    let copiado = false;

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(codigo);
            copiado = true;
        }
    } catch (_) {
        copiado = false;
    }

    if (!copiado) {
        const inputTemp = document.createElement('textarea');
        inputTemp.value = codigo;
        inputTemp.style.position = 'fixed';
        inputTemp.style.opacity = '0';
        document.body.appendChild(inputTemp);
        inputTemp.focus();
        inputTemp.select();
        try {
            copiado = document.execCommand('copy');
        } catch (_) {
            copiado = false;
        }
        document.body.removeChild(inputTemp);
    }

    if (feedback) {
        if (copiado && mercadoPagoAmbienteAtual === 'teste') {
            feedback.innerText = 'Código Pix copiado (ambiente TESTE).';
        } else {
            feedback.innerText = copiado ? 'Código Pix copiado.' : 'Não foi possível copiar automaticamente.';
        }
    }
}

async function marcarEnviosEmRota(envioIds, rotaId) {
    if (!Array.isArray(envioIds) || !envioIds.length) return;

    clientes.forEach((cliente) => {
        const historico = Array.isArray(cliente.historico) ? cliente.historico : [];
        historico.forEach((h, idx) => {
            const idAtual = h.id || ('envio-' + cliente.id + '-' + idx);
            if (envioIds.includes(idAtual)) {
                h.id = idAtual;
                h.status = 'BUSCANDO';
                h.rotaId = rotaId;
                h.atualizadoEm = Date.now();
            }
        });
        cliente.historico = historico;
    });

    await saveClientes();
}

async function salvarRotaNoBanco(rota) {
    const uid = getUsuarioIdAtual();
    if (!uid || !rota?.id) return;

    const pagamentoMp = rota.pagamentoMercadoPago || {};
    const payload = {
        id: rota.id,
        pacoteIds: rota.pacotes,
        quantidade: rota.qtd,
        totalFrete: rota.totalFrete,
        pagamento: rota.pagamento || 'APROVADO',
        status: rota.status || 'BUSCANDO',
        criadoEm: rota.criadoEm,
        atualizadoEm: Date.now(),
        pagamentoProvider: pagamentoMp.provider || 'manual',
        pagamentoId: pagamentoMp.paymentId || null,
        pagamentoStatus: pagamentoMp.status || rota.pagamento || 'APROVADO',
        creditoCarteiraAplicado: Number(rota.creditoCarteiraAplicado || 0),
        valorPixPago: Number.isFinite(Number(rota.valorRestantePix)) ? Number(rota.valorRestantePix) : rota.totalFrete
    };

    try {
        await db.ref('usuarios/' + uid + '/rotas/' + rota.id).set(payload);
    } catch (err) {
        console.warn('Falha ao salvar rota no banco:', err);
    }
}

// Pagamento com saldo da carteira (inclui crédito de estornos, ver
// project-flexa-notificacoes-e-exclusao). Debita o valor e reaproveita
// confirmarPagamentoRota pra terminar o fluxo (marca envios, salva rota, avança
// pro passo 3) — o mesmo caminho já usado pelo pagamento simulado em modo teste.
async function pagarRotaComSaldo() {
    if (!rotaDraftAtual) return;

    const total = Number(rotaDraftAtual.totalFrete || 0);
    if (!Number.isFinite(total) || total <= 0) return;

    const ok = window.confirm(`Pagar ${precoParaMoeda(total)} usando o saldo da sua carteira?`);
    if (!ok) return;

    const resultado = await debitarSaldoUsuarioAtual(total, `Pagamento da rota ${rotaDraftAtual.id} com saldo`);
    if (!resultado.ok) {
        alert(
            'Não foi possível debitar o saldo.\n\n' +
            `Saldo encontrado no banco agora: ${precoParaMoeda(resultado.saldoEncontrado)}\n` +
            `Valor necessário: ${precoParaMoeda(total)}\n\n` +
            'Se o saldo mostrado aqui estiver errado, confira o extrato em Perfil > Pagamento. Por enquanto, pague via Pix abaixo.'
        );
        // Corrige o card na tela com o valor real, já que o cache local estava errado.
        const saldoValorEl = document.getElementById('rota-saldo-disponivel-valor');
        if (saldoValorEl) saldoValorEl.innerText = precoParaMoeda(resultado.saldoEncontrado);
        const saldoCard = document.getElementById('rota-saldo-pagamento-card');
        if (saldoCard && resultado.saldoEncontrado < total) saldoCard.style.display = 'none';
        return;
    }

    rotaDraftAtual.pagamentoMercadoPago = {
        provider: 'saldo-interno',
        paymentId: 'saldo_' + Date.now(),
        status: 'approved',
        statusDetail: 'pago_com_saldo_carteira',
        pixCode: '',
        ticketUrl: '',
        qrCodeBase64: ''
    };

    await confirmarPagamentoRota();
}

async function confirmarPagamentoRota() {
    if (!rotaDraftAtual) return;

    const btn = document.getElementById('rota-flow-action-btn');
    const textoOriginal = btn ? btn.innerText : '';
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Verificando...';
    }

    try {
        const pagamentoMp = rotaDraftAtual.pagamentoMercadoPago || null;

        if (pagamentoMp?.provider === 'mercadopago' && pagamentoMp.paymentId) {
            const statusAtual = await consultarPagamentoPixMercadoPago(pagamentoMp.paymentId);
            rotaDraftAtual.pagamentoMercadoPago.status = statusAtual?.status || pagamentoMp.status || 'pending';
            rotaDraftAtual.pagamentoMercadoPago.statusDetail = statusAtual?.statusDetail || pagamentoMp.statusDetail || '';

            if (rotaDraftAtual.pagamentoMercadoPago.status === 'approved') {
                setStatusPagamentoPixRota('Pagamento aprovado no Mercado Pago.', 'approved');
            } else {
                setStatusPagamentoPixRota('Pagamento ainda pendente no Mercado Pago.', 'warning');

                if (mercadoPagoAmbienteAtual !== 'teste') {
                    alert('O pagamento ainda não foi aprovado pelo Mercado Pago. Aguarde a confirmação para liberar a rota.');
                    return;
                }

                const liberarTeste = confirm('O pagamento ainda não está aprovado. Deseja liberar a rota mesmo assim em modo teste?');
                if (!liberarTeste) {
                    return;
                }
                rotaDraftAtual.pagamentoMercadoPago.status = 'test_override';
            }
        }

        // Aplica o crédito de saldo (se algum foi calculado em irParaPagamentoRota) só
        // agora que o Pix foi de fato confirmado — evita gastar o crédito do lojista se
        // ele nunca chegar a pagar o restante. Não se aplica ao provider 'saldo-interno'
        // porque esse caminho (pagarRotaComSaldo) já debita o valor cheio antes de chegar
        // aqui.
        if (
            pagamentoMp?.provider !== 'saldo-interno'
            && !rotaDraftAtual.creditoJaAplicado
            && Number(rotaDraftAtual.creditoCarteiraAplicado) > 0
        ) {
            const debitoCredito = await debitarSaldoUsuarioAtual(
                rotaDraftAtual.creditoCarteiraAplicado,
                `Crédito de saldo aplicado na rota ${rotaDraftAtual.id}`
            );
            if (debitoCredito.ok) {
                rotaDraftAtual.creditoJaAplicado = true;
            } else {
                // Não trava a rota por isso — o Pix já foi pago, a rota deve seguir.
                // Só fica sem aplicar o desconto de saldo dessa vez; avisa no console.
                console.warn('Pix aprovado mas não foi possível aplicar o crédito de saldo:', debitoCredito);
            }
        }

        rotaDraftAtual.pagamento = 'APROVADO';
        await marcarEnviosEmRota(rotaDraftAtual.pacotes, rotaDraftAtual.id);
        await salvarRotaNoBanco(rotaDraftAtual);

        const idEl = document.getElementById('rota-created-id');
        if (idEl) idEl.innerText = rotaDraftAtual.id;

        rotaModalStep = 3;
        renderEtapaModalRota();
        renderEnviosHome();
        renderRotasTelaPrincipal();
    } catch (erro) {
        console.warn('Erro ao confirmar pagamento da rota:', erro);
        alert('Não foi possível confirmar o pagamento agora. Tente novamente.');
    } finally {
        if (btn && rotaModalStep === 2) {
            btn.disabled = false;
            btn.innerText = textoOriginal || 'Verificar pagamento';
        }
    }
}

function iniciarModalRota() {
    rotaModalStep = 1;
    rotaSelecaoIds = new Set();
    rotaDraftAtual = null;
    rotaPendentesCache = coletarEnviosPendentesParaRota();

    const pixTxt = document.getElementById('rota-pix-code');
    const pixQtd = document.getElementById('rota-pix-qtd');
    const pixTotal = document.getElementById('rota-pix-total');
    const pixFeedback = document.getElementById('rota-pix-copy-feedback');
    rotaPixCodigoRawAtual = '';
    if (pixTxt) pixTxt.textContent = '--';
    if (pixQtd) pixQtd.innerText = '0';
    if (pixTotal) pixTotal.innerText = 'R$ 0,00';
    if (pixFeedback) pixFeedback.innerText = '';
    setTicketPagamentoPixRota('');
    setStatusPagamentoPixRota('Aguardando geração do código...', 'pending');
    atualizarAvisoAmbientePix();

    renderListaPendentesRota();
    renderEtapaModalRota();
}

function openModal() {
    if (usuarioEhEntregador()) {
        alert('Perfil entregador nao pode criar rota. Escolha uma rota disponivel.');
        return;
    }
    if (!overlayRota || !sheetRota) return;
    iniciarModalRota();
    overlayRota.style.display = 'flex';
    setTimeout(() => {
        sheetRota.classList.add('show');
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }, 10);
}
function closeModal() {
    if (!overlayRota || !sheetRota) return;
    sheetRota.classList.remove('show');
    setTimeout(() => {
        overlayRota.style.display = 'none';
    }, 350);
}

function voltarEtapaModalRota(event) {
    if (event) event.stopPropagation();
    if (rotaModalStep <= 1) {
        closeModal();
        return;
    }
    rotaModalStep -= 1;
    renderEtapaModalRota();
}

async function acaoPrincipalModalRota() {
    if (rotaModalStep === 1) {
        await irParaPagamentoRota();
        return;
    }
    if (rotaModalStep === 2) {
        await confirmarPagamentoRota();
        return;
    }
    closeModal();
}

lucide.createIcons();

// Abrir Modal de Perfil e carregar dados atuais
function abrirModalPerfil() {
    const user = window.usuarioLogado;
    const ehEntregador = usuarioEhEntregador();
    if (user) {
        document.getElementById('edit-nome').value = user.nome || '';
        document.getElementById('edit-instagram').value = user.instagram || '';
        document.getElementById('edit-whatsapp').value = user.whatsapp || '';
        document.getElementById('edit-cnh').value = user.cnh || '';
        document.getElementById('edit-veiculo-tipo').value = user.veiculoTipo || '';
        document.getElementById('edit-veiculo-marca').value = user.veiculoMarca || '';
        document.getElementById('edit-veiculo-modelo').value = user.veiculoModelo || '';
        document.getElementById('edit-veiculo-cor').value = user.veiculoCor || '';
        document.getElementById('edit-veiculo-placa').value = user.veiculoPlaca || '';
        aplicarFotoComPlaceholder(document.getElementById('edit-preview-img'), user.foto || '');
    }

    document.querySelectorAll('.perfil-veiculo-group').forEach((group) => {
        group.style.display = ehEntregador ? 'block' : 'none';
    });

    const overlay = document.getElementById('overlay-perfil');
    const sheet = document.getElementById('sheet-perfil');
    if (!overlay || !sheet) return;

    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
        overlay.classList.add('is-open');
        sheet.style.transform = 'translateY(0)';
        sheet.style.opacity = '1';
    });
}

function fecharModalPerfil() {
    const overlay = document.getElementById('overlay-perfil');
    const sheet = document.getElementById('sheet-perfil');
    if (!overlay || !sheet) return;

    overlay.classList.remove('is-open');
    sheet.style.transform = 'translateY(100%)';
    sheet.style.opacity = '0';

    setTimeout(() => {
        overlay.style.display = 'none';
    }, 240);
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
    // 1. Verifica se temos o ID do usuário
    const uid = window.usuarioLogado ? window.usuarioLogado.id : (firebase.auth().currentUser ? firebase.auth().currentUser.uid : null);
    
    if (!uid) {
        alert("Erro: Usuário não identificado. Tente fazer login novamente.");
        return;
    }

    const novosDados = {
        nome: document.getElementById('edit-nome').value,
        instagram: document.getElementById('edit-instagram').value,
        whatsapp: document.getElementById('edit-whatsapp').value,
        foto: document.getElementById('edit-preview-img').src // Imagem em Base64
    };

    if (usuarioEhEntregador()) {
        novosDados.cnh = document.getElementById('edit-cnh').value;
        novosDados.veiculoTipo = document.getElementById('edit-veiculo-tipo').value;
        novosDados.veiculoMarca = document.getElementById('edit-veiculo-marca').value;
        novosDados.veiculoModelo = document.getElementById('edit-veiculo-modelo').value;
        novosDados.veiculoCor = document.getElementById('edit-veiculo-cor').value;
        novosDados.veiculoPlaca = document.getElementById('edit-veiculo-placa').value;
    }

    // 2. Salva no Firebase
    db.ref('usuarios/' + uid).update(novosDados)
        .then(() => {
            // 3. Atualiza o objeto na memória do app
            window.usuarioLogado = { ...window.usuarioLogado, ...novosDados };
            // 4. Atualiza as duas telas de perfil (lojista e entregador)
            preencherPerfilLojista();
            preencherPerfilEntregador();
            
            fecharModalPerfil();
            
            // 5. Renderiza novamente os Ícones (importante para o Ícone do Insta)
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
    
    // Atualiza Ícones Lucide (como o Ícone de fechar e map-pin)
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

// 3. BUSCA CEP (VERSÃO ?sNICA E COMPLETA)
async function buscarCEP(valor, opts = {}) {
    const silencioso = Boolean(opts?.silencioso);
    const cep = valor.replace(/\D/g, '');
    if (cep.length !== 8) return null;
    if (cep === ultimoCepLojaConsultado && document.getElementById('end-rua')?.value) return null;
    ultimoCepLojaConsultado = cep;

    // Feedback visual nos campos
    const campoRua = document.getElementById('end-rua');
    campoRua.placeholder = "Buscando endereço...";

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
        if (!silencioso) alert("CEP não encontrado.");
    } catch (_) {
        if (!silencioso) alert("Erro ao buscar CEP. Verifique sua conexão.");
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
        alert("Erro: Usuário não identificado.");
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

    // Salva no nó 'endereco' dentro do perfil do usuário
    db.ref('usuarios/' + uid + '/endereco').update(endereco)
        .then(() => {
            // Atualiza o objeto local para refletir as mudanças sem recarregar
            if (!window.usuarioLogado) window.usuarioLogado = {};
            window.usuarioLogado.endereco = endereco;
            atualizarLocalColetaDinamico();
            renderizarDashboard(window.usuarioLogado || {});

            fecharModalEndereco();
            alert("Endereço atualizado com sucesso!");
        })
        .catch(error => {
            console.error("Erro ao salvar endereço:", error);
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
            <span style="font-size: 14px;">Contato excluído</span>
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
    const uidAtual = getUsuarioIdAtual();
    const pacotesUid = window.pacotesRaizCache?.[uidAtual] || {};
    clientes.forEach((c) => {
        const historico = Array.isArray(c.historico) ? c.historico : [];
        historico.forEach((h, idx) => {
            const statusRaw = (h.status || 'PENDENTE').toString().toUpperCase();
            const pagamentoStatusRaw = (h.pagamentoStatus || h.pagamento || '').toString().toUpperCase();
            const categoria = mapearCategoriaEnvio({ statusRaw, pagamentoStatusRaw });

            let statusLabel = rotuloStatusEnvio(statusRaw);
            if (categoria === 'PAGAMENTO_PENDENTE') statusLabel = 'Pagamento pendente';

            envios.push({
                id: h.id || `envio-${c.id}-${idx}`,
                codigo: h.id ? h.id.replace('envio-', '').slice(-4) : String(idx + 1).padStart(4, '0'),
                clienteId: c.id,
                destinatario: c.nome || 'Cliente',
                whatsapp: c.whatsapp || '',
                endereco: formatEnderecoDisplay(h.destinoEndereco || c.endereco || ''),
                destinoCompleto: (h.destinoEndereco || montarEnderecoParaCalculo(c, c.endereco || '') || '').trim(),
                origemCompleta: (h.origemEndereco || formatarEnderecoLojaParaCalculo(window.usuarioLogado?.endereco || {}) || obterEnderecoLojaTexto() || '').trim(),
                status: statusLabel,
                statusRaw,
                categoria,
                pagamentoStatusRaw,
                valor: Number.isFinite(Number(h.valorFrete)) ? Number(h.valorFrete) : parseMoedaParaNumero(h.valor || 0),
                valorConteudo: Number.isFinite(Number(h.valorConteudo)) ? Number(h.valorConteudo) : null,
                servico: h.servico || 'Standard',
                tamanho: h.tamanho || '',
                veiculo: h.veiculo || 'Moto',
                descricao: h.descricao || '',
                observacoes: h.observacoes || c.obs || '',
                distanciaKm: Number.isFinite(Number(h.distanciaKm)) ? Number(h.distanciaKm) : null,
                duracaoMin: Number.isFinite(Number(h.duracaoMin)) ? Number(h.duracaoMin) : null,
                origemGeo: normalizarGeo(h.origemGeo) || normalizarGeo(window.usuarioLogado?.endereco?.geo) || null,
                destinoGeo: normalizarGeo(h.destinoGeo) || normalizarGeo(c.geo) || null,
                criadoEm: h.criadoEm || Date.now()
            });
        });
    });

    // modelo novo (/pacotes/{uidAtual})
    Object.keys(pacotesUid).forEach((pid) => {
        const p = pacotesUid[pid] || {};
        const statusRaw = (p.status || p.statusRaw || 'PACOTE_NOVO').toString().toUpperCase();
        const pagamentoStatusRaw = (p.pagamentoStatus || '').toString().toUpperCase();
        const categoria = mapearCategoriaEnvio({ statusRaw, pagamentoStatusRaw });
        envios.push({
            id: pid,
            codigo: pid.replace('envio-', '').slice(-4),
            clienteId: p.clienteId || uidAtual,
            destinatario: p.destinatario || 'Cliente',
            whatsapp: p.whatsapp || '',
            endereco: formatEnderecoDisplay(p.destinoEndereco || p.destino || ''),
            destinoCompleto: (p.destinoEndereco || p.destino || '').trim(),
            origemCompleta: (p.origemEndereco || formatarEnderecoLojaParaCalculo(window.usuarioLogado?.endereco || {}) || obterEnderecoLojaTexto() || '').trim(),
            status: rotuloStatusEnvio(statusRaw),
            statusRaw,
            categoria,
            pagamentoStatusRaw,
            valor: Number.isFinite(Number(p.valorFrete)) ? Number(p.valorFrete) : parseMoedaParaNumero(p.valor || 0),
            valorConteudo: Number.isFinite(Number(p.valorConteudo)) ? Number(p.valorConteudo) : null,
            servico: p.servico || 'Standard',
            tamanho: p.tamanho || '',
            veiculo: p.veiculo || 'Moto',
            descricao: p.descricao || '',
            observacoes: p.observacoes || '',
            distanciaKm: Number.isFinite(Number(p.distanciaKm)) ? Number(p.distanciaKm) : null,
            duracaoMin: Number.isFinite(Number(p.duracaoMin)) ? Number(p.duracaoMin) : null,
            origemGeo: normalizarGeo(p.origemGeo) || normalizarGeo(window.usuarioLogado?.endereco?.geo) || null,
            destinoGeo: normalizarGeo(p.destinoGeo) || null,
            criadoEm: p.criadoEm || Date.now(),
            cidade: (p.cidadeDestino || p.cidade || extrairCidadeEnderecoSimples(p.destinoEndereco || p.destino || '')).toString()
        });
    });

    // modelo novo (/pacotes/<uidAtual>)
    Object.keys(pacotesUid).forEach((pid) => {
        const p = pacotesUid[pid] || {};
        const statusRaw = (p.status || p.statusRaw || 'PACOTE_NOVO').toString().toUpperCase();
        const pagamentoStatusRaw = (p.pagamentoStatus || '').toString().toUpperCase();
        const categoria = mapearCategoriaEnvio({ statusRaw, pagamentoStatusRaw });
        envios.push({
            id: pid,
            codigo: pid.replace('envio-', '').slice(-4),
            clienteId: p.clienteId || uidAtual,
            destinatario: p.destinatario || 'Cliente',
            whatsapp: p.whatsapp || '',
            endereco: formatEnderecoDisplay(p.destinoEndereco || p.destino || ''),
            destinoCompleto: (p.destinoEndereco || p.destino || '').trim(),
            origemCompleta: (p.origemEndereco || formatarEnderecoLojaParaCalculo(window.usuarioLogado?.endereco || {}) || obterEnderecoLojaTexto() || '').trim(),
            status: rotuloStatusEnvio(statusRaw),
            statusRaw,
            categoria,
            pagamentoStatusRaw,
            valor: Number.isFinite(Number(p.valorFrete)) ? Number(p.valorFrete) : parseMoedaParaNumero(p.valor || 0),
            valorConteudo: Number.isFinite(Number(p.valorConteudo)) ? Number(p.valorConteudo) : null,
            servico: p.servico || 'Standard',
            tamanho: p.tamanho || '',
            veiculo: p.veiculo || 'Moto',
            descricao: p.descricao || '',
            observacoes: p.observacoes || '',
            distanciaKm: Number.isFinite(Number(p.distanciaKm)) ? Number(p.distanciaKm) : null,
            duracaoMin: Number.isFinite(Number(p.duracaoMin)) ? Number(p.duracaoMin) : null,
            origemGeo: normalizarGeo(p.origemGeo) || normalizarGeo(window.usuarioLogado?.endereco?.geo) || null,
            destinoGeo: normalizarGeo(p.destinoGeo) || null,
            criadoEm: p.criadoEm || Date.now(),
            cidade: (p.cidadeDestino || p.cidade || extrairCidadeEnderecoSimples(p.destinoEndereco || p.destino || '')).toString()
        });
    });

    if (!envios.length) return [];

    // remove duplicados pelo id, priorizando o último coletado (normalmente o modelo novo)
    const mapa = new Map();
    envios.forEach((e) => {
        const k = String(e.id || '');
        if (!k) return;
        mapa.set(k, e);
    });
    const unicos = Array.from(mapa.values());

    return unicos.sort((a, b) => Number(b.criadoEm || 0) - Number(a.criadoEm || 0));
}

function renderEnviosHome() {
    const container = document.getElementById('envios-list');
    if (!container) return;

    const row = document.getElementById('envio-filter-row');
    if (row) {
        row.querySelectorAll('[data-envio-filter]').forEach((chip) => {
            const alvo = normalizarFiltroChipEnvio(chip.dataset.envioFilter || '');
            chip.classList.toggle('active', alvo === filtroEnviosAtivo);
        });
    }

    const envios = coletarEnviosDaBase();
    const filtrados = envios.filter((envio) => envioPassaNoFiltro(envio));

    if (!envios.length) {
        container.innerHTML = `
            <div class="envios-empty">
                <h3>Voce ainda nao tem pacotes para enviar</h3>
                <button type="button" class="envios-empty-btn" onclick="abrirSeletorCliente()">Criar envio</button>
            </div>
        `;
        return;
    }

    if (!filtrados.length) {
        container.innerHTML = `
            <div class="envios-empty">
                <h3>Nenhum pacote neste filtro</h3>
                <button type="button" class="envios-empty-btn" onclick="selecionarFiltroEnvios('TODOS')">Ver todos</button>
            </div>
        `;
        return;
    }

    container.innerHTML = filtrados.map((envio) => {
        const valor = Number(envio.valor || 0).toFixed(2).replace('.', ',');
        const classeStatusCor = obterClasseCorStatusEnvioCard(envio);
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
                         ontouchend="handleEnvioTouchEnd(event)"
                         onclick="abrirModalDetalheEnvio('${envio.id}', event)">
                    <button class="envio-delete-btn" type="button" onclick="confirmarExclusaoEnvio('${envio.id}'); event.stopPropagation();">
                        <i data-lucide="trash-2" size="14"></i>
                    </button>
                    <div class="envio-item-top envio-item-top-compact">
                        <div class="envio-item-main">
                            <div class="envio-item-kicker">Pedido #${envio.codigo}</div>
                            <div class="envio-item-name">${envio.destinatario}</div>
                        </div>
                        <div class="envio-item-side">
                            <div class="envio-item-price">R$ ${valor}</div>
                            <div class="envio-item-status ${classeStatusCor}">${envio.status}</div>
                        </div>
                    </div>
                    <div class="envio-item-line">
                        <span class="envio-item-service">${envio.servico}</span>
                    </div>
                </article>
            </div>
        `;
    }).join('');

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function preencherTextoDetalheEnvio(id, valor, fallback = '--') {
    const el = document.getElementById(id);
    if (!el) return;
    const texto = (valor === null || valor === undefined || valor === '') ? fallback : String(valor);
    el.textContent = texto;
}

function montarLinkMapaEnvio(envio) {
    const origem = (envio?.origemCompleta || '').trim();
    const destino = (envio?.destinoCompleto || '').trim();
    if (!destino) return '';
    const params = new URLSearchParams({ api: '1', destination: destino, travelmode: 'driving' });
    if (origem) params.set('origin', origem);
    return 'https://www.google.com/maps/dir/?' + params.toString();
}

function abrirModalDetalheEnvio(envioId, event) {
    if (event) event.stopPropagation();
    if (!envioId) return;

    const card = document.getElementById(`envio-card-${envioId}`);
    if (card?.dataset?.swiping === '1') return;
    const transformAtual = card?.style?.transform || '';
    if (transformAtual && transformAtual !== 'translateX(0)' && transformAtual !== 'translateX(0px)') {
        fecharSwipesEnvio();
        return;
    }

    const envio = coletarEnviosDaBase().find((item) => item.id === envioId);
    if (!envio) return;

    envioDetalheAtualId = envioId;

    preencherTextoDetalheEnvio('envio-detalhe-pedido', `Pedido #${envio.codigo}`);
    preencherTextoDetalheEnvio('envio-detalhe-cliente', envio.destinatario);
    preencherTextoDetalheEnvio('envio-detalhe-whatsapp', envio.whatsapp || '--');
    preencherTextoDetalheEnvio('envio-detalhe-servico', envio.servico || '--');
    preencherTextoDetalheEnvio('envio-detalhe-veiculo', envio.veiculo || '--');
    preencherTextoDetalheEnvio('envio-detalhe-tamanho', envio.tamanho || '--');
    preencherTextoDetalheEnvio('envio-detalhe-distancia', formatarDistancia(envio.distanciaKm));
    preencherTextoDetalheEnvio('envio-detalhe-duracao', formatarDuracao(envio.duracaoMin));
    preencherTextoDetalheEnvio('envio-detalhe-valor-frete', precoParaMoeda(envio.valor || 0));
    preencherTextoDetalheEnvio('envio-detalhe-valor-conteudo', Number.isFinite(envio.valorConteudo) ? precoParaMoeda(envio.valorConteudo) : '--');
    preencherTextoDetalheEnvio('envio-detalhe-descricao', envio.descricao || '--');
    preencherTextoDetalheEnvio('envio-detalhe-observacoes', envio.observacoes || '--');
    preencherTextoDetalheEnvio('envio-detalhe-origem', envio.origemCompleta || '--');
    preencherTextoDetalheEnvio('envio-detalhe-destino', envio.destinoCompleto || '--');
    preencherTextoDetalheEnvio('envio-detalhe-criado-em', new Date(envio.criadoEm || Date.now()).toLocaleString('pt-BR'));

    const statusEl = document.getElementById('envio-detalhe-status');
    if (statusEl) statusEl.textContent = envio.status || 'Pendente';

    const mapIframe = document.getElementById('envio-detalhe-map');
    if (mapIframe) {
        const destinoMapa = (envio.destinoCompleto || envio.endereco || '').trim();
        mapIframe.src = destinoMapa ? `https://www.google.com/maps?q=${encodeURIComponent(destinoMapa)}&output=embed` : 'about:blank';
    }

    const mapaLink = document.getElementById('envio-detalhe-link-mapa');
    if (mapaLink) {
        const href = montarLinkMapaEnvio(envio);
        if (href) {
            mapaLink.href = href;
            mapaLink.style.display = 'inline-flex';
        } else {
            mapaLink.removeAttribute('href');
            mapaLink.style.display = 'none';
        }
    }

    const modal = document.getElementById('modal-detalhe-envio');
    if (!modal) return;
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('is-open'));

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function fecharModalDetalheEnvio() {
    envioDetalheAtualId = null;
    const modal = document.getElementById('modal-detalhe-envio');
    if (!modal) return;
    modal.classList.remove('is-open');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 220);
}

function excluirEnvioAtualNoModal() {
    if (!envioDetalheAtualId) return;
    const id = envioDetalheAtualId;
    fecharModalDetalheEnvio();
    setTimeout(() => confirmarExclusaoEnvio(id), 140);
}

async function excluirEnvioPorId(envioId, { persistir = false } = {}) {
    const uid = getUsuarioIdAtual();
    // 1) tenta no modelo antigo (clientes/historico)
    for (const cliente of clientes) {
        const historico = Array.isArray(cliente.historico) ? cliente.historico : [];
        const idx = historico.findIndex((h) => h.id === envioId);
        if (idx >= 0) {
            historico.splice(idx, 1);
            cliente.historico = historico;
            cliente.envios = Math.max(0, Number(cliente.envios || 0) - 1);
            if (persistir && uid) {
                db.ref(`usuarios/${uid}/clientes/${cliente.id}/historico/${idx}`).remove().catch(() => {});
            }
            // continua para remover rota/pacote
            break;
        }
    }

    // 2) modelo novo (/pacotes)
    if (persistir && uid) {
        await db.ref(`usuarios/${uid}/pacotes/${envioId}`).remove().catch(() => {});
        if (window.pacotesRaizCache?.[uid]) delete window.pacotesRaizCache[uid][envioId];
    }

    // 3) remover de rotas locais e no banco
    if (persistir && uid) {
        const rotas = window.usuarioLogado?.rotas || {};
        Object.keys(rotas).forEach((rid) => {
            const r = rotas[rid];
            if (!r) return;
            const lista = Array.isArray(r.pacoteIds) ? r.pacoteIds : (Array.isArray(r.pacotes) ? r.pacotes : []);
            if (lista.includes(envioId)) {
                const novas = lista.filter((id) => id !== envioId);
                db.ref(`usuarios/${uid}/rotas/${rid}/pacoteIds`).set(novas).catch(() => {});
                if (Array.isArray(r.pacoteIds)) r.pacoteIds = novas;
            }
        });
    }

    return true;
}

const TAXA_CANCELAMENTO_ENVIO = 5;

async function cobrarTaxaCancelamentoEnvio(envioId, rotaId) {
    const uid = getUsuarioIdAtual();
    if (!uid) return;

    // Penalidade: pode deixar o saldo negativo (permitirNegativo: true, padrão).
    const resultado = await ajustarSaldoUsuario(uid, -TAXA_CANCELAMENTO_ENVIO);
    if (!resultado.ok) {
        console.warn('Falha ao cobrar taxa de cancelamento');
        return;
    }

    if (!window.usuarioLogado) window.usuarioLogado = {};
    window.usuarioLogado.financeiro = { ...(window.usuarioLogado.financeiro || {}), saldo: resultado.saldoDepois, atualizadoEm: Date.now() };
    await registrarTransacaoFinanceira('DEBITO', TAXA_CANCELAMENTO_ENVIO, `Taxa de cancelamento — pedido #${envioId}${rotaId ? ` (rota #${rotaId})` : ''}`);
    if (typeof atualizarSaldoPagamentoUI === 'function') atualizarSaldoPagamentoUI();
}

// Acha em qual rota (se alguma) esse envio está, com o objeto da rota completo
// (precisa pra checar status de pagamento) e o id do entregador, se já tiver um.
function localizarRotaDoEnvio(envioId) {
    const rotas = window.usuarioLogado?.rotas || {};
    for (const rid of Object.keys(rotas)) {
        const r = rotas[rid];
        if (!r) continue;
        const lista = Array.isArray(r.pacoteIds) ? r.pacoteIds : (Array.isArray(r.pacotes) ? r.pacotes : []);
        if (lista.includes(envioId)) {
            return { rotaId: rid, rota: r, entregadorId: String(r.entregadorId || r.aceitoPor || '') };
        }
    }
    return { rotaId: '', rota: null, entregadorId: '' };
}

// Quando um envio é removido e isso esvazia uma rota que já tem entregador designado,
// a rota não é excluída (excluirRotaPorId bloqueia isso) — em vez disso vira CANCELADA,
// atualizada nas duas cópias (lojista e entregador) pra não desincronizar.
async function marcarRotaCanceladaSeVazia(rotaId, entregadorId) {
    const uid = getUsuarioIdAtual();
    if (!uid || !rotaId) return;

    const rota = window.usuarioLogado?.rotas?.[rotaId];
    if (!rota) return;
    const lista = Array.isArray(rota.pacoteIds) ? rota.pacoteIds : (Array.isArray(rota.pacotes) ? rota.pacotes : []);
    if (lista.length) return;

    const agora = Date.now();
    const updates = {
        [`usuarios/${uid}/rotas/${rotaId}/status`]: 'CANCELADA',
        [`usuarios/${uid}/rotas/${rotaId}/atualizadoEm`]: agora
    };
    if (entregadorId) {
        updates[`usuarios/${entregadorId}/rotas/${rotaId}/status`] = 'CANCELADA';
        updates[`usuarios/${entregadorId}/rotas/${rotaId}/atualizadoEm`] = agora;
    }

    try {
        await db.ref().update(updates);
        if (window.usuarioLogado?.rotas?.[rotaId]) {
            window.usuarioLogado.rotas[rotaId].status = 'CANCELADA';
        }
    } catch (err) {
        console.warn('Falha ao marcar rota como cancelada:', err);
    }
}

async function confirmarExclusaoEnvio(envioId) {
    if (!envioId) return;
    const uid = getUsuarioIdAtual();

    const { rotaId, rota, entregadorId } = localizarRotaDoEnvio(envioId);

    // Descobre, num único fetch, se a corrida desse envio já começou e qual o valor
    // pago por ele (pra saber se cabe reembolso e/ou taxa de cancelamento).
    let corridaIniciada = false;
    let valorFrete = 0;
    let nomeDestinatario = 'Destinatário';
    if (uid) {
        try {
            const snap = await db.ref(`usuarios/${uid}/pacotes/${envioId}`).once('value');
            const dados = snap.val() || {};
            corridaIniciada = Boolean(dados.corridaIniciadaEm);
            valorFrete = Number(dados.valorFrete || 0);
            nomeDestinatario = obterNomeDestinatarioPacote(dados, rota || {});
        } catch (_) {
            corridaIniciada = false;
            valorFrete = 0;
        }
    }

    // Só reembolsa se esse envio já foi pago de fato (fez parte de uma rota com Pix
    // aprovado) — envio avulso, nunca colocado numa rota paga, não gera crédito.
    const podeReembolsar = Boolean(rota) && rota.pagamento === 'APROVADO' && Number.isFinite(valorFrete) && valorFrete > 0;

    let avisoConta = '';
    if (podeReembolsar && corridaIniciada) {
        const liquido = Number((valorFrete - TAXA_CANCELAMENTO_ENVIO).toFixed(2));
        avisoConta = `\n\nO entregador já iniciou a entrega deste pacote. Será cobrada uma taxa de cancelamento de ${precoParaMoeda(TAXA_CANCELAMENTO_ENVIO)} e devolvido ${precoParaMoeda(liquido)} de crédito na carteira (valor do pedido menos a taxa).`;
    } else if (podeReembolsar) {
        avisoConta = `\n\n${precoParaMoeda(valorFrete)} voltam como crédito na sua carteira.`;
    } else if (corridaIniciada) {
        avisoConta = `\n\nO entregador já iniciou a entrega deste pacote — será cobrada uma taxa de cancelamento de ${precoParaMoeda(TAXA_CANCELAMENTO_ENVIO)}.`;
    }

    const ok = window.confirm('Deseja excluir este envio?' + avisoConta);
    if (!ok) return;

    try {
        await excluirEnvioPorId(envioId, { persistir: true });

        if (entregadorId) {
            criarNotificacao(entregadorId, {
                tipo: 'envio_removido',
                titulo: 'Pacote removido da rota',
                mensagem: `O lojista removeu o pedido de ${nomeDestinatario} da rota${rotaId ? ` #${rotaId}` : ''}.`,
                rotaId: rotaId || ''
            });
        }

        if (podeReembolsar) {
            await creditarSaldoUsuarioAtual(valorFrete, `Estorno do pedido #${envioId} cancelado${rotaId ? ` (rota #${rotaId})` : ''}`);
        }
        if (corridaIniciada) {
            await cobrarTaxaCancelamentoEnvio(envioId, rotaId);
        }

        if (rotaId && entregadorId) {
            await marcarRotaCanceladaSeVazia(rotaId, entregadorId);
        }

        saveClientes();
        renderEnviosHome();
        atualizarListaEnviosSelector?.();
        if (envioDetalheAtualId === envioId) fecharModalDetalheEnvio();
        notificarErro(corridaIniciada ? `Envio excluído. Taxa de ${precoParaMoeda(TAXA_CANCELAMENTO_ENVIO)} cobrada.` : 'Envio excluído.');
    } catch (err) {
        console.warn('Falha ao excluir envio:', err);
        alert('Não foi possível excluir este envio.');
    }
}

let envioTouchStartX = 0;
let envioCardAtivo = null;

function handleEnvioTouchStart(e) {
    envioCardAtivo = e.currentTarget;
    envioTouchStartX = e.touches[0].clientX;
    if (envioCardAtivo) envioCardAtivo.dataset.swiping = '0';
    fecharSwipesEnvio(envioCardAtivo.id);
}

function handleEnvioTouchMove(e) {
    if (!envioCardAtivo) return;
    const diff = e.touches[0].clientX - envioTouchStartX;
    if (Math.abs(diff) > 8) envioCardAtivo.dataset.swiping = '1';
    if (diff > 0) {
        envioCardAtivo.style.transform = 'translateX(0)';
        return;
    }
    const limitado = Math.max(diff, -92);
    envioCardAtivo.style.transform = `translateX(${limitado}px)`;
}

function handleEnvioTouchEnd(e) {
    if (!envioCardAtivo) return;
    const card = envioCardAtivo;
    const diff = e.changedTouches[0].clientX - envioTouchStartX;
    card.style.transition = 'transform 0.22s ease';
    card.style.transform = diff < -52 ? 'translateX(-92px)' : 'translateX(0)';
    setTimeout(() => {
        card.style.transition = '';
        card.dataset.swiping = '0';
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
    renderRotasTelaPrincipal();
    atualizarLocalColetaDinamico();
    if (window.usuarioLogado) renderizarDashboard(window.usuarioLogado);
};

const _confirmarEnvioFinalOriginal = confirmarEnvioFinal;
confirmarEnvioFinal = function confirmarEnvioFinalNovaHome() {
    _confirmarEnvioFinalOriginal();
    renderEnviosHome();
    renderRotasTelaPrincipal();
    if (window.usuarioLogado) renderizarDashboard(window.usuarioLogado);
};

const _abrirNovoClienteOriginal = abrirNovoCliente;
abrirNovoCliente = function abrirNovoClienteComSheet() {
    fecharSeletorCliente();
    _abrirNovoClienteOriginal();
};

renderClientes = function renderClientesRedirect(filtro = '') {
    renderClientesSelector(filtro);
};











// ===================== [CHAT LOJISTA x ENTREGADOR] =====================
let chatConversasCache = [];
let chatAtualId = null;
let chatMsgUnsubscribe = null;
let chatImagemSelecionadaDataUrl = '';
let chatImagemSelecionadaNome = '';

function pacoteAbertoParaChat(pacote) {
    const status = normalizarStatusEnvioFiltro(pacote?.status || 'PENDENTE');
    return status !== 'ENTREGUE' && status !== 'CANCELADO';
}

function obterEntregadorDaRota(rota) {
    const entregadorId =
        rota?.entregadorId ||
        rota?.driverId ||
        rota?.courierId ||
        rota?.aceitoPor ||
        rota?.entregador?.id ||
        '';

    const entregadorNome =
        rota?.entregadorNome ||
        rota?.driverNome ||
        rota?.courierNome ||
        rota?.entregador?.nome ||
        'Entregador';

    const entregadorFoto =
        rota?.entregadorFoto ||
        rota?.driverFoto ||
        rota?.courierFoto ||
        rota?.entregador?.foto ||
        '';

    return {
        id: String(entregadorId || ''),
        nome: String(entregadorNome || 'Entregador'),
        foto: String(entregadorFoto || '')
    };
}

function chatIdParaRota(rota) {
    // 1 conversa por rota: chave determinística pelo ID da rota, igual dos dois lados
    // (lojista e entregador), sem depender de resolver corretamente o UID da contraparte.
    return `rota_${sanitizeFirebaseKey(rota?.id || '')}`;
}

function obterParticipanteChatDaRota(rota, meta = {}) {
    const euEntregador = usuarioEhEntregador();
    if (euEntregador) {
        return {
            id: String(rota?.origemLojistaUid || rota?.lojistaUid || meta?.lojistaId || ''),
            nome: String(rota?.lojistaNome || meta?.lojistaNome || 'Lojista'),
            foto: String(rota?.lojistaFoto || meta?.lojistaFoto || ''),
            tipo: 'LOJISTA'
        };
    }

    const entregador = obterEntregadorDaRota(rota);
    return {
        id: String(entregador.id || meta?.entregadorId || ''),
        nome: String(meta?.entregadorNome || entregador.nome || 'Entregador'),
        foto: String(meta?.entregadorFoto || entregador.foto || ''),
        tipo: 'ENTREGADOR'
    };
}

function obterPacotesAbertosRotaParaChat(rota) {
    const pacotes = getPacotesDaRota(rota);
    if (pacotes.length) {
        return pacotes.filter((p) => pacoteAbertoParaChat(p)).length;
    }
    const statusRota = normalizarStatusRotaFiltro(rota?.status || rota?.pagamentoStatus || 'CRIADA');
    if (statusRota === 'CONCLUIDO' || statusRota === 'CANCELADO') return 0;
    return Math.max(0, Number(rota?.quantidade || 0));
}
function rotaTemEntregadorAtivoParaChat(rota) {
    const statusRota = normalizarStatusRotaFiltro(rota?.status || rota?.pagamentoStatus || 'CRIADA');
    if (statusRota !== 'EM_ROTA') return false;
    const entregador = obterEntregadorDaRota(rota);
    return Boolean(entregador.id || entregador.nome);
}

function parseMensagensChatDoBanco(chatData) {
    const mensagensObj = chatData?.mensagens || {};
    const mensagens = Object.keys(mensagensObj).map((id) => ({ id, ...mensagensObj[id] }));
    mensagens.sort((a, b) => Number(a?.criadoEm || 0) - Number(b?.criadoEm || 0));
    return mensagens;
}

function obterUltimaMensagemResumo(chatData) {
    const mensagens = parseMensagensChatDoBanco(chatData);
    const ultima = mensagens[mensagens.length - 1];
    if (!ultima) {
        return {
            texto: 'Sem mensagens ainda',
            criadoEm: 0
        };
    }
    const texto = (ultima?.texto || '').trim();
    const possuiImagem = Boolean((ultima?.imagemDataUrl || ultima?.imagemUrl || '').trim());
    if (!texto && possuiImagem) {
        return { texto: '[imagem]', criadoEm: Number(ultima?.criadoEm || 0) };
    }
    return {
        texto: texto || 'Mensagem',
        criadoEm: Number(ultima?.criadoEm || 0)
    };
}

function formatarHoraChat(ts) {
    const data = Number(ts || 0);
    if (!data) return '--:--';
    return new Date(data).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function gerarIniciais(nome) {
    const partes = String(nome || 'E').split(' ').filter(Boolean);
    return partes.map((p) => p[0]).join('').slice(0, 2).toUpperCase() || 'E';
}

function renderListaChats() {
    const listEl = document.getElementById('chat-list');
    const countEl = document.getElementById('chat-active-count');
    if (!listEl || !countEl) return;

    countEl.innerText = `${chatConversasCache.length} ativo(s)`;

    if (!chatConversasCache.length) {
        listEl.innerHTML = `
            <div class="chat-empty">
                <h3>Nenhum chat ativo agora</h3>
                <p>O chat abre quando um entregador aceita rota e ainda ha pacotes em aberto.</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = chatConversasCache.map((c) => {
        const foto = c.participanteFoto
            ? `<img src="${escapeHtmlChat(c.participanteFoto)}" alt="${escapeHtmlChat(c.participanteNome)}">`
            : `<span>${escapeHtmlChat(gerarIniciais(c.participanteNome))}</span>`;

        return `
            <button type="button" class="chat-list-item" onclick="abrirThreadChat('${escapeHtmlChat(c.chatId)}')">
                <div class="chat-list-avatar">${foto}</div>
                <div class="chat-list-content">
                    <div class="chat-list-top">
                        <strong>${escapeHtmlChat(c.participanteNome)}</strong>
                        <small>${formatarHoraChat(c.ultimaMensagemEm)}</small>
                    </div>
                    <div class="chat-list-mid">Rota ${escapeHtmlChat(c.rotaId)} • ${c.pacotesAbertos} pacote(s) em aberto</div>
                    <div class="chat-list-last">${escapeHtmlChat(c.ultimaMensagemTexto || 'Sem mensagens')}</div>
                </div>
            </button>
        `;
    }).join('');
}

async function carregarChatsAtivos() {
    try {
        const uid = getUsuarioIdAtual();
        const listEl = document.getElementById('chat-list');
        if (!uid || !listEl) return;

        listEl.innerHTML = '<div class="chat-empty"><p>Carregando chats...</p></div>';

        let rotas = Array.isArray(rotasHomeCache) ? rotasHomeCache : [];
        if (!rotas.length) {
            rotas = await carregarRotasDoBanco();
            rotasHomeCache = rotas;
        }

        const snapChats = await db.ref(`usuarios/${uid}/chats`).once('value').catch(() => null);
        const chatsData = snapChats?.val() || {};

        const conversas = [];
        const cacheChatsUsados = new Set();
        const cacheLojistaNome = {};

        for (const rota of rotas) {
            if (!rotaTemEntregadorAtivoParaChat(rota)) continue;

            const abertos = obterPacotesAbertosRotaParaChat(rota);
            if (abertos <= 0) continue;

            const chatId = chatIdParaRota(rota);
            const chatData = chatsData[chatId] || {};
            const ultimaMsg = obterUltimaMensagemResumo(chatData);
            const meta = chatData.meta || {};
            const participante = obterParticipanteChatDaRota(rota, meta);

            if (usuarioEhEntregador() && participante.id && (!participante.nome || participante.nome === 'Lojista')) {
                if (!cacheLojistaNome[participante.id]) {
                    const snapLojista = await db.ref(`usuarios/${participante.id}`).once('value').catch(() => null);
                    const dadosLojista = snapLojista?.val() || {};
                    cacheLojistaNome[participante.id] = {
                        nome: String(dadosLojista?.nome || 'Lojista'),
                        foto: String(dadosLojista?.foto || '')
                    };
                }
                participante.nome = cacheLojistaNome[participante.id].nome;
                participante.foto = participante.foto || cacheLojistaNome[participante.id].foto;
            }

            const existente = conversas.find((c) => c.chatId === chatId);
            if (existente) {
                existente.pacotesAbertos += abertos;
                const novoUpdated = Number(rota.atualizadoEm || rota.criadoEm || 0);
                if (novoUpdated > Number(existente.atualizadoEm || 0)) {
                    existente.atualizadoEm = novoUpdated;
                    existente.rotaId = String(rota.id || '');
                }
                continue;
            }

            conversas.push({
                chatId,
                rotaId: String(rota.id || ''),
                participanteId: participante.id || '',
                participanteNome: participante.nome || 'Contato',
                participanteFoto: participante.foto || '',
                participanteTipo: participante.tipo || 'ENTREGADOR',
                pacotesAbertos: abertos,
                ultimaMensagemTexto: ultimaMsg.texto,
                ultimaMensagemEm: Number(meta.ultimaMensagemEm || ultimaMsg.criadoEm || rota.atualizadoEm || rota.criadoEm || 0),
                atualizadoEm: Number(rota.atualizadoEm || rota.criadoEm || 0)
            });
        }

        conversas.sort((a, b) => Number(b.ultimaMensagemEm || b.atualizadoEm || 0) - Number(a.ultimaMensagemEm || a.atualizadoEm || 0));
        chatConversasCache = conversas;
        renderListaChats();
        atualizarBadgeChatSimples(chatsData);
    } catch (err) {
        console.error('Erro ao carregar chats', err);
        notificarErro('Falha ao carregar chats. Tente novamente.');
    }
}

function abrirPainelThreadChat() {
    const listPanel = document.getElementById('chat-list-panel');
    const threadPanel = document.getElementById('chat-thread-panel');
    if (listPanel) listPanel.classList.add('hidden');
    if (threadPanel) threadPanel.classList.remove('hidden');
    const nav = document.getElementById('main-nav');
    if (nav) nav.style.display = 'none';
    document.body.classList.add('chat-thread-open');
}

function abrirPainelListaChat() {
    const listPanel = document.getElementById('chat-list-panel');
    const threadPanel = document.getElementById('chat-thread-panel');
    if (threadPanel) threadPanel.classList.add('hidden');
    if (listPanel) listPanel.classList.remove('hidden');
    const nav = document.getElementById('main-nav');
    if (nav) nav.style.display = 'flex';
    document.body.classList.remove('chat-thread-open');
}

function limparPreviewImagemChat() {
    chatImagemSelecionadaDataUrl = '';
    chatImagemSelecionadaNome = '';
    const preview = document.getElementById('chat-image-preview');
    if (preview) {
        preview.style.display = 'none';
        preview.innerHTML = '';
    }
    const inputFile = document.getElementById('chat-input-image');
    if (inputFile) inputFile.value = '';
}

function renderMensagensChat(mensagens = []) {
    const box = document.getElementById('chat-messages');
    if (!box) return;

    if (!mensagens.length) {
        box.innerHTML = '<div class="chat-empty"><p>Conversa iniciada. Envie a primeira mensagem.</p></div>';
        return;
    }

    const uidAtual = getUsuarioIdAtual();
    box.innerHTML = mensagens.map((msg) => {
        const souEuQueEnviei = String(msg?.remetenteId || '') === String(uidAtual || '');
        const classe = souEuQueEnviei ? 'from-me' : 'from-them';
        const texto = (msg?.texto || '').trim();
        const img = (msg?.imagemDataUrl || msg?.imagemUrl || '').trim();
        const hora = formatarHoraChat(msg?.criadoEm);
        const blocoTexto = texto ? `<p>${escapeHtmlChat(texto).replace(/\n/g, '<br>')}</p>` : '';
        const blocoImagem = img ? `<img src="${escapeHtmlChat(img)}" alt="Imagem da mensagem">` : '';
        return `
            <div class="chat-msg ${classe}">
                <div class="chat-bubble">
                    ${blocoImagem}
                    ${blocoTexto}
                    <small>${hora}</small>
                </div>
            </div>
        `;
    }).join('');

    box.scrollTop = box.scrollHeight;
}

function encerrarListenerMensagensChat() {
    if (typeof chatMsgUnsubscribe === 'function') {
        chatMsgUnsubscribe();
    }
    chatMsgUnsubscribe = null;
}

function iniciarListenerMensagensChat(chatId) {
    const uid = getUsuarioIdAtual();
    if (!uid || !chatId) return;

    encerrarListenerMensagensChat();

    const ref = db.ref(`usuarios/${uid}/chats/${chatId}/mensagens`).limitToLast(120);
    const handler = (snap) => {
        const data = snap.val() || {};
        const mensagens = Object.keys(data).map((id) => ({ id, ...data[id] }));
        mensagens.sort((a, b) => Number(a?.criadoEm || 0) - Number(b?.criadoEm || 0));
        renderMensagensChat(mensagens);
    };

    ref.on('value', handler);
    chatMsgUnsubscribe = () => ref.off('value', handler);
}

async function abrirThreadChat(chatId) {
    const conversa = chatConversasCache.find((c) => c.chatId === chatId);
    if (!conversa) return;

    chatAtualId = chatId;
    const title = document.getElementById('chat-thread-title');
    const subtitle = document.getElementById('chat-thread-subtitle');
    if (title) title.innerText = conversa.participanteNome || 'Contato';
    if (subtitle) subtitle.innerText = `Rota ${conversa.rotaId} • ${conversa.pacotesAbertos} pacote(s) em aberto`;

    abrirPainelThreadChat();
    limparPreviewImagemChat();
    renderMensagensChat([]);
    iniciarListenerMensagensChat(chatId);
    limparBadgeChat();
}

function voltarListaChats() {
    encerrarListenerMensagensChat();
    chatAtualId = null;
    limparPreviewImagemChat();
    abrirPainelListaChat();
    carregarChatsAtivos();
}

function limparBadgeChat() {
    const navChat = document.getElementById('nav-chat');
    if (navChat) navChat.classList.remove('has-unread');
}

function atualizarBadgeChatSimples(chatsObj = {}) {
    const navChat = document.getElementById('nav-chat');
    if (!navChat) return;
    if (document.getElementById('view-chat')?.classList.contains('active')) {
        navChat.classList.remove('has-unread');
        return;
    }
    const temMsg = Object.keys(chatsObj).length > 0;
    if (temMsg) navChat.classList.add('has-unread');
}

function abrirSeletorImagemChat() {
    const input = document.getElementById('chat-input-image');
    if (input) input.click();
}

function selecionarImagemChat(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        alert('Selecione uma imagem valida.');
        return;
    }
    if (file.size > (2 * 1024 * 1024)) {
        alert('Imagem muito grande. Use ate 2MB.');
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        chatImagemSelecionadaDataUrl = String(reader.result || '');
        chatImagemSelecionadaNome = file.name || 'imagem';
        const preview = document.getElementById('chat-image-preview');
        if (!preview) return;
        preview.innerHTML = `
            <div class="chat-preview-card">
                <img src="${escapeHtmlChat(chatImagemSelecionadaDataUrl)}" alt="Preview">
                <div class="chat-preview-meta">
                    <span>${escapeHtmlChat(chatImagemSelecionadaNome)}</span>
                    <button type="button" onclick="limparPreviewImagemChat()">Remover</button>
                </div>
            </div>
        `;
        preview.style.display = 'block';
    };
    reader.readAsDataURL(file);
}

async function chatEstaAtivo(conversa) {
    if (!conversa?.rotaId) return false;
    let rotas = Array.isArray(rotasHomeCache) ? rotasHomeCache : [];
    if (!rotas.length) {
        rotas = await carregarRotasDoBanco();
        rotasHomeCache = rotas;
    }
    const rota = rotas.find((r) => String(r.id) === String(conversa.rotaId));
    if (!rota) return false;
    if (!rotaTemEntregadorAtivoParaChat(rota)) return false;
    const abertos = obterPacotesAbertosRotaParaChat(rota);
    return abertos > 0;
}

async function enviarMensagemChat() {
    if (!chatAtualId) return;
    const uid = getUsuarioIdAtual();
    if (!uid) return;

    const conversa = chatConversasCache.find((c) => c.chatId === chatAtualId);
    if (!conversa) return;

    const podeConversar = await chatEstaAtivo(conversa);
    if (!podeConversar) {
        alert('Este chat foi encerrado porque a rota nao possui mais pacotes em aberto.');
        voltarListaChats();
        return;
    }

    const input = document.getElementById('chat-input-text');
    const texto = (input?.value || '').trim();
    const imagemData = (chatImagemSelecionadaDataUrl || '').trim();
    if (!texto && !imagemData) return;

    const criadoEm = Date.now();
    const msgId = `msg_${criadoEm}_${Math.random().toString(36).slice(2, 8)}`;
    const remetenteTipoAtual = usuarioEhEntregador() ? 'ENTREGADOR' : 'LOJISTA';
    const payload = {
        id: msgId,
        texto,
        imagemDataUrl: imagemData || '',
        remetenteTipo: remetenteTipoAtual,
        remetenteId: uid,
        criadoEm
    };

    const chatRef = db.ref(`usuarios/${uid}/chats/${chatAtualId}`);
    const metaRef = chatRef.child('meta');
    const msgRef = chatRef.child(`mensagens/${msgId}`);

    const metaPayload = {
        rotaId: conversa.rotaId || '',
        entregadorId: usuarioEhEntregador() ? uid : (conversa.participanteId || ''),
        entregadorNome: usuarioEhEntregador() ? (window.usuarioLogado?.nome || 'Entregador') : (conversa.participanteNome || 'Entregador'),
        entregadorFoto: usuarioEhEntregador() ? (window.usuarioLogado?.foto || '') : (conversa.participanteFoto || ''),
        lojistaId: usuarioEhEntregador() ? (conversa.participanteId || '') : uid,
        lojistaNome: usuarioEhEntregador() ? (conversa.participanteNome || 'Lojista') : (window.usuarioLogado?.nome || 'Lojista'),
        lojistaFoto: usuarioEhEntregador() ? (conversa.participanteFoto || '') : (window.usuarioLogado?.foto || ''),
        ultimaMensagemTexto: texto || '[imagem]',
        ultimaMensagemEm: criadoEm,
        atualizadoEm: criadoEm
    };

    await msgRef.set(payload);
    await metaRef.update(metaPayload);

    const destinoUid = String(conversa.participanteId || '').trim();
    if (destinoUid && destinoUid !== uid) {
        const chatRefDestino = db.ref(`usuarios/${destinoUid}/chats/${chatAtualId}`);
        await chatRefDestino.child(`mensagens/${msgId}`).set(payload);
        await chatRefDestino.child('meta').update(metaPayload);

        criarNotificacao(destinoUid, {
            tipo: 'chat_mensagem',
            titulo: `Mensagem de ${window.usuarioLogado?.nome || (remetenteTipoAtual === 'ENTREGADOR' ? 'entregador' : 'lojista')}`,
            mensagem: texto || 'Enviou uma imagem.',
            rotaId: conversa.rotaId || ''
        });
    }

    if (input) input.value = '';
    limparPreviewImagemChat();
}

ativarAbaChat = function ativarAbaChatReal() {
    navegar('view-chat');
};

const _navegarOriginalComChat = navegar;
navegar = function navegarComChat(idTela) {
    _navegarOriginalComChat(idTela);

    const nav = document.getElementById('main-nav');
    if (nav) {
        const tipo = obterTipoUsuarioAtual();
        const telasComMenu = (tipo === 'entregador')
            ? ['view-dash-entregador', 'view-rotas', 'view-buscar', 'view-chat', 'view-perfil-entregador']
            : ['view-dash-loja', 'view-novo-envio', 'view-rotas', 'view-buscar', 'view-chat', 'view-perfil'];

        const telaAtual = document.querySelector('.view.active')?.id || idTela;
        const mostrarMenu = telasComMenu.includes(telaAtual);
        nav.style.display = mostrarMenu ? 'flex' : 'none';
        if (mostrarMenu) {
            const navTarget = telaAtual === 'view-perfil-entregador'
                ? 'view-perfil'
                : (telaAtual === 'view-dash-entregador' ? 'view-dash-loja' : telaAtual);
            ativarMenuInferior(navTarget);
        }
    }

    const telaAtual = document.querySelector('.view.active')?.id || idTela;
    if (telaAtual === 'view-chat') {
        abrirPainelListaChat();
        carregarChatsAtivos();
    } else if (chatAtualId) {
        encerrarListenerMensagensChat();
        chatAtualId = null;
        limparPreviewImagemChat();
    }

    aplicarPermissoesPorTipoUsuario();
};
// ===================== [PAGAMENTO + SUPORTE PERFIL] =====================
let pagamentoPerfilCache = {
    saldo: 0,
    banco: {},
    pix: {}
};

function caminhoFinanceiroUsuario() {
    const uid = getUsuarioIdAtual();
    return uid ? `usuarios/${uid}/financeiro` : null;
}

function formatarSaldoPagamento(valor) {
    return precoParaMoeda(Number(valor || 0));
}

function atualizarSaldoPagamentoUI() {
    const saldoEl = document.getElementById('pag-saldo');
    if (saldoEl) saldoEl.innerText = formatarSaldoPagamento(pagamentoPerfilCache.saldo || 0);
}


async function carregarDadosPagamento() {
    const path = caminhoFinanceiroUsuario();
    if (!path) return;

    try {
        const snap = await db.ref(path).once('value');
        const data = snap.val() || {};

        pagamentoPerfilCache = {
            saldo: Number(data?.saldo || 0),
            banco: data?.banco || {},
            pix: data?.pix || {}
        };

        const banco = pagamentoPerfilCache.banco || {};
        const pix = pagamentoPerfilCache.pix || {};

        const bankName = document.getElementById('pag-bank-name');
        const agencia = document.getElementById('pag-bank-agencia');
        const conta = document.getElementById('pag-bank-conta');
        const titular = document.getElementById('pag-bank-titular');
        const pixTipo = document.getElementById('pag-pix-tipo');
        const pixChave = document.getElementById('pag-pix-chave');

        if (bankName) bankName.value = banco.nome || '';
        if (agencia) agencia.value = banco.agencia || '';
        if (conta) conta.value = banco.conta || '';
        if (titular) titular.value = banco.titular || '';
        if (pixTipo) pixTipo.value = pix.tipo || '';
        if (pixChave) pixChave.value = pix.chave || '';

        atualizarSaldoPagamentoUI();
    } catch (err) {
        console.warn('Falha ao carregar dados de pagamento:', err);
    }
}

function abrirPagamento() {
    abrirModalSheetGenerico('modal-pagamento');
    carregarDadosPagamento();
}

function fecharModalPagamento() {
    fecharModalSheetGenerico('modal-pagamento');
}

function lerValorMonetarioInput(valor) {
    return parseMoedaParaNumero((valor || '').toString().trim());
}

async function persistirFinanceiroUsuario(payload = {}) {
    const path = caminhoFinanceiroUsuario();
    if (!path) return false;
    try {
        await db.ref(path).update(payload);
        return true;
    } catch (err) {
        console.warn('Erro ao persistir financeiro:', err);
        return false;
    }
}

async function salvarDadosPagamento() {
    const banco = {
        nome: (document.getElementById('pag-bank-name')?.value || '').trim(),
        agencia: (document.getElementById('pag-bank-agencia')?.value || '').trim(),
        conta: (document.getElementById('pag-bank-conta')?.value || '').trim(),
        titular: (document.getElementById('pag-bank-titular')?.value || '').trim()
    };

    const pix = {
        tipo: (document.getElementById('pag-pix-tipo')?.value || '').trim(),
        chave: (document.getElementById('pag-pix-chave')?.value || '').trim()
    };

    pagamentoPerfilCache.banco = banco;
    pagamentoPerfilCache.pix = pix;

    const ok = await persistirFinanceiroUsuario({
        banco,
        pix,
        saldo: Number(pagamentoPerfilCache.saldo || 0),
        atualizadoEm: Date.now()
    });

    if (!ok) {
        alert('Nao foi possivel salvar os dados de pagamento.');
        return;
    }

    alert('Dados de pagamento salvos com sucesso.');
    fecharModalPagamento();
}

async function registrarTransacaoFinanceira(tipo, valor, descricao = '') {
    const path = caminhoFinanceiroUsuario();
    if (!path) return;
    try {
        const ref = db.ref(path + '/transacoes').push();
        await ref.set({
            id: ref.key,
            tipo,
            valor: Number(valor || 0),
            descricao,
            criadoEm: Date.now()
        });
    } catch (err) {
        console.warn('Falha ao registrar transacao financeira:', err);
    }
}

function abrirModalInfoPerfil(titulo, html) {
    const titleEl = document.getElementById('info-perfil-title');
    const bodyEl = document.getElementById('info-perfil-body');
    if (titleEl) titleEl.innerText = titulo || 'Informacoes';
    if (bodyEl) bodyEl.innerHTML = html || '';
    abrirModalSheetGenerico('modal-info-perfil');
}

function fecharModalInfoPerfil() {
    fecharModalSheetGenerico('modal-info-perfil');
}

function abrirAjuda() {
    abrirModalInfoPerfil('Central de ajuda', `
        <div class="info-card">
            <h4>Perguntas frequentes</h4>
            <ul>
                <li><strong>Como criar envio?</strong> Va em Envio, toque no botao + e siga os passos.</li>
                <li><strong>Como criar rota?</strong> Va em Rotas, toque em Nova Rota e selecione os pacotes pendentes.</li>
                <li><strong>Pagamento nao confirmou?</strong> Revise o Pix e toque em verificar pagamento no fluxo da rota.</li>
                <li><strong>Problema no mapa?</strong> Confira CEP, rua, numero, cidade e UF no perfil e no cliente.</li>
            </ul>
        </div>
        <div class="info-card">
            <h4>Atendimento</h4>
            <p>Horario: segunda a sexta, 08h as 18h.</p>
            <p>Tempo medio de resposta: ate 15 minutos em horario comercial.</p>
        </div>
    `);
}

function abrirFaleConosco() {
    abrirModalInfoPerfil('Fale conosco', `
        <div class="info-card">
            <h4>Canais oficiais</h4>
            <p><strong>WhatsApp suporte:</strong> <a href="https://wa.me/5585988000000" target="_blank" rel="noopener noreferrer">(85) 98800-0000</a></p>
            <p><strong>E-mail:</strong> <a href="mailto:suporte@flexalog.com.br">suporte@flexalog.com.br</a></p>
            <p><strong>Comercial:</strong> comercial@flexalog.com.br</p>
        </div>
        <div class="info-card">
            <h4>Antes de chamar</h4>
            <ul>
                <li>Tenha em maos o ID da rota ou pedido.</li>
                <li>Explique o problema e quando aconteceu.</li>
                <li>Se puder, envie print para agilizar o suporte.</li>
            </ul>
        </div>
    `);
}

function abrirSobre() {
    abrirModalInfoPerfil('Sobre a Flexa Log', `
        <div class="info-card">
            <h4>Nossa proposta</h4>
            <p>A Flexa Log conecta lojistas e entregadores para operacao de envios urbanos com foco em agilidade, transparencia e controle em tempo real.</p>
            <p>O app permite criar envios, montar rotas, rastrear status e organizar pagamentos de forma simples no celular.</p>
        </div>
        <div class="info-card">
            <h4>Versao do app</h4>
            <p>Flexa Log • MVP validacao</p>
            <p>Atualizacao: ${new Date().toLocaleDateString('pt-BR')}</p>
        </div>
    `);
}

function formatarDataExtrato(ts) {
    const data = Number(ts || 0);
    if (!data) return '--';
    return new Date(data).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function renderExtratoPagamento(transacoes = []) {
    const list = document.getElementById('pag-extrato-list');
    if (!list) return;

    if (!Array.isArray(transacoes) || !transacoes.length) {
        list.innerHTML = '<div class="pagamento-extrato-empty">Sem transacoes ainda.</div>';
        return;
    }

    list.innerHTML = transacoes.map((item) => {
        const tipo = String(item?.tipo || '').toUpperCase();
        const isCredito = tipo === 'CREDITO';
        const sinal = isCredito ? '+' : '-';
        const valorClasse = isCredito ? 'credito' : 'debito';
        const valorTxt = `${sinal} ${precoParaMoeda(Number(item?.valor || 0))}`;
        const descricao = (item?.descricao || 'Movimentacao').toString();
        return `
            <div class="pagamento-extrato-item">
                <div class="top">
                    <span class="tipo">${isCredito ? 'Credito' : 'Debito'}</span>
                    <span class="valor ${valorClasse}">${valorTxt}</span>
                </div>
                <div class="desc">${escapeHtmlChat(descricao)}</div>
                <div class="data">${formatarDataExtrato(item?.criadoEm)}</div>
            </div>
        `;
    }).join('');
}

async function carregarExtratoPagamento() {
    const path = caminhoFinanceiroUsuario();
    const list = document.getElementById('pag-extrato-list');
    if (!path || !list) return;

    list.innerHTML = '<div class="pagamento-extrato-empty">Carregando extrato...</div>';

    try {
        const snap = await db.ref(path + '/transacoes').limitToLast(40).once('value');
        const data = snap.val() || {};
        const arr = Object.keys(data).map((id) => ({ id, ...data[id] }));
        arr.sort((a, b) => Number(b?.criadoEm || 0) - Number(a?.criadoEm || 0));
        renderExtratoPagamento(arr);
    } catch (err) {
        console.warn('Falha ao carregar extrato:', err);
        list.innerHTML = '<div class="pagamento-extrato-empty">Nao foi possivel carregar o extrato.</div>';
    }
}

const _carregarDadosPagamentoOriginal = carregarDadosPagamento;
carregarDadosPagamento = async function carregarDadosPagamentoComExtrato() {
    await _carregarDadosPagamentoOriginal();
    await carregarExtratoPagamento();
};

const _registrarTransacaoFinanceiraOriginal = registrarTransacaoFinanceira;
registrarTransacaoFinanceira = async function registrarTransacaoFinanceiraComExtrato(tipo, valor, descricao = '') {
    await _registrarTransacaoFinanceiraOriginal(tipo, valor, descricao);
    await carregarExtratoPagamento();
};

// ===================== [TIPO DE USUARIO: LOJISTA x ENTREGADOR] =====================
let tipoCadastroSelecionado = 'loja';

function normalizarTipoCadastro(valor) {
    return String(valor || '').toLowerCase() === 'entrega' ? 'entrega' : 'loja';
}

function aplicarTipoCadastroNaTela() {
    const labelNome = document.getElementById('label-nome');
    const inputNome = document.getElementById('input-nome');
    const groupCnh = document.getElementById('group-cnh');
    const cnhInput = groupCnh ? groupCnh.querySelector('input') : null;

    const ehEntregador = tipoCadastroSelecionado === 'entrega';

    if (labelNome) labelNome.innerText = ehEntregador ? 'Nome completo' : 'Nome da loja';
    if (inputNome) {
        inputNome.placeholder = ehEntregador ? 'Digite seu nome completo' : 'Digite o nome da loja';
    }

    if (groupCnh) {
        groupCnh.classList.toggle('hidden', !ehEntregador);
    }

    if (cnhInput) {
        cnhInput.required = ehEntregador;
        if (!ehEntregador) cnhInput.value = '';
    }
}

function irParaCadastro(tipo) {
    tipoCadastroSelecionado = normalizarTipoCadastro(tipo);
    navegar('view-auth');
    alternarAuth('entrar');
    aplicarTipoCadastroNaTela();
}

const _alternarAuthComTipoOriginal = alternarAuth;
alternarAuth = function alternarAuthComTipo(modo) {
    _alternarAuthComTipoOriginal(modo);
    aplicarTipoCadastroNaTela();
};

cadastrarReal = async function cadastrarRealComTipo() {
    const nome = (document.getElementById('input-nome')?.value || '').trim();
    const email = (document.querySelector('#form-cadastrar input[type="email"]')?.value || '').trim();
    const senha = (document.getElementById('pass-cad')?.value || '').trim();
    const cnh = (document.getElementById('input-cnh')?.value || '').trim();

    if (!nome || !email || !senha) return alert('Preencha todos os campos.');

    const ehEntregador = tipoCadastroSelecionado === 'entrega';
    if (ehEntregador && !cnh) {
        alert('Preencha o numero da CNH para cadastro de entregador.');
        return;
    }

    try {
        const cred = await auth.createUserWithEmailAndPassword(email, senha);
        const payload = {
            nome,
            email,
            tipo: ehEntregador ? 'entregador' : 'loja',
            criadoEm: Date.now()
        };
        if (ehEntregador) payload.cnh = cnh;

        await db.ref('usuarios/' + cred.user.uid).set(payload);

        alert('Conta criada com sucesso.');
        alternarAuth('entrar');
    } catch (error) {
        alert('Erro ao cadastrar: ' + error.message);
    }
};

// Estado inicial da tela de autenticacao
setTimeout(() => {
    aplicarTipoCadastroNaTela();
}, 0);
















// ===================== [HOME ENTREGADOR] =====================
function normalizarStatusPacoteEntrega(statusRaw) {
    return normalizarStatusEnvioFiltro(statusRaw || 'PENDENTE');
}

function montarMapaPacotesParaEntregador(clientesNo = {}) {
    const mapa = new Map();
    const listaClientes = Object.keys(clientesNo || {}).map((id) => ({ id, ...(clientesNo[id] || {}) }));

    listaClientes.forEach((cliente) => {
        const historico = Array.isArray(cliente?.historico) ? cliente.historico : [];
        const cidadeBase = (cliente?.cidade || extrairCamposEnderecoCliente(cliente || {}).cidade || '').trim();

        historico.forEach((h, idx) => {
            const idEnvio = h?.id || ('envio-' + cliente.id + '-' + idx);
            const destinoCidade = (h?.cidadeDestino || h?.destinoCidade || h?.cidade || cidadeBase || '').trim();
            mapa.set(idEnvio, {
                id: idEnvio,
                cliente: cliente?.nome || 'Cliente',
                cidade: destinoCidade || cidadeBase || '--',
                destino: h?.destinoEndereco || cliente?.endereco || '--',
                status: normalizarStatusPacoteEntrega(h?.status || 'PENDENTE'),
                distanciaKm: Number.isFinite(Number(h?.distanciaKm)) ? Number(h.distanciaKm) : 0,
                duracaoMin: Number.isFinite(Number(h?.duracaoMin)) ? Number(h.duracaoMin) : 0,
                valorFrete: Number.isFinite(Number(h?.valorFrete)) ? Number(h.valorFrete) : parseMoedaParaNumero(h?.valor || 0)
            });
        });
    });

    return mapa;
}

function formatarTempoCompacto(minutos) {
    const min = Math.max(0, Math.round(Number(minutos || 0)));
    if (min < 60) return min + 'min';
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!m) return h + 'h';
    return h + 'h ' + m + 'm';
}

function formatarTempoPainel(minutos) {
    const min = Math.max(0, Math.round(Number(minutos || 0)));
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}:${String(m).padStart(2, '0')}h`;
}

function obterInicioDiaLocal(ts = Date.now()) {
    const data = new Date(Number(ts || Date.now()));
    data.setHours(0, 0, 0, 0);
    return data.getTime();
}

function obterMetaDiaEntregador(dadosUsuario = {}) {
    const noMeta = dadosUsuario?.entregadorMetaDia || {};
    const inicioPadrao = obterInicioDiaLocal(Date.now());
    const inicioEm = Number(noMeta?.inicioEm || inicioPadrao);
    const alvoPacotes = Math.max(1, Number(noMeta?.alvoPacotes || 20));
    const alvoGanhos = Math.max(1, Number(noMeta?.alvoGanhos || 150));

    return {
        inicioEm,
        alvoPacotes,
        alvoGanhos
    };
}

function calcularResumoDiaEntregador(resumoRotas = [], metaDia = null) {
    const meta = metaDia || obterMetaDiaEntregador(window.usuarioLogado || {});
    const inicioEm = Number(meta?.inicioEm || obterInicioDiaLocal(Date.now()));
    const fimEm = Date.now();

    const rotasDoPeriodo = resumoRotas.filter((rota) => {
        const tsRota = Number(rota?.dataRef || 0);
        return tsRota >= inicioEm && tsRota <= fimEm;
    });

    const totalPacotesConcluidos = rotasDoPeriodo.reduce((acc, rota) => acc + Number(rota?.concluidos || 0), 0);

    const ganhosConcluidos = rotasDoPeriodo.reduce((acc, rota) => {
        const concluido = Number(rota?.concluidos || 0);
        const totalPacotes = Math.max(1, Number(rota?.totalPacotes || 1));
        const proporcao = Math.max(0, Math.min(1, concluido / totalPacotes));
        return acc + (Number(rota?.totalValor || 0) * proporcao);
    }, 0);

    const distanciaConcluida = rotasDoPeriodo.reduce((acc, rota) => {
        const concluido = Number(rota?.concluidos || 0);
        const totalPacotes = Math.max(1, Number(rota?.totalPacotes || 1));
        const proporcao = Math.max(0, Math.min(1, concluido / totalPacotes));
        return acc + (Number(rota?.totalDist || 0) * proporcao);
    }, 0);

    const tempoConcluido = rotasDoPeriodo.reduce((acc, rota) => {
        const concluido = Number(rota?.concluidos || 0);
        const totalPacotes = Math.max(1, Number(rota?.totalPacotes || 1));
        const proporcao = Math.max(0, Math.min(1, concluido / totalPacotes));
        return acc + (Number(rota?.totalDur || 0) * proporcao);
    }, 0);

    const progressoPacotes = Math.max(0, Math.min(100, Math.round((totalPacotesConcluidos / Math.max(1, meta.alvoPacotes)) * 100)));
    const progressoGanhos = Math.max(0, Math.min(100, Math.round((ganhosConcluidos / Math.max(1, meta.alvoGanhos)) * 100)));
    const progressoGeral = Math.round((progressoPacotes + progressoGanhos) / 2);

    return {
        inicioEm,
        totalPacotesConcluidos,
        ganhosConcluidos,
        distanciaConcluida,
        tempoConcluido,
        progressoPacotes,
        progressoGanhos,
        progressoGeral
    };
}

function calcularResumoAtivoEntregador(rotasAtivas = [], metaDia = null) {
    const meta = metaDia || obterMetaDiaEntregador(window.usuarioLogado || {});
    const distancia = rotasAtivas.reduce((acc, rota) => acc + Number(rota.totalDist || 0), 0);
    const tempo = rotasAtivas.reduce((acc, rota) => acc + Number(rota.totalDur || 0), 0);
    const receber = rotasAtivas.reduce((acc, rota) => acc + Number(rota.totalValor || 0), 0);
    const entregasConcluidas = rotasAtivas.reduce((acc, rota) => acc + Number(rota.concluidos || 0) + Number(rota.cancelados || 0), 0);
    const totalPacotes = rotasAtivas.reduce((acc, rota) => acc + Number(rota.totalPacotes || 0), 0);

    return {
        distancia,
        tempo,
        receber,
        entregasConcluidas,
        totalPacotes,
        alvoPacotes: Math.max(1, Number(meta?.alvoPacotes || 20))
    };
}

function resumirRotaParaEntregador(rota, mapaPacotes, usuarioData = {}) {
    const pacoteIds = Array.isArray(rota?.pacoteIds) ? rota.pacoteIds : (Array.isArray(rota?.pacotes) ? rota.pacotes : []);
    const pacotes = pacoteIds.map((id) => mapaPacotes.get(id)).filter(Boolean);

    const totalDistPacotes = pacotes.reduce((acc, p) => acc + Number(p?.distanciaKm || 0), 0);
    const totalDurPacotes = pacotes.reduce((acc, p) => acc + Number(p?.duracaoMin || 0), 0);
    const totalDist = Number.isFinite(Number(rota?.distanciaTotal)) ? Number(rota.distanciaTotal) : totalDistPacotes;
    const totalDur = Number.isFinite(Number(rota?.duracaoTotal)) ? Number(rota.duracaoTotal) : totalDurPacotes;
    const totalValor = Number.isFinite(Number(rota?.totalFrete))
        ? Number(rota.totalFrete)
        : pacotes.reduce((acc, p) => acc + Number(p?.valorFrete || 0), 0);

    const concluidos = pacotes.filter((p) => p.status === 'CONCLUIDO');
    const cancelados = pacotes.filter((p) => p.status === 'CANCELADO');
    const restantes = pacotes.filter((p) => p.status !== 'CONCLUIDO' && p.status !== 'CANCELADO');

    const statusNorm = normalizarStatusRotaFiltro(rota?.status || rota?.pagamentoStatus || 'CRIADA');
    const totalPacotesRota = Math.max(0, Number(rota?.quantidade || pacotes.length || 0));
    const concluidosCount = pacotes.length
        ? concluidos.length
        : (statusNorm === 'CONCLUIDO' ? totalPacotesRota : 0);
    const restantesCount = Math.max(0, totalPacotesRota - concluidosCount - cancelados.length);

    const restanteDist = pacotes.length
        ? restantes.reduce((acc, p) => acc + Number(p?.distanciaKm || 0), 0)
        : (statusNorm === 'CONCLUIDO' ? 0 : totalDist);
    const restanteDur = pacotes.length
        ? restantes.reduce((acc, p) => acc + Number(p?.duracaoMin || 0), 0)
        : (statusNorm === 'CONCLUIDO' ? 0 : totalDur);
    const valorRestante = pacotes.length
        ? restantes.reduce((acc, p) => acc + Number(p?.valorFrete || 0), 0)
        : (statusNorm === 'CONCLUIDO' ? 0 : totalValor);

    const destinosPacotes = [...new Set(pacotes.map((p) => (p?.cidade || '').trim()).filter(Boolean))];
    const destinosFallback = Array.isArray(rota?.destinos) ? rota.destinos : [];
    const destinos = destinosPacotes.length ? destinosPacotes : (destinosFallback.length ? destinosFallback : (rota?.destinoPrincipal ? [rota.destinoPrincipal] : []));
    const origemCidade = (usuarioData?.endereco?.cidade || '').trim();
    const origemUf = (usuarioData?.endereco?.uf || usuarioData?.endereco?.estado || '').trim();

    const progresso = totalPacotesRota ? Math.round((concluidosCount / totalPacotesRota) * 100) : 0;
    const dataRef = Number(rota?.aceitoEm || rota?.atualizadoEm || rota?.criadoEm || Date.now());

    return {
        id: rota?.id || '--',
        statusNorm,
        statusVisual: getStatusVisualRota(statusNorm),
        totalPacotes: totalPacotesRota,
        concluidos: concluidosCount,
        cancelados: cancelados.length,
        restante: restantesCount,
        totalDist,
        totalDur,
        restanteDist,
        restanteDur,
        totalValor,
        valorRestante,
        origem: origemCidade ? (origemCidade + (origemUf ? ', ' + origemUf : '')) : '--',
        destino: destinos.length ? destinos.join(' / ') : '--',
        destinoPrincipal: destinos[0] || '--',
        progresso,
        dataRef,
        pacotes
    };
}

function montarCardRotaEntregador(rotaResumo, subtitulo = '') {
    const statusCor = rotaResumo.statusNorm === 'EM_ROTA'
        ? 'bg-sky-100 text-sky-600'
        : (rotaResumo.statusNorm === 'CONCLUIDO' ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-500');

    const rotaIdEsc = String(rotaResumo.id || '').replace(/'/g, "\\'");
    const valorTxt = precoParaMoeda(rotaResumo.totalValor || 0);

    return `<button type="button" onclick="abrirSheetRotaEntregadorHome('${rotaIdEsc}')" class="w-full rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm transition active:scale-[0.99]">
        <div class="flex items-start justify-between gap-2">
            <div>
                <p class="text-[13px] font-extrabold text-slate-900">ID: ${rotaResumo.id}</p>
                <p class="text-[11px] text-slate-500">${subtitulo || (rotaResumo.totalPacotes + ' pacote(s)')}</p>
            </div>
            <span class="rounded-full px-2 py-1 text-[10px] font-bold uppercase ${statusCor}">${rotaResumo.statusVisual.label}</span>
        </div>

        <div class="mt-2 h-[4px] w-full overflow-hidden rounded-full bg-slate-100">
            <div class="h-full rounded-full bg-flexa-orange transition-all duration-300" style="width:${Math.max(0, Math.min(100, rotaResumo.progresso))}%"></div>
        </div>

        <div class="mt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-500">
            <div>
                <span class="font-semibold text-slate-400">Origem</span>
                <p class="truncate font-semibold text-slate-700">${rotaResumo.origem}</p>
            </div>
            <div>
                <span class="font-semibold text-slate-400">Destino</span>
                <p class="truncate font-semibold text-slate-700">${rotaResumo.destinoPrincipal || rotaResumo.destino}</p>
            </div>
        </div>

        <div class="mt-2 flex items-center justify-between text-[11px] font-semibold text-slate-500">
            <span>${formatarDistancia(rotaResumo.totalDist)} • ${formatarTempoCompacto(rotaResumo.totalDur)}</span>
            <span class="text-[12px] font-extrabold text-flexa-orange">${valorTxt}</span>
        </div>
    </button>`;
}

function renderizarDashboardEntregador(payloadUsuario = null) {
    const container = document.getElementById('dash-entregador-content');
    if (!container) return;

    const dados = payloadUsuario || entregadorHomeCache || window.usuarioLogado || {};
    const saldo = Number(dados?.financeiro?.saldo || 0);
    const headerHtml = renderHeaderGlobal('entregador', saldo);
    const metaDia = obterMetaDiaEntregador(dados);

    const rotasNo = dados?.rotas || {};
    const clientesNo = dados?.clientes || {};
    const mapaPacotes = montarMapaPacotesParaEntregador(clientesNo);
    const listaRotas = Object.keys(rotasNo).map((id) => ({ id, ...(rotasNo[id] || {}) }))
        .sort((a, b) => Number(b?.atualizadoEm || b?.criadoEm || 0) - Number(a?.atualizadoEm || a?.criadoEm || 0));

    const resumoRotas = listaRotas.map((rota) => resumirRotaParaEntregador(rota, mapaPacotes, dados));
    const rotasEmRota = resumoRotas.filter((r) => r.statusNorm === 'EM_ROTA');
    const rotasAIniciar = resumoRotas.filter((r) => r.statusNorm === 'BUSCANDO');
    const rotasRecentes = resumoRotas.slice(0, 3);

    const rotaAtual = rotasEmRota[0] || rotasAIniciar[0] || resumoRotas[0] || null;
    const resumoDia = calcularResumoDiaEntregador(resumoRotas, metaDia);
    const resumoAtivo = calcularResumoAtivoEntregador(rotasEmRota, metaDia);
    entregadorMetaDiaCache = { ...resumoDia, ...metaDia };

    const cardsEmRota = rotasEmRota.length
        ? rotasEmRota.map((r) => montarCardRotaEntregador(r, `${r.totalPacotes} pacote(s) em andamento`)).join('')
        : '<div class="rounded-2xl border border-dashed border-slate-300 bg-white px-3 py-4 text-center text-[12px] font-semibold text-slate-400">Nenhuma rota em andamento agora.</div>';

    const cardsRotasRecentes = rotasRecentes.length
        ? rotasRecentes.map((r) => montarCardRotaEntregador(r, `${r.totalPacotes} pacote(s) • ${r.statusVisual.label}`)).join('')
        : '<div class="rounded-2xl border border-dashed border-slate-300 bg-white px-3 py-4 text-center text-[12px] font-semibold text-slate-400">Nenhuma rota recente para exibir.</div>';

    const progressoPct = (() => {
        if (resumoAtivo.totalPacotes > 0) {
            return Math.max(0, Math.min(100, Math.round((resumoAtivo.entregasConcluidas / resumoAtivo.totalPacotes) * 100)));
        }
        if (resumoDia.progressoGeral) return Math.max(0, Math.min(100, resumoDia.progressoGeral));
        if (rotaAtual && Number.isFinite(rotaAtual.progresso)) return Math.max(0, Math.min(100, rotaAtual.progresso));
        return 0;
    })();

    container.innerHTML = `
        ${headerHtml}
        <div class="pb-28">
            <div class="mb-3 overflow-hidden rounded-2xl bg-white shadow-sm">
                <img src="img/banner1.png" alt="Banner Flexa" class="h-auto w-full object-cover" onerror="this.style.display='none'">
            </div>

            <div class="mb-3 rounded-3xl bg-white p-3 shadow-sm entregador-dia-card">
                <div class="dash-meta-head">
                    <div class="dash-meta-title">• Meta do dia (${Math.max(0, Math.min(100, progressoPct))}% concluido)</div>
                    <button type="button" class="dash-meta-link" onclick="abrirModalMetaDiaEntregador()">Ver mais</button>
                </div>

                <div class="dash-meta-progress-track">
                    <div class="dash-meta-progress-fill" style="width:${progressoPct}%"></div>
                </div>

                <div class="dash-meta-grid">
                    <div class="dash-meta-item dash-meta-item-azul">
                        <span class="dash-meta-icon"><i data-lucide="map-pin" size="15"></i></span>
                        <small>Percorrido</small>
                        <strong>${formatarDistancia(resumoAtivo.distancia)}</strong>
                    </div>

                    <div class="dash-meta-item dash-meta-item-laranja">
                        <span class="dash-meta-icon"><i data-lucide="clock-3" size="15"></i></span>
                        <small>Em rota</small>
                        <strong>${formatarTempoPainel(resumoAtivo.tempo)}</strong>
                    </div>

                    <div class="dash-meta-item dash-meta-item-verde">
                        <span class="dash-meta-icon"><i data-lucide="package-check" size="15"></i></span>
                        <small>Entregas</small>
                        <strong>${resumoAtivo.entregasConcluidas}/${resumoAtivo.totalPacotes || 0}</strong>
                    </div>

                    <div class="dash-meta-item dash-meta-item-amarelo">
                        <span class="dash-meta-icon"><i data-lucide="wallet" size="15"></i></span>
                        <small>A receber</small>
                        <strong>${precoParaMoeda(Number(resumoAtivo.receber || 0))}</strong>
                    </div>
                </div>
            </div>

            <section class="mb-3">
                <div class="mb-2 flex items-center justify-between">
                    <h3 class="text-[16px] font-extrabold text-slate-900">Em rota</h3>
                    <button type="button" class="text-[12px] font-bold text-flexa-orange" onclick="navegar('view-rotas')">Ver todas</button>
                </div>
                <div class="space-y-2">${cardsEmRota}</div>
            </section>

            <section>
                <div class="mb-2 flex items-center justify-between">
                    <h3 class="text-[16px] font-extrabold text-slate-900">Rotas Recentes</h3>
                    <button type="button" class="text-[12px] font-bold text-flexa-orange" onclick="navegar('view-rotas')">Ver todas</button>
                </div>
                <div class="space-y-2">${cardsRotasRecentes}</div>
            </section>
        </div>
    `;

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function abrirSheetRotaEntregadorHome(rotaId) {
    abrirSheetRotaEntregador(rotaId, { refetchPacotes: true });
}

function abrirModalMetaDiaEntregador() {
    const meta = entregadorMetaDiaCache || {};
    const inicioDiaTxt = Number(meta.inicioEm) ? new Date(meta.inicioEm).toLocaleString('pt-BR') : '--';
    const html = `
        <div class="info-card">
            <h4>Meta da jornada</h4>
            <p><strong>Inicio do expediente:</strong> ${inicioDiaTxt}</p>
            <p><strong>Ganhos concluidos:</strong> ${precoParaMoeda(Number(meta.ganhosConcluidos || 0))}</p>
            <p><strong>Pacotes entregues:</strong> ${Number(meta.totalPacotesConcluidos || 0)} / ${Math.max(1, Number(meta.alvoPacotes || 20))}</p>
            <p><strong>Distancia percorrida:</strong> ${formatarDistancia(Number(meta.distanciaConcluida || 0))}</p>
            <p><strong>Tempo em rota:</strong> ${formatarTempoCompacto(Number(meta.tempoConcluido || 0))}</p>
        </div>
        <button type="button" class="btn-main" style="margin-top: 8px;" onclick="zerarMetaDiaEntregador()">Zerar meta do dia</button>
    `;
    abrirModalInfoPerfil('Meta do dia', html);
}

async function zerarMetaDiaEntregador() {
    const uid = getUsuarioIdAtual();
    if (!uid || !usuarioEhEntregador()) return;

    const confirmar = confirm('Finalizar expediente e zerar os contadores do dia?');
    if (!confirmar) return;

    const metaAtual = entregadorMetaDiaCache || {};
    const agora = Date.now();
    const historicoPayload = {
        inicioEm: Number(metaAtual.inicioEm || obterInicioDiaLocal(agora)),
        finalizadoEm: agora,
        ganhosConcluidos: Number(metaAtual.ganhosConcluidos || 0),
        pacotesConcluidos: Number(metaAtual.totalPacotesConcluidos || 0),
        distanciaConcluidaKm: Number(metaAtual.distanciaConcluida || 0),
        tempoConcluidoMin: Number(metaAtual.tempoConcluido || 0)
    };

    await db.ref(`usuarios/${uid}/metaDiaHistorico`).push(historicoPayload);
    await db.ref(`usuarios/${uid}/entregadorMetaDia`).update({
        inicioEm: agora,
        alvoPacotes: Math.max(1, Number(metaAtual.alvoPacotes || 20)),
        alvoGanhos: Math.max(1, Number(metaAtual.alvoGanhos || 150)),
        atualizadoEm: agora
    });

    fecharModalInfoPerfil();
}
function pararListenerHomeEntregador() {
    if (entregadorHomeListenerRef && entregadorHomeListenerCb) {
        entregadorHomeListenerRef.off('value', entregadorHomeListenerCb);
    }
    entregadorHomeListenerRef = null;
    entregadorHomeListenerCb = null;
    entregadorHomeListenerUid = null;
}

function registrarPresencaUsuario(uid) {
    try {
        pararPresencaUsuarioAtual();
        const ref = db.ref('presence/' + uid);
        const payload = { online: true, ts: firebase.database.ServerValue.TIMESTAMP };
        ref.set(payload);
        ref.onDisconnect().remove();
        presencaRef = ref;
        // heartbeat a cada 60s
        presencaInterval = setInterval(() => {
            ref.update({ ts: firebase.database.ServerValue.TIMESTAMP });
        }, 60000);
    } catch (err) {
        console.warn('Falha ao registrar presença:', err);
    }
}

function pararPresencaUsuarioAtual() {
    try {
        if (presencaInterval) {
            clearInterval(presencaInterval);
            presencaInterval = null;
        }
        if (presencaRef) {
            presencaRef.remove().catch(() => {});
            presencaRef = null;
        }
    } catch (err) {
        console.warn('Falha ao parar presença:', err);
    }
}

let trackLojaIdAtual = null;
async function abrirModalTrackingLoja(rotaId) {
    if (!rotaId) return;
    try {
        trackLojaIdAtual = rotaId;

        const rota = (rotasHomeCache || []).find((r) => String(r.id) === String(rotaId)) || {};
        const statusStr = rota?.status || rota?.pagamentoStatus || 'CRIADA';
        const status = getStatusVisualRota(statusStr);

    const pacotes = getPacotesDaRota(rota);
    const totalPac = pacotes.length || Number(rota?.quantidade || 0) || 0;
    const valor = Number.isFinite(Number(rota?.totalFrete))
        ? Number(rota.totalFrete)
        : pacotes.reduce((acc, p) => acc + Number(p?.valorFrete || 0), 0);

    const origem = rota?.origemLabel
        || rota?.coletaLabel
        || rota?.coletaCidade
        || (pacotes[0]?.origemLabel)
        || '--';
    const destinos = Array.isArray(rota?.destinos) ? rota.destinos : [];
    const destinoPrincipal = rota?.destinoPrincipal
        || destinos[0]
        || pacotes[0]?.destinoLabel
        || '--';

    const parseNum = (v) => {
        if (v === null || v === undefined) return 0;
        let s = v;
        if (typeof s === 'string') {
            s = s.replace(/[^0-9,.\-]/g, '').replace(',', '.');
        }
        return Number(s) || 0;
    };

    let distRaw = parseNum(rota?.distanciaTotal || rota?.kmTotal || rota?.km || rota?.distancia);
    let durRaw = parseNum(rota?.duracaoTotal || rota?.tempoTotal || rota?.duracao || rota?.tempo);
    if (!distRaw && Array.isArray(pacotes) && pacotes.length) {
        distRaw = pacotes.reduce((acc, p) => acc + parseNum(p?.distancia || p?.km || p?.distanciaKm || p?.distanciaTotal), 0);
    }
    if (!durRaw && Array.isArray(pacotes) && pacotes.length) {
        durRaw = pacotes.reduce((acc, p) => acc + parseNum(p?.duracao || p?.tempo || p?.duracaoMin || p?.duracaoTotal), 0);
    }
    const dist = distRaw > 0 ? formatarDistancia(distRaw) : '--';
    const dur = durRaw > 0 ? formatarDuracao(durRaw) : '--';

        const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
        setTxt('track-loja-status', status.label);
        setTxt('track-loja-id', rota.id || '--');
        setTxt('track-loja-pacotes', `${totalPac} pacote(s)`);
        setTxt('track-loja-valor', precoParaMoeda(valor || 0));
        setTxt('track-loja-distancia', distRaw ? dist : 'Calculando...');
        setTxt('track-loja-duracao', durRaw ? dur : 'Calculando...');

    // linha do tempo de pacotes (até 5 pontos)
    const timelineEl = document.getElementById('track-loja-timeline');
    if (timelineEl) {
        const maxDots = 5;
        const total = totalPac || 1;
        const entregues = pacotes.filter(p => (p?.status || '').toUpperCase() === 'ENTREGUE').length;
        const cancelados = pacotes.filter(p => (p?.status || '').toUpperCase() === 'CANCELADO').length;
        const concluidos = entregues + cancelados;
        const grupo = Math.max(1, Math.ceil(total / maxDots));
        const dotsCount = Math.min(maxDots, Math.max(1, Math.ceil(total / grupo)));
        timelineEl.classList.toggle('is-single', dotsCount === 1);
        let html = '';
        for (let i = 0; i < dotsCount; i++) {
            const rangeStart = i * grupo;
            const rangeEnd = Math.min(total, rangeStart + grupo);
            const entreguesRange = pacotes.slice(rangeStart, rangeEnd).filter(p => (p?.status || '').toUpperCase() === 'ENTREGUE').length;
            const canceladosRange = pacotes.slice(rangeStart, rangeEnd).filter(p => (p?.status || '').toUpperCase() === 'CANCELADO').length;
            const reached = (rangeEnd <= concluidos);
            const hasCancel = canceladosRange > 0;
            const active = !reached && concluidos >= rangeStart && concluidos < rangeEnd;
            const classe = reached ? 'done' : active ? 'active' : hasCancel ? 'cancel' : '';
            html += `<span class="tracking-dot ${classe}"></span>`;
        }
        timelineEl.innerHTML = html;
    }

    // Entregador
        const rowDriver = document.getElementById('track-driver-row');
        const fotoEl = document.getElementById('track-driver-foto');
        const nomeEl = document.getElementById('track-driver-nome');
        const rolEl = document.getElementById('track-driver-rol');
        const btnCall = document.getElementById('track-driver-call');
        const btnChat = document.getElementById('track-driver-chat');
        const entregadorInfoDireto = rota?.entregador || rota?.driver || {};
        const setBtnState = (btn, enabled) => {
            if (!btn) return;
            btn.style.opacity = enabled ? '1' : '0.4';
            btn.style.pointerEvents = enabled ? 'auto' : 'none';
        };

    if (rowDriver) rowDriver.style.display = 'flex';
    aplicarFotoComPlaceholder(fotoEl, '');
    if (nomeEl) nomeEl.innerText = '--';
    if (rolEl) rolEl.innerText = 'Entregador';
    setBtnState(btnCall, false);
    setBtnState(btnChat, false);

    const entregadorId =
        rota?.entregadorId
        || rota?.aceitoPor
        || rota?.aceitoPorUid
        || rota?.entregadorUid
        || rota?.entregador?.id
        || rota?.entregador?.uid
        || entregadorInfoDireto?.id;
    const hasDriver = Boolean(entregadorId);
    const podeChat = hasDriver; // se o card está em rota, o vínculo já existe, libera chat

        if (hasDriver) {
            const snap = await db.ref(`usuarios/${entregadorId}`).once('value');
            const driver = { ...(snap?.val() || {}), ...entregadorInfoDireto };
            if (nomeEl) nomeEl.innerText = driver.nome || driver.displayName || 'Entregador';
            if (rolEl) rolEl.innerText = driver.tipo === 'entregador' ? 'Entregador' : (driver.tipo || 'Entregador');
            if (fotoEl) {
                const foto = driver.foto || driver.photoURL || driver.avatar || driver.logo;
                aplicarFotoComPlaceholder(fotoEl, foto || '');
            }

            const telefone = driver.whatsapp || driver.telefone || driver.celular || rota?.telefoneEntregador || driver?.contato || '';
            if (btnCall) {
                if (telefone) {
                    const numeroLimpo = String(telefone).trim();
                    btnCall.onclick = () => { window.location.href = `tel:${numeroLimpo}`; };
                    setBtnState(btnCall, true);
                } else {
                    btnCall.onclick = null;
                    setBtnState(btnCall, false);
                }
            }
            if (btnChat) {
                if (podeChat) {
                    btnChat.onclick = () => abrirChatDaRota(rotaId);
                    setBtnState(btnChat, true);
                } else {
                    btnChat.onclick = null;
                    setBtnState(btnChat, false);
                }
            }
        } else if (rowDriver) {
            rowDriver.style.display = 'none';
        }

        const uidLojista = getUsuarioIdAtual();
        if (hasDriver && uidLojista) {
            iniciarListenerGeoTrackingLoja(uidLojista, rotaId);
        } else {
            pararListenerGeoTrackingLoja();
            atualizarMapaTrackingLoja(null);
        }

        const banner = document.getElementById('track-loja-stale-banner');
        if (banner) {
            const parada = await verificarRotaParada(rota);
            banner.style.display = parada ? 'block' : 'none';
        }

        const overlay = document.getElementById('overlay-tracking-loja');
        if (overlay) {
            overlay.style.display = 'flex';
            if (window.lucide) window.lucide.createIcons();
        }
    } catch (err) {
        console.error('Erro ao abrir tracking', err);
        notificarErro('Não foi possível abrir os detalhes da rota.');
    }
}

function abrirChatDaRota(rotaId) {
    if (!rotaId) return;
    const rotaRef = (rotasHomeCache || []).find((r) => String(r.id) === String(rotaId)) || {};
    const chatId = chatIdParaRota(rotaRef);

    // navega para aba chat
    if (typeof ativarMenuInferior === 'function') ativarMenuInferior('view-chat');
    if (typeof navegar === 'function') navegar('view-chat');
    // fecha o modal de tracking
    fecharModalTrackingLoja();

    const participanteNome = rotaRef?.entregador?.nome || rotaRef?.entregadorNome || 'Entregador';
    const participanteId = rotaRef?.entregadorId || rotaRef?.entregadorUid || '';

    // cria stub se não existir
    if (!chatConversasCache.find((c) => c.chatId === chatId)) {
        chatConversasCache.push({
            chatId,
            rotaId: String(rotaId),
            participanteNome,
            participanteId,
            participanteTipo: 'ENTREGADOR',
            pacotesAbertos: 1,
            ultimaMensagemTexto: 'Conversa iniciada',
            ultimaMensagemEm: Date.now(),
            atualizadoEm: Date.now()
        });
    }

    // abre thread; se ainda não carregou mensagens, renderiza vazio e listener entra
    abrirThreadChat(chatId);
    carregarChatsAtivos();
}

function fecharModalTrackingLoja() {
    const overlay = document.getElementById('overlay-tracking-loja');
    if (overlay) overlay.style.display = 'none';
    trackLojaIdAtual = null;
    pararListenerGeoTrackingLoja();
}

// ===== [MAPA AO VIVO NO TRACKING DO LOJISTA] =====
let geoTrackingListenerRef = null;
let geoTrackingListenerCb = null;

function pararListenerGeoTrackingLoja() {
    if (geoTrackingListenerRef && geoTrackingListenerCb) {
        geoTrackingListenerRef.off('value', geoTrackingListenerCb);
    }
    geoTrackingListenerRef = null;
    geoTrackingListenerCb = null;
}

function iniciarListenerGeoTrackingLoja(lojistaUid, rotaId) {
    pararListenerGeoTrackingLoja();
    if (!lojistaUid || !rotaId) return;

    const ref = db.ref(`usuarios/${lojistaUid}/rotas/${rotaId}/entregadorGeo`);
    const callback = (snap) => atualizarMapaTrackingLoja(snap.val());
    ref.on('value', callback);
    geoTrackingListenerRef = ref;
    geoTrackingListenerCb = callback;
}

function atualizarMapaTrackingLoja(geo) {
    const wrap = document.getElementById('track-loja-map-wrap');
    const frame = document.getElementById('track-loja-map-frame');
    const status = document.getElementById('track-loja-geo-status');
    if (!wrap || !frame || !status) return;

    const lat = Number(geo?.lat);
    const lng = Number(geo?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        wrap.style.display = 'none';
        frame.src = '';
        return;
    }

    wrap.style.display = 'block';
    frame.src = `https://www.google.com/maps?q=${lat},${lng}&z=15&output=embed`;

    const atualizadoEm = Number(geo?.atualizadoEm || 0);
    if (atualizadoEm) {
        const minutosAtras = Math.max(0, Math.round((Date.now() - atualizadoEm) / 60000));
        status.innerText = minutosAtras <= 0 ? 'Localização atualizada agora' : `Localização atualizada há ${minutosAtras} min`;
    } else {
        status.innerText = '--';
    }
}

// Considera a rota "parada" se o entregador aceitou há mais de 2h e ainda não iniciou
// a corrida de NENHUM pacote dela (ver corridaIniciadaEm, gravado em iniciarCorridaPacoteAtual).
const LIMITE_ROTA_PARADA_MS = 2 * 60 * 60 * 1000;

async function verificarRotaParada(rota) {
    const temEntregador = Boolean(rota?.entregadorId || rota?.aceitoPor);
    if (!temEntregador) return false;

    const aceitoEm = Number(rota?.aceitoEm || 0);
    if (!aceitoEm || (Date.now() - aceitoEm) < LIMITE_ROTA_PARADA_MS) return false;

    const uid = getUsuarioIdAtual();
    const pacoteIds = Array.isArray(rota?.pacoteIds) ? rota.pacoteIds : (Array.isArray(rota?.pacotes) ? rota.pacotes : []);
    if (!uid || !pacoteIds.length) return true;

    try {
        const snap = await db.ref(`usuarios/${uid}/pacotes`).once('value');
        const pacotesNo = snap.val() || {};
        const algumaCorridaIniciada = pacoteIds.some((id) => Boolean(pacotesNo?.[id]?.corridaIniciadaEm));
        return !algumaCorridaIniciada;
    } catch (_) {
        return false;
    }
}

// Ação do lojista pra destravar uma rota parada sem precisar do admin: remove o
// entregador atual e devolve a rota pro marketplace (status BUSCANDO), removendo
// também a cópia da rota no lado do entregador (evita o bug de desincronização).
async function liberarRotaParadaLojista() {
    const rotaId = trackLojaIdAtual;
    const uid = getUsuarioIdAtual();
    if (!rotaId || !uid) return;

    const rota = (rotasHomeCache || []).find((r) => String(r.id) === String(rotaId));
    if (!rota) return;

    const ok = window.confirm('O entregador atual será removido da rota e ela volta a ficar disponível no marketplace para qualquer entregador aceitar. Continuar?');
    if (!ok) return;

    const entregadorId = String(rota.entregadorId || rota.aceitoPor || '');
    const agora = Date.now();
    const updates = {
        [`usuarios/${uid}/rotas/${rotaId}/status`]: 'BUSCANDO',
        [`usuarios/${uid}/rotas/${rotaId}/pagamentoStatus`]: 'BUSCANDO',
        [`usuarios/${uid}/rotas/${rotaId}/entregadorId`]: null,
        [`usuarios/${uid}/rotas/${rotaId}/aceitoPor`]: null,
        [`usuarios/${uid}/rotas/${rotaId}/aceitoEm`]: null,
        [`usuarios/${uid}/rotas/${rotaId}/entregadorGeo`]: null,
        [`usuarios/${uid}/rotas/${rotaId}/atualizadoEm`]: agora
    };

    try {
        await db.ref().update(updates);
        if (entregadorId) {
            await db.ref(`usuarios/${entregadorId}/rotas/${rotaId}`).remove();
            criarNotificacao(entregadorId, {
                tipo: 'rota_liberada',
                titulo: 'Rota removida de você',
                mensagem: `O lojista liberou a rota #${rotaId} para outro entregador por inatividade.`,
                rotaId: String(rotaId)
            });
        }
        notificarErro('Rota liberada para novo entregador.');
        fecharModalTrackingLoja();
        rotasHomeCache = await carregarRotasDoBanco();
        if (typeof renderRotasTelaPrincipal === 'function') renderRotasTelaPrincipal();
        if (typeof renderEnviosHome === 'function') renderEnviosHome();
    } catch (err) {
        console.warn('Falha ao liberar rota parada:', err);
        alert('Não foi possível liberar a rota agora. Tente novamente.');
    }
}

function iniciarListenerHomeEntregador() {
    const uid = getUsuarioIdAtual();
    if (!uid || obterTipoUsuarioAtual() !== 'entregador') return;

    if (entregadorHomeListenerRef && entregadorHomeListenerUid === uid) {
        return;
    }

    pararListenerHomeEntregador();

    const ref = db.ref('usuarios/' + uid);
    const callback = (snap) => {
        entregadorHomeCache = snap.val() || {};
        if (window.usuarioLogado) {
            window.usuarioLogado = { ...window.usuarioLogado, ...entregadorHomeCache };
            usuarioLogado = window.usuarioLogado;
        }

        if (document.getElementById('view-dash-entregador')?.classList.contains('active')) {
            renderizarDashboardEntregador(window.usuarioLogado || entregadorHomeCache || {});
        }

        // badge de novas mensagens (simples): se houver chats e usuário fora da view chat
        atualizarBadgeChatSimples(entregadorHomeCache?.chats || {});
    };

    ref.on('value', callback);
    entregadorHomeListenerRef = ref;
    entregadorHomeListenerCb = callback;
    entregadorHomeListenerUid = uid;
}



















































// ============================================================================
// TEMPORARY BRIDGE EXPORT — Stage 1 of the modularization refactor.
// This file is a verbatim staging copy of the pre-refactor app.js, kept as a
// single module only until Stage 2/3 slice it into src/<domain>/*.js. Every
// top-level function is re-exported here so main.js can attach them all to
// window (inline onclick=/onchange=/... handlers in index.html need them on
// the global object, same as before esbuild). Delete this file once the real
// domain modules replace it.
export {
  abrirAjuda,
  abrirChatDaRota,
  abrirCriarRota,
  abrirEditarCliente,
  abrirFaleConosco,
  abrirHistoricoDoClienteAtual,
  abrirModalAcoesCliente,
  abrirModalDetalheEnvio,
  abrirModalDetalheRota,
  abrirModalEndereco,
  abrirModalEnvioDetalhes,
  abrirModalHistorico,
  abrirModalInfoPerfil,
  abrirModalMetaDiaEntregador,
  abrirModalNovoCliente,
  abrirModalPerfil,
  abrirModalRastrearRotas,
  abrirModalTrackingLoja,
  abrirNotificacao,
  abrirNovaRotaPeloChip,
  abrirNovoCliente,
  abrirNovoClientePeloSeletor,
  abrirPagamento,
  abrirPainelListaChat,
  abrirPainelNotificacoes,
  abrirPainelThreadChat,
  abrirSeletorCliente,
  abrirSeletorImagemChat,
  abrirSheetBuscaRota,
  abrirSheetRotaEntregador,
  abrirSheetRotaEntregadorHome,
  abrirSobre,
  abrirThreadChat,
  acaoPrincipalModalRota,
  aceitarRotaMarketplaceEntregador,
  adminAlterarStatusPacotes,
  adminCarregarPacotes,
  adminCreateField,
  adminCreateTable,
  adminDeleteField,
  adminListTables,
  adminSalvarPacotes,
  adminSalvarRotas,
  agendarBuscaCepCliente,
  agendarBuscaCepLoja,
  ajustarSaldoUsuario,
  alternarAuth,
  alternarStatusUsuarioMaster,
  animarAtivacaoItemMenu,
  aplicarFiltroRotaEntregador,
  aplicarFreteTesteSeConfigurado,
  aplicarHeaderGlobalEmViewEstatica,
  aplicarPermissoesPorTipoUsuario,
  aplicarTipoCadastroNaTela,
  ativarAbaChat,
  ativarMenuInferior,
  ativarModoAdminSeNecessario,
  atualizarAvisoAmbientePix,
  atualizarBadgeChatSimples,
  atualizarBadgeNotificacoes,
  atualizarCodigoConfirmacaoAtual,
  atualizarDisponibilidadeVeiculos,
  atualizarEstadoBotaoCentralMenu,
  atualizarIndicadorMenuInferior,
  atualizarListaBuscaEntregador,
  atualizarListaMarketplaceRotasEntregador,
  atualizarListasClientesUI,
  atualizarLocalColetaDinamico,
  atualizarMapaTrackingLoja,
  atualizarPrecoEstimadoAtual,
  atualizarPrecosCardsVeiculo,
  atualizarResumoModalDetalheRota,
  atualizarResumoRota,
  atualizarResumoSelecaoRota,
  atualizarSaldoPagamentoUI,
  atualizarStatusRotaMaster,
  atualizarWalletChipEntregadorUI,
  buscarCEP,
  buscarDadosDoBanco,
  buscarEndereco,
  cadastrarReal,
  calcularFreteBaseServico,
  calcularFreteEstimado,
  calcularPesoTotalRota,
  calcularResumoAtivoEntregador,
  calcularResumoDiaEntregador,
  calcularValorCreditoRota,
  caminhoFinanceiroUsuario,
  cancelarCorridaPacoteAtual,
  carregarChatsAtivos,
  carregarDadosPagamento,
  carregarExtratoPagamento,
  carregarGoogleMapsJs,
  carregarMarketplaceRotasEntregador,
  carregarPacotesRaizDoUid,
  carregarRotasDoBanco,
  chamarPaymentsProxy,
  chatEstaAtivo,
  chatIdParaRota,
  closeModal,
  cobrarTaxaCancelamentoEnvio,
  coletarEnviosDaBase,
  coletarEnviosPendentesParaRota,
  confirmarEntregaPacoteAtual,
  confirmarEnvioFinal,
  confirmarExclusaoEnvio,
  confirmarExclusaoRota,
  confirmarPagamentoRota,
  consultarPagamentoPixMercadoPago,
  consultarPagamentoPixTesteClienteLocal,
  copiarCodigoPixRota,
  creditarCarteiraEntregadorRotaFinalizada,
  creditarSaldoUsuarioAtual,
  criarContaMaster,
  criarNotificacao,
  criarPagamentoPixMercadoPago,
  criarPagamentoPixTesteClienteLocal,
  debitarSaldoUsuarioAtual,
  desfazerExclusaoCliente,
  desistirRotaEntregador,
  detalheRotaParaTexto,
  encerrarListenerMensagensChat,
  entSheetNext,
  entSheetPrev,
  enviarMensagemChat,
  enviarResetSenhaMaster,
  envioPassaNoFiltro,
  estimarRotaEntrega,
  estimarRotaGoogle,
  estimarRotaRoutesApi,
  estimativaPlausivel,
  excluirClienteAtualComConfirmacao,
  excluirClienteComDesfazer,
  excluirEnvioAtualNoModal,
  excluirEnvioPorId,
  excluirRotaAtualComConfirmacao,
  excluirRotaPorId,
  extrairCidadeEnderecoSimples,
  fecharModalAcoesCliente,
  fecharModalDetalheEnvio,
  fecharModalDetalheRota,
  fecharModalEndereco,
  fecharModalEnvioDetalhes,
  fecharModalHistorico,
  fecharModalInfoPerfil,
  fecharModalNovoCliente,
  fecharModalPagamento,
  fecharModalPerfil,
  fecharModalRastrearRotas,
  fecharModalRota,
  fecharModalTrackingLoja,
  fecharPainelNotificacoes,
  fecharSeletorCliente,
  fecharSheetBuscar,
  fecharSheetRotaEntregador,
  fecharSwipesClientesSelector,
  fecharSwipesEnvio,
  fecharSwipesRota,
  fecharToastSuave,
  finalizarSplash,
  finalizarSwipeEntSheet,
  finalizarSwipePaginaRota,
  formatarDataExtrato,
  formatarHoraChat,
  formatarHoraNotificacao,
  formatarSaldoPagamento,
  formatarTamanhoTotalRota,
  formatarTempoCompacto,
  formatarTempoPainel,
  garantirCodigosConfirmacaoEntrega,
  garantirEstimativaAtual,
  garantirGeoClienteSelecionado,
  garantirPacotesDaRota,
  geocodificarCliente,
  geocodificarEndereco,
  geocodificarPorCampos,
  gerarCodigoConfirmacaoEntrega,
  gerarIdRota,
  gerarIdempotencyKeyTesteLocal,
  gerarIniciais,
  getChavePacoteRota,
  getClienteById,
  getEtapaRastreamento,
  getGeoCliente,
  getPacotesDaRota,
  getServicoSelecionadoAtual,
  getStatusVisualRota,
  getUsuarioIdAtual,
  handleEnvioBack,
  handleEnvioTouchEnd,
  handleEnvioTouchMove,
  handleEnvioTouchStart,
  handleRotaCardClick,
  handleRotaTouchEnd,
  handleRotaTouchMove,
  handleRotaTouchStart,
  handleSelectorCardClick,
  handleSelectorTouchEnd,
  handleSelectorTouchMove,
  handleSelectorTouchStart,
  iniciarCorridaPacoteAtual,
  iniciarListenerGeoTrackingLoja,
  iniciarListenerHomeEntregador,
  iniciarListenerMarketplaceEntregador,
  iniciarListenerMensagensChat,
  iniciarListenerNotificacoes,
  iniciarModalRota,
  iniciarRastreioGpsEntregador,
  iniciarSwipeEntSheet,
  iniciarSwipePaginaRota,
  initAdminCharts,
  initClienteSearch,
  initClientes,
  initDropdownBuscaEntregador,
  irParaBuscarEntregador,
  irParaCadastro,
  irParaHistoricoRotasEntregador,
  irParaPagamentoRota,
  irParaPasso2,
  irParaPerfil,
  irParaRevisao,
  irParaVeiculos,
  lerValorMonetarioInput,
  liberarRotaParadaLojista,
  limparBadgeChat,
  limparFiltrosRotaEntregador,
  limparHeaderGlobalEmView,
  limparPreviewImagemChat,
  limparUltimoErroRota,
  loadClientes,
  localizarRotaDoEnvio,
  loginAdmin,
  loginReal,
  logoutReal,
  mapearCategoriaEnvio,
  marcarEnviosEmRota,
  marcarNotificacaoLida,
  marcarRotaCanceladaSeVazia,
  marcarTodasNotificacoesLidas,
  montarCardBuscaEntregador,
  montarCardHistoricoRotaEntregador,
  montarCardMarketplaceRotaEntregador,
  montarCardRotaEntregador,
  montarCidadeUfMarketplace,
  montarDropdownFiltroMarketplace,
  montarEnderecoCompletoPacote,
  montarLinkMapaEnvio,
  montarMapaEnviosPorId,
  montarMapaPacotesParaEntregador,
  montarMapaPacotesUsuarioMarketplace,
  montarOptionsDropdownBusca,
  montarOptionsFiltroMarketplace,
  montarTimelineRastreamento,
  montarWaypointRota,
  mostrarTelaAdminDashboard,
  mostrarTelaAdminLogin,
  mostrarTelaAdminSignup,
  moverSwipePaginaRota,
  navegar,
  normalizarCidadeRota,
  normalizarCodigoConfirmacaoEntrega,
  normalizarCodigoPix,
  normalizarFiltroChipEnvio,
  normalizarIdPacoteBusca,
  normalizarStatusEnvioFiltro,
  normalizarStatusPacoteEntrega,
  normalizarStatusRotaFiltro,
  normalizarTipoCadastro,
  obterCidadeDestinoPacoteMarketplace,
  obterCidadeUfUsuarioLogado,
  obterClasseCorStatusEnvioCard,
  obterCodigoConfirmacaoEsperado,
  obterEmailPagadorTesteLocal,
  obterEnderecoLojaAtual,
  obterEnderecoLojaTexto,
  obterEntregadorDaRota,
  obterEntregadorUidDaRota,
  obterEstadoPacoteRota,
  obterFreteTesteDasObservacoes,
  obterIdPacoteConfirmacao,
  obterInicioDiaLocal,
  obterLogoLojista,
  obterLojistaUidDaRota,
  obterMetaDiaEntregador,
  obterNomeDestinatarioPacote,
  obterNomeLojistaSeparadoTesteLocal,
  obterPacotesAbertosRotaParaChat,
  obterParticipanteChatDaRota,
  obterProximoIndicePacotePendente,
  obterTipoUsuarioAtual,
  obterUltimaMensagemResumo,
  openModal,
  pacoteAbertoParaChat,
  pacoteConcluidoOuCanceladoNoSheet,
  pagarComPix,
  pagarRotaComSaldo,
  paginaAnteriorDetalheRota,
  pararListenerGeoTrackingLoja,
  pararListenerHomeEntregador,
  pararListenerMarketplaceEntregador,
  pararListenerNotificacoes,
  pararPresencaUsuarioAtual,
  pararRastreioGpsEntregador,
  parseDurationSecondsGoogle,
  parseMensagensChatDoBanco,
  persistirEntregaPacoteAtual,
  persistirFinanceiroUsuario,
  podeSelecionarPacoteRota,
  preencherPerfilEntregador,
  preencherPerfilLojista,
  preencherTextoDetalheEnvio,
  prepararPacotesRotaEntregador,
  previewImagem,
  proximaPaginaDetalheRota,
  registrarEstadosPacotesRota,
  registrarPresencaUsuario,
  registrarTransacaoFinanceira,
  relatarProblemaRota,
  renderClientesSelector,
  renderDashboardMaster,
  renderEnviosHome,
  renderEtapaModalRota,
  renderExtratoPagamento,
  renderHeaderGlobal,
  renderHistoricoRotasEntregador,
  renderListaChats,
  renderListaModalRastrearRotas,
  renderListaNotificacoes,
  renderListaPendentesRota,
  renderMensagensChat,
  renderRotaDetalhePagina,
  renderRotasMarketplaceEntregador,
  renderRotasTelaPrincipal,
  renderSheetRotaEntregadorConteudo,
  renderTelaBuscarEntregador,
  renderizarDashboard,
  renderizarDashboardEntregador,
  resetClienteForm,
  restaurarRotaMaster,
  resumirCidadesRota,
  resumirRotaParaEntregador,
  rotaMarketplacePassaNoFiltro,
  rotaPassaNoFiltro,
  rotaSheetBloqueada,
  rotaTemEntregadorAtivoParaChat,
  rotuloStatusEnvio,
  salvarDadosPagamento,
  salvarEndereco,
  salvarNovoCliente,
  salvarPerfil,
  salvarRotaNoBanco,
  saveClientes,
  selecionarClienteNoSheet,
  selecionarFiltroEnvios,
  selecionarFiltroRotas,
  selecionarImagemChat,
  selecionarServico,
  selecionarTamanho,
  selecionarVeiculo,
  setEstadoPacoteRota,
  setModalEnvioStep,
  setStatusPacotes,
  setStatusPagamentoPixRota,
  setTicketPagamentoPixRota,
  setUltimoErroRota,
  sincronizarDropdownBuscaEntregador,
  switchAdminTab,
  telaInicialPorTipoUsuario,
  telaPerfilPorTipoUsuario,
  togglePacoteRota,
  togglePass,
  usuarioEhEntregador,
  usuarioEhMaster,
  verHistoricoCliente,
  verTodasAsRotas,
  verificarRotaParada,
  voltarEtapaModalRota,
  voltarListaChats,
  voltarParaDetalhes,
  zerarMetaDiaEntregador,
};
