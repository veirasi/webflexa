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
// BUG CORRIGIDO 2026-09-19: nunca era declarada (só recebia valor dentro de
// selecionarVeiculo), então LER veiculoSelecionado antes do usuário clicar
// em algum card de veículo lançava "ReferenceError: veiculoSelecionado is
// not defined" — e isso é exatamente o que atualizarPrecoEstimadoAtual faz
// automaticamente assim que a distância chega do Google Maps. O erro
// interrompia a função ANTES de atualizarPrecosCardsVeiculo rodar, por isso
// os cards ficavam presos nos preços estáticos de fallback do HTML até o
// clique no card forçar selecionarVeiculo (que aí sim "criava" a variável).
let veiculoSelecionado = 'Moto';
let veiculoPrecoSelecionado = null;
// Coleta reversa (troca/devolução agendada) — ver selecionarTipoFluxoEnvio e
// confirmarEnvioFinal. 'entrega' é o padrão (loja -> cliente, como sempre foi).
let tipoFluxoEnvioAtual = 'entrega';
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
// Taxa de espera/subida (ver confirmarCheguei/aceitarSolicitacaoSubida) —
// listener ao vivo no pacote público pra pegar pedido de subida do cliente
// sem precisar reabrir a rota.
let rotaEntSheetEsperaListenerRef = null;
let rotaEntSheetEsperaListenerChave = '';
// Pix da cobrança na entrega (ver project-flexa-cobranca-entrega-dinheiro)
let pixCobrancaEntregaAtual = null;
let pixCobrancaEntregaPollTimer = null;
let lojistaLogoCache = {};
let rotaEntregadorProgresso = {};
let rotaSwipeStartX = 0;
let rotaSwipeCardAtivo = null;
let filtroEnviosAtivo = 'TODOS';
// Valor LITERAL do chip clicado (não passa por normalizarFiltroChipEnvio) —
// usado só pra decidir qual botão acende. BUG CORRIGIDO 2026-10-02:
// normalizarFiltroChipEnvio junta "Pacote Novo" e "Pagamento Pendente" na
// mesma categoria de filtro (de propósito, pra filtrar o mesmo conjunto),
// mas isso fazia os DOIS chips acenderem juntos sempre que qualquer um dos
// dois era clicado — usar o valor cru aqui mantém o destaque exclusivo sem
// mexer na lógica de filtragem em si.
let filtroEnviosChipAtivo = 'TODOS';
let filtroRotasAtivo = 'BUSCANDO';
let dashboardRotasSincronizadas = false;
let adminUsersCache = null;
let modoAdmin = false;
let presencaRef = null;
let presencaInterval = null;
let adminChartsState = null;
let saquesPendentesAdminCache = [];
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

function atualizarTopoAdmin(nome, email) {
    const nomeEl = document.getElementById('admin-topbar-nome');
    const avatarEl = document.getElementById('admin-avatar');
    const emailEl = document.getElementById('admin-user-email');
    const nomeExib = (nome || '').trim() || (email || '').split('@')[0] || 'Master';
    if (nomeEl) nomeEl.innerText = 'Olá, ' + nomeExib;
    if (avatarEl) avatarEl.innerText = nomeExib.slice(0, 1).toUpperCase();
    if (emailEl) emailEl.innerText = email || '--';
}

function mostrarTelaAdminDashboard() {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const nav = document.getElementById('main-nav');
    if (nav) nav.style.display = 'none';
    const v = document.getElementById('view-admin-dashboard');
    if (v) v.classList.add('active');
    switchAdminTab('overview');
    aplicarTemaAdminSalvo();
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

// ===== [RASTREIO PÚBLICO DO CLIENTE FINAL] =====
// Mesmo padrão do modoAdmin acima: detecta a rota #/rastreio/<token> ANTES
// do primeiro onAuthStateChanged, pra essa tela poder ser mostrada mesmo sem
// (ou independente de) login — inclusive se o link for aberto no mesmo
// navegador onde um lojista/entregador já está logado.
let modoRastreioPublico = false;
let tokenRastreioAtual = '';
// Endereço estruturado do pacote rastreado nesta tela (ver
// renderConteudoRastreioPublico/abrirClienteAuthCompletarCadastro) — usado
// só pra pré-preencher o passo de completar cadastro, nunca persistido aqui.
let enderecoDestinoRastreioAtual = null;
// Uso único de propósito (ver consumirLoginCliente no backend) — essa flag
// só evita tentar de novo à toa a cada hashchange dentro da mesma aba (ex:
// navegação interna que não muda o token); a segunda tentativa de qualquer
// forma seria negada pelo servidor, nunca duplica login.
let loginTokenJaTentado = false;
function ativarModoRastreioSeNecessario() {
    const hash = window.location.hash || '';
    const match = hash.match(/rastreio\/([a-z0-9_-]+)/i);
    // #/cliente (sem token) é o link genérico de convite (ver
    // convidarClienteParaApp) — não aponta pra uma entrega específica, só
    // abre a mesma tela pro cliente entrar/completar o cadastro.
    const ehLinkClienteGenerico = /^#\/cliente\/?$/.test(hash);
    if (match || ehLinkClienteGenerico) {
        modoRastreioPublico = true;
        // Marca no body pra tela de bloqueio de tela grande (styles.css) não
        // esconder o link público de rastreio — esse aqui faz sentido ser
        // aberto num computador (ex: WhatsApp Web).
        document.body.classList.add('modo-rastreio-publico');
        tokenRastreioAtual = match ? match[1] : '';

        // Login automático via link (plano 2026-09-28): se a URL trouxer
        // ?lt=..., tenta autenticar o cliente sozinho, sem nunca mostrar
        // senha nenhuma — roda em paralelo, nunca bloqueia a exibição do
        // rastreio (que já funciona sem login).
        if (!loginTokenJaTentado) {
            const qIdx = hash.indexOf('?');
            if (qIdx >= 0) {
                const loginTokenBruto = new URLSearchParams(hash.slice(qIdx + 1)).get('lt') || '';
                // BUG CORRIGIDO 2026-10-03 (achado pelo dono): "Copiar link"
                // copia URL + mensagem explicando o código numa coisa só,
                // separados por quebra de linha real — pensado pra colar num
                // chat (WhatsApp/SMS), onde isso é só texto normal. Mas se
                // alguém cola esse bloco inteiro direto numa barra de
                // endereço (ou qualquer lugar que achata quebra de linha em
                // espaço), o resto da mensagem vira parte do valor de "lt",
                // e o token nunca mais bate com nenhum real — login
                // automático falha sempre, silenciosamente. O token real é
                // sempre hexadecimal puro, então corta no primeiro caractere
                // que não é — sem efeito nenhum quando o link é usado certo.
                const loginToken = (loginTokenBruto.match(/^[0-9a-f]+/i) || [''])[0];
                if (loginToken) {
                    loginTokenJaTentado = true;
                    tentarAutoLoginClienteViaLink(loginToken);
                }
            }
        }

        // Se o app já estava carregado (a aba já tinha o Flex aberto e o
        // link mudou só o hash), o onAuthStateChanged não dispara de novo
        // sozinho — então também mostra a tela direto por aqui.
        if (document.readyState !== 'loading') {
            exibirTelaRastreioPublico(tokenRastreioAtual);
        }
    }
}

// Consome o loginToken de uso único (backend) e loga o cliente sozinho na
// instância secundária de auth, sem nunca expor senha nenhuma. Falha
// silenciosa de propósito — o rastreio em si nunca depende disso.
async function tentarAutoLoginClienteViaLink(loginToken) {
    try {
        // BUG CORRIGIDO 2026-09-28: esta função é disparada muito cedo no
        // carregamento do script (por ativarModoRastreioSeNecessario, que já
        // roda antes até do DOMContentLoaded) — FLEXA_PAYMENTS_PROXY_URL só é
        // inicializada bem mais abaixo no arquivo, então lê-la aqui direto
        // pegava undefined (a chamada saía como ".../undefined/consumir-
        // login-cliente", 404). O setTimeout(0) empurra a leitura pra depois
        // que o script inteiro já rodou.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const resp = await fetch(`${FLEXA_PAYMENTS_PROXY_URL}/consumir-login-cliente`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loginToken })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data?.customToken) return;

        const auth2 = obterClienteAuth();
        await auth2.signInWithCustomToken(data.customToken);

        if (data.cadastroCompleto === false) {
            abrirModalClienteAuth('entrar');
            abrirClienteAuthCompletarCadastro(data.nome || '');
        }
    } catch (err) {
        console.warn('Falha no login automático do cliente via link:', err);
    }
}
document.addEventListener('DOMContentLoaded', ativarModoRastreioSeNecessario);
window.addEventListener('hashchange', ativarModoRastreioSeNecessario);
ativarModoRastreioSeNecessario();

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
    // Submenu Lojistas/Entregadores (pedido do dono 2026-09-27) só faz
    // sentido aberto enquanto a aba Usuários está ativa.
    document.getElementById('admin-nav-submenu-users')?.classList.toggle('open', tab === 'users');
    const main = document.querySelector('.admin-main');
    if (main) main.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'auto' });
    document.getElementById('admin-sidebar')?.classList.remove('mobile-open');
    if (tab === 'packages') adminCarregarPacotes();
    if (tab === 'routes') renderDashboardMaster();
    if (tab === 'database') adminListTables();
    if (tab === 'banners') renderBannersAdmin();
    if (tab === 'ganhos') renderSerieGanhosAdmin();
    if (tab === 'chamados') renderChamadosAdmin();
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
    const whatsEl = document.getElementById('perfil-whatsapp-display');
    const emailEl = document.getElementById('perfil-email-display');

    if (nomeEl) nomeEl.innerText = dados.nome || 'Usuário';
    aplicarLinkInstagram(instaEl, dados.instagram || '');
    aplicarFotoComPlaceholder(fotoEl, dados.foto || '');
    if (whatsEl) whatsEl.innerText = dados.whatsapp || '--';
    if (emailEl) emailEl.innerText = dados.email || firebase.auth().currentUser?.email || '--';
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

// Confere se o resultado do Google Geocoding bate com a cidade/UF esperada — usado
// pelos dois geocodificadores (por campos estruturados e por texto livre) pra não
// aceitar silenciosamente um endereço na cidade/bairro errado.
function geocodeBateComCidadeUf(primeiro, cityEsperada, ufEsperada) {
    const cityEsp = normalizarTexto(cityEsperada || '');
    const ufEsp = normalizarUf(ufEsperada || '');
    if (!cityEsp && !ufEsp) return true;
    const comps = Array.isArray(primeiro?.address_components) ? primeiro.address_components : [];
    const cityComp = normalizarTexto((comps.find(c => c.types?.includes('administrative_area_level_2'))?.long_name || comps.find(c => c.types?.includes('locality'))?.long_name || ''));
    const ufComp = normalizarUf(comps.find(c => c.types?.includes('administrative_area_level_1'))?.short_name || '');
    const cidadeOk = !cityEsp || (cityComp && (cityComp.includes(cityEsp) || cityEsp.includes(cityComp)));
    const ufOk = !ufEsp || (ufComp === ufEsp);
    return cidadeOk && ufOk;
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
            if (!geocodeBateComCidadeUf(primeiro, cidade, estado)) {
                setUltimoErroRota('Geocode retornou local divergente do endereco informado.', {
                    enderecoGoogle,
                    cidade,
                    estado,
                    formatted: primeiro?.formatted_address || null
                });
                return null;
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
    document.getElementById('envio-detalhes-vazio')?.classList.add('hidden');
    document.getElementById('envio-detalhes-conteudo')?.classList.remove('hidden');
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

    // Desktop: formulário e lista de clientes abrem/fecham juntos (ver
    // abrirSeletorCliente) — fecha a lista inline aqui (sem chamar
    // fecharSeletorCliente(), que faria o inverso e entraria em loop).
    if (document.body.classList.contains('lojista-desktop-mode')) {
        const seletor = document.getElementById('modal-seletor-cliente');
        if (seletor) {
            if (typeof fecharSwipesClientesSelector === 'function') fecharSwipesClientesSelector();
            seletor.classList.remove('is-open');
            setTimeout(() => {
                seletor.style.display = 'none';
            }, 220);
        }
    }
}

function abrirModalNovoCliente() {
    const modal = document.getElementById('modal-novo-cliente');
    if (!modal) return;

    // Desktop: ocupa a coluna esquerda no lugar do seletor de clientes
    // (conceito de 2 grupos da tela de Pedidos) — esconde o seletor sem
    // tocar na coluna direita (form de envio), que continua do jeito que
    // já estava (ver fecharModalNovoCliente, que desfaz isso).
    if (document.body.classList.contains('lojista-desktop-mode')) {
        const seletor = document.getElementById('modal-seletor-cliente');
        if (seletor) {
            seletor.classList.remove('is-open');
            seletor.style.display = 'none';
        }
    }

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

    // Desktop: volta a mostrar o seletor de clientes na coluna esquerda
    // (ver abrirModalNovoCliente, que o esconde ao abrir "Novo Cliente"/
    // "Editar Cliente") — igual acontece ao escolher um cliente existente
    // (selecionarClienteNoSheet), o seletor nunca fica fechado de verdade
    // no desktop.
    if (document.body.classList.contains('lojista-desktop-mode')) {
        const seletor = document.getElementById('modal-seletor-cliente');
        if (seletor) {
            seletor.style.display = 'flex';
            requestAnimationFrame(() => seletor.classList.add('is-open'));
            if (typeof renderClientesSelector === 'function') {
                renderClientesSelector(document.getElementById('buscar-cliente')?.value || '');
            }
        }
    }
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
    if (typeof liberarCidadeEstadoManual === 'function') liberarCidadeEstadoManual(false);
    abrirModalNovoCliente();
}

function resetClienteForm() {
    document.querySelectorAll('#modal-novo-cliente input').forEach((input) => {
        input.value = '';
    });
    clienteEmEdicaoId = null;
    document.getElementById('novo-cliente-title').innerText = 'Novo Cliente';
    document.getElementById('btn-salvar-cliente').innerText = 'Salvar e Continuar';
    if (typeof liberarCidadeEstadoManual === 'function') liberarCidadeEstadoManual(false);
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

    // Rola de volta pro topo a cada passo (pedido do dono 2026-10-02): sem
    // isso, o scroll ficava onde o usuário parou de preencher o passo
    // anterior (geralmente lá embaixo) — o passo novo entrava já mostrando
    // o FIM da lista em vez do começo (ex: escolher veículo mostrava
    // primeiro as últimas opções).
    const conteudo = document.querySelector('#modal-envio-detalhes .envio-sheet-content');
    if (conteudo) conteudo.scrollTop = 0;
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
    resumoRevisaoAtual.cobrancaEntrega = null;
    resumoRevisaoAtual.destinoPersonalizado = false;
    document.getElementById('destino-personalizado-badge')?.classList.add('hidden');
    document.getElementById('edicao-destino-envio')?.classList.add('hidden');

    const inputDesc = document.getElementById('input-desc');
    const inputValor = document.getElementById('input-valor');
    const inputObs = document.getElementById('input-obs-envio');
    if (inputDesc) inputDesc.value = '';
    if (inputValor) inputValor.value = '';
    if (inputObs) inputObs.value = '';
    resetarCobrancaEntregaFormulario();
    selecionarTipoFluxoEnvio('entrega');

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
    ['pp', 'm', 'g', 'gg'].forEach((k) => {
        const el = document.getElementById('sz-' + k);
        if (el) el.classList.remove('active');
    });
    const alvo = document.getElementById('sz-' + String(tam || '').toLowerCase());
    if (alvo) alvo.classList.add('active');
}

function selecionarTipoFluxoEnvio(tipo) {
    tipoFluxoEnvioAtual = tipo === 'coleta_reversa' ? 'coleta_reversa' : 'entrega';
    document.getElementById('fluxo-entrega')?.classList.toggle('active', tipoFluxoEnvioAtual === 'entrega');
    document.getElementById('fluxo-coleta')?.classList.toggle('active', tipoFluxoEnvioAtual === 'coleta_reversa');
    const hint = document.getElementById('hint-tipo-fluxo');
    if (hint) hint.style.display = tipoFluxoEnvioAtual === 'coleta_reversa' ? 'block' : 'none';
}

function selecionarEmbalagem(tipo, el) {
    document.querySelectorAll('#grupo-tipo-embalagem .radio-pill').forEach((item) => item.classList.remove('active'));
    if (el) el.classList.add('active');
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

    // Coleta reversa mostra os dois códigos aqui: o de retirada (repassar ao
    // cliente) e o de devolução (o próprio lojista guarda e confirma quando
    // o entregador voltar) — textos diferentes do fluxo normal. O valor do
    // código de retirada em si é preenchido mais abaixo, junto com o resto
    // do pacoteObj (é lá que ele é gerado).
    const ehColetaReversaCard = tipoFluxoEnvioAtual === 'coleta_reversa';
    const cardRetirada = document.getElementById('codigo-retirada-card');
    const labelPedido = document.getElementById('codigo-pedido-label');
    const hintPedido = document.getElementById('codigo-pedido-hint');
    if (ehColetaReversaCard) {
        if (cardRetirada) cardRetirada.classList.remove('hidden');
        if (labelPedido) labelPedido.innerText = 'Código de confirmação de devolução';
        if (hintPedido) hintPedido.innerText = 'Guarde esse código — você mesmo confirma quando o entregador te devolver o pacote.';
    } else {
        if (cardRetirada) cardRetirada.classList.add('hidden');
        if (labelPedido) labelPedido.innerText = 'Código de confirmação de entrega';
        if (hintPedido) hintPedido.innerText = 'Repasse esse código ao destinatário. Ele será exigido do entregador para confirmar a entrega.';
    }

    if (clienteSelecionadoId) {
        const idx = clientes.findIndex((c) => c.id === clienteSelecionadoId);
        if (idx >= 0) {
            const enviosAtual = Number(clientes[idx].envios || 0) + 1;
            clientes[idx].envios = enviosAtual;
            if (enviosAtual >= 5) clientes[idx].frequente = true;

            const historico = Array.isArray(clientes[idx].historico) ? clientes[idx].historico : [];
            const desc = (resumoRevisaoAtual.descricao || document.getElementById('input-desc')?.value || '').trim();
            const servico = resumoRevisaoAtual.servico || getServicoSelecionadoAtual();
            const tamanho = getTamanhoSelecionadoAtual();
            const embalagem = getEmbalagemSelecionadaAtual();
            const totalFrete = Number.isFinite(resumoRevisaoAtual.totalFrete)
                ? resumoRevisaoAtual.totalFrete
                : parseMoedaParaNumero(document.getElementById('input-valor')?.value || 0);
            const valorConteudo = Number.isFinite(resumoRevisaoAtual.valorConteudo)
                ? resumoRevisaoAtual.valorConteudo
                : parseMoedaParaNumero(document.getElementById('input-valor')?.value || 0);
            const observacoes = (resumoRevisaoAtual.observacoes || document.getElementById('input-obs-envio')?.value || clientes[idx].obs || '').trim();
            const cobrancaEntrega = resumoRevisaoAtual.cobrancaEntrega?.ativa ? resumoRevisaoAtual.cobrancaEntrega : null;

            // Coleta reversa (troca/devolução agendada, ver ponto 3 do dono
            // 2026-09-22): mesma distância/rota calculada pra loja<->cliente,
            // só inverte QUAL endereço é retirada e qual é entrega — o
            // entregador busca no cliente e traz pra loja, em vez do
            // caminho normal.
            const ehColetaReversa = tipoFluxoEnvioAtual === 'coleta_reversa';
            const origemLojaEndereco = resumoRevisaoAtual.origem || obterEnderecoLojaTexto();
            const destinoClienteEndereco = resumoRevisaoAtual.destino || document.getElementById('card-endereco')?.innerText || '';
            const origemLojaGeo = resumoRevisaoAtual.origemGeo || null;
            const destinoClienteGeo = resumoRevisaoAtual.destinoGeo || null;
            // Coleta reversa precisa de DOIS códigos, um por perna da viagem —
            // codigoConfirmacaoEntrega já existente vira o código de
            // "devolução" (2ª perna, na loja); este novo é o de "retirada" (1ª
            // perna, com o cliente). Ver pedido do dono 2026-09-26 e
            // renderSheetRotaEntregadorConteudo/confirmarRetiradaPacoteAtual.
            const codigoConfirmacaoRetirada = ehColetaReversa ? gerarCodigoConfirmacaoEntrega() : null;
            if (ehColetaReversa) {
                const codigoRetiradaEl = document.getElementById('codigo-retirada-solicitado');
                if (codigoRetiradaEl) codigoRetiradaEl.innerText = `#${codigoConfirmacaoRetirada}`;
            }

            const pacoteObj = {
                id: pedidoId,
                codigoConfirmacaoEntrega,
                codigoConfirmacaoRetirada,
                criadoEm: Date.now(),
                descricao: desc,
                observacoes,
                cobrancaEntrega,
                tipoFluxo: ehColetaReversa ? 'coleta_reversa' : 'entrega',
                valorConteudo: Number(valorConteudo.toFixed(2)),
                valorFrete: Number(totalFrete.toFixed(2)),
                servico,
                tamanho,
                embalagem,
                veiculo: resumoRevisaoAtual.veiculo || veiculoSelecionado,
                distanciaKm: Number.isFinite(resumoRevisaoAtual.distanciaKm) ? Number(resumoRevisaoAtual.distanciaKm.toFixed(2)) : null,
                duracaoMin: Number.isFinite(resumoRevisaoAtual.duracaoMin) ? Math.round(resumoRevisaoAtual.duracaoMin) : null,
                origemEndereco: ehColetaReversa ? destinoClienteEndereco : origemLojaEndereco,
                destinoEndereco: ehColetaReversa ? origemLojaEndereco : destinoClienteEndereco,
                origemGeo: ehColetaReversa ? destinoClienteGeo : origemLojaGeo,
                destinoGeo: ehColetaReversa ? origemLojaGeo : destinoClienteGeo,
                status: 'PACOTE_NOVO',
                destinoPersonalizado: Boolean(resumoRevisaoAtual.destinoPersonalizado),
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

// BUG CORRIGIDO 2026-10-03 (achado pelo dono: CEP copiado direto do Google
// Maps, de endereço real, voltou "não encontrado" no ViaCEP — a base do
// ViaCEP tem buracos reais, não é só erro de digitação). Cidade/UF ficavam
// readonly PRA SEMPRE nesse caso, travando o cadastro: sem a API achar o
// CEP, não tinha jeito nenhum de completar o endereço manualmente.
function liberarCidadeEstadoManual(liberar) {
    const cidadeInput = document.getElementById('new-cli-cidade');
    const estadoInput = document.getElementById('new-cli-estado');
    [cidadeInput, estadoInput].forEach((el) => {
        if (!el) return;
        el.readOnly = !liberar;
        el.style.background = liberar ? '#fff' : '#f8fafc';
    });
    if (liberar) {
        if (cidadeInput) cidadeInput.placeholder = 'Digite a cidade';
        if (estadoInput) estadoInput.placeholder = 'Ex: CE';
    }
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
            liberarCidadeEstadoManual(true);
            if (!silencioso) alert('CEP não encontrado. Preencha cidade e estado manualmente.');
            return null;
        }

        liberarCidadeEstadoManual(false);
        document.getElementById('new-cli-rua').value = dados.logradouro || '';
        document.getElementById('new-cli-bairro').value = dados.bairro || '';
        document.getElementById('new-cli-cidade').value = dados.localidade || '';
        document.getElementById('new-cli-estado').value = dados.uf || '';
        document.getElementById('new-cli-num')?.focus();
        return dados;
    } catch (err) {
        liberarCidadeEstadoManual(true);
        if (!silencioso) alert('Erro ao buscar CEP. Preencha cidade e estado manualmente.');
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

function clienteTemEnvioEmRota(clienteId) {
    const cliente = clientes.find((c) => c.id === clienteId);
    if (!cliente) return false;
    const historico = Array.isArray(cliente.historico) ? cliente.historico : [];
    return historico.some((h) => normalizarStatusEnvioFiltro(h?.status || h?.statusRaw || '') === 'EM_ROTA');
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
    let geoFalhouAoSalvar = false;

    if (clienteEmEdicaoId) {
        const idx = clientes.findIndex((c) => c.id === clienteEmEdicaoId);
        if (idx >= 0) {
            const clienteAtual = clientes[idx];
            const enderecoMudou = (
                cepLimpo !== (clienteAtual.cep || '') ||
                rua.trim() !== (clienteAtual.rua || '') ||
                num.trim() !== (clienteAtual.num || '') ||
                bairro.trim() !== (clienteAtual.bairro || '') ||
                cidade.trim() !== (clienteAtual.cidade || '') ||
                ufNormalizada !== (clienteAtual.uf || '') ||
                comp.trim() !== (clienteAtual.comp || '')
            );
            // Envios já criados sempre guardam o endereço de quando foram feitos (rastreabilidade
            // — não é atualizado retroativamente). Mas enquanto o cliente tem uma entrega EM ROTA
            // agora, mudar o endereço no cadastro criaria uma divergência perigosa entre pra onde o
            // entregador está indo e o endereço "oficial" do cliente — por isso, bloqueia a edição
            // do endereço (não o resto do cadastro) até a entrega em andamento terminar.
            if (enderecoMudou && clienteTemEnvioEmRota(clienteEmEdicaoId)) {
                alert('Este cliente tem uma entrega em rota agora. O endereço não pode ser alterado até essa entrega ser concluída (envios já criados mantêm sempre o endereço de quando foram feitos).');
                return;
            }
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
            } else {
                geoFalhouAoSalvar = true;
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
        } else {
            geoFalhouAoSalvar = true;
        }
        clientes.unshift(novoCliente);
        await saveClientes();
        clienteSelecionadoId = novoCliente.id;
    }

    // Mantém o índice global (clientesGlobais) atualizado pra outras lojas
    // conseguirem achar esse mesmo cliente pelo WhatsApp — ver ponto 1 do
    // pedido do dono 2026-09-21 (Karisy cadastrada pela Nidobox não aparecia
    // pra Express Imports buscar).
    const whatsappGlobalNorm = normalizarWhatsapp(tel);
    if (whatsappGlobalNorm) {
        // BUG CORRIGIDO 2026-10-02: era .set(), que apagava uid/cadastroCompleto
        // de quem já tivesse conta ativa nesse telefone a cada salvar/editar
        // cliente (em QUALQUER loja).
        db.ref('clientesGlobais/' + whatsappGlobalNorm).update({
            nome: nome.trim(),
            whatsapp: whatsappGlobalNorm
        }).catch(() => {});

        // Perfil completo (endereço/geo) reutilizável por OUTRA loja via
        // busca exata — ver buscarClienteGlobalEExibir/database.rules.json.
        // Nunca listável, só alcançável digitando o WhatsApp exato.
        // Pedido do dono 2026-10-03: depois que o PRÓPRIO cliente confirma o
        // endereço pela conta dele (ver completarCadastroClienteRastreio,
        // confirmadoPeloCliente:true), ele vira o dono desse dado — lojista
        // continua podendo editar o registro LOCAL dele (snapshot do envio),
        // mas para de sobrescrever o universal sem querer.
        db.ref('clientesGlobaisPerfil/' + whatsappGlobalNorm).once('value').then((snap) => {
            if (snap.val()?.confirmadoPeloCliente === true) return;
            const clienteSalvo = clientes.find((c) => c.id === clienteSelecionadoId);
            const perfilGlobal = {
                nome: nome.trim(),
                whatsapp: whatsappGlobalNorm,
                cep: cepLimpo,
                rua: (rua || '').trim(),
                num: (num || '').trim(),
                bairro: (bairro || '').trim(),
                cidade: (cidade || '').trim(),
                uf: ufNormalizada,
                comp: (comp || '').trim(),
                atualizadoEm: Date.now()
            };
            if (clienteSalvo?.geo) {
                perfilGlobal.geo = clienteSalvo.geo;
                perfilGlobal.geoSig = clienteSalvo.geoSig || null;
            }
            return db.ref('clientesGlobaisPerfil/' + whatsappGlobalNorm).update(perfilGlobal);
        }).catch(() => {});
    }

    renderClientes(document.getElementById('buscar-cliente')?.value || '');
    if (typeof renderClientesSelector === 'function') {
        renderClientesSelector(document.getElementById('buscar-cliente')?.value || '');
    }

    if (geoFalhouAoSalvar) {
        alert('Cliente salvo, mas não foi possível localizar esse endereço no mapa agora (confira rua, número, bairro, cidade e CEP). O sistema vai tentar de novo automaticamente, mas por enquanto o mapa do entregador pode não abrir no lugar certo para esse cliente.');
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

    const sidebar = document.getElementById('loja-sidebar');
    if (sidebar) {
        sidebar.querySelectorAll('.loja-sidebar-link').forEach((item) => item.classList.remove('active'));
        const ativoSidebar = sidebar.querySelector(`.loja-sidebar-link[data-nav-target="${targetTela}"]`);
        if (ativoSidebar) ativoSidebar.classList.add('active');
    }
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

// ===== [DASHBOARD DESKTOP DO LOJISTA] (pedido do dono 2026-09-30) =====
// Sidebar responsiva: em telas largas (>=1024px) e só pra tipo lojista,
// troca a barra inferior mobile por uma sidebar fixa à esquerda — mesma
// navegação (navegar/views), zero lógica de negócio duplicada. Retorna se
// o estado mudou, pra quem chamou saber se precisa re-renderizar a tela
// atual (o dashboard tem HTML completamente diferente em cada modo).
function atualizarModoDesktopLoja() {
    const tipo = obterTipoUsuarioAtual();
    const deveAtivar = tipo === 'loja' && window.innerWidth >= 1024 && !!getUsuarioIdAtual();
    const jaAtivo = document.body.classList.contains('lojista-desktop-mode');
    if (deveAtivar === jaAtivo) return false;
    document.body.classList.toggle('lojista-desktop-mode', deveAtivar);
    return true;
}

function toggleLojaSidebarCompact() {
    document.body.classList.toggle('loja-sidebar-compact');
}

window.addEventListener('resize', () => {
    requestAnimationFrame(() => {
        const mudou = atualizarModoDesktopLoja();
        if (mudou && document.getElementById('view-dash-loja')?.classList.contains('active')) {
            renderizarDashboard(window.usuarioLogado || {});
        }
    });
});

// Pedido do dono 2026-09-30: no desktop, o botão da sidebar tem PRIORIDADE
// — clicar nele precisa SEMPRE trocar o conteúdo, mesmo com um sheet
// aberto por cima (antes só o X do sheet fechava, deixando o botão da
// sidebar "inútil"). Fecha genericamente qualquer overlay/sheet aberto
// via DOM (sem precisar conhecer as ~20 funções abrir/fechar
// específicas de cada um — ver core/ui-sheet.js) antes de trocar de tela.
function fecharTodosOverlaysLojaDesktop() {
    if (!document.body.classList.contains('lojista-desktop-mode')) return;
    // overlay-rota-detalhe (painel fixo da tela Rotas) também é fechado aqui
    // normalmente — ele só volta a aparecer via CSS (:has(#view-rotas.active))
    // quando a tela Rotas estiver mesmo ativa; fora dela, fica escondido
    // igual qualquer outro, senão "vazava" por cima da próxima tela.
    document.querySelectorAll('.modal-overlay, .modal-perfil-overlay, .sheet-overlay').forEach((el) => {
        el.style.display = 'none';
        el.classList.remove('show', 'is-open');
    });
}

function navegar(idTela) {
    fecharTodosOverlaysLojaDesktop();
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
        resetarPainelDetalheRotaDesktop();
    }
    if (telaAlvo === 'view-novo-envio') {
        resetarPainelDetalheEnvioDesktop();
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
// Taxa de espera/subida (pedido do dono 2026-09-25): 100% do entregador, a
// plataforma não fica com nada. Ver criarDividaLojistaEntregador/
// resolverTaxaEsperaSubidaAntesDeEntregar.
const TAXA_ESPERA_GRACE_MIN = 4;
const TAXA_ESPERA_POR_MIN = 1;
const TAXA_SUBIR_FIXA = 6;

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
    return document.querySelector('#modal-envio-detalhes #grupo-tipo-servico .radio-row.active .radio-row-label')?.innerText || 'Standard';
}

function getTamanhoSelecionadoAtual() {
    return document.querySelector('#modal-envio-detalhes #grupo-tamanho-volume .mini-radio-row.active .mini-radio-label')?.innerText || 'PP/P';
}

function getEmbalagemSelecionadaAtual() {
    const texto = document.querySelector('#modal-envio-detalhes #grupo-tipo-embalagem .radio-pill.active')?.innerText || 'Caixa';
    return texto.trim();
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

// BUG CORRIGIDO 2026-09-19: removia TODO espaço do código Pix, inclusive
// espaço que é conteúdo de verdade (ex: nome do lojista "ADRIANO VEIRASI"
// dentro do próprio código) — encolhia o valor real do campo sem atualizar o
// "tamanho declarado" daquele campo na estrutura do BR Code, desalinhando
// tudo que vem depois e quebrando o checksum (CRC16) que o banco confere
// antes de aceitar pagar. Só espaço nas PONTAS (início/fim) é formatação
// acidental de copiar/colar; espaço no meio faz parte do conteúdo e nunca
// deve ser tocado.
function normalizarCodigoPix(codigo = '') {
    return (codigo || '').toString().trim();
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
        // Aviso removido (pedido do dono 2026-10-02) — poluía o card de
        // pagamento sem agregar nada pro lojista real; o escape hatch de
        // simular pagamento aprovado em ambiente teste continua intacto
        // (ver irParaPagamentoRota), só o texto deste aviso que some.
        aviso.className = 'rota-pix-env';
        aviso.innerText = '';
        return;
    }

    if (mercadoPagoAmbienteAtual === 'producao') {
        // Aviso removido (pedido do dono 2026-10-02) — mesma lógica do aviso
        // de ambiente TESTE acima: só poluía o card, nada de funcional muda.
        aviso.className = 'rota-pix-env';
        aviso.innerText = '';
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

// ===================== [COMISSÃO DA PLATAFORMA] =====================
// Retida sem elemento visual novo, por pedido do dono (2026-09-19): o lojista
// sempre vê/paga o valor cheio (totalFrete, sem mudança nenhuma nas telas
// dele); o entregador só enxerga o valor líquido (valorFrete - taxa) em
// qualquer lugar que hoje mostra o valor da rota pra ele — marketplace,
// cards de rota, "a receber", e é esse valor líquido que realmente cai na
// carteira dele quando a rota conclui. Nenhum dos dois vê o valor do outro
// nem quanto a plataforma retém.
//
// Faixas definidas pelo dono (valor da corrida → taxa fixa):
//   até R$5 → R$1,00 | R$5–15 → R$1,50 | R$15–25 → R$2,00 | acima de R$25 → R$2,50
// Proteção de piso por cima das faixas: o entregador nunca deve ficar abaixo
// de R$1,00/km depois do corte — testamos com o dono que uma faixa fixa
// sozinha sempre tem um "começo de faixa" que fura esse piso, então a taxa
// alvo da faixa é reduzida automaticamente (nunca aumentada) sempre que
// aplicá-la inteira derrubaria o entregador abaixo do piso.
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

// distanciaKm é opcional de propósito: em telas que ainda não têm a
// distância à mão, a proteção de piso simplesmente não se aplica ali (fica
// só a faixa alvo) — mas o crédito real na carteira (Cloud Function
// /creditar-rota-finalizada, backend/functions/index.js) sempre passa a
// distância, que é onde o piso realmente importa.
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

// cidadeEsperada/ufEsperada são opcionais — quando informados, o resultado é
// validado com a mesma checagem usada em geocodificarPorCampos (não aceita
// silenciosamente um endereço em cidade/UF diferente da esperada).
async function geocodificarEndereco(endereco, cidadeEsperada = '', ufEsperada = '') {
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
        const primeiro = resultado?.results?.[0] || null;
        const loc = primeiro?.geometry?.location;
        if (resultado?.status === 'OK' && loc) {
            const geo = { lat: Number(loc.lat()), lon: Number(loc.lng()) };
            if (!geoNoBrasil(geo)) {
                setUltimoErroRota('Geocode por endereco retornou coordenada fora do Brasil.', { status: resultado?.status, textoBase, geo });
                return null;
            }
            if (!geocodeBateComCidadeUf(primeiro, cidadeEsperada, ufEsperada)) {
                setUltimoErroRota('Geocode por endereco retornou local divergente do esperado.', {
                    textoBase,
                    cidadeEsperada,
                    ufEsperada,
                    formatted: primeiro?.formatted_address || null
                });
                return null;
            }
            return geo;
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
    return await geocodificarEndereco(enderecoCalculo, campos.cidade, campos.estado);
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

// ===== [ENDEREÇO PERSONALIZADO POR ENVIO] (2026-09-25) =====
// Deixa o lojista entregar num endereço diferente do cadastro do cliente,
// só pra este envio (pedido do dono: "e se o cliente quiser entregar em
// outro endereço?"). NÃO toca no cadastro do cliente — só sobrescreve
// resumoRevisaoAtual.destino/destinoGeo, que é exatamente o que
// garantirEstimativaAtual() já usa quando destinoGeo está preenchido (pula
// o geocode do cliente, ver ali embaixo). Isso garante que a distância e o
// preço saem da MESMA fórmula/regras de sempre (calcularFreteEstimado,
// R$1,10/km Standard etc.) — só o ENDEREÇO em si é diferente.
function abrirEdicaoDestinoEnvio() {
    const cliente = getClienteById(clienteSelecionadoId);
    const campos = extrairCamposEnderecoCliente(cliente || {});
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('dest-edit-rua', campos.rua);
    setVal('dest-edit-num', campos.num);
    setVal('dest-edit-bairro', campos.bairro);
    setVal('dest-edit-comp', campos.comp);
    setVal('dest-edit-cidade', campos.cidade);
    setVal('dest-edit-uf', campos.estado);
    setVal('dest-edit-cep', campos.cep);
    document.getElementById('edicao-destino-envio')?.classList.remove('hidden');
}

function cancelarEdicaoDestinoEnvio() {
    document.getElementById('edicao-destino-envio')?.classList.add('hidden');
}

async function salvarEdicaoDestinoEnvio() {
    const campos = {
        rua: (document.getElementById('dest-edit-rua')?.value || '').trim(),
        num: (document.getElementById('dest-edit-num')?.value || '').trim(),
        bairro: (document.getElementById('dest-edit-bairro')?.value || '').trim(),
        comp: (document.getElementById('dest-edit-comp')?.value || '').trim(),
        cidade: (document.getElementById('dest-edit-cidade')?.value || '').trim(),
        estado: (document.getElementById('dest-edit-uf')?.value || '').trim(),
        cep: (document.getElementById('dest-edit-cep')?.value || '').trim()
    };
    if (!campos.rua || !campos.num || !campos.cidade) {
        alert('Preencha ao menos rua, número e cidade.');
        return;
    }

    const btn = document.getElementById('dest-edit-salvar-btn');
    const textoOriginalBtn = btn?.innerText;
    if (btn) { btn.disabled = true; btn.innerText = 'Calculando...'; }

    try {
        const geo = await geocodificarPorCampos(campos);
        if (!geo) {
            alert('Não conseguimos localizar esse endereço. Confira os dados e tente de novo.');
            return;
        }

        const enderecoFormatado = montarEnderecoCliente(campos);
        resumoRevisaoAtual.destino = enderecoFormatado;
        resumoRevisaoAtual.destinoGeo = geo;
        resumoRevisaoAtual.destinoPersonalizado = true;

        const enderecoEl = document.getElementById('card-endereco');
        if (enderecoEl) enderecoEl.innerText = enderecoFormatado;
        document.getElementById('destino-personalizado-badge')?.classList.remove('hidden');

        cancelarEdicaoDestinoEnvio();
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = textoOriginalBtn || 'Salvar endereço deste envio'; }
    }
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

function exibirSkeletonVeiculos() {
    document.querySelectorAll('#modal-envio-step-2 .veiculo-item').forEach((card) => card.classList.add('skeleton'));
}

function ocultarSkeletonVeiculos() {
    document.querySelectorAll('#modal-envio-step-2 .veiculo-item').forEach((card) => card.classList.remove('skeleton'));
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

// ===================== [COBRANCA NA ENTREGA] =====================
// Permite ao lojista marcar, na criacao do envio, que o entregador deve
// cobrar o cliente (dinheiro e/ou Pix) no ato da entrega e repassar o
// valor depois. Ver memoria project-flexa-cobranca-entrega-dinheiro.
function definirCobrancaEntregaAtiva(ativa) {
    const boxNao = document.getElementById('cobranca-entrega-nao');
    const boxSim = document.getElementById('cobranca-entrega-sim');
    const grupoFormas = document.getElementById('grupo-cobranca-entrega-formas');
    if (boxNao) boxNao.classList.toggle('active', !ativa);
    if (boxSim) boxSim.classList.toggle('active', ativa);
    if (grupoFormas) grupoFormas.style.display = ativa ? 'flex' : 'none';
}

function alternarFormaCobrancaEntrega(forma, el) {
    if (!el) return;
    const outroId = forma === 'dinheiro' ? 'cobranca-forma-pix' : 'cobranca-forma-dinheiro';
    const outro = document.getElementById(outroId);
    const estaAtivo = el.classList.contains('active');
    // nao deixa desmarcar as duas formas ao mesmo tempo — precisa sobrar ao menos uma
    if (estaAtivo && !(outro && outro.classList.contains('active'))) return;
    el.classList.toggle('active');
}

function resetarCobrancaEntregaFormulario() {
    definirCobrancaEntregaAtiva(false);
    document.getElementById('cobranca-forma-dinheiro')?.classList.add('active');
    document.getElementById('cobranca-forma-pix')?.classList.add('active');
}

function lerCobrancaEntregaDoFormulario() {
    const ativa = Boolean(document.getElementById('cobranca-entrega-sim')?.classList.contains('active'));
    if (!ativa) return { ativa: false, formasAceitas: [], valor: 0, status: 'pendente' };

    const formasAceitas = [];
    if (document.getElementById('cobranca-forma-dinheiro')?.classList.contains('active')) formasAceitas.push('dinheiro');
    if (document.getElementById('cobranca-forma-pix')?.classList.contains('active')) formasAceitas.push('pix');

    const valor = parseMoedaParaNumero(document.getElementById('input-valor')?.value || 0);
    return {
        ativa: true,
        formasAceitas: formasAceitas.length ? formasAceitas : ['dinheiro', 'pix'],
        valor: Number.isFinite(valor) ? Number(valor.toFixed(2)) : 0,
        status: 'pendente'
    };
}

async function irParaVeiculos() {
    const inputDesc = (document.getElementById('input-desc')?.value || '').trim();
    const inputValorConteudo = parseMoedaParaNumero(document.getElementById('input-valor')?.value || 0);
    if (!Number.isFinite(inputValorConteudo) || inputValorConteudo <= 0) {
        alert('Informe o Valor Total do envio.');
        document.getElementById('input-valor')?.focus();
        return;
    }
    resumoRevisaoAtual.descricao = inputDesc;
    resumoRevisaoAtual.valorConteudo = Number.isFinite(inputValorConteudo) ? inputValorConteudo : 0;
    resumoRevisaoAtual.observacoes = (document.getElementById('input-obs-envio')?.value || '').trim();
    resumoRevisaoAtual.cobrancaEntrega = lerCobrancaEntregaDoFormulario();

    setModalEnvioStep(2);
    exibirSkeletonVeiculos();
    try {
        await garantirEstimativaAtual();
        atualizarPrecoEstimadoAtual();
    } finally {
        ocultarSkeletonVeiculos();
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function voltarParaDetalhes() {
    setModalEnvioStep(1);
}

// Revisao com distancia/tempo e valor estimado
async function irParaRevisao() {
    const nome = document.getElementById('card-nome').innerText;
    const enderecoDestinoExibicao = document.getElementById('card-endereco').innerText;
    const servico = getServicoSelecionadoAtual();
    const tamanho = getTamanhoSelecionadoAtual();
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
        freteTesteOverride: resumoRevisaoAtual.freteTesteOverride || null,
        // Bug encontrado 2026-08-16: esse objeto era recriado do zero aqui e
        // esses dois campos (setados 2 passos atrás, em irParaVeiculos) ficavam
        // pra trás — cobrancaEntrega virava undefined silenciosamente (sem
        // fallback nenhum, ao contrário de valorConteudo, que só "funcionava"
        // por acidente lendo direto do input escondido no DOM). Confirmado com
        // os logs de diagnóstico no console (ver lerCobrancaEntregaDoFormulario).
        valorConteudo: resumoRevisaoAtual.valorConteudo,
        cobrancaEntrega: resumoRevisaoAtual.cobrancaEntrega || null
    };
    // BUG CORRIGIDO 2026-09-23: essa tela mostrava sempre loja=origem e
    // cliente=destino, mesmo em coleta reversa — só o pacote final (depois
    // de confirmado) vinha com os endereços trocados. Agora a revisão já
    // mostra igual vai ficar de verdade.
    const ehColetaReversaRevisao = tipoFluxoEnvioAtual === 'coleta_reversa';
    const revEndLabel = document.getElementById('rev-end-label');
    const revOrigemLabel = document.getElementById('rev-origem-label');
    if (revEndLabel) revEndLabel.innerText = ehColetaReversaRevisao ? 'Retirada (origem)' : 'Destino';
    if (revOrigemLabel) revOrigemLabel.innerText = ehColetaReversaRevisao ? 'Entrega na loja' : 'Origem';

    document.getElementById('rev-nome').innerText = nome;
    document.getElementById('rev-end').innerText = enderecoDestinoExibicao;
    document.getElementById('rev-servico').innerText = servico;
    document.getElementById('rev-tamanho').innerText = `Pacote ${tamanho} - ${veiculoSelecionado}`;
    document.getElementById('rev-total').innerText = precoParaMoeda(totalFrete);
    const revDist = document.getElementById('rev-distancia'); if (revDist) revDist.innerText = formatarDistancia(distanciaKm);
    const revTempo = document.getElementById('rev-tempo'); if (revTempo) revTempo.innerText = formatarDuracao(duracaoMin);
    const revOrigem = document.getElementById('rev-origem');
    if (revOrigem) revOrigem.innerText = enderecoOrigem || 'Defina o endereco da loja no Perfil';
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
    const whatsapp = normalizarWhatsapp(document.getElementById('whatsapp-login')?.value || '');
    const senha = document.getElementById('pass-login').value;

    if (!whatsapp || !senha) return alert('Preencha WhatsApp e senha!');

    try {
        // Firebase Auth só loga por e-mail — o WhatsApp é só a "chave" que o
        // usuário digita; por baixo dos panos resolve pro e-mail cadastrado
        // (ver telefoneParaEmail, escrito em cadastrarRealComTipo).
        const email = await db.ref('telefoneParaEmail/' + whatsapp).once('value').then((s) => s.val());
        if (!email) {
            alert('Não encontramos uma conta com esse número de WhatsApp.');
            return;
        }
        const cred = await auth.signInWithEmailAndPassword(email, senha);
        const snapshot = await db.ref('usuarios/' + cred.user.uid).once('value');
        const dadosUser = snapshot.val();

        if (!dadosUser) {
            alert('Conta sem perfil no banco. Fale com o suporte.');
            return;
        }

        // BUG CORRIGIDO 2026-09-20: até aqui, login comparava o tipo real da
        // conta (dadosUser.tipo) contra tipoCadastroSelecionado — uma variável
        // que só fazia sentido na tela antiga (view-inicio), onde a pessoa
        // escolhia "Enviar pacotes" ou "Fazer entregas" ANTES de chegar no
        // login. Como essa tela não existe mais (login agora é a primeira
        // tela, sem pré-seleção de tipo), tipoCadastroSelecionado ficava
        // parado no valor padrão 'loja' e barrava todo login de entregador
        // com "Essa conta é de entregador. Entre pela opção Fazer entregas" —
        // mesmo a conta sendo, de fato, de entregador. O tipo da conta já
        // vem do banco (dadosUser.tipo) e é isso que decide o dashboard logo
        // abaixo (telaInicialPorTipoUsuario) — não precisa mais desse check.
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
        // Removido 2026-09-18: essa linha só escrevia, nunca era lida por
        // nada (a restauração de sessão já usa firebase.auth().onAuthStateChanged
        // + busca fresca em usuarios/{uid}, não este cache). Depois de muitos
        // testes, o cadastro cresceu o suficiente pra passar do limite do
        // localStorage — e como isso quebrava ANTES de iniciarListenerNotificacoes()
        // logo abaixo, sem try/catch, o login inteiro abortava em cascata:
        // sem listener de notificação, sem navegar pra tela certa, nada.
        // Explica os bugs relatados pelo dono 2026-09-18: notificações
        // travadas em dados antigos e "erro ao entrar" toda hora.

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

// Login passou a ser por WhatsApp, mas a recuperação de senha continua por
// e-mail (é assim que o Firebase Auth manda o link, e é o motivo de ainda
// pedirmos e-mail no cadastro mesmo o dia a dia sendo só com o WhatsApp).
async function recuperarSenhaReal() {
    const email = (document.getElementById('input-email-recuperar')?.value || '').trim();
    if (!email) return alert('Informe o e-mail cadastrado na conta.');
    try {
        await auth.sendPasswordResetEmail(email);
        alert('Link de redefinição enviado para o seu e-mail.');
        navegar('view-auth');
    } catch (error) {
        alert('Não foi possível enviar o link: ' + error.message);
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
        atualizarTopoAdmin(dadosUser.nome, dadosUser.email || email);
        mostrarTelaAdminDashboard();
        await renderDashboardMaster();
        const splash = document.getElementById('splash-screen');
        finalizarSplash(splash);
    } catch (err) {
        alert('Falha no login admin: ' + err.message);
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

    if (modoRastreioPublico) {
        if (tabbar) tabbar.style.display = 'none';
        exibirTelaRastreioPublico(tokenRastreioAtual);
        finalizarSplash(splash);
        return;
    }

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

                    // Segurança: /admin só pode ser aberto por conta master.
                    // Antes, bastava a URL conter "/admin" (modoAdmin=true) pra
                    // cair direto no painel com QUALQUER sessão já logada —
                    // um entregador ou lojista comum que abrisse /#/admin com
                    // a própria sessão ativa entrava no painel de administrador.
                    if (modoAdmin && tipo !== 'master') {
                        modoAdmin = false;
                        document.body.classList.remove('admin-mode');
                        firebase.auth().signOut().catch(() => {});
                        alert('Esta conta não tem permissão de administrador.');
                        mostrarTelaAdminLogin();
                        if (tabbar) tabbar.style.display = 'none';
                        finalizarSplash(splash);
                        return;
                    }

                    if (tipo === 'master') {
                        modoAdmin = true;
                        document.body.classList.add('admin-mode');
                        atualizarTopoAdmin(userData.nome, userData.email || user.email || '--');
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

        // Mudanca 2026-09-20: antes caia sempre numa tela de "escolha seu
        // perfil" (marketing + 2 botoes), tanto na primeira visita quanto
        // depois de um logout — pra quem ja tem conta isso nao fazia sentido.
        // Agora vai direto pro login/cadastro; quem nao tem conta escolhe o
        // perfil (lojista/entregador) dentro da propria aba "Cadastre-se".
        navegar('view-auth');
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

    atualizarModoDesktopLoja();
    const modoDesktop = document.body.classList.contains('lojista-desktop-mode');

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

        const realRota = montarTimelineRealRota(pacotes, totalPacotes, 'home-route-dot');
        timelineHtml = realRota.html;
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

    if (modoDesktop) {
        container.innerHTML = montarDashboardDesktopLojaHtml({
            user, saldoUser, localColeta, rotas, envios, rotaAtual, rotasRecentes,
            progressoPctRota, distanciaTotal, duracaoTotal, cidadeDestino, statusRotaVisual, timelineHtml
        });
        sincronizarSidebarLojaConta(user);
        if (typeof lucide !== 'undefined') lucide.createIcons();
        iniciarTimerFlashEntregador();
    } else {
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

            <div id="dividas-entregador-lojista-home" class="dividas-entregador-card hidden"></div>

            <div id="banner-lojista-home" class="rastreio-pub-banners hidden"></div>

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
        carregarBannersPorPublico('lojista', 'banner-lojista-home');
        carregarDividasEntregadorLojistaHome();
    }

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

function sincronizarSidebarLojaConta(user) {
    const avatar = document.getElementById('loja-sidebar-avatar');
    const nomeEl = document.getElementById('loja-sidebar-nome');
    const nome = (user?.loja || user?.nome || 'Loja').toString().trim() || 'Loja';
    if (nomeEl) nomeEl.textContent = nome;
    if (avatar) aplicarFotoComPlaceholder(avatar, user?.foto || user?.logo || '');
}

// ===== [DASHBOARD DESKTOP DO LOJISTA — CONTEÚDO] (pedido do dono 2026-09-30) =====
// Reaproveita os dados já calculados por renderizarDashboard (rotas, envios,
// rotaAtual etc) — só ADICIONA as agregações novas que a versão mobile nunca
// precisou: rotas Flash em andamento com prazo, cliente mais ativo, clientes
// inativos há +3 meses e entregador com mais aceites. Layout aprovado no
// mockup (Artifact "Dashboard Desktop Lojista Flex").
function montarDashboardDesktopLojaHtml({ user, saldoUser, localColeta, rotas, envios, rotaAtual, rotasRecentes, progressoPctRota, distanciaTotal, duracaoTotal, cidadeDestino, statusRotaVisual }) {
    const nomeLoja = (user?.loja || user?.nome || 'Loja').toString().trim() || 'Loja';

    const rotasEmAndamentoCount = rotas.filter((r) => {
        const st = normalizarStatusRotaFiltro(r?.status || r?.pagamentoStatus || 'CRIADA');
        return st === 'EM_ROTA' || st === 'BUSCANDO';
    }).length;

    const statusBreakdown = { pendente: 0, emRota: 0, concluido: 0 };
    envios.forEach((e) => {
        if (e.categoria === 'PACOTE_NOVO') statusBreakdown.pendente += 1;
        else if (e.categoria === 'EM_ROTA' || e.categoria === 'BUSCANDO') statusBreakdown.emRota += 1;
        else if (e.categoria === 'ENTREGUE') statusBreakdown.concluido += 1;
    });

    // Rotas Flash em andamento — mesma trava de prazo de 2h já usada no lado
    // do entregador (FLASH_PRAZO_MS/pacoteEhFlashEntregador), só que aqui é
    // visão do lojista: quais das SUAS rotas ativas têm Flash e quanto tempo
    // falta, pra ele acompanhar risco de atraso mesmo sem falar com o entregador.
    const rotasFlashAtivas = [];
    rotas.forEach((rota) => {
        const statusNorm = normalizarStatusRotaFiltro(rota?.status || rota?.pagamentoStatus || 'CRIADA');
        if (statusNorm !== 'EM_ROTA') return;
        const pacotesRota = getPacotesDaRota(rota);
        if (!pacotesRota.some((p) => pacoteEhFlashEntregador(p))) return;
        const aceitoEm = Number(rota?.aceitoEm || rota?.atualizadoEm || rota?.criadoEm || Date.now());
        rotasFlashAtivas.push({
            id: rota.id,
            entregadorNome: (rota?.entregadorNome || 'Entregador').toString(),
            prazoFlashAte: aceitoEm + FLASH_PRAZO_MS
        });
    });
    rotasFlashAtivas.sort((a, b) => a.prazoFlashAte - b.prazoFlashAte);

    // Cliente mais ativo / clientes inativos há +3 meses.
    const statsClientes = clientes
        .map((c) => {
            const historico = Array.isArray(c.historico) ? c.historico : [];
            if (!historico.length) return null;
            const totalGasto = historico.reduce((acc, h) => acc + (Number.isFinite(Number(h.valorFrete)) ? Number(h.valorFrete) : parseMoedaParaNumero(h.valor || 0)), 0);
            const maisRecente = Math.max(...historico.map((h) => Number(h.criadoEm || 0)));
            return { nome: (c.nome || 'Cliente').toString(), totalGasto, maisRecente };
        })
        .filter(Boolean);
    const clienteMaisAtivo = statsClientes.length
        ? statsClientes.reduce((max, cur) => (cur.totalGasto > (max?.totalGasto || 0) ? cur : max), null)
        : null;
    const TRES_MESES_MS = 90 * 24 * 60 * 60 * 1000;
    const agora = Date.now();
    const clientesInativosCount = statsClientes.filter((c) => (agora - c.maisRecente) > TRES_MESES_MS).length;

    // Entregador com mais rotas aceitas (histórico completo de rotas, não só as ativas).
    const aceitesPorEntregador = new Map();
    rotas.forEach((rota) => {
        const entId = rota?.entregadorId || rota?.aceitoPor;
        if (!entId) return;
        const atual = aceitesPorEntregador.get(entId) || { nome: (rota?.entregadorNome || 'Entregador').toString(), count: 0 };
        atual.count += 1;
        aceitesPorEntregador.set(entId, atual);
    });
    const entregadorMaisAtivo = aceitesPorEntregador.size
        ? [...aceitesPorEntregador.values()].reduce((max, cur) => (cur.count > (max?.count || 0) ? cur : max), null)
        : null;

    const flashHtml = rotasFlashAtivas.length
        ? rotasFlashAtivas.map((r) => `
            <div class="loja-flash-card">
                <div class="loja-flash-card-top">
                    <span class="entregas-flash-badge">⚡ FLASH</span>
                    <span class="entregas-flash-timer" data-flash-deadline="${r.prazoFlashAte}">--</span>
                </div>
                <div class="loja-flash-card-rota">Rota #${escaparHtmlMarketplace(r.id)}</div>
                <div class="loja-flash-card-entregador">Entregador: ${escaparHtmlMarketplace(r.entregadorNome)}</div>
            </div>
        `).join('')
        : '<div class="loja-flash-empty">Nenhuma rota Flash ativa no momento.</div>';

    const rotasRecentesHtml = rotasRecentes.length
        ? rotasRecentes.map((rota) => {
            const statusNorm = normalizarStatusRotaFiltro(rota?.status || rota?.pagamentoStatus || 'CRIADA');
            const statusVisual = getStatusVisualRota(statusNorm);
            const qtdPacotes = getPacotesDaRota(rota).length || Number(rota?.quantidade || 0);
            const dataTxt = rota?.atualizadoEm ? new Date(rota.atualizadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--';
            return `
                <button type="button" class="loja-desktop-rota-row" onclick="abrirModalDetalheRota('${String(rota.id).replace(/'/g, "\\'")}')">
                    <div>
                        <div class="loja-desktop-rota-id">Rota #${escaparHtmlMarketplace(String(rota.id))}</div>
                        <div class="loja-desktop-rota-meta">${qtdPacotes} pacote(s) · ${dataTxt}</div>
                    </div>
                    <span class="loja-desktop-status-pill ${escaparHtmlMarketplace(statusVisual.className)}">${escaparHtmlMarketplace(statusVisual.label)}</span>
                </button>
            `;
        }).join('')
        : '<div class="loja-desktop-empty">Nenhuma rota recente para exibir.</div>';

    const emRotaHtml = rotaAtual
        ? `
            <div class="loja-desktop-card">
                <div class="loja-desktop-card-head">
                    <div class="loja-desktop-card-title">Em rota agora</div>
                    <span class="loja-desktop-status-pill ${escaparHtmlMarketplace(statusRotaVisual.className)}">${escaparHtmlMarketplace(statusRotaVisual.label)}</span>
                </div>
                <div class="loja-desktop-track">
                    <div class="loja-desktop-track-fill" style="width:${progressoPctRota}%;"></div>
                </div>
                <div class="loja-desktop-track-foot">
                    <span>${escaparHtmlMarketplace(localColeta)} → ${escaparHtmlMarketplace(cidadeDestino)}</span>
                    <span>${formatarDistancia(distanciaTotal)} · ${formatarDuracao(duracaoTotal)} · ${progressoPctRota}% concluído</span>
                </div>
            </div>
        `
        : '';

    return `
        <div class="loja-desktop-topbar">
            <div>
                <div class="loja-desktop-greeting">Olá, ${escaparHtmlMarketplace(nomeLoja)}</div>
                <div class="loja-desktop-subgreeting">${escaparHtmlMarketplace(localColeta)}</div>
            </div>
            <div class="loja-desktop-saldo-pill">${precoParaMoeda(saldoUser)}</div>
        </div>

        <div class="loja-desktop-content">

            <div class="loja-desktop-metrics">
                <div class="loja-desktop-metric-card">
                    <div class="loja-desktop-metric-icon icon-orange"><i data-lucide="wallet" size="17"></i></div>
                    <div class="loja-desktop-metric-label">Saldo disponível</div>
                    <div class="loja-desktop-metric-value">${precoParaMoeda(saldoUser)}</div>
                </div>
                <div class="loja-desktop-metric-card">
                    <div class="loja-desktop-metric-icon icon-blue"><i data-lucide="route" size="17"></i></div>
                    <div class="loja-desktop-metric-label">Rotas em andamento</div>
                    <div class="loja-desktop-metric-value">${rotasEmAndamentoCount}</div>
                </div>
                <div class="loja-desktop-metric-card">
                    <div class="loja-desktop-metric-icon icon-amber"><i data-lucide="package" size="17"></i></div>
                    <div class="loja-desktop-metric-label">Envios pendentes</div>
                    <div class="loja-desktop-metric-value">${statusBreakdown.pendente}</div>
                </div>
            </div>

            <div class="loja-desktop-flash-section">
                <div class="loja-desktop-flash-head">
                    <i data-lucide="zap" size="16" style="color:#ef4444;"></i>
                    <div class="loja-desktop-card-title">Rotas Flash em andamento</div>
                    <span class="loja-desktop-flash-badge">PRAZO DE 2H</span>
                </div>
                <div class="loja-desktop-flash-grid">${flashHtml}</div>
            </div>

            <div class="loja-desktop-grid-2col">
                <div class="loja-desktop-col">
                    ${emRotaHtml}
                    <div class="loja-desktop-card">
                        <div class="loja-desktop-card-title" style="margin-bottom:12px;">Rotas recentes</div>
                        ${rotasRecentesHtml}
                    </div>
                </div>
                <div class="loja-desktop-col">
                    <div class="loja-desktop-card">
                        <div class="loja-desktop-card-title" style="margin-bottom:12px;">Envios por status</div>
                        <div class="loja-desktop-status-row"><span class="loja-desktop-dot dot-amber"></span><span class="loja-desktop-status-label">Pendente</span><strong>${statusBreakdown.pendente}</strong></div>
                        <div class="loja-desktop-status-row"><span class="loja-desktop-dot dot-blue"></span><span class="loja-desktop-status-label">Em rota</span><strong>${statusBreakdown.emRota}</strong></div>
                        <div class="loja-desktop-status-row"><span class="loja-desktop-dot dot-green"></span><span class="loja-desktop-status-label">Concluído</span><strong>${statusBreakdown.concluido}</strong></div>
                    </div>
                    <div class="loja-desktop-card loja-desktop-acoes">
                        <div class="loja-desktop-card-title">Ações rápidas</div>
                        <button type="button" class="loja-desktop-btn-primary" onclick="navegar('view-rotas')">+ Nova rota</button>
                        <button type="button" class="loja-desktop-btn-outline" onclick="abrirSeletorCliente()">+ Novo envio</button>
                    </div>
                </div>
            </div>

            <div class="loja-desktop-insights">
                <div class="loja-desktop-insight-card">
                    <div class="loja-desktop-insight-head"><div class="loja-desktop-insight-icon icon-orange"><i data-lucide="star" size="15"></i></div><span>Cliente mais ativo</span></div>
                    ${clienteMaisAtivo
                        ? `<div class="loja-desktop-insight-main">${escaparHtmlMarketplace(clienteMaisAtivo.nome)}</div><div class="loja-desktop-insight-sub">${precoParaMoeda(clienteMaisAtivo.totalGasto)} em pedidos (total)</div>`
                        : '<div class="loja-desktop-insight-sub">Sem dados suficientes ainda.</div>'}
                </div>
                <div class="loja-desktop-insight-card">
                    <div class="loja-desktop-insight-head"><div class="loja-desktop-insight-icon icon-red"><i data-lucide="user-x" size="15"></i></div><span>Clientes inativos (+3 meses)</span></div>
                    <div class="loja-desktop-insight-main">${clientesInativosCount} cliente${clientesInativosCount === 1 ? '' : 's'}</div>
                </div>
                <div class="loja-desktop-insight-card">
                    <div class="loja-desktop-insight-head"><div class="loja-desktop-insight-icon icon-blue"><i data-lucide="bike" size="15"></i></div><span>Entregador mais ativo</span></div>
                    ${entregadorMaisAtivo
                        ? `<div class="loja-desktop-insight-main">${escaparHtmlMarketplace(entregadorMaisAtivo.nome)}</div><div class="loja-desktop-insight-sub">${entregadorMaisAtivo.count} rota(s) aceita(s)</div>`
                        : '<div class="loja-desktop-insight-sub">Sem dados suficientes ainda.</div>'}
                </div>
            </div>

        </div>
    `;
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
                origemGeo: h?.origemGeo || null,
                destinoGeo: h?.destinoGeo || null,
                cepDestino: h?.cepDestino || '',
                bairroDestino: h?.bairroDestino || '',
                numero: h?.numero || '',
                complemento: h?.complemento || '',
                status: (h?.status || 'PENDENTE').toUpperCase(),
                criadoEm: Number(h?.criadoEm || Date.now()),
                cobrancaEntrega: h?.cobrancaEntrega || null,
                devolucaoStatus: h?.devolucaoStatus || null,
                motivoDevolucao: h?.motivoDevolucao || null,
                motivoDevolucaoDetalhe: h?.motivoDevolucaoDetalhe || null,
                codigoConfirmacaoDevolucao: h?.codigoConfirmacaoDevolucao || null,
                // FALTAVA (pedido do dono 2026-10-02: "o link copiado manda
                // um código e o lojista recebe outro totalmente diferente")
                // — sem isso, renderRotaDetalhePagina sempre lia
                // p.codigoConfirmacaoEntrega como undefined, e o botão
                // "Copiar link"/"Enviar no WhatsApp" nunca incluía nenhum
                // código na mensagem pro cliente.
                codigoConfirmacaoEntrega: h?.codigoConfirmacaoEntrega || null,
                codigoConfirmacaoRetirada: h?.codigoConfirmacaoRetirada || null
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
                    origemGeo: p.origemGeo || null,
                    destinoGeo: p.destinoGeo || null,
                    cepDestino: p.cepDestino || '',
                    bairroDestino: p.bairroDestino || '',
                    numero: p.numero || '',
                    complemento: p.complemento || '',
                    status: (p.status || p.statusRaw || 'PACOTE_NOVO').toUpperCase(),
                    criadoEm: Number(p.criadoEm || Date.now()),
                    cobrancaEntrega: p.cobrancaEntrega || null,
                    devolucaoStatus: p.devolucaoStatus || null,
                    motivoDevolucao: p.motivoDevolucao || null,
                    motivoDevolucaoDetalhe: p.motivoDevolucaoDetalhe || null,
                    codigoConfirmacaoDevolucao: p.codigoConfirmacaoDevolucao || null,
                    codigoConfirmacaoEntrega: p.codigoConfirmacaoEntrega || null,
                    codigoConfirmacaoRetirada: p.codigoConfirmacaoRetirada || null
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
        // BUG CORRIGIDO 2026-10-02: lia 'pacotes/{uid}' (raiz), um caminho que
        // NINGUÉM grava — confirmarEnvioFinal/persistirEntregaPacoteAtual (e
        // todo o resto do app) sempre gravaram em 'usuarios/{uid}/pacotes'.
        // Resultado prático: window.pacotesRaizCache[uid] ficava sempre {}
        // depois de qualquer reload, fazendo o merge historico+pacotes em
        // coletarEnviosDaBase/montarMapaEnviosPorId rodar só com o lado
        // antigo (historico) pra sempre — o lado "modelo novo" nunca
        // existia de verdade na tela.
        const snap = await db.ref(`usuarios/${uid}/pacotes`).once('value');
        if (!window.pacotesRaizCache) window.pacotesRaizCache = {};
        window.pacotesRaizCache[uid] = snap.exists() ? (snap.val() || {}) : {};
    } catch (err) {
        console.warn('Falha ao carregar pacotes raiz', err);
    }
}

// Faixa de peso de cada tamanho — mesmo texto usado nos rótulos do seletor
// "Tamanho do Volume" no Novo Envio (index.html #grupo-tamanho-volume), só
// espelhado aqui pro entregador ver a mesma informação no detalhe da corrida.
const FAIXA_PESO_TAMANHO_MKT = { 'PP/P': 'até 2kg', 'M': 'até 5kg', 'G': 'até 10kg', 'GG': 'acima de 10kg' };
const RANK_TAMANHO_MKT = { 'PP/P': 1, 'M': 2, 'G': 3, 'GG': 4 };
function obterTamanhoMaiorPacotesMarketplace(pacotes) {
    let maior = 'PP/P';
    let maiorRank = 1;
    (pacotes || []).forEach((p) => {
        const t = (p?.tamanho || 'PP/P').toString().trim() || 'PP/P';
        const r = RANK_TAMANHO_MKT[t] || 1;
        if (r > maiorRank) { maiorRank = r; maior = t; }
    });
    return maior;
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
                bairro: (h?.bairroDestino || cliente?.bairro || '').toString().trim(),
                destino: (h?.destinoEndereco || montarEnderecoParaCalculo(cliente, cliente?.endereco || '') || '').toString().trim(),
                servico: (h?.servico || 'Standard').toString().trim(),
                status: normalizarStatusPacoteEntrega(h?.status || 'PENDENTE'),
                distanciaKm: Number.isFinite(Number(h?.distanciaKm)) ? Number(h.distanciaKm) : 0,
                duracaoMin: Number.isFinite(Number(h?.duracaoMin)) ? Number(h.duracaoMin) : 0,
                valorFrete: Number.isFinite(Number(h?.valorFrete)) ? Number(h.valorFrete) : parseMoedaParaNumero(h?.valor || 0),
                tamanho: (h?.tamanho || '').toString().trim(),
                embalagem: (h?.embalagem || '').toString().trim(),
                veiculo: (h?.veiculo || '').toString().trim()
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
                    bairro: (p.bairroDestino || '').toString().trim(),
                    destino: (p.destinoEndereco || p.destino || '').toString().trim(),
                    servico: (p.servico || 'Standard').toString().trim(),
                    status: normalizarStatusPacoteEntrega(p.status || 'PENDENTE'),
                    distanciaKm: Number.isFinite(Number(p.distanciaKm)) ? Number(p.distanciaKm) : 0,
                    duracaoMin: Number.isFinite(Number(p.duracaoMin)) ? Number(p.duracaoMin) : 0,
                    valorFrete: Number.isFinite(Number(p.valorFrete)) ? Number(p.valorFrete) : parseMoedaParaNumero(p.valor || 0),
                    tamanho: (p.tamanho || '').toString().trim(),
                    embalagem: (p.embalagem || '').toString().trim(),
                    veiculo: (p.veiculo || '').toString().trim()
                });
            });
        });
    }

    return mapa;
}

async function carregarMarketplaceRotasEntregador() {
    try {
        // Plano de segurança 2026-09-27 (Fase 3): antes lia a coleção `usuarios`
        // inteira (exigia usuarios/.read: auth != null, vazando financeiro/dívida/
        // saques/clientes de TODO MUNDO pra qualquer autenticado). Agora lê
        // marketplacePublico, um espelho mantido por Cloud Function trigger
        // (backend/functions/index.js) só com os campos que este marketplace já
        // mostrava antes — mesmo formato de usuário, já filtrado por tipo (só
        // lojista) e sem financeiro/clientes sensíveis, então o resto desta
        // função continua igual.
        const snap = await db.ref('marketplacePublico').once('value');
        const usuariosNo = snap.val() || {};
        window.pacotesRaizCache = {};
        const lista = [];

        Object.keys(usuariosNo).forEach((uid) => {
            const entradaPublica = usuariosNo[uid] || {};
            const usuario = {
                ...(entradaPublica.perfil || {}),
                clientes: entradaPublica.clientes || {},
                rotas: entradaPublica.rotas || {}
            };
            // BUG CORRIGIDO 2026-09-28: faltava a fonte "pacotesNovo" (modelo
            // usuarios/{uid}/pacotes, o mais usado hoje) no índice — só
            // pacotesRaiz (bem legado) era combinado aqui, então uma rota com
            // pacotes só no modelo novo aparecia sem destino/tamanho/valor.
            window.pacotesRaizCache[uid] = { ...(entradaPublica.pacotesRaiz || {}), ...(entradaPublica.pacotesNovo || {}) };

            const rotasNo = usuario?.rotas || {};
            const rotaIds = Object.keys(rotasNo || {});
            if (!rotaIds.length) return;

            const lojistaNome = (usuario?.nome || usuario?.loja || 'Lojista').toString().trim() || 'Lojista';
            const origemCidade = (usuario?.endereco?.cidade || '').toString().trim();
            const origemUf = normalizarUf(usuario?.endereco?.uf || usuario?.endereco?.estado || '');
            const origemLabel = montarCidadeUfMarketplace(origemCidade, origemUf);
            const origemBairro = (usuario?.endereco?.bairro || '').toString().trim();

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

                // "Paradas" é por ENDEREÇO de entrega, não por cidade — 3 pacotes
                // pra 3 endereços diferentes na mesma cidade são 3 paradas, não 1.
                // Bug relatado pelo dono 2026-09-18: usava `destinos` (deduplicado
                // por cidade) pra isso, então 3 pacotes na mesma cidade mostravam
                // "1 Parada".
                const enderecosDestino = [...new Set(
                    pacotes
                        .map((p) => (p?.destinoCompleto || p?.destinoEndereco || p?.destino || obterCidadeDestinoPacoteMarketplace(p) || '').toString().trim())
                        .filter(Boolean)
                )];
                const totalParadas = enderecosDestino.length || pacotes.length || 1;

                // Bairros de destino (pedido do dono 2026-09-28): pro dropdown
                // de destino no sheet "Buscar" mostrar o detalhe de cada parada
                // por bairro, não só a cidade — ordem de aparição, sem repetir.
                const bairrosDestino = [...new Set(
                    pacotes.map((p) => (p?.bairro || '').toString().trim()).filter(Boolean)
                )];

                const totalFrete = Number.isFinite(Number(rota?.totalFrete))
                    ? Number(rota.totalFrete)
                    : pacotes.reduce((acc, p) => acc + Number(p?.valorFrete || 0), 0);
                const distanciaTotal = pacotes.reduce((acc, p) => acc + Number(p?.distanciaKm || 0), 0);
                const duracaoTotal = pacotes.reduce((acc, p) => acc + Number(p?.duracaoMin || 0), 0);

                const temFlash = pacotes.some((p) => {
                    const serv = normalizarTexto(p?.servico || '');
                    return serv.includes('flash') || serv.includes('expresso');
                });
                const temStandard = pacotes.some((p) => {
                    const serv = normalizarTexto(p?.servico || '');
                    return !(serv.includes('flash') || serv.includes('expresso'));
                }) || !pacotes.length;
                const servicoLabel = temFlash ? 'Expresso' : 'Padrao';
                // Coleta reversa (troca/devolução agendada) parte do
                // endereço do CLIENTE em vez da loja — montarRota já impede
                // misturar com entregas normais, então isso é tudo-ou-nada
                // por rota, mas checa "some" pelo mesmo padrão usado acima.
                const ehColetaReversa = pacotes.some((p) => p?.tipoFluxo === 'coleta_reversa');

                // Detalhes da corrida (pedido do dono 2026-09-27): rota com 1 só
                // pacote mostra o tamanho real dele; com mais de um, mostra o
                // MAIOR tamanho entre eles (o entregador precisa se preparar pro
                // pior caso, não pro menor). Embalagem: só mostra um tipo se
                // todos os pacotes da rota forem iguais, senão "Variado".
                const tamanhoTxt = obterTamanhoMaiorPacotesMarketplace(pacotes);
                const embalagensUnicas = [...new Set(pacotes.map((p) => (p?.embalagem || 'Caixa').toString().trim() || 'Caixa'))];
                const embalagemTxt = embalagensUnicas.length > 1 ? 'Variado' : (embalagensUnicas[0] || 'Caixa');
                const veiculoTxt = (pacotes.find((p) => p?.veiculo)?.veiculo || 'Moto').toString().trim() || 'Moto';

                lista.push({
                    id: rota.id,
                    lojistaUid: uid,
                    lojistaNome,
                    lojistaLogo: (usuario?.logo || usuario?.foto || ''),
                    origemCidade: origemCidade || '--',
                    origemLabel,
                    origemBairro,
                    destinoPrincipal,
                    destinos,
                    bairrosDestino,
                    totalPacotes,
                    totalParadas,
                    totalFrete,
                    distanciaTotal,
                    duracaoTotal,
                    statusNorm,
                    statusVisual,
                    servicoLabel,
                    temStandard,
                    temFlash,
                    ehColetaReversa,
                    tamanhoTxt,
                    embalagemTxt,
                    veiculoTxt,
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

    const ref = db.ref('marketplacePublico');
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
                    <img src="img/logoflexa.png" alt="Flex" class="gh-logo">
                </div>
                <div class="gh-actions">
                    ${chipHtml}
                    <div class="entregador-bell gh-bell" onclick="abrirPainelNotificacoes()">
                        <i data-lucide="bell" size="18"></i>
                        <span class="dot"></span>
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

// O sino (.gh-bell) acende pra duas fontes diferentes de "não lido":
// notificações de rota (notificacoesCache) E mensagens de chat
// (atualizarBadgeChatSimples, mais abaixo) — pedido do dono 2026-10-02:
// "o sino notificação do entregador também precisa sinalizar mensagem não
// lida". Cada fonte só sabe o PRÓPRIO estado; sem esses dois caches
// separados, a função que rodasse por último apagaria sozinha o aceso
// que a outra tinha acabado de ligar.
let notificacoesSinoTemNaoLida = false;
let chatSinoTemNaoLido = false;

function atualizarSinoNaoLido() {
    const acender = notificacoesSinoTemNaoLida || chatSinoTemNaoLido;
    document.querySelectorAll('.gh-bell').forEach((bell) => {
        bell.classList.toggle('has-unread', acender);
    });
}

function atualizarBadgeNotificacoes() {
    const naoLidas = notificacoesCache.filter((n) => !n?.lida).length;
    notificacoesSinoTemNaoLida = naoLidas > 0;
    atualizarSinoNaoLido();
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
    // Km total em vez da contagem de paradas: o entregador consegue comparar
    // valor x distância direto no card, sem abrir o detalhe (pedido do dono
    // 2026-09-19).
    const distTotalNum = Number(rota?.distanciaTotal || 0);
    const kmTxt = formatarDistancia(distTotalNum);
    // Tags de serviço com cor: Flash é entrega urgente, precisa se destacar.
    // Rota mista (tem pacote Start E Flash) mostra as duas tags juntas.
    const tags = montarTagsServicoMarketplace(rota);
    // Entregador só vê o valor líquido aqui também — ver [COMISSÃO DA PLATAFORMA].
    const repasseValor = calcularValorRepasseEntregador(Number(rota?.totalFrete || 0), distTotalNum);
    const precoTxt = precoParaMoeda(repasseValor);
    // Valor/km e veículo (pedido do dono 2026-09-27): mesmo padrão de "quanto
    // vale essa corrida" que já existe no sheet de detalhes, só que resumido
    // numa linha extra, mantendo o card baixinho de lista.
    const precoPorKmTxt = precoParaMoeda(distTotalNum > 0 ? repasseValor / distTotalNum : 0);
    const veiculoTxt = rota?.veiculoTxt || 'Moto';
    const logo = (rota?.lojistaLogo || "").toString().trim();
    const rotaIdEsc = escaparHtmlMarketplace(String(rota?.id || ''));
    const lojistaUidEsc = escaparHtmlMarketplace(String(rota?.lojistaUid || ''));
    const avatar = logo
        ? `<img src="${escaparHtmlMarketplace(logo)}" alt="${escaparHtmlMarketplace(rota?.lojistaNome || "Loja")}" class="buscar-rota-avatar-img">`
        : `<div class="buscar-rota-avatar-fallback">${escaparHtmlMarketplace((rota?.lojistaNome || "L").slice(0, 1).toUpperCase())}</div>`;
    // Card com altura mínima: tags de serviço e km na MESMA linha (pedido do
    // dono 2026-09-19), em vez de 3 linhas empilhadas (título/tags/km).
    return `
        <article class="buscar-rota-card" onclick="abrirSheetBuscaRota('${rotaIdEsc}', '${lojistaUidEsc}')">
            <div class="buscar-rota-avatar">${avatar}</div>
            <div class="buscar-rota-body">
                <div class="buscar-rota-title">${escaparHtmlMarketplace(rota?.lojistaNome || "Loja")}</div>
                <div class="buscar-rota-tags">${tags.join('')}<span class="buscar-rota-meta">${escaparHtmlMarketplace(kmTxt)}</span></div>
                <div class="buscar-rota-extra">${escaparHtmlMarketplace(precoPorKmTxt)}/km · 🏍 ${escaparHtmlMarketplace(veiculoTxt)}</div>
            </div>
            <div class="buscar-rota-price">${escaparHtmlMarketplace(precoTxt)}</div>
        </article>
    `;
}

// Compartilhado entre o card da lista e o sheet de detalhes pra sempre
// mostrarem a mesma tag (bug corrigido 2026-09-19: o sheet usava um
// `servicoLabel` à parte ('Padrao'/'Expresso') que ficava incoerente com as
// tags 'Start'/'Flash' da lista).
function montarTagsServicoMarketplace(rota) {
    const tags = [];
    // Coleta reversa vem primeiro e sozinha — é a informação mais
    // importante pro entregador antes de aceitar (direção invertida:
    // busca no cliente, entrega na loja), não pode passar despercebida
    // misturada com as tags de serviço.
    if (rota?.ehColetaReversa) {
        tags.push('<span class="buscar-rota-tag tag-coleta">↩ Coleta</span>');
        return tags;
    }
    if (rota?.temStandard) tags.push('<span class="buscar-rota-tag tag-standard">Start</span>');
    if (rota?.temFlash) tags.push('<span class="buscar-rota-tag tag-flash">⚡ Flash</span>');
    if (!tags.length) tags.push('<span class="buscar-rota-tag tag-standard">Start</span>');
    return tags;
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
    // "Paradas" é por endereço de entrega (rota.totalParadas), não por cidade
    // (destinos.length) — ver carregarMarketplaceRotasEntregador.
    const qtdParadas = Number.isFinite(Number(rota.totalParadas)) && Number(rota.totalParadas) > 0
        ? Number(rota.totalParadas)
        : Math.max(1, destinos.length);
    const badgeHtml = montarTagsServicoMarketplace(rota).join('');
    // Entregador só vê o valor líquido (já descontada a taxa da plataforma) —
    // ver [COMISSÃO DA PLATAFORMA].
    const distanciaTotalNum = Number(rota.distanciaTotal || 0);
    const repasseValor = calcularValorRepasseEntregador(Number(rota.totalFrete || 0), distanciaTotalNum);
    const precoTxt = precoParaMoeda(repasseValor);
    const precoPorKmTxt = precoParaMoeda(distanciaTotalNum > 0 ? repasseValor / distanciaTotalNum : 0);
    const distanciaTxt = formatarDistancia(distanciaTotalNum);
    const duracaoTxt = formatarDuracao(Number(rota.duracaoTotal || 0));
    const totalPacotesNum = Number(rota.totalPacotes || 0);
    const origemTxt = rota.origemLabel || 'Origem não informada';
    const destinoTxt = rota.destinoPrincipal || (destinos[0] || 'Destino não informado');
    // Origem e destino continuam sempre visíveis (igual sempre foi) — o que
    // muda (pedido do dono 2026-09-28) é que CADA linha vira seu próprio
    // dropdown independente, revelando os bairros daquele lado especificamente
    // (não um resumo combinado dos dois, que escondia a cidade por padrão).
    const bairrosOrigem = rota.origemBairro ? [rota.origemBairro] : [];
    const bairrosDestino = Array.isArray(rota.bairrosDestino) ? rota.bairrosDestino : [];
    const logo = (rota?.lojistaLogo || "").toString().trim();
    const avatar = logo
        ? `<img src="${escaparHtmlMarketplace(logo)}" alt="${escaparHtmlMarketplace(rota?.lojistaNome || "Loja")}" />`
        : `<span>${escaparHtmlMarketplace((rota?.lojistaNome || 'L').slice(0,1).toUpperCase())}</span>`;

    // Detalhes da corrida (pedido do dono 2026-09-27): tamanho/embalagem/
    // veículo já vêm agregados de carregarMarketplaceRotasEntregador.
    const tamanhoTxt = rota.tamanhoTxt || 'PP/P';
    const faixaPesoTxt = FAIXA_PESO_TAMANHO_MKT[tamanhoTxt] || '';
    const embalagemTxt = rota.embalagemTxt || 'Caixa';
    const veiculoTxt = rota.veiculoTxt || 'Moto';

    content.innerHTML = `
        <div class="sheet-header">
        <div class="sheet-merchant">
            <div class="sheet-merchant-logo">${avatar}</div>
            <div class="sheet-merchant-info">
                <strong>${escaparHtmlMarketplace(rota?.lojistaNome || 'Lojista')}</strong>
                <div class="sheet-badge-row">${badgeHtml}</div>
            </div>
        </div>
        <small class="sheet-rota-id">#${escaparHtmlMarketplace(String(rota.id || ''))}</small>
    </div>

    <div class="sheet-price-row">
        <div class="sheet-price-block">
            <div class="sheet-price">${escaparHtmlMarketplace(precoTxt)}</div>
            <div class="sheet-price-km">${escaparHtmlMarketplace(precoPorKmTxt)}/km</div>
        </div>
        <div class="sheet-price-icon"><i data-lucide="package" size="32"></i></div>
    </div>

    <div class="sheet-meta-row">
        <div class="sheet-meta-item"><i data-lucide="route"></i><strong>${escaparHtmlMarketplace(distanciaTxt)}</strong><small>total</small></div>
        <div class="sheet-meta-item"><i data-lucide="clock"></i><strong>${escaparHtmlMarketplace(duracaoTxt)}</strong><small>estimados</small></div>
        <div class="sheet-meta-item"><i data-lucide="box"></i><strong>${totalPacotesNum}</strong><small>pacote${totalPacotesNum > 1 ? 's' : ''}</small></div>
        <div class="sheet-meta-item"><i data-lucide="flag"></i><strong>${qtdParadas}</strong><small>parada${qtdParadas > 1 ? 's' : ''}</small></div>
    </div>

    <div class="sheet-route-timeline">
        <button type="button" class="sheet-route-point-toggle${bairrosOrigem.length ? '' : ' no-chevron'}" onclick="toggleDetalhesCorrida(this)">
            <span class="sheet-route-point"><span class="sheet-route-dot sheet-route-dot-origem"></span><strong>${escaparHtmlMarketplace(origemTxt)}</strong></span>
            ${bairrosOrigem.length ? '<i data-lucide="chevron-down" size="14" class="sheet-details-chevron"></i>' : ''}
        </button>
        <div class="sheet-route-bairros hidden">
            ${bairrosOrigem.map((b) => `<span class="sheet-route-bairro-item">${escaparHtmlMarketplace(b)}</span>`).join('')}
        </div>
        <button type="button" class="sheet-route-point-toggle${bairrosDestino.length ? '' : ' no-chevron'}" onclick="toggleDetalhesCorrida(this)">
            <span class="sheet-route-point"><span class="sheet-route-dot sheet-route-dot-destino"></span><strong>${escaparHtmlMarketplace(destinoTxt)}</strong></span>
            ${bairrosDestino.length ? '<i data-lucide="chevron-down" size="14" class="sheet-details-chevron"></i>' : ''}
        </button>
        <div class="sheet-route-bairros hidden">
            ${bairrosDestino.map((b) => `<span class="sheet-route-bairro-item">${escaparHtmlMarketplace(b)}</span>`).join('')}
        </div>
    </div>

    <div class="sheet-details-accordion">
        <button type="button" class="sheet-details-toggle" onclick="toggleDetalhesCorrida(this)">
            <span><i data-lucide="clipboard-list" size="16"></i> Detalhes da corrida</span>
            <i data-lucide="chevron-down" size="16" class="sheet-details-chevron"></i>
        </button>
        <div class="sheet-details-body hidden">
            <div class="sheet-detail-row">📦 ${totalPacotesNum} pacote${totalPacotesNum > 1 ? 's' : ''} · Tamanho ${escaparHtmlMarketplace(tamanhoTxt)}${faixaPesoTxt ? ` (${escaparHtmlMarketplace(faixaPesoTxt)})` : ''}</div>
            <div class="sheet-detail-row">🏍 Veículo: ${escaparHtmlMarketplace(veiculoTxt)}</div>
            <div class="sheet-detail-row">Tipo: ${escaparHtmlMarketplace(embalagemTxt)}</div>
        </div>
    </div>

    <div class="sheet-actions">
            <button class="sheet-accept-btn" onclick="fecharSheetBuscar(); aceitarRotaMarketplaceEntregador('${escaparHtmlMarketplace(String(rota.lojistaUid || ''))}', '${escaparHtmlMarketplace(String(rota.id || ''))}')">
                ✓ Aceitar corrida
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

function toggleDetalhesCorrida(btn) {
    const body = btn?.nextElementSibling;
    if (!body) return;
    const abrindo = body.classList.contains('hidden');
    body.classList.toggle('hidden', !abrindo);
    btn.classList.toggle('is-open', abrindo);
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
    const precoTxt = precoParaMoeda(calcularValorRepasseEntregador(Number(rota?.totalFrete || 0), Number(rota?.distanciaTotal || 0)));
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
    const precoTxt = precoParaMoeda(calcularValorRepasseEntregador(Number(rota?.totalFrete || 0), Number(rota?.distanciaTotal || 0)));
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
    // BUG CORRIGIDO 2026-10-03 (achado pelo dono: código que o entregador via
    // divergia do código já mandado pro cliente, e piorava com rotas
    // sucessivas). Esta função confiava só no objeto `pac` em MEMÓRIA pra
    // decidir "esse pacote não tem código, preciso gerar um novo" — se por
    // qualquer motivo (cache de window.pacotesRaizCache desatualizado,
    // corrida entre aceitar a rota e abrir o sheet, fetch incompleto) o
    // `pac` local vinha sem o campo mesmo o pacote JÁ tendo um código real
    // no banco (já mandado pro cliente via link), sobrescrevia
    // silenciosamente com um código novo e ALEATÓRIO. O cliente continuava
    // vendo o código antigo (rastreioPublico é gravado uma vez na criação da
    // rota e nunca mais atualizado), e o entregador passava a exigir um
    // código diferente — nenhum dos dois lados avisa que algo mudou. Agora
    // confere direto no banco (fonte real) antes de gerar — nunca mais gera
    // por cima de um código que já existe de verdade.
    for (const pac of pacotes) {
        if (obterCodigoConfirmacaoEsperado(pac)) continue;
        const pacoteId = obterIdPacoteConfirmacao(pac);
        if (!pacoteId) continue;
        let codigoReal = '';
        try {
            const snap = await db.ref(`usuarios/${lojistaUid}/pacotes/${pacoteId}/codigoConfirmacaoEntrega`).once('value');
            codigoReal = (snap.val() || '').toString().trim();
        } catch (err) { /* segue pro fallback de gerar um novo abaixo */ }
        if (codigoReal) {
            pac.codigoConfirmacaoEntrega = codigoReal;
            continue;
        }
        const novoCodigo = gerarCodigoConfirmacaoEntrega();
        pac.codigoConfirmacaoEntrega = novoCodigo;
        updates[`usuarios/${lojistaUid}/pacotes/${pacoteId}/codigoConfirmacaoEntrega`] = novoCodigo;
    }

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

    // SEMPRE busca os pacotes frescos do lojista (garantirPacotesDaRota), não só
    // quando opts.refetchPacotes é passado explicitamente. Bug encontrado
    // 2026-08-16: o card da lista de rotas abre este sheet sem essa flag, caindo
    // no fallback sintético de prepararPacotesRotaEntregador — que RECONSTRÓI os
    // pacotes a partir só dos campos da própria rota (sem devolucaoStatus,
    // cobrancaEntrega, codigoConfirmacaoDevolucao etc). Reabrir a rota entre
    // ações (ex: devolver o pacote 1, fechar o sheet, reabrir pra entregar o
    // pacote 2) perdia silenciosamente o estado de devolução já gravado,
    // fazendo finalizarRotaSeCompleta calcular o desfecho errado (CANCELADA em
    // vez de CONCLUIDO) e o pacote devolvido "sumir" do status correto após
    // recarregar a página. garantirPacotesDaRota já cai de volta nesse mesmo
    // fallback sozinho se não achar nada, então isso é estritamente mais seguro.
    let pacotes = await garantirPacotesDaRota(rotaObj);
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
    pararPollingPixCobrancaEntrega();
    pixCobrancaEntregaAtual = null;
    pararListenerEsperaPacote();
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
            db.ref(`rastreioPublico/${rotaId}`).update({ entregadorGeo: payload, atualizadoEm: agora }).catch(() => {});
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
            // BUG CORRIGIDO 2026-09-19: isto pré-preenchia o campo "Confirme a
            // entrega" com o próprio código real (codigoPersistido) mesmo pra
            // pacote ainda PENDENTE — o entregador via a resposta certa sem
            // precisar que o cliente informasse nada, o que anula todo o
            // propósito do código (ver project-flexa-flow-bugs). Só faz
            // sentido pré-preencher com o código real quando o pacote JÁ foi
            // concluído antes (é só a exibição "Código: XXXX" como recibo,
            // não um campo esperando digitação).
            estado.pacotes[chave] = {
                status: concluido ? 'concluido' : 'pendente',
                codigoConfirmacao: concluido ? codigoPersistido : ''
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

// Protocolo de pagamento (pedido do dono 2026-09-30) — mesmo gerador do
// backend (gerarProtocoloTransacaoServer), só que pro lado do cliente cria
// transação direto (pagamento com saldo, saque marcado como pago).
function gerarProtocoloTransacao() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TX-${ts}-${rand}`;
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

// Desfecho final de um pacote dentro da rota do entregador: 'entregue' | 'devolvido'
// | 'cancelado' | 'pendente'. Usado tanto pra decidir se a rota inteira já chegou
// a um estado final quanto pra decidir QUAL estado final (CONCLUIDO vs CANCELADA
// — ver finalizarRotaSeCompleta). Ver project-flexa-cobranca-entrega-dinheiro.
function obterDesfechoPacoteNoSheet(rotaId, pac, idx = 0) {
    const estado = obterEstadoPacoteRota(rotaId, pac, idx);
    if (estado.status === 'concluido') return 'entregue';
    const statusPac = normalizarStatusEnvioFiltro(pac?.statusRaw || pac?.status || '');
    if (statusPac === 'ENTREGUE') return 'entregue';
    if (statusPac === 'CANCELADO') return 'cancelado';
    if (pac?.devolucaoStatus === 'DEVOLVIDO') return 'devolvido';
    return 'pendente';
}

function pacoteConcluidoOuCanceladoNoSheet(rotaId, pac, idx = 0) {
    return obterDesfechoPacoteNoSheet(rotaId, pac, idx) !== 'pendente';
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


function atualizarWalletChipEntregadorUI(saldo = 0) {
    document.querySelectorAll('.entregador-wallet-chip span').forEach((el) => {
        el.textContent = precoParaMoeda(Number(saldo) || 0);
    });
}

// Depois que QUALQUER pacote de uma rota chega a um desfecho final (entrega OU
// devolução — ver obterDesfechoPacoteNoSheet), decide se a rota inteira terminou
// e grava o status certo nas duas cópias (lojista+entregador). Regra do dono
// (2026-08-15): CONCLUIDO se pelo menos 1 pacote foi entregue de verdade;
// CANCELADA se nenhum foi (todos devolvidos/cancelados). `forcarEntregueIdx` é
// usado no instante em que um pacote acabou de ser marcado ENTREGUE no banco mas
// o array local `pacotes` ainda não reflete isso.
async function finalizarRotaSeCompleta(rotaObj, pacotes, { forcarEntregueIdx = -1 } = {}) {
    const rotaId = String(rotaObj?.id || '').trim();
    const semDesfecho = { todosPacotesConcluidos: false, statusRota: 'EM_ROTA', creditado: false, saldoAtualizado: Number(window.usuarioLogado?.financeiro?.saldo || 0), valorCreditado: 0 };
    if (!rotaId || !Array.isArray(pacotes) || !pacotes.length) return semDesfecho;

    const desfechos = pacotes.map((p, idx) => (idx === forcarEntregueIdx ? 'entregue' : obterDesfechoPacoteNoSheet(rotaId, p, idx)));
    const todosPacotesConcluidos = desfechos.every((d) => d !== 'pendente');
    if (!todosPacotesConcluidos) return { ...semDesfecho, todosPacotesConcluidos: false };

    const teveEntrega = desfechos.some((d) => d === 'entregue');
    const statusRota = teveEntrega ? 'CONCLUIDO' : 'CANCELADA';

    const lojistaUid = obterLojistaUidDaRota(rotaObj, pacotes[0] || {});
    const uidEntregador = getUsuarioIdAtual();
    const agora = Date.now();
    const updatesRota = {};
    if (lojistaUid) {
        const rotaLojistaPath = `usuarios/${lojistaUid}/rotas/${rotaId}`;
        updatesRota[`${rotaLojistaPath}/status`] = statusRota;
        updatesRota[`${rotaLojistaPath}/pagamentoStatus`] = statusRota;
        updatesRota[`${rotaLojistaPath}/atualizadoEm`] = agora;
        updatesRota[`${rotaLojistaPath}/concluidaEm`] = agora;
    }
    if (uidEntregador) {
        const rotaEntregadorPath = `usuarios/${uidEntregador}/rotas/${rotaId}`;
        updatesRota[`${rotaEntregadorPath}/status`] = statusRota;
        updatesRota[`${rotaEntregadorPath}/pagamentoStatus`] = statusRota;
        updatesRota[`${rotaEntregadorPath}/atualizadoEm`] = agora;
        updatesRota[`${rotaEntregadorPath}/concluidaEm`] = agora;
    }
    updatesRota[`rastreioPublico/${rotaId}/statusRota`] = statusRota;
    updatesRota[`rastreioPublico/${rotaId}/atualizadoEm`] = agora;
    if (Object.keys(updatesRota).length) {
        try {
            await db.ref().update(updatesRota);
        } catch (err) {
            console.warn('Falha ao gravar status final da rota:', err);
        }
    }

    if (window.usuarioLogado?.rotas?.[rotaId]) {
        window.usuarioLogado.rotas[rotaId] = {
            ...(window.usuarioLogado.rotas[rotaId] || {}),
            status: statusRota, pagamentoStatus: statusRota, atualizadoEm: agora, concluidaEm: agora
        };
    }
    if (entregadorHomeCache?.rotas?.[rotaId]) {
        entregadorHomeCache.rotas[rotaId] = {
            ...(entregadorHomeCache.rotas[rotaId] || {}),
            status: statusRota, pagamentoStatus: statusRota, atualizadoEm: agora, concluidaEm: agora
        };
    }

    // Só credita o frete da rota pro entregador se pelo menos uma entrega
    // aconteceu de verdade — rota cancelada (tudo devolvido) não gera crédito.
    // O valor de crédito agora é recalculado no servidor a partir da rota/pacotes
    // canônicos do lojista (ver /creditar-rota-finalizada em backend/functions),
    // nunca mais a partir do espelho local do entregador — o endpoint já é
    // idempotente por conta própria, então é seguro chamar mesmo se essa rota já
    // tiver sido finalizada antes.
    let creditoResumo = { creditado: false, saldoAtualizado: Number(window.usuarioLogado?.financeiro?.saldo || 0), valorCreditado: 0 };
    if (teveEntrega && lojistaUid) {
        try {
            const resp = await chamarPaymentsProxy('/creditar-rota-finalizada', { tenantId: lojistaUid, rotaId });
            if (resp?.creditado) {
                creditoResumo = { creditado: true, saldoAtualizado: Number(resp.saldoAtualizado || 0), valorCreditado: Number(resp.valorCreditado || 0) };
                if (!window.usuarioLogado) window.usuarioLogado = {};
                window.usuarioLogado.financeiro = { ...(window.usuarioLogado.financeiro || {}), saldo: creditoResumo.saldoAtualizado, atualizadoEm: Date.now() };
                if (entregadorHomeCache) {
                    entregadorHomeCache.financeiro = { ...(entregadorHomeCache.financeiro || {}), saldo: creditoResumo.saldoAtualizado, atualizadoEm: Date.now() };
                }
                pagamentoPerfilCache.saldo = creditoResumo.saldoAtualizado;
                atualizarWalletChipEntregadorUI(creditoResumo.saldoAtualizado);
            }
        } catch (err) {
            console.warn('Falha ao creditar carteira do entregador na conclusão da rota:', err);
        }
    }

    return { todosPacotesConcluidos, statusRota, ...creditoResumo };
}

async function persistirEntregaPacoteAtual(rotaObj = {}, pac = {}, codigoConfirmacao = '') {
    const rotaId = String(rotaObj?.id || '').trim();
    const pacoteId = obterIdPacoteConfirmacao(pac);
    const lojistaUid = obterLojistaUidDaRota(rotaObj, pac);
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

    // Marca essa parada como entregue no espelho público de rastreio — é o
    // que faz o ponto dela acender na timeline que o cliente final vê pelo
    // link, mostrando que o entregador já passou por ali.
    updates[`rastreioPublico/${rotaId}/pacotes/${pacoteId}/status`] = 'ENTREGUE';
    updates[`rastreioPublico/${rotaId}/pacotes/${pacoteId}/entregueEm`] = agora;

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

    // Recalcula o desfecho da rota inteira (CONCLUIDO se essa entrega bastou,
    // CANCELADA se ainda faltarem outros pacotes só devolvidos, etc — ver
    // finalizarRotaSeCompleta). O pacote que acabou de ser confirmado ainda não
    // está com status ENTREGUE no array local, por isso o forcarEntregueIdx.
    return finalizarRotaSeCompleta(rotaObj, rotaEntSheetPacotes, { forcarEntregueIdx: rotaEntSheetIndex });
}

function rotaSheetBloqueada() {
    if (!rotaEntSheetRotaAtual || !rotaEntSheetPacotes.length) return false;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    const estado = obterEstadoPacoteRota(rotaEntSheetRotaAtual.id, pac, rotaEntSheetIndex);
    const statusPac = normalizarStatusEnvioFiltro(pac?.statusRaw || pac?.status || '');
    if (statusPac === 'ENTREGUE' || statusPac === 'CANCELADO' || estado.status === 'concluido') return false;
    return estado.status === 'em_corrida' || statusPac === 'EM_ROTA';
}

// ===================== [COLETA DE PACOTES NA LOJA] =====================
// Passo obrigatorio entre aceitar a rota e "Iniciar Corrida" ate o cliente:
// o entregador precisa ir na loja e confirmar com codigo que retirou os
// pacotes fisicamente. Ver memoria project-flexa-cobranca-entrega-dinheiro.
function rotaPrecisaConfirmarColeta(rotaObj) {
    if (!rotaObj) return false;
    // Coleta reversa não passa por aqui (bug corrigido 2026-09-26): não tem
    // nada pra retirar NA LOJA antes de sair — o entregador vai direto pro
    // endereço de cada cliente. A "retirada" de cada pacote agora é
    // confirmada individualmente, por pacote, dentro do sheet normal (ver
    // renderSheetRotaEntregadorConteudo/confirmarRetiradaPacoteAtual).
    const ehColetaReversa = rotaEntSheetPacotes.some((p) => p?.tipoFluxo === 'coleta_reversa');
    if (ehColetaReversa) return false;
    const statusNorm = normalizarStatusRotaFiltro(rotaObj?.status || rotaObj?.pagamentoStatus || 'CRIADA');
    return statusNorm === 'EM_ROTA' && rotaObj?.coletaConfirmada !== true;
}

function enderecoLojaDaRotaAtual() {
    const rotaObj = rotaEntSheetRotaAtual;
    const primeiroPacote = rotaEntSheetPacotes[0] || {};
    return (rotaObj?.origemEndereco || primeiroPacote?.origemCompleta || primeiroPacote?.origemEndereco || '').toString().trim();
}

// FALLBACK (pedido do dono 2026-10-02: "no mobile nao ta reconhecendo o
// endereco do usuario loja"): origemEndereco/origemCompleta é uma FOTO do
// endereço da loja tirada no momento em que o PACOTE foi criado
// (confirmarEnvioFinal) — se o lojista ainda não tinha endereço cadastrado
// naquele momento, essa foto fica vazia PRA SEMPRE, mesmo que ele cadastre
// o endereço depois (o guard novo em abrirSeletorCliente só evita isso daqui
// pra frente, não conserta pedidos antigos). Quando a foto vier vazia,
// busca o endereço ATUAL do lojista direto no banco como último recurso.
async function resolverEnderecoLojaDaRotaAtual() {
    const snapshot = enderecoLojaDaRotaAtual();
    if (snapshot) return snapshot;

    const lojistaUid = obterLojistaUidDaRota(rotaEntSheetRotaAtual || {}, rotaEntSheetPacotes[0] || {});
    if (!lojistaUid) return '';

    try {
        const snap = await db.ref(`usuarios/${lojistaUid}/endereco`).once('value');
        return formatarEnderecoEstruturado(snap.val()).trim();
    } catch (err) {
        console.warn('Falha ao buscar endereço atual da loja:', err);
        return '';
    }
}

async function abrirMapaColetaLoja() {
    const origem = await resolverEnderecoLojaDaRotaAtual();
    if (!origem) {
        alert('Endereço da loja não informado.');
        return;
    }
    const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(origem)}`;
    window.open(url, '_blank');
}

async function confirmarColetaPacotes() {
    const rotaObj = rotaEntSheetRotaAtual;
    if (!rotaObj) return;
    const input = document.getElementById('ent-sheet-coleta-code-input');
    const codigo = (input?.value || '').trim();
    if (!codigo) {
        alert('Digite o código de coleta informado pelo lojista.');
        return;
    }
    const codigoEsperado = String(rotaObj.codigoConfirmacaoColeta || '').trim();
    if (!codigoEsperado) {
        alert('Rota sem código de coleta gerado. Feche e reabra a rota.');
        return;
    }
    if (normalizarCodigoConfirmacaoEntrega(codigo) !== normalizarCodigoConfirmacaoEntrega(codigoEsperado)) {
        alert('Código inválido. Peça o código de coleta ao lojista.');
        return;
    }

    const lojistaUid = obterLojistaUidDaRota(rotaObj, {});
    const uidEntregador = getUsuarioIdAtual();
    const agora = Date.now();
    const updates = {};
    if (lojistaUid) {
        updates[`usuarios/${lojistaUid}/rotas/${rotaObj.id}/coletaConfirmada`] = true;
        updates[`usuarios/${lojistaUid}/rotas/${rotaObj.id}/coletaConfirmadaEm`] = agora;
    }
    if (uidEntregador) {
        updates[`usuarios/${uidEntregador}/rotas/${rotaObj.id}/coletaConfirmada`] = true;
        updates[`usuarios/${uidEntregador}/rotas/${rotaObj.id}/coletaConfirmadaEm`] = agora;
    }
    // BUG CORRIGIDO 2026-09-21: o ponto de retirada na timeline pública
    // ficava verde assim que um entregador ACEITAVA a rota — mas aceitar não
    // é a mesma coisa que já ter passado na loja e pego os pacotes de
    // verdade. Só acende quando a coleta é confirmada aqui.
    updates[`rastreioPublico/${rotaObj.id}/coletaConfirmada`] = true;

    try {
        await db.ref().update(updates);
    } catch (err) {
        console.warn('Falha ao confirmar coleta:', err);
        alert('Não foi possível confirmar a coleta agora. Tente novamente.');
        return;
    }

    rotaObj.coletaConfirmada = true;
    rotaObj.coletaConfirmadaEm = agora;
    if (window.usuarioLogado?.rotas?.[rotaObj.id]) {
        window.usuarioLogado.rotas[rotaObj.id].coletaConfirmada = true;
    }
    if (lojistaUid) {
        criarNotificacao(lojistaUid, {
            tipo: 'coleta_confirmada',
            titulo: 'Pacotes retirados',
            mensagem: `${window.usuarioLogado?.nome || 'O entregador'} retirou os pacotes da rota #${rotaObj.id}.`,
            rotaId: String(rotaObj.id)
        });
    }

    renderSheetRotaEntregadorConteudo();
}

function renderSheetColetaPacotes() {
    const content = document.getElementById('rotas-entregador-sheet-content');
    if (!content || !rotaEntSheetRotaAtual) return;
    const rotaObj = rotaEntSheetRotaAtual;
    const enderecoLoja = enderecoLojaDaRotaAtual();
    const nomeLoja = rotaObj?.lojistaNome || 'Lojista';
    const totalPacotes = rotaEntSheetPacotes.length;
    const logo = (rotaObj?.lojistaLogo || rotaObj?.lojistaFoto || '').toString().trim();
    const avatar = logo
        ? `<img src=\"${escaparHtmlMarketplace(logo)}\" alt=\"${escaparHtmlMarketplace(nomeLoja)}\" />`
        : `<span>${escaparHtmlMarketplace(nomeLoja.slice(0, 1).toUpperCase())}</span>`;

    content.innerHTML = `
    <div class=\"sheet-buscar modal-ent-sheet\" style=\"background:#fff; border-radius:22px 22px 0 0; padding:18px 18px 20px 18px; box-shadow: 0 18px 36px rgba(0,0,0,0.20); width:100%;\">
        <div class=\"ent-sheet-handle\"></div>
        <button type=\"button\" class=\"ent-sheet-close-btn\" onclick=\"fecharSheetRotaEntregador()\">&times;</button>
        <div class=\"ent-sheet-header\">
            <div class=\"ent-sheet-loja\">
                <div class=\"ent-sheet-avatar\">${avatar}</div>
                <div>
                    <div class=\"ent-sheet-loja-nome\">${escaparHtmlMarketplace(nomeLoja)}</div>
                    <div class=\"ent-sheet-loja-id\">Rota #${escaparHtmlMarketplace(String(rotaObj.id || ''))}</div>
                </div>
            </div>
        </div>

        <div class=\"ent-sheet-destino\">
            <strong>Retirar ${totalPacotes} pacote${totalPacotes === 1 ? '' : 's'} na loja</strong>
            <div class=\"ent-sheet-endereco\" id=\"ent-sheet-endereco-texto\">${escaparHtmlMarketplace(enderecoLoja || 'Endereço não informado')}</div>
        </div>

        <div class=\"ent-sheet-code-box\">
            <label for=\"ent-sheet-coleta-code-input\">Peça o código de coleta ao lojista</label>
            <input id=\"ent-sheet-coleta-code-input\" type=\"text\" placeholder=\"Código de coleta\">
            <div class=\"ent-sheet-actions-inline\">
                <button type=\"button\" class=\"ent-sheet-btn-ghost\" onclick=\"abrirMapaColetaLoja()\">Ir até a loja</button>
                <button type=\"button\" class=\"ent-sheet-primary small\" onclick=\"confirmarColetaPacotes()\">Confirmar coleta</button>
            </div>
        </div>

        <button class=\"ent-sheet-link\" onclick=\"relatarProblemaRota()\">Relatar Problema</button>
    </div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();

    // Endereço vazio na "foto" do pacote (ver resolverEnderecoLojaDaRotaAtual)
    // -- tenta buscar o endereço ATUAL do lojista no banco antes de desistir.
    if (!enderecoLoja) {
        resolverEnderecoLojaDaRotaAtual().then((enderecoAoVivo) => {
            if (!enderecoAoVivo) return;
            const el = document.getElementById('ent-sheet-endereco-texto');
            if (el) el.textContent = enderecoAoVivo;
        });
    }
}

// Nova versão do sheet de rota do entregador com paginação por pacote
function renderSheetRotaEntregadorConteudo() {
    const content = document.getElementById('rotas-entregador-sheet-content');
    if (!content || !rotaEntSheetRotaAtual) return;
    if (rotaPrecisaConfirmarColeta(rotaEntSheetRotaAtual)) {
        renderSheetColetaPacotes();
        return;
    }
    if (!rotaEntSheetPacotes.length) {
        content.innerHTML = '<div class=\"buscar-empty\">Nenhum pacote associado a esta rota.</div>';
        return;
    }
    const rotaObj = rotaEntSheetRotaAtual;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    const total = Math.max(1, rotaEntSheetPacotes.length);
    const statusNorm = normalizarStatusRotaFiltro(rotaObj?.status || rotaObj?.pagamentoStatus || 'CRIADA');
    const statusVisual = getStatusVisualRota(statusNorm);
    // Calculado aqui em cima (não só mais abaixo, junto de bloqueado/estadoAtual)
    // porque o endereço mostrado no card já precisa saber a fase certa.
    const emFaseRetiradaEndereco = pac?.tipoFluxo === 'coleta_reversa' && !pac?.retiradaConfirmada;

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
    // Coleta reversa, fase 1 (retirada): mostra o endereço do CLIENTE (é pra
    // lá que o entregador vai agora), não o da loja — bug corrigido
    // 2026-09-26, montarEnderecoCompletoPacote só olhava campos de destino.
    const enderecoCompleto = emFaseRetiradaEndereco
        ? (pac.origemCompleta || pac.origemEndereco || '--')
        : (montarEnderecoCompletoPacote(pac, rotaObj) || '--');
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
    // Coleta reversa (pedido do dono 2026-09-26): antes de qualquer outra
    // coisa, o pacote precisa ser "retirado com o cliente" — reaproveita a
    // MESMA máquina de estado (obterEstadoPacoteRota/rotaSheetBloqueada) já
    // usada pra "iniciar corrida"/"confirmar entrega", só que apontando pra
    // ORIGEM (o cliente) em vez do destino, com o código de retirada em vez
    // do de entrega. Uma vez confirmada, esse estado reseta (ver
    // confirmarRetiradaPacoteAtual) e o pacote cai no fluxo normal abaixo,
    // dessa vez indo pro destino real (a loja) com o código de devolução.
    const emFaseRetirada = pac?.tipoFluxo === 'coleta_reversa' && !pac?.retiradaConfirmada;

    const dots = Array.from({ length: total }).map((_, idx) =>
        `<span class=\"ent-sheet-dot ${idx === rotaEntSheetIndex ? 'active' : ''} ${bloqueado ? 'locked' : ''}\"></span>`
    ).join('');

    const enderecoExtra = [complemento].filter(Boolean).join(' • ');

    // Taxa de espera/subida (pedido do dono 2026-09-25) — só aparece depois
    // que o pacote está "bloqueado" (corrida iniciada, indo pro destino) e
    // enquanto não foi finalizada (ver resolverTaxaEsperaSubidaAntesDeEntregar,
    // chamada na hora de confirmar a entrega).
    const espera = pac?.esperaEntrega || {};
    let blocoEspera = '';
    if (!emFaseRetirada && bloqueado && !finalizado && !espera.finalizada) {
        if (!espera.chegouEm) {
            blocoEspera = `<button type=\"button\" class=\"ent-sheet-cheguei-btn\" onclick=\"confirmarCheguei()\"><i data-lucide=\"map-pin\" size=\"14\"></i> Cheguei no local</button>`;
        } else {
            const minutosDesde = Math.max(0, Math.round((Date.now() - Number(espera.chegouEm)) / 60000));
            blocoEspera = `<div class=\"ent-sheet-aguardando\"><i data-lucide=\"clock\" size=\"14\"></i> Aguardando há ${minutosDesde} min${minutosDesde > TAXA_ESPERA_GRACE_MIN ? ` (${minutosDesde - TAXA_ESPERA_GRACE_MIN} min já geram taxa)` : ''}</div>`;
            if (espera.subirStatus === 'pendente') {
                blocoEspera += `
                    <div class=\"ent-sheet-subir-pedido\">
                        <span>Cliente pediu pra você subir até o apartamento</span>
                        <div class=\"ent-sheet-actions-inline\">
                            <button type=\"button\" class=\"ent-sheet-primary small\" onclick=\"aceitarSolicitacaoSubida()\">Aceitar (+R$ 6,00)</button>
                            <button type=\"button\" class=\"ent-sheet-btn-ghost\" onclick=\"recusarSolicitacaoSubida()\">Recusar</button>
                        </div>
                    </div>`;
            } else if (espera.subirStatus === 'aceito') {
                blocoEspera += `<div class=\"ent-sheet-subir-aceito\"><i data-lucide=\"check\" size=\"14\"></i> Subida aceita (+R$ 6,00)</div>`;
            } else if (espera.subirStatus === 'recusado') {
                blocoEspera += `<div class=\"ent-sheet-subir-recusado\">Você recusou subir dessa vez</div>`;
            }
        }
    }

    // Só fica ouvindo pedido de subida enquanto ele ainda pode acontecer
    // (já chegou, ainda não respondeu sim/não) — evita listener aberto à toa.
    if (!emFaseRetirada && bloqueado && !finalizado && !espera.finalizada && espera.chegouEm && !espera.subirStatus) {
        gerenciarListenerEsperaPacote(rotaObj.id, obterIdPacoteConfirmacao(pac));
    } else {
        pararListenerEsperaPacote();
    }

    // Coleta reversa (perna 2, "devolução" na loja) usa rótulos diferentes —
    // é o LOJISTA quem confirma o recebimento aqui, não repassa a ninguém.
    const ehColetaReversaLabel = pac?.tipoFluxo === 'coleta_reversa';
    const codeBox = `
        <div class=\"ent-sheet-code-box\">
            ${blocoEspera}
            <label for=\"ent-sheet-code-input\">${ehColetaReversaLabel ? 'Confirme a devolução (código com o lojista)' : 'Confirme a entrega'}</label>
            <input id=\"ent-sheet-code-input\" type=\"text\" placeholder=\"Código de confirmação\" value=\"${escaparHtmlMarketplace(estadoAtual.codigoConfirmacao || '')}\" oninput=\"atualizarCodigoConfirmacaoAtual(this.value)\">
            <div class=\"ent-sheet-actions-inline\">
                <button type=\"button\" class=\"ent-sheet-primary small\" onclick=\"confirmarEntregaPacoteAtual()\">${ehColetaReversaLabel ? 'Confirmar devolução' : 'Confirmar entrega'}</button>
                <button type=\"button\" class=\"ent-sheet-btn-ghost\" onclick=\"cancelarCorridaPacoteAtual()\">Cancelar</button>
            </div>
        </div>
    `;

    // Fase 1 da coleta reversa: retirar com o cliente (código com o CLIENTE,
    // não com o lojista). Reaproveita a mesma máquina de estado (bloqueado
    // aqui é sempre relativo a essa 1ª perna, já que emFaseRetirada some
    // depois que confirmarRetiradaPacoteAtual reseta o estado do pacote).
    const codeBoxRetirada = `
        <div class=\"ent-sheet-code-box\">
            <label for=\"ent-sheet-code-input\">Confirme a retirada (código com o cliente)</label>
            <input id=\"ent-sheet-code-input\" type=\"text\" placeholder=\"Código de confirmação\" value=\"${escaparHtmlMarketplace(estadoAtual.codigoConfirmacao || '')}\" oninput=\"atualizarCodigoConfirmacaoAtual(this.value)\">
            <div class=\"ent-sheet-actions-inline\">
                <button type=\"button\" class=\"ent-sheet-primary small\" onclick=\"confirmarRetiradaPacoteAtual()\">Confirmar retirada</button>
                <button type=\"button\" class=\"ent-sheet-btn-ghost\" onclick=\"cancelarCorridaPacoteAtual()\">Cancelar</button>
            </div>
        </div>
    `;

    const statusOk = `
        <div class=\"ent-sheet-status-ok\"><i data-lucide=\"check-circle-2\"></i> ${ehColetaReversaLabel ? 'Devolução confirmada' : 'Entrega confirmada'}</div>
        ${estadoAtual.codigoConfirmacao ? `<div class=\"ent-sheet-code-pill\">Código ${escaparHtmlMarketplace(estadoAtual.codigoConfirmacao)}</div>` : ''}
    `;

    // Devolução por entrega falhou (ver project-flexa-cobranca-entrega-dinheiro):
    // tem prioridade sobre o fluxo normal de entrega assim que solicitada.
    // Não se aplica enquanto ainda estiver na fase de retirada da coleta
    // reversa (não tem "entrega" nenhuma pra falhar ainda).
    const devolucaoStatus = emFaseRetirada ? '' : (pac?.devolucaoStatus || '');
    let footerPrincipal;
    if (emFaseRetirada) {
        footerPrincipal = bloqueado
            ? codeBoxRetirada
            : `<button class=\"ent-sheet-primary\" onclick=\"iniciarRetiradaPacoteAtual(this)\"><span>Iniciar corrida (retirada)</span><span class=\"ent-sheet-arrow\" style=\"font-size:22px;\">›</span></button>`;
    } else if (devolucaoStatus === 'DEVOLUCAO_SOLICITADA') {
        footerPrincipal = `<div class=\"ent-sheet-status-ok ent-sheet-status-aguardando\"><i data-lucide=\"clock\"></i> Aguardando o lojista confirmar a devolução</div>`;
    } else if (devolucaoStatus === 'DEVOLUCAO_CONFIRMADA') {
        // Lojista confirmou que a devolução é real e o Pix do frete de volta já foi
        // gerado do lado dele — aqui só espera o pagamento. O código de devolução
        // só existe (e só é mostrado) depois disso, em DEVOLUCAO_PIX_PAGO. Ver
        // project-flexa-cobranca-entrega-dinheiro / pedido do dono 2026-08-15.
        footerPrincipal = `<div class=\"ent-sheet-status-ok ent-sheet-status-aguardando\"><i data-lucide=\"clock\"></i> Devolução confirmada — aguardando o lojista pagar o Pix do frete de volta para liberar o código</div>`;
    } else if (devolucaoStatus === 'DEVOLUCAO_PIX_PAGO') {
        footerPrincipal = renderBlocoDevolucaoConfirmada(pac);
    } else if (devolucaoStatus === 'DEVOLVIDO') {
        footerPrincipal = `<div class=\"ent-sheet-status-ok\"><i data-lucide=\"check-circle-2\"></i> Pacote devolvido à loja</div>`;
    } else if (bloqueado) {
        footerPrincipal = codeBox;
    } else if (finalizado) {
        footerPrincipal = statusOk;
    } else {
        footerPrincipal = `<button class=\"ent-sheet-primary\" onclick=\"iniciarCorridaPacoteAtual(this)\"><span>Iniciar Corrida</span><span class=\"ent-sheet-arrow\" style=\"font-size:22px;\">›</span></button>`;
    }
    const podeSolicitarDevolucao = !emFaseRetirada && !devolucaoStatus && !finalizado;

    content.innerHTML = `
    <div class=\"sheet-buscar modal-ent-sheet\" style=\"background:#fff; border-radius:22px 22px 0 0; padding:18px 18px 20px 18px; box-shadow: 0 18px 36px rgba(0,0,0,0.20); width:100%;\" ontouchstart=\"iniciarSwipeEntSheet(event)\" ontouchend=\"finalizarSwipeEntSheet(event)\">
        <div class=\"ent-sheet-handle\"></div>
        <button type=\"button\" class=\"ent-sheet-close-btn\" onclick=\"fecharSheetRotaEntregador()\">&times;</button>
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
            ${obs ? `<div class=\"ent-sheet-obs\"><i data-lucide=\"alert-triangle\" size=\"16\"></i><div><span class=\"ent-sheet-obs-label\">Atenção</span><p>${escaparHtmlMarketplace(obs)}</p></div></div>` : ''}
        </div>

        ${renderBlocoCobrancaEntrega(pac)}

        <div class=\"ent-sheet-footer\">
            ${footerPrincipal}
            <button class=\"ent-sheet-link\" onclick=\"relatarProblemaRota()\">Relatar Problema</button>
            ${podeSolicitarDevolucao ? `<button class=\"ent-sheet-link\" onclick=\"iniciarFluxoDevolucao()\">Não consegui entregar</button>` : ''}
            <div class=\"ent-sheet-nav-row\">
                <div class=\"ent-sheet-dots\">${dots}</div>
            </div>
        </div>
    </div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ===================== [DEVOLUÇÃO POR FALHA DE ENTREGA] =====================
// Disponível pra QUALQUER envio (não só cobrança ativa) — ver
// project-flexa-cobranca-entrega-dinheiro. "Cliente não pagou" só aparece
// quando o envio tem cobrança na entrega pendente.
function iniciarFluxoDevolucao() {
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    if (!rotaEntSheetRotaAtual || !pac) return;
    renderSheetMotivoDevolucao(pac);
}

function renderSheetMotivoDevolucao(pac) {
    const content = document.getElementById('rotas-entregador-sheet-content');
    if (!content) return;
    const podeClienteNaoPagou = pac?.cobrancaEntrega?.ativa && pac.cobrancaEntrega.status === 'pendente';

    content.innerHTML = `
    <div class=\"sheet-buscar modal-ent-sheet\" style=\"background:#fff; border-radius:22px 22px 0 0; padding:18px 18px 20px 18px; box-shadow: 0 18px 36px rgba(0,0,0,0.20); width:100%;\">
        <div class=\"ent-sheet-handle\"></div>
        <button type=\"button\" class=\"ent-sheet-close-btn\" onclick=\"fecharSheetRotaEntregador()\">&times;</button>
        <strong style=\"display:block; font-size:16px; margin-bottom:12px; color:#0f172a;\">Por que não conseguiu entregar?</strong>
        <div class=\"ent-sheet-motivo-lista\">
            ${podeClienteNaoPagou ? `<button type=\"button\" class=\"ent-sheet-btn-ghost ent-sheet-motivo-btn\" onclick=\"solicitarDevolucaoPacoteAtual('cliente_nao_pagou')\">Cliente não pagou</button>` : ''}
            <button type=\"button\" class=\"ent-sheet-btn-ghost ent-sheet-motivo-btn\" onclick=\"solicitarDevolucaoPacoteAtual('cliente_ausente')\">Cliente não está em casa</button>
            <button type=\"button\" class=\"ent-sheet-btn-ghost ent-sheet-motivo-btn\" onclick=\"solicitarDevolucaoPacoteAtual('endereco_nao_encontrado')\">Endereço não encontrado</button>
            <button type=\"button\" class=\"ent-sheet-btn-ghost ent-sheet-motivo-btn\" onclick=\"solicitarDevolucaoPacoteAtual('cliente_recusou')\">Cliente recusou o pedido</button>
            <button type=\"button\" class=\"ent-sheet-btn-ghost ent-sheet-motivo-btn\" onclick=\"solicitarDevolucaoPacoteAtual('outro')\">Outro motivo</button>
        </div>
        <button class=\"ent-sheet-link\" onclick=\"renderSheetRotaEntregadorConteudo()\">Cancelar</button>
    </div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Grava campos de um envio nos DOIS modelos de dados que este app usa
// (usuarios/{uid}/pacotes/{id} — modelo novo — e usuarios/{uid}/clientes/{c}/historico[]
// — modelo antigo, usado pelo fluxo padrão "Novo Envio"). Sem isso, uma
// atualização só chega no modelo errado e a tela nunca reflete a mudança —
// mesmo bug que persistirEntregaPacoteAtual já contorna pra confirmação de
// entrega. Ver project-flexa-cobranca-entrega-dinheiro.
async function sincronizarCamposEnvioLojista(lojistaUid, envioId, campos) {
    if (!lojistaUid || !envioId || !campos) return;
    const updates = {};
    Object.keys(campos).forEach((chave) => {
        updates[`usuarios/${lojistaUid}/pacotes/${envioId}/${chave}`] = campos[chave];
    });

    try {
        const clientesSnap = await db.ref(`usuarios/${lojistaUid}/clientes`).once('value');
        const clientesNo = clientesSnap.val() || {};
        Object.keys(clientesNo).forEach((clienteId) => {
            const historico = Array.isArray(clientesNo[clienteId]?.historico) ? clientesNo[clienteId].historico : [];
            historico.forEach((h, idx) => {
                const idAtual = String(h?.id || (`envio-${clienteId}-${idx}`));
                if (idAtual !== envioId) return;
                Object.keys(campos).forEach((chave) => {
                    updates[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}/${chave}`] = campos[chave];
                });
            });
        });
    } catch (err) {
        console.warn('Falha ao localizar envio no histórico do cliente:', err);
    }

    await db.ref().update(updates);
}

async function solicitarDevolucaoPacoteAtual(motivo) {
    const rotaObj = rotaEntSheetRotaAtual;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    if (!rotaObj || !pac) return;

    let motivoDetalhe = '';
    if (motivo === 'outro') {
        motivoDetalhe = (window.prompt('Descreva o motivo:') || '').trim();
        if (!motivoDetalhe) return;
    }
    if (!window.confirm('Confirma que não conseguiu entregar este pedido? O lojista vai precisar confirmar a devolução antes de você levar o pacote de volta.')) {
        return;
    }

    const lojistaUid = obterLojistaUidDaRota(rotaObj, pac);
    const envioId = obterIdPacoteConfirmacao(pac);
    if (!lojistaUid || !envioId) return;
    const agora = Date.now();

    try {
        await sincronizarCamposEnvioLojista(lojistaUid, envioId, {
            devolucaoStatus: 'DEVOLUCAO_SOLICITADA',
            motivoDevolucao: motivo,
            motivoDevolucaoDetalhe: motivoDetalhe,
            devolucaoSolicitadaEm: agora
        });

        criarNotificacao(lojistaUid, {
            tipo: 'devolucao_solicitada',
            titulo: 'Entrega não realizada',
            mensagem: `${window.usuarioLogado?.nome || 'O entregador'} não conseguiu entregar o pedido de ${obterNomeDestinatarioPacote(pac, rotaObj)}. Confirme a devolução no app.`,
            rotaId: String(rotaObj.id)
        });

        pac.devolucaoStatus = 'DEVOLUCAO_SOLICITADA';
        pac.motivoDevolucao = motivo;
        pac.motivoDevolucaoDetalhe = motivoDetalhe;
        renderSheetRotaEntregadorConteudo();
    } catch (err) {
        console.warn('Falha ao solicitar devolução:', err);
        alert('Não foi possível registrar a devolução agora. Tente novamente.');
    }
}

function renderBlocoDevolucaoConfirmada(pac) {
    return `
    <div class=\"ent-sheet-code-box\">
        <label for=\"ent-sheet-devolucao-code-input\">Código de devolução (informado pelo lojista)</label>
        <input id=\"ent-sheet-devolucao-code-input\" type=\"text\" placeholder=\"Código de devolução\">
        <div class=\"ent-sheet-actions-inline\">
            <button type=\"button\" class=\"ent-sheet-btn-ghost\" onclick=\"abrirMapaColetaLoja()\">Ir até a loja</button>
            <button type=\"button\" class=\"ent-sheet-primary small\" onclick=\"confirmarCodigoDevolucaoPacoteAtual()\">Confirmar devolução</button>
        </div>
    </div>`;
}

async function confirmarCodigoDevolucaoPacoteAtual() {
    const rotaObj = rotaEntSheetRotaAtual;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    if (!rotaObj || !pac) return;

    const input = document.getElementById('ent-sheet-devolucao-code-input');
    const codigo = (input?.value || '').trim();
    if (!codigo) {
        alert('Digite o código de devolução informado pelo lojista.');
        return;
    }
    const codigoEsperado = String(pac.codigoConfirmacaoDevolucao || '').trim();
    if (!codigoEsperado) {
        alert('Ainda não há código de devolução — o lojista precisa pagar o Pix do frete de volta primeiro.');
        return;
    }
    if (normalizarCodigoConfirmacaoEntrega(codigo) !== normalizarCodigoConfirmacaoEntrega(codigoEsperado)) {
        alert('Código inválido. Peça o código de devolução ao lojista.');
        return;
    }

    const lojistaUid = obterLojistaUidDaRota(rotaObj, pac);
    const envioId = obterIdPacoteConfirmacao(pac);
    if (!lojistaUid || !envioId) return;
    const agora = Date.now();

    try {
        // Marca a devolução como concluída e libera o pacote de volta pra fila de
        // "criar nova rota" — mesmo padrão já usado por setStatusPacotes(id,
        // 'PACOTE_NOVO'): status volta a PACOTE_NOVO e o vínculo com esta rota é
        // removido do envio (a rota em si mantém o pacote no histórico dela, só o
        // envio individual fica livre de novo). Ver project-flexa-cobranca-entrega-dinheiro.
        await sincronizarCamposEnvioLojista(lojistaUid, envioId, {
            devolucaoStatus: 'DEVOLVIDO',
            devolvidoEm: agora,
            status: 'PACOTE_NOVO',
            statusRaw: 'PACOTE_NOVO',
            rotaId: null
        });

        // Mesma lógica de persistirEntregaPacoteAtual: marca essa parada como
        // não entregue (devolvida) no espelho público, pra timeline do
        // cliente final não mostrar "entregue" numa parada que na verdade
        // voltou pro lojista.
        if (rotaObj?.id) {
            db.ref(`rastreioPublico/${rotaObj.id}/pacotes/${envioId}`).update({
                status: 'DEVOLVIDO',
                devolvidoEm: agora
            }).catch(() => {});
        }

        pac.devolucaoStatus = 'DEVOLVIDO';
        pac.status = 'PACOTE_NOVO';
        pac.statusRaw = 'PACOTE_NOVO';

        await finalizarRotaSeCompleta(rotaObj, rotaEntSheetPacotes);

        renderSheetRotaEntregadorConteudo();
    } catch (err) {
        console.warn('Falha ao confirmar código de devolução:', err);
        alert('Não foi possível confirmar a devolução agora. Tente novamente.');
    }
}

async function criarPagamentoPixDevolucaoTesteLocal(pac, rotaId) {
    const valor = Number(pac?.valor || pac?.valorFrete || 0);
    if (!Number.isFinite(valor) || valor <= 0) {
        throw new Error('Valor de frete inválido para cobrança de devolução.');
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
            description: 'Flex - frete de devolução (pedido ' + (pac?.id || '') + ') [TESTE LOCAL]',
            payment_method_id: 'pix',
            payer: { email: obterEmailPagadorTesteLocal(), first_name: firstName, last_name: lastName },
            date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            external_reference: 'devolucao:' + rotaId + ':' + (pac?.id || '')
        })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const detalhe = data?.message || data?.error || data?.cause?.[0]?.description || ('HTTP ' + resp.status);
        throw new Error('Mercado Pago: ' + detalhe);
    }
    const tx = data?.point_of_interaction?.transaction_data || {};
    return {
        paymentId: data?.id ? String(data.id) : '',
        status: data?.status || 'pending',
        pixCode: tx.qr_code || '',
        qrCodeBase64: tx.qr_code_base64 || '',
        valor
    };
}

// A partir daqui o Pix do frete de devolução é do LOJISTA (é ele quem paga o
// frete extra da volta — ver backend /create-pix-devolucao), então o card de
// pagar/ver o Pix vive na tela de tracking do lojista, não no sheet do
// entregador. Ver confirmarDevolucaoComoLojista, que dispara isso assim que o
// lojista confirma que a devolução é real, e liberarCodigoDevolucaoAposPagamento,
// que só gera o código de confirmação depois do Pix pago. Ver
// project-flexa-cobranca-entrega-dinheiro / pedido do dono 2026-08-15.
let pixDevolucaoLojistaAtual = null;
let pixDevolucaoLojistaPollTimer = null;

function pararPollingPixDevolucaoLojista() {
    if (pixDevolucaoLojistaPollTimer) {
        clearInterval(pixDevolucaoLojistaPollTimer);
        pixDevolucaoLojistaPollTimer = null;
    }
}

// Acha o valor do frete de um envio a partir dos dados já carregados na tela
// de tracking do lojista (clientes/pacotesRaizCache acabaram de ser
// atualizados por abrirModalTrackingLoja, então não precisa de outra ida ao banco).
function buscarValorFreteEnvioLojista(envioId) {
    for (const cliente of clientes) {
        const historico = Array.isArray(cliente.historico) ? cliente.historico : [];
        const h = historico.find((x) => x.id === envioId);
        if (h) return Number.isFinite(Number(h.valorFrete)) ? Number(h.valorFrete) : parseMoedaParaNumero(h.valor || 0);
    }
    const uid = getUsuarioIdAtual();
    const pacoteNovo = uid ? window.pacotesRaizCache?.[uid]?.[envioId] : null;
    return Number(pacoteNovo?.valorFrete || 0);
}

async function gerarPixDevolucaoFreteLojista(lojistaUid, rotaId, envioId, pacoteAprox = {}) {
    try {
        let data;
        if (FLEXA_PAYMENTS_PROXY_URL) {
            data = await chamarPaymentsProxy('/create-pix-devolucao', { tenantId: lojistaUid, rotaId, envioId });
        } else if (FLEXA_MP_TEST_TOKEN) {
            data = await criarPagamentoPixDevolucaoTesteLocal(pacoteAprox, rotaId);
        } else {
            throw new Error('Pagamento não configurado: defina FLEXA_PAYMENTS_PROXY_URL (produção) ou FLEXA_MP_TEST_TOKEN (só teste local).');
        }

        const pixCode = normalizarCodigoPix(data.pixCode || '');
        if (!pixCode) throw new Error('Mercado Pago não retornou código Pix.');

        // Saldo disponível do lojista, pra oferecer "Pagar com saldo" no card
        // (mesmo padrão do pagamento de rota, ver pagarDevolucaoComSaldo) —
        // busca ao vivo no Firebase, não usa window.usuarioLogado (cache do login).
        let saldoDisponivel = 0;
        try {
            const saldoSnap = await db.ref(`usuarios/${lojistaUid}/financeiro/saldo`).once('value');
            saldoDisponivel = Number(saldoSnap.val() || 0);
        } catch (err) {
            console.warn('Falha ao ler saldo do lojista para devolução:', err);
        }

        pixDevolucaoLojistaAtual = {
            paymentId: data.paymentId ? String(data.paymentId) : '',
            envioId,
            lojistaUid,
            rotaId,
            pixCode,
            qrCodeBase64: data.qrCodeBase64 || '',
            valor: data.valor || Number(pacoteAprox?.valorFrete || 0),
            saldoDisponivel
        };

        iniciarPollingPixDevolucaoLojista();
    } catch (err) {
        console.warn('Falha ao gerar Pix de devolução (lojista):', err);

        // Mesma escotilha de teste usada no pagamento principal — sem Cloud
        // Function deployada, o navegador não consegue chamar a API do Mercado
        // Pago direto (CORS/rede). Ver feedback_flexa_test_mode_escape_hatches.
        if (!FLEXA_PAYMENTS_PROXY_URL && mercadoPagoAmbienteAtual === 'teste') {
            const simular = confirm(
                'Não foi possível gerar o Pix de devolução (ambiente TESTE).\n\n' +
                'Detalhe: ' + (err?.message || 'erro desconhecido') + '\n\n' +
                'Deseja simular o pagamento do frete de devolução para continuar testando o fluxo?'
            );
            if (simular) {
                await liberarCodigoDevolucaoAposPagamento(lojistaUid, rotaId, envioId);
                return;
            }
        }

        alert(err.message || 'Não foi possível gerar o Pix de devolução agora.');
    }
}

// Mesmo motivo do cobrança-na-entrega: um Pix de TESTE nunca é pago por um
// banco de verdade, então o polling nunca chegaria a "approved" sozinho.
async function simularAprovacaoDevolucaoTeste() {
    if (!pixDevolucaoLojistaAtual) return;
    if (!window.confirm('Simular esse Pix do frete de devolução como pago? Isso só deve ser usado em ambiente de TESTE.')) return;
    const { lojistaUid, rotaId, envioId } = pixDevolucaoLojistaAtual;
    pararPollingPixDevolucaoLojista();
    pixDevolucaoLojistaAtual = null;
    try {
        await liberarCodigoDevolucaoAposPagamento(lojistaUid, rotaId, envioId);
    } catch (err) {
        console.warn('Falha ao simular devolução paga:', err);
        alert('Não foi possível simular o pagamento agora. Tente novamente.');
    }
}

function iniciarPollingPixDevolucaoLojista() {
    pararPollingPixDevolucaoLojista();
    pixDevolucaoLojistaPollTimer = setInterval(async () => {
        if (!pixDevolucaoLojistaAtual?.paymentId) {
            pararPollingPixDevolucaoLojista();
            return;
        }
        try {
            const data = FLEXA_PAYMENTS_PROXY_URL
                ? await chamarPaymentsProxy('/check-pix-devolucao', { tenantId: pixDevolucaoLojistaAtual.lojistaUid, paymentId: pixDevolucaoLojistaAtual.paymentId })
                : await consultarPagamentoPixTesteClienteLocal(pixDevolucaoLojistaAtual.paymentId);

            if (data?.status === 'approved') {
                pararPollingPixDevolucaoLojista();
                const { lojistaUid, rotaId, envioId } = pixDevolucaoLojistaAtual;
                pixDevolucaoLojistaAtual = null;
                await liberarCodigoDevolucaoAposPagamento(lojistaUid, rotaId, envioId);
            }
        } catch (err) {
            console.warn('Falha ao consultar status do Pix de devolução (lojista):', err);
        }
    }, 4000);
}

// Só a partir daqui existe um código de confirmação de devolução — antes disso
// o entregador não vê nem consegue digitar código nenhum (ver
// confirmarCodigoDevolucaoPacoteAtual, que valida contra esse código).
async function liberarCodigoDevolucaoAposPagamento(lojistaUid, rotaId, envioId) {
    const codigo = gerarCodigoConfirmacaoEntrega();
    const agora = Date.now();
    try {
        await sincronizarCamposEnvioLojista(lojistaUid, envioId, {
            devolucaoStatus: 'DEVOLUCAO_PIX_PAGO',
            codigoConfirmacaoDevolucao: codigo,
            devolucaoFretePagoEm: agora
        });
        alert(`Pix do frete de devolução recebido. Informe este código ao entregador quando ele chegar na loja: ${codigo}`);
        if (trackLojaIdAtual && String(trackLojaIdAtual) === String(rotaId)) {
            await abrirModalTrackingLoja(rotaId);
        }
    } catch (err) {
        console.warn('Falha ao liberar código de devolução:', err);
        alert('Pagamento recebido, mas não foi possível liberar o código agora. Reabra esta rota para tentar de novo.');
    }
}

// Alternativa ao Pix: paga o frete de devolução direto do saldo do lojista na
// carteira (mesmo padrão do "Pagar com saldo" do pagamento de rota — ver
// pagarRotaComSaldo). Pedido do dono, 2026-08-16: reaproveitar esse modelo pro
// card de devolução também.
async function pagarDevolucaoComSaldo() {
    if (!pixDevolucaoLojistaAtual) return;
    const { lojistaUid, rotaId, envioId, valor } = pixDevolucaoLojistaAtual;
    if (!lojistaUid || !Number.isFinite(valor) || valor <= 0) return;

    const btn = document.getElementById('track-loja-devolucao-saldo-btn');
    if (btn) { btn.disabled = true; btn.innerText = 'Pagando...'; }

    try {
        const resultado = await ajustarSaldoUsuario(lojistaUid, -valor, { permitirNegativo: false });
        if (!resultado.ok) {
            if (resultado.saldoInsuficiente) {
                alert('Saldo insuficiente para pagar o frete de devolução com a carteira. Use o Pix abaixo.');
            } else {
                alert('Não foi possível pagar com saldo agora. Tente novamente ou use o Pix abaixo.');
            }
            if (btn) { btn.disabled = false; btn.innerText = 'Pagar com saldo'; }
            return;
        }

        await db.ref(`usuarios/${lojistaUid}/financeiro/transacoes`).push({
            protocolo: gerarProtocoloTransacao(),
            tipo: 'DEBITO',
            metodo: 'interno',
            valor,
            descricao: `Frete de devolução pago com saldo (pedido #${envioId})`,
            criadoEm: Date.now()
        }).catch((err) => console.warn('Falha ao registrar débito do frete de devolução:', err));

        pararPollingPixDevolucaoLojista();
        pixDevolucaoLojistaAtual = null;
        await liberarCodigoDevolucaoAposPagamento(lojistaUid, rotaId, envioId);
    } catch (err) {
        console.warn('Falha ao pagar devolução com saldo:', err);
        alert('Não foi possível pagar com saldo agora. Tente novamente ou use o Pix abaixo.');
        if (btn) { btn.disabled = false; btn.innerText = 'Pagar com saldo'; }
    }
}

function copiarCodigoPixDevolucaoLojista() {
    if (!pixDevolucaoLojistaAtual?.pixCode) return;
    navigator.clipboard?.writeText(pixDevolucaoLojistaAtual.pixCode).then(() => {
        const feedback = document.getElementById('track-loja-pix-devolucao-copy-feedback');
        if (feedback) feedback.innerText = 'Código copiado!';
        notificarSucesso('Código Pix copiado!');
    }).catch(() => notificarErro('Não foi possível copiar automaticamente.'));
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

        // Manda o código de confirmação de entrega aqui de novo (já foi mostrado
        // uma vez na criação do envio) — na prática o lojista repassa pro
        // cliente perto da hora da entrega, não semanas antes. Pedido do dono,
        // 2026-09-19. O código NUNCA aparece pro entregador em lugar nenhum —
        // só o cliente/lojista sabem, o entregador tem que perguntar na porta.
        // Coleta reversa (2ª perna, indo devolver na loja): quem confirma
        // aqui é o próprio LOJISTA, não repassa código a ninguém — mensagem
        // diferente da entrega normal (pedido do dono 2026-09-26).
        const ehColetaReversaAviso = pac?.tipoFluxo === 'coleta_reversa';
        const codigoEntregaAviso = obterCodigoConfirmacaoEsperado(pac);
        criarNotificacao(lojistaUidCorrida, {
            tipo: 'corrida_iniciada',
            titulo: ehColetaReversaAviso ? 'Devolução a caminho' : 'Entrega iniciada',
            mensagem: ehColetaReversaAviso
                ? `${window.usuarioLogado?.nome || 'O entregador'} está a caminho da loja pra devolver o pacote de ${obterNomeDestinatarioPacote(pac, rotaEntSheetRotaAtual)}. Código de confirmação: ${codigoEntregaAviso} — informe esse código a ele quando receber.`
                : (codigoEntregaAviso
                    ? `${window.usuarioLogado?.nome || 'O entregador'} iniciou a entrega do pedido de ${obterNomeDestinatarioPacote(pac, rotaEntSheetRotaAtual)}. Código de confirmação: ${codigoEntregaAviso} — repasse ao cliente, ele deve informar ao entregador na entrega.`
                    : `${window.usuarioLogado?.nome || 'O entregador'} iniciou a entrega do pedido de ${obterNomeDestinatarioPacote(pac, rotaEntSheetRotaAtual)}.`),
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

// Fase 1 da coleta reversa: ir até o CLIENTE retirar o pacote (equivalente
// ao "Iniciar Corrida" normal, mas navegando pra ORIGEM — que pra um pacote
// coleta_reversa é o endereço do cliente, já invertido desde a criação do
// envio, ver confirmarEnvioFinal). Pedido do dono 2026-09-26.
function iniciarRetiradaPacoteAtual(btn) {
    const rotaId = rotaEntSheetRotaAtual?.id;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    if (!rotaId || !pac) return;

    setEstadoPacoteRota(rotaId, pac, { status: 'em_corrida' }, rotaEntSheetIndex);

    if (btn) {
        btn.classList.add('sliding');
        setTimeout(() => btn.classList.remove('sliding'), 800);
    }

    let origem = '';
    if (pac.origemGeo?.lat && pac.origemGeo?.lon) {
        origem = `${pac.origemGeo.lat},${pac.origemGeo.lon}`;
    } else {
        origem = encodeURIComponent(pac.origemEndereco || pac.origemCompleta || '');
    }
    if (!origem) {
        alert('Endereço do cliente não informado.');
        setEstadoPacoteRota(rotaId, pac, { status: 'pendente' }, rotaEntSheetIndex);
        return renderSheetRotaEntregadorConteudo();
    }
    const url = `https://www.google.com/maps/dir/?api=1&destination=${origem}`;
    setTimeout(() => window.open(url, '_blank'), 250);
    renderSheetRotaEntregadorConteudo();
}

// Confirma a retirada com o cliente (código de retirada, informado pelo
// CLIENTE) — ao confirmar, marca a bolinha da timeline pública como
// retirada (verde) e RESETA o estado local do pacote, pra ele cair no fluxo
// normal de "Iniciar Corrida" logo em seguida, dessa vez indo pro destino
// real (a loja) com o código de devolução.
async function confirmarRetiradaPacoteAtual() {
    const rotaId = rotaEntSheetRotaAtual?.id;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    if (!rotaId || !pac) return;

    const estado = obterEstadoPacoteRota(rotaId, pac, rotaEntSheetIndex);
    const codigo = (estado.codigoConfirmacao || '').trim();
    if (!codigo) {
        alert('Digite o código de retirada informado pelo cliente.');
        return;
    }

    const codigoEsperado = String(pac?.codigoConfirmacaoRetirada || '').trim();
    if (!codigoEsperado) {
        alert('Pacote sem código de retirada gerado. Feche e reabra a rota.');
        return;
    }
    if (normalizarCodigoConfirmacaoEntrega(codigo) !== normalizarCodigoConfirmacaoEntrega(codigoEsperado)) {
        alert('Código inválido. Peça o código de retirada ao cliente.');
        return;
    }

    const lojistaUid = obterLojistaUidDaRota(rotaEntSheetRotaAtual, pac);
    const envioId = obterIdPacoteConfirmacao(pac);
    const agora = Date.now();

    try {
        if (lojistaUid && envioId) {
            await sincronizarCamposEnvioLojista(lojistaUid, envioId, {
                retiradaConfirmada: true,
                retiradaConfirmadaEm: agora
            });
            criarNotificacao(lojistaUid, {
                tipo: 'retirada_confirmada',
                titulo: 'Pacote retirado',
                mensagem: `${window.usuarioLogado?.nome || 'O entregador'} retirou o pacote de ${obterNomeDestinatarioPacote(pac, rotaEntSheetRotaAtual)} e está a caminho da loja.`,
                rotaId: String(rotaId)
            });
        }
        // Bolinha da timeline pública fica verde aqui — mesmo padrão já usado
        // pra coletaConfirmada (confirmarColetaPacotes) e chegada (confirmarCheguei).
        if (envioId) {
            await db.ref(`rastreioPublico/${rotaId}/pacotes/${envioId}`).update({
                retiradaConfirmada: true
            }).catch(() => {});
        }
    } catch (err) {
        console.warn('Falha ao confirmar retirada:', err);
        alert('Não foi possível confirmar a retirada agora. Tente novamente.');
        return;
    }

    pac.retiradaConfirmada = true;
    // Reseta o estado local desse pacote — a partir daqui ele cai no fluxo
    // normal (iniciarCorridaPacoteAtual/confirmarEntregaPacoteAtual), como se
    // fosse uma entrega comum, só que rumo à loja com o código de devolução.
    setEstadoPacoteRota(rotaId, pac, { status: 'pendente', codigoConfirmacao: '' }, rotaEntSheetIndex);
    renderSheetRotaEntregadorConteudo();
}

async function confirmarEntregaPacoteAtual() {
    const rotaId = rotaEntSheetRotaAtual?.id;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    if (!rotaId || !pac) return;

    if (pac.cobrancaEntrega?.ativa && pac.cobrancaEntrega.status === 'pendente') {
        alert('Resolva a cobrança deste pedido (Pix ou dinheiro) antes de confirmar a entrega.');
        return;
    }

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

    // Taxa de espera/subida (ver ponto 5, pedido do dono 2026-09-25) — melhor
    // esforço: nunca deve travar a confirmação da entrega em si, só registra
    // o que der (mesma filosofia de isolar side-effects já usada em
    // confirmarExclusaoEnvio, ver project-flexa-cobranca-entrega-dinheiro).
    try {
        await resolverTaxaEsperaSubidaAntesDeEntregar(rotaEntSheetRotaAtual, pac);
    } catch (err) {
        console.warn('Falha ao resolver taxa de espera/subida:', err);
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

// ===== [TAXA DE ESPERA / SUBIDA] (2026-09-25) =====
// Ponto 5 do pedido do dono: entregador aperta "Cheguei", cliente pode pedir
// pra ele subir até o apartamento. 100% do valor é do entregador — nunca da
// plataforma. Se o cliente pagar em dinheiro na hora, o entregador só fica
// com o dinheiro (nenhum lançamento). Se não (Pix junto com outra cobrança,
// ou corrida já paga), vira uma dívida do LOJISTA pro ENTREGADOR — o lojista
// paga por fora usando a chave Pix do entregador (mesmo modelo do saque:
// mostra os dados, a pessoa paga manual, confirma depois) e fica com "Novo
// Envio" bloqueado até o próprio entregador confirmar que recebeu.

async function confirmarCheguei() {
    const rotaObj = rotaEntSheetRotaAtual;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    const rotaId = rotaObj?.id;
    if (!rotaId || !pac) return;

    const lojistaUid = obterLojistaUidDaRota(rotaObj, pac);
    const envioId = obterIdPacoteConfirmacao(pac);
    const agora = Date.now();

    try {
        if (lojistaUid && envioId) {
            await sincronizarCamposEnvioLojista(lojistaUid, envioId, { 'esperaEntrega/chegouEm': agora });
        }
        await db.ref(`rastreioPublico/${rotaId}/pacotes/${envioId}`).update({
            entregadorChegou: true,
            chegouEm: agora
        }).catch(() => {});

        pac.esperaEntrega = { ...(pac.esperaEntrega || {}), chegouEm: agora };
        renderSheetRotaEntregadorConteudo();
    } catch (err) {
        console.warn('Falha ao registrar chegada:', err);
        alert('Não foi possível registrar sua chegada agora. Tente de novo.');
    }
}

async function responderSolicitacaoSubida(aceitar) {
    const rotaObj = rotaEntSheetRotaAtual;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    const rotaId = rotaObj?.id;
    if (!rotaId || !pac) return;

    const lojistaUid = obterLojistaUidDaRota(rotaObj, pac);
    const envioId = obterIdPacoteConfirmacao(pac);
    const novoStatus = aceitar ? 'aceito' : 'recusado';

    try {
        if (lojistaUid && envioId) {
            await sincronizarCamposEnvioLojista(lojistaUid, envioId, { 'esperaEntrega/subirStatus': novoStatus, 'esperaEntrega/subirRespondidoEm': Date.now() });
        }
        await db.ref(`rastreioPublico/${rotaId}/pacotes/${envioId}`).update({ subirStatus: novoStatus }).catch(() => {});

        pac.esperaEntrega = { ...(pac.esperaEntrega || {}), subirStatus: novoStatus };
        pararListenerEsperaPacote();
        renderSheetRotaEntregadorConteudo();
    } catch (err) {
        console.warn('Falha ao responder pedido de subida:', err);
        alert('Não foi possível registrar sua resposta agora. Tente de novo.');
    }
}

function aceitarSolicitacaoSubida() {
    responderSolicitacaoSubida(true);
}

function recusarSolicitacaoSubida() {
    responderSolicitacaoSubida(false);
}

function gerenciarListenerEsperaPacote(rotaId, pacoteId) {
    const chave = `${rotaId}|${pacoteId}`;
    if (rotaEntSheetEsperaListenerChave === chave && rotaEntSheetEsperaListenerRef) return;
    pararListenerEsperaPacote();
    if (!rotaId || !pacoteId) return;

    rotaEntSheetEsperaListenerChave = chave;
    rotaEntSheetEsperaListenerRef = db.ref(`rastreioPublico/${rotaId}/pacotes/${pacoteId}`);
    rotaEntSheetEsperaListenerRef.on('value', (snap) => {
        const dados = snap.val() || {};
        const pacAtual = rotaEntSheetPacotes[rotaEntSheetIndex];
        if (!pacAtual || obterIdPacoteConfirmacao(pacAtual) !== pacoteId) return;
        if ((dados.subirStatus || null) === (pacAtual.esperaEntrega?.subirStatus || null)) return;
        pacAtual.esperaEntrega = { ...(pacAtual.esperaEntrega || {}), subirStatus: dados.subirStatus || null };
        renderSheetRotaEntregadorConteudo();
    });
}

function pararListenerEsperaPacote() {
    if (rotaEntSheetEsperaListenerRef) {
        rotaEntSheetEsperaListenerRef.off();
        rotaEntSheetEsperaListenerRef = null;
    }
    rotaEntSheetEsperaListenerChave = '';
}

// Calcula e resolve a taxa de espera/subida na hora de confirmar a entrega
// (chamada de dentro de confirmarEntregaPacoteAtual, antes de persistir a
// entrega em si). Pergunta ao entregador se recebeu em dinheiro; se não,
// vira dívida do lojista com ele.
//
// SEGURANÇA (2026-09-27): o cálculo do valor e a gravação da dívida (que
// mexe em dinheiro de OUTRO usuário) migraram pra Cloud Function
// (/resolver-taxa-espera em backend/functions/index.js) — antes rodava tudo
// aqui no navegador do entregador, então um cliente adulterado podia mandar
// qualquer valor pra qualquer lojistaUid sem nenhuma validação. O cálculo
// abaixo (minutosEspera/valorTaxaEstimado) agora serve só de ESTIMATIVA pra
// mostrar no texto da confirmação — o valor que de fato é gravado é
// recalculado no servidor a partir de esperaEntrega.chegouEm/subirStatus já
// persistidos, nunca confia no que sai daqui.
async function resolverTaxaEsperaSubidaAntesDeEntregar(rotaObj, pac) {
    const espera = pac?.esperaEntrega || {};
    if (espera.finalizada) return;

    const lojistaUid = obterLojistaUidDaRota(rotaObj, pac);
    const envioId = obterIdPacoteConfirmacao(pac);
    const rotaId = rotaObj?.id;
    if (!lojistaUid || !envioId || !rotaId) return;

    const chegouEm = Number(espera.chegouEm) || 0;
    const minutosEsperaEstimado = chegouEm ? Math.max(0, Math.round((Date.now() - chegouEm) / 60000) - TAXA_ESPERA_GRACE_MIN) : 0;
    const valorEsperaEstimado = Number((minutosEsperaEstimado * TAXA_ESPERA_POR_MIN).toFixed(2));
    const valorSubirEstimado = espera.subirStatus === 'aceito' ? TAXA_SUBIR_FIXA : 0;
    const valorTaxaEstimado = Number((valorEsperaEstimado + valorSubirEstimado).toFixed(2));

    let recebeuEmDinheiro = false;
    if (valorTaxaEstimado > 0) {
        const partes = [];
        if (valorEsperaEstimado > 0) partes.push(`${minutosEsperaEstimado} min de espera (${precoParaMoeda(valorEsperaEstimado)})`);
        if (valorSubirEstimado > 0) partes.push(`subida no local (${precoParaMoeda(valorSubirEstimado)})`);
        const motivo = partes.join(' + ');

        recebeuEmDinheiro = window.confirm(
            `Taxa extra pra você: ${precoParaMoeda(valorTaxaEstimado)} (${motivo}).\n\n` +
            `Você recebeu esse valor EM DINHEIRO do cliente agora?\n\n` +
            `OK = recebi em dinheiro (fica com você)\nCancelar = não recebi (a loja te paga via Pix depois)`
        );
    } else if (!chegouEm) {
        // nunca chegou a registrar "cheguei" nessa entrega — não tem taxa
        // nenhuma a resolver, nem precisa chamar o servidor.
        return;
    }

    try {
        await chamarPaymentsProxy('/resolver-taxa-espera', {
            tenantId: lojistaUid,
            rotaId,
            envioId,
            recebeuEmDinheiro
        });
    } catch (err) {
        console.warn('Falha ao resolver taxa de espera:', err);
        if (valorTaxaEstimado > 0) alert('Não foi possível registrar a taxa de espera agora. Tente novamente.');
    }
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

// ===================== [CAPACIDADE PRA ACEITAR ROTA COM COBRANÇA] =====================
// Rota com envio de cobrança-na-entrega em dinheiro fica visível pra todo
// entregador (sem filtro de plano — ainda não existe sistema de planos), mas
// o ACEITE é bloqueado se ele não tiver capacidade financeira suficiente.
// Ver project-flexa-cobranca-entrega-dinheiro pros exemplos numéricos.
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

    // As checagens (bloqueio por dívida, capacidade de cobrança em dinheiro) e a
    // aceitação em si (transação condicional + espelhos nos dois modelos) agora
    // rodam no servidor (plano de segurança 2026-09-27, ver /aceitar-rota-marketplace
    // em backend/functions/index.js) — a regra do banco pra "rotas" é auth != null,
    // então antes bastava chamar essa função direto do console pra pular todas as
    // checagens, ou até sobrescrever entregadorId de uma rota já aceita por outro.
    try {
        const resp = await chamarPaymentsProxy('/aceitar-rota-marketplace', { lojistaUid, rotaId });
        const rotaAtualizada = resp?.rota || {};

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
        const motivo = err?.motivo;
        if (motivo === 'bloqueado_divida') {
            alert('Sua conta está bloqueada para novos envios: você tem uma dívida em aberto há mais de 5 dias. Vá em Perfil > Pagamento e paga a dívida via Pix pra liberar.');
        } else if (motivo === 'capacidade_insuficiente') {
            alert('Você não pode aceitar essa corrida agora — seu saldo está baixo. Aceite ou conclua mais corridas para liberar.');
        } else if (motivo === 'ja_aceita') {
            alert('Essa rota ja foi aceita por outro entregador.');
            await renderRotasMarketplaceEntregador(true);
        } else if (motivo === 'flash_pendente') {
            alert('Você tem uma entrega Flash/Expresso pendente (prazo de 2h) — finalize essa entrega antes de aceitar outra rota. Veja a aba Rotas > Entregas.');
        } else {
            console.warn('Erro ao aceitar rota marketplace:', err);
            alert('Nao foi possivel aceitar essa rota agora. Tente novamente.');
        }
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
// ===== [ENTREGAS AGRUPADAS POR BAIRRO] (pedido do dono 2026-09-29) =====
// Junta os pacotes pendentes de TODAS as rotas EM_ROTA do entregador (podem
// ser de lojas diferentes) numa lista única, agrupada Cidade > Bairro >
// Logradouro (ordem alfabética, do menor pro maior) — assim ele entrega tudo
// de uma rua/bairro de uma vez, sem descobrir depois que tinha outro pedido
// bem perto e precisar voltar. Reordenação manual (setas) fica só na sessão
// atual — é um ajuste pontual do entregador, não precisa sincronizar entre
// dispositivos nem sobreviver a um F5.
let entregadorOrdemManual = new Map(); // pacoteId -> posição efetiva (sessão)

// Prazo de entrega Flash/Expresso (pedido do dono 2026-09-29): 2h a partir
// do aceite da rota (rota.aceitoEm, já gravado de verdade pelo backend —
// ver /aceitar-rota-marketplace). Sem campo novo no banco: o prazo é
// sempre recalculado aqui a partir do aceitoEm.
const FLASH_PRAZO_MS = 2 * 60 * 60 * 1000;
let entregadorFlashTimerInterval = null;

function pacoteEhFlashEntregador(pac = {}) {
    const servico = (pac?.servico || '').toString().toLowerCase();
    return servico.includes('flash') || servico.includes('expresso');
}

function formatarContagemFlash(prazoFlashAte) {
    const restanteMs = prazoFlashAte - Date.now();
    const restanteMin = Math.round(Math.abs(restanteMs) / 60000);
    const h = Math.floor(restanteMin / 60);
    const m = restanteMin % 60;
    const txtTempo = h > 0 ? `${h}h ${m}min` : `${m}min`;
    if (restanteMs < 0) return { texto: `Atrasado ${txtTempo}`, classe: 'flash-critico' };
    if (restanteMs <= 30 * 60000) return { texto: `${txtTempo} restantes`, classe: 'flash-alerta' };
    return { texto: `${txtTempo} restantes`, classe: 'flash-ok' };
}

function atualizarTimersFlashEntregador() {
    document.querySelectorAll('[data-flash-deadline]').forEach((el) => {
        const prazo = Number(el.dataset.flashDeadline);
        if (!Number.isFinite(prazo)) return;
        const { texto, classe } = formatarContagemFlash(prazo);
        el.textContent = texto;
        el.className = `entregas-flash-timer ${classe}`;
    });
}

function iniciarTimerFlashEntregador() {
    pararTimerFlashEntregador();
    entregadorFlashTimerInterval = setInterval(atualizarTimersFlashEntregador, 1000);
}

function pararTimerFlashEntregador() {
    if (entregadorFlashTimerInterval) clearInterval(entregadorFlashTimerInterval);
    entregadorFlashTimerInterval = null;
}

function extrairLogradouroPacoteEntregador(pac = {}) {
    const direto = (pac?.rua || pac?.logradouro || '').toString().trim();
    if (direto) return direto;
    const endereco = (pac?.destinoCompleto || pac?.destinoEndereco || pac?.destino || '').toString().trim();
    if (!endereco) return '';
    return endereco.split(',')[0].trim();
}

async function coletarStopsPendentesEntregador() {
    const rotasNo = window.usuarioLogado?.rotas || {};
    const rotasEmRota = Object.keys(rotasNo)
        .map((id) => ({ id, ...(rotasNo[id] || {}) }))
        .filter((r) => normalizarStatusRotaFiltro(r?.status || r?.pagamentoStatus || 'CRIADA') === 'EM_ROTA');

    const stops = [];
    for (const rota of rotasEmRota) {
        let pacotes = await garantirPacotesDaRota(rota);
        if (!pacotes || !pacotes.length) pacotes = prepararPacotesRotaEntregador(rota);
        pacotes.forEach((p, idx) => {
            const status = normalizarStatusPacoteEntrega(p?.status);
            if (status === 'CONCLUIDO' || status === 'CANCELADO') return;
            const cidade = (p?.cidade || obterCidadeDestinoPacoteMarketplace(p) || rota?.origemCidade || '').toString().trim() || 'Cidade não informada';
            const bairro = (p?.bairroDestino || p?.bairro || '').toString().trim() || 'Bairro não informado';
            const logradouro = extrairLogradouroPacoteEntregador(p) || 'Endereço não informado';
            const isFlash = pacoteEhFlashEntregador(p);
            const aceitoEm = Number(rota?.aceitoEm || rota?.atualizadoEm || rota?.criadoEm || Date.now());
            stops.push({
                pacoteId: String(p?.id || `${rota.id}-${idx}`),
                rotaId: rota.id,
                lojistaNome: (rota?.lojistaNome || 'Lojista').toString().trim() || 'Lojista',
                destinatario: (p?.destinatario || p?.clienteNome || 'Cliente').toString().trim() || 'Cliente',
                enderecoCompleto: montarEnderecoCompletoPacote(p, rota),
                cidade,
                bairro,
                logradouro,
                valorFrete: Number(p?.valorFrete || 0),
                isFlash,
                prazoFlashAte: isFlash ? (aceitoEm + FLASH_PRAZO_MS) : null
            });
        });
    }
    return stops;
}

function ordenarStopsEntregador(stops) {
    // Flash/Expresso (prazo de 2h) sempre primeiro, sem exceção — não entra
    // na reordenação manual do resto da lista, nem pode ser empurrado pra
    // baixo sem querer (pedido do dono 2026-09-29: "sem chances de pular
    // essa entrega"). Entre vários flash, o de prazo mais próximo vem antes.
    const flashStops = stops.filter((s) => s.isFlash).sort((a, b) => a.prazoFlashAte - b.prazoFlashAte);
    const normais = stops.filter((s) => !s.isFlash);

    const auto = [...normais].sort((a, b) => (
        a.cidade.localeCompare(b.cidade, 'pt-BR')
        || a.bairro.localeCompare(b.bairro, 'pt-BR')
        || a.logradouro.localeCompare(b.logradouro, 'pt-BR')
        || a.destinatario.localeCompare(b.destinatario, 'pt-BR')
    ));
    auto.forEach((s, idx) => { s.ordemAuto = idx; });
    const normaisOrdenados = auto
        .map((s) => ({ ...s, ordemEfetiva: entregadorOrdemManual.has(s.pacoteId) ? entregadorOrdemManual.get(s.pacoteId) : s.ordemAuto }))
        .sort((a, b) => a.ordemEfetiva - b.ordemEfetiva);

    return [...flashStops, ...normaisOrdenados];
}

function moverStopEntregadorOrdem(pacoteId, direcao) {
    const lista = window.entregadorStopsOrdenadosCache || [];
    const idx = lista.findIndex((s) => s.pacoteId === pacoteId);
    const alvo = idx + direcao;
    if (idx < 0 || alvo < 0 || alvo >= lista.length) return;
    const a = lista[idx];
    const b = lista[alvo];
    if (a.isFlash || b.isFlash) return; // flash nunca reordena
    entregadorOrdemManual.set(a.pacoteId, b.ordemEfetiva);
    entregadorOrdemManual.set(b.pacoteId, a.ordemEfetiva);
    renderAbaEntregasEntregador();
}

function montarStopEntregadorHtml(stop, idx, total, mostrarCidade, mostrarBairro, mostrarLogradouro) {
    const precoTxt = precoParaMoeda(stop.valorFrete);
    const pacoteIdEsc = String(stop.pacoteId).replace(/'/g, "\\'");
    const rotaIdEsc = escaparHtmlMarketplace(String(stop.rotaId));

    const reorderHtml = stop.isFlash
        ? `<div class="entregas-stop-reorder entregas-stop-reorder-flash"><i data-lucide="zap" size="16"></i></div>`
        : `<div class="entregas-stop-reorder">
                <button type="button" onclick="moverStopEntregadorOrdem('${pacoteIdEsc}', -1)" ${idx === 0 ? 'disabled' : ''} aria-label="Mover pra cima"><i data-lucide="chevron-up" size="16"></i></button>
                <button type="button" onclick="moverStopEntregadorOrdem('${pacoteIdEsc}', 1)" ${idx === total - 1 ? 'disabled' : ''} aria-label="Mover pra baixo"><i data-lucide="chevron-down" size="16"></i></button>
           </div>`;

    const flashBadgeHtml = stop.isFlash
        ? `<div class="entregas-stop-flash-row">
                <span class="entregas-flash-badge">⚡ FLASH</span>
                <span class="entregas-flash-timer" data-flash-deadline="${stop.prazoFlashAte}">--</span>
           </div>`
        : '';

    return `
        ${mostrarCidade ? `<div class="entregas-grupo-cidade"><i data-lucide="map-pin" size="13"></i>${escaparHtmlMarketplace(stop.cidade)}</div>` : ''}
        ${mostrarBairro ? `<div class="entregas-grupo-bairro">${escaparHtmlMarketplace(stop.bairro)}</div>` : ''}
        ${mostrarLogradouro ? `<div class="entregas-grupo-rua"><i data-lucide="minus" size="11"></i>${escaparHtmlMarketplace(stop.logradouro)}</div>` : ''}
        <div class="entregas-stop-card${stop.isFlash ? ' entregas-stop-card-flash' : ''}">
            ${reorderHtml}
            <div class="entregas-stop-info">
                ${flashBadgeHtml}
                <strong>${escaparHtmlMarketplace(stop.destinatario)}</strong>
                <small>${escaparHtmlMarketplace(stop.enderecoCompleto || stop.logradouro)}</small>
                <span class="entregas-stop-loja">${escaparHtmlMarketplace(stop.lojistaNome)}</span>
            </div>
            <div class="entregas-stop-right">
                <span class="entregas-stop-valor">${escaparHtmlMarketplace(precoTxt)}</span>
                <button type="button" class="entregas-stop-btn${stop.isFlash ? ' entregas-stop-btn-flash' : ''}" onclick="abrirSheetRotaEntregador('${rotaIdEsc}')">Entregar</button>
            </div>
        </div>
    `;
}

async function renderAbaEntregasEntregador() {
    const container = document.getElementById('entregador-entregas-conteudo');
    if (!container) return;
    container.innerHTML = '<div class="rotas-ent-empty">Carregando entregas...</div>';

    const stops = await coletarStopsPendentesEntregador();
    if (!stops.length) {
        container.innerHTML = '<div class="rotas-ent-empty">Nenhuma entrega pendente agora.</div>';
        return;
    }
    const ordenados = ordenarStopsEntregador(stops);
    window.entregadorStopsOrdenadosCache = ordenados;

    const qtdFlash = ordenados.filter((s) => s.isFlash).length;
    const bannerFlash = qtdFlash
        ? `<div class="entregas-flash-banner"><i data-lucide="zap" size="15"></i> ${qtdFlash > 1 ? `${qtdFlash} entregas Flash pendentes` : '1 entrega Flash pendente'} — entregue antes de tudo, você não pode aceitar rota nova até resolver.</div>`
        : '';

    let cidadeAnt = null, bairroAnt = null, ruaAnt = null;
    const html = ordenados.map((stop, idx) => {
        const mostrarCidade = stop.cidade !== cidadeAnt;
        const mostrarBairro = mostrarCidade || stop.bairro !== bairroAnt;
        const mostrarLogradouro = mostrarBairro || stop.logradouro !== ruaAnt;
        cidadeAnt = stop.cidade; bairroAnt = stop.bairro; ruaAnt = stop.logradouro;
        return montarStopEntregadorHtml(stop, idx, ordenados.length, mostrarCidade, mostrarBairro, mostrarLogradouro);
    }).join('');

    container.innerHTML = `${bannerFlash}<div class="entregas-agrupadas-lista">${html}</div>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    atualizarTimersFlashEntregador();
    if (qtdFlash) iniciarTimerFlashEntregador();
    else pararTimerFlashEntregador();
}

async function renderAbaHistoricoEntregador() {
    const container = document.getElementById('rotas-painel-historico');
    if (!container) return;
    container.innerHTML = '<div class="rotas-ent-empty">Carregando histórico...</div>';

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
            return { ...r, id: r.id, statusNorm, statusVisual };
        })
        .filter((r) => ['EM_ROTA', 'CONCLUIDO', 'CANCELADO'].includes(r.statusNorm))
        .sort((a, b) => Number(b?.atualizadoEm || b?.criadoEm || 0) - Number(a?.atualizadoEm || a?.criadoEm || 0));

    container.innerHTML = listaRotas.length
        ? `<div class="rotas-entregador-list">${listaRotas.map((r) => montarCardHistoricoRotaEntregador(r)).join('')}</div>`
        : '<div class="rotas-ent-empty">Nenhuma rota em andamento ou finalizada.</div>';

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function alternarAbaRotasEntregador(aba) {
    const btnEntregas = document.getElementById('rotas-tab-entregas');
    const btnHistorico = document.getElementById('rotas-tab-historico');
    const painelEntregas = document.getElementById('rotas-painel-entregas');
    const painelHistorico = document.getElementById('rotas-painel-historico');
    if (!btnEntregas || !btnHistorico || !painelEntregas || !painelHistorico) return;

    const ehEntregas = aba === 'entregas';
    btnEntregas.classList.toggle('active', ehEntregas);
    btnHistorico.classList.toggle('active', !ehEntregas);
    painelEntregas.classList.toggle('hidden', !ehEntregas);
    painelHistorico.classList.toggle('hidden', ehEntregas);

    if (ehEntregas) {
        renderAbaEntregasEntregador();
    } else {
        pararTimerFlashEntregador();
        renderAbaHistoricoEntregador();
    }
}

async function renderHistoricoRotasEntregador() {
    const shell = document.getElementById('entregador-rotas-shell');
    if (!shell || !usuarioEhEntregador()) return;

    shell.classList.remove('hidden');

    const headerHtml = renderHeaderGlobal('entregador', Number(window.usuarioLogado?.financeiro?.saldo || 0));
    shell.innerHTML = `
        ${headerHtml}
        <div class="rotas-ent-tabs">
            <button type="button" id="rotas-tab-entregas" class="rotas-ent-tab active" onclick="alternarAbaRotasEntregador('entregas')">
                <i data-lucide="route" size="15"></i> Entregas
            </button>
            <button type="button" id="rotas-tab-historico" class="rotas-ent-tab" onclick="alternarAbaRotasEntregador('historico')">
                <i data-lucide="history" size="15"></i> Histórico
            </button>
        </div>
        <div id="rotas-painel-entregas" class="rotas-ent-painel">
            <div id="entregador-entregas-conteudo"><div class="rotas-ent-empty">Carregando entregas...</div></div>
        </div>
        <div id="rotas-painel-historico" class="rotas-ent-painel hidden"></div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
    await renderAbaEntregasEntregador();
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
    filtroEnviosChipAtivo = normalizarTexto((filtro || 'TODOS').toString()).toUpperCase().replace(/\s+/g, '_');
    const row = document.getElementById('envio-filter-row');
    if (row) {
        row.querySelectorAll('[data-envio-filter]').forEach((chip) => {
            const alvo = normalizarTexto((chip.dataset.envioFilter || '').toString()).toUpperCase().replace(/\s+/g, '_');
            chip.classList.toggle('active', alvo === filtroEnviosChipAtivo);
        });
    }
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

// Timeline "real" de uma rota — 1 bolinha por pacote de verdade (capado em 6
// + "+N" de overflow), preenchida conforme cada pacote é entregue/cancelado,
// com % de progresso pra posicionar o ícone de "em rota" (bike) ao longo da
// linha. Substituiu montarTimelineRastreamento/getEtapaRastreamento (BUG
// CORRIGIDO 2026-09-26: aquela versão sempre desenhava 4 bolinhas genéricas
// e um ícone de bike parado num canto fixo, sem nenhuma relação com a
// quantidade real de paradas da rota nem com o progresso real dela).
// dotClass permite reaproveitar o mesmo cálculo tanto no card "Em Rota" da
// home (.home-route-dot) quanto no modal "Rastrear Rotas" (.rastrear-dot).
// onclickPorIndice é opcional (usado pelo sheet "Acompanhar entrega" do
// lojista pra abrir a info da parada ao tocar num dot — ver abrirModalTrackingLoja)
// — sem ele, os dots ficam só visuais, igual sempre foram no card "Em Rota"
// da home e no modal "Rastrear Rotas".
function montarTimelineRealRota(pacotes, totalFallback, dotClass, onclickPorIndice) {
    const CAP_DOTS_VISIVEIS = 6;
    const pacoteEstaConcluido = (p) => {
        if (!p) return false;
        const st = normalizarStatusEnvioFiltro(p?.status || p?.statusRaw || '');
        return st === 'ENTREGUE' || st === 'CANCELADO';
    };
    const totalPacotes = pacotes.length || Math.max(1, Number(totalFallback || 0)) || 1;
    const pacotesOrdenados = pacotes.length ? pacotes : Array.from({ length: totalPacotes });
    const concluidos = pacotesOrdenados.filter(pacoteEstaConcluido).length;
    const progressoPct = totalPacotes > 0 ? Math.max(0, Math.min(100, Math.round((concluidos / totalPacotes) * 100))) : 0;
    const onclickAttr = (idx) => (onclickPorIndice ? ` onclick="${onclickPorIndice(idx)}"` : '');

    let html;
    if (totalPacotes <= CAP_DOTS_VISIVEIS) {
        html = pacotesOrdenados.slice(0, totalPacotes).map((p, idx) =>
            `<span class="${dotClass} ${pacoteEstaConcluido(p) ? 'done' : ''}"${onclickAttr(idx)}></span>`
        ).join('');
    } else {
        const visiveis = pacotesOrdenados.slice(0, CAP_DOTS_VISIVEIS - 1);
        const restantes = pacotesOrdenados.slice(CAP_DOTS_VISIVEIS - 1);
        const restantesDoneCount = restantes.filter(pacoteEstaConcluido).length;
        const restantesPct = restantes.length ? Math.round((restantesDoneCount / restantes.length) * 100) : 0;
        const dotsVisiveisHtml = visiveis.map((p, idx) =>
            `<span class="${dotClass} ${pacoteEstaConcluido(p) ? 'done' : ''}"${onclickAttr(idx)}></span>`
        ).join('');
        const moreHtml = `<span class="home-route-more" style="background:linear-gradient(90deg, #da6f18 ${restantesPct}%, #d6deea ${restantesPct}%);" title="${restantesDoneCount}/${restantes.length} entregues">+${restantes.length}</span>`;
        html = dotsVisiveisHtml + moreHtml;
    }

    return { html, progressoPct };
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

        let { html: dotsHtml, progressoPct } = montarTimelineRealRota(pacotes, qtd, 'rastrear-dot');
        if (statusNorm === 'CONCLUIDO') progressoPct = 100;
        if (statusNorm === 'BUSCANDO') progressoPct = 0;
        // Clamp ajustado pro ícone real (.rastrear-track-bike, 36px de
        // largura) — a conta antiga (-10px / 100%-20px) presumia um ícone de
        // ~20px e deixava a bolinha vazar pra fora do card perto de 100% de
        // progresso (pedido do dono 2026-10-02: "a bolinha ta colando e
        // ultrapassando o card"). -18px é metade de 36px (centraliza de
        // verdade); 100%-44px garante a borda direita do ícone parando
        // exatamente onde a linha pontilhada termina (mesmo respiro de 8px
        // que .rastrear-track-line já usa dos dois lados).
        const bikeLeft = `clamp(8px, calc(${progressoPct}% - 18px), calc(100% - 44px))`;
        // .rastrear-track-fill começa em left:8px (mesmo respiro da linha
        // pontilhada), mas sua largura era só "${progressoPct}%" — uma
        // porcentagem da caixa INTEIRA do track-wrap, sem descontar esse
        // respiro de 8px nem o de right:8px do outro lado. Em 100% de
        // progresso isso fazia a linha preenchida ultrapassar o fim da
        // linha pontilhada e encostar quase na borda do card (pedido do
        // dono 2026-10-02: "no lado direito a linha encosta no card").
        // Largura corrigida pra ser uma porcentagem só do espaço ENTRE os
        // dois respiros (100% - 16px), não da caixa inteira.
        const fillWidth = `calc(${progressoPct}% - ${(progressoPct * 16 / 100).toFixed(2)}px)`;

        return `
            <button type="button" class="rastrear-card" onclick="abrirModalDetalheRota('${String(rota.id).replace(/'/g, "\\'")}')">
                <div class="rastrear-card-head">
                    <strong>${rota.id}</strong>
                    <span class="rota-main-status ${statusVisual.className}">${statusVisual.label}</span>
                </div>
                <div class="rastrear-card-meta">${qtd} pacote(s) • ${resumoCidade.principal || '--'} • ${precoParaMoeda(Number(rota?.totalFrete || 0))}</div>
                <div class="rastrear-track-wrap">
                    <span class="rastrear-track-time">${tempoHint}</span>
                    <div class="rastrear-track-fill" style="width:${fillWidth};"></div>
                    <div class="rastrear-track-line"></div>
                    <div class="rastrear-track-dots">${dotsHtml}</div>
                    <span class="rastrear-track-bike" style="left:${bikeLeft};"><img src="img/timeline-icon.png" alt=""></span>
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

// ===================== [DIVIDA POR DINHEIRO NA ENTREGA] =====================
// financeiro/divida e SEPARADO de financeiro/saldo de proposito: saldo e sempre
// dinheiro que a plataforma deve ao usuario (carteira, saque, pagar rota com
// saldo); divida e dinheiro fisico que o entregador ficou devendo de volta.
// Nunca misturar os dois campos — combinar so na hora de calcular capacidade
// (ver Cloud Functions /aceitar-rota-marketplace e /creditar-rota-finalizada,
// backend/functions/index.js). Grava financeiro/dividaDesde na primeira vez
// que a divida sai de 0 — usado pro bloqueio de 5 dias.
async function ajustarDividaUsuario(uid, delta) {
    if (!uid || !Number.isFinite(delta) || delta === 0) {
        return { ok: false, dividaAntes: 0, dividaDepois: 0 };
    }

    const dividaRef = db.ref(`usuarios/${uid}/financeiro/divida`);
    let dividaAntes = 0;
    try {
        const snap = await dividaRef.once('value');
        dividaAntes = Number(snap.val() || 0);
    } catch (err) {
        console.warn('Falha ao ler dívida atual:', err);
        return { ok: false, dividaAntes: 0, dividaDepois: 0 };
    }

    const dividaDepois = Math.max(0, Number((dividaAntes + delta).toFixed(2)));
    try {
        await dividaRef.set(dividaDepois);
        const dividaDesdeRef = db.ref(`usuarios/${uid}/financeiro/dividaDesde`);
        if (dividaAntes <= 0 && dividaDepois > 0) {
            await dividaDesdeRef.set(Date.now());
        } else if (dividaDepois <= 0) {
            await dividaDesdeRef.remove();
        }
    } catch (err) {
        console.warn('Falha ao gravar nova dívida:', err);
        return { ok: false, dividaAntes, dividaDepois: dividaAntes };
    }

    return { ok: true, dividaAntes, dividaDepois };
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

    // atualiza também no modelo novo /pacotes (BUG CORRIGIDO 2026-10-02:
    // gravava em 'pacotes/{uid}/{id}', um caminho que nada mais no app lê —
    // o real é 'usuarios/{uid}/pacotes/{id}', mesmo usado por
    // confirmarEnvioFinal/persistirEntregaPacoteAtual).
    if (salvar && uid) {
        alvos.forEach((id) => {
            db.ref(`usuarios/${uid}/pacotes/${id}/status`).set(status).catch(() => {});
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

    // Passo de coleta: lojista precisa ver o codigo pra passar ao entregador
    // (ver memoria project-flexa-cobranca-entrega-dinheiro).
    const coletaAvisoEl = document.getElementById('rota-detalhe-coleta-aviso');
    if (coletaAvisoEl) {
        const precisaColeta = !usuarioEhEntregador()
            && rotaDetalheAtual?.coletaConfirmada !== true
            && rotaDetalheAtual?.codigoConfirmacaoColeta
            && normalizarStatusRotaFiltro(rotaDetalheAtual?.status || rotaDetalheAtual?.pagamentoStatus || 'CRIADA') === 'EM_ROTA';
        coletaAvisoEl.style.display = precisaColeta ? 'flex' : 'none';
        if (precisaColeta) {
            const codigoEl = document.getElementById('rota-detalhe-codigo-coleta');
            if (codigoEl) codigoEl.innerText = rotaDetalheAtual.codigoConfirmacaoColeta;
        }
    }
    if (distEl) distEl.innerText = formatarDistancia(distanciaTotal);
    if (durEl) durEl.innerText = formatarDuracao(duracaoTotal);
    if (paradasEl) paradasEl.innerText = String(totalParadas).padStart(2, '0');
    if (valorEl) valorEl.innerText = precoParaMoeda(valorTotal);
    if (pesoEl) pesoEl.innerText = pacotes.length ? `${pesoTotal.toFixed(1).replace('.', ',')} kg` : '--';
    if (tamEl) tamEl.innerText = tamanhoTotal;
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
        // BUG CORRIGIDO 2026-10-02: só atualizava o modelo antigo (historico)
        // — mesma causa raiz do status ficar preso em "Em rota" depois de
        // aceitar (ver /aceitar-rota-marketplace em backend/functions).
        pacotesIds.forEach((pid) => {
            updates[`usuarios/${lojistaUid}/pacotes/${pid}/status`] = 'BUSCANDO';
            updates[`usuarios/${lojistaUid}/pacotes/${pid}/statusRaw`] = 'BUSCANDO';
            updates[`usuarios/${lojistaUid}/pacotes/${pid}/rotaId`] = null;
            updates[`usuarios/${lojistaUid}/pacotes/${pid}/atualizadoEm`] = agora;
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

    if (!window.pacotesRaizCache) {
        window.pacotesRaizCache = {};
    }

    const usersSnap = await db.ref('usuarios').once('value');
    const usersNo = usersSnap.val() || {};
    adminUsersCache = usersNo;

    // BUG CORRIGIDO 2026-10-02: antes buscava 'pacotes' (raiz) separado — um
    // caminho que nada grava (o pacote real vive em usuarios/{uid}/pacotes,
    // já incluído na leitura de usersNo acima, já que master lê a árvore
    // 'usuarios' inteira). Isso deixava window.pacotesRaizCache sempre vazio
    // e o merge historico+pacotes do admin nunca via o "modelo novo".
    Object.keys(usersNo).forEach((uid) => {
        window.pacotesRaizCache[uid] = usersNo[uid]?.pacotes || {};
    });
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
        } else if (tipo === 'cliente') {
            // BUG CORRIGIDO 2026-10-02: esse else-catch-all contava conta de
            // CLIENTE final (tipo:'cliente', criada por autocadastro/convite
            // na tela de rastreio) como lojista — o card "Lojistas" da Visão
            // Geral divergia do filtro "Lojistas" da aba Usuários, que já
            // tinha sido corrigido pra separar cliente (ver badgeClass logo
            // abaixo, comentário de 2026-09-27). Conta de cliente não entra
            // em nenhum dos 3 cards de topo hoje.
        } else {
            lojas += 1;
            if (estaAtivo) ativosL += 1;
        }
    });

    // Pacotes
    let pacTotal = 0; let pacEmRota = 0; let pacEnt = 0; let pacCanc = 0;
    const pacotesListaAdmin = [];
    const rankingLojistasMap = new Map(); // uid -> { nome, entregues }
    Object.keys(usersNo).forEach((uid) => {
        const nomeLojista = usersNo[uid]?.nome || 'Lojista';
        const clientesNo = usersNo[uid]?.clientes || {};
        Object.keys(clientesNo).forEach((cid) => {
            const hist = Array.isArray(clientesNo[cid]?.historico) ? clientesNo[cid].historico : [];
            hist.forEach((h, idx) => {
                const st = normalizarStatusEnvioFiltro(h.status || h.statusRaw || 'PACOTE_NOVO');
                pacTotal += 1;
                if (st === 'EM_ROTA') pacEmRota += 1;
                else if (st === 'ENTREGUE') pacEnt += 1;
                else if (st === 'CANCELADO') pacCanc += 1;

                pacotesListaAdmin.push({
                    id: h.id || `${cid}-${idx}`,
                    destinatario: clientesNo[cid]?.nome || h.destinatario || 'Cliente',
                    lojistaNome: nomeLojista,
                    status: st,
                    criadoEm: Number(h.criadoEm || 0),
                    entregueEm: Number(h.entregueEm || 0)
                });

                if (st === 'ENTREGUE') {
                    const atual = rankingLojistasMap.get(uid) || { nome: nomeLojista, entregues: 0 };
                    atual.entregues += 1;
                    rankingLojistasMap.set(uid, atual);
                }
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
                    duracaoMin: Number.isFinite(Number(h.duracaoMin)) ? Number(h.duracaoMin) : 0,
                    status: normalizarStatusEnvioFiltro(h.status || h.statusRaw || 'PACOTE_NOVO')
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
                duracaoMin: Number.isFinite(Number(p.duracaoMin)) ? Number(p.duracaoMin) : 0,
                status: normalizarStatusEnvioFiltro(p.status || p.statusRaw || 'PACOTE_NOVO')
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
            const totalParadas = pacIds.length || pacotesDaRota.length;
            const paradasConcluidas = pacotesDaRota.filter((p) => p.status === 'ENTREGUE' || p.status === 'CANCELADO').length;

            rotasRecuperaveis.push({
                ...r,
                id: rid,
                lojistaUid: uid,
                lojistaNome: usersNo[uid]?.nome || 'Lojista',
                entregadorNome: usersNo[String(r.entregadorId || r.aceitoPor || '')]?.nome || '',
                statusNorm,
                destinoPrincipal,
                distanciaTotal: r.distanciaTotal || distSoma,
                duracaoTotal: r.duracaoTotal || durSoma,
                totalParadas,
                paradasConcluidas
            });
        });
    });

    // Ranking de entregadores: quem mais concluiu / mais cancelou rota. Usa
    // rota.entregadorId (ou o antigo aceitoPor) — dado real, já gravado por
    // aceitarRotaMarketplaceEntregador, não é aproximação.
    const rankingEntregadoresMap = new Map(); // uid -> { nome, concluidas, canceladas }
    rotasRecuperaveis.forEach((r) => {
        const entId = String(r.entregadorId || r.aceitoPor || '').trim();
        if (!entId || (r.statusNorm !== 'CONCLUIDO' && r.statusNorm !== 'CANCELADO')) return;
        const atual = rankingEntregadoresMap.get(entId) || { nome: usersNo[entId]?.nome || 'Entregador', concluidas: 0, canceladas: 0 };
        if (r.statusNorm === 'CONCLUIDO') atual.concluidas += 1;
        else atual.canceladas += 1;
        rankingEntregadoresMap.set(entId, atual);
    });

    // Série real dos últimos 7 dias: entregas por dia (pacote.entregueEm) e
    // envios criados por dia (pacote.criadoEm). Não existe "atrasada" nem
    // "cancelado em X" gravado no app hoje — nada de inventar essas séries,
    // só o que dá pra contar de verdade.
    const DIAS_SEMANA_CURTO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const hojeInicio = obterInicioDiaLocal(Date.now());
    const diasSerie = [];
    for (let i = 6; i >= 0; i--) {
        const inicioDia = hojeInicio - i * 86400000;
        diasSerie.push({ inicioDia, fimDia: inicioDia + 86400000, label: DIAS_SEMANA_CURTO[new Date(inicioDia).getDay()], entregues: 0, criados: 0 });
    }
    pacotesListaAdmin.forEach((p) => {
        if (p.entregueEm) {
            const dia = diasSerie.find((d) => p.entregueEm >= d.inicioDia && p.entregueEm < d.fimDia);
            if (dia) dia.entregues += 1;
        }
        if (p.criadoEm) {
            const dia = diasSerie.find((d) => p.criadoEm >= d.inicioDia && p.criadoEm < d.fimDia);
            if (dia) dia.criados += 1;
        }
    });

    // Ganhos da plataforma (pedido do dono 2026-09-27): não é o valor total
    // movimentado — é só a taxa que fica com a Flex depois de repassar o
    // entregador (calcularTaxaPlataformaRota, a mesma conta usada pra saber
    // quanto o entregador recebe). Só conta rota já CONCLUÍDA — em rota ou
    // buscando ainda pode cancelar, não é ganho de verdade ainda.
    diasSerie.forEach((d) => { d.ganhos = 0; });
    let ganhosHoje = 0; let ganhosSemana = 0; let ganhosMes = 0; let ganhosTotal = 0;
    // Comparativo (pedido do dono 2026-09-27): total bruto pago pelo lojista
    // (o frete cheio) vs. total repassado ao entregador — junto com o ganho
    // da plataforma acima, os três batem: pagoLojista = pagoEntregador + taxa.
    let totalPagoLojistaHistorico = 0; let totalPagoEntregadorHistorico = 0;
    const rankingGanhosLojistasMap = new Map(); // uid -> { nome, ganhos }
    const inicioMesGanhosDate = new Date();
    inicioMesGanhosDate.setDate(1);
    inicioMesGanhosDate.setHours(0, 0, 0, 0);
    const inicioMesGanhosTs = inicioMesGanhosDate.getTime();
    const inicioSemanaGanhosTs = hojeInicio - 6 * 86400000;

    // Filtro dia/semana/mês (pedido do dono 2026-09-27): além da série diária
    // (últimos 7 dias, diasSerie acima), monta duas séries a mais — últimas 8
    // semanas (janelas corridas de 7 dias, não semana de calendário) e
    // últimos 6 meses (aí sim de calendário, dia 1 a dia 1) — pro mesmo
    // gráfico de "Ganhos" poder trocar de granularidade.
    const semanaSerieGanhos = [];
    for (let i = 7; i >= 0; i--) {
        const fim = hojeInicio - i * 7 * 86400000 + 86400000;
        const inicio = fim - 7 * 86400000;
        semanaSerieGanhos.push({ inicioDia: inicio, fimDia: fim, label: new Date(inicio).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }), ganhos: 0 });
    }
    const MESES_ABREV_GANHOS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const mesSerieGanhos = [];
    const hojeDateGanhos = new Date();
    for (let i = 5; i >= 0; i--) {
        const d = new Date(hojeDateGanhos.getFullYear(), hojeDateGanhos.getMonth() - i, 1);
        const inicio = d.getTime();
        const fim = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
        mesSerieGanhos.push({ inicioDia: inicio, fimDia: fim, label: MESES_ABREV_GANHOS[d.getMonth()], ganhos: 0 });
    }

    rotasRecuperaveis.forEach((r) => {
        if (r.statusNorm !== 'CONCLUIDO') return;
        const freteRota = Number(r.totalFrete || 0);
        const distRota = Number(r.distanciaTotal || 0);
        const taxa = calcularTaxaPlataformaRota(freteRota, distRota);
        if (taxa <= 0) return;
        const quando = Number(r.atualizadoEm || r.criadoEm || 0);

        ganhosTotal += taxa;
        totalPagoLojistaHistorico += freteRota;
        totalPagoEntregadorHistorico += calcularValorRepasseEntregador(freteRota, distRota);
        if (quando >= hojeInicio) ganhosHoje += taxa;
        if (quando >= inicioSemanaGanhosTs) ganhosSemana += taxa;
        if (quando >= inicioMesGanhosTs) ganhosMes += taxa;

        const diaBucket = diasSerie.find((d) => quando >= d.inicioDia && quando < d.fimDia);
        if (diaBucket) diaBucket.ganhos += taxa;
        const semanaBucket = semanaSerieGanhos.find((d) => quando >= d.inicioDia && quando < d.fimDia);
        if (semanaBucket) semanaBucket.ganhos += taxa;
        const mesBucket = mesSerieGanhos.find((d) => quando >= d.inicioDia && quando < d.fimDia);
        if (mesBucket) mesBucket.ganhos += taxa;

        const atualRank = rankingGanhosLojistasMap.get(r.lojistaUid) || { nome: r.lojistaNome || 'Lojista', ganhos: 0 };
        atualRank.ganhos += taxa;
        rankingGanhosLojistasMap.set(r.lojistaUid, atualRank);
    });

    // Rotas "buscando" há muito tempo sem ninguém aceitar — sinal real de
    // alerta (não é "atraso de entrega" inventado, é literalmente rota parada
    // no marketplace há mais de 2h).
    const agoraAlerta = Date.now();
    const rotasPresasAdmin = rotasRecuperaveis.filter((r) => {
        if (r.statusNorm !== 'BUSCANDO') return false;
        const desde = Number(r.criadoEm || r.atualizadoEm || 0);
        return desde > 0 && (agoraAlerta - desde) > 2 * 60 * 60 * 1000;
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

    renderSaquesPendentesAdmin(usersNo);

    // Tabela usuários
    const usersTable = document.getElementById('adm-users-table');
    if (usersTable) {
        const rows = Object.keys(usersNo).map((uid) => {
            const u = usersNo[uid] || {};
            const tipo = normalizarTexto(u.tipo || 'loja');
            // BUG CORRIGIDO 2026-09-27: cliente caía no else e virava "loja"
            // pro filtro (o texto do badge mostrava "cliente" certo, só o
            // agrupamento/filtro é que misturava as duas categorias).
            const badgeClass = tipo === 'master'
                ? 'master'
                : (tipo === 'entregador' || tipo === 'entrega')
                    ? 'entregador'
                    : tipo === 'cliente' ? 'cliente' : 'loja';
            const status = u.status || 'ativo';
            return `
                <div class="admin-row" data-tipo="${badgeClass}">
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

    // Tabela de rotas — reconstruída 2026-09-19 (era cards simples, virou
    // tabela de verdade com progresso real de paradas e botão de excluir).
    const rotasTable = document.getElementById('adm-rotas-cards');
    if (rotasTable) {
        const statusOpsRota = [
            { value: 'BUSCANDO', label: 'Buscando' },
            { value: 'EM_ROTA', label: 'Em Rota' },
            { value: 'CONCLUIDO', label: 'Concluída' },
            { value: 'CANCELADO', label: 'Cancelada' }
        ];
        const linhas = rotasRecuperaveis.slice(0, 150).map((r) => {
            const idEsc = escaparHtmlMarketplace(r.id);
            const lojistaUidEsc = escaparHtmlMarketplace(r.lojistaUid);
            const select = statusOpsRota.map((op) => {
                const sel = op.value === r.statusNorm ? 'selected' : '';
                return `<option value="${op.value}" ${sel}>${op.label}</option>`;
            }).join('');
            const destinoTxt = escaparHtmlMarketplace(r.destinoPrincipal || r.destino || r.destinoPrincipalCalculado || '--');
            const pct = r.totalParadas > 0 ? Math.round((r.paradasConcluidas / r.totalParadas) * 100) : 0;
            const statusVisual = getStatusVisualRota(r.statusNorm);
            return `
                <tr data-rota-id="${idEsc}" data-lojista-uid="${lojistaUidEsc}">
                    <td>
                        <strong class="admin-td-title">${destinoTxt}</strong>
                        <span class="admin-mini-sub">${idEsc}</span>
                    </td>
                    <td>${escaparHtmlMarketplace(r.lojistaNome || 'Lojista')}</td>
                    <td>${escaparHtmlMarketplace(r.entregadorNome || '--')}</td>
                    <td>
                        <div class="admin-progress-row">
                            <div class="admin-progress-track"><div class="admin-progress-fill" style="width:${pct}%"></div></div>
                            <span class="admin-mini-sub">${r.paradasConcluidas}/${r.totalParadas}</span>
                        </div>
                    </td>
                    <td><span class="status-chip status-${(r.statusNorm || '').toLowerCase()}">${escaparHtmlMarketplace(statusVisual?.label || r.statusNorm || '--')}</span></td>
                    <td>
                        <div class="admin-row-actions">
                            <select class="adm-card-select" data-rota-id="${idEsc}" data-lojista-uid="${lojistaUidEsc}">
                                ${select}
                            </select>
                            <button type="button" class="admin-btn suspend" onclick="adminExcluirRota('${lojistaUidEsc}', '${idEsc}')">Excluir</button>
                        </div>
                    </td>
                </tr>
            `;
        });
        rotasTable.innerHTML = linhas.length
            ? `<table class="admin-data-table"><thead><tr><th>Rota</th><th>Lojista</th><th>Entregador</th><th>Paradas</th><th>Status</th><th>Ações</th></tr></thead><tbody>${linhas.join('')}</tbody></table>`
            : '<div class="admin-row">Nenhuma rota encontrada.</div>';
    }

    adminChartsState = {
        usuarios: { lojas, entregadores, masters, ativosL, ativosE },
        pacotes: { total: pacTotal, emRota: pacEmRota, entregues: pacEnt, cancelados: pacCanc },
        rotas: { total: rotTotal, buscando: rotBus, emRota: rotEm, concluidas: rotCon, canceladas: rotCanc },
        ganhos: {
            hoje: ganhosHoje,
            semana: ganhosSemana,
            mes: ganhosMes,
            total: ganhosTotal,
            pagoLojistaTotal: totalPagoLojistaHistorico,
            pagoEntregadorTotal: totalPagoEntregadorHistorico
        },
        ganhosSeries: { dia: diasSerie, semana: semanaSerieGanhos, mes: mesSerieGanhos },
        diasSerie,
        rankingLojistas: [...rankingLojistasMap.values()].sort((a, b) => b.entregues - a.entregues).slice(0, 5),
        rankingEntregadores: [...rankingEntregadoresMap.values()].sort((a, b) => b.concluidas - a.concluidas).slice(0, 5),
        rankingGanhosLojistas: [...rankingGanhosLojistasMap.values()].sort((a, b) => b.ganhos - a.ganhos).slice(0, 5),
        pacotesRecentes: pacotesListaAdmin.filter((p) => p.criadoEm > 0).sort((a, b) => b.criadoEm - a.criadoEm).slice(0, 6),
        rotasAndamento: rotasRecuperaveis.filter((r) => r.statusNorm === 'EM_ROTA' || r.statusNorm === 'BUSCANDO')
            .sort((a, b) => Number(b.atualizadoEm || b.criadoEm || 0) - Number(a.atualizadoEm || a.criadoEm || 0)).slice(0, 4),
        rotasPresas: rotasPresasAdmin
    };
    initAdminCharts();
    adminListTables();
    atualizarResumoRelatorioAdmin();
    renderSerieEntregasAdmin('entregues');
    renderRotasAndamentoAdmin();
    renderPacotesRecentesAdmin();
    renderRankingAdmin();
    renderAlertasAdmin();
    renderGanhosKpisAdmin();
    renderSerieGanhosAdmin();
    renderRankingGanhosAdmin();

    const lastUpdEl = document.getElementById('admin-last-updated');
    if (lastUpdEl) lastUpdEl.innerText = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function atualizarResumoRelatorioAdmin() {
    const el = document.getElementById('admin-report-summary');
    if (!el || !adminChartsState) return;
    const { usuarios, pacotes, rotas } = adminChartsState;
    const totalUsuarios = usuarios.lojas + usuarios.entregadores + usuarios.masters;
    const taxaEntrega = pacotes.total > 0 ? Math.round((pacotes.entregues / pacotes.total) * 100) : 0;
    const taxaConclusaoRotas = rotas.total > 0 ? Math.round((rotas.concluidas / rotas.total) * 100) : 0;
    el.innerText = `${totalUsuarios} usuários na plataforma (${usuarios.lojas} lojistas, ${usuarios.entregadores} entregadores). ` +
        `${pacotes.total} pacotes registrados, ${taxaEntrega}% já entregues. ` +
        `${rotas.total} rotas no total, ${taxaConclusaoRotas}% concluídas (${rotas.buscando} buscando, ${rotas.emRota} em rota).`;
}

function atualizarNotificacoesAdminSaques(pendentes = []) {
    saquesPendentesAdminCache = pendentes;
    const countEl = document.getElementById('admin-notif-count');
    const listEl = document.getElementById('admin-notif-list');
    if (!countEl || !listEl) return;

    if (!pendentes.length) {
        countEl.style.display = 'none';
        listEl.innerHTML = '<div class="pagamento-extrato-empty">Nada pendente.</div>';
        return;
    }

    countEl.style.display = 'grid';
    countEl.innerText = pendentes.length > 9 ? '9+' : String(pendentes.length);
    listEl.innerHTML = pendentes.slice(0, 8).map((s) => `
        <div class="admin-notif-item" onclick="switchAdminTab('overview')">
            <strong>${escaparHtmlMarketplace(s.nome)}</strong> pediu saque de ${precoParaMoeda(Number(s.valor || 0))}
            <div class="subtle" style="margin-top:2px;">${escaparHtmlMarketplace(formatarDataExtrato(s.solicitadoEm))}</div>
        </div>
    `).join('');
}

function toggleAdminSidebarCompact() {
    document.getElementById('admin-layout')?.classList.toggle('compact');
}

function toggleAdminSidebarMobile() {
    document.getElementById('admin-sidebar')?.classList.toggle('mobile-open');
}

function toggleAdminNotifPanel() {
    document.getElementById('admin-notif-panel')?.classList.toggle('show');
}

function aplicarTemaAdminSalvo() {
    const secao = document.getElementById('view-admin-dashboard');
    const btn = document.getElementById('admin-theme-btn');
    if (!secao) return;
    const escuro = localStorage.getItem('flexa_admin_tema') === 'dark';
    secao.classList.toggle('admin-dark', escuro);
    if (btn) btn.innerHTML = `<i data-lucide="${escuro ? 'sun' : 'moon'}" size="18"></i>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Tema escuro só desta seção (#view-admin-dashboard.admin-dark, ver styles.css) —
// nunca mexe em document.body, então não vaza pro app do lojista/entregador.
function toggleAdminTheme() {
    const secao = document.getElementById('view-admin-dashboard');
    if (!secao) return;
    const escuro = secao.classList.toggle('admin-dark');
    localStorage.setItem('flexa_admin_tema', escuro ? 'dark' : 'light');
    const btn = document.getElementById('admin-theme-btn');
    if (btn) btn.innerHTML = `<i data-lucide="${escuro ? 'sun' : 'moon'}" size="18"></i>`;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function filtrarLinhasAdmin(containerId, itemSelector, termo) {
    const container = document.getElementById(containerId);
    if (!container) return 0;
    const q = normalizarTexto((termo || '').trim());
    let visiveis = 0;
    container.querySelectorAll(itemSelector).forEach((item) => {
        const bate = !q || normalizarTexto(item.textContent || '').includes(q);
        item.style.display = bate ? '' : 'none';
        if (bate) visiveis += 1;
    });
    return visiveis;
}

function filtrarAdminUsuarios(termo) {
    filtrarLinhasAdmin('adm-users-table', '.admin-row', termo);
}

// Submenu Lojistas/Entregadores (pedido do dono 2026-09-27): separa a
// listagem de usuários por tipo sem precisar de outra ida ao banco — os
// dados já estão todos na tabela, é só mostrar/esconder pelo data-tipo
// gravado em cada linha (ver renderDashboardMaster).
function filtrarAdminUsuariosPorTipo(tipo, btn) {
    document.querySelectorAll('#admin-nav-submenu-users .admin-nav-subitem').forEach((el) => {
        el.classList.toggle('active', el === btn);
    });
    const container = document.getElementById('adm-users-table');
    if (!container) return;
    container.querySelectorAll('.admin-row').forEach((row) => {
        const bate = tipo === 'todos' || row.dataset.tipo === tipo;
        row.style.display = bate ? '' : 'none';
    });
}

function filtrarAdminPacotes(termo) {
    filtrarLinhasAdmin('adm-pack-cards', '.adm-card', termo);
}

function filtrarAdminRotas(termo) {
    filtrarLinhasAdmin('adm-rotas-cards', '.adm-card', termo);
}

// Busca global do topbar: aplica o filtro real da aba que estiver aberta no
// momento (usuários/pacotes/rotas), já que cada uma renderiza sua própria
// lista — não existe um índice único pra buscar tudo de uma vez sem duplicar
// leituras do Firebase que renderDashboardMaster já fez.
function filtrarAdminBuscaAtiva(termo) {
    const tab = document.querySelector('.admin-tab.active')?.dataset.tab;
    if (tab === 'users') filtrarAdminUsuarios(termo);
    else if (tab === 'packages') filtrarAdminPacotes(termo);
    else if (tab === 'routes') filtrarAdminRotas(termo);
}

function baixarArquivoTexto(nome, conteudo, tipo = 'text/csv;charset=utf-8;') {
    const blob = new Blob(['﻿' + conteudo], { type: tipo });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function exportarRelatorioCsvAdmin() {
    if (!adminChartsState) {
        alert('Atualize o painel (aba Visão geral) antes de exportar.');
        return;
    }
    const { usuarios, pacotes, rotas } = adminChartsState;
    const linhas = [
        ['metrica', 'valor'],
        ['lojistas', usuarios.lojas],
        ['lojistas_ativos_agora', usuarios.ativosL],
        ['entregadores', usuarios.entregadores],
        ['entregadores_ativos_agora', usuarios.ativosE],
        ['pacotes_total', pacotes.total],
        ['pacotes_em_rota', pacotes.emRota],
        ['pacotes_entregues', pacotes.entregues],
        ['pacotes_cancelados', pacotes.cancelados],
        ['rotas_total', rotas.total],
        ['rotas_buscando', rotas.buscando],
        ['rotas_em_rota', rotas.emRota],
        ['rotas_concluidas', rotas.concluidas],
        ['rotas_canceladas', rotas.canceladas]
    ];
    const csv = linhas.map((l) => l.join(',')).join('\n');
    baixarArquivoTexto(`flex-relatorio-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    notificarSucesso('Relatório exportado.');
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

    // Master não entra aqui de propósito: só existe 1 (o dono), não é uma
    // categoria de usuário relevante pra "distribuição" (pedido do dono
    // 2026-09-19).
    makeChart('adm-chart-usuarios', {
        type: 'doughnut',
        data: {
            labels: ['Lojistas', 'Entregadores'],
            datasets: [{
                data: [adminChartsState.usuarios.lojas, adminChartsState.usuarios.entregadores],
                backgroundColor: ['#fb923c', '#38bdf8']
            }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });

    // "Pacotes por status": donut + legenda própria (não a legenda padrão do
    // Chart.js) pra bater com o layout pedido pelo dono — número central e
    // legenda lado a lado, ver populaDonutPacotesAdmin logo abaixo.
    const pctPac = adminChartsState.pacotes;
    const pendentesPac = Math.max(0, pctPac.total - pctPac.emRota - pctPac.entregues - pctPac.cancelados);
    makeChart('adm-chart-pacotes', {
        type: 'doughnut',
        data: {
            labels: ['Em trânsito', 'Entregues', 'Aguardando', 'Cancelados'],
            datasets: [{
                data: [pctPac.emRota, pctPac.entregues, pendentesPac, pctPac.cancelados],
                backgroundColor: ['#2563eb', '#16a34a', '#f59e0b', '#ef4444'],
                borderWidth: 0
            }]
        },
        options: { responsive: true, cutout: '72%', plugins: { legend: { display: false }, tooltip: { enabled: true } } }
    });
    populaDonutPacotesAdmin(pctPac.total, [
        { label: 'Em trânsito', valor: pctPac.emRota, cor: '#2563eb' },
        { label: 'Entregues', valor: pctPac.entregues, cor: '#16a34a' },
        { label: 'Aguardando', valor: pendentesPac, cor: '#f59e0b' },
        { label: 'Cancelados', valor: pctPac.cancelados, cor: '#ef4444' }
    ]);

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

function populaDonutPacotesAdmin(total, itens) {
    const totalEl = document.getElementById('adm-pacotes-donut-total');
    const legendEl = document.getElementById('adm-pacotes-legend');
    if (totalEl) totalEl.innerText = String(total);
    if (legendEl) {
        legendEl.innerHTML = itens.map((it) => `
            <li><span><i class="dot" style="background:${it.cor}"></i>${escaparHtmlMarketplace(it.label)}</span><b>${it.valor}</b></li>
        `).join('');
    }
}

let adminChartEntregasDias = null;
function renderSerieEntregasAdmin(serieAtiva = 'entregues') {
    document.querySelectorAll('.admin-chart-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.serie === serieAtiva);
    });
    if (!adminChartsState || typeof Chart === 'undefined') return;
    const dias = adminChartsState.diasSerie || [];
    const cor = serieAtiva === 'criados' ? '#7c3aed' : '#2563eb';
    const dados = dias.map((d) => serieAtiva === 'criados' ? d.criados : d.entregues);
    const cfg = {
        type: 'line',
        data: {
            labels: dias.map((d) => d.label),
            datasets: [{
                label: serieAtiva === 'criados' ? 'Envios criados' : 'Entregas',
                data: dados,
                borderColor: cor,
                backgroundColor: cor + '22',
                fill: true,
                tension: 0.35,
                pointRadius: 4,
                pointBackgroundColor: '#fff',
                pointBorderColor: cor,
                pointBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
        }
    };
    const ctx = document.getElementById('adm-chart-entregas-dias');
    if (!ctx) return;
    if (adminChartEntregasDias) { adminChartEntregasDias.destroy(); }
    adminChartEntregasDias = new Chart(ctx, cfg);
}

function renderRotasAndamentoAdmin() {
    const container = document.getElementById('adm-rotas-andamento-mini');
    if (!container || !adminChartsState) return;
    const lista = adminChartsState.rotasAndamento || [];
    if (!lista.length) {
        container.innerHTML = '<div class="pagamento-extrato-empty">Nenhuma rota em andamento agora.</div>';
        return;
    }
    container.innerHTML = lista.map((r) => `
        <div class="admin-mini-row">
            <div>
                <strong>${escaparHtmlMarketplace(r.destinoPrincipal || r.destino || '--')}</strong>
                <span class="admin-mini-sub">${escaparHtmlMarketplace(r.id || '')}</span>
            </div>
            <span class="status-chip status-${(r.statusNorm || '').toLowerCase()}">${escaparHtmlMarketplace(getStatusVisualRota(r.statusNorm)?.label || r.statusNorm || '--')}</span>
        </div>
    `).join('');
}

function renderPacotesRecentesAdmin() {
    const container = document.getElementById('adm-pacotes-recentes-mini');
    if (!container || !adminChartsState) return;
    const lista = adminChartsState.pacotesRecentes || [];
    if (!lista.length) {
        container.innerHTML = '<div class="pagamento-extrato-empty">Nenhum pacote registrado ainda.</div>';
        return;
    }
    container.innerHTML = lista.map((p) => `
        <div class="admin-mini-row">
            <div>
                <strong>${escaparHtmlMarketplace(p.destinatario || 'Cliente')}</strong>
                <span class="admin-mini-sub">${escaparHtmlMarketplace(p.lojistaNome || '--')} • ${escaparHtmlMarketplace(formatarDataExtrato(p.criadoEm))}</span>
            </div>
            <span class="status-chip status-${(p.status || '').toLowerCase()}">${escaparHtmlMarketplace(rotuloStatusEnvio(p.status) || p.status || '--')}</span>
        </div>
    `).join('');
}

function renderRankingAdmin() {
    const lojistasEl = document.getElementById('adm-ranking-lojistas');
    const entregadoresEl = document.getElementById('adm-ranking-entregadores');
    if (!adminChartsState) return;

    if (lojistasEl) {
        const lista = adminChartsState.rankingLojistas || [];
        lojistasEl.innerHTML = lista.length
            ? lista.map((l, i) => `<li><span>${i + 1}. ${escaparHtmlMarketplace(l.nome)}</span><b>${l.entregues} entregas</b></li>`).join('')
            : '<li class="admin-rank-empty">Sem entregas registradas ainda.</li>';
    }
    if (entregadoresEl) {
        const lista = adminChartsState.rankingEntregadores || [];
        entregadoresEl.innerHTML = lista.length
            ? lista.map((e, i) => `<li><span>${i + 1}. ${escaparHtmlMarketplace(e.nome)}</span><b>${e.concluidas} concluídas${e.canceladas ? ` • ${e.canceladas} canceladas` : ''}</b></li>`).join('')
            : '<li class="admin-rank-empty">Sem rotas concluídas ainda.</li>';
    }
}

// Ganhos da plataforma (pedido do dono 2026-09-27): KPIs de hoje/semana/mês/
// total, num card na Visão Geral e repetidos com mais destaque na aba própria
// "Ganhos" — os ids têm sufixo -mini (overview) e sem sufixo (aba Ganhos)
// pra poder existir nos dois lugares sem duplicar id no DOM.
function renderGanhosKpisAdmin() {
    if (!adminChartsState) return;
    const g = adminChartsState.ganhos || { hoje: 0, semana: 0, mes: 0, total: 0 };
    const setTxt = (id, valor) => {
        const el = document.getElementById(id);
        if (el) el.innerText = precoParaMoeda(valor);
    };
    setTxt('adm-ganhos-hoje-mini', g.hoje);
    setTxt('adm-ganhos-hoje', g.hoje);
    setTxt('adm-ganhos-semana', g.semana);
    setTxt('adm-ganhos-mes', g.mes);
    setTxt('adm-ganhos-total', g.total);
    setTxt('adm-ganhos-total-2', g.total);
    setTxt('adm-ganhos-pago-lojista', g.pagoLojistaTotal || 0);
    setTxt('adm-ganhos-pago-entregador', g.pagoEntregadorTotal || 0);
}

let adminChartsGanhos = {};
// Filtro dia/semana/mês (pedido do dono 2026-09-27) só se aplica ao gráfico
// grande, da aba "Ganhos" — o mini gráfico da Visão Geral é só uma prévia
// rápida, sempre dia a dia, sem os botões de período.
function renderSerieGanhosAdmin(periodo = 'dia') {
    if (!adminChartsState || typeof Chart === 'undefined') return;
    document.querySelectorAll('.admin-chart-tab-ganhos').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.periodoGanhos === periodo);
    });

    const series = adminChartsState.ganhosSeries || {};
    const serieDia = series.dia || adminChartsState.diasSerie || [];
    const serieEscolhida = series[periodo] || serieDia;

    const montarCfg = (serie) => ({
        type: 'bar',
        data: {
            labels: serie.map((d) => d.label),
            datasets: [{
                label: 'Ganhos da plataforma',
                data: serie.map((d) => Number((d.ganhos || 0).toFixed(2))),
                backgroundColor: '#16a34a',
                borderRadius: 6,
                maxBarThickness: 36
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => precoParaMoeda(ctx.parsed.y) } }
            },
            scales: { y: { beginAtZero: true, ticks: { callback: (v) => precoParaMoeda(v) } } }
        }
    });

    const ctxFull = document.getElementById('adm-chart-ganhos-dias');
    if (ctxFull) {
        if (adminChartsGanhos['adm-chart-ganhos-dias']) adminChartsGanhos['adm-chart-ganhos-dias'].destroy();
        adminChartsGanhos['adm-chart-ganhos-dias'] = new Chart(ctxFull, montarCfg(serieEscolhida));
    }
    const ctxMini = document.getElementById('adm-chart-ganhos-mini');
    if (ctxMini) {
        if (adminChartsGanhos['adm-chart-ganhos-mini']) adminChartsGanhos['adm-chart-ganhos-mini'].destroy();
        adminChartsGanhos['adm-chart-ganhos-mini'] = new Chart(ctxMini, montarCfg(serieDia));
    }
}

function renderRankingGanhosAdmin() {
    const el = document.getElementById('adm-ranking-ganhos-lojistas');
    if (!el || !adminChartsState) return;
    const lista = adminChartsState.rankingGanhosLojistas || [];
    el.innerHTML = lista.length
        ? lista.map((l, i) => `<li><span>${i + 1}. ${escaparHtmlMarketplace(l.nome)}</span><b>${precoParaMoeda(l.ganhos)}</b></li>`).join('')
        : '<li class="admin-rank-empty">Sem rotas concluídas ainda.</li>';
}

function renderAlertasAdmin() {
    const container = document.getElementById('adm-alertas-lista');
    if (!container || !adminChartsState) return;

    const alertas = [];
    saquesPendentesAdminCache.forEach((s) => {
        alertas.push({
            cor: '#f59e0b',
            titulo: `Saque pendente: ${s.nome}`,
            sub: `${precoParaMoeda(Number(s.valor || 0))} • ${formatarDataExtrato(s.solicitadoEm)}`,
            tab: 'overview'
        });
    });
    (adminChartsState.rotasPresas || []).forEach((r) => {
        alertas.push({
            cor: '#ef4444',
            titulo: `Rota ${r.id} parada há mais de 2h`,
            sub: 'Buscando entregador no marketplace, ninguém aceitou ainda.',
            tab: 'routes'
        });
    });

    if (!alertas.length) {
        container.innerHTML = '<div class="pagamento-extrato-empty">Nenhum alerta no momento.</div>';
        return;
    }
    container.innerHTML = alertas.slice(0, 8).map((a) => `
        <div class="admin-alert-item">
            <span class="admin-alert-bar" style="background:${a.cor}"></span>
            <div>
                <strong>${escaparHtmlMarketplace(a.titulo)}</strong>
                <div class="admin-mini-sub">${escaparHtmlMarketplace(a.sub)}</div>
            </div>
            <button type="button" class="admin-link-btn" onclick="switchAdminTab('${a.tab}')">Ver</button>
        </div>
    `).join('');
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
                        lojistaUid: u,
                        lojista: dataUsers[u].nome || u,
                        cidade: h.cidade || cliente.cidade || '',
                        criadoEm: Number(h.criadoEm || 0)
                    });
                });
            });
        });

        // leitura de /pacotes (novo modelo) — BUG CORRIGIDO 2026-10-02: lia
        // 'pacotes' (raiz), caminho que nada grava. O pacote real vive em
        // usuarios/{uid}/pacotes, já presente em dataUsers[uid].pacotes.
        Object.keys(dataUsers).forEach((uid) => {
            const pacs = dataUsers[uid]?.pacotes || {};
            Object.keys(pacs).forEach((pid) => {
                const p = pacs[pid] || {};
                linhas.push({
                    id: pid,
                    status: normalizarStatusEnvioFiltro(p.status || p.statusRaw || 'PACOTE_NOVO'),
                    cliente: (p.destinatario || p.cliente || '').toString(),
                    lojistaUid: uid,
                    lojista: dataUsers?.[uid]?.nome || uid,
                    cidade: p.cidadeDestino || p.cidade || extrairCidadeEnderecoSimples(p.destinoEndereco || p.destino || ''),
                    criadoEm: Number(p.criadoEm || 0)
                });
            });
        });

        // de-dup por id: um envio pode existir nos dois modelos (historico +
        // pacotes) — mantém a última versão (pacotes, mais confiável porque
        // não depende de casar id com o histórico do cliente).
        {
            const mapaLinhas = new Map();
            linhas.forEach((l) => mapaLinhas.set(String(l.id || ''), l));
            linhas = Array.from(mapaLinhas.values());
        }

        // fallback local se nada retornou (ex.: regras de leitura)
        if (!linhas.length && Array.isArray(clientes)) {
            const meuUid = getUsuarioIdAtual() || '';
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
                        lojistaUid: meuUid,
                        lojista: usuarioLogado?.nome || meuUid,
                        cidade: h.cidade || cliente.cidade || '',
                        criadoEm: Number(h.criadoEm || 0)
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

        linhas.sort((a, b) => b.criadoEm - a.criadoEm || (a.id || '').localeCompare(b.id || ''));
        const linhasHtml = linhas.slice(0, 150).map((l) => {
            const idEsc = escaparHtmlMarketplace(l.id);
            const lojistaUidEsc = escaparHtmlMarketplace(l.lojistaUid || '');
            const select = statusOps.map((op) => {
                const sel = op.value === l.status ? 'selected' : '';
                return `<option value="${op.value}" ${sel}>${op.label}</option>`;
            }).join('');
            return `
                <tr data-pack-id="${idEsc}" data-lojista-uid="${lojistaUidEsc}">
                    <td>
                        <strong class="admin-td-title">${idEsc}</strong>
                        <span class="admin-mini-sub">${escaparHtmlMarketplace(l.cidade || '')}</span>
                    </td>
                    <td>${escaparHtmlMarketplace(l.cliente || '--')}</td>
                    <td>${escaparHtmlMarketplace(l.lojista || '--')}</td>
                    <td>${l.criadoEm ? escaparHtmlMarketplace(formatarDataExtrato(l.criadoEm)) : '--'}</td>
                    <td><span class="status-chip status-${(l.status || '').toLowerCase()}">${escaparHtmlMarketplace(rotuloStatusEnvio(l.status) || l.status || '--')}</span></td>
                    <td>
                        <div class="admin-row-actions">
                            <select class="adm-card-select" data-pack-id="${idEsc}" data-lojista-uid="${lojistaUidEsc}">
                                ${select}
                            </select>
                            <button type="button" class="admin-btn suspend" onclick="adminExcluirPacote('${lojistaUidEsc}', '${idEsc}')">Excluir</button>
                        </div>
                    </td>
                </tr>`;
        }).join('');

        container.innerHTML = `<table class="admin-data-table"><thead><tr><th>Código</th><th>Destinatário</th><th>Lojista</th><th>Criado em</th><th>Status</th><th>Ações</th></tr></thead><tbody>${linhasHtml}</tbody></table>`;
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

// CORRIGIDO 2026-09-19: isto chamava setStatusPacotes(), que só mexe no
// array `clientes` (dados do usuário LOGADO — o master, que não tem
// clientes/pacotes próprios) e grava em `pacotes/{uid do master}/...`. Ou
// seja, mudar o status de um pacote aqui não fazia NADA no pacote real do
// lojista — silenciosamente. Trocado por sincronizarCamposEnvioLojista, que
// já existe no app pra esse exato cenário (escrever no pacote de OUTRO
// usuário, usado hoje pelo fluxo de devolução/cobrança do entregador) e
// aceita o lojistaUid certo, gravando nos dois modelos (histórico antigo e
// /pacotes novo).
async function adminSalvarPacotes() {
    if (!usuarioEhMaster()) return;
    const container = document.getElementById('adm-pack-cards');
    if (!container) return;
    const selects = Array.from(container.querySelectorAll('select.adm-card-select'));
    if (!selects.length) return;

    const agora = Date.now();
    const promessas = selects.map((sel) => {
        const envioId = sel.dataset.packId;
        const lojistaUid = sel.dataset.lojistaUid;
        const status = (sel.value || 'PACOTE_NOVO').toUpperCase();
        if (!envioId || !lojistaUid) return Promise.resolve();
        return sincronizarCamposEnvioLojista(lojistaUid, envioId, { status, atualizadoEm: agora });
    });

    await Promise.all(promessas);
    notificarSucesso('Status dos pacotes atualizado.');
    adminUsersCache = null;
    await adminCarregarPacotes();
}

async function adminExcluirPacote(lojistaUid, envioId) {
    if (!usuarioEhMaster() || !lojistaUid || !envioId) return;
    if (!window.confirm(`Excluir o pacote ${envioId} definitivamente? Essa ação não pode ser desfeita.`)) return;

    try {
        const updates = {};
        updates[`usuarios/${lojistaUid}/pacotes/${envioId}`] = null;

        const clientesSnap = await db.ref(`usuarios/${lojistaUid}/clientes`).once('value');
        const clientesNo = clientesSnap.val() || {};
        Object.keys(clientesNo).forEach((clienteId) => {
            const historico = Array.isArray(clientesNo[clienteId]?.historico) ? clientesNo[clienteId].historico : [];
            historico.forEach((h, idx) => {
                const idAtual = String(h?.id || (`envio-${clienteId}-${idx}`));
                if (idAtual === envioId) updates[`usuarios/${lojistaUid}/clientes/${clienteId}/historico/${idx}`] = null;
            });
        });

        const rotasSnap = await db.ref(`usuarios/${lojistaUid}/rotas`).once('value');
        const rotasNo = rotasSnap.val() || {};
        Object.keys(rotasNo).forEach((rid) => {
            const r = rotasNo[rid] || {};
            const lista = Array.isArray(r.pacoteIds) ? r.pacoteIds : (Array.isArray(r.pacotes) ? r.pacotes : []);
            if (lista.includes(envioId)) {
                updates[`usuarios/${lojistaUid}/rotas/${rid}/pacoteIds`] = lista.filter((id) => id !== envioId);
            }
        });

        await db.ref().update(updates);
        notificarSucesso('Pacote excluído.');
        // adminCarregarPacotes reaproveita adminUsersCache quando já existe
        // (carregado antes pela própria Visão Geral ou por uma chamada
        // anterior desta mesma aba) — sem invalidar aqui, o pacote recém
        // excluído continuava aparecendo na lista (já tinha sumido do banco
        // de verdade, só a aba não sabia disso ainda).
        adminUsersCache = null;
        await adminCarregarPacotes();
    } catch (err) {
        console.warn('Falha ao excluir pacote (admin):', err);
        alert('Não foi possível excluir o pacote agora. Tente novamente.');
    }
}

async function atualizarStatusRotaMaster(lojistaUid, rotaId, status = 'BUSCANDO') {
    if (!usuarioEhMaster() || !lojistaUid || !rotaId) return;
    // A checagem de "é master de verdade" e a gravação nas duas cópias
    // (lojista+entregador) agora rodam no servidor (plano de segurança
    // 2026-09-27, ver /admin-atualizar-status-rota em backend/functions) — a
    // regra do banco pra "rotas" é auth != null, então antes bastava chamar
    // esta função direto do console (com usuarioEhMaster() sempre true pra
    // quem edita o próprio localStorage) pra reescrever a rota de qualquer
    // lojista. A checagem acima continua só pra UX (não mostra a opção pra
    // quem não é master).
    await chamarPaymentsProxy('/admin-atualizar-status-rota', { lojistaUid, rotaId, status });
}

async function adminExcluirRota(lojistaUid, rotaId) {
    if (!usuarioEhMaster() || !lojistaUid || !rotaId) return;
    if (!window.confirm(`Excluir a rota ${rotaId} definitivamente? Isso não apaga os pacotes dela, só a rota em si — os pacotes voltam a aparecer como disponíveis pra entrar em outra rota.`)) return;

    try {
        // Mesma migração de atualizarStatusRotaMaster: quem decide e quem
        // grava agora é o servidor (/admin-excluir-rota).
        await chamarPaymentsProxy('/admin-excluir-rota', { lojistaUid, rotaId });

        notificarSucesso('Rota excluída.');
        await renderDashboardMaster();
    } catch (err) {
        console.warn('Falha ao excluir rota (admin):', err);
        alert('Não foi possível excluir a rota agora. Tente novamente.');
    }
}

// Painel master de saques pendentes (ver solicitarSaque) — usersNo já vem da
// mesma leitura de /usuarios que renderDashboardMaster faz pra tudo mais, não
// precisa de outra ida ao banco. Isto só REGISTRA que o pagamento manual foi
// feito — não move dinheiro nenhum, quem paga o Pix de verdade é o dono, fora
// do app.
function renderSaquesPendentesAdmin(usersNo = {}) {
    const container = document.getElementById('adm-saques-lista');
    if (!container) return;

    const pendentes = [];
    Object.keys(usersNo).forEach((uid) => {
        const saquesNo = usersNo[uid]?.saques || {};
        Object.keys(saquesNo).forEach((saqueId) => {
            const s = saquesNo[saqueId] || {};
            if ((s.status || 'solicitado') !== 'solicitado') return;
            pendentes.push({ id: saqueId, uid, nome: usersNo[uid]?.nome || 'Usuário', ...s });
        });
    });
    pendentes.sort((a, b) => Number(a?.solicitadoEm || 0) - Number(b?.solicitadoEm || 0));
    atualizarNotificacoesAdminSaques(pendentes);

    if (!pendentes.length) {
        container.innerHTML = '<div class="pagamento-extrato-empty">Nenhum saque pendente.</div>';
        return;
    }

    container.innerHTML = pendentes.map((s) => `
        <div class="admin-row">
            <div>
                <strong>${escaparHtmlMarketplace(s.nome)}</strong>
                <div class="admin-badge loja">${precoParaMoeda(Number(s.valor || 0))}</div>
            </div>
            <div>${escaparHtmlMarketplace(String(s.pixTipo || '').toUpperCase())}: ${escaparHtmlMarketplace(s.pixChave || '--')}</div>
            <div>Solicitado: ${escaparHtmlMarketplace(formatarDataExtrato(s.solicitadoEm))}</div>
            <div class="admin-row-actions">
                <button class="admin-btn reset" onclick="marcarSaqueComoPago('${escaparHtmlMarketplace(s.uid)}', '${escaparHtmlMarketplace(s.id)}')">Marcar como pago</button>
            </div>
        </div>
    `).join('');
}

async function marcarSaqueComoPago(lojistaUid, saqueId) {
    if (!usuarioEhMaster() || !lojistaUid || !saqueId) return;

    const saqueRef = db.ref(`usuarios/${lojistaUid}/saques/${saqueId}`);
    const snap = await saqueRef.once('value').catch(() => null);
    const saque = snap?.val();
    if (!saque || (saque.status || 'solicitado') !== 'solicitado') {
        alert('Este saque não está mais pendente.');
        return;
    }
    const valor = Number(saque.valor || 0);

    if (!window.confirm(`Confirma que já pagou ${precoParaMoeda(valor)} via Pix pra fora do app? O valor será debitado da carteira do usuário agora.`)) return;

    try {
        // CORRIGIDO 2026-09-19: o débito só acontece aqui, na confirmação real
        // do pagamento pelo master — não mais no momento em que o usuário só
        // solicita o saque (ver solicitarSaque).
        const resultado = await ajustarSaldoUsuario(lojistaUid, -valor, { permitirNegativo: false });
        if (!resultado.ok) {
            alert(resultado.saldoInsuficiente
                ? 'O usuário não tem mais saldo suficiente pra cobrir esse saque (pode já ter gastado). Não foi marcado como pago.'
                : 'Não foi possível debitar o saldo agora. Tente novamente.');
            return;
        }

        const nomeSnap = await db.ref(`usuarios/${lojistaUid}/nome`).once('value').catch(() => null);
        const nomeDestinatario = (nomeSnap?.val() || 'Usuário').toString();
        const protocolo = gerarProtocoloTransacao();

        const transRef = db.ref(`usuarios/${lojistaUid}/financeiro/transacoes`).push();
        await transRef.set({
            id: transRef.key,
            protocolo,
            tipo: 'DEBITO',
            metodo: 'pix',
            valor,
            descricao: `Saque pago via Pix (${String(saque.pixTipo || '').toUpperCase()}: ${saque.pixChave || '--'})`,
            remetente: 'Flex (saque)',
            destinatario: nomeDestinatario,
            pixChave: saque.pixChave || '--',
            pixTipo: String(saque.pixTipo || '').toUpperCase(),
            criadoEm: Date.now()
        });

        await saqueRef.update({
            status: 'pago',
            pagoEm: Date.now(),
            protocolo
        });
        notificarSucesso(`Saque marcado como pago. Protocolo: ${protocolo}`);
        await renderDashboardMaster();
    } catch (err) {
        console.warn('Falha ao marcar saque como pago:', err);
        alert('Não foi possível marcar o saque como pago agora. Tente novamente.');
    }
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
    notificarSucesso('Status das rotas atualizado.');
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
    const tokenRastreio = rotaDetalheAtual?.tokensRastreio?.[p.id] || '';
    const linkRastreioHtml = tokenRastreio ? `
        <div class="rota-detalhe-rastreio">
            <span>Link de rastreio pro cliente</span>
            <div class="rota-detalhe-rastreio-actions">
                <button type="button" class="btn-chip" onclick="copiarLinkRastreioPacote('${tokenRastreio}', '${escaparHtmlMarketplace(String(p.codigoConfirmacaoEntrega || ''))}', '${escaparHtmlMarketplace(String(p.whatsapp || ''))}', '${escaparHtmlMarketplace(String(p.destinatario || '').replace(/'/g, "\\'"))}')"><i data-lucide="link" size="14"></i> Copiar link</button>
                ${p.whatsapp && p.whatsapp !== '--' ? `<button type="button" class="btn-chip btn-chip-primary" onclick="compartilharLinkRastreioWhatsapp('${tokenRastreio}', '${escaparHtmlMarketplace(String(p.whatsapp))}', '${escaparHtmlMarketplace(String(p.codigoConfirmacaoEntrega || ''))}', '${escaparHtmlMarketplace(String(p.destinatario || '').replace(/'/g, "\\'"))}')"><i data-lucide="send" size="14"></i> Enviar no WhatsApp</button>` : ''}
            </div>
        </div>
    ` : '';

    wrap.innerHTML = `
        <div class="rota-detalhe-package-card">
            <h4>Pacote #${p.codigo} · ${p.destinatario}</h4>
            ${linkRastreioHtml}
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
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function montarUrlRastreioPublico(token) {
    return `${window.location.origin}${window.location.pathname}#/rastreio/${token}`;
}

async function copiarLinkRastreioPacote(token, codigoConfirmacao, whatsapp, nome) {
    // Login automático embutido no link — mesmo mecanismo do "Enviar no
    // WhatsApp" (ver compartilharLinkRastreioWhatsapp). BUG CORRIGIDO
    // 2026-10-03 (pedido do dono): antes só o botão de WhatsApp gerava esse
    // token — "Copiar link" saía sem ele, então colar o link copiado direto
    // no navegador nunca logava o cliente nem abria completar cadastro
    // automaticamente. Se a chamada falhar, cai pro link normal sem login
    // automático — o rastreio em si nunca depende disso.
    let loginTokenParam = '';
    if (whatsapp) {
        try {
            const resp = await chamarPaymentsProxy('/gerar-login-cliente', { whatsapp, nome });
            if (resp?.loginToken) loginTokenParam = `?lt=${encodeURIComponent(resp.loginToken)}`;
        } catch (err) {
            console.warn('Falha ao gerar login automático do cliente:', err);
        }
    }
    const url = montarUrlRastreioPublico(token) + loginTokenParam;
    // O código vai junto porque é o cliente quem confirma a entrega direto
    // com o entregador na porta — sem o código na mensagem, o lojista tinha
    // que procurar e repassar isso à parte (pedido do dono, 2026-09-25).
    const texto = codigoConfirmacao
        ? `${url}\n\nCódigo pra confirmar com o entregador na entrega: ${codigoConfirmacao}`
        : url;
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(texto)
            .then(() => notificarSucesso('Link de rastreio copiado.'))
            .catch(() => alert(`Copie o link manualmente:\n${texto}`));
    } else {
        alert(`Copie o link manualmente:\n${texto}`);
    }
}

// BUG CORRIGIDO 2026-09-22: o wa.me exige o número no formato internacional
// completo (com código do país) — sem isso o WhatsApp recusa com "código do
// país não foi inserido". Os números salvos no app são só DDD+número (como
// a pessoa digita normalmente no Brasil), então precisa completar com 55
// aqui na hora de montar o link — sem mexer em normalizarWhatsapp (usada
// pro login/índices, que já estão salvos nesse formato sem 55).
function paraWhatsappInternacional(whatsapp) {
    const digits = normalizarWhatsapp(whatsapp);
    return digits.length <= 11 ? '55' + digits : digits;
}

async function compartilharLinkRastreioWhatsapp(token, whatsapp, codigoConfirmacao, nome) {
    // Abre a aba JÁ (síncrono, dentro do próprio clique) e só troca a URL
    // dela depois — navegadores bloqueiam window.open chamado depois de um
    // await, mesmo que o clique tenha disparado tudo isso.
    const aba = window.open('', '_blank');

    // Login automático do cliente embutido no mesmo link (plano 2026-09-28):
    // antes o acesso à conta exigia um convite separado com usuário+senha
    // temporária em texto puro — agora o próprio link de rastreio já
    // autentica o cliente ao clicar, sem nunca mostrar senha nenhuma (ver
    // gerarLoginCliente/consumirLoginCliente, backend/functions/index.js).
    // Se a chamada falhar por qualquer motivo, cai pro link normal sem login
    // automático — o rastreio em si nunca depende disso.
    let loginTokenParam = '';
    try {
        const resp = await chamarPaymentsProxy('/gerar-login-cliente', { whatsapp, nome });
        if (resp?.loginToken) loginTokenParam = `?lt=${encodeURIComponent(resp.loginToken)}`;
    } catch (err) {
        console.warn('Falha ao gerar login automático do cliente:', err);
    }

    const url = montarUrlRastreioPublico(token) + loginTokenParam;
    const numero = paraWhatsappInternacional(whatsapp);
    // Código junto na mensagem: é o cliente quem confirma a entrega com o
    // entregador na porta, então ele precisa desse código em mãos (pedido do
    // dono, 2026-09-25) — antes só ia o link, o código ficava só com o lojista.
    const msg = codigoConfirmacao
        ? `Acompanhe sua entrega em tempo real: ${url}\n\nQuando o entregador chegar, informe este código pra confirmar: ${codigoConfirmacao}`
        : `Acompanhe sua entrega em tempo real: ${url}`;
    const texto = encodeURIComponent(msg);
    const urlWhatsapp = `https://wa.me/${numero}?text=${texto}`;
    if (aba) aba.location.href = urlWhatsapp;
    else window.open(urlWhatsapp, '_blank');
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

    // No painel fixo do desktop (tela Rotas), "abrir" é só trocar o estado
    // vazio pelo conteúdo — o overlay já fica sempre visível ali (ver CSS).
    document.getElementById('rota-detalhe-vazio')?.classList.add('hidden');
    document.getElementById('rota-detalhe-conteudo')?.classList.remove('hidden');

    overlay.style.display = 'flex';
    requestAnimationFrame(() => sheet.classList.add('show'));
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Estado padrão do painel fixo de detalhe (desktop, tela Rotas) — chamado
// toda vez que se entra/recarrega a tela Rotas, pra não ficar mostrando
// o detalhe de uma rota de uma visita anterior.
function resetarPainelDetalheRotaDesktop() {
    rotaDetalheAtual = null;
    document.getElementById('rota-detalhe-vazio')?.classList.remove('hidden');
    document.getElementById('rota-detalhe-conteudo')?.classList.add('hidden');
}

// Mesma ideia acima, pro painel fixo "Detalhes do Envio" da tela Pedidos
// (pedido do dono 2026-10-01).
function resetarPainelDetalheEnvioDesktop() {
    envioDetalheAtualId = null;
    document.getElementById('envio-detalhe-vazio')?.classList.remove('hidden');
    document.getElementById('envio-detalhe-conteudo')?.classList.add('hidden');
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
            // Detecção ampliada 2026-09-29: antes só pegava servico === 'flash'
            // exato, então um pacote marcado "Expresso" passava batido pela
            // regra de tipo único abaixo (mesma checagem .includes usada em
            // temFlash/servicoLabel no resto do arquivo).
            const flash = servico.toLowerCase().includes('flash') || servico.toLowerCase().includes('expresso');
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
                veiculo: h.veiculo || 'Moto',
                tipoFluxo: h.tipoFluxo || 'entrega',
                // Geo do ponto de parada — em coleta reversa é o próprio
                // destinoGeo que já guarda o endereço do CLIENTE (origem e
                // destino já vêm trocados desde a criação do envio, ver
                // confirmarEnvioFinal), então sempre é o campo certo pra
                // calcular a ordem por proximidade (ver ordenarPacotesPorProximidade).
                destinoGeo: h.destinoGeo || null
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

    // Prévia do card de pagamento (coluna direita no desktop, visível antes
    // de clicar em "Pagamento" de verdade — pedido do dono 2026-10-02: o
    // card de Pix aparecia vazio/zerado porque só irParaPagamentoRota()
    // calcula esse total, e essa função só roda DEPOIS do clique). Mesmo
    // cálculo (valorFrete de cada pacote selecionado), só que ao vivo a
    // cada pacote marcado/desmarcado, sem gerar nenhuma cobrança ainda.
    const previewQtd = document.getElementById('rota-preview-qtd');
    const previewTotal = document.getElementById('rota-preview-total');
    if (previewQtd || previewTotal) {
        const totalFrete = selecionados.reduce((acc, p) => acc + Number(p.valorFrete || 0), 0);
        if (previewQtd) previewQtd.innerText = String(selecionados.length);
        if (previewTotal) previewTotal.innerText = precoParaMoeda(totalFrete);
    }
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
        const badgeText = pacote.flash ? 'FLASH' : 'START';
        const cityText = pacote.cidade || 'Sem cidade';
        const coletaBadge = pacote.tipoFluxo === 'coleta_reversa'
            ? '<span class="rota-badge-coleta">↩ COLETA</span>'
            : '';

        return `
            <button type="button" class="rota-pending-item ${selecionado ? 'selected' : ''}" onclick="togglePacoteRota('${pacote.id}')">
                <div class="rota-pending-main">
                    <strong>Pedido #${pacote.codigo} - ${pacote.destinatario}</strong>
                    <span>${cityText} • ${pacote.veiculo}</span>
                </div>
                <div class="rota-pending-meta">
                    ${coletaBadge}
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

    // Regra nova (pedido do dono 2026-09-29): rota só pode ter UM tipo de
    // serviço — tudo Flash ou tudo Start, nunca misto. Substitui a regra
    // antiga de "no máximo 1 Flash por rota" (o prazo de 2h agora é
    // controlado por pacote na tela Entregas do entregador, não precisa
    // mais limitar quantidade, só o tipo).
    if (selecionados.length && pacote.flash !== selecionados[0].flash) {
        alert(pacote.flash
            ? 'Essa rota já tem pacote(s) Start — não dá pra misturar com Flash. Monte uma rota separada só com os pacotes Flash.'
            : 'Essa rota já tem pacote(s) Flash — não dá pra misturar com Start. Monte uma rota separada só com os pacotes Start.');
        return false;
    }

    // Coleta reversa parte do endereço do CLIENTE, não da loja — misturar
    // com entregas normais (que partem da loja) quebraria a lógica de uma
    // origem só por rota. Enquanto não existir suporte a múltiplas
    // origens numa rota, cada uma fica separada.
    const ehColeta = pacote.tipoFluxo === 'coleta_reversa';
    if (ehColeta && selecionados.some((item) => item.tipoFluxo !== 'coleta_reversa')) {
        alert('Coleta reversa não pode ser combinada com entregas normais na mesma rota — monte uma rota separada só de coletas.');
        return false;
    }
    if (!ehColeta && selecionados.some((item) => item.tipoFluxo === 'coleta_reversa')) {
        alert('Essa rota já tem uma coleta reversa — não dá pra combinar com entregas normais.');
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
        const err = new Error(data?.error || data?.message || ('HTTP ' + resp.status));
        if (data?.motivo) err.motivo = data.motivo;
        throw err;
    }
    return data;
}

function obterNomeLojistaSeparadoTesteLocal() {
    const nomeCompleto = (window.usuarioLogado?.nome || 'Lojista Flex').toString().trim();
    const partes = nomeCompleto.split(/\s+/).filter(Boolean);
    const firstName = partes[0] || 'Lojista';
    const lastName = partes.slice(1).join(' ') || 'Flex';
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
            description: 'Flex Rota ' + rotaDraft.id + ' (' + rotaDraft.qtd + ' pacote(s)) [TESTE LOCAL]',
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

// ===================== [PIX DA COBRANÇA NA ENTREGA] =====================
// O entregador gera o Pix pelo próprio app, o CLIENTE paga escaneando/copiando
// — o dinheiro vai direto pro Mercado Pago do lojista/plataforma, nunca passa
// pela mão do entregador, por isso não cria dívida nenhuma (ao contrário do
// dinheiro). Ver project-flexa-cobranca-entrega-dinheiro.
async function criarPagamentoPixCobrancaEntregaTesteLocal(pac, rotaId, valorOverride) {
    const cobranca = pac?.cobrancaEntrega;
    const valor = Number.isFinite(Number(valorOverride)) && Number(valorOverride) > 0
        ? Number(valorOverride)
        : Number(cobranca?.valor || 0);
    if (!Number.isFinite(valor) || valor <= 0) {
        throw new Error('Valor de cobrança inválido.');
    }
    const nomeCliente = (pac?.destinatario || 'Cliente Flex').toString().trim() || 'Cliente Flex';
    const partes = nomeCliente.split(/\s+/).filter(Boolean);
    const firstName = partes[0] || 'Cliente';
    const lastName = partes.slice(1).join(' ') || 'Flex';

    const resp = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + FLEXA_MP_TEST_TOKEN,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': gerarIdempotencyKeyTesteLocal()
        },
        body: JSON.stringify({
            transaction_amount: Number(valor.toFixed(2)),
            description: 'Flex - cobrança na entrega (pedido ' + (pac?.id || '') + ') [TESTE LOCAL]',
            payment_method_id: 'pix',
            payer: { email: obterEmailPagadorTesteLocal(), first_name: firstName, last_name: lastName },
            date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            external_reference: rotaId + ':' + (pac?.id || '')
        })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const detalhe = data?.message || data?.error || data?.cause?.[0]?.description || ('HTTP ' + resp.status);
        throw new Error('Mercado Pago: ' + detalhe);
    }
    const tx = data?.point_of_interaction?.transaction_data || {};
    return {
        paymentId: data?.id ? String(data.id) : '',
        status: data?.status || 'pending',
        statusDetail: data?.status_detail || '',
        pixCode: tx.qr_code || '',
        qrCodeBase64: tx.qr_code_base64 || '',
        valor
    };
}

async function gerarPixCobrancaEntrega(valorOverride) {
    const rotaObj = rotaEntSheetRotaAtual;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    const cobranca = pac?.cobrancaEntrega;
    if (!rotaObj || !cobranca?.ativa || cobranca.status !== 'pendente') return;

    const lojistaUid = obterLojistaUidDaRota(rotaObj, pac);
    const envioId = obterIdPacoteConfirmacao(pac);
    if (!lojistaUid || !envioId) return;

    // valorOverride é usado no pagamento misto (ver confirmarPagamentoMistoCobranca):
    // cobra só a diferença depois de já registrar o que veio em dinheiro.
    const valorPix = Number.isFinite(Number(valorOverride)) && Number(valorOverride) > 0
        ? Number(valorOverride)
        : Number(cobranca.valor || 0);

    const btn = document.getElementById('ent-sheet-pix-gerar-btn');
    if (btn) { btn.disabled = true; btn.innerText = 'Gerando Pix...'; }

    try {
        let data;
        if (FLEXA_PAYMENTS_PROXY_URL) {
            data = await chamarPaymentsProxy('/create-pix-cobranca', { tenantId: lojistaUid, rotaId: rotaObj.id, envioId, valor: valorPix });
        } else if (FLEXA_MP_TEST_TOKEN) {
            data = await criarPagamentoPixCobrancaEntregaTesteLocal(pac, rotaObj.id, valorPix);
        } else {
            throw new Error('Pagamento não configurado: defina FLEXA_PAYMENTS_PROXY_URL (produção) ou FLEXA_MP_TEST_TOKEN (só teste local).');
        }

        const pixCode = normalizarCodigoPix(data.pixCode || '');
        if (!pixCode) throw new Error('Mercado Pago não retornou código Pix.');

        pixCobrancaEntregaAtual = {
            paymentId: data.paymentId ? String(data.paymentId) : '',
            envioId,
            lojistaUid,
            rotaId: rotaObj.id,
            pixCode,
            qrCodeBase64: data.qrCodeBase64 || '',
            valor: data.valor || valorPix
        };

        renderSheetRotaEntregadorConteudo();
        iniciarPollingPixCobrancaEntrega();
    } catch (err) {
        console.warn('Falha ao gerar Pix de cobrança na entrega:', err);

        // Mesma escotilha de teste usada em rota e devolução — sem Cloud Function
        // deployada, o navegador não consegue chamar a API do Mercado Pago direto
        // (CORS/rede). Ver feedback_flexa_test_mode_escape_hatches.
        if (!FLEXA_PAYMENTS_PROXY_URL && mercadoPagoAmbienteAtual === 'teste') {
            const simular = confirm(
                'Não foi possível gerar o Pix de cobrança (ambiente TESTE).\n\n' +
                'Detalhe: ' + (err?.message || 'erro desconhecido') + '\n\n' +
                'Deseja simular esse Pix como pago para continuar testando o fluxo?'
            );
            if (simular) {
                await creditarLojistaCobrancaEntregaTesteLocal(lojistaUid, valorPix, envioId);
                await sincronizarCamposEnvioLojista(lojistaUid, envioId, {
                    'cobrancaEntrega/status': 'pago',
                    'cobrancaEntrega/pagoEm': Date.now()
                }).catch((e) => console.warn('Falha ao persistir cobrança simulada como paga:', e));
                pac.cobrancaEntrega = { ...pac.cobrancaEntrega, status: 'pago', pagoEm: Date.now() };
                renderSheetRotaEntregadorConteudo();
                return;
            }
        }

        alert(err.message || 'Não foi possível gerar o Pix agora.');
        if (btn) { btn.disabled = false; btn.innerText = 'Gerar Pix'; }
    }
}

function pararPollingPixCobrancaEntrega() {
    if (pixCobrancaEntregaPollTimer) {
        clearInterval(pixCobrancaEntregaPollTimer);
        pixCobrancaEntregaPollTimer = null;
    }
}

// O Pix da cobrança na entrega é pago pelo CLIENTE e cai como CRÉDITO NA
// CARTEIRA DO LOJISTA (não do entregador — o produto é dele, o entregador só
// intermedeia a cobrança; ver project-flexa-cobranca-entrega-dinheiro, decisão
// do dono 2026-08-16). Em produção (FLEXA_PAYMENTS_PROXY_URL) quem credita é o
// backend, em /check-pix-cobranca. No modo teste local (sem Cloud Function) tem
// que creditar aqui mesmo, pelo mesmo motivo dos outros pagamentos em modo
// teste (ver feedback_flexa_test_mode_escape_hatches).
async function creditarLojistaCobrancaEntregaTesteLocal(lojistaUid, valor, envioId) {
    if (!lojistaUid || !Number.isFinite(valor) || valor <= 0) return;
    try {
        const resultado = await ajustarSaldoUsuario(lojistaUid, valor);
        if (!resultado.ok) return;
        await db.ref(`usuarios/${lojistaUid}/financeiro/transacoes`).push({
            protocolo: gerarProtocoloTransacao(),
            tipo: 'CREDITO',
            metodo: 'pix',
            valor,
            descricao: `Cobrança na entrega recebida via Pix (pedido #${envioId}) [TESTE]`,
            remetente: 'Cliente (Pix simulado — ambiente teste)',
            destinatario: 'Carteira da loja',
            criadoEm: Date.now()
        });
    } catch (err) {
        console.warn('Falha ao creditar lojista pela cobrança via Pix (teste local):', err);
    }
}

// Desfecho de "pago" da cobrança-na-entrega — compartilhado entre o polling
// (pagamento realmente aprovado no Mercado Pago) e o botão de simulação em
// ambiente teste (ver simularAprovacaoCobrancaEntregaTeste), já que um Pix de
// TESTE nunca é aceito por um banco de verdade — não tem como um usuário
// pagar de verdade pra testar o resto do fluxo. Ver
// feedback_flexa_test_mode_escape_hatches.
async function finalizarCobrancaEntregaComoPaga(lojistaUid, envioId, valor) {
    const agora = Date.now();

    if (!FLEXA_PAYMENTS_PROXY_URL) {
        // Modo teste local: o backend não rodou, então credita o lojista e
        // persiste o desfecho aqui mesmo (produção já fez isso no backend).
        await creditarLojistaCobrancaEntregaTesteLocal(lojistaUid, valor, envioId);
        await sincronizarCamposEnvioLojista(lojistaUid, envioId, {
            'cobrancaEntrega/status': 'pago',
            'cobrancaEntrega/pagoEm': agora
        }).catch((err) => console.warn('Falha ao persistir cobrança paga via Pix (teste local):', err));
    }

    const pac = rotaEntSheetPacotes.find((p) => obterIdPacoteConfirmacao(p) === envioId);
    if (pac) pac.cobrancaEntrega = { ...pac.cobrancaEntrega, status: 'pago', pagoEm: agora };
    pixCobrancaEntregaAtual = null;
    renderSheetRotaEntregadorConteudo();
}

function iniciarPollingPixCobrancaEntrega() {
    pararPollingPixCobrancaEntrega();
    pixCobrancaEntregaPollTimer = setInterval(async () => {
        if (!pixCobrancaEntregaAtual?.paymentId) {
            pararPollingPixCobrancaEntrega();
            return;
        }
        try {
            const data = FLEXA_PAYMENTS_PROXY_URL
                ? await chamarPaymentsProxy('/check-pix-cobranca', { tenantId: pixCobrancaEntregaAtual.lojistaUid, paymentId: pixCobrancaEntregaAtual.paymentId })
                : await consultarPagamentoPixTesteClienteLocal(pixCobrancaEntregaAtual.paymentId);

            const statusEl = document.getElementById('ent-sheet-pix-status');
            if (data?.status === 'approved') {
                pararPollingPixCobrancaEntrega();
                const { lojistaUid, envioId, valor } = pixCobrancaEntregaAtual;
                await finalizarCobrancaEntregaComoPaga(lojistaUid, envioId, valor);
            } else if (statusEl) {
                statusEl.innerText = 'Aguardando pagamento do cliente...';
            }
        } catch (err) {
            console.warn('Falha ao consultar status do Pix de cobrança:', err);
        }
    }, 4000);
}

// Um Pix gerado com credencial de TESTE do Mercado Pago nunca é aceito por um
// banco de verdade (nenhum dinheiro real existe pra completar), então o
// polling acima nunca chegaria a "approved" sozinho — sem isto, o teste fica
// travado pra sempre em "Aguardando pagamento". Só aparece quando o ambiente
// é confirmadamente 'teste'.
async function simularAprovacaoCobrancaEntregaTeste() {
    if (!pixCobrancaEntregaAtual) return;
    if (!window.confirm('Simular esse Pix de cobrança como pago? Isso só deve ser usado em ambiente de TESTE.')) return;
    const { lojistaUid, envioId, valor } = pixCobrancaEntregaAtual;
    pararPollingPixCobrancaEntrega();
    try {
        await finalizarCobrancaEntregaComoPaga(lojistaUid, envioId, valor);
    } catch (err) {
        console.warn('Falha ao simular cobrança paga:', err);
        alert('Não foi possível simular o pagamento agora. Tente novamente.');
    }
}

function copiarCodigoPixCobrancaEntrega() {
    if (!pixCobrancaEntregaAtual?.pixCode) return;
    navigator.clipboard?.writeText(pixCobrancaEntregaAtual.pixCode).then(() => {
        const feedback = document.getElementById('ent-sheet-pix-copy-feedback');
        if (feedback) feedback.innerText = 'Código copiado!';
        notificarSucesso('Código Pix copiado!');
    }).catch(() => notificarErro('Não foi possível copiar automaticamente.'));
}

// ===================== [DINHEIRO / MISTO DA COBRANÇA NA ENTREGA] =====================
// Confirma o recebimento quando SÓ dinheiro está habilitado pra esse envio
// (nenhum split necessário). Ver confirmarPagamentoMistoCobranca pro caso em
// que dinheiro E Pix estão habilitados juntos.
// SEGURANÇA (2026-09-27): o valor recebido em dinheiro agora é sempre
// validado pelo servidor contra cobrancaEntrega.valor persistido (mesma
// checagem que /create-pix-cobranca já faz pro Pix) — antes o navegador do
// entregador podia reportar qualquer valor pra qualquer lojista.
async function confirmarRecebimentoDinheiro() {
    const rotaObj = rotaEntSheetRotaAtual;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    const cobranca = pac?.cobrancaEntrega;
    if (!rotaObj || !cobranca?.ativa || cobranca.status !== 'pendente') return;

    const valor = Number(cobranca.valor || 0);
    if (!Number.isFinite(valor) || valor <= 0) return;

    const confirmado = window.confirm(
        `Confirmar que recebeu ${precoParaMoeda(valor)} em dinheiro do cliente? Esse valor vira dívida sua com a plataforma até a próxima rota concluída (liquidação automática).`
    );
    if (!confirmado) return;

    const lojistaUid = obterLojistaUidDaRota(rotaObj, pac);
    const rotaId = rotaObj?.id;
    const envioId = obterIdPacoteConfirmacao(pac);

    try {
        const data = await chamarPaymentsProxy('/confirmar-cobranca-dinheiro', {
            tenantId: lojistaUid,
            rotaId,
            envioId
        });
        const agora = Date.now();
        pac.cobrancaEntrega = { ...cobranca, status: 'pago', valorDinheiro: Number(data?.valor ?? valor), valorPix: 0, pagoEm: agora };
        renderSheetRotaEntregadorConteudo();
    } catch (err) {
        console.warn('Falha ao confirmar recebimento em dinheiro:', err);
        alert('Não foi possível registrar o recebimento agora. Tente novamente.');
    }
}

// Atualiza só o texto "Restante no Pix" ao digitar — não grava nada ainda,
// é puramente visual até o entregador clicar em confirmar.
function atualizarRestantePixCobranca(valorDigitado) {
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    const total = Number(pac?.cobrancaEntrega?.valor || 0);
    let dinheiro = parseMoedaParaNumero(valorDigitado || 0);
    if (!Number.isFinite(dinheiro) || dinheiro < 0) dinheiro = 0;
    if (dinheiro > total) dinheiro = total;
    const restante = Number((total - dinheiro).toFixed(2));
    const label = document.getElementById('ent-sheet-cobranca-restante-label');
    if (label) label.innerText = restante > 0 ? `Restante no Pix: ${precoParaMoeda(restante)}` : 'Dinheiro cobre o total — nenhum Pix necessário.';
}

// Pagamento misto: dinheiro e Pix habilitados juntos pro mesmo envio. O
// entregador digita quanto recebeu em dinheiro; o resto (se sobrar) vira um
// Pix cobrado só da diferença. Ver project-flexa-cobranca-entrega-dinheiro
// (pedido do dono 2026-08-16).
async function confirmarPagamentoMistoCobranca() {
    const rotaObj = rotaEntSheetRotaAtual;
    const pac = rotaEntSheetPacotes[rotaEntSheetIndex] || {};
    const cobranca = pac?.cobrancaEntrega;
    if (!rotaObj || !cobranca?.ativa || cobranca.status !== 'pendente') return;

    const total = Number(cobranca.valor || 0);
    const input = document.getElementById('ent-sheet-cobranca-dinheiro-input');
    let valorDinheiro = parseMoedaParaNumero(input?.value || 0);
    if (!Number.isFinite(valorDinheiro) || valorDinheiro < 0) valorDinheiro = 0;
    if (valorDinheiro > total) {
        alert(`O valor em dinheiro não pode ser maior que o total da cobrança (${precoParaMoeda(total)}).`);
        return;
    }
    const valorPix = Number((total - valorDinheiro).toFixed(2));

    if (valorDinheiro > 0) {
        const aviso = valorPix > 0
            ? `Confirmar que recebeu ${precoParaMoeda(valorDinheiro)} em dinheiro do cliente? O restante de ${precoParaMoeda(valorPix)} vai ser cobrado via Pix a seguir. O valor em dinheiro vira dívida sua com a plataforma até a próxima rota concluída (liquidação automática).`
            : `Confirmar que recebeu ${precoParaMoeda(valorDinheiro)} em dinheiro do cliente? Esse valor vira dívida sua com a plataforma até a próxima rota concluída (liquidação automática).`;
        if (!window.confirm(aviso)) return;
    } else if (valorPix <= 0) {
        alert('Digite quanto foi recebido em dinheiro, ou gere o Pix pelo valor cheio.');
        return;
    }

    const lojistaUid = obterLojistaUidDaRota(rotaObj, pac);
    const uidEntregador = getUsuarioIdAtual();
    const envioId = obterIdPacoteConfirmacao(pac);
    const agora = Date.now();

    try {
        if (valorPix <= 0) {
            // Dinheiro cobriu o total — mesma rota seguida pelo fluxo "só
            // dinheiro" (plano de segurança 2026-09-27): o servidor recalcula o
            // valor a partir de cobrancaEntrega.valor persistido e credita a
            // dívida do entregador, nunca confia no que este app mandar.
            const data = await chamarPaymentsProxy('/confirmar-cobranca-dinheiro', { tenantId: lojistaUid, rotaId: rotaObj.id, envioId });
            pac.cobrancaEntrega = { ...cobranca, status: 'pago', valorDinheiro: Number(data?.valor ?? total), valorPix: 0, pagoEm: agora };
            renderSheetRotaEntregadorConteudo();
            return;
        }

        // Sobrou parte em Pix: registra a dívida do valor já recebido em
        // dinheiro (escrita na própria conta, autorizada) e grava o valor
        // pra não perder o registro se o app fechar no meio — o teto do Pix
        // em si já é sempre revalidado no servidor (/create-pix-cobranca).
        const resultadoDivida = await ajustarDividaUsuario(uidEntregador, valorDinheiro);
        if (!resultadoDivida.ok) throw new Error('Falha ao registrar dívida.');
        if (lojistaUid && envioId) {
            await sincronizarCamposEnvioLojista(lojistaUid, envioId, {
                'cobrancaEntrega/valorDinheiro': valorDinheiro,
                'cobrancaEntrega/valorPix': valorPix
            });
        }
        pac.cobrancaEntrega = { ...cobranca, valorDinheiro, valorPix };
        await gerarPixCobrancaEntrega(valorPix);
    } catch (err) {
        console.warn('Falha ao confirmar pagamento misto da cobrança:', err);
        alert('Não foi possível registrar o recebimento agora. Tente novamente.');
    }
}

function renderBlocoCobrancaEntrega(pac) {
    const cobranca = pac?.cobrancaEntrega;
    if (!cobranca?.ativa) return '';

    if (cobranca.status === 'pago') {
        const partes = [];
        if (Number(cobranca.valorDinheiro) > 0) partes.push(`${precoParaMoeda(cobranca.valorDinheiro)} em dinheiro`);
        if (Number(cobranca.valorPix) > 0) partes.push(`${precoParaMoeda(cobranca.valorPix)} via Pix`);
        const texto = partes.length ? `${partes.join(' + ')} recebidos` : `${precoParaMoeda(cobranca.valor)} recebidos`;
        return `<div class="ent-sheet-cobranca-box ent-sheet-cobranca-ok"><i data-lucide="check-circle-2"></i> ${texto}</div>`;
    }
    // Compat com registros antigos gravados antes do pagamento misto existir.
    if (cobranca.status === 'pago_pix') {
        return `<div class="ent-sheet-cobranca-box ent-sheet-cobranca-ok"><i data-lucide="check-circle-2"></i> Pix de ${precoParaMoeda(cobranca.valor)} recebido pela plataforma</div>`;
    }
    if (cobranca.status === 'pago_dinheiro') {
        return `<div class="ent-sheet-cobranca-box ent-sheet-cobranca-ok"><i data-lucide="check-circle-2"></i> ${precoParaMoeda(cobranca.valor)} recebidos em dinheiro</div>`;
    }

    const formasAceitas = Array.isArray(cobranca.formasAceitas) ? cobranca.formasAceitas : [];
    const podeGerarPix = formasAceitas.includes('pix');
    const podeReceberDinheiro = formasAceitas.includes('dinheiro');
    const envioIdAtual = obterIdPacoteConfirmacao(pac);
    const pixAtivo = pixCobrancaEntregaAtual && pixCobrancaEntregaAtual.envioId === envioIdAtual;

    if (pixAtivo) {
        const valorDinheiroJaRecebido = Number(cobranca.valorDinheiro) > 0 ? Number(cobranca.valorDinheiro) : 0;
        return `
        <div class="ent-sheet-cobranca-box">
            <strong>Cobrar ${precoParaMoeda(pixCobrancaEntregaAtual.valor || cobranca.valor)} do cliente via Pix</strong>
            ${valorDinheiroJaRecebido > 0 ? `<p class="ent-sheet-pix-status" style="margin-top:2px;">${precoParaMoeda(valorDinheiroJaRecebido)} já recebidos em dinheiro</p>` : ''}
            ${pixCobrancaEntregaAtual.qrCodeBase64 ? `<img class="ent-sheet-pix-qr-img" src="data:image/png;base64,${pixCobrancaEntregaAtual.qrCodeBase64}" alt="QR Code Pix">` : ''}
            <textarea readonly class="ent-sheet-pix-copia" onclick="this.select()">${escaparHtmlMarketplace(pixCobrancaEntregaAtual.pixCode)}</textarea>
            <div class="ent-sheet-actions-inline">
                <button type="button" class="ent-sheet-btn-ghost" onclick="copiarCodigoPixCobrancaEntrega()">Copiar código Pix</button>
            </div>
            <div id="ent-sheet-pix-status" class="ent-sheet-pix-status">Aguardando pagamento do cliente...</div>
            <div id="ent-sheet-pix-copy-feedback" class="ent-sheet-pix-copy-feedback"></div>
            ${mercadoPagoAmbienteAtual === 'teste' ? `<button type="button" class="ent-sheet-link" onclick="simularAprovacaoCobrancaEntregaTeste()">Simular pagamento aprovado (teste)</button>` : ''}
        </div>`;
    }

    // Só uma forma aceita pra esse envio — fluxo direto, sem split.
    if (podeReceberDinheiro && !podeGerarPix) {
        return `
        <div class="ent-sheet-cobranca-box">
            <strong>Cobrar ${precoParaMoeda(cobranca.valor)} em dinheiro na entrega</strong>
            <div class="ent-sheet-actions-inline">
                <button type="button" class="ent-sheet-primary small" onclick="confirmarRecebimentoDinheiro()">Recebi em dinheiro</button>
            </div>
        </div>`;
    }
    if (podeGerarPix && !podeReceberDinheiro) {
        return `
        <div class="ent-sheet-cobranca-box">
            <strong>Cobrar ${precoParaMoeda(cobranca.valor)} do cliente via Pix</strong>
            <div class="ent-sheet-actions-inline">
                <button type="button" id="ent-sheet-pix-gerar-btn" class="ent-sheet-btn-ghost" onclick="gerarPixCobrancaEntrega()">Gerar Pix</button>
            </div>
        </div>`;
    }

    // As duas formas aceitas: entregador informa o split (pagamento misto —
    // dinheiro + o restante automaticamente vira Pix).
    return `
    <div class="ent-sheet-cobranca-box">
        <strong>Cobrar ${precoParaMoeda(cobranca.valor)} do cliente na entrega</strong>
        <label for="ent-sheet-cobranca-dinheiro-input" style="display:block; margin-top:8px; font-size:12px; font-weight:700; color:#475569;">Recebido em dinheiro (deixe 0 se for tudo no Pix)</label>
        <input id="ent-sheet-cobranca-dinheiro-input" type="text" inputmode="decimal" placeholder="R$ 0,00" oninput="atualizarRestantePixCobranca(this.value)">
        <p id="ent-sheet-cobranca-restante-label" class="ent-sheet-pix-status">Restante no Pix: ${precoParaMoeda(cobranca.valor)}</p>
        <div class="ent-sheet-actions-inline">
            <button type="button" class="ent-sheet-primary small" onclick="confirmarPagamentoMistoCobranca()">Confirmar recebimento</button>
        </div>
    </div>`;
}

// Distância em linha reta (Haversine) entre 2 pontos {lat, lon} — suficiente
// pra ORDENAR paradas por proximidade (não precisa da distância de rua real
// que o Google Maps calcula depois, só de saber qual é mais perto de qual).
function distanciaHaversineKm(a, b) {
    if (!a || !b) return Infinity;
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Regra geral pedida pelo dono 2026-09-23: a rota deixa de seguir a ordem em
// que os pacotes foram selecionados/clicados e passa a visitar sempre a
// parada mais próxima da posição atual, começando na loja (vizinho mais
// próximo, guloso — não é o caminho matematicamente ótimo, mas é o padrão
// mais simples e comum pra esse tipo de app, e já resolve o caso real: não
// ziguezaguear pela cidade). Pacotes sem geo (endereço não geocodificado)
// ficam no fim, na ordem original, pra não travar a rota por causa de 1
// endereço com problema. Não tenta detectar "essa entrega é urgente" a
// partir do texto da observação — isso fica pra decisão manual do lojista.
function ordenarPacotesPorProximidade(itens) {
    const origemGeo = normalizarGeo(window.usuarioLogado?.endereco?.geo);
    const comGeo = itens.filter((it) => it.destinoGeo);
    const semGeo = itens.filter((it) => !it.destinoGeo);
    if (!origemGeo || comGeo.length < 2) return itens;

    const restantes = [...comGeo];
    const ordenado = [];
    let atual = origemGeo;
    while (restantes.length) {
        let idxMaisProximo = 0;
        let menorDist = Infinity;
        restantes.forEach((it, idx) => {
            const d = distanciaHaversineKm(atual, it.destinoGeo);
            if (d < menorDist) { menorDist = d; idxMaisProximo = idx; }
        });
        const [proximo] = restantes.splice(idxMaisProximo, 1);
        ordenado.push(proximo);
        atual = proximo.destinoGeo;
    }
    return [...ordenado, ...semGeo];
}

async function irParaPagamentoRota() {
    const selecionados = rotaPendentesCache.filter((item) => rotaSelecaoIds.has(item.id));
    if (!selecionados.length) {
        alert('Selecione pelo menos 1 pacote para continuar.');
        return;
    }

    const total = selecionados.reduce((acc, item) => acc + Number(item.valorFrete || 0), 0);
    const selecionadosOrdenados = ordenarPacotesPorProximidade(selecionados);

    rotaDraftAtual = {
        id: gerarIdRota(),
        pacotes: selecionadosOrdenados.map((item) => item.id),
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
        // BUG CORRIGIDO 2026-09-19: mercadoPagoAmbienteAtual já é atualizado com
        // o ambiente real que veio na resposta (chamarPaymentsProxy), mas esse
        // aviso na tela só era redesenhado ANTES da chamada — ficava mostrando
        // "Ambiente TESTE" preso de uma sessão anterior mesmo quando a cobrança
        // que acabou de ser gerada já era de produção. Bug puramente visual, o
        // Pix em si já estava correto.
        atualizarAvisoAmbientePix();
        if (mercadoPagoAmbienteAtual === 'teste') {
            setStatusPagamentoPixRota('Pix de teste gerado. Em banco real ele pode ser recusado.', 'warning');
        } else {
            setStatusPagamentoPixRota('Pix gerado com sucesso. Aguardando pagamento...', 'pending');
        }
        renderEtapaModalRota();
    } catch (erro) {
        console.warn('Falha ao gerar Pix no Mercado Pago:', erro);
        rotaDraftAtual.pagamentoMercadoPago = null;
        rotaPixCodigoRawAtual = '';
        if (pixTxt) pixTxt.textContent = '--';
        setTicketPagamentoPixRota('');
        atualizarAvisoAmbientePix();

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

    const mensagem = copiado
        ? (mercadoPagoAmbienteAtual === 'teste' ? 'Código Pix copiado (ambiente TESTE).' : 'Código Pix copiado.')
        : 'Não foi possível copiar automaticamente.';
    if (feedback) feedback.innerText = mensagem;
    // O texto acima é discreto e fica escondido atrás do card do Pix em
    // telas pequenas — duplica como toast (igual o resto do app) pra sempre
    // ficar visível. Ver pedido do dono, 2026-09-18.
    if (copiado) notificarSucesso(mensagem); else notificarErro(mensagem);
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

    // BUG CORRIGIDO 2026-10-02: só atualizava o modelo antigo (historico) —
    // usuarios/{uid}/pacotes/{id}/status ficava parado em PACOTE_NOVO entre
    // criar a rota e o entregador aceitar, mesma causa raiz do status do
    // pedido não acompanhar o da rota.
    const uid = getUsuarioIdAtual();
    if (uid) {
        const updatesPacotes = {};
        const agora = Date.now();
        envioIds.forEach((id) => {
            updatesPacotes[`usuarios/${uid}/pacotes/${id}/status`] = 'BUSCANDO';
            updatesPacotes[`usuarios/${uid}/pacotes/${id}/statusRaw`] = 'BUSCANDO';
            updatesPacotes[`usuarios/${uid}/pacotes/${id}/rotaId`] = rotaId;
            updatesPacotes[`usuarios/${uid}/pacotes/${id}/atualizadoEm`] = agora;
        });
        db.ref().update(updatesPacotes).catch(() => {});
        // Mantém window.pacotesRaizCache (lido por coletarEnviosDaBase) em dia
        // na MESMA sessão, sem esperar um reload — pacotesRaizCache[uid] só é
        // buscado uma vez no login (ver carregarPacotesRaizDoUid).
        if (window.pacotesRaizCache?.[uid]) {
            envioIds.forEach((id) => {
                if (window.pacotesRaizCache[uid][id]) {
                    window.pacotesRaizCache[uid][id] = { ...window.pacotesRaizCache[uid][id], status: 'BUSCANDO', statusRaw: 'BUSCANDO', rotaId, atualizadoEm: agora };
                }
            });
        }
    }
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
        await criarLinksRastreioParaRota(rota, uid);
    } catch (err) {
        console.warn('Falha ao salvar rota no banco:', err);
    }
}

// ===== [RASTREIO PÚBLICO DO CLIENTE FINAL] (2026-09-20) =====
// Ver comentário em backend/database.rules.json sobre "rastreioToken" e
// "rastreioPublico" — o motivo de existir uma cópia separada em vez de abrir
// a rota/pacote de verdade pra leitura pública.
function gerarTokenRastreio() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    return 'rt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

// Chamado assim que a rota é salva (lojista pagou/confirmou o frete) — é o
// momento mais cedo em que dá pra gerar um link por pacote, mesmo que ainda
// não tenha entregador. A tela pública mostra "aguardando entregador" até
// alguém aceitar (ver atualização em aceitarRotaMarketplaceEntregador).
async function criarLinksRastreioParaRota(rota, uidLojista) {
    try {
        const pacoteIds = Array.isArray(rota?.pacotes) ? rota.pacotes.map(String) : [];
        if (!pacoteIds.length) return;

        const lojaNome = (window.usuarioLogado?.loja || window.usuarioLogado?.nome || 'Loja').toString();
        const pacotesMapa = {};
        const updates = {};
        let tipoFluxoRota = 'entrega';

        // "ordem" é a posição do pacote dentro da rota (1ª parada, 2ª parada...) —
        // pela ordem em que o lojista montou a rota, já que ainda não existe
        // otimização automática de sequência de paradas. É isso que permite a
        // tela pública mostrar "sua parada é a 3ª de 5".
        for (let idx = 0; idx < pacoteIds.length; idx++) {
            const pacoteId = pacoteIds[idx];
            let destinatario = 'Cliente';
            let destinoChave = pacoteId; // fallback: se não achar endereço, cada pacote fica no seu próprio ponto
            let whatsappCliente = '';
            let codigoConfirmacao = '';
            let codigoRetirada = '';
            let pontoGeo = null;
            let enderecoDestino = null;
            try {
                const snap = await db.ref(`usuarios/${uidLojista}/pacotes/${pacoteId}`).once('value');
                const pac = snap.val() || {};
                destinatario = (pac.destinatario || destinatario).toString();
                whatsappCliente = normalizarWhatsapp(pac.whatsapp || '');
                // Endereço estruturado (rua/uf não existem soltos no pacote, só
                // dentro de destinoEndereco já formatado) — busca no cadastro do
                // cliente pra levar pra tela pública de "complete seu cadastro"
                // (pedido do dono 2026-10-03: cliente confirma o endereço que o
                // lojista já digitou, em vez de digitar tudo de novo). Só pro
                // fluxo normal (coleta reversa não faz sentido aqui — o destino
                // é a própria loja).
                if (pac.clienteId && pac.tipoFluxo !== 'coleta_reversa') {
                    try {
                        const cliSnap = await db.ref(`usuarios/${uidLojista}/clientes/${pac.clienteId}`).once('value');
                        const cli = cliSnap.val() || {};
                        enderecoDestino = {
                            cep: cli.cep || pac.cepDestino || '',
                            rua: cli.rua || '',
                            num: cli.num || pac.numero || '',
                            bairro: cli.bairro || pac.bairroDestino || '',
                            cidade: cli.cidade || pac.cidadeDestino || '',
                            uf: cli.uf || '',
                            comp: cli.comp || pac.complemento || ''
                        };
                    } catch (e) { /* segue sem endereço estruturado */ }
                }
                // Ponto de chegada desse pacote (pra tela pública estimar
                // "+- quanto tempo falta" a partir da posição AO VIVO do
                // entregador, em vez de só repartir a duração total da rota
                // — ver cálculo em renderConteudoRastreioPublico).
                pontoGeo = pac.tipoFluxo === 'coleta_reversa' ? (pac.origemGeo || null) : (pac.destinoGeo || null);
                // Código de confirmação também vai pro nó público — é o que
                // permite a tela de rastreio mostrar "seu código é X" (pedido
                // do dono 2026-09-25). Só quem tem o link/token específico
                // desse pacote consegue ver, mesmo nível de acesso que já
                // existe pro resto dos dados aqui.
                codigoConfirmacao = (pac.codigoConfirmacaoEntrega || '').toString();
                codigoRetirada = (pac.codigoConfirmacaoRetirada || '').toString();
                if (pac.tipoFluxo === 'coleta_reversa') tipoFluxoRota = 'coleta_reversa';
                // Pacotes pro MESMO endereço viram um só ponto na timeline
                // (pedido do dono 2026-09-21) — normaliza pra não separar por
                // causa de espaço/maiúscula diferente. Numa coleta reversa o
                // endereço que VARIA por pacote é a origem (cliente), não o
                // destino (loja, igual pra todo mundo) — agrupa pelo lado
                // certo em cada caso.
                const campoEndereco = pac.tipoFluxo === 'coleta_reversa'
                    ? (pac.origemCompleta || pac.origemEndereco)
                    : (pac.destinoCompleto || pac.destinoEndereco);
                const enderecoBruto = (campoEndereco || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
                if (enderecoBruto) destinoChave = enderecoBruto;
            } catch (e) { /* pacote pode não existir no modelo novo ainda — mantém o padrão */ }

            const token = gerarTokenRastreio();
            updates[`usuarios/${uidLojista}/pacotes/${pacoteId}/tokenRastreio`] = token;
            updates[`rastreioToken/${token}`] = { rotaId: String(rota.id), pacoteId, lojistaUid: uidLojista };
            // Também grava na própria rota (tokensRastreio) pra tela de
            // detalhes (renderRotaDetalhePagina) conseguir mostrar o botão
            // "Copiar link" sem precisar de uma busca extra no banco.
            updates[`usuarios/${uidLojista}/rotas/${rota.id}/tokensRastreio/${pacoteId}`] = token;
            // Índice mínimo pro cliente logado (ver contas do cliente final,
            // src/legacy-monolith.js `renderMeusPedidosCliente`) achar seus
            // próprios pedidos em QUALQUER loja, sem expor endereço/dados de
            // outros clientes — mesmo padrão de índice mínimo já usado em
            // clientesGlobais/telefoneParaEmail.
            if (whatsappCliente) {
                updates[`pedidosPorCliente/${whatsappCliente}/${token}`] = { lojistaNome: lojaNome, criadoEm: Date.now() };
            }
            pacotesMapa[pacoteId] = { destinatario, destinoChave, status: 'BUSCANDO', ordem: idx + 1, codigoConfirmacaoEntrega: codigoConfirmacao, codigoConfirmacaoRetirada: codigoRetirada, geo: pontoGeo, enderecoDestino };
        }

        updates[`rastreioPublico/${rota.id}`] = {
            lojaNome,
            statusRota: 'BUSCANDO',
            tipoFluxo: tipoFluxoRota,
            coletaConfirmada: false,
            entregadorNome: null,
            entregadorGeo: null,
            distanciaKm: Number(rota.distanciaTotal || 0) || null,
            duracaoMin: Number(rota.duracaoTotal || 0) || null,
            totalParadas: pacoteIds.length,
            atualizadoEm: Date.now(),
            pacotes: pacotesMapa
        };

        await db.ref().update(updates);
    } catch (err) {
        console.warn('Falha ao criar links de rastreio da rota:', err);
    }
}

// Tela pública (sem login) que o cliente final abre pelo link enviado pela
// loja. Usa um listener ao vivo em vez de leitura única — o objetivo é o
// cliente ver o status/localização mudando sozinho, sem precisar recarregar.
let rastreioPublicoListenerRef = null;

// ===== [CONTA DO CLIENTE FINAL] (2026-09-23) =====
// Login/cadastro acessível a partir da tela de rastreio público, pra dar ao
// cliente final uma conta única que no futuro reúne os pedidos dele em
// qualquer loja parceira (hoje só a mecânica de conta; o "meus pedidos"
// entre lojas fica pra depois). Usa uma instância SECUNDÁRIA do Firebase
// (mesmo projeto, auth isolada) em vez de firebase.auth() — a auth
// principal do app não tem nenhum conceito de usuário "cliente" (só
// lojista/entregador) e o onAuthStateChanged global tentaria montar um
// dashboard de loja com os dados vazios de uma conta cliente. Mantendo a
// sessão do cliente isolada, a tela de rastreio continua funcionando do
// jeito que já funciona (leitura pública via token), e a conta logada é só
// um estado a mais nessa mesma tela.
let clienteAuthApp = null;
let clienteAuthListenerAtivo = false;
function obterClienteAuthApp() {
    if (!clienteAuthApp) {
        clienteAuthApp = firebase.initializeApp(firebase.app().options, 'clienteAuth');
    }
    return clienteAuthApp;
}
function obterClienteAuth() {
    const auth2 = obterClienteAuthApp().auth();
    // A sessão persistida (localStorage) dessa instância só termina de ser
    // restaurada de forma ASSÍNCRONA — auth2.currentUser continua null por um
    // instante logo após dar reload na página, mesmo com uma conta já
    // logada. Sem esse listener, atualizarUiClienteAuth() (chamada na carga
    // da tela) sempre achava "deslogado" nesse primeiro instante e nunca
    // corrigia depois, então o botão Entrar/Cadastre-se ficava preso mesmo
    // com o cliente logado.
    if (!clienteAuthListenerAtivo) {
        clienteAuthListenerAtivo = true;
        auth2.onAuthStateChanged(() => atualizarUiClienteAuth());
    }
    return auth2;
}
function obterClienteDb() {
    return obterClienteAuthApp().database();
}

function abrirModalClienteAuth(modo) {
    alternarClienteAuthTab(modo || 'entrar');
    const overlay = document.getElementById('overlay-cliente-auth');
    const sheet = document.getElementById('sheet-cliente-auth');
    if (!overlay || !sheet) return;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
        sheet.classList.add('is-open');
    });
}

function fecharModalClienteAuth() {
    const overlay = document.getElementById('overlay-cliente-auth');
    const sheet = document.getElementById('sheet-cliente-auth');
    if (!overlay || !sheet) return;
    sheet.classList.remove('is-open');
    setTimeout(() => {
        overlay.style.display = 'none';
    }, 220);
}

function alternarClienteAuthTab(modo) {
    const fCad = document.getElementById('form-cliente-cadastrar');
    const fEnt = document.getElementById('form-cliente-entrar');
    const fCompletar = document.getElementById('form-cliente-completar');
    if (!fCad || !fEnt) return;
    if (fCompletar) fCompletar.classList.add('hidden');
    if (modo === 'cadastrar') {
        fCad.classList.remove('hidden');
        fEnt.classList.add('hidden');
    } else {
        fEnt.classList.remove('hidden');
        fCad.classList.add('hidden');
    }
}

function abrirClienteAuthCompletarCadastro(nomeAtual) {
    const fCad = document.getElementById('form-cliente-cadastrar');
    const fEnt = document.getElementById('form-cliente-entrar');
    const fCompletar = document.getElementById('form-cliente-completar');
    if (!fCad || !fEnt || !fCompletar) return;
    fCad.classList.add('hidden');
    fEnt.classList.add('hidden');
    fCompletar.classList.remove('hidden');
    const nomeInput = document.getElementById('cliente-auth-completar-nome');
    if (nomeInput) nomeInput.value = nomeAtual || '';

    // Pré-preenche com o endereço que o lojista já digitou nesse envio (ver
    // enderecoDestinoRastreioAtual, gravado por renderConteudoRastreioPublico)
    // — o cliente só confere/corrige, não digita do zero.
    const end = enderecoDestinoRastreioAtual;
    const campos = {
        'cliente-auth-completar-cep': end?.cep,
        'cliente-auth-completar-rua': end?.rua,
        'cliente-auth-completar-num': end?.num,
        'cliente-auth-completar-bairro': end?.bairro,
        'cliente-auth-completar-cidade': end?.cidade,
        'cliente-auth-completar-estado': end?.uf,
        'cliente-auth-completar-comp': end?.comp
    };
    Object.keys(campos).forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = campos[id] || '';
    });
}

async function cadastrarClienteRastreio() {
    const nome = (document.getElementById('cliente-auth-nome')?.value || '').trim();
    const whatsapp = normalizarWhatsapp(document.getElementById('cliente-auth-whatsapp')?.value || '');
    const email = (document.getElementById('cliente-auth-email')?.value || '').trim();
    const senha = (document.getElementById('cliente-auth-senha')?.value || '').trim();

    if (!nome || !whatsapp || !email || !senha) return alert('Preencha todos os campos.');

    const auth2 = obterClienteAuth();
    const db2 = obterClienteDb();
    try {
        // BUG CORRIGIDO 2026-09-26: só bloqueia se a conta existente
        // realmente foi CONCLUÍDA — um convite de senha temporária do
        // lojista que a pessoa nunca chegou a usar não deveria travar o
        // autocadastro dela aqui (mesma raiz do bug em convidarClienteParaApp).
        const globalExistente = (await db2.ref('clientesGlobais/' + whatsapp).once('value')).val();
        if (globalExistente?.cadastroCompleto === true) {
            alert('Esse número de WhatsApp já tem conta. Toque em "Entrar".');
            return;
        }

        const cred = await auth2.createUserWithEmailAndPassword(email, senha);
        await db2.ref('usuarios/' + cred.user.uid).set({
            nome, email, whatsapp, tipo: 'cliente', criadoEm: Date.now(), cadastroCompleto: true
        });
        await db2.ref('telefoneParaEmail/' + whatsapp).set(email);
        // Mesmo índice usado pela busca de cliente do lojista (ver
        // salvarNovoCliente) — assim uma loja que já tinha esse número
        // cadastrado manualmente passa a enxergar o mesmo nome que o
        // cliente confirmou na própria conta. .update() (não .set()) pra
        // nunca apagar um perfil/endereço que já exista nesse telefone.
        await db2.ref('clientesGlobais/' + whatsapp).update({ nome, whatsapp, uid: cred.user.uid, cadastroCompleto: true });

        fecharModalClienteAuth();
        atualizarUiClienteAuth();
    } catch (error) {
        alert('Erro ao cadastrar: ' + error.message);
    }
}

async function loginClienteRastreio() {
    const whatsapp = normalizarWhatsapp(document.getElementById('cliente-auth-login-whatsapp')?.value || '');
    const senha = document.getElementById('cliente-auth-login-senha')?.value || '';
    if (!whatsapp || !senha) return alert('Preencha WhatsApp e senha.');

    const auth2 = obterClienteAuth();
    const db2 = obterClienteDb();
    try {
        const email = (await db2.ref('telefoneParaEmail/' + whatsapp).once('value')).val();
        if (!email) {
            alert('Não encontramos uma conta com esse número de WhatsApp.');
            return;
        }
        const cred = await auth2.signInWithEmailAndPassword(email, senha);
        const dadosUser = (await db2.ref('usuarios/' + cred.user.uid).once('value')).val();
        if (!dadosUser || dadosUser.tipo !== 'cliente') {
            await auth2.signOut();
            alert('Essa conta não é de cliente. Entre pelo login de loja/entregador.');
            return;
        }

        // Conta criada por CONVITE do lojista (ver convidarClienteAtualParaApp)
        // ainda com senha temporária — pede pro próprio cliente confirmar os
        // dados e trocar a senha antes de considerar a conta ativa.
        if (dadosUser.cadastroCompleto === false) {
            abrirClienteAuthCompletarCadastro(dadosUser.nome);
            return;
        }

        fecharModalClienteAuth();
        atualizarUiClienteAuth();
    } catch (error) {
        alert('Erro ao entrar: ' + error.message);
    }
}

async function completarCadastroClienteRastreio() {
    const auth2 = obterClienteAuth();
    const db2 = obterClienteDb();
    const user = auth2.currentUser;
    if (!user) return;

    const nome = (document.getElementById('cliente-auth-completar-nome')?.value || '').trim();
    const email = (document.getElementById('cliente-auth-completar-email')?.value || '').trim();
    const novaSenha = (document.getElementById('cliente-auth-completar-senha')?.value || '').trim();
    const cep = (document.getElementById('cliente-auth-completar-cep')?.value || '').trim();
    const rua = (document.getElementById('cliente-auth-completar-rua')?.value || '').trim();
    const num = (document.getElementById('cliente-auth-completar-num')?.value || '').trim();
    const bairro = (document.getElementById('cliente-auth-completar-bairro')?.value || '').trim();
    const cidade = (document.getElementById('cliente-auth-completar-cidade')?.value || '').trim();
    const uf = (document.getElementById('cliente-auth-completar-estado')?.value || '').trim();
    const comp = (document.getElementById('cliente-auth-completar-comp')?.value || '').trim();

    if (!nome || !novaSenha) return alert('Preencha nome e a nova senha.');
    if (novaSenha.length < 6) return alert('A nova senha precisa ter pelo menos 6 caracteres.');

    try {
        const dadosAntes = (await db2.ref('usuarios/' + user.uid).once('value')).val() || {};
        const whatsapp = dadosAntes.whatsapp || '';

        await user.updatePassword(novaSenha);

        // NÃO troca o e-mail de autenticação do Firebase aqui — updateEmail
        // exige que o e-mail novo já esteja verificado (auth/operation-not-allowed
        // senão, bug real encontrado 2026-09-25: travava o cadastro inteiro,
        // inclusive nome/senha, por causa só do e-mail opcional falhar). O
        // e-mail de login continua sendo o placeholder gerado no convite
        // (cliente.{whatsapp}@flex.local) — funciona porque o login é sempre
        // por WhatsApp (telefoneParaEmail), nunca por e-mail digitado. O que
        // a pessoa digitar aqui vira só um contato informativo.
        const updates = { nome, cadastroCompleto: true };
        if (email) updates.emailContato = email;
        await db2.ref('usuarios/' + user.uid).update(updates);
        // uid + cadastroCompleto:true aqui é o que permite convidarClienteParaApp
        // diferenciar "já tem conta ativa" de "convite antigo nunca concluído".
        // .update() (não .set()) pra nunca apagar um perfil/endereço já salvo.
        if (whatsapp) await db2.ref('clientesGlobais/' + whatsapp).update({ nome, whatsapp, uid: user.uid, cadastroCompleto: true });

        // Endereço confirmado pelo PRÓPRIO cliente — pedido do dono 2026-10-03:
        // a partir daqui a conta do cliente é dona desse endereço (qualquer
        // lojista que reusar esse contato por WhatsApp já recebe o endereço
        // certo, sem o cliente confirmar de novo loja por loja). Só grava se
        // a pessoa preencheu rua (endereço pode não ter vindo pré-preenchido
        // em acessos sem um envio específico por trás, ex: link genérico
        // #/cliente — nesse caso não bloqueia o resto do cadastro).
        if (whatsapp && rua) {
            await db2.ref('clientesGlobaisPerfil/' + whatsapp).update({
                nome, whatsapp, cep, rua, num, bairro, cidade, uf, comp,
                // Trava pra salvarNovoCliente (lado do lojista) não sobrescrever
                // mais um endereço que o próprio dono já confirmou — ver comentário lá.
                confirmadoPeloCliente: true,
                atualizadoEm: Date.now()
            });
        }

        fecharModalClienteAuth();
        atualizarUiClienteAuth();
        alert('Cadastro completo! Sua conta Flex já está ativa em todas as lojas parceiras.');
    } catch (error) {
        alert('Erro ao completar cadastro: ' + error.message);
    }
}

function sairClienteRastreio() {
    obterClienteAuth().signOut().finally(() => atualizarUiClienteAuth());
}

function atualizarUiClienteAuth() {
    const logado = document.getElementById('rastreio-pub-auth-logado');
    const deslogado = document.getElementById('rastreio-pub-auth-deslogado');
    const nomeEl = document.getElementById('rastreio-pub-auth-nome');
    if (!logado || !deslogado) return;

    const user = obterClienteAuth().currentUser;
    if (!user) {
        logado.style.display = 'none';
        deslogado.style.display = 'flex';
        // Só a tela genérica #/cliente (sem token) mostra esse card de boas-vindas
        // ou a lista de pedidos — uma tela de rastreio de verdade nunca é
        // sobrescrita por aqui.
        if (!tokenRastreioAtual) renderBemVindoClienteDeslogado();
        return;
    }

    obterClienteDb().ref('usuarios/' + user.uid).once('value').then((snap) => {
        const dados = snap.val();

        // Conta autenticada mas com senha temporária de convite ainda não
        // confirmada (ver completarCadastroClienteRastreio) não conta como
        // "logada" pra fins de UI — bug real encontrado 2026-09-25: o
        // cabeçalho mostrava "Olá, Nome" e a lista de Meus Pedidos mesmo
        // com o cadastro incompleto (ou tendo dado erro no meio), porque
        // aqui só checava "existe usuário autenticado", nunca cadastroCompleto.
        if (dados?.cadastroCompleto === false) {
            logado.style.display = 'none';
            deslogado.style.display = 'flex';
            if (!tokenRastreioAtual) renderBemVindoClienteDeslogado();
            return;
        }

        if (nomeEl) nomeEl.innerText = dados?.nome ? dados.nome.split(' ')[0] : 'cliente';
        logado.style.display = 'flex';
        deslogado.style.display = 'none';
        if (!tokenRastreioAtual) renderMeusPedidosCliente(dados?.whatsapp);
    });
}

function renderBemVindoClienteDeslogado() {
    const conteudo = document.getElementById('rastreio-pub-conteudo');
    if (!conteudo) return;
    conteudo.innerHTML = '<div class="rastreio-pub-card"><p class="rastreio-pub-titulo">Bem-vindo(a) à Flex</p><p class="rastreio-pub-status">Entre com seu WhatsApp e senha pra acompanhar seus pedidos, ou acesse pelo link de rastreio que a loja te enviou.</p></div>';
}

// "Meus pedidos": lista os pedidos do cliente logado em QUALQUER loja
// parceira, usando o índice mínimo pedidosPorCliente (ver
// criarLinksRastreioParaRota). Cada item é só um link pra tela de rastreio
// já existente daquele pedido — não duplica nenhum dado sensível aqui.
function renderMeusPedidosCliente(whatsapp) {
    const conteudo = document.getElementById('rastreio-pub-conteudo');
    if (!conteudo) return;
    if (!whatsapp) {
        conteudo.innerHTML = '<div class="rastreio-pub-card"><p class="rastreio-pub-titulo">Meus pedidos</p><p class="rastreio-pub-status">Não encontramos um WhatsApp na sua conta.</p></div>';
        return;
    }

    conteudo.innerHTML = '<div class="rastreio-pub-loading">Carregando seus pedidos...</div>';

    obterClienteDb().ref('pedidosPorCliente/' + whatsapp).once('value').then((snap) => {
        const dados = snap.val() || {};
        const itens = Object.entries(dados)
            .map(([token, info]) => ({ token, ...info }))
            .sort((a, b) => (Number(b?.criadoEm) || 0) - (Number(a?.criadoEm) || 0));

        if (!itens.length) {
            conteudo.innerHTML = '<div class="rastreio-pub-card"><p class="rastreio-pub-titulo">Meus pedidos</p><p class="rastreio-pub-status">Você ainda não tem nenhum pedido rastreado por aqui.</p></div>';
            return;
        }

        const linhas = itens.map((item) => {
            const dataTxt = item.criadoEm ? new Date(item.criadoEm).toLocaleDateString('pt-BR') : '--';
            return `
                <a class="meus-pedidos-item" href="#/rastreio/${encodeURIComponent(item.token)}">
                    <div>
                        <p class="meus-pedidos-loja">${escaparHtmlMarketplace(item.lojistaNome || 'Loja')}</p>
                        <p class="meus-pedidos-data">${dataTxt}</p>
                    </div>
                    <i data-lucide="chevron-right" size="18"></i>
                </a>`;
        }).join('');

        conteudo.innerHTML = `<div class="rastreio-pub-card"><p class="rastreio-pub-titulo">Meus pedidos</p><div class="meus-pedidos-lista">${linhas}</div></div>`;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }).catch(() => {
        conteudo.innerHTML = '<div class="rastreio-pub-erro">Não foi possível carregar seus pedidos agora.</div>';
    });
}

async function exibirTelaRastreioPublico(token) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const view = document.getElementById('view-rastreio-publico');
    if (view) view.classList.add('active');
    // Independe de quem chamou (onAuthStateChanged na carga inicial, ou o
    // hashchange direto de ativarModoRastreioSeNecessario quando o app já
    // estava aberto/logado) — essa tela nunca deve mostrar a barra de
    // navegação do app.
    const tabbar = document.getElementById('main-nav');
    if (tabbar) tabbar.style.display = 'none';
    atualizarUiClienteAuth();

    const conteudo = document.getElementById('rastreio-pub-conteudo');
    if (!conteudo) return;

    if (!token) {
        // Link genérico #/cliente (convite do lojista ou acesso direto, sem
        // uma entrega específica por trás) — atualizarUiClienteAuth() logo
        // acima já renderizou o conteúdo certo (boas-vindas se deslogado,
        // "Meus pedidos" se logado).
        return;
    }

    carregarBannersRastreioPublico();

    try {
        const tokenSnap = await db.ref(`rastreioToken/${token}`).once('value');
        const tokenInfo = tokenSnap.val();
        if (!tokenInfo?.rotaId) {
            conteudo.innerHTML = '<div class="rastreio-pub-erro">Link de rastreio inválido ou expirado.</div>';
            return;
        }

        if (rastreioPublicoListenerRef) rastreioPublicoListenerRef.off();
        rastreioPublicoListenerRef = db.ref(`rastreioPublico/${tokenInfo.rotaId}`);
        rastreioPublicoListenerRef.on('value', (snap) => {
            renderConteudoRastreioPublico(snap.val(), tokenInfo.pacoteId, tokenInfo.rotaId);
        });
    } catch (err) {
        console.warn('Falha ao carregar rastreio público:', err);
        conteudo.innerHTML = '<div class="rastreio-pub-erro">Não foi possível carregar o rastreio agora. Tente novamente em instantes.</div>';
    }
}

function renderConteudoRastreioPublico(dados, pacoteId, rotaId) {
    const conteudo = document.getElementById('rastreio-pub-conteudo');
    if (!conteudo) return;

    if (!dados) {
        conteudo.innerHTML = '<div class="rastreio-pub-erro">Rastreio não encontrado.</div>';
        return;
    }

    const pacotesMapa = dados.pacotes || {};
    const pacoteInfo = pacotesMapa[pacoteId] || {};
    const destinatario = pacoteInfo.destinatario || 'Cliente';
    const statusNorm = normalizarStatusRotaFiltro(dados.statusRota || 'BUSCANDO');
    // Guardado pra pré-preencher o endereço na tela de completar cadastro
    // (ver abrirClienteAuthCompletarCadastro) — o cliente confirma o que o
    // lojista já digitou nesse envio, em vez de digitar tudo de novo.
    if (pacoteInfo.enderecoDestino) enderecoDestinoRastreioAtual = pacoteInfo.enderecoDestino;

    // Paradas ordenadas pela sequência da rota, depois agrupadas por endereço
    // — 2+ pacotes pro MESMO destino (ex: dois pedidos pro mesmo prédio)
    // viram um ponto só na timeline (pedido do dono 2026-09-21), em vez de
    // um ponto por pacote.
    const paradasBrutas = Object.entries(pacotesMapa)
        .map(([id, p]) => ({ pacoteId: id, ...p }))
        .sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0));
    const paradas = agruparParadasPorEndereco(paradasBrutas);

    const totalParadas = paradas.length;
    const minhaParadaIdx = paradas.findIndex((grupo) => grupo.pacoteIds.some((id) => String(id) === String(pacoteId)));
    const minhaOrdem = minhaParadaIdx >= 0 ? minhaParadaIdx + 1 : 0;

    const timelineHtml = montarTimelineParadasRastreio(dados, paradas, pacoteId, statusNorm);

    // O status da ROTA inteira (statusRota) nem sempre reflete o pedido
    // desse cliente especificamente — numa rota com várias paradas, ela
    // continua EM_ROTA (entregador ainda indo pras próximas) mesmo depois
    // que a parada DESSE cliente já foi entregue.
    const idxProximaParadaPendente = paradas.findIndex((grupo) => grupo.status !== 'ENTREGUE' && grupo.status !== 'DEVOLVIDO');
    const souAProximaParada = idxProximaParadaPendente >= 0 && idxProximaParadaPendente === minhaParadaIdx;

    const ehColetaReversaTexto = dados.tipoFluxo === 'coleta_reversa';
    const nomeEnt = dados.entregadorNome || 'O entregador';

    // ETA real (pedido do dono 2026-09-26): distância em linha reta da
    // posição AO VIVO do entregador (GPS, ver iniciarRastreioGpsEntregador)
    // até o ponto de chegada DESSE pacote (pacoteInfo.geo, mirrorado em
    // criarLinksRastreioParaRota), convertida em minutos por uma velocidade
    // média de entrega urbana. Só faz sentido quando é a PRÓXIMA parada —
    // se ainda tem parada(s) antes da sua, o entregador não está indo na sua
    // direção agora. Sem GPS ainda, cai pro cálculo antigo (reparte a
    // duração total da rota pelas paradas) — só uma estimativa grosseira.
    const VELOCIDADE_MEDIA_ENTREGA_KMH = 22;
    let etaMin = null;
    if (statusNorm === 'EM_ROTA' && pacoteInfo.status !== 'ENTREGUE' && pacoteInfo.status !== 'DEVOLVIDO' && souAProximaParada) {
        const geoEnt = dados.entregadorGeo;
        const geoDestino = pacoteInfo.geo;
        if (geoEnt && geoDestino && Number.isFinite(Number(geoDestino.lat)) && Number.isFinite(Number(geoDestino.lon))) {
            const distKm = distanciaHaversineKm({ lat: geoEnt.lat, lon: geoEnt.lng }, geoDestino);
            if (Number.isFinite(distKm)) {
                etaMin = Math.max(1, Math.round((distKm / VELOCIDADE_MEDIA_ENTREGA_KMH) * 60));
            }
        }
    }
    if (etaMin === null && statusNorm === 'EM_ROTA' && pacoteInfo.status !== 'ENTREGUE' && pacoteInfo.status !== 'DEVOLVIDO' && minhaOrdem > 0 && Number(dados.duracaoMin) > 0) {
        etaMin = Math.max(1, Math.round((minhaOrdem / totalParadas) * Number(dados.duracaoMin)));
    }

    // Texto dinâmico (pedido do dono 2026-09-26): antes era só "está a
    // caminho" fixo pra qualquer situação — agora varia conforme o que está
    // acontecendo de verdade com ESSE pedido (ainda não coletou na loja, tem
    // outra parada antes, ou é a próxima e já dá pra estimar quanto falta).
    let statusTexto;
    if (ehColetaReversaTexto) {
        // Direção invertida: "entregue" pro pacote aqui significa "já foi
        // recolhido com o cliente" (não "chegou até ele").
        if (pacoteInfo.status === 'ENTREGUE') {
            statusTexto = 'Pedido recolhido! Está a caminho da loja.';
        } else if (statusNorm === 'EM_ROTA') {
            if (!souAProximaParada && paradas.length > 1) {
                statusTexto = `${nomeEnt} está em rota fazendo outras coletas antes da sua.`;
            } else if (souAProximaParada && etaMin) {
                statusTexto = `${nomeEnt} está indo até você nos próximos ${formatarDuracao(etaMin)} pra buscar seu pedido. Fique atento!`;
            } else {
                statusTexto = `${nomeEnt} está a caminho para buscar com você.`;
            }
        } else if (statusNorm === 'CONCLUIDO') {
            statusTexto = 'Coleta concluída — o pedido já chegou na loja.';
        } else if (statusNorm === 'CANCELADO') {
            statusTexto = 'Essa coleta foi cancelada.';
        } else {
            statusTexto = 'Procurando um entregador para buscar seu pedido...';
        }
    } else if (pacoteInfo.status === 'ENTREGUE') {
        statusTexto = 'Pedido entregue!';
    } else if (pacoteInfo.status === 'DEVOLVIDO') {
        statusTexto = 'Esse pedido foi devolvido para a loja.';
    } else if (statusNorm === 'EM_ROTA') {
        if (!dados.coletaConfirmada) {
            statusTexto = `${nomeEnt} está indo coletar seu pedido com ${dados.lojaNome || 'a loja'}.`;
        } else if (!souAProximaParada && paradas.length > 1) {
            statusTexto = `${nomeEnt} está em rota fazendo outras entregas antes da sua.`;
        } else if (souAProximaParada && etaMin) {
            statusTexto = `${nomeEnt} está indo até você nos próximos ${formatarDuracao(etaMin)}. Fique atento!`;
        } else {
            statusTexto = `${nomeEnt} está a caminho com o seu pedido.`;
        }
    } else if (statusNorm === 'BUSCANDO') {
        statusTexto = 'Procurando um entregador para a sua entrega...';
    } else if (statusNorm === 'CANCELADO') {
        statusTexto = 'Essa entrega foi cancelada.';
    } else {
        statusTexto = '';
    }

    const paradaInfoHtml = (totalParadas > 1 && minhaOrdem > 0)
        ? `<p class="rastreio-pub-parada-info">Sua parada é a <strong>${minhaOrdem}ª de ${totalParadas}</strong></p>`
        : '';

    let etaHtml = '';
    if (etaMin) {
        const etaTxt = formatarDuracao(etaMin);
        etaHtml = ehColetaReversaTexto
            ? `<p class="rastreio-pub-eta"><i data-lucide="clock" size="14"></i> Previsão de coleta em <strong>${escaparHtmlMarketplace(etaTxt)}</strong></p>`
            : `<p class="rastreio-pub-eta"><i data-lucide="clock" size="14"></i> Seu pedido chega em <strong>${escaparHtmlMarketplace(etaTxt)}</strong></p>`;
    }

    const geo = dados.entregadorGeo;
    const mapaHtml = (geo && geo.lat && geo.lng)
        ? `<div class="rastreio-pub-mapa"><iframe src="https://www.google.com/maps?q=${geo.lat},${geo.lng}&z=15&output=embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div>`
        : '';

    // Cartão de "sucesso" (pedido do dono 2026-09-27): assim que ESSE pedido
    // já passou pro lado do cliente — entrega normal confirmada, ou na coleta
    // reversa o cliente já entregou o pacote ao entregador (retiradaConfirmada,
    // mesmo que o entregador ainda esteja a caminho da loja pra fechar a
    // devolução) — a timeline/status de "a caminho" deixam de fazer sentido
    // pra ele. Troca tudo por um cartão único. O texto de "+1 ponto" foi
    // removido (pedido do dono 2026-10-02): como não grava/soma nada de
    // verdade ainda, só confundia o cliente.
    const pedidoConcluidoParaCliente = ehColetaReversaTexto
        ? pacoteInfo.retiradaConfirmada === true
        : pacoteInfo.status === 'ENTREGUE';
    const sucessoHtml = pedidoConcluidoParaCliente
        ? `<div class="rastreio-pub-sucesso">
                <div class="rastreio-pub-sucesso-check"><i data-lucide="check-circle-2"></i></div>
                <h3>${ehColetaReversaTexto ? 'Pedido recebido com sucesso!' : 'Pedido entregue com sucesso!'}</h3>
            </div>`
        : '';

    const distTxt = dados.distanciaKm ? formatarDistancia(Number(dados.distanciaKm)) : '';
    const durTxt = dados.duracaoMin ? formatarDuracao(Number(dados.duracaoMin)) : '';

    // Código de confirmação, sempre visível na própria tela (bug corrigido
    // 2026-09-26: antes só ia na mensagem de WhatsApp — se o cliente
    // perdesse essa mensagem, não tinha como saber o código de outro jeito).
    // Coleta reversa mostra o código de RETIRADA (é o cliente quem confirma
    // essa perna) só até ele entregar o pacote ao entregador — a 2ª perna
    // (devolução na loja) é confirmada pelo LOJISTA, não pelo cliente, então
    // nenhum código aparece mais aqui depois da retirada.
    let codigoHtml = '';
    if (ehColetaReversaTexto) {
        if (pacoteInfo.codigoConfirmacaoRetirada && !pacoteInfo.retiradaConfirmada) {
            codigoHtml = `<div class="rastreio-pub-codigo"><span>Seu código de confirmação</span><strong>${escaparHtmlMarketplace(pacoteInfo.codigoConfirmacaoRetirada)}</strong><small>Informe esse código ao entregador na hora da retirada</small></div>`;
        }
    } else if (pacoteInfo.codigoConfirmacaoEntrega && pacoteInfo.status !== 'ENTREGUE' && pacoteInfo.status !== 'DEVOLVIDO') {
        codigoHtml = `<div class="rastreio-pub-codigo"><span>Seu código de confirmação</span><strong>${escaparHtmlMarketplace(pacoteInfo.codigoConfirmacaoEntrega)}</strong><small>Informe esse código ao entregador na hora da entrega</small></div>`;
    }

    // Taxa de subida (pedido do dono 2026-09-25): só aparece depois que o
    // entregador confirma "Cheguei" (entregadorChegou, espelhado aqui em
    // rastreioPublico) e enquanto o pacote ainda não foi entregue/devolvido.
    // A escrita de subirSolicitado é pública (sem exigir conta de cliente) —
    // ver regra em backend/database.rules.json.
    let subirHtml = '';
    if (rotaId && pacoteInfo.entregadorChegou && pacoteInfo.status !== 'ENTREGUE' && pacoteInfo.status !== 'DEVOLVIDO') {
        const subirStatus = pacoteInfo.subirStatus || null;
        if (subirStatus === 'aceito') {
            subirHtml = `<div class="rastreio-pub-subir rastreio-pub-subir-ok"><i data-lucide="check-circle-2" size="16"></i> O entregador confirmou: vai subir até você.</div>`;
        } else if (subirStatus === 'recusado') {
            subirHtml = `<div class="rastreio-pub-subir rastreio-pub-subir-neg">O entregador avisou que não vai poder subir dessa vez.</div>`;
        } else if (subirStatus === 'pendente') {
            subirHtml = `<div class="rastreio-pub-subir rastreio-pub-subir-aguardando"><i data-lucide="clock" size="16"></i> Aguardando o entregador confirmar a subida...</div>`;
        } else {
            subirHtml = `
                <div class="rastreio-pub-subir">
                    <p>O entregador chegou! Precisa que ele suba até você?</p>
                    <button type="button" class="btn-main" onclick="solicitarSubidaCliente('${escaparHtmlMarketplace(rotaId)}', '${escaparHtmlMarketplace(pacoteId)}', this)">Solicitar subida (R$ 6,00)</button>
                </div>`;
        }
    }

    conteudo.innerHTML = pedidoConcluidoParaCliente
        ? `
        <div class="rastreio-pub-card">
            <span class="rastreio-pub-loja">${escaparHtmlMarketplace(dados.lojaNome || 'Loja')}</span>
            <h2 class="rastreio-pub-titulo">Olá, ${escaparHtmlMarketplace(destinatario)}!</h2>
            ${sucessoHtml}
        </div>
    `
        : `
        <div class="rastreio-pub-card">
            <span class="rastreio-pub-loja">${escaparHtmlMarketplace(dados.lojaNome || 'Loja')}</span>
            <h2 class="rastreio-pub-titulo">Olá, ${escaparHtmlMarketplace(destinatario)}!</h2>
            <p class="rastreio-pub-status">${escaparHtmlMarketplace(statusTexto)}</p>
            ${etaHtml}
            ${codigoHtml}
            ${timelineHtml}
            ${paradaInfoHtml}
            ${(distTxt || durTxt) ? `<div class="rastreio-pub-meta">${escaparHtmlMarketplace([distTxt, durTxt].filter(Boolean).join(' • '))}</div>` : ''}
            ${subirHtml}
        </div>
        ${mapaHtml}
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function solicitarSubidaCliente(rotaId, pacoteId, btn) {
    if (!rotaId || !pacoteId) return;
    if (btn) { btn.disabled = true; btn.innerText = 'Enviando...'; }
    db.ref(`rastreioPublico/${rotaId}/pacotes/${pacoteId}`).update({
        subirStatus: 'pendente',
        subirSolicitadoEm: Date.now()
    }).catch(() => {
        alert('Não foi possível enviar o pedido agora. Tente de novo.');
        if (btn) { btn.disabled = false; btn.innerText = 'Solicitar subida (R$ 6,00)'; }
    });
}

// Agrupa pacotes com o mesmo destinoChave (mesmo endereço) num único "ponto
// de parada" — pedido do dono 2026-09-21: 2 pacotes pro mesmo endereço não
// são 2 bolinhas, são 1. Mantém a ordem da primeira ocorrência de cada grupo.
function agruparParadasPorEndereco(paradasBrutas) {
    const grupos = [];
    const porChave = new Map();

    paradasBrutas.forEach((p) => {
        const chave = p.destinoChave || p.pacoteId;
        if (!porChave.has(chave)) {
            const grupo = { destinoChave: chave, pacoteIds: [], destinatario: p.destinatario, statusPorPacote: [], retiradaPorPacote: [] };
            porChave.set(chave, grupo);
            grupos.push(grupo);
        }
        const grupo = porChave.get(chave);
        grupo.pacoteIds.push(p.pacoteId);
        grupo.statusPorPacote.push(p.status || 'BUSCANDO');
        // Retirada (coleta reversa) é um marco à parte de "status" — ver
        // montarTimelineParadasRastreio, a bolinha do cliente fica verde
        // assim que ele entrega o pacote ao entregador, bem antes do pacote
        // "chegar" na loja (status só vira ENTREGUE lá no fim).
        grupo.retiradaPorPacote.push(p.retiradaConfirmada === true);
    });

    return grupos.map((g) => {
        const todosEntregues = g.statusPorPacote.every((s) => s === 'ENTREGUE');
        const todosDevolvidos = g.statusPorPacote.every((s) => s === 'DEVOLVIDO');
        return {
            ...g,
            status: todosEntregues ? 'ENTREGUE' : (todosDevolvidos ? 'DEVOLVIDO' : 'BUSCANDO'),
            retiradaConfirmada: g.retiradaPorPacote.every(Boolean)
        };
    });
}

// Timeline vertical "por parada de verdade" (2026-09-20/21, substituiu a
// versão horizontal de 4 bolinhas genéricas BUSCANDO/EM_ROTA/CONCLUIDO): a
// quantidade de pontos agora é a rota real — ponto A (retirada na loja) + um
// ponto por PARADA (pacotes pro mesmo endereço agrupados — ver
// agruparParadasPorEndereco), na ordem de entrega. Rola verticalmente feito
// timeline de rede social, então funciona igual com 1 parada ou 100.
//
// Privacidade (pedido do dono 2026-09-21): o nome e a numeração da parada só
// aparecem no ponto da PRÓPRIA pessoa vendo a tela — as demais mostram só a
// bolinha, sem identificar quem são os outros clientes da rota.
function montarTimelineParadasRastreio(dados, paradas, pacoteId, statusNorm) {
    const idxAtual = paradas.findIndex((grupo) => grupo.status !== 'ENTREGUE' && grupo.status !== 'DEVOLVIDO');
    const ehColetaReversa = dados.tipoFluxo === 'coleta_reversa';

    let pontos;
    if (ehColetaReversa) {
        // Coleta reversa: a ordem física é invertida (busca no(s) cliente(s),
        // entrega na loja) — então a loja vira o ÚLTIMO ponto em vez do
        // primeiro. "Retirada" de cada parada já usa o mesmo status ENTREGUE
        // que a confirmação de entrega grava (ver confirmarEnvioFinal: em
        // coleta reversa origem/destino do pacote já vêm trocados, então
        // esse status sempre significou "chegou no destino final do pacote"
        // — aqui o destino final de cada parada é justamente ter sido
        // recolhida do cliente).
        pontos = [
            ...paradas.map((grupo, idx) => {
                const ehMinha = grupo.pacoteIds.some((id) => String(id) === String(pacoteId));
                return {
                    origem: false,
                    label: ehMinha ? (grupo.destinatario || 'Cliente') : '',
                    sub: ehMinha ? 'Retirada com você' : '',
                    // BUG CORRIGIDO 2026-09-26: antes só acendia quando o pacote
                    // inteiro virava ENTREGUE (ou seja, só depois de já ter
                    // chegado na loja também) — a retirada com o cliente é um
                    // marco à parte (confirmarRetiradaPacoteAtual), acontece
                    // bem antes disso.
                    done: grupo.retiradaConfirmada === true,
                    devolvido: grupo.status === 'DEVOLVIDO',
                    atual: statusNorm === 'EM_ROTA' && idx === idxAtual,
                    voce: ehMinha
                };
            }),
            {
                origem: true,
                label: dados.lojaNome || 'Loja',
                sub: 'Entrega na loja',
                done: statusNorm === 'CONCLUIDO',
                atual: statusNorm === 'EM_ROTA' && idxAtual === -1,
                voce: false,
                devolvido: false
            }
        ];
    } else {
        // BUG CORRIGIDO 2026-09-21: o ponto de retirada acendia assim que um
        // entregador aceitava a rota — agora só acende quando ele confirma
        // que passou na loja e pegou os pacotes de verdade (coletaConfirmada,
        // ver confirmarColetaPacotes).
        const origemConcluida = dados.coletaConfirmada === true;
        pontos = [
            {
                origem: true,
                label: dados.lojaNome || 'Loja',
                sub: 'Retirada do pedido',
                done: origemConcluida,
                atual: !origemConcluida,
                voce: false,
                devolvido: false
            },
            ...paradas.map((grupo, idx) => {
                const ehMinha = grupo.pacoteIds.some((id) => String(id) === String(pacoteId));
                return {
                    origem: false,
                    // Só mostra nome/posição da parada de quem está vendo a
                    // tela — as outras ficam só com a bolinha, sem identificar
                    // o cliente.
                    label: ehMinha ? (grupo.destinatario || 'Cliente') : '',
                    sub: ehMinha ? `${idx + 1}ª parada` : '',
                    done: grupo.status === 'ENTREGUE',
                    devolvido: grupo.status === 'DEVOLVIDO',
                    atual: origemConcluida && statusNorm === 'EM_ROTA' && idx === idxAtual,
                    voce: ehMinha
                };
            })
        ];
    }

    const itensHtml = pontos.map((pt, idx) => {
        const classes = ['parada-v-item'];
        if (pt.done) classes.push('done');
        if (pt.devolvido) classes.push('devolvido');
        // BUG CORRIGIDO 2026-09-26: na coleta reversa, a parada do cliente
        // podia ficar marcada como "done" (retirada confirmada) E "atual" ao
        // mesmo tempo (o status do pacote só vira ENTREGUE de verdade lá na
        // devolução) — a regra .atual pintava a borda de laranja por cima da
        // bolinha já verde. Uma parada concluída nunca é mais "a atual".
        if (pt.atual && !pt.done) classes.push('atual');
        if (pt.voce) classes.push('voce');
        if (!pt.label) classes.push('anonima');
        if (idx === pontos.length - 1) classes.push('ultimo');

        let marca = '';
        if (pt.done) marca = '✓';
        else if (pt.devolvido) marca = '–';
        else if (pt.origem) marca = '<i data-lucide="store" size="12"></i>';

        const conteudoHtml = pt.label
            ? `<div class="parada-v-content">
                    <span class="parada-v-label">${escaparHtmlMarketplace(pt.label)}${pt.voce ? ' <span class="parada-v-you">(Você)</span>' : ''}</span>
                    <span class="parada-v-sub">${escaparHtmlMarketplace(pt.sub)}</span>
                </div>`
            : '';

        return `
            <div class="${classes.join(' ')}">
                <div class="parada-v-marker"><span class="parada-v-dot">${marca}</span></div>
                ${conteudoHtml}
            </div>
        `;
    }).join('');

    return `<div class="paradas-v-timeline">${itensHtml}</div>`;
}

// ===== [BANNERS] =====
// Cada tipo de usuário (cliente final na tela de rastreio, lojista e
// entregador no início) tem seus próprios banners — filtrados pelo campo
// "publico" gravado em cada banner. Gerenciados pelo master em Admin >
// Banners (ver renderBannersAdmin / salvarBannerAdmin).
function carregarBannersRastreioPublico() {
    carregarBannersPorPublico('cliente', 'rastreio-pub-banners');
}

function carregarBannersPorPublico(publico, containerId) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;
    db.ref('banners').once('value').then((snap) => {
        const dados = snap.val() || {};
        const ativos = Object.values(dados)
            .filter((b) => b?.ativo && b?.imagemUrl && (b?.publico || 'cliente') === publico)
            .sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0));

        if (!ativos.length) {
            wrap.classList.add('hidden');
            return;
        }

        wrap.classList.remove('hidden');
        wrap.innerHTML = ativos.map((b) => `
            <a href="${escaparHtmlMarketplace(b.linkUrl || '#')}" target="_blank" rel="noopener" class="rastreio-pub-banner-item">
                <img src="${escaparHtmlMarketplace(b.imagemUrl)}" alt="Publicidade">
            </a>
        `).join('');
        iniciarRotacaoBanners(wrap);
    }).catch(() => wrap.classList.add('hidden'));
}

const bannerRotacaoTimers = new WeakMap();
function iniciarRotacaoBanners(wrap) {
    const itens = wrap.querySelectorAll('.rastreio-pub-banner-item');
    const timerAntigo = bannerRotacaoTimers.get(wrap);
    if (timerAntigo) clearInterval(timerAntigo);
    itens.forEach((el, i) => el.classList.toggle('is-active', i === 0));
    if (itens.length <= 1) return;
    let idx = 0;
    const timer = setInterval(() => {
        itens[idx].classList.remove('is-active');
        idx = (idx + 1) % itens.length;
        itens[idx].classList.add('is-active');
    }, 5000);
    bannerRotacaoTimers.set(wrap, timer);
}

// ===== [BANNERS - PAINEL ADMIN] =====
// CRUD simples pro master trocar os banners sem precisar mexer em código.
// Imagem vai pro Firebase Storage; só o link fica no Realtime Database.
// Cada banner pertence a um "publico" (cliente/lojista/entregador) — o
// painel filtra pela aba selecionada (ver filtrarBannersAdminPorPublico).
let filtroPublicoBannerAdmin = 'cliente';

function filtrarBannersAdminPorPublico(publico, btn) {
    filtroPublicoBannerAdmin = publico;
    document.querySelectorAll('#admin-banner-tabs .admin-chip').forEach((b) => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderBannersAdmin();
}

async function renderBannersAdmin() {
    const wrap = document.getElementById('admin-banners-lista');
    if (!wrap) return;
    wrap.innerHTML = '<p class="admin-subtle">Carregando...</p>';

    try {
        const snap = await db.ref('banners').once('value');
        const dados = snap.val() || {};
        const lista = Object.entries(dados)
            .map(([id, b]) => ({ id, ...b }))
            .filter((b) => (b.publico || 'cliente') === filtroPublicoBannerAdmin)
            .sort((a, b) => Number(a.ordem || 0) - Number(b.ordem || 0));

        if (!lista.length) {
            wrap.innerHTML = '<p class="admin-subtle">Nenhum banner cadastrado pra esse público ainda.</p>';
            return;
        }

        wrap.innerHTML = lista.map((b) => `
            <div class="admin-banner-item">
                <img src="${escaparHtmlMarketplace(b.imagemUrl || '')}" alt="Banner">
                <div class="admin-banner-info">
                    <span class="admin-banner-link">${escaparHtmlMarketplace(b.linkUrl || 'Sem link')}</span>
                    <label class="admin-banner-toggle">
                        <input type="checkbox" ${b.ativo ? 'checked' : ''} onchange="alternarAtivoBannerAdmin('${b.id}', this.checked)">
                        Ativo
                    </label>
                </div>
                <button type="button" class="admin-banner-excluir" onclick="excluirBannerAdmin('${b.id}')" title="Excluir"><i data-lucide="trash-2" size="16"></i></button>
            </div>
        `).join('');
        if (typeof lucide !== 'undefined') lucide.createIcons();
    } catch (err) {
        console.warn('Falha ao carregar banners:', err);
        wrap.innerHTML = '<p class="admin-subtle">Não foi possível carregar os banners agora.</p>';
    }
}

async function salvarBannerAdmin() {
    const fileInput = document.getElementById('banner-novo-arquivo');
    const linkInput = document.getElementById('banner-novo-link');
    const publicoInput = document.getElementById('banner-novo-publico');
    const statusEl = document.getElementById('banner-upload-status');
    const arquivo = fileInput?.files?.[0];
    const publico = publicoInput?.value || 'cliente';

    if (!arquivo) {
        alert('Escolha uma imagem para o banner.');
        return;
    }

    if (statusEl) statusEl.innerText = 'Enviando imagem...';

    try {
        const id = db.ref('banners').push().key;
        const ref = firebase.storage().ref(`banners/${id}-${arquivo.name}`);
        await ref.put(arquivo);
        const imagemUrl = await ref.getDownloadURL();

        const snapTodos = await db.ref('banners').once('value');
        const totalNessePublico = Object.values(snapTodos.val() || {}).filter((b) => (b.publico || 'cliente') === publico).length;

        await db.ref('banners/' + id).set({
            imagemUrl,
            linkUrl: (linkInput?.value || '').trim(),
            publico,
            ativo: true,
            ordem: totalNessePublico,
            criadoEm: Date.now()
        });

        if (fileInput) fileInput.value = '';
        if (linkInput) linkInput.value = '';
        if (statusEl) statusEl.innerText = 'Banner adicionado.';
        filtroPublicoBannerAdmin = publico;
        document.querySelectorAll('#admin-banner-tabs .admin-chip').forEach((b) => b.classList.toggle('active', b.dataset.publico === publico));
        renderBannersAdmin();
    } catch (err) {
        console.warn('Falha ao salvar banner:', err);
        if (statusEl) statusEl.innerText = 'Falha ao enviar o banner: ' + (err?.message || err);
    }
}

async function alternarAtivoBannerAdmin(id, ativo) {
    try {
        await db.ref('banners/' + id + '/ativo').set(Boolean(ativo));
    } catch (err) {
        alert('Não foi possível atualizar o banner.');
    }
}

async function excluirBannerAdmin(id) {
    if (!confirm('Excluir esse banner?')) return;
    try {
        const snap = await db.ref('banners/' + id).once('value');
        const imagemUrl = snap.val()?.imagemUrl;
        await db.ref('banners/' + id).remove();
        if (imagemUrl) {
            firebase.storage().refFromURL(imagemUrl).delete().catch(() => {});
        }
        renderBannersAdmin();
    } catch (err) {
        alert('Não foi possível excluir o banner.');
    }
}

// ===== [PAINEL ADMIN — CHAMADOS DE SUPORTE] (2026-09-29) =====
// Master já tem leitura irrestrita de usuarios/ (ver database.rules.json),
// então não precisa de índice espelhado igual o marketplacePublico — só
// reaproveita o mesmo cache (adminUsersCache) que adminCarregarPacotes já
// usa, extraindo o subnó chamados de cada usuário.
let adminChamadosFiltroStatus = 'todos';

function filtrarChamadosAdminPorStatus(status, btn) {
    adminChamadosFiltroStatus = status;
    document.querySelectorAll('#admin-chamados-tabs .admin-chip').forEach((b) => b.classList.toggle('active', b === btn));
    renderChamadosAdmin();
}

async function renderChamadosAdmin() {
    const wrap = document.getElementById('admin-chamados-lista');
    if (!wrap) return;
    wrap.innerHTML = '<p class="admin-subtle">Carregando...</p>';

    try {
        let dataUsers = adminUsersCache;
        if (!dataUsers) {
            const snap = await db.ref('usuarios').once('value');
            dataUsers = snap.val() || {};
            adminUsersCache = dataUsers;
        }

        const lista = [];
        Object.keys(dataUsers).forEach((uid) => {
            const chamadosNo = dataUsers[uid]?.chamados || {};
            Object.keys(chamadosNo).forEach((cid) => {
                lista.push({
                    uid,
                    nomeUsuario: (dataUsers[uid]?.nome || dataUsers[uid]?.loja || 'Usuário').toString(),
                    tipoUsuario: (dataUsers[uid]?.tipo || '').toString(),
                    ...chamadosNo[cid],
                    id: cid
                });
            });
        });
        lista.sort((a, b) => Number(b?.criadoEm || 0) - Number(a?.criadoEm || 0));

        const filtrados = adminChamadosFiltroStatus === 'todos'
            ? lista
            : lista.filter((c) => (c.status || 'aberto') === adminChamadosFiltroStatus);

        if (!filtrados.length) {
            wrap.innerHTML = '<p class="admin-subtle">Nenhum chamado por aqui.</p>';
            return;
        }

        wrap.innerHTML = filtrados.map((c) => montarChamadoAdminHtml(c)).join('');
        if (typeof lucide !== 'undefined') lucide.createIcons();
    } catch (err) {
        console.warn('Falha ao carregar chamados:', err);
        wrap.innerHTML = '<p class="admin-subtle">Não foi possível carregar os chamados agora.</p>';
    }
}

function montarChamadoAdminHtml(c) {
    const status = c.status || 'aberto';
    const statusClass = status === 'respondido' ? 'status-em_rota' : (status === 'fechado' ? 'status-concluido' : 'status-buscando');
    const dataTxt = c.criadoEm ? new Date(c.criadoEm).toLocaleString('pt-BR') : '--';
    const uidEsc = escaparHtmlMarketplace(String(c.uid));
    const idEsc = escaparHtmlMarketplace(String(c.id));
    const anexosHtml = Array.isArray(c.anexos) && c.anexos.length
        ? `<div class="admin-chamado-anexos">${c.anexos.map((a) => `<a href="${escaparHtmlMarketplace(a.url)}" target="_blank" rel="noopener noreferrer"><i data-lucide="paperclip" size="13"></i> ${escaparHtmlMarketplace(a.nome || 'anexo')}</a>`).join('')}</div>`
        : '';
    const respostaHtml = c.resposta
        ? `<div class="admin-chamado-resposta"><strong>Resposta enviada:</strong> ${escaparHtmlMarketplace(c.resposta)}</div>`
        : '';
    const areaResposta = status === 'fechado'
        ? ''
        : `<div class="admin-chamado-actions">
                <textarea id="resposta-${uidEsc}-${idEsc}" placeholder="Escrever resposta pro usuário...">${escaparHtmlMarketplace(c.resposta || '')}</textarea>
                <div class="admin-chamado-btns">
                    <button type="button" class="btn-main" style="width:auto;" onclick="responderChamadoAdmin('${uidEsc}','${idEsc}')">Responder</button>
                    <button type="button" class="admin-chip" onclick="fecharChamadoAdmin('${uidEsc}','${idEsc}')">Fechar chamado</button>
                </div>
           </div>`;

    return `
        <div class="admin-chamado-card">
            <div class="admin-chamado-head">
                <div>
                    <strong>${escaparHtmlMarketplace(c.nomeUsuario)}</strong>
                    <span class="admin-chip">${escaparHtmlMarketplace(c.tipoUsuario || '--')}</span>
                    <span class="admin-chamado-categoria">${escaparHtmlMarketplace(CHAMADO_CATEGORIA_LABEL[c.categoria] || 'Suporte')}</span>
                </div>
                <span class="status-chip ${statusClass}">${CHAMADO_STATUS_LABEL[status] || 'Aberto'}</span>
            </div>
            <p class="admin-chamado-msg">${escaparHtmlMarketplace(c.mensagem || '')}</p>
            ${anexosHtml}
            <p class="admin-chamado-data">${dataTxt}</p>
            ${respostaHtml}
            ${areaResposta}
        </div>
    `;
}

async function responderChamadoAdmin(uid, chamadoId) {
    const textarea = document.getElementById(`resposta-${uid}-${chamadoId}`);
    const texto = (textarea?.value || '').trim();
    if (!texto) {
        alert('Escreva uma resposta antes de enviar.');
        return;
    }
    try {
        const respondidoEm = Date.now();
        await db.ref(`usuarios/${uid}/chamados/${chamadoId}`).update({ resposta: texto, status: 'respondido', respondidoEm });
        if (adminUsersCache?.[uid]?.chamados?.[chamadoId]) {
            Object.assign(adminUsersCache[uid].chamados[chamadoId], { resposta: texto, status: 'respondido', respondidoEm });
        }
        renderChamadosAdmin();
    } catch (err) {
        alert('Não foi possível enviar a resposta agora.');
    }
}

async function fecharChamadoAdmin(uid, chamadoId) {
    try {
        await db.ref(`usuarios/${uid}/chamados/${chamadoId}/status`).set('fechado');
        if (adminUsersCache?.[uid]?.chamados?.[chamadoId]) adminUsersCache[uid].chamados[chamadoId].status = 'fechado';
        renderChamadosAdmin();
    } catch (err) {
        alert('Não foi possível fechar o chamado agora.');
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
// Redimensiona/comprime a foto ANTES de virar base64 (pedido do dono
// 2026-10-02, erro real: "TRIGGER_PAYLOAD_TOO_LARGE" ao salvar foto) —
// usuarios/{uid} tem uma Cloud Function de gatilho (marketplacePublicoUsuarios,
// espelha o perfil público) disparada em TODA escrita nesse caminho, e esse
// gatilho tem limite de tamanho de payload. Uma foto de câmera moderna em
// base64 cru (sem redimensionar) passa fácil de alguns MB e o Firebase
// REJEITA A ESCRITA INTEIRA (não só o campo foto) quando isso acontece.
// Limitar a 480px no lado maior + JPEG ~75% deixa o resultado na casa de
// poucas dezenas de KB, bem abaixo do limite.
function redimensionarImagemParaDataUrl(file, maxDim = 480, qualidade = 0.75) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Falha ao ler o arquivo.'));
        reader.onload = (e) => {
            const img = new Image();
            img.onerror = () => reject(new Error('Falha ao carregar a imagem.'));
            img.onload = () => {
                let { width, height } = img;
                if (width > height && width > maxDim) {
                    height = Math.round(height * (maxDim / width));
                    width = maxDim;
                } else if (height > maxDim) {
                    width = Math.round(width * (maxDim / height));
                    height = maxDim;
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', qualidade));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// Preview da imagem selecionada
function previewImagem(input) {
    if (input.files && input.files[0]) {
        redimensionarImagemParaDataUrl(input.files[0])
            .then((dataUrl) => {
                document.getElementById('edit-preview-img').src = dataUrl;
            })
            .catch((err) => {
                console.error('Erro ao processar imagem:', err);
                alert('Não foi possível processar essa imagem. Tente outra.');
            });
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

// IDs dos campos do endereço: modal mobile (compartilhado com o perfil do
// entregador) vs accordion novo do Perfil desktop (pedido do dono
// 2026-10-01) — mesma lógica de busca/salvamento, só os elementos mudam.
const ENDERECO_IDS_MODAL = { cep: 'end-cep', rua: 'end-rua', num: 'end-num', bairro: 'end-bairro', cidade: 'end-cidade', uf: 'end-uf', comp: 'end-comp' };
const ENDERECO_IDS_DESKTOP = { cep: 'pf-end-cep', rua: 'pf-end-rua', num: 'pf-end-num', bairro: 'pf-end-bairro', cidade: 'pf-end-cidade', uf: 'pf-end-uf', comp: 'pf-end-comp' };

// 3. BUSCA CEP (VERSÃO ?sNICA E COMPLETA)
async function buscarCEP(valor, opts = {}) {
    const silencioso = Boolean(opts?.silencioso);
    const ids = opts?.ids || ENDERECO_IDS_MODAL;
    const cep = valor.replace(/\D/g, '');
    if (cep.length !== 8) return null;
    if (cep === ultimoCepLojaConsultado && document.getElementById(ids.rua)?.value) return null;
    ultimoCepLojaConsultado = cep;

    // Feedback visual nos campos
    const campoRua = document.getElementById(ids.rua);
    campoRua.placeholder = "Buscando endereço...";

    try {
        const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
        const dados = await res.json();
        if (!dados.erro) {
            document.getElementById(ids.rua).value = dados.logradouro || '';
            document.getElementById(ids.bairro).value = dados.bairro || '';
            document.getElementById(ids.cidade).value = dados.localidade || '';
            document.getElementById(ids.uf).value = dados.uf || '';
            document.getElementById(ids.num).focus();
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

function agendarBuscaCepLojaDesktop(valor) {
    const cep = (valor || '').replace(/\D/g, '');
    if (cepLojaDebounceTimerDesktop) clearTimeout(cepLojaDebounceTimerDesktop);
    if (cep.length !== 8) return;
    cepLojaDebounceTimerDesktop = setTimeout(() => {
        buscarCEP(cep, { silencioso: true, ids: ENDERECO_IDS_DESKTOP });
    }, 260);
}
let cepLojaDebounceTimerDesktop = null;

document.getElementById('end-cep')?.addEventListener('input', function (e) {
    agendarBuscaCepLoja(e.target.value);
});

// 4. SALVA NO FIREBASE
async function salvarEnderecoComIds(ids, aoSalvar) {
    // Identifica o UID de forma segura
    const uid = window.usuarioLogado?.id || (firebase.auth().currentUser ? firebase.auth().currentUser.uid : null);

    if (!uid) {
        alert("Erro: Usuário não identificado.");
        return;
    }

    const endereco = {
        cep: formatarCep(document.getElementById(ids.cep).value),
        rua: (document.getElementById(ids.rua).value || '').trim(),
        num: (document.getElementById(ids.num).value || '').trim(),
        bairro: (document.getElementById(ids.bairro).value || '').trim(),
        cidade: (document.getElementById(ids.cidade).value || '').trim(),
        uf: normalizarUf(document.getElementById(ids.uf).value),
        comp: (document.getElementById(ids.comp).value || '').trim()
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

            aoSalvar();
            alert("Endereço atualizado com sucesso!");
        })
        .catch(error => {
            console.error("Erro ao salvar endereço:", error);
            alert("Erro ao salvar: " + error.message);
        });
}

function salvarEndereco() {
    return salvarEnderecoComIds(ENDERECO_IDS_MODAL, fecharModalEndereco);
}

// Colapsa um accordion do Perfil desktop depois de salvar (equivalente a
// "fechar o modal" no mobile) — pedido do dono 2026-10-02: salvar
// endereço/dados da conta mostrava o alerta de sucesso mas não fazia
// nada visualmente (accordion continuava aberto, nenhuma tela mudava).
function fecharAccordionDesktop(headerId, bodyId) {
    const header = document.getElementById(headerId);
    const body = document.getElementById(bodyId);
    if (header) header.classList.remove('accordion-aberto');
    if (body) body.classList.add('hidden');
}

// Perfil desktop (pedido do dono 2026-10-01): "Dados da conta" e
// "Endereço" viram accordion em vez de abrir modal — expande/recolhe
// local, com os MESMOS campos/lógica de salvar do modal mobile, só em
// elementos novos (ver ENDERECO_IDS_DESKTOP). No mobile essas funções
// nem são chamadas: alternarAccordionDadosConta/Endereco() abrem o modal
// de sempre fora do modo desktop.
function salvarEnderecoDesktop() {
    return salvarEnderecoComIds(ENDERECO_IDS_DESKTOP, () => fecharAccordionDesktop('acc-endereco-header', 'acc-endereco-body'));
}

function preencherCamposEnderecoDesktop() {
    const end = window.usuarioLogado?.endereco;
    if (!end) return;
    document.getElementById('pf-end-cep').value = end.cep || '';
    document.getElementById('pf-end-rua').value = end.rua || '';
    document.getElementById('pf-end-num').value = end.num || '';
    document.getElementById('pf-end-bairro').value = end.bairro || '';
    document.getElementById('pf-end-cidade').value = end.cidade || '';
    document.getElementById('pf-end-uf').value = end.uf || '';
    document.getElementById('pf-end-comp').value = end.comp || '';
    const cep = formatarCep(end.cep || '');
    const faltandoCamposBase = !end.rua || !end.bairro || !end.cidade || !end.uf;
    if (cep && faltandoCamposBase) buscarCEP(cep, { silencioso: true, ids: ENDERECO_IDS_DESKTOP });
}

function alternarAccordionEndereco() {
    if (!document.body.classList.contains('lojista-desktop-mode')) {
        abrirModalEndereco();
        return;
    }
    const header = document.getElementById('acc-endereco-header');
    const body = document.getElementById('acc-endereco-body');
    if (!header || !body) return;
    const abrindo = body.classList.contains('hidden');
    header.classList.toggle('accordion-aberto', abrindo);
    body.classList.toggle('hidden', !abrindo);
    if (abrindo) {
        preencherCamposEnderecoDesktop();
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
}

function preencherCamposDadosContaDesktop() {
    const user = window.usuarioLogado;
    if (!user) return;
    document.getElementById('pf-nome').value = user.nome || '';
    document.getElementById('pf-instagram').value = user.instagram || '';
    document.getElementById('pf-whatsapp').value = user.whatsapp || '';
    document.getElementById('pf-email').value = user.email || firebase.auth().currentUser?.email || '';
}

// Upload de foto/logotipo (card de perfil do Perfil desktop, pedido do dono
// 2026-10-02) — mesmo fluxo de preview+base64 do modal mobile
// (previewImagem/salvarPerfil), mas salva na hora assim que o arquivo é
// escolhido, já que aqui não existe um passo de "Salvar" separado pro
// cartão de perfil (só o accordion Dados da conta tem botão de salvar).
function selecionarFotoPerfilDesktop() {
    if (!document.body.classList.contains('lojista-desktop-mode')) return;
    document.getElementById('pf-foto-input')?.click();
}

function onFotoPerfilDesktopSelecionada(input) {
    if (!input.files || !input.files[0]) return;
    const uid = window.usuarioLogado ? window.usuarioLogado.id : (firebase.auth().currentUser ? firebase.auth().currentUser.uid : null);
    if (!uid) return;

    redimensionarImagemParaDataUrl(input.files[0])
        .then((fotoBase64) => {
            const preview = document.getElementById('perfil-foto-display');
            if (preview) preview.src = fotoBase64;

            return db.ref('usuarios/' + uid).update({ foto: fotoBase64 })
                .then(() => {
                    window.usuarioLogado = { ...window.usuarioLogado, foto: fotoBase64 };
                    alert('Foto atualizada com sucesso!');
                });
        })
        .catch((error) => {
            console.error('Erro ao salvar foto:', error);
            alert('Erro ao salvar foto: ' + error.message);
        });
    input.value = '';
}

function alternarAccordionDadosConta() {
    if (!document.body.classList.contains('lojista-desktop-mode')) {
        abrirModalPerfil();
        return;
    }
    const header = document.getElementById('acc-dados-conta-header');
    const body = document.getElementById('acc-dados-conta-body');
    if (!header || !body) return;
    const abrindo = body.classList.contains('hidden');
    header.classList.toggle('accordion-aberto', abrindo);
    body.classList.toggle('hidden', !abrindo);
    if (abrindo) {
        preencherCamposDadosContaDesktop();
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
}

function salvarDadosContaDesktop() {
    const uid = window.usuarioLogado ? window.usuarioLogado.id : (firebase.auth().currentUser ? firebase.auth().currentUser.uid : null);
    if (!uid) {
        alert("Erro: Usuário não identificado. Tente fazer login novamente.");
        return;
    }

    const novosDados = {
        nome: document.getElementById('pf-nome').value,
        instagram: document.getElementById('pf-instagram').value,
        whatsapp: document.getElementById('pf-whatsapp').value
    };

    db.ref('usuarios/' + uid).update(novosDados)
        .then(() => {
            window.usuarioLogado = { ...window.usuarioLogado, ...novosDados };
            preencherPerfilLojista();
            if (typeof lucide !== 'undefined') lucide.createIcons();
            fecharAccordionDesktop('acc-dados-conta-header', 'acc-dados-conta-body');
            alert("Perfil atualizado com sucesso!");
        })
        .catch(error => {
            console.error("Erro ao salvar:", error);
            alert("Erro ao salvar: " + error.message);
        });
}







/* ===== New Envio Home + Client Sheet ===== */
async function abrirSeletorCliente() {
    // Bloqueio (pedido do dono 2026-10-02): sem endereço da loja cadastrado
    // não tem de onde a coleta parte (geocodificação/cálculo de rota
    // dependem disso) — barra a criação do pedido aqui, antes de deixar o
    // lojista preencher cliente/pacote pra só travar depois, e manda ele
    // completar o cadastro em vez de só mostrar um erro.
    const enderecoLoja = window.usuarioLogado?.endereco || {};
    if (!String(enderecoLoja.rua || '').trim() || !String(enderecoLoja.cidade || '').trim()) {
        alert('Você ainda não tem um endereço cadastrado. Por favor, complete seu cadastro.');
        irParaPerfil();
        return;
    }

    // Bloqueio parcial (pedido do dono 2026-09-25): enquanto o lojista deve
    // uma taxa de espera/subida a algum entregador, "Novo Envio" fica
    // travado — o resto do app continua funcionando normal. Desbloqueia
    // quando o PRÓPRIO entregador confirma que recebeu (ver
    // confirmarRecebimentoTaxaEntregador), não o lojista.
    const bloqueio = await obterBloqueioNovoEnvioPorDividaEntregador();
    if (bloqueio) {
        alert(`Você tem uma taxa de espera/subida pendente com ${bloqueio.entregadorNome} (${precoParaMoeda(bloqueio.valor)}).\n\nPague usando a chave Pix dele (veja no início da tela) e aguarde ele confirmar o recebimento — só assim "Novo Envio" libera de novo.`);
        return;
    }

    const modal = document.getElementById('modal-seletor-cliente');
    if (!modal) return;
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('is-open'));
    renderClientesSelector(document.getElementById('buscar-cliente')?.value || '');

    // Desktop (pedido do dono 2026-10-01): lista de clientes e formulário de
    // criar pedido ficam lado a lado — o formulário já abre junto (em estado
    // vazio, "selecione um cliente") em vez de só aparecer depois de
    // escolher alguém, pra formar as 2 colunas do mockup desde o início.
    if (document.body.classList.contains('lojista-desktop-mode')) {
        const modalEnvio = document.getElementById('modal-envio-detalhes');
        if (modalEnvio) {
            modalEnvio.style.display = 'flex';
            requestAnimationFrame(() => modalEnvio.classList.add('is-open'));
        }
        document.getElementById('envio-detalhes-vazio')?.classList.remove('hidden');
        document.getElementById('envio-detalhes-conteudo')?.classList.add('hidden');
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function obterBloqueioNovoEnvioPorDividaEntregador() {
    const uid = getUsuarioIdAtual();
    if (!uid) return null;
    try {
        const snap = await db.ref(`usuarios/${uid}/dividasEntregador`).once('value');
        const dados = snap.val() || {};
        return Object.values(dados).find((d) => d?.status === 'pendente') || null;
    } catch (err) {
        console.warn('Falha ao checar dívidas com entregadores:', err);
        return null;
    }
}

// Card na home do lojista listando taxas de espera/subida pendentes de
// repasse a entregadores — mostra a chave Pix de cada um pra pagar por
// fora (mesmo modelo do saque: mostra os dados, a pessoa paga manual).
async function carregarDividasEntregadorLojistaHome() {
    const uid = getUsuarioIdAtual();
    const container = document.getElementById('dividas-entregador-lojista-home');
    if (!uid || !container) return;

    try {
        const snap = await db.ref(`usuarios/${uid}/dividasEntregador`).once('value');
        const dados = snap.val() || {};
        const pendentes = Object.values(dados).filter((d) => d?.status === 'pendente');

        if (!pendentes.length) {
            container.classList.add('hidden');
            container.innerHTML = '';
            return;
        }

        const total = pendentes.reduce((acc, d) => acc + Number(d.valor || 0), 0);
        const linhas = pendentes.map((d) => `
            <div class="dividas-entregador-item">
                <div>
                    <p class="dividas-entregador-nome">${escaparHtmlMarketplace(d.entregadorNome || 'Entregador')}</p>
                    <p class="dividas-entregador-motivo">${escaparHtmlMarketplace(d.motivo || '')}</p>
                    <p class="dividas-entregador-pix">${escaparHtmlMarketplace(String(d.pixTipo || '').toUpperCase())}: ${escaparHtmlMarketplace(d.pixChave || '--')}</p>
                </div>
                <strong>${escaparHtmlMarketplace(precoParaMoeda(Number(d.valor || 0)))}</strong>
            </div>
        `).join('');

        container.innerHTML = `
            <p class="dividas-entregador-titulo">Taxas pendentes a entregadores — ${escaparHtmlMarketplace(precoParaMoeda(total))}</p>
            <p class="dividas-entregador-aviso">"Novo Envio" fica bloqueado até o entregador confirmar o recebimento.</p>
            ${linhas}
        `;
        container.classList.remove('hidden');
    } catch (err) {
        console.warn('Falha ao carregar dívidas com entregadores:', err);
    }
}

// Espelho do card acima, do lado do entregador: lista o que ele tem a
// receber de taxas de espera/subida, e é ELE quem confirma quando o Pix cai
// (pedido do dono 2026-09-25: "o próprio entregador confirma"), não o
// lojista nem o master.
async function carregarTaxasAReceberEntregadorHome() {
    const uid = getUsuarioIdAtual();
    const container = document.getElementById('taxas-receber-entregador-home');
    if (!uid || !container) return;

    try {
        const snap = await db.ref(`usuarios/${uid}/taxasAReceber`).once('value');
        const dados = snap.val() || {};
        const pendentes = Object.entries(dados).filter(([, d]) => d?.status === 'pendente');

        if (!pendentes.length) {
            container.classList.add('hidden');
            container.innerHTML = '';
            return;
        }

        const total = pendentes.reduce((acc, [, d]) => acc + Number(d.valor || 0), 0);
        const linhas = pendentes.map(([id, d]) => `
            <div class="taxas-receber-item">
                <div>
                    <p class="taxas-receber-nome">${escaparHtmlMarketplace(d.motivo || 'Taxa de espera/subida')}</p>
                    <p class="taxas-receber-valor">${escaparHtmlMarketplace(precoParaMoeda(Number(d.valor || 0)))}</p>
                </div>
                <button type="button" class="btn-chip btn-chip-primary" onclick="confirmarRecebimentoTaxaEntregador('${escaparHtmlMarketplace(id)}')">Confirmar recebimento</button>
            </div>
        `).join('');

        container.innerHTML = `
            <p class="taxas-receber-titulo">A receber da loja — ${escaparHtmlMarketplace(precoParaMoeda(total))}</p>
            ${linhas}
        `;
        container.classList.remove('hidden');
    } catch (err) {
        console.warn('Falha ao carregar taxas a receber:', err);
    }
}

// SEGURANÇA (2026-09-27): confirmar aqui só lê a PRÓPRIA cópia
// (taxasAReceber) — bastava fabricar um registro com o id de uma dívida
// alheia pra "limpar" a dívida real de outro lojista. Migrado pra Cloud
// Function (/confirmar-taxa-espera-recebida), que confere pela cópia
// canônica do lado do lojista quem é de fato o entregador daquela dívida.
async function confirmarRecebimentoTaxaEntregador(id) {
    const uid = getUsuarioIdAtual();
    if (!uid || !id) return;

    try {
        const snap = await db.ref(`usuarios/${uid}/taxasAReceber/${id}`).once('value');
        const registro = snap.val();
        if (!registro) return;

        if (!window.confirm(`Confirmar que você recebeu ${precoParaMoeda(Number(registro.valor || 0))} da loja via Pix?`)) return;

        await chamarPaymentsProxy('/confirmar-taxa-espera-recebida', {
            tenantId: registro.lojistaUid,
            dividaId: id
        });
        carregarTaxasAReceberEntregadorHome();
    } catch (err) {
        console.warn('Falha ao confirmar recebimento da taxa:', err);
        alert('Não foi possível confirmar agora. Tente de novo.');
    }
}

function fecharSeletorCliente() {
    const modal = document.getElementById('modal-seletor-cliente');
    if (!modal) return;
    fecharSwipesClientesSelector();
    modal.classList.remove('is-open');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 220);

    // Desktop: ver fecharModalEnvioDetalhes — fecha o formulário inline
    // aqui (sem chamar fecharModalEnvioDetalhes(), que faria o inverso).
    if (document.body.classList.contains('lojista-desktop-mode')) {
        const modalEnvio = document.getElementById('modal-envio-detalhes');
        if (modalEnvio) {
            modalEnvio.classList.remove('is-open');
            setTimeout(() => {
                modalEnvio.style.display = 'none';
            }, 250);
            setModalEnvioStep(1);
        }
    }
}

function abrirNovoClientePeloSeletor() {
    // Desktop: não fecha a tela toda (fecharSeletorCliente também fecharia
    // a coluna direita do form de envio) — abrirModalNovoCliente já troca
    // só a coluna esquerda sozinho, mantendo as 2 colunas da tela de
    // Pedidos.
    if (document.body.classList.contains('lojista-desktop-mode')) {
        abrirNovoCliente();
        return;
    }
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

    const btnConvidar = document.getElementById('cliente-actions-convidar');
    if (btnConvidar) {
        btnConvidar.innerText = cliente.contaClienteUid ? 'Reenviar convite' : 'Convidar pro app';
    }

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

// ===== [CONVITE DO LOJISTA PRO CLIENTE] (2026-09-23) =====
// Complementa o autocadastro (ver cadastrarClienteRastreio): em vez de
// esperar o cliente achar sozinho o link de rastreio e criar a própria
// conta, o lojista pode "puxar" o cliente que já tem cadastrado — cria a
// conta com uma senha temporária de 6 dígitos e manda por WhatsApp. No
// primeiro login (ver loginClienteRastreio → cadastroCompleto:false) o
// próprio cliente confirma os dados e troca a senha, e só aí a conta conta
// como "ativada" de verdade.
function gerarSenhaTemporaria() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

async function convidarClienteAtualParaApp() {
    if (!clienteAcaoAtualId) return;
    const id = clienteAcaoAtualId;
    fecharModalAcoesCliente();
    await convidarClienteParaApp(id);
}

async function convidarClienteParaApp(clienteId) {
    const idx = clientes.findIndex((c) => c.id === clienteId);
    if (idx < 0) return;
    const cliente = clientes[idx];
    const whatsapp = normalizarWhatsapp(cliente.whatsapp || '');
    if (!whatsapp) {
        alert('Este cliente não tem um WhatsApp válido cadastrado.');
        return;
    }

    // Instância secundária (mesma técnica do login/cadastro do cliente) —
    // criar a conta aqui NÃO pode derrubar a sessão do lojista que está
    // logado no app principal.
    const auth2 = obterClienteAuth();
    const db2 = obterClienteDb();

    try {
        // BUG CORRIGIDO 2026-09-26: antes checava só telefoneParaEmail
        // existir — mas isso também é verdade pra um convite anterior que
        // nunca foi concluído (cadastroCompleto:false), bloqueando
        // "reenviar convite" pra sempre mesmo quando o cliente nunca chegou
        // a usar a senha temporária (perdeu a mensagem, não viu, etc.).
        // clientesGlobais agora carrega esse status (ver
        // completarCadastroClienteRastreio/cadastrarClienteRastreio) — só
        // bloqueia de verdade quando o cadastro foi CONCLUÍDO.
        const globalExistente = (await db2.ref('clientesGlobais/' + whatsapp).once('value')).val();
        const jaConcluiu = globalExistente?.cadastroCompleto === true;
        const ehReenvio = Boolean(globalExistente) && !jaConcluiu;

        if (jaConcluiu) {
            clientes[idx] = { ...clientes[idx], contaClienteUid: globalExistente.uid || 'externo' };
            await saveClientes();
            alert('Esse cliente já tem uma conta ativa no Flex (própria ou de outra loja). Não é possível reenviar convite de senha temporária.');
            return;
        }

        const senhaTemp = gerarSenhaTemporaria();
        // E-mail fictício — Firebase Auth exige um, mas o convite não depende
        // do cliente ter e-mail; ele pode informar um de verdade ao
        // completar o cadastro (ver completarCadastroClienteRastreio). No
        // reenvio, versiona o e-mail (timestamp) porque o e-mail do convite
        // anterior (nunca concluído) já está em uso — a conta antiga fica
        // órfã, inofensiva, nunca mais é referenciada por ninguém.
        const emailConvite = ehReenvio
            ? `cliente.${whatsapp}.${Date.now()}@flex.local`
            : `cliente.${whatsapp}@flex.local`;

        const cred = await auth2.createUserWithEmailAndPassword(emailConvite, senhaTemp);
        await db2.ref('usuarios/' + cred.user.uid).set({
            nome: cliente.nome || '',
            email: emailConvite,
            whatsapp,
            tipo: 'cliente',
            criadoEm: Date.now(),
            convidadoPorUid: getUsuarioIdAtual(),
            cadastroCompleto: false
        });
        await db2.ref('telefoneParaEmail/' + whatsapp).set(emailConvite);
        // .update() (não .set()) pra nunca apagar um perfil/endereço já salvo.
        await db2.ref('clientesGlobais/' + whatsapp).update({ nome: cliente.nome || '', whatsapp, uid: cred.user.uid, cadastroCompleto: false });
        await auth2.signOut();

        clientes[idx] = { ...clientes[idx], contaClienteUid: cred.user.uid, contaClienteConvidadaEm: Date.now() };
        await saveClientes();

        const link = `${window.location.origin}${window.location.pathname}#/cliente`;
        const msg = ehReenvio
            ? `Olá${cliente.nome ? ', ' + cliente.nome.split(' ')[0] : ''}! Reenviando seu acesso à Flex (o convite anterior ainda não tinha sido usado).\n\nAcesse: ${link}\nSeu login é o seu WhatsApp e a senha temporária é: *${senhaTemp}*\n\nNo primeiro acesso você confirma seus dados e cria sua própria senha.`
            : `Olá${cliente.nome ? ', ' + cliente.nome.split(' ')[0] : ''}! Agora você pode acompanhar seus pedidos pela Flex.\n\nAcesse: ${link}\nSeu login é o seu WhatsApp e a senha temporária é: *${senhaTemp}*\n\nNo primeiro acesso você confirma seus dados e cria sua própria senha.`;
        window.open(`https://wa.me/${paraWhatsappInternacional(whatsapp)}?text=${encodeURIComponent(msg)}`, '_blank');
    } catch (error) {
        alert('Erro ao convidar cliente: ' + error.message);
    }
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

// Busca clientesGlobais + clientesGlobaisPerfil (índices compartilhados
// entre lojas, ver database.rules.json) quando essa loja não tem esse
// WhatsApp cadastrado ainda. Busca sempre por valor EXATO (nunca lista
// clientes de outras lojas) — pedido do dono 2026-10-02, pra não virar um
// banco de contatos pra marketing entre lojistas. Se achar, mostra o
// cartão de contato completo (nome, telefone, endereço) pra reaproveitar;
// se não achar, convida a cadastrar.
let clienteGlobalEncontradoCache = null;
async function buscarClienteGlobalEExibir(whatsapp, container) {
    try {
        const [snapBasico, snapPerfil] = await Promise.all([
            db.ref('clientesGlobais/' + whatsapp).once('value'),
            db.ref('clientesGlobaisPerfil/' + whatsapp).once('value')
        ]);
        const dados = snapBasico.val();
        const perfil = snapPerfil.val();
        // Evita sobrescrever um resultado mais novo se a pessoa já digitou
        // outra coisa enquanto a busca estava no ar.
        const filtroAtual = (document.getElementById('buscar-cliente')?.value || '').replace(/\D/g, '');
        if (filtroAtual !== whatsapp) return;

        // BUG CORRIGIDO 2026-10-02: checava `!dados?.nome` — um registro que
        // EXISTE mas tem nome vazio (ex: convite de app ainda não concluído
        // pelo cliente, cadastroCompleto:false, nome:'') caía aqui como se
        // não existisse, mostrando "deseja cadastrar?" pra um contato que já
        // é cliente de outra loja. A existência do registro é o que importa
        // (checa `dados` em si, não um campo específico dele).
        if (!dados) {
            container.innerHTML = `
                <p class="selector-global-hint">Esse contato não está cadastrado em nenhuma loja.</p>
                <button type="button" class="selector-global-cta-cadastrar" onclick="abrirNovoClienteComTelefone('${whatsapp}')">Deseja cadastrar?</button>
            `;
            return;
        }

        // Guarda os dados encontrados numa variável, nunca num atributo HTML
        // (BUG CORRIGIDO 2026-10-02: o onclick antigo interpolava o nome
        // direto num atributo delimitado por aspas duplas, escapando só
        // aspas simples — como esse nó é gravável por qualquer autenticado,
        // um nome com `"` quebrava pra fora do atributo e injetava HTML/JS
        // arbitrário na tela de quem buscasse esse telefone depois).
        clienteGlobalEncontradoCache = {
            nome: dados.nome,
            whatsapp,
            cep: perfil?.cep || '',
            rua: perfil?.rua || '',
            num: perfil?.num || '',
            bairro: perfil?.bairro || '',
            cidade: perfil?.cidade || '',
            uf: perfil?.uf || '',
            comp: perfil?.comp || ''
        };

        const nomeEsc = escaparHtmlMarketplace(dados.nome || 'Contato sem nome salvo');
        const enderecoResumo = perfil?.rua
            ? escaparHtmlMarketplace(`${perfil.rua}, ${perfil.num || 's/n'}${perfil.bairro ? ' - ' + perfil.bairro : ''}`)
            : '';
        const iniciais = (dados.nome || 'C').split(' ').filter(Boolean).map((n) => n[0]).join('').slice(0, 2).toUpperCase();
        container.innerHTML = `
            <p class="selector-global-hint">Não é cliente dessa loja ainda, mas encontramos esse contato:</p>
            <div class="selector-global-card" onclick="usarClienteGlobalEncontrado()">
                <span class="selector-avatar-iniciais">${iniciais}</span>
                <div class="selector-global-card-info">
                    <strong>${nomeEsc}</strong>
                    <span>${escaparHtmlMarketplace(whatsapp)}</span>
                    ${enderecoResumo ? `<span>${enderecoResumo}</span>` : ''}
                </div>
                <span class="selector-global-card-cta">Usar</span>
            </div>
            <p class="selector-global-note">Confirme o endereço de entrega com o cliente ao continuar.</p>
        `;
    } catch (err) {
        container.innerHTML = '<div class="selector-empty">Nenhum cliente encontrado.</div>';
    }
}

// Leva pro formulário de Novo Cliente já com nome/whatsapp/endereço
// preenchidos (lido da cache acima, nunca de HTML) — o lojista só confere
// e salva; salvarNovoCliente mantém o perfil global atualizado.
function usarClienteGlobalEncontrado() {
    const dados = clienteGlobalEncontradoCache;
    if (!dados) return;

    const preencherCampos = () => {
        abrirNovoCliente();
        const campos = {
            'new-cli-nome': dados.nome,
            'new-cli-tel': dados.whatsapp,
            'new-cli-cep': dados.cep,
            'new-cli-rua': dados.rua,
            'new-cli-num': dados.num,
            'new-cli-bairro': dados.bairro,
            'new-cli-cidade': dados.cidade,
            'new-cli-estado': dados.uf,
            'new-cli-comp': dados.comp
        };
        Object.keys(campos).forEach((id) => {
            const el = document.getElementById(id);
            if (!el || !campos[id]) return;
            el.value = campos[id];
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };

    // BUG CORRIGIDO 2026-10-03: no desktop, fecharSeletorCliente() também
    // fecha a coluna direita (form de envio) — mesma armadilha já evitada
    // em abrirNovoClientePeloSeletor. abrirModalNovoCliente já troca só a
    // coluna esquerda sozinho, então no desktop nem precisa fechar nada.
    if (document.body.classList.contains('lojista-desktop-mode')) {
        preencherCampos();
        return;
    }
    fecharSeletorCliente();
    setTimeout(preencherCampos, 180);
}

// Pré-preenche só o telefone já digitado, a partir do aviso "não está
// cadastrado. Deseja cadastrar?".
function abrirNovoClienteComTelefone(whatsapp) {
    const preencherTelefone = () => {
        abrirNovoCliente();
        const telInput = document.getElementById('new-cli-tel');
        if (telInput) {
            telInput.value = whatsapp;
            telInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    };
    // Mesma correção de usarClienteGlobalEncontrado: no desktop não fecha o
    // seletor (fecharia também a coluna direita do form de envio).
    if (document.body.classList.contains('lojista-desktop-mode')) {
        preencherTelefone();
        return;
    }
    fecharSeletorCliente();
    setTimeout(preencherTelefone, 180);
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
        // Não achou nessa loja — antes de desistir, checa se esse WhatsApp já
        // é cliente de OUTRA loja (clientesGlobais). Só tenta se parece
        // mesmo um número (8+ dígitos), pra não gerar leitura no banco a
        // cada letra digitada numa busca por nome.
        if (filtroNumero.length >= 8) {
            container.innerHTML = '<div class="selector-empty">Buscando...</div>';
            buscarClienteGlobalEExibir(filtroNumero, container);
        } else {
            container.innerHTML = '<div class="selector-empty">Nenhum cliente encontrado.</div>';
        }
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
    // Desktop: a lista de clientes fica sempre visível ao lado do
    // formulário (pedido do dono 2026-10-01), então escolher um cliente só
    // atualiza o formulário — não fecha a lista como no mobile.
    if (document.body.classList.contains('lojista-desktop-mode')) {
        irParaPasso2(id, nome, endereco, whats);
        return;
    }
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
                cobrancaEntrega: h.cobrancaEntrega || null,
                devolucaoStatus: h.devolucaoStatus || null,
                motivoDevolucao: h.motivoDevolucao || null,
                motivoDevolucaoDetalhe: h.motivoDevolucaoDetalhe || null,
                codigoConfirmacaoDevolucao: h.codigoConfirmacaoDevolucao || null,
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
            cobrancaEntrega: p.cobrancaEntrega || null,
            devolucaoStatus: p.devolucaoStatus || null,
            motivoDevolucao: p.motivoDevolucao || null,
            motivoDevolucaoDetalhe: p.motivoDevolucaoDetalhe || null,
            codigoConfirmacaoDevolucao: p.codigoConfirmacaoDevolucao || null,
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
            cobrancaEntrega: p.cobrancaEntrega || null,
            devolucaoStatus: p.devolucaoStatus || null,
            motivoDevolucao: p.motivoDevolucao || null,
            motivoDevolucaoDetalhe: p.motivoDevolucaoDetalhe || null,
            codigoConfirmacaoDevolucao: p.codigoConfirmacaoDevolucao || null,
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
            const alvo = normalizarTexto((chip.dataset.envioFilter || '').toString()).toUpperCase().replace(/\s+/g, '_');
            chip.classList.toggle('active', alvo === filtroEnviosChipAtivo);
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

function rotuloMotivoDevolucao(motivo, detalhe) {
    const mapa = {
        cliente_nao_pagou: 'Cliente não pagou',
        cliente_ausente: 'Cliente não está em casa',
        endereco_nao_encontrado: 'Endereço não encontrado',
        cliente_recusou: 'Cliente recusou o pedido',
        outro: detalhe ? `Outro: ${detalhe}` : 'Outro motivo'
    };
    return mapa[motivo] || 'Motivo não informado';
}

// Lojista confirma que a devolução relatada pelo entregador é real (ver
// project-flexa-cobranca-entrega-dinheiro). A partir daqui é gerado o Pix do
// frete extra de volta, que o lojista precisa pagar — o código de confirmação
// só é liberado depois desse pagamento (ver liberarCodigoDevolucaoAposPagamento),
// pra não entregar o código antes da cobrança acontecer (pedido do dono, 2026-08-15).
async function confirmarDevolucaoComoLojista(envioId) {
    if (!envioId) return;
    const uid = getUsuarioIdAtual();
    if (!uid) return;
    const rotaId = trackLojaIdAtual;
    if (!rotaId) return;

    if (!window.confirm('Confirma que a devolução é real? Depois disso você vai precisar pagar o Pix do frete de volta antes de receber o código para dar ao entregador.')) {
        return;
    }

    const agora = Date.now();
    try {
        await sincronizarCamposEnvioLojista(uid, envioId, {
            devolucaoStatus: 'DEVOLUCAO_CONFIRMADA',
            devolucaoConfirmadaEm: agora
        });

        const valorFrete = buscarValorFreteEnvioLojista(envioId);
        await gerarPixDevolucaoFreteLojista(uid, rotaId, envioId, { id: envioId, valorFrete });

        await abrirModalTrackingLoja(rotaId);
    } catch (err) {
        console.warn('Falha ao confirmar devolução:', err);
        alert('Não foi possível confirmar a devolução agora. Tente novamente.');
    }
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
    const cobrancaRow = document.getElementById('envio-detalhe-cobranca-row');
    if (envio.cobrancaEntrega?.ativa) {
        const formas = (envio.cobrancaEntrega.formasAceitas || []).map((f) => f === 'dinheiro' ? 'Dinheiro' : 'Pix').join(' ou ');
        if (cobrancaRow) cobrancaRow.style.display = 'flex';
        preencherTextoDetalheEnvio('envio-detalhe-cobranca', `${precoParaMoeda(envio.cobrancaEntrega.valor || 0)} (${formas || '--'})`);
    } else if (cobrancaRow) {
        cobrancaRow.style.display = 'none';
    }

    const devolucaoAvisoEl = document.getElementById('envio-detalhe-devolucao-aviso');
    const devolucaoCodigoEl = document.getElementById('envio-detalhe-devolucao-codigo');
    if (devolucaoAvisoEl) {
        devolucaoAvisoEl.style.display = envio.devolucaoStatus === 'DEVOLUCAO_SOLICITADA' ? 'flex' : 'none';
        if (envio.devolucaoStatus === 'DEVOLUCAO_SOLICITADA') {
            preencherTextoDetalheEnvio('envio-detalhe-devolucao-motivo', rotuloMotivoDevolucao(envio.motivoDevolucao, envio.motivoDevolucaoDetalhe));
        }
    }
    if (devolucaoCodigoEl) {
        const mostrarCodigo = envio.devolucaoStatus === 'DEVOLUCAO_PIX_PAGO' && envio.codigoConfirmacaoDevolucao;
        devolucaoCodigoEl.style.display = mostrarCodigo ? 'flex' : 'none';
        if (mostrarCodigo) preencherTextoDetalheEnvio('envio-detalhe-codigo-devolucao', envio.codigoConfirmacaoDevolucao);
    }

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
    document.getElementById('envio-detalhe-vazio')?.classList.add('hidden');
    document.getElementById('envio-detalhe-conteudo')?.classList.remove('hidden');

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
    let jaResolvido = false;
    if (uid) {
        try {
            const snap = await db.ref(`usuarios/${uid}/pacotes/${envioId}`).once('value');
            const dados = snap.val() || {};
            corridaIniciada = Boolean(dados.corridaIniciadaEm);
            valorFrete = Number(dados.valorFrete || 0);
            nomeDestinatario = obterNomeDestinatarioPacote(dados, rota || {});
            // Taxa de cancelamento e reembolso só fazem sentido pra um envio
            // que ainda está em andamento (pendente/em rota) — se a entrega já
            // terminou (ENTREGUE) ou já foi cancelada antes, não há corrida
            // pra "cancelar" mais. Bug relatado pelo dono 2026-09-18: excluir
            // um envio já Concluído cobrava taxa de cancelamento do mesmo jeito.
            const statusResolvido = normalizarStatusEnvioFiltro(dados.statusRaw || dados.status || '');
            jaResolvido = statusResolvido === 'ENTREGUE' || statusResolvido === 'CANCELADO';
        } catch (_) {
            corridaIniciada = false;
            valorFrete = 0;
        }
    }
    if (jaResolvido) {
        corridaIniciada = false;
    }

    // Só reembolsa se esse envio já foi pago de fato (fez parte de uma rota com Pix
    // aprovado) — envio avulso, nunca colocado numa rota paga, não gera crédito.
    // Também não reembolsa um envio já ENTREGUE/CANCELADO: o serviço já foi
    // prestado (ou já tinha sido encerrado antes), excluir o registro histórico
    // agora não desfaz isso.
    const podeReembolsar = !jaResolvido && Boolean(rota) && rota.pagamento === 'APROVADO' && Number.isFinite(valorFrete) && valorFrete > 0;

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
    } catch (err) {
        console.warn('Falha ao excluir envio:', err);
        alert('Não foi possível excluir este envio.');
        return;
    }

    // Daqui pra baixo o envio JÁ foi excluído de verdade — notificação, reembolso,
    // taxa e status da rota são efeitos colaterais best-effort. Uma falha em
    // qualquer um deles NUNCA pode fazer a mensagem final dizer que a exclusão
    // falhou (bug relatado pelo dono 2026-08-16: o toast "não foi possível
    // excluir" aparecia mesmo com o envio já sumido da lista, porque tudo isso
    // rodava dentro do MESMO try/catch da exclusão em si — qualquer exceção aqui
    // embaixo acionava o catch genérico e mentia sobre o resultado da exclusão).
    // Cada passo agora é isolado no seu próprio catch, sem interromper os demais.
    if (entregadorId) {
        await criarNotificacao(entregadorId, {
            tipo: 'envio_removido',
            titulo: 'Pacote removido da rota',
            mensagem: `O lojista removeu o pedido de ${nomeDestinatario} da rota${rotaId ? ` #${rotaId}` : ''}.`,
            rotaId: rotaId || ''
        }).catch((err) => console.warn('Falha ao notificar entregador sobre exclusão:', err));
    }

    if (podeReembolsar) {
        await creditarSaldoUsuarioAtual(valorFrete, `Estorno do pedido #${envioId} cancelado${rotaId ? ` (rota #${rotaId})` : ''}`)
            .catch((err) => console.warn('Falha ao reembolsar envio excluído:', err));
    }
    if (corridaIniciada) {
        await cobrarTaxaCancelamentoEnvio(envioId, rotaId)
            .catch((err) => console.warn('Falha ao cobrar taxa de cancelamento:', err));
    }

    if (rotaId && entregadorId) {
        await marcarRotaCanceladaSeVazia(rotaId, entregadorId)
            .catch((err) => console.warn('Falha ao atualizar status da rota após exclusão:', err));
    }

    try {
        saveClientes();
        renderEnviosHome();
        if (envioDetalheAtualId === envioId) fecharModalDetalheEnvio();
    } catch (err) {
        console.warn('Falha ao atualizar a tela após excluir envio:', err);
    }

    notificarSucesso(corridaIniciada ? `Envio excluído. Taxa de ${precoParaMoeda(TAXA_CANCELAMENTO_ENVIO)} cobrada.` : 'Envio excluído.');
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
    // Desktop: não fecha o sheet (fecharSeletorCliente fecharia também a
    // coluna direita do form de envio) — abrirModalNovoCliente já troca só
    // a coluna esquerda sozinho (ver conceito de 2 grupos em
    // abrirNovoClientePeloSeletor).
    if (!document.body.classList.contains('lojista-desktop-mode')) {
        fecharSeletorCliente();
    }
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
        const classeNaoLida = c.naoLida ? ' nao-lida' : '';

        return `
            <button type="button" class="chat-list-item${classeNaoLida}" onclick="abrirThreadChat('${escapeHtmlChat(c.chatId)}')">
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
                    // Plano de segurança 2026-09-27 (Fase 3): lê só os campos
                    // públicos (nome/foto), nunca o nó inteiro de outro usuário —
                    // usuarios/.read passou a exigir dono ou master.
                    const [nomeSnap, fotoSnap] = await Promise.all([
                        db.ref(`usuarios/${participante.id}/nome`).once('value').catch(() => null),
                        db.ref(`usuarios/${participante.id}/foto`).once('value').catch(() => null)
                    ]);
                    cacheLojistaNome[participante.id] = {
                        nome: String(nomeSnap?.val() || 'Lojista'),
                        foto: String(fotoSnap?.val() || '')
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

            // Mesmo critério de "não lida" do sino/nav (ver
            // atualizarBadgeChatSimples) — pedido do dono 2026-10-02: "o card
            // do contato no chat também precisa sinalizar mensagem não lida".
            const naoLida = !(meta.lidoEm === undefined || meta.lidoEm === null)
                && Number(meta.ultimaMensagemEm || 0) > Number(meta.lidoEm || 0);

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
                atualizadoEm: Number(rota.atualizadoEm || rota.criadoEm || 0),
                naoLida
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
    document.getElementById('chat-thread-vazio')?.classList.add('hidden');
    document.getElementById('chat-thread-conteudo')?.classList.remove('hidden');
    const nav = document.getElementById('main-nav');
    if (nav) nav.style.display = 'none';
    document.body.classList.add('chat-thread-open');
}

function abrirPainelListaChat() {
    const listPanel = document.getElementById('chat-list-panel');
    const threadPanel = document.getElementById('chat-thread-panel');
    if (threadPanel) threadPanel.classList.add('hidden');
    if (listPanel) listPanel.classList.remove('hidden');
    document.getElementById('chat-thread-vazio')?.classList.remove('hidden');
    document.getElementById('chat-thread-conteudo')?.classList.add('hidden');
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

    // Tira o indicador do CARD desse contato na hora (otimista — o recarregamento
    // completo de carregarChatsAtivos confirma depois), igual já fazia pro
    // nav/sino.
    if (conversa.naoLida) {
        conversa.naoLida = false;
        renderListaChats();
    }

    const uidLeitor = getUsuarioIdAtual();
    if (uidLeitor) {
        db.ref(`usuarios/${uidLeitor}/chats/${chatId}/meta`).update({ lidoEm: Date.now() }).catch(() => {});
    }
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
    document.querySelector('.loja-sidebar-link[data-nav-target="view-chat"]')
        ?.classList.remove('has-unread');
}

function atualizarBadgeChatSimples(chatsObj = {}) {
    const navChat = document.getElementById('nav-chat');
    const chatViewAtiva = document.getElementById('view-chat')?.classList.contains('active');

    // Não lido de verdade: última mensagem do chat é mais nova que a última
    // vez que este usuário abriu essa conversa (meta.lidoEm, gravado em
    // abrirThreadChat/enviarMensagemChat). Antes disso o dot só checava se
    // existia ALGUM chat, então ficava aceso pra sempre depois da 1a conversa.
    // CORRIGIDO 2026-09-18: meta.lidoEm é campo novo — toda conversa criada
    // ANTES desta correção não tem esse campo (undefined), e tratar undefined
    // como 0 fazia a bolinha acender pra qualquer chat antigo com mensagem,
    // mesmo já lida há muito tempo. Chat sem meta.lidoEm (nunca rastreado por
    // este código) agora conta como lido; só concorre pra bolinha quando o
    // campo existe de verdade (gravado por abrirThreadChat, ou 0 explícito
    // gravado por enviarMensagemChat pro destinatário de uma mensagem nova).
    // Enquanto a tela de Chat já está aberta, conta como lido pros dois
    // indicadores (nav + sino) — igual já era só pro nav antes.
    const temNaoLida = !chatViewAtiva && Object.values(chatsObj || {}).some((chat) => {
        const meta = chat?.meta || {};
        if (meta.lidoEm === undefined || meta.lidoEm === null) return false;
        return Number(meta.ultimaMensagemEm || 0) > Number(meta.lidoEm || 0);
    });
    if (navChat) navChat.classList.toggle('has-unread', temNaoLida);

    // Link "Chat" da sidebar desktop do lojista — mesmo indicador do
    // nav-chat mobile, elemento separado (pedido do dono 2026-10-02: "tanto
    // no desktop e no mobile").
    document.querySelector('.loja-sidebar-link[data-nav-target="view-chat"]')
        ?.classList.toggle('has-unread', temNaoLida);

    // Sino (.gh-bell) — pedido do dono 2026-10-02: "o sino notificação do
    // entregador também precisa sinalizar mensagem não lida". Mesma fonte
    // de dado, só soma com o estado de notificações de rota em vez de
    // sobrescrever (ver atualizarSinoNaoLido).
    chatSinoTemNaoLido = temNaoLida;
    atualizarSinoNaoLido();
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

    // Mesmo redimensionamento usado na foto de perfil (ver
    // redimensionarImagemParaDataUrl) — mensagens de chat gravam em
    // usuarios/{uid}/chats/..., caminho embaixo do MESMO gatilho de Cloud
    // Function (marketplacePublicoUsuarios) que rejeitou a foto de perfil
    // crua com TRIGGER_PAYLOAD_TOO_LARGE. Um arquivo de até 2MB vira ~2.7MB
    // em base64 cru — perto demais do limite pra arriscar.
    redimensionarImagemParaDataUrl(file, 960, 0.8)
        .then((dataUrl) => {
            chatImagemSelecionadaDataUrl = dataUrl;
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
        })
        .catch((err) => {
            console.error('Erro ao processar imagem do chat:', err);
            alert('Não foi possível processar essa imagem. Tente outra.');
        });
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
    // lidoEm só na própria cópia: quem manda já "leu" a mensagem que acabou de
    // escrever. A cópia do destinatário (abaixo) NÃO leva lidoEm, pra continuar
    // parecendo não lida até ele abrir esse chat (ver atualizarBadgeChatSimples).
    await metaRef.update({ ...metaPayload, lidoEm: criadoEm });

    const destinoUid = String(conversa.participanteId || '').trim();
    if (destinoUid && destinoUid !== uid) {
        const chatRefDestino = db.ref(`usuarios/${destinoUid}/chats/${chatAtualId}`);
        await chatRefDestino.child(`mensagens/${msgId}`).set(payload);
        // lidoEm:0 explícito (não omitido) pra essa chegar SEMPRE marcada como
        // não lida, mesmo que o destinatário já tivesse essa conversa aberta
        // antes (0 < ultimaMensagemEm sempre). É isso que diferencia "mensagem
        // nova, não lida de verdade" de "conversa antiga de antes dessa
        // correção, nunca rastreada" (meta.lidoEm ausente) na checagem do
        // badge (ver atualizarBadgeChatSimples).
        await chatRefDestino.child('meta').update({ ...metaPayload, lidoEm: 0 });

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
            divida: Number(data?.divida || 0),
            banco: data?.banco || {},
            pix: data?.pix || {}
        };
        renderDividaPagamentoUI();

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
    marcarSidebarLojaAtivoFinanceiro();
}

// Desktop (pedido do dono 2026-10-01): duas coisas que só dá pra acertar
// medindo de verdade em JS (CSS puro não resolve, ver comentário em
// styles.css junto de .pagamento-coluna-direita):
// 1) o extrato (coluna direita) precisa ter EXATAMENTE a altura da
//    coluna esquerda, pra rolar por dentro em vez de esticar sem limite
//    com uma lista longa;
// 2) "Salvar dados" (irmão de .pagamento-body no HTML — não pode entrar
//    dentro da coluna, tiraria ele do botão fixo no mobile) precisa
//    ficar logo depois do card Pix, não embaixo de tudo.
// Recalculado toda vez que os dados carregam (a seção de dívida pode
// aparecer/sumir e mudar essa altura) e no resize da janela.
function posicionarFooterPagamentoDesktop() {
    if (!document.body.classList.contains('lojista-desktop-mode')) return;
    const sheet = document.querySelector('.pagamento-sheet');
    const esquerda = document.querySelector('.pagamento-coluna-esquerda');
    const direita = document.querySelector('.pagamento-coluna-direita');
    const footer = document.querySelector('#modal-pagamento .modal-footer-sticky');
    if (!sheet || !esquerda || !direita || !footer) return;

    if (direita) direita.style.height = '';
    const esquerdaHeight = esquerda.getBoundingClientRect().height;
    direita.style.height = Math.round(esquerdaHeight) + 'px';

    const sheetTop = sheet.getBoundingClientRect().top;
    const esquerdaBottom = esquerda.getBoundingClientRect().bottom;
    footer.style.top = Math.round(esquerdaBottom - sheetTop + 20) + 'px';
}
window.addEventListener('resize', () => {
    if (document.getElementById('modal-pagamento')?.classList.contains('is-open')) {
        requestAnimationFrame(posicionarFooterPagamentoDesktop);
    }
});

function fecharModalPagamento() {
    fecharModalSheetGenerico('modal-pagamento');
    resincronizarSidebarLojaComViewAtual();
}

// Financeiro (pedido do dono 2026-10-01): o botão "Financeiro" do menu
// lateral não navega pra uma view de verdade, só abre o modal Pagamento
// por cima da tela atual — sem isso, ativarMenuInferior (que só conhece
// views via data-nav-target) nunca marcava esse item como ativo.
function marcarSidebarLojaAtivoFinanceiro() {
    marcarSidebarLojaAtivoPorId('loja-sidebar-link-financeiro');
}

// Suporte (pedido do dono 2026-10-01): mesmo problema do Financeiro, mas
// abrirFaleConosco() também é chamada a partir do menu "Fale conosco" do
// Perfil (onde o item ativo certo continua sendo Perfil) — por isso a
// marcação fica no onclick do próprio link da sidebar, não dentro da
// função compartilhada.
function marcarSidebarLojaAtivoPorId(id) {
    const sidebar = document.getElementById('loja-sidebar');
    if (!sidebar) return;
    sidebar.querySelectorAll('.loja-sidebar-link').forEach((item) => item.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
}

// Ao fechar o Financeiro, volta o destaque pra tela que já estava aberta
// por baixo (Dashboard, Rotas etc), em vez de deixar nenhum item ativo.
function resincronizarSidebarLojaComViewAtual() {
    const sidebar = document.getElementById('loja-sidebar');
    const viewAtual = document.querySelector('.view.active')?.id;
    if (!sidebar || !viewAtual) return;
    sidebar.querySelectorAll('.loja-sidebar-link').forEach((item) => item.classList.remove('active'));
    sidebar.querySelector(`.loja-sidebar-link[data-nav-target="${viewAtual}"]`)?.classList.add('active');
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
    resincronizarSidebarLojaComViewAtual();
}

function htmlCentralAjuda() {
    return `
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
    `;
}

function abrirAjuda() {
    abrirModalInfoPerfil('Central de ajuda', htmlCentralAjuda());
}

// Perfil desktop (pedido do dono 2026-10-01): mesmo tratamento accordion
// de Dados da conta/Endereço, agora pra Suporte inteiro — reaproveita o
// MESMO html gerado pros modais mobile (htmlCentralAjuda/htmlFaleConosco/
// etc), só injeta num container novo em vez do modal. Como o modal mobile
// (#info-perfil-body) só é populado quando abrirAjuda()/abrirFaleConosco()
// etc são chamadas de verdade (o que só acontece fora do modo desktop),
// não existe risco de 2 elementos com o mesmo id vivos ao mesmo tempo.
function alternarAccordionGenerico(headerId, bodyId, conteudoId, gerarHtml, aoAbrir) {
    const header = document.getElementById(headerId);
    const body = document.getElementById(bodyId);
    const conteudo = document.getElementById(conteudoId);
    if (!header || !body || !conteudo) return;
    const abrindo = body.classList.contains('hidden');
    header.classList.toggle('accordion-aberto', abrindo);
    body.classList.toggle('hidden', !abrindo);
    if (abrindo) {
        conteudo.innerHTML = gerarHtml();
        if (typeof lucide !== 'undefined') lucide.createIcons();
        if (aoAbrir) aoAbrir();
    }
}

function alternarAccordionAjuda() {
    if (!document.body.classList.contains('lojista-desktop-mode')) { abrirAjuda(); return; }
    alternarAccordionGenerico('acc-ajuda-header', 'acc-ajuda-body', 'acc-ajuda-conteudo', htmlCentralAjuda);
}

// ===== [SUPORTE / CHAMADOS] (pedido do dono 2026-09-29) =====
// Suporte técnico/financeiro só cria chamado + link de WhatsApp/e-mail —
// nada de e-mail automático via backend (custaria credencial nova de
// provedor); mailto abre o app de e-mail do próprio usuário, já funciona
// sem nenhuma infra adicional.
const SUPORTE_WHATSAPP_NUMERO = '5585981632349';
const SUPORTE_EMAIL = 'suporte@flexapp.com.br';

function htmlFaleConosco() {
    return `
        <div class="info-card">
            <h4>Abrir chamado</h4>
            <p class="admin-subtle">Escolha o tipo de suporte, descreva o problema e anexe print se puder — ajuda a agilizar.</p>
            <select id="chamado-categoria" class="suporte-select">
                <option value="tecnico">Suporte técnico</option>
                <option value="financeiro">Suporte financeiro</option>
            </select>
            <textarea id="chamado-mensagem" class="suporte-textarea" rows="4" placeholder="Descreva o problema, com ID da rota/pedido se tiver..."></textarea>
            <input type="file" id="chamado-anexos" class="suporte-file" multiple accept="image/*,.pdf">
            <button type="button" class="btn-main" style="width:auto;" onclick="enviarChamadoSuporte()">Enviar chamado</button>
            <p class="suporte-status" id="chamado-status"></p>
        </div>
        <div class="info-card">
            <h4>Outros canais</h4>
            <p><strong>WhatsApp suporte:</strong> <a href="https://wa.me/${SUPORTE_WHATSAPP_NUMERO}" target="_blank" rel="noopener noreferrer">(85) 98163-2349</a></p>
            <p><strong>E-mail:</strong> <a href="mailto:${SUPORTE_EMAIL}">${SUPORTE_EMAIL}</a></p>
        </div>
        <div class="info-card">
            <h4>Meus chamados</h4>
            <div id="meus-chamados-lista"><p class="admin-subtle">Carregando...</p></div>
        </div>
    `;
}

function abrirFaleConosco() {
    abrirModalInfoPerfil('Suporte', htmlFaleConosco());
    renderMeusChamadosSuporte();
}

function alternarAccordionSuporteChamados() {
    if (!document.body.classList.contains('lojista-desktop-mode')) { abrirFaleConosco(); return; }
    alternarAccordionGenerico('acc-suporte-header', 'acc-suporte-body', 'acc-suporte-conteudo', htmlFaleConosco, renderMeusChamadosSuporte);
}

async function enviarChamadoSuporte() {
    const categoriaEl = document.getElementById('chamado-categoria');
    const mensagemEl = document.getElementById('chamado-mensagem');
    const anexosEl = document.getElementById('chamado-anexos');
    const statusEl = document.getElementById('chamado-status');

    const categoria = categoriaEl?.value || 'tecnico';
    const mensagem = (mensagemEl?.value || '').trim();
    if (!mensagem) {
        alert('Descreva o problema antes de enviar.');
        return;
    }

    if (statusEl) statusEl.innerText = 'Enviando...';
    try {
        await criarChamadoSuporte(categoria, mensagem, Array.from(anexosEl?.files || []));
        if (mensagemEl) mensagemEl.value = '';
        if (anexosEl) anexosEl.value = '';
        if (statusEl) statusEl.innerText = 'Chamado enviado! A gente responde por aqui mesmo.';
        renderMeusChamadosSuporte();
    } catch (err) {
        console.warn('Falha ao enviar chamado:', err);
        if (statusEl) statusEl.innerText = 'Não foi possível enviar agora. Tente de novo ou chame no WhatsApp.';
    }
}

async function criarChamadoSuporte(categoria, mensagem, arquivos = []) {
    const uid = getUsuarioIdAtual();
    if (!uid) throw new Error('Usuário não autenticado.');

    const id = db.ref(`usuarios/${uid}/chamados`).push().key;
    const anexos = [];
    for (const arquivo of arquivos) {
        const storageRef = firebase.storage().ref(`chamados/${uid}/${id}-${arquivo.name}`);
        await storageRef.put(arquivo);
        anexos.push({ nome: arquivo.name, url: await storageRef.getDownloadURL() });
    }

    await db.ref(`usuarios/${uid}/chamados/${id}`).set({
        id,
        categoria,
        mensagem,
        anexos,
        status: 'aberto',
        criadoEm: Date.now()
    });
    return id;
}

const CHAMADO_CATEGORIA_LABEL = {
    tecnico: 'Técnico',
    financeiro: 'Financeiro',
    lgpd_exclusao: 'LGPD · Exclusão de dados'
};
const CHAMADO_STATUS_LABEL = {
    aberto: 'Aberto',
    respondido: 'Respondido',
    fechado: 'Fechado'
};

async function renderMeusChamadosSuporte() {
    const wrap = document.getElementById('meus-chamados-lista');
    if (!wrap) return;
    try {
        const uid = getUsuarioIdAtual();
        const snap = await db.ref(`usuarios/${uid}/chamados`).once('value');
        const chamadosNo = snap.val() || {};
        const lista = Object.values(chamadosNo).sort((a, b) => Number(b?.criadoEm || 0) - Number(a?.criadoEm || 0));

        if (!lista.length) {
            wrap.innerHTML = '<p class="admin-subtle">Você ainda não abriu nenhum chamado.</p>';
            return;
        }

        wrap.innerHTML = lista.map((c) => {
            const statusClass = c.status === 'respondido' ? 'status-em_rota' : (c.status === 'fechado' ? 'status-concluido' : 'status-buscando');
            const dataTxt = c.criadoEm ? new Date(c.criadoEm).toLocaleString('pt-BR') : '--';
            const respostaHtml = c.resposta
                ? `<div class="suporte-resposta"><strong>Resposta do suporte:</strong> ${escaparHtmlMarketplace(c.resposta)}</div>`
                : '';
            return `
                <div class="suporte-chamado-card">
                    <div class="suporte-chamado-head">
                        <span class="status-chip ${statusClass}">${CHAMADO_STATUS_LABEL[c.status] || 'Aberto'}</span>
                        <small>${escaparHtmlMarketplace(CHAMADO_CATEGORIA_LABEL[c.categoria] || 'Suporte')} • ${dataTxt}</small>
                    </div>
                    <p>${escaparHtmlMarketplace(c.mensagem || '')}</p>
                    ${respostaHtml}
                </div>
            `;
        }).join('');
    } catch (err) {
        console.warn('Falha ao carregar meus chamados:', err);
        wrap.innerHTML = '<p class="admin-subtle">Não foi possível carregar seus chamados agora.</p>';
    }
}

// ===== [PRIVACIDADE / LGPD] =====
function htmlPrivacidadeLgpd() {
    return `
        <div class="info-card">
            <h4>Como usamos seus dados</h4>
            <p>Coletamos nome, contato, endereço e dados de uso do app pra operar entregas: montar rotas, calcular fretes, processar pagamentos e viabilizar o rastreio dos pedidos. Não vendemos seus dados a terceiros.</p>
            <p>Você pode, a qualquer momento: pedir uma cópia dos seus dados, pedir a exclusão da sua conta, ou corrigir informações erradas direto no seu Perfil.</p>
        </div>
        <div class="info-card">
            <h4>Baixe uma cópia dos seus dados</h4>
            <p class="admin-subtle">Gera um arquivo com as informações da sua conta pra você guardar ou levar.</p>
            <button type="button" class="btn-main" style="width:auto;" onclick="baixarMeusDadosLgpd()"><i data-lucide="download" size="16"></i> Baixar meus dados</button>
        </div>
        <div class="info-card">
            <h4>Excluir minha conta</h4>
            <p class="admin-subtle">Abre um chamado pedindo a exclusão — nossa equipe confirma e executa manualmente, garantindo que nenhuma rota/pagamento em andamento seja perdido sem querer.</p>
            <button type="button" class="btn-main" style="width:auto;" onclick="solicitarExclusaoDadosLgpd()"><i data-lucide="trash-2" size="16"></i> Solicitar exclusão dos meus dados</button>
        </div>
    `;
}

function abrirPrivacidadeLgpd() {
    abrirModalInfoPerfil('Privacidade e LGPD', htmlPrivacidadeLgpd());
}

function alternarAccordionLgpd() {
    if (!document.body.classList.contains('lojista-desktop-mode')) { abrirPrivacidadeLgpd(); return; }
    alternarAccordionGenerico('acc-lgpd-header', 'acc-lgpd-body', 'acc-lgpd-conteudo', htmlPrivacidadeLgpd);
}

function baixarMeusDadosLgpd() {
    const dados = window.usuarioLogado || {};
    const conteudo = JSON.stringify(dados, null, 2);
    const blob = new Blob([conteudo], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meus-dados-flex-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

async function solicitarExclusaoDadosLgpd() {
    const confirmado = confirm('Tem certeza? Isso abre um pedido de exclusão da sua conta — nossa equipe entra em contato pra confirmar antes de executar.');
    if (!confirmado) return;
    try {
        await criarChamadoSuporte('lgpd_exclusao', 'Solicitação de exclusão de conta e dados pessoais (LGPD).', []);
        alert('Pedido enviado. Nossa equipe vai confirmar com você antes de excluir qualquer coisa.');
    } catch (err) {
        console.warn('Falha ao solicitar exclusão:', err);
        alert('Não foi possível enviar o pedido agora. Tente de novo ou chame no WhatsApp.');
    }
}

function htmlSobre() {
    return `
        <div class="info-card">
            <h4>Nossa proposta</h4>
            <p>A Flex Log conecta lojistas e entregadores para operacao de envios urbanos com foco em agilidade, transparencia e controle em tempo real.</p>
            <p>O app permite criar envios, montar rotas, rastrear status e organizar pagamentos de forma simples no celular.</p>
        </div>
        <div class="info-card">
            <h4>Versao do app</h4>
            <p>Flex Log • MVP validacao</p>
            <p>Atualizacao: ${new Date().toLocaleDateString('pt-BR')}</p>
        </div>
    `;
}

function abrirSobre() {
    abrirModalInfoPerfil('Sobre a Flex Log', htmlSobre());
}

function alternarAccordionSobre() {
    if (!document.body.classList.contains('lojista-desktop-mode')) { abrirSobre(); return; }
    alternarAccordionGenerico('acc-sobre-header', 'acc-sobre-body', 'acc-sobre-conteudo', htmlSobre);
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

// Cache da última lista carregada, só pra abrir o detalhe (abrirDetalheTransacaoExtrato)
// sem precisar buscar de novo no banco — mesmo padrão de rotaEntSheetPacotes etc.
let extratoTransacoesCache = [];

function renderExtratoPagamento(transacoes = []) {
    const list = document.getElementById('pag-extrato-list');
    if (!list) return;
    extratoTransacoesCache = Array.isArray(transacoes) ? transacoes : [];

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
        const idEsc = escaparHtmlMarketplace(String(item?.id || ''));
        return `
            <div class="pagamento-extrato-item clicavel" onclick="abrirDetalheTransacaoExtrato('${idEsc}')">
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

const TRANSACAO_TIPO_LABEL = {
    CREDITO: 'Crédito',
    DEBITO: 'Débito',
    DEBITO_DIVIDA: 'Débito (quitação de dívida)'
};

function abrirDetalheTransacaoExtrato(id) {
    const item = extratoTransacoesCache.find((t) => String(t?.id) === String(id));
    if (!item) return;

    const tipo = String(item?.tipo || '').toUpperCase();
    const isCredito = tipo === 'CREDITO';
    const metodo = item?.metodo === 'pix' ? 'Pix' : 'Interno (carteira Flex)';
    const valorTxt = precoParaMoeda(Number(item?.valor || 0));

    const linhaOpcional = (rotulo, valor) => valor
        ? `<p><strong>${escaparHtmlMarketplace(rotulo)}:</strong> ${escaparHtmlMarketplace(String(valor))}</p>`
        : '';

    abrirModalInfoPerfil('Detalhe da transação', `
        <div class="info-card">
            <h4>${isCredito ? 'Crédito' : (TRANSACAO_TIPO_LABEL[tipo] || 'Débito')}</h4>
            <p class="extrato-detalhe-valor ${isCredito ? 'credito' : 'debito'}">${isCredito ? '+' : '-'} ${valorTxt}</p>
            <p><strong>Protocolo:</strong> ${escaparHtmlMarketplace(item?.protocolo || item?.id || '--')}</p>
            <p><strong>Método:</strong> ${metodo}</p>
            <p><strong>Data e hora:</strong> ${formatarDataExtrato(item?.criadoEm)}</p>
            ${linhaOpcional('Remetente', item?.remetente)}
            ${linhaOpcional('Destinatário', item?.destinatario)}
            ${linhaOpcional('Chave Pix', item?.pixChave)}
            ${linhaOpcional('Tipo de chave', item?.pixTipo)}
            ${linhaOpcional('ID do pagamento na Mercado Pago', item?.paymentIdMp)}
            <p><strong>Descrição:</strong> ${escaparHtmlMarketplace(item?.descricao || '--')}</p>
        </div>
        ${item?.paymentIdMp ? `
        <div class="info-card">
            <h4>Comprovante na Mercado Pago</h4>
            <p class="admin-subtle">Use o ID do pagamento acima pra localizar o comprovante oficial no painel da Mercado Pago (Atividades → busca por ID).</p>
        </div>` : ''}
    `);
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

// ===================== [SAQUE — SOLICITAÇÃO DE RETIRADA VIA PIX] =====================
// Não existe transferência automática (sem integração de payout do Mercado
// Pago ainda) — isto é só o pedido: o valor é debitado da carteira na hora
// (pra não continuar disponível pra gastar em dobro enquanto o saque está
// pendente) e o pagamento em si é feito manualmente pela Flex, na chave Pix
// já cadastrada no perfil, fora do app. O painel master (ver
// renderSaquesPendentesAdmin) é só o controle de "já paguei isso" — não move
// dinheiro nenhum sozinho. Pedido do dono, 2026-09-17.
function renderSaquesUsuario(saques = []) {
    const list = document.getElementById('pag-saque-historico');
    if (!list) return;

    if (!Array.isArray(saques) || !saques.length) {
        list.innerHTML = '<div class="pagamento-extrato-empty">Nenhum saque solicitado ainda.</div>';
        return;
    }

    const rotuloStatus = { solicitado: 'Aguardando pagamento', pago: 'Pago', cancelado: 'Cancelado' };
    list.innerHTML = saques.map((s) => {
        const status = s?.status || 'solicitado';
        return `
            <div class="pagamento-extrato-item">
                <div class="top">
                    <span class="tipo">Saque Pix • ${escaparHtmlMarketplace(rotuloStatus[status] || status)}</span>
                    <span class="valor debito">- ${precoParaMoeda(Number(s?.valor || 0))}</span>
                </div>
                <div class="desc">${escaparHtmlMarketplace(String(s?.pixTipo || '').toUpperCase())}: ${escaparHtmlMarketplace(s?.pixChave || '--')}</div>
                <div class="data">${formatarDataExtrato(s?.solicitadoEm)}</div>
            </div>
        `;
    }).join('');
}

async function carregarSaquesUsuario() {
    const uid = getUsuarioIdAtual();
    const list = document.getElementById('pag-saque-historico');
    if (!uid || !list) return;

    try {
        const snap = await db.ref(`usuarios/${uid}/saques`).limitToLast(20).once('value');
        const data = snap.val() || {};
        const arr = Object.keys(data).map((id) => ({ id, ...data[id] }));
        arr.sort((a, b) => Number(b?.solicitadoEm || 0) - Number(a?.solicitadoEm || 0));
        pagamentoPerfilCache.saquesPendentesTotal = arr
            .filter((s) => (s?.status || 'solicitado') === 'solicitado')
            .reduce((acc, s) => acc + Number(s?.valor || 0), 0);
        renderSaquesUsuario(arr);
    } catch (err) {
        console.warn('Falha ao carregar saques:', err);
        list.innerHTML = '<div class="pagamento-extrato-empty">Não foi possível carregar seus saques.</div>';
    }
}

async function solicitarSaque() {
    const uid = getUsuarioIdAtual();
    if (!uid) return;

    const pixTipo = document.getElementById('pag-pix-tipo')?.value || '';
    const pixChave = (document.getElementById('pag-pix-chave')?.value || '').trim();
    if (!pixTipo || !pixChave) {
        alert('Cadastre e salve sua chave Pix (seção "Pix" abaixo) antes de solicitar o saque.');
        return;
    }

    const input = document.getElementById('pag-saque-valor');
    const valor = parseMoedaParaNumero(input?.value || 0);
    const saldoAtual = Number(pagamentoPerfilCache?.saldo || 0);
    // CORRIGIDO 2026-09-19: o valor não sai mais da carteira aqui — só quando
    // o master de fato confirma o pagamento (marcarSaqueComoPago). Pra não
    // deixar o usuário pedir mais do que realmente tem disponível (ex: pedir
    // R$300 duas vezes tendo só R$300), o "disponível pra novo saque" desconta
    // os saques já solicitados e ainda não pagos (pendentes).
    const pendentes = Number(pagamentoPerfilCache?.saquesPendentesTotal || 0);
    const disponivelParaSaque = Math.max(0, saldoAtual - pendentes);
    if (!Number.isFinite(valor) || valor <= 0) {
        alert('Digite um valor válido para o saque.');
        return;
    }
    if (valor > disponivelParaSaque) {
        alert(pendentes > 0
            ? `Saldo insuficiente. Você já tem ${precoParaMoeda(pendentes)} em saques pendentes — disponível pra novo saque: ${precoParaMoeda(disponivelParaSaque)}.`
            : `Saldo insuficiente. Seu saldo disponível é ${precoParaMoeda(disponivelParaSaque)}.`);
        return;
    }

    const confirmado = window.confirm(
        `Confirma a solicitação de saque de ${precoParaMoeda(valor)} via Pix (${pixTipo.toUpperCase()}: ${pixChave})?\n\n` +
        'O valor continua na sua carteira até a plataforma confirmar o pagamento manualmente (pode levar alguns dias úteis).'
    );
    if (!confirmado) return;

    const btn = document.getElementById('pag-saque-btn');
    if (btn) { btn.disabled = true; btn.innerText = 'Solicitando...'; }

    try {
        const agora = Date.now();
        const ref = db.ref(`usuarios/${uid}/saques`).push();
        await ref.set({
            id: ref.key,
            valor,
            pixTipo,
            pixChave,
            status: 'solicitado',
            solicitadoEm: agora
        });

        if (input) input.value = '';
        notificarSucesso(`Saque de ${precoParaMoeda(valor)} solicitado. O valor sai da carteira quando a plataforma confirmar o pagamento.`);
        await carregarSaquesUsuario();
    } catch (err) {
        console.warn('Falha ao solicitar saque:', err);
        alert('Não foi possível solicitar o saque agora. Tente novamente.');
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = 'Solicitar saque'; }
    }
}

// ===================== [QUITAÇÃO DA DÍVIDA EM DINHEIRO] =====================
// financeiro/divida (dinheiro recebido na entrega que o entregador ainda deve
// repassar) só era abatida automaticamente ao concluir uma rota — mas o
// bloqueio de 5 dias (checado em /aceitar-rota-marketplace) impede aceitar
// QUALQUER rota nova, inclusive as que dariam frete suficiente pra abater
// sozinho. Sem uma forma manual de pagar, o entregador ficava travado sem
// saída nenhuma. Pedido do dono, 2026-09-18.
let pixQuitacaoDividaAtual = null;
let pixQuitacaoDividaPollTimer = null;

function renderDividaPagamentoUI() {
    const divida = Number(pagamentoPerfilCache?.divida || 0);
    const saldo = Number(pagamentoPerfilCache?.saldo || 0);
    const section = document.getElementById('pag-divida-section');
    const valorEl = document.getElementById('pag-divida-valor');
    if (valorEl) valorEl.innerText = precoParaMoeda(divida);
    if (section) section.style.display = divida > 0 ? 'block' : 'none';

    const saldoBtn = document.getElementById('pag-divida-saldo-btn');
    const pixWrap = document.getElementById('pag-divida-pix-wrap');
    const podePagarComSaldo = saldo >= divida;
    if (saldoBtn) {
        saldoBtn.disabled = !podePagarComSaldo;
        saldoBtn.innerText = podePagarComSaldo
            ? 'Pagar com saldo'
            : `Pagar com saldo (falta ${precoParaMoeda(divida - saldo)})`;
    }
    // Mesmo critério do pagamento de rota (irParaPagamentoRota): se o saldo já
    // cobre o total, nem mostra a opção de Pix — só faz sentido gerar Pix pela
    // diferença que o saldo não cobre. Pedido do dono, 2026-09-18.
    if (pixWrap) pixWrap.style.display = podePagarComSaldo ? 'none' : 'block';
}

// Quita a dívida direto do saldo da própria carteira — sem precisar de Pix
// nenhum, já que é o mesmo usuário: só um acerto interno entre os dois campos
// (saldo cai, dívida cai o mesmo tanto). Pedido do dono, 2026-09-18.
async function pagarDividaComSaldo() {
    const uid = getUsuarioIdAtual();
    const divida = Number(pagamentoPerfilCache?.divida || 0);
    const saldo = Number(pagamentoPerfilCache?.saldo || 0);
    if (!uid || !Number.isFinite(divida) || divida <= 0) return;

    if (saldo < divida) {
        alert(`Saldo insuficiente. Seu saldo disponível é ${precoParaMoeda(saldo)} e a dívida é ${precoParaMoeda(divida)}.`);
        return;
    }

    if (!window.confirm(`Confirma pagar ${precoParaMoeda(divida)} de dívida usando o saldo da sua carteira?`)) return;

    const btn = document.getElementById('pag-divida-saldo-btn');
    if (btn) { btn.disabled = true; btn.innerText = 'Pagando...'; }

    try {
        const resultadoSaldo = await ajustarSaldoUsuario(uid, -divida, { permitirNegativo: false });
        if (!resultadoSaldo.ok) {
            alert(resultadoSaldo.saldoInsuficiente ? 'Saldo insuficiente.' : 'Não foi possível pagar agora. Tente novamente.');
            return;
        }
        await ajustarDividaUsuario(uid, -divida);
        await registrarTransacaoFinanceira('DEBITO_DIVIDA', divida, 'Dívida quitada com saldo da carteira');
        await carregarDadosPagamento();
        notificarSucesso('Dívida quitada com o saldo! Você já pode aceitar novas rotas.');
    } catch (err) {
        console.warn('Falha ao pagar dívida com saldo:', err);
        alert('Não foi possível pagar agora. Tente novamente.');
        if (btn) { btn.disabled = false; btn.innerText = 'Pagar com saldo'; }
    }
}

async function criarPagamentoPixQuitacaoDividaTesteLocal(valor) {
    if (!Number.isFinite(valor) || valor <= 0) {
        throw new Error('Valor de dívida inválido.');
    }
    const nomeUsuario = (window.usuarioLogado?.nome || 'Entregador Flex').toString().trim() || 'Entregador Flex';
    const partes = nomeUsuario.split(/\s+/).filter(Boolean);
    const firstName = partes[0] || 'Entregador';
    const lastName = partes.slice(1).join(' ') || 'Flex';

    const resp = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + FLEXA_MP_TEST_TOKEN,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': gerarIdempotencyKeyTesteLocal()
        },
        body: JSON.stringify({
            transaction_amount: Number(valor.toFixed(2)),
            description: 'Flex - quitação de dívida em dinheiro [TESTE LOCAL]',
            payment_method_id: 'pix',
            payer: { email: obterEmailPagadorTesteLocal(), first_name: firstName, last_name: lastName },
            date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            external_reference: 'quitacao:' + getUsuarioIdAtual()
        })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const detalhe = data?.message || data?.error || data?.cause?.[0]?.description || ('HTTP ' + resp.status);
        throw new Error('Mercado Pago: ' + detalhe);
    }
    const tx = data?.point_of_interaction?.transaction_data || {};
    return {
        paymentId: data?.id ? String(data.id) : '',
        status: data?.status || 'pending',
        pixCode: tx.qr_code || '',
        qrCodeBase64: tx.qr_code_base64 || '',
        valor
    };
}

async function gerarPixQuitacaoDivida() {
    const uid = getUsuarioIdAtual();
    const valor = Number(pagamentoPerfilCache?.divida || 0);
    if (!uid || !Number.isFinite(valor) || valor <= 0) return;

    const btn = document.getElementById('pag-divida-gerar-btn');
    if (btn) { btn.disabled = true; btn.innerText = 'Gerando Pix...'; }

    try {
        let data;
        if (FLEXA_PAYMENTS_PROXY_URL) {
            data = await chamarPaymentsProxy('/create-pix-quitacao-divida', {});
        } else if (FLEXA_MP_TEST_TOKEN) {
            data = await criarPagamentoPixQuitacaoDividaTesteLocal(valor);
        } else {
            throw new Error('Pagamento não configurado: defina FLEXA_PAYMENTS_PROXY_URL (produção) ou FLEXA_MP_TEST_TOKEN (só teste local).');
        }

        const pixCode = normalizarCodigoPix(data.pixCode || '');
        if (!pixCode) throw new Error('Mercado Pago não retornou código Pix.');

        pixQuitacaoDividaAtual = {
            paymentId: data.paymentId ? String(data.paymentId) : '',
            pixCode,
            qrCodeBase64: data.qrCodeBase64 || '',
            valor: data.valor || valor
        };

        renderPixQuitacaoDividaUI();
        iniciarPollingPixQuitacaoDivida();
    } catch (err) {
        console.warn('Falha ao gerar Pix de quitação de dívida:', err);

        if (!FLEXA_PAYMENTS_PROXY_URL && mercadoPagoAmbienteAtual === 'teste') {
            const simular = confirm(
                'Não foi possível gerar o Pix de quitação (ambiente TESTE).\n\n' +
                'Detalhe: ' + (err?.message || 'erro desconhecido') + '\n\n' +
                'Deseja simular esse pagamento como aprovado para continuar testando o fluxo?'
            );
            if (simular) {
                await finalizarQuitacaoDividaTesteLocal(valor);
                return;
            }
        }

        alert(err.message || 'Não foi possível gerar o Pix agora.');
        if (btn) { btn.disabled = false; btn.innerText = 'Pagar dívida via Pix'; }
    }
}

async function finalizarQuitacaoDividaTesteLocal(valor) {
    const uid = getUsuarioIdAtual();
    if (!uid) return;
    const resultado = await ajustarDividaUsuario(uid, -valor);
    if (!resultado.ok) {
        alert('Não foi possível registrar a quitação agora. Tente novamente.');
        return;
    }
    await registrarTransacaoFinanceira('DEBITO_DIVIDA', valor, 'Dívida quitada via Pix (TESTE LOCAL)');
    pixQuitacaoDividaAtual = null;
    await carregarDadosPagamento();
    notificarSucesso('Dívida quitada! Você já pode aceitar novas rotas.');
}

function pararPollingPixQuitacaoDivida() {
    if (pixQuitacaoDividaPollTimer) {
        clearInterval(pixQuitacaoDividaPollTimer);
        pixQuitacaoDividaPollTimer = null;
    }
}

function iniciarPollingPixQuitacaoDivida() {
    pararPollingPixQuitacaoDivida();
    pixQuitacaoDividaPollTimer = setInterval(async () => {
        if (!pixQuitacaoDividaAtual?.paymentId) {
            pararPollingPixQuitacaoDivida();
            return;
        }
        try {
            const data = FLEXA_PAYMENTS_PROXY_URL
                ? await chamarPaymentsProxy('/check-pix-quitacao-divida', { paymentId: pixQuitacaoDividaAtual.paymentId })
                : await consultarPagamentoPixTesteClienteLocal(pixQuitacaoDividaAtual.paymentId);

            const statusEl = document.getElementById('pag-divida-pix-status');
            if (data?.status === 'approved') {
                pararPollingPixQuitacaoDivida();
                const valorPago = pixQuitacaoDividaAtual.valor;
                pixQuitacaoDividaAtual = null;
                if (!FLEXA_PAYMENTS_PROXY_URL) {
                    // Modo teste local: o backend não rodou, credita aqui mesmo
                    // (produção já fez isso no backend).
                    const uid = getUsuarioIdAtual();
                    if (uid) {
                        await ajustarDividaUsuario(uid, -valorPago);
                        await registrarTransacaoFinanceira('DEBITO_DIVIDA', valorPago, 'Dívida quitada via Pix');
                    }
                }
                await carregarDadosPagamento();
                notificarSucesso('Dívida quitada! Você já pode aceitar novas rotas.');
            } else if (statusEl) {
                statusEl.innerText = 'Aguardando confirmação do pagamento...';
            }
        } catch (err) {
            console.warn('Falha ao consultar status do Pix de quitação:', err);
        }
    }, 4000);
}

function renderPixQuitacaoDividaUI() {
    const area = document.getElementById('pag-divida-pix-area');
    if (!area || !pixQuitacaoDividaAtual) return;
    area.innerHTML = `
        <div class="rota-pix-card">
            ${pixQuitacaoDividaAtual.qrCodeBase64 ? `<img class="ent-sheet-pix-qr-img" src="data:image/png;base64,${pixQuitacaoDividaAtual.qrCodeBase64}" alt="QR Code Pix">` : ''}
            <textarea readonly class="ent-sheet-pix-copia" onclick="this.select()">${escaparHtmlMarketplace(pixQuitacaoDividaAtual.pixCode)}</textarea>
            <div class="ent-sheet-actions-inline">
                <button type="button" class="ent-sheet-btn-ghost" onclick="copiarCodigoPixQuitacaoDivida()">Copiar código Pix</button>
            </div>
            <div id="pag-divida-pix-status" class="ent-sheet-pix-status">Aguardando confirmação do pagamento...</div>
            <div id="pag-divida-pix-copy-feedback" class="ent-sheet-pix-copy-feedback"></div>
            ${mercadoPagoAmbienteAtual === 'teste' ? `<button type="button" class="ent-sheet-link" onclick="simularAprovacaoQuitacaoDividaTeste()">Simular pagamento aprovado (teste)</button>` : ''}
        </div>
    `;
}

function copiarCodigoPixQuitacaoDivida() {
    if (!pixQuitacaoDividaAtual?.pixCode) return;
    navigator.clipboard?.writeText(pixQuitacaoDividaAtual.pixCode).then(() => {
        const feedback = document.getElementById('pag-divida-pix-copy-feedback');
        if (feedback) feedback.innerText = 'Código copiado!';
        notificarSucesso('Código Pix copiado!');
    }).catch(() => notificarErro('Não foi possível copiar automaticamente.'));
}

async function simularAprovacaoQuitacaoDividaTeste() {
    if (!pixQuitacaoDividaAtual) return;
    if (!window.confirm('Simular esse Pix de quitação como pago? Isso só deve ser usado em ambiente de TESTE.')) return;
    const valor = pixQuitacaoDividaAtual.valor;
    pararPollingPixQuitacaoDivida();
    pixQuitacaoDividaAtual = null;
    await finalizarQuitacaoDividaTesteLocal(valor);
}

const _carregarDadosPagamentoOriginal = carregarDadosPagamento;
carregarDadosPagamento = async function carregarDadosPagamentoComExtrato() {
    await _carregarDadosPagamentoOriginal();
    await carregarExtratoPagamento();
    await carregarSaquesUsuario();
    posicionarFooterPagamentoDesktop();
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

// Chave usada em usuarios/{uid}.whatsapp e no indice telefoneParaEmail — só
// dígitos, pra bater sempre com o mesmo formato independente de como a
// pessoa digitou (com parenteses, espaço, traço etc).
function normalizarWhatsapp(valor) {
    return String(valor || '').replace(/\D/g, '');
}

function aplicarTipoCadastroNaTela() {
    const labelNome = document.getElementById('label-nome');
    const inputNome = document.getElementById('input-nome');
    const groupCnh = document.getElementById('group-cnh');
    const cnhInput = groupCnh ? groupCnh.querySelector('input') : null;
    const cardLoja = document.getElementById('tipo-cad-loja');
    const cardEntrega = document.getElementById('tipo-cad-entrega');

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

    if (cardLoja) cardLoja.classList.toggle('active', !ehEntregador);
    if (cardEntrega) cardEntrega.classList.toggle('active', ehEntregador);
}

// Substituiu irParaCadastro: antes o tipo (lojista/entregador) era escolhido
// numa tela à parte (view-inicio) antes de chegar no login/cadastro; agora
// os dois cartões ficam dentro da própria aba "Cadastre-se", então só
// precisa marcar a seleção — não navegar pra lugar nenhum.
function selecionarTipoCadastro(tipo) {
    tipoCadastroSelecionado = normalizarTipoCadastro(tipo);
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
    const whatsapp = normalizarWhatsapp(document.getElementById('input-whatsapp-cad')?.value || '');
    const senha = (document.getElementById('pass-cad')?.value || '').trim();
    const cnh = (document.getElementById('input-cnh')?.value || '').trim();

    if (!nome || !email || !senha || !whatsapp) return alert('Preencha todos os campos, incluindo o WhatsApp — ele é usado pra entrar no app.');

    const ehEntregador = tipoCadastroSelecionado === 'entrega';
    if (ehEntregador && !cnh) {
        alert('Preencha o numero da CNH para cadastro de entregador.');
        return;
    }

    try {
        // Login agora é por WhatsApp — esse número precisa ser único, senão o
        // login de uma conta passaria a resolver pra outro e-mail. Checa
        // ANTES de criar a conta no Firebase Auth pra não deixar uma conta
        // órfã (criada mas sem conseguir logar) se o número já existir.
        const telefoneJaUsado = (await db.ref('telefoneParaEmail/' + whatsapp).once('value')).val();
        if (telefoneJaUsado) {
            alert('Esse número de WhatsApp já está cadastrado. Tente entrar em vez de criar uma conta nova.');
            return;
        }

        const cred = await auth.createUserWithEmailAndPassword(email, senha);
        const payload = {
            nome,
            email,
            whatsapp,
            tipo: ehEntregador ? 'entregador' : 'loja',
            criadoEm: Date.now(),
            // Antes esse campo só existia se alguém mexesse nele manualmente
            // no console, ou na primeira transação real (ver ajustarSaldoUsuario)
            // — deixa toda conta nova já com o mesmo formato, saldo: 0.
            financeiro: { saldo: 0 }
        };
        if (ehEntregador) payload.cnh = cnh;

        await db.ref('usuarios/' + cred.user.uid).set(payload);
        await db.ref('telefoneParaEmail/' + whatsapp).set(email);

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
    const totalValorBruto = Number.isFinite(Number(rota?.totalFrete))
        ? Number(rota.totalFrete)
        : pacotes.reduce((acc, p) => acc + Number(p?.valorFrete || 0), 0);
    // Entregador só enxerga o valor líquido (ver [COMISSÃO DA PLATAFORMA]) —
    // totalValor/valorRestante abaixo já saem descontados, não o bruto.
    const totalValor = calcularValorRepasseEntregador(totalValorBruto, totalDist);

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
    // Proporção líquido/bruto aplicada aqui também — sem isso, somar
    // valorFrete cru dos pacotes restantes voltaria a mostrar o valor bruto
    // (sem o corte da plataforma) só nessa conta parcial.
    const proporcaoLiquida = totalValorBruto > 0 ? (totalValor / totalValorBruto) : 1;
    const valorRestante = pacotes.length
        ? Number((restantes.reduce((acc, p) => acc + Number(p?.valorFrete || 0), 0) * proporcaoLiquida).toFixed(2))
        : (statusNorm === 'CONCLUIDO' ? 0 : totalValor);

    const destinosPacotes = [...new Set(pacotes.map((p) => (p?.cidade || '').trim()).filter(Boolean))];
    const destinosFallback = Array.isArray(rota?.destinos) ? rota.destinos : [];
    const destinos = destinosPacotes.length ? destinosPacotes : (destinosFallback.length ? destinosFallback : (rota?.destinoPrincipal ? [rota.destinoPrincipal] : []));
    // BUG CORRIGIDO 2026-09-26: isso usava o endereço do PRÓPRIO entregador
    // (usuarioData) como "origem" da rota — sem sentido (a origem é a LOJA,
    // não a casa do entregador) e quase sempre vazio, daí o "Origem: --"
    // constante no card "Em rota" da home. rota.origemLabel/origemCidade
    // agora são gravados de verdade ao aceitar a rota (ver
    // aceitarRotaMarketplaceEntregador) — rotas aceitas ANTES dessa correção
    // continuam sem esse dado (nunca foi salvo) até serem substituídas por
    // rotas novas; não há como recuperar retroativamente sem uma migração.
    const origemLabelPronto = (rota?.origemLabel || '').trim();

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
        origem: origemLabelPronto || (rota?.origemCidade || '').trim() || '--',
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
    const rotasRecentes = resumoRotas.slice(0, 3);

    const resumoDia = calcularResumoDiaEntregador(resumoRotas, metaDia);
    const resumoAtivo = calcularResumoAtivoEntregador(rotasEmRota, metaDia);
    entregadorMetaDiaCache = { ...resumoDia, ...metaDia };

    const cardsEmRota = rotasEmRota.length
        ? rotasEmRota.map((r) => montarCardRotaEntregador(r, `${r.totalPacotes} pacote(s) em andamento`)).join('')
        : '<div class="rounded-2xl border border-dashed border-slate-300 bg-white px-3 py-4 text-center text-[12px] font-semibold text-slate-400">Nenhuma rota em andamento agora.</div>';

    const cardsRotasRecentes = rotasRecentes.length
        ? rotasRecentes.map((r) => montarCardRotaEntregador(r, `${r.totalPacotes} pacote(s) • ${r.statusVisual.label}`)).join('')
        : '<div class="rounded-2xl border border-dashed border-slate-300 bg-white px-3 py-4 text-center text-[12px] font-semibold text-slate-400">Nenhuma rota recente para exibir.</div>';

    // CORRIGIDO 2026-09-18: caía num fallback pro progresso da última rota
    // tocada (rotaAtual.progresso) mesmo quando essa rota não tinha nada a ver
    // com "hoje" (ex: uma rota concluída de outro dia) — mostrava tipo "27%"
    // no card "Meta do dia" mesmo com 0 pacotes/0 ganhos no dia, o que não fazia
    // sentido nenhum. "Meta do dia" agora é sempre resumoAtivo (rota em
    // andamento) ou resumoDia.progressoGeral (0 se não houve nenhuma entrega
    // hoje) — nunca o progresso solto de uma rota qualquer.
    const progressoPct = resumoAtivo.totalPacotes > 0
        ? Math.max(0, Math.min(100, Math.round((resumoAtivo.entregasConcluidas / resumoAtivo.totalPacotes) * 100)))
        : Math.max(0, Math.min(100, Number(resumoDia.progressoGeral) || 0));

    container.innerHTML = `
        ${headerHtml}
        <div class="pb-28">
            <div id="banner-entregador-home" class="rastreio-pub-banners hidden mb-3"></div>

            <div id="taxas-receber-entregador-home" class="taxas-receber-card hidden"></div>

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
    carregarBannersPorPublico('entregador', 'banner-entregador-home');
    carregarTaxasAReceberEntregadorHome();
}

function abrirSheetRotaEntregadorHome(rotaId) {
    abrirSheetRotaEntregador(rotaId, { refetchPacotes: true });
}

function abrirModalMetaDiaEntregador() {
    const meta = entregadorMetaDiaCache || {};
    const inicioDiaTxt = Number(meta.inicioEm) ? new Date(meta.inicioEm).toLocaleString('pt-BR') : '--';
    const alvoPacotesAtual = Math.max(1, Number(meta.alvoPacotes || 20));
    const alvoGanhosAtual = Math.max(1, Number(meta.alvoGanhos || 150));
    const html = `
        <div class="info-card">
            <h4>Sua meta de hoje</h4>
            <p class="pagamento-saque-help">Defina quantos pacotes e quanto quer ganhar hoje. O % do card inicial passa a ser baseado nessa meta.</p>
            <div class="form-group">
                <label>Pacotes que quer entregar</label>
                <div class="input-wrapper"><input type="number" id="meta-dia-alvo-pacotes" min="1" step="1" inputmode="numeric" value="${alvoPacotesAtual}"></div>
            </div>
            <div class="form-group">
                <label>Ganhos que quer alcancar (R$)</label>
                <div class="input-wrapper"><input type="number" id="meta-dia-alvo-ganhos" min="1" step="0.01" inputmode="decimal" value="${alvoGanhosAtual}"></div>
            </div>
            <button type="button" class="btn-main" style="margin-top:0;" onclick="salvarMetaDiaEntregador()">Salvar meta</button>
        </div>
        <div class="info-card">
            <h4>Progresso de hoje</h4>
            <p><strong>Inicio do expediente:</strong> ${inicioDiaTxt}</p>
            <p><strong>Ganhos concluidos:</strong> ${precoParaMoeda(Number(meta.ganhosConcluidos || 0))} / ${precoParaMoeda(alvoGanhosAtual)}</p>
            <p><strong>Pacotes entregues:</strong> ${Number(meta.totalPacotesConcluidos || 0)} / ${alvoPacotesAtual}</p>
            <p><strong>Distancia percorrida:</strong> ${formatarDistancia(Number(meta.distanciaConcluida || 0))}</p>
            <p><strong>Tempo em rota:</strong> ${formatarTempoCompacto(Number(meta.tempoConcluido || 0))}</p>
        </div>
        <button type="button" class="btn-outline" style="margin-top: 8px; width:100%;" onclick="zerarMetaDiaEntregador()">Zerar meta do dia</button>
    `;
    abrirModalInfoPerfil('Meta do dia', html);
}

async function salvarMetaDiaEntregador() {
    const uid = getUsuarioIdAtual();
    if (!uid || !usuarioEhEntregador()) return;

    const alvoPacotes = Math.max(1, Math.round(Number(document.getElementById('meta-dia-alvo-pacotes')?.value || 0)));
    const alvoGanhos = Math.max(1, Number(document.getElementById('meta-dia-alvo-ganhos')?.value || 0));

    if (!Number.isFinite(alvoPacotes) || alvoPacotes <= 0 || !Number.isFinite(alvoGanhos) || alvoGanhos <= 0) {
        notificarErro('Informe valores válidos para a meta.');
        return;
    }

    await db.ref(`usuarios/${uid}/entregadorMetaDia`).update({
        alvoPacotes,
        alvoGanhos,
        atualizadoEm: Date.now()
    });

    entregadorMetaDiaCache = { ...(entregadorMetaDiaCache || {}), alvoPacotes, alvoGanhos };
    notificarSucesso('Meta do dia atualizada!');
    fecharModalInfoPerfil();
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
// Guarda os pacotes da rota aberta no modal de tracking, pra clicar numa
// bolinha da timeline e mostrar de quem é aquele pacote sem precisar buscar
// no banco de novo (ver mostrarInfoParadaTrackingLoja).
let trackLojaPacotesAtual = [];

function mostrarInfoParadaTrackingLoja(rangeStart, rangeEnd) {
    const el = document.getElementById('track-loja-parada-info');
    if (!el) return;

    const pacotesDoRange = trackLojaPacotesAtual.slice(rangeStart, rangeEnd);
    if (!pacotesDoRange.length) {
        el.classList.add('hidden');
        return;
    }

    el.innerHTML = pacotesDoRange.map((p) => {
        const statusNorm = normalizarStatusEnvioFiltro(p?.status || p?.statusRaw || 'PACOTE_NOVO');
        const statusLabel = rotuloStatusEnvio(statusNorm);
        // Só mostra o botão de avisar quando dá pra montar um link de
        // rastreio de verdade — pacotes antigos (modelo pré-rastreio-público)
        // podem não ter tokenRastreio/whatsapp ainda.
        const podeAvisar = p?.whatsapp && p?.tokenRastreio;
        const btnAvisar = podeAvisar
            ? `<button type="button" class="tracking-parada-avisar-btn" onclick="avisarClienteStatusWhatsapp('${escaparHtmlMarketplace(p.whatsapp)}', '${escaparHtmlMarketplace(p.destinatario || 'Cliente').replace(/'/g, "\\'")}', '${escaparHtmlMarketplace(statusLabel).replace(/'/g, "\\'")}', '${p.tokenRastreio}')">Avisar cliente</button>`
            : '';
        return `
            <div class="tracking-parada-info-item">
                <strong>${escaparHtmlMarketplace(p?.destinatario || 'Cliente')}</strong>
                <span class="tracking-parada-info-status">${escaparHtmlMarketplace(statusLabel)}</span>
                <small>${escaparHtmlMarketplace(p?.destinoEndereco || p?.destinoCompleto || '--')}</small>
                ${btnAvisar}
            </div>
        `;
    }).join('');
    el.classList.remove('hidden');
}

// Abre o WhatsApp já com uma mensagem pronta avisando o cliente do status
// atual do pedido + o link de rastreio dele — não é envio automático de
// verdade (isso exigiria a API oficial do WhatsApp Business, paga e sujeita
// a aprovação), é reduzir "escrever a mensagem do zero" pra "1 clique".
async function avisarClienteStatusWhatsapp(whatsapp, nome, statusLabel, token) {
    // BUG CORRIGIDO 2026-10-03 (achado pelo dono): essa era a 3ª função
    // diferente montando link de rastreio, e a única que nunca gerou o
    // token de login automático (ver compartilharLinkRastreioWhatsapp) —
    // quem recebia o link por aqui (botão "Avisar cliente" do tracking da
    // Home) nunca caía no auto-login nem na tela de completar cadastro.
    const aba = window.open('', '_blank');
    let loginTokenParam = '';
    try {
        const resp = await chamarPaymentsProxy('/gerar-login-cliente', { whatsapp, nome });
        if (resp?.loginToken) loginTokenParam = `?lt=${encodeURIComponent(resp.loginToken)}`;
    } catch (err) {
        console.warn('Falha ao gerar login automático do cliente:', err);
    }
    const link = `${window.location.origin}${window.location.pathname}#/rastreio/${token}${loginTokenParam}`;
    const msg = `Olá${nome ? ', ' + nome.split(' ')[0] : ''}! Seu pedido está: ${statusLabel}.\n\nAcompanhe em tempo real: ${link}`;
    const urlWhatsapp = `https://wa.me/${paraWhatsappInternacional(whatsapp)}?text=${encodeURIComponent(msg)}`;
    if (aba) aba.location.href = urlWhatsapp;
    else window.open(urlWhatsapp, '_blank');
}

async function abrirModalTrackingLoja(rotaId) {
    if (!rotaId) return;
    try {
        trackLojaIdAtual = rotaId;

        // `clientes`/`pacotesRaizCache` são carregados uma vez no login, sem listener
        // ao vivo — mudanças feitas pelo entregador depois (coleta, cobrança, devolução)
        // não aparecem até um refresh completo. Recarrega tudo fresco toda vez que essa
        // tela abre, pra sempre refletir o estado real. Ver project-flexa-cobranca-entrega-dinheiro.
        const uidLojistaAtual = getUsuarioIdAtual();
        if (uidLojistaAtual) {
            try {
                const [clientesFrescos, pacotesSnap, rotaFrescaSnap] = await Promise.all([
                    loadClientes(),
                    db.ref(`usuarios/${uidLojistaAtual}/pacotes`).once('value'),
                    db.ref(`usuarios/${uidLojistaAtual}/rotas/${rotaId}`).once('value')
                ]);
                clientes = clientesFrescos;
                window.pacotesRaizCache = window.pacotesRaizCache || {};
                window.pacotesRaizCache[uidLojistaAtual] = pacotesSnap.val() || {};
                if (rotaFrescaSnap.exists()) {
                    const rotaFresca = { id: rotaId, ...(rotaFrescaSnap.val() || {}) };
                    const idx = rotasHomeCache.findIndex((r) => String(r.id) === String(rotaId));
                    if (idx >= 0) rotasHomeCache[idx] = rotaFresca;
                    else rotasHomeCache.push(rotaFresca);
                }
            } catch (err) {
                console.warn('Falha ao recarregar dados frescos da rota:', err);
            }
        }

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

    // Timeline padronizada (pedido do dono 2026-09-27): mesma estrutura/CSS
    // do card "Em Rota" da home (ver montarTimelineRealRota) — cada dot
    // continua clicável, abrindo a info daquele pacote específico (antes
    // agrupava vários pacotes por dot quando passava de 5; agora é 1 dot por
    // pacote real, igual a home, capado em 6 + "+N").
    trackLojaPacotesAtual = pacotes;
    const paradaInfoEl = document.getElementById('track-loja-parada-info');
    if (paradaInfoEl) paradaInfoEl.classList.add('hidden');
    const timelineEl = document.getElementById('track-loja-timeline');
    if (timelineEl) {
        const { html: dotsHtml, progressoPct } = montarTimelineRealRota(
            pacotes, totalPac, 'home-route-dot',
            (idx) => `mostrarInfoParadaTrackingLoja(${idx}, ${idx + 1})`
        );
        timelineEl.innerHTML = `
            <div class="tracking-route-track-fill" style="width:${progressoPct}%;"></div>
            <div class="tracking-route-track-line"></div>
            <div class="tracking-route-dots">${dotsHtml}</div>
            <span class="tracking-route-bike" style="left: clamp(0px, calc(${progressoPct}% - 18px), calc(100% - 36px));"><img src="img/timeline-icon.png" alt=""></span>
        `;
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
            // Plano de segurança 2026-09-27 (Fase 3): lê só os campos públicos
            // (nome/tipo/foto/logo/whatsapp), nunca o nó inteiro de outro
            // usuário — usuarios/.read passou a exigir dono ou master.
            const [nomeSnap, tipoSnap, fotoSnap, logoSnap, whatsappSnap] = await Promise.all([
                db.ref(`usuarios/${entregadorId}/nome`).once('value').catch(() => null),
                db.ref(`usuarios/${entregadorId}/tipo`).once('value').catch(() => null),
                db.ref(`usuarios/${entregadorId}/foto`).once('value').catch(() => null),
                db.ref(`usuarios/${entregadorId}/logo`).once('value').catch(() => null),
                db.ref(`usuarios/${entregadorId}/whatsapp`).once('value').catch(() => null)
            ]);
            const driverBanco = {
                nome: nomeSnap?.val(),
                tipo: tipoSnap?.val(),
                foto: fotoSnap?.val(),
                logo: logoSnap?.val(),
                whatsapp: whatsappSnap?.val()
            };
            const driver = { ...driverBanco, ...entregadorInfoDireto };
            if (nomeEl) nomeEl.innerText = driver.nome || driver.displayName || 'Entregador';
            if (rolEl) rolEl.innerText = driver.tipo === 'entregador' ? 'Entregador' : (driver.tipo || 'Entregador');
            if (fotoEl) {
                const foto = driver.foto || driver.photoURL || driver.avatar || driver.logo;
                aplicarFotoComPlaceholder(fotoEl, foto || '');
            }

            const telefone = driver.whatsapp || driver.telefone || driver.celular || rota?.telefoneEntregador || driver?.contato || '';
            if (btnCall) {
                if (telefone) {
                    // BUG CORRIGIDO 2026-09-23: era ligação de telefone
                    // (tel:) — troca pra abrir o WhatsApp de verdade com o
                    // entregador, igual o botão equivalente na tela de
                    // rastreio público.
                    btnCall.onclick = () => { window.open(`https://wa.me/${paraWhatsappInternacional(telefone)}`, '_blank'); };
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

        // Devolução por falha de entrega (ver project-flexa-cobranca-entrega-dinheiro):
        // é aqui que o lojista cai ao tocar na notificação "rota_aceita"/devolução,
        // então o card de confirmar precisa estar visível nesta tela, não só no
        // detalhe individual do envio.
        const devolucoesEl = document.getElementById('track-loja-devolucoes');
        if (devolucoesEl) {
            const pacotesDevolucao = pacotes.filter((p) => p?.devolucaoStatus === 'DEVOLUCAO_SOLICITADA' || p?.devolucaoStatus === 'DEVOLUCAO_CONFIRMADA' || p?.devolucaoStatus === 'DEVOLUCAO_PIX_PAGO');
            devolucoesEl.innerHTML = pacotesDevolucao.map((p) => {
                if (p.devolucaoStatus === 'DEVOLUCAO_SOLICITADA') {
                    return `
                    <div class=\"tracking-stale-banner\" style=\"background:#fef2f2; border-color:#fecaca;\">
                        <p style=\"color:#991b1b;\">O entregador não conseguiu entregar o pedido de ${escaparHtmlMarketplace(p.destinatario || 'cliente')}: ${escaparHtmlMarketplace(rotuloMotivoDevolucao(p.motivoDevolucao, p.motivoDevolucaoDetalhe))}</p>
                        <button type=\"button\" class=\"tracking-btn main full\" onclick=\"confirmarDevolucaoComoLojista('${String(p.id).replace(/'/g, "\\'")}')\">Confirmar devolução</button>
                    </div>`;
                }
                if (p.devolucaoStatus === 'DEVOLUCAO_CONFIRMADA') {
                    // Devolução confirmada, mas o código só existe depois do Pix do
                    // frete de volta pago — ver gerarPixDevolucaoFreteLojista.
                    const pixAtivo = pixDevolucaoLojistaAtual && String(pixDevolucaoLojistaAtual.envioId) === String(p.id);
                    if (pixAtivo) {
                        const podePagarComSaldo = Number(pixDevolucaoLojistaAtual.saldoDisponivel || 0) >= Number(pixDevolucaoLojistaAtual.valor || 0);
                        return `
                        <div class=\"tracking-stale-banner\" style=\"background:#fffaf5; border-color:#fdba74;\">
                            <p style=\"color:#0f172a;\"><strong>Pague o frete de devolução (${escaparHtmlMarketplace(precoParaMoeda(pixDevolucaoLojistaAtual.valor || 0))}) para liberar o código de confirmação.</strong></p>
                            <div class=\"rota-pix-card\">
                                <span class=\"rota-pix-label\">Saldo disponível</span>
                                <p class=\"rota-flow-help\" style=\"margin:4px 0 10px;\">Saldo disponível: <strong>${escaparHtmlMarketplace(precoParaMoeda(pixDevolucaoLojistaAtual.saldoDisponivel || 0))}</strong></p>
                                <button id=\"track-loja-devolucao-saldo-btn\" type=\"button\" class=\"btn-main\" style=\"margin-top:0;\" ${podePagarComSaldo ? '' : 'disabled'} onclick=\"pagarDevolucaoComSaldo()\">Pagar com saldo</button>
                            </div>
                            <p class=\"rota-flow-help\">Ou use o Pix Copia e Cola para pagar e liberar o código.</p>
                            <div class=\"rota-pix-card\">
                                <span class=\"rota-pix-label\">Pix Copia e Cola</span>
                                ${pixDevolucaoLojistaAtual.qrCodeBase64 ? `<img class=\"ent-sheet-pix-qr-img\" src=\"data:image/png;base64,${pixDevolucaoLojistaAtual.qrCodeBase64}\" alt=\"QR Code Pix\">` : ''}
                                <textarea readonly class=\"ent-sheet-pix-copia\" onclick=\"this.select()\">${escaparHtmlMarketplace(pixDevolucaoLojistaAtual.pixCode)}</textarea>
                                <div class=\"ent-sheet-actions-inline\">
                                    <button type=\"button\" class=\"ent-sheet-btn-ghost\" onclick=\"copiarCodigoPixDevolucaoLojista()\">Copiar código Pix</button>
                                </div>
                                <div class=\"ent-sheet-pix-status\">Aguardando confirmação do pagamento...</div>
                                <div id=\"track-loja-pix-devolucao-copy-feedback\" class=\"ent-sheet-pix-copy-feedback\"></div>
                                ${mercadoPagoAmbienteAtual === 'teste' ? `<button type=\"button\" class=\"ent-sheet-link\" onclick=\"simularAprovacaoDevolucaoTeste()\">Simular pagamento aprovado (teste)</button>` : ''}
                            </div>
                        </div>`;
                    }
                    return `
                    <div class=\"tracking-stale-banner\" style=\"background:#fffaf5; border-color:#fdba74;\">
                        <p style=\"color:#0f172a;\">Gerando o Pix do frete de devolução...</p>
                    </div>`;
                }
                return `
                <div class=\"tracking-stale-banner\" style=\"background:#fffaf5; border-color:#fdba74;\">
                    <p style=\"color:#0f172a;\">Informe este código ao entregador quando ele voltar à loja com o pedido de ${escaparHtmlMarketplace(p.destinatario || 'cliente')}:</p>
                    <strong style=\"display:block; text-align:center; font-size:20px; letter-spacing:2px; color:var(--brand-orange);\">${escaparHtmlMarketplace(p.codigoConfirmacaoDevolucao || '----')}</strong>
                </div>`;
            }).join('');
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
    pararPollingPixDevolucaoLojista();
    pixDevolucaoLojistaAtual = null;
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
    // BUG CORRIGIDO 2026-10-02: só devolvia a ROTA pra BUSCANDO — os pacotes
    // dela ficavam presos em EM_ROTA no modelo novo (usuarios/{uid}/pacotes),
    // mesma causa raiz do status do pedido não acompanhar o da rota.
    const pacoteIdsRota = Array.isArray(rota?.pacoteIds) ? rota.pacoteIds : (Array.isArray(rota?.pacotes) ? rota.pacotes : []);
    pacoteIdsRota.forEach((pid) => {
        updates[`usuarios/${uid}/pacotes/${pid}/status`] = 'BUSCANDO';
        updates[`usuarios/${uid}/pacotes/${pid}/statusRaw`] = 'BUSCANDO';
        updates[`usuarios/${uid}/pacotes/${pid}/rotaId`] = null;
        updates[`usuarios/${uid}/pacotes/${pid}/atualizadoEm`] = agora;
    });

    try {
        await db.ref().update(updates);
        if (window.pacotesRaizCache?.[uid]) {
            pacoteIdsRota.forEach((pid) => {
                if (window.pacotesRaizCache[uid][pid]) {
                    window.pacotesRaizCache[uid][pid] = { ...window.pacotesRaizCache[uid][pid], status: 'BUSCANDO', statusRaw: 'BUSCANDO', rotaId: null, atualizadoEm: agora };
                }
            });
        }
        if (entregadorId) {
            await db.ref(`usuarios/${entregadorId}/rotas/${rotaId}`).remove();
            criarNotificacao(entregadorId, {
                tipo: 'rota_liberada',
                titulo: 'Rota removida de você',
                mensagem: `O lojista liberou a rota #${rotaId} para outro entregador por inatividade.`,
                rotaId: String(rotaId)
            });
        }
        notificarSucesso('Rota liberada para novo entregador.');
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
  abrirDetalheTransacaoExtrato,
  abrirEdicaoDestinoEnvio,
  abrirEditarCliente,
  abrirFaleConosco,
  abrirHistoricoDoClienteAtual,
  abrirModalAcoesCliente,
  abrirMapaColetaLoja,
  abrirModalClienteAuth,
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
  abrirNovoClienteComTelefone,
  abrirNovoClientePeloSeletor,
  abrirPagamento,
  abrirPainelListaChat,
  abrirPainelNotificacoes,
  abrirPainelThreadChat,
  abrirPrivacidadeLgpd,
  abrirSeletorCliente,
  abrirSeletorImagemChat,
  abrirSheetBuscaRota,
  abrirSheetRotaEntregador,
  abrirSheetRotaEntregadorHome,
  abrirSobre,
  abrirThreadChat,
  acaoPrincipalModalRota,
  aceitarRotaMarketplaceEntregador,
  aceitarSolicitacaoSubida,
  adminAlterarStatusPacotes,
  adminCarregarPacotes,
  adminCreateField,
  adminCreateTable,
  adminDeleteField,
  adminExcluirPacote,
  adminExcluirRota,
  adminListTables,
  adminSalvarPacotes,
  adminSalvarRotas,
  agendarBuscaCepCliente,
  agendarBuscaCepLoja,
  agendarBuscaCepLojaDesktop,
  ajustarSaldoUsuario,
  alternarAbaRotasEntregador,
  alternarAccordionAjuda,
  alternarAccordionDadosConta,
  alternarAccordionEndereco,
  alternarAccordionLgpd,
  alternarAccordionSobre,
  alternarAccordionSuporteChamados,
  alternarAtivoBannerAdmin,
  alternarAuth,
  alternarClienteAuthTab,
  alternarFormaCobrancaEntrega,
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
  atualizarRestantePixCobranca,
  atualizarPrecosCardsVeiculo,
  atualizarResumoModalDetalheRota,
  atualizarResumoRota,
  atualizarResumoSelecaoRota,
  atualizarSaldoPagamentoUI,
  atualizarStatusRotaMaster,
  atualizarUiClienteAuth,
  atualizarWalletChipEntregadorUI,
  avisarClienteStatusWhatsapp,
  baixarMeusDadosLgpd,
  buscarCEP,
  buscarDadosDoBanco,
  buscarEndereco,
  cadastrarClienteRastreio,
  cadastrarReal,
  calcularFreteBaseServico,
  calcularFreteEstimado,
  calcularPesoTotalRota,
  calcularResumoAtivoEntregador,
  calcularResumoDiaEntregador,
  caminhoFinanceiroUsuario,
  cancelarCorridaPacoteAtual,
  cancelarEdicaoDestinoEnvio,
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
  compartilharLinkRastreioWhatsapp,
  completarCadastroClienteRastreio,
  confirmarCheguei,
  confirmarCodigoDevolucaoPacoteAtual,
  confirmarColetaPacotes,
  confirmarDevolucaoComoLojista,
  confirmarEntregaPacoteAtual,
  confirmarEnvioFinal,
  confirmarExclusaoEnvio,
  confirmarExclusaoRota,
  confirmarPagamentoMistoCobranca,
  confirmarPagamentoRota,
  confirmarRecebimentoDinheiro,
  confirmarRecebimentoTaxaEntregador,
  confirmarRetiradaPacoteAtual,
  consultarPagamentoPixMercadoPago,
  consultarPagamentoPixTesteClienteLocal,
  convidarClienteAtualParaApp,
  copiarCodigoPixCobrancaEntrega,
  copiarCodigoPixDevolucaoLojista,
  copiarCodigoPixQuitacaoDivida,
  copiarCodigoPixRota,
  copiarLinkRastreioPacote,
  creditarSaldoUsuarioAtual,
  criarNotificacao,
  criarPagamentoPixMercadoPago,
  criarPagamentoPixTesteClienteLocal,
  debitarSaldoUsuarioAtual,
  definirCobrancaEntregaAtiva,
  desfazerExclusaoCliente,
  desistirRotaEntregador,
  detalheRotaParaTexto,
  encerrarListenerMensagensChat,
  entSheetNext,
  entSheetPrev,
  enviarChamadoSuporte,
  enviarMensagemChat,
  enviarResetSenhaMaster,
  envioPassaNoFiltro,
  estimarRotaEntrega,
  estimarRotaGoogle,
  estimarRotaRoutesApi,
  estimativaPlausivel,
  excluirBannerAdmin,
  excluirClienteAtualComConfirmacao,
  excluirClienteComDesfazer,
  excluirEnvioAtualNoModal,
  excluirEnvioPorId,
  excluirRotaAtualComConfirmacao,
  excluirRotaPorId,
  exportarRelatorioCsvAdmin,
  extrairCidadeEnderecoSimples,
  fecharChamadoAdmin,
  fecharModalAcoesCliente,
  fecharModalClienteAuth,
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
  fecharTodosOverlaysLojaDesktop,
  filtrarAdminBuscaAtiva,
  filtrarAdminPacotes,
  filtrarAdminUsuarios,
  filtrarAdminUsuariosPorTipo,
  filtrarBannersAdminPorPublico,
  filtrarChamadosAdminPorStatus,
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
  gerarPixCobrancaEntrega,
  gerarPixQuitacaoDivida,
  getChavePacoteRota,
  getClienteById,
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
  iniciarFluxoDevolucao,
  iniciarListenerGeoTrackingLoja,
  iniciarListenerHomeEntregador,
  iniciarListenerMarketplaceEntregador,
  iniciarListenerMensagensChat,
  iniciarListenerNotificacoes,
  iniciarModalRota,
  iniciarRastreioGpsEntregador,
  iniciarRetiradaPacoteAtual,
  iniciarSwipeEntSheet,
  iniciarSwipePaginaRota,
  initAdminCharts,
  initClienteSearch,
  initClientes,
  initDropdownBuscaEntregador,
  irParaBuscarEntregador,
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
  loginClienteRastreio,
  loginReal,
  logoutReal,
  mapearCategoriaEnvio,
  marcarEnviosEmRota,
  marcarNotificacaoLida,
  marcarRotaCanceladaSeVazia,
  marcarSaqueComoPago,
  marcarSidebarLojaAtivoPorId,
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
  montarWaypointRota,
  mostrarInfoParadaTrackingLoja,
  mostrarTelaAdminDashboard,
  mostrarTelaAdminLogin,
  moverStopEntregadorOrdem,
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
  onFotoPerfilDesktopSelecionada,
  openModal,
  pacoteAbertoParaChat,
  pacoteConcluidoOuCanceladoNoSheet,
  pagarComPix,
  pagarDevolucaoComSaldo,
  pagarDividaComSaldo,
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
  recuperarSenhaReal,
  recusarSolicitacaoSubida,
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
  renderSerieEntregasAdmin,
  renderSerieGanhosAdmin,
  renderSheetRotaEntregadorConteudo,
  renderTelaBuscarEntregador,
  renderizarDashboard,
  renderizarDashboardEntregador,
  resetClienteForm,
  responderChamadoAdmin,
  resumirCidadesRota,
  resumirRotaParaEntregador,
  rotaMarketplacePassaNoFiltro,
  rotaPassaNoFiltro,
  rotaSheetBloqueada,
  rotaTemEntregadorAtivoParaChat,
  rotuloStatusEnvio,
  sairClienteRastreio,
  salvarBannerAdmin,
  salvarDadosContaDesktop,
  salvarDadosPagamento,
  salvarEdicaoDestinoEnvio,
  salvarEndereco,
  salvarEnderecoDesktop,
  salvarMetaDiaEntregador,
  salvarNovoCliente,
  salvarPerfil,
  salvarRotaNoBanco,
  saveClientes,
  selecionarClienteNoSheet,
  selecionarEmbalagem,
  selecionarFiltroEnvios,
  selecionarFiltroRotas,
  selecionarFotoPerfilDesktop,
  selecionarImagemChat,
  selecionarServico,
  selecionarTamanho,
  selecionarTipoCadastro,
  selecionarTipoFluxoEnvio,
  selecionarVeiculo,
  setEstadoPacoteRota,
  setModalEnvioStep,
  setStatusPacotes,
  setStatusPagamentoPixRota,
  setTicketPagamentoPixRota,
  setUltimoErroRota,
  simularAprovacaoCobrancaEntregaTeste,
  simularAprovacaoDevolucaoTeste,
  simularAprovacaoQuitacaoDividaTeste,
  sincronizarDropdownBuscaEntregador,
  solicitarDevolucaoPacoteAtual,
  solicitarExclusaoDadosLgpd,
  solicitarSaque,
  solicitarSubidaCliente,
  switchAdminTab,
  telaInicialPorTipoUsuario,
  telaPerfilPorTipoUsuario,
  toggleAdminNotifPanel,
  toggleAdminSidebarCompact,
  toggleAdminSidebarMobile,
  toggleAdminTheme,
  toggleDetalhesCorrida,
  toggleLojaSidebarCompact,
  togglePacoteRota,
  togglePass,
  usarClienteGlobalEncontrado,
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
