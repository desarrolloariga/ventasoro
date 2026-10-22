// =====================================================================
//  Joyería ARIGA - Lógica de la aplicación (equivalente a Index.html +
//  Código.gs de Apps Script, usando Supabase como base de datos).
// =====================================================================
const CFG = window.ARIGA_CONFIG;
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    db: { schema: CFG.SCHEMA },
});

let dropdownData = { tipos: [], productos: [] };
let createClientModal, referenciaModal, asignarClienteModal, passwordModal;
let fullHistoryData = [], fullCarteraDetalleData = [], fullInventoryData = [];
let fullClientesData = [], datosFilas = [], cargasFilas = [];
let fullSaldosData = [], estadoCuentaFilas = [], recibidosFilas = [];
let referencias = [], movimientosFilas = [], perfiles = [];
let perfil = null;          // perfil del usuario con sesión (rol, activo)
let usuarioActual;          // id del usuario mostrado (evita recargas repetidas)
let datosIniciados = false;

const esAdmin = () => perfil?.rol === 'admin';
const esSupervisor = () => perfil?.rol === 'supervisor';
// Ve información de otros vendedores: el admin (todos) y el supervisor (su equipo)
const veEquipo = () => esAdmin() || esSupervisor();
// Consecutivo interno de los clientes del vendedor (id -> 1, 2, 3...)
let consecutivos = {};
const cod = id => (id === null || id === undefined || id === '') ? '' : (veEquipo() ? id : (consecutivos[id] ?? id));
const coincideCodigo = (id, q) => !!q && (String(id) === q || String(cod(id)) === q);
async function cargarConsecutivos() {
    if (veEquipo()) return;
    const filas = await fetchAll(() => sb.from('clientes').select('id,consecutivo'));
    consecutivos = Object.fromEntries(filas.filter(c => c.consecutivo != null).map(c => [c.id, c.consecutivo]));
}
const recordarConsecutivo = c => { if (c?.consecutivo != null) consecutivos[c.id] = c.consecutivo; };
// Ordena por el código de cliente que ve el usuario, de menor a mayor (sin código al final).
// Es estable: dentro del mismo cliente se conserva el orden previo (p. ej. fecha).
const sinCodigo = v => v === null || v === undefined || v === '';
const ordenarPorCodigo = (filas, campo) => filas.sort((a, b) =>
    (sinCodigo(a[campo]) - sinCodigo(b[campo])) || (Number(cod(a[campo])) - Number(cod(b[campo]))) || 0);
// Se entra con un usuario ("maria"); Supabase Auth lo guarda como maria@ariga.local
const DOMINIO_USUARIOS = 'ariga.local';
const aEmail = u => { u = u.trim().toLowerCase(); return u.includes('@') ? u : `${u}@${DOMINIO_USUARIOS}`; };
const aUsuario = email => String(email ?? '').endsWith('@' + DOMINIO_USUARIOS) ? email.split('@')[0] : email;

// ---------------------------------------------------------------- utilidades
const $ = id => document.getElementById(id);
const showSpinner = () => $('spinner').classList.remove('d-none');
const hideSpinner = () => $('spinner').classList.add('d-none');

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const fmt = v => num(v).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQ = v => 'Q ' + fmt(v);
const fmtFecha = f => { if (!f) return ''; const [y, m, d] = String(f).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const hoyISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: CFG.ZONA_HORARIA }).format(new Date());
const inicioMesISO = () => hoyISO().slice(0, 8) + '01';
const norm = v => String(v ?? '').trim().toLowerCase();
const unico = r => Array.isArray(r) ? r[0] : r;   // RPC que devuelve un registro

const showAlert = (m, t = 'info') => {
    $('alert-container').innerHTML =
        `<div class="alert alert-${t} alert-dismissible fade show">${esc(m)}<button class="btn-close" data-bs-dismiss="alert"></button></div>`;
    $('alert-container').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

// Las listas con data-crear="<maestro>" terminan con la opción "+ Crear nuevo…"
const OPCION_CREAR = '__crear__';
const opcionCrear = crear => crear ? `<option value="${OPCION_CREAR}">+ Crear nuevo…</option>` : '';

const populateDropdown = (id, opts, placeholder) => {
    const s = $(id);
    if (!s) return;
    s.innerHTML = `<option value="">${esc(placeholder)}</option>` +
        opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('') + opcionCrear(s.dataset.crear);
};

// Ejecuta una operación con spinner y manejo de errores centralizado
async function run(fn) {
    showSpinner();
    try {
        return await fn();
    } catch (err) {
        console.error(err);
        showAlert(err.message || String(err), 'danger');
    } finally {
        hideSpinner();
    }
}

// Lanza el error de Supabase o devuelve los datos
function ok({ data, error }) {
    if (error) throw new Error(error.message);
    return data;
}

// Supabase entrega máximo 1000 filas por consulta: se pagina hasta traer todo
async function fetchAll(buildQuery, pageSize = 1000) {
    const out = [];
    for (let from = 0; ; from += pageSize) {
        const data = ok(await buildQuery().range(from, from + pageSize - 1));
        out.push(...data);
        if (data.length < pageSize) break;
    }
    return out;
}

// ---------------------------------------------------------------- inicio y sesión
document.addEventListener('DOMContentLoaded', () => {
    createClientModal = new bootstrap.Modal($('createClientModal'));
    referenciaModal = new bootstrap.Modal($('referenciaModal'));
    crearModal = new bootstrap.Modal($('crearModal'));
    asignarClienteModal = new bootstrap.Modal($('asignarClienteModal'));
    passwordModal = new bootstrap.Modal($('passwordModal'));

    $('loginForm').addEventListener('submit', handleLogin);
    $('olvidoButton').addEventListener('click', recuperarPassword);
    $('logoutButton').addEventListener('click', salir);
    $('sinAccesoSalir').addEventListener('click', salir);
    $('cambiarPasswordButton').addEventListener('click', () => abrirCambioPassword());
    $('passwordForm').addEventListener('submit', guardarPassword);
    $('passwordModal').addEventListener('shown.bs.modal', () => $('nuevaPassword').focus());
    registrarEventos();

    // INITIAL_SESSION, SIGNED_IN, SIGNED_OUT, PASSWORD_RECOVERY...
    sb.auth.onAuthStateChange((evento, session) => {
        if (evento === 'PASSWORD_RECOVERY') abrirCambioPassword();
        // Fuera del callback: supabase-js no admite llamadas a la API dentro de él
        setTimeout(() => mostrarVista(session), 0);
    });
});

async function mostrarVista(session) {
    const uid = session?.user?.id ?? null;
    if (uid === usuarioActual) return;
    usuarioActual = uid;
    const ver = (id, si) => $(id).classList.toggle('d-none', !si);

    if (!uid) {
        perfil = null;
        ver('loginView', true); ver('sinAccesoView', false); ver('appView', false);
        $('userBox').classList.add('d-none'); $('userBox').classList.remove('d-flex');
        return;
    }
    const { data, error } = await sb.from('perfiles').select('*').eq('id', uid).maybeSingle();
    if (error) console.warn('perfiles', error.message);
    perfil = data;
    $('userBox').classList.add('d-flex'); $('userBox').classList.remove('d-none');
    $('userNombre').textContent = perfil?.nombre || aUsuario(session.user.email);
    $('userIniciales').textContent = iniciales($('userNombre').textContent);
    $('userRol').textContent = perfil ? (ROLES[perfil.rol] || 'Vendedor') : '';
    mostrarTiendaUsuario();
    ver('loginView', false);

    if (!perfil?.activo) {
        $('sinAccesoEmail').textContent = aUsuario(session.user.email);
        ver('sinAccesoView', true); ver('appView', false);
        if (error) showAlert('La base de datos no está actualizada. Ejecute supabase/01_esquema.sql en Supabase.', 'warning');
        return;
    }
    ver('sinAccesoView', false); ver('appView', true);
    document.querySelectorAll('.solo-admin').forEach(e => e.classList.toggle('d-none', !esAdmin()));
    document.querySelectorAll('.solo-vendedor').forEach(e => e.classList.toggle('d-none', esAdmin()));
    document.querySelectorAll('.solo-equipo').forEach(e => e.classList.toggle('d-none', !veEquipo()));
    if (!datosIniciados) { datosIniciados = true; cargarDatosIniciales(); }
}

async function handleLogin(e) {
    e.preventDefault();
    mensajeLogin('');
    showSpinner();
    const { error } = await sb.auth.signInWithPassword({
        email: aEmail($('loginEmail').value),
        password: $('loginPassword').value,
    });
    hideSpinner();
    if (error) mensajeLogin(/invalid/i.test(error.message) ? 'Usuario o contraseña incorrectos.' : 'No se pudo iniciar sesión: ' + error.message, 'danger');
}

function mensajeLogin(texto, tipo = 'info') {
    const m = $('loginMensaje');
    m.className = `alert alert-${tipo} py-2` + (texto ? '' : ' d-none');
    m.textContent = texto;
}

async function recuperarPassword() {
    const email = $('loginEmail').value.trim();
    // Los usuarios sin correo real no pueden recibir el enlace: el admin les cambia la contraseña
    if (!email.includes('@')) { mensajeLogin('Pida al administrador que le asigne una contraseña nueva (pestaña Usuarios).', 'info'); return; }
    showSpinner();
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    hideSpinner();
    mensajeLogin(error ? 'No se pudo enviar el correo: ' + error.message
        : 'Si el correo está registrado, le llegará un enlace para crear una contraseña nueva.', error ? 'danger' : 'success');
}

// perfilId: cambiar la contraseña de otro usuario (solo administradores); sin él, la propia
let passwordObjetivo = null;
function abrirCambioPassword(perfilId = null, nombre = '') {
    passwordObjetivo = perfilId;
    $('passwordForm').reset();
    $('passwordTitulo').textContent = perfilId ? `Contraseña de ${nombre}` : 'Cambiar mi contraseña';
    passwordModal.show();
}

function guardarPassword(e) {
    e.preventDefault();
    const nueva = $('nuevaPassword').value;
    run(async () => {
        if (passwordObjetivo) ok(await sb.rpc('admin_cambiar_password', { p_perfil: passwordObjetivo, p_password: nueva }));
        else ok(await sb.auth.updateUser({ password: nueva }));
        passwordModal.hide();
        showAlert('Contraseña actualizada', 'success');
    });
}

async function salir() {
    await sb.auth.signOut();
    location.reload();  // limpia todo lo cargado del usuario anterior
}

function cargarDatosIniciales() {
    run(async () => {
        await Promise.all([cargarMaestros(), veEquipo() ? cargarPerfiles() : null, cargarConsecutivos()]);
        $('cargaFecha').value = hoyISO();
        $('fechaPago').value = hoyISO();
        $('recDesde').value = inicioMesISO();
        $('recHasta').value = hoyISO();
        $('trasladoFecha').value = hoyISO();
        actualizarBadgeTraslados();
    });
}

async function cargarPerfiles() {
    perfiles = ok(await sb.from('perfiles').select('*').order('nombre'));
}
const nombreUsuario = id => { const u = perfiles.find(p => p.id === id); return u ? (u.nombre || u.email) : ''; };

// "Maria Lopez" -> "ML"
const iniciales = nombre => String(nombre || '').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase();

// ---------------------------------------------------------------- armazón: menú lateral y cabecera
function abrirSeccion(idPestana) {
    bootstrap.Tab.getOrCreateInstance($(idPestana)).show();
}

function registrarArmazon() {
    // Cabecera: migaja y título de la sección abierta
    $('menuPrincipal').addEventListener('shown.bs.tab', e => {
        $('cabeceraMigaja').textContent = e.target.dataset.migaja || '';
        $('cabeceraTitulo').textContent = e.target.dataset.titulo || e.target.textContent.trim();
        document.querySelectorAll('.barra-movil [data-ir]').forEach(b => b.classList.toggle('activo', b.dataset.ir === e.target.id));
        $('appView').classList.remove('menu-abierto');
        window.scrollTo({ top: 0, behavior: 'instant' });
    });
    // Accesos directos (barra inferior en móvil y botón "Nueva venta")
    document.querySelectorAll('[data-ir]').forEach(b => b.addEventListener('click', () => {
        if (b.id === 'accionNuevaVenta' && $('envioOriginal').value) resetForm();
        abrirSeccion(b.dataset.ir);
    }));
    // Cajón del menú en móvil
    $('abrirMenu').addEventListener('click', () => $('appView').classList.add('menu-abierto'));
    $('cerrarMenu').addEventListener('click', () => $('appView').classList.remove('menu-abierto'));
    $('menuVelo').addEventListener('click', () => $('appView').classList.remove('menu-abierto'));
    document.querySelector('.barra-movil [data-ir="registro-tab"]').classList.add('activo');

    // Grupos del menú: el rótulo los contrae o despliega (se recuerda en este navegador)
    const CLAVE_GRUPOS = 'ariga.menuContraido';
    let contraidos = [];
    try { contraidos = JSON.parse(localStorage.getItem(CLAVE_GRUPOS)) || []; } catch { contraidos = []; }
    document.querySelectorAll('.menu-rotulo').forEach(b => {
        const grupo = b.closest('.menu-grupo');
        const contraer = c => { grupo.classList.toggle('contraido', c); b.setAttribute('aria-expanded', String(!c)); };
        contraer(contraidos.includes(b.dataset.grupo));
        b.addEventListener('click', () => {
            contraer(!grupo.classList.contains('contraido'));
            const lista = [...document.querySelectorAll('.menu-grupo.contraido .menu-rotulo')].map(x => x.dataset.grupo);
            try { localStorage.setItem(CLAVE_GRUPOS, JSON.stringify(lista)); } catch { /* sin almacenamiento */ }
        });
    });
}

function registrarEventos() {
    registrarArmazon();

    // "+ Crear nuevo…" en cualquier lista: recuerda el valor previo y abre el formulario
    document.addEventListener('focusin', e => {
        if (e.target.tagName === 'SELECT' && e.target.dataset.crear) e.target.dataset.previo = e.target.value;
    });
    document.addEventListener('change', e => {
        const sel = e.target;
        if (sel.tagName !== 'SELECT' || !sel.dataset.crear) return;
        if (sel.value !== OPCION_CREAR) { sel.dataset.previo = sel.value; return; }
        sel.value = sel.dataset.previo ?? '';
        abrirCrear(sel.dataset.crear, sel);
    });
    $('crearForm').addEventListener('submit', guardarCrear);
    $('crearModal').addEventListener('shown.bs.modal', () => $('crearNombre').focus());

    // Buscadores de clientes (código, nombre o DPI)
    crearBuscadorCliente('clientDPI', ponerClienteEnVenta, {
        alNoEncontrar: q => {
            if (confirm('Cliente no encontrado. ¿Desea crearlo?'))
                abrirModalCliente(/^\d[\d-]*$/.test(q) ? { dpi: q } : { nombre: q }, 'venta');
        },
    });
    crearBuscadorCliente('pagoCliente', seleccionarClientePago);
    crearBuscadorCliente('ecCliente', c => cargarEstadoCuenta(c.id), { filtrar: clienteEnFiltroCartera });
    crearBuscadorCliente('asignarCliente', asignarClienteAPago);

    // Venta
    $('newClientSaleButton').addEventListener('click', () => abrirModalCliente({}, 'venta'));
    registrarListaClientes();
    $('saveClientButton').addEventListener('click', saveNewClient);
    $('addProductButton').addEventListener('click', () => addProductLine());
    $('saleForm').addEventListener('submit', handleFormSubmit);
    $('productLines').addEventListener('input', updateLineTotal);

    $('productLines').addEventListener('click', e => {
        if (e.target.classList.contains('delete-row')) { e.target.closest('tr').remove(); updateSubtotal(); }
    });

    // Inteligencia comercial
    $('inteligencia-tab').addEventListener('shown.bs.tab', loadInteligencia);
    $('intPeriodo').addEventListener('change', () => {
        $('intRango').classList.toggle('d-none', $('intPeriodo').value !== 'rango');
        if ($('intPeriodo').value !== 'rango') loadInteligencia();
    });
    ['intDesde', 'intHasta'].forEach(id => $(id).addEventListener('change', loadInteligencia));
    $('intActualizar').addEventListener('click', loadInteligencia);
    $('intBodega').addEventListener('change', loadInteligencia);
    $('intVendedor').addEventListener('change', loadInteligencia);
    $('exportGramosButton').addEventListener('click', exportGramos);

    // Búsqueda de pedidos
    $('searchEnvioButton').addEventListener('click', buscarPedidos);
    $('searchEnvioInput').addEventListener('keydown', e => { if (e.key === 'Enter') buscarPedidos(); });
    $('searchPedidoCampo').addEventListener('change', () => { if ($('searchEnvioInput').value.trim()) buscarPedidos(); });
    $('pedidosTableBody').addEventListener('click', e => {
        const b = e.target.closest('.abrir-pedido');
        if (b) abrirPedido(b.dataset.clave);
    });
    $('deleteOrderButton').addEventListener('click', deleteOrder);
    $('newSaleButton').addEventListener('click', resetForm);

    // Pagos
    $('paymentForm').addEventListener('submit', handlePaymentSubmit);
    $('pagoEnviosBody').addEventListener('input', e => { if (e.target.classList.contains('abono-envio')) mostrarNuevoSaldo(); });
    $('pagoEnviosBody').addEventListener('click', e => {
        const b = e.target.closest('.abono-todo');
        if (!b) return;
        const inp = b.closest('tr').querySelector('.abono-envio');
        inp.value = num(inp.dataset.saldo) > 0 ? num(inp.dataset.saldo).toFixed(2) : '';
        mostrarNuevoSaldo();
    });
    $('pagoRepartirBoton').addEventListener('click', repartirPago);
    moverPagoModal = new bootstrap.Modal($('moverPagoModal'));
    $('pagoHistorialBody').addEventListener('click', e => { const b = e.target.closest('.mover-pago'); if (b) abrirMoverPago(Number(b.dataset.id)); });
    $('moverPagoEnvio').addEventListener('change', sugerirValorMover);
    $('moverPagoGuardar').addEventListener('click', guardarMoverPago);
    $('pagoVerPagados').addEventListener('change', renderEnviosPago);
    $('pills-recibidos-tab').addEventListener('shown.bs.tab', loadRecibidos);
    ['recDesde', 'recHasta', 'recSinCliente'].forEach(id => $(id).addEventListener('change', loadRecibidos));
    $('recBuscarButton').addEventListener('click', loadRecibidos);
    ['recMetodo', 'recUsuario', 'recCliente'].forEach(id => $(id).addEventListener('input', renderRecibidos));
    $('exportRecibidosButton').addEventListener('click', exportRecibidos);
    $('recibidosTableBody').addEventListener('click', e => {
        const b = e.target.closest('.asignar-pago');
        if (b) abrirAsignarCliente(Number(b.dataset.id));
    });

    // Histórico
    $('historico-tab').addEventListener('shown.bs.tab', () => { if (esAdmin()) cargarHistorialAdmin(); else { loadHistoryData(); cargarMisComisiones(); } });
    $('misComActualizar').addEventListener('click', cargarMisComisiones);
    construirHistorialAdmin();
    construirReportes();
    ['filterCliente', 'filterTienda', 'filterTipo', 'filterProducto'].forEach(id => $(id).addEventListener('input', filterHistory));

    // Cartera
    // Saldos y Por envío usan los mismos datos (se recargan al abrir Cartera o cambiar de sección)
    $('cartera-tab').addEventListener('shown.bs.tab', loadCartera);
    $('pills-saldoscli-tab').addEventListener('shown.bs.tab', loadCartera);
    $('pills-detalle-tab').addEventListener('shown.bs.tab', loadCartera);
    ['carBodega', 'carVendedor'].forEach(id => $(id).addEventListener('change', aplicarFiltrosCartera));
    ['filterSaldos', 'saldosSoloDeudores'].forEach(id => $(id).addEventListener('input', filterSaldos));
    $('saldosTableBody').addEventListener('click', e => {
        const tr = e.target.closest('tr[data-codigo]');
        if (tr) verEstadoCuenta(Number(tr.dataset.codigo));
    });
    ['filterCarteraDetalleCliente', 'filterCarteraDetalleEnvio'].forEach(id => $(id).addEventListener('input', filterCarteraDetalle));

    // Inventario: cada sub-sección se recarga al abrirla
    const subInventario = { 'pills-saldos-tab': loadInventoryData, 'pills-carga-tab': loadCargas,
        'pills-referencias-tab': loadReferencias, 'pills-movimientos-tab': loadMovimientos,
        'pills-traslados-tab': loadTraslados };
    $('inventario-tab').addEventListener('shown.bs.tab', () =>
        subInventario[document.querySelector('#inventario .nav-pills .active').id]());
    Object.entries(subInventario).forEach(([id, fn]) => $(id).addEventListener('shown.bs.tab', fn));
    ['inventarioVista', 'filterInventarioTienda', 'filterInventarioProducto'].forEach(id => $(id).addEventListener('input', filterInventory));
    $('exportInventarioButton').addEventListener('click', exportInventario);
    $('inventarioTableBody').addEventListener('click', e => {
        const tr = e.target.closest('tr[data-tienda]');
        if (tr) verMovimientos(tr.dataset.tienda, tr.dataset.producto);
    });

    $('cargaForm').addEventListener('submit', handleCargaSubmit);
    ['cargaTienda', 'cargaProducto'].forEach(id => $(id).addEventListener('change', mostrarSaldoCarga));
    $('plantillaCargaButton').addEventListener('click', descargarPlantillaCarga);
    $('archivoCarga').addEventListener('change', e => { if (e.target.files[0]) leerArchivoCarga(e.target.files[0]); });
    $('masivaCancelar').addEventListener('click', limpiarCargaMasiva);
    $('masivaConfirmar').addEventListener('click', confirmarCargaMasiva);
    $('pills-carga-tab').addEventListener('shown.bs.tab', () => {
        $('masivaTiendaNota').textContent = !esAdmin() && perfil?.tienda ? `Todo se carga en su bodega: ${perfil.tienda}` : '';
    });
    ['filterCargasTienda', 'filterCargasProducto'].forEach(id => $(id).addEventListener('input', renderCargas));
    $('cargasTableBody').addEventListener('click', e => {
        const b = e.target.closest('.delete-carga');
        if (b) eliminarCarga(Number(b.dataset.id));
    });

    $('newReferenciaButton').addEventListener('click', () => abrirModalReferencia());
    $('saveReferenciaButton').addEventListener('click', guardarReferencia);
    $('filterReferencias').addEventListener('input', renderReferencias);
    $('exportReferenciasButton').addEventListener('click', exportReferencias);
    $('referenciasTableBody').addEventListener('click', e => {
        const b = e.target.closest('.edit-ref');
        if (b) abrirModalReferencia(referencias.find(r => r.nombre === b.dataset.nombre));
    });

    ['movTienda', 'movProducto'].forEach(id => $(id).addEventListener('change', loadMovimientos));

    // Traslados
    $('trasladoForm').addEventListener('submit', enviarTraslado);
    ['trasladoOrigen', 'trasladoProducto'].forEach(id => $(id).addEventListener('change', () => { prepararDestinos(); mostrarSaldoTraslado(); }));
    $('filterTrasladoEstado').addEventListener('input', renderTraslados);
    $('exportTrasladosButton').addEventListener('click', exportTraslados);
    ['porRecibirBody', 'trasladosBody'].forEach(id => $(id).addEventListener('click', e => {
        const b = e.target.closest('[data-accion]');
        if (b) (b.dataset.accion === 'recibir' ? recibirTraslado : anularTraslado)(Number(b.dataset.id));
    }));
    $('exportMovimientosButton').addEventListener('click', exportMovimientos);

    // Clientes
    $('clientes-tab').addEventListener('shown.bs.tab', loadClientesData);
    $('filterClientes').addEventListener('input', filterClientes);
    $('filterClientesTipo').addEventListener('input', filterClientes);
    // Al elegir otro vendedor dueño en un cliente nuevo, cambia el código propuesto
    $('clientResponsable').addEventListener('change', () => { if (!$('editClientId').value) mostrarProximoCodigo(); });
    $('newClientButton').addEventListener('click', () => abrirModalCliente({}, 'clientes'));
    $('clientesTableBody').addEventListener('click', e => {
        const b = e.target.closest('.edit-client');
        if (b) abrirModalCliente(fullClientesData.find(c => c.id === Number(b.dataset.id)), 'clientes');
    });

    // Maestros
    construirMaestros();
    $('maestros-tab').addEventListener('shown.bs.tab', () => run(cargarMaestros));
    $('maestros').addEventListener('submit', e => {
        if (e.target.classList.contains('maestro-editar-form')) { e.preventDefault(); renombrarMaestro(e.target); return; }
        if (!e.target.classList.contains('maestro-form')) return;
        e.preventDefault();
        agregarMaestro(e.target.dataset.maestro, e.target.querySelector('input'), e.target.querySelector('.maestro-clase-nueva')?.value);
    });
    $('maestros').addEventListener('change', e => {
        if (e.target.classList.contains('maestro-activo')) cambiarActivoMaestro(e.target);
        if (e.target.classList.contains('maestro-unidad')) cambiarUnidadTipo(e.target);
        else if (e.target.classList.contains('maestro-clase')) cambiarClaseTienda(e.target);
    });
    $('maestros').addEventListener('click', e => {
        const b = e.target.closest('.maestro-delete');
        if (b) eliminarMaestro(b.dataset.maestro, b.dataset.nombre);
        const ed = e.target.closest('.maestro-editar');
        if (ed && esAdmin()) editarMaestro(ed.dataset.maestro, ed.dataset.nombre);
        if (e.target.closest('.maestro-cancelar')) editarMaestro(null);
    });
    $('maestros').addEventListener('input', e => {
        if (e.target.classList.contains('maestro-buscar')) renderMaestro(e.target.dataset.maestro);
    });
    $('maestros').addEventListener('keydown', e => {
        if (e.key === 'Escape' && e.target.closest('.maestro-editar-form')) editarMaestro(null);
    });

    // Usuarios (administradores)
    $('usuarios-tab').addEventListener('shown.bs.tab', loadUsuarios);
    registrarJerarquias();
    registrarCaja();
    registrarCuadre();
    $('usuarioForm').addEventListener('submit', agregarUsuario);
    $('usuariosTableBody').addEventListener('change', e => {
        if (e.target.matches('.usr-activo')) actualizarUsuario(e.target, { activo: e.target.checked });
        if (e.target.matches('.usr-tienda')) actualizarUsuario(e.target, { tienda: e.target.value || null });
        if (e.target.matches('.usr-vendedor')) actualizarUsuario(e.target, { vendedor: e.target.value || null });
        if (e.target.matches('.usr-rango')) guardarRangoUsuario(e.target.closest('tr'));
    });
    $('usuariosTableBody').addEventListener('click', e => {
        const b = e.target.closest('.usr-password');
        if (b) abrirCambioPassword(b.dataset.id, b.dataset.nombre);
    });

    // Datos en bruto
    $('datosTabla').innerHTML = TABLAS_DATOS.map((t, i) => `<option value="${i}">${esc(t.titulo)}</option>`).join('');
    $('datos-tab').addEventListener('shown.bs.tab', loadDatos);
    $('datosTabla').addEventListener('change', loadDatos);
    $('filterDatos').addEventListener('input', filterDatos);

    // Exportar a Excel (exporta lo que está filtrado en pantalla)
    $('exportHistoricoButton').addEventListener('click', exportHistorico);
    $('exportSaldosButton').addEventListener('click', exportSaldos);
    $('exportEstadoButton').addEventListener('click', exportEstadoCuenta);
    $('exportCarteraDetalleButton').addEventListener('click', exportCarteraDetalle);
    $('exportClientesButton').addEventListener('click', exportClientes);
    $('exportDatosButton').addEventListener('click', exportDatos);
}

// ---------------------------------------------------------------- buscador de clientes
// Un resultado: se elige solo. Varios: lista para escoger. Ninguno: alNoEncontrar.
function crearBuscadorCliente(id, alElegir, { alNoEncontrar, filtrar } = {}) {
    const input = $(id), lista = $(id + 'Resultados');
    let resultados = [];
    const cerrar = () => lista.classList.add('d-none');
    const buscar = () => {
        const q = input.value.trim();
        if (!q) return;
        run(async () => {
            resultados = ok(await sb.rpc('buscar_clientes', { p_termino: q }));
            const antes = resultados.length;
            if (filtrar) resultados = resultados.filter(filtrar);
            resultados.forEach(recordarConsecutivo);
            ordenarPorCodigo(resultados, 'id');
            if (resultados.length === 1) { cerrar(); alElegir(resultados[0]); return; }
            if (!resultados.length) {
                cerrar();
                if (alNoEncontrar) alNoEncontrar(q); else showAlert(`No se encontró ningún cliente con "${q}"` + (antes ? ' que cumpla los filtros de bodega o vendedor de arriba' : ''), 'warning');
                return;
            }
            lista.innerHTML = resultados.map((c, i) => `<button type="button" class="list-group-item list-group-item-action" data-i="${i}">
                <span class="badge text-bg-secondary me-2">${veEquipo() ? c.id : (c.consecutivo ?? c.id)}</span>${esc(c.nombre)}${c.tipo_cliente === 'MAYORISTA' ? ' <span class="badge text-bg-warning ms-1">Mayorista</span>' : ''}
                <small class="text-muted ms-1">${esc(c.dpi || c.nit || c.telefono || '')}</small></button>`).join('');
            lista.classList.remove('d-none');
        });
    };
    $(id + 'Boton').addEventListener('click', buscar);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); buscar(); }
        if (e.key === 'Escape') cerrar();
    });
    lista.addEventListener('click', e => {
        const b = e.target.closest('[data-i]');
        if (b) { cerrar(); recordarConsecutivo(resultados[Number(b.dataset.i)]); alElegir(resultados[Number(b.dataset.i)]); }
    });
    document.addEventListener('click', e => { if (!lista.contains(e.target) && e.target !== input) cerrar(); });
}

// ---------------------------------------------------------------- clientes (ficha)
// Campos del modal <-> columnas de la tabla clientes
const CAMPOS_CLIENTE = {
    newClientDPI: 'dpi', newClientNIT: 'nit', newClientNombre: 'nombre',
    newClientFechaNac: 'fecha_nacimiento', newClientDepto: 'departamento',
    newClientTel: 'telefono', newClientTel2: 'telefono2', newClientCorreo: 'correo',
    newClientDireccion: 'direccion', newClientNIT2: 'nit2', newClientCodigo: 'codigo_cliente',
    newClientTipo: 'tipo_cliente',
};
let origenModalCliente = 'venta'; // 'venta' llena el formulario de venta al guardar

// c.id presente = edición; origen: 'venta' o 'clientes'
function abrirModalCliente(c = {}, origen = 'clientes') {
    origenModalCliente = origen;
    $('createClientForm').reset();
    $('editClientId').value = c.id || '';
    $('clientModalTitle').textContent = c.id ? 'Editar Cliente' : 'Crear Nuevo Cliente';
    $('clientModalId').textContent = c.id ? textoCodigo(c) : 'se asigna automáticamente al guardar';
    for (const [id, col] of Object.entries(CAMPOS_CLIENTE)) {
        if (id === 'newClientDepto') setSelectValue(id, c[col]); else $(id).value = c[col] ?? '';
    }
    // Mayorista: solo el administrador lo asigna
    if (!c.tipo_cliente) $('newClientTipo').value = 'MINORISTA';
    $('newClientTipo').disabled = !esAdmin();
    $('newClientTipoAyuda').textContent = esAdmin() ? '' : 'Solo el administrador crea clientes mayoristas.';
    // Saldo inicial: al crear se escribe; al editar se carga el que tiene para poder cambiarlo
    saldoInicialOriginal = null;
    $('saldoInicialFecha').value = hoyISO();
    $('saldoInicialEstado').textContent = '(opcional)';
    $('saldoInicialAyuda').textContent = 'Queda registrado como una venta "SALDO INICIAL" y suma a lo que debe el cliente.';
    // Solo el dueño o el admin lo cambian (un supervisor no edita clientes de su equipo)
    const puedeSaldo = !c.id || esAdmin() || c.creado_por === perfil.id;
    $('saldoInicialGrupo').classList.toggle('d-none', !puedeSaldo);
    if (c.id && puedeSaldo) cargarSaldoInicial(c.id);
    aplicarTiendaUsuario();  // el reset del formulario borra la tienda fija
    // Vendedor dueño: el administrador lo elige al crear o al editar
    $('clientResponsableGrupo').classList.toggle('d-none', !esAdmin());
    if (esAdmin()) {
        $('clientResponsable').innerHTML = (c.id ? '<option value="">(sin asignar: solo administradores)</option>' : '') +
            perfiles.map(p => `<option value="${p.id}">${esc(p.nombre || p.email)}${p.id === perfil.id ? ' (usted)' : ''}${p.rango_desde ? ` · códigos ${p.rango_desde}-${p.rango_hasta}` : ''}${p.activo ? '' : ' (inactivo)'}</option>`).join('');
        $('clientResponsable').value = c.id ? (c.creado_por ?? '') : perfil.id;
    }
    if (!c.id) mostrarProximoCodigo();
    createClientModal.show();
}

// Saldo inicial actual del cliente (venta "SALDO INICIAL") y lo que ya se le abonó
let saldoInicialOriginal = null;
const valoresSaldoInicial = () => ({
    valor: String(num($('saldoInicialValor').value)), fecha: $('saldoInicialFecha').value,
    tienda: $('saldoInicialTienda').value, vendedor: $('saldoInicialVendedor').value,
});
async function cargarSaldoInicial(clienteId) {
    $('saldoInicialEstado').textContent = '(cargando…)';
    const [ventas, envios] = await Promise.all([
        sb.from('ventas').select('valor_total,fecha_venta,tienda,vendedor,envio,pedido_id').eq('cliente_id', clienteId).eq('producto', 'SALDO INICIAL').then(ok),
        sb.rpc('envios_cliente', { p_cliente: clienteId }).then(ok),
    ]);
    if (String(clienteId) !== $('editClientId').value) return;   // se abrió otra ficha
    const v = ventas[0];
    if (v) {
        $('saldoInicialValor').value = num(v.valor_total).toFixed(2);
        $('saldoInicialFecha').value = String(v.fecha_venta || hoyISO()).slice(0, 10);
        setSelectValue('saldoInicialTienda', v.tienda || '');
        setSelectValue('saldoInicialVendedor', v.vendedor || '');
        const e = envios.find(x => x.envio === ((v.envio || '').trim() || v.pedido_id));
        const abonado = num(e?.pagado);
        $('saldoInicialEstado').textContent = `(envío ${(v.envio || '').trim() || v.pedido_id})`;
        $('saldoInicialAyuda').textContent = abonado > 0.005
            ? `Ya se abonaron ${fmtQ(abonado)} a este saldo; queda pendiente ${fmtQ(e.saldo)}. El valor no puede ser menor que lo abonado.`
            : 'Puede cambiar el valor, la fecha, la tienda o el vendedor. En 0 se elimina el saldo inicial.';
        $('saldoInicialValor').min = abonado > 0.005 ? abonado.toFixed(2) : '0';
    } else {
        $('saldoInicialEstado').textContent = '(no tiene)';
        $('saldoInicialAyuda').textContent = 'Si el cliente debía algo antes de registrarse, escriba el valor y se agrega como "SALDO INICIAL".';
        $('saldoInicialValor').min = '0';
    }
    saldoInicialOriginal = valoresSaldoInicial();
}

// "1003 · consecutivo 3 de Pablo" (admin) o "3" (vendedor)
function textoCodigo(c) {
    if (!veEquipo()) return String(c.consecutivo ?? c.id);
    const dueno = nombreUsuario(c.creado_por);
    return `${c.id}` + (c.consecutivo != null ? ` · consecutivo ${c.consecutivo}${dueno ? ` de ${dueno}` : ''}` : '');
}

// Código que tendrá el cliente nuevo según el rango del usuario
async function mostrarProximoCodigo() {
    const dueno = esAdmin() ? ($('clientResponsable').value || perfil.id) : null;
    const { data, error } = await sb.rpc('proximo_codigo_cliente', { p_dueno: dueno });
    if (error || $('editClientId').value) return;   // base sin actualizar o se abrió otra ficha
    const s = unico(data);
    $('clientModalId').textContent = !s || s.codigo === null ? 'el rango de códigos de ese vendedor está lleno: amplíelo en Usuarios'
        : `${textoCodigo({ id: s.codigo, consecutivo: s.consecutivo, creado_por: dueno })} (se confirma al guardar)`;
}

function saveNewClient() {
    const d = {};
    for (const [id, col] of Object.entries(CAMPOS_CLIENTE)) d[col] = $(id).value.trim() || null;
    if (!d.nombre) { $('newClientNombre').reportValidity(); return; }
    if (d.correo && !$('newClientCorreo').checkValidity()) { $('newClientCorreo').reportValidity(); return; }
    const id = $('editClientId').value;
    const saldo = num($('saldoInicialValor').value);
    // No se puede bajar el saldo inicial por debajo de lo ya abonado
    if (!$('saldoInicialValor').checkValidity()) { $('saldoInicialValor').reportValidity(); return; }
    run(async () => {
        let c;
        if (esAdmin()) d.creado_por = $('clientResponsable').value || null;
        else delete d.tipo_cliente;   // la base no deja a un vendedor crear mayoristas
        let saldoMsg = '';
        if (id) {
            c = ok(await sb.from('clientes').update(d).eq('id', id).select().single());
            // Saldo inicial: solo si se cambió algo
            const nuevo = valoresSaldoInicial();
            if (saldoInicialOriginal && JSON.stringify(nuevo) !== JSON.stringify(saldoInicialOriginal)) {
                const pendiente = ok(await sb.rpc('guardar_saldo_inicial', { p_cliente: c.id, p_saldo: nuevo }));
                saldoMsg = num(nuevo.valor) > 0 ? ` · Saldo inicial ${fmtQ(nuevo.valor)} (pendiente ${fmtQ(pendiente)})` : ' · Saldo inicial eliminado';
            }
        } else {
            c = unico(ok(await sb.rpc('crear_cliente', {
                p_cliente: d,
                p_saldo: saldo > 0 ? {
                    valor: saldo, fecha: $('saldoInicialFecha').value,
                    tienda: $('saldoInicialTienda').value, vendedor: $('saldoInicialVendedor').value,
                } : null,
            })));
        }
        createClientModal.hide();
        recordarConsecutivo(c);
        if (origenModalCliente === 'venta') {
            ponerClienteEnVenta(c);
        } else {
            // Al reasignarlo a un vendedor con rango, el cliente puede cambiar de código
            const i = fullClientesData.findIndex(x => x.id === (id ? Number(id) : c.id));
            if (i >= 0) fullClientesData[i] = c; else fullClientesData.unshift(c);
            filterClientes();
        }
        showAlert(id ? (Number(id) !== c.id ? `Cliente actualizado. Nuevo código: ${textoCodigo(c)}` : `Cliente ${cod(c.id)} actualizado con éxito`) + saldoMsg
            : `Cliente creado. Código cliente: ${textoCodigo(c)}` + (saldo > 0 ? ` · Saldo inicial ${fmtQ(saldo)} registrado` : ''), 'success');
    });
}

// ---------------------------------------------------------------- venta: elegir cliente del listado
let listaClientesModal, listaClientes = [];
// Desde dónde se abrió el listado: qué hacer al elegir y qué clientes mostrar
let listaClientesUso = null;
const sinTildes = v => norm(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function registrarListaClientes() {
    listaClientesModal = new bootstrap.Modal($('listaClientesModal'));
    // Venta y Pagos: solo clientes propios (el admin, todos). Pedidos: todos los que el usuario puede ver.
    $('listaClientesBoton').addEventListener('click', () => abrirListaClientes({
        entrada: 'clientDPI', soloPropios: true, crear: true, titulo: 'Elegir cliente para la venta', alElegir: ponerClienteEnVenta }));
    $('pagoListaClientes').addEventListener('click', () => abrirListaClientes({
        entrada: 'pagoCliente', soloPropios: true, titulo: 'Elegir cliente para registrar el pago', alElegir: seleccionarClientePago }));
    $('pedidosListaClientes').addEventListener('click', () => abrirListaClientes({
        entrada: 'searchEnvioInput', soloPropios: false, titulo: 'Ver los pedidos de un cliente', alElegir: c => {
            $('searchPedidoCampo').value = 'codigo';
            $('searchEnvioInput').value = cod(c.id);
            buscarPedidos();
        } }));
    $('listaClientesModal').addEventListener('shown.bs.modal', () => $('listaClientesBuscar').focus());
    $('listaClientesBuscar').addEventListener('input', renderListaClientes);
    $('listaClientesBuscar').addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        $('listaClientesBody').querySelector('[data-id]')?.click();   // Enter elige el primero
    });
    $('listaClientesBody').addEventListener('click', e => {
        const b = e.target.closest('[data-id]');
        if (!b) return;
        const c = listaClientes.find(x => String(x.id) === b.dataset.id);
        listaClientesModal.hide();
        listaClientesUso.alElegir(c);
        if (listaClientesUso.entrada === 'clientDPI') showAlert(`Cliente ${cod(c.id)} · ${c.nombre} seleccionado`, 'success');
    });
    $('listaClientesNuevo').addEventListener('click', () => {
        const q = $('listaClientesBuscar').value.trim();
        listaClientesModal.hide();
        abrirModalCliente(/^\d[\d-]*$/.test(q) ? { dpi: q } : q ? { nombre: q } : {}, 'venta');
    });
}

function abrirListaClientes(uso) {
    listaClientesUso = uso;
    $('listaClientesTitulo').textContent = uso.titulo;
    $('listaClientesNuevo').classList.toggle('d-none', !uso.crear);
    // Lo escrito en el buscador pasa al listado (en la venta, si todavía no hay cliente elegido)
    const escrito = $(uso.entrada).value.trim();
    const yaElegido = uso.entrada === 'clientDPI' ? !!$('clientId').dataset.real
        : uso.entrada === 'pagoCliente' ? !!clientePago && escrito === `${clientePago.id} · ${clientePago.nombre}` : false;
    $('listaClientesBuscar').value = escrito && !yaElegido && !(uso.entrada === 'searchEnvioInput' && $('searchPedidoCampo').value !== 'todo' && $('searchPedidoCampo').value !== 'cliente') ? escrito : '';
    $('listaClientesBody').innerHTML = '<div class="list-group-item text-muted">Cargando clientes…</div>';
    listaClientesModal.show();
    run(async () => {
        if (veEquipo() && !perfiles.length) await cargarPerfiles();
        const todos = await fetchAll(() => sb.from('clientes')
            .select('id,consecutivo,nombre,dpi,nit,telefono,telefono2,tipo_cliente,departamento,creado_por').order('id'));
        // Ventas y pagos solo a clientes propios (el admin, a cualquiera)
        listaClientes = ordenarPorCodigo(todos.filter(c => !uso.soloPropios || esAdmin() || c.creado_por === perfil.id), 'id');
        listaClientes.forEach(recordarConsecutivo);
        renderListaClientes();
    });
}

const MAX_LISTA_CLIENTES = 200;
function renderListaClientes() {
    // Cada palabra escrita debe aparecer en alguno de los datos del cliente
    const palabras = sinTildes($('listaClientesBuscar').value).split(/\s+/).filter(Boolean);
    const d = listaClientes.filter(c => {
        const texto = sinTildes([cod(c.id), c.id, c.nombre, c.dpi, c.nit, c.telefono, c.telefono2, c.departamento,
            veEquipo() ? nombreUsuario(c.creado_por) : ''].filter(Boolean).join(' '));
        return palabras.every(p => texto.includes(p));
    });
    $('listaClientesBody').innerHTML = d.slice(0, MAX_LISTA_CLIENTES).map(c => `<button type="button" class="list-group-item list-group-item-action" data-id="${c.id}">
        <div class="d-flex justify-content-between align-items-center gap-2">
          <span><span class="badge text-bg-secondary me-2">${esc(cod(c.id))}</span><strong>${esc(c.nombre)}</strong>${c.tipo_cliente === 'MAYORISTA' ? ' <span class="badge text-bg-warning ms-1">Mayorista</span>' : ''}</span>
          <i class="bi bi-chevron-right text-muted"></i></div>
        <div class="small text-muted mt-1">${[c.dpi && `DPI ${esc(c.dpi)}`, c.nit && `NIT ${esc(c.nit)}`, c.telefono && `Tel. ${esc(c.telefono)}`, c.departamento && esc(c.departamento),
            veEquipo() && c.creado_por && c.creado_por !== perfil.id && `Vendedor: ${esc(nombreUsuario(c.creado_por))}`].filter(Boolean).join(' · ') || '&nbsp;'}</div>
      </button>`).join('')
        || `<div class="list-group-item text-muted">${listaClientes.length ? 'Ningún cliente coincide. Puede crearlo con el botón de abajo.' : 'Todavía no tiene clientes.'}</div>`;
    $('listaClientesInfo').textContent = `${d.length} de ${listaClientes.length} cliente(s)` + (d.length > MAX_LISTA_CLIENTES ? ` · se muestran ${MAX_LISTA_CLIENTES}; escriba más para afinar` : '');
}

function ponerClienteEnVenta(c) {
    recordarConsecutivo(c);
    $('clientId').dataset.real = c.id ?? '';
    $('clientId').value = cod(c.id);
    $('clientDPI').value = c.dpi || c.nit || c.nombre;
    $('clientName').value = c.nombre;
    $('clientNIT').value = c.nit || '';
}

// ---------------------------------------------------------------- ventas
const getOptionsHTML = (opts, sel, crear) => {
    // Si el valor guardado ya no está en Maestros se conserva igual
    const lista = sel && !opts.includes(sel) ? [...opts, sel] : opts;
    return `<option value="">...</option>` +
        lista.map(x => `<option value="${esc(x)}" ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('') + opcionCrear(crear);
};

// Lo que se vende y se controla en inventario es el Tipo (material) de Maestros.
// La tabla "productos" (referencias) es una copia automática de los tipos.
const tiposConInventario = () => referencias.filter(r => r.activo && r.controla_inventario)
    .sort((a, b) => (a.unidad === 'GRAMOS' ? 0 : 1) - (b.unidad === 'GRAMOS' ? 0 : 1) || (a.orden || 0) - (b.orden || 0))
    .map(r => r.nombre);

function addProductLine(d = {}) {
    const r = document.createElement('tr');
    r.innerHTML = `
        <td><select class="form-select form-select-sm product-tipo" data-crear="tipos" required>${getOptionsHTML(dropdownData.tipos, d.tipo || d.producto, 'tipos')}</select></td>
        <td><input type="number" class="form-control form-control-sm product-cantidad" value="${esc(d.cantidad ?? 1)}" step="any" required></td>
        <td><input type="number" class="form-control form-control-sm product-valor-unitario" value="${esc(d.valor_unitario ?? 0)}" step="0.01" required></td>
        <td><input type="text" class="form-control form-control-sm product-valor-total" value="${esc(num(d.valor_total).toFixed(2))}" readonly></td>
        <td><button type="button" class="btn btn-danger btn-sm delete-row">X</button></td>`;
    $('productLines').appendChild(r);
}

function updateLineTotal(e) {
    if (e.target.classList.contains('product-cantidad') || e.target.classList.contains('product-valor-unitario')) {
        const r = e.target.closest('tr');
        const c = num(r.querySelector('.product-cantidad').value);
        const v = num(r.querySelector('.product-valor-unitario').value);
        r.querySelector('.product-valor-total').value = (c * v).toFixed(2);
        updateSubtotal();
    }
}

function updateSubtotal() {
    let t = 0;
    document.querySelectorAll('.product-valor-total').forEach(i => t += num(i.value));
    $('subtotal').value = t.toFixed(2);
}

function handleFormSubmit(e) {
    e.preventDefault();
    const header = {
        tienda: $('tiendaSelect').value,
        vendedor: $('vendedorSelect').value,
        clienteNombre: $('clientName').value,
        clienteDPI: $('clientDPI').value,
        clienteId: $('clientId').dataset.real || '',
        pedidoId: $('pedidoId').value,
    };
    const productLines = [...document.querySelectorAll('#productLines tr')].map(r => ({
        tipo: r.querySelector('.product-tipo').value,
        producto: r.querySelector('.product-tipo').value,
        cantidad: r.querySelector('.product-cantidad').value,
        valorUnitario: r.querySelector('.product-valor-unitario').value,
        valorTotal: r.querySelector('.product-valor-total').value,
    }));
    if (!header.tienda || !header.vendedor || !header.clienteNombre || productLines.length === 0) {
        showAlert('Complete los datos requeridos (cliente, tienda, vendedor y al menos un producto)', 'warning');
        return;
    }
    const formaPago = $('formaPago').value;
    if (formaPago === 'EFECTIVO' && !header.clienteId) { showAlert('Una venta en efectivo debe tener un cliente registrado (búsquelo o créelo).', 'warning'); return; }
    const venta = { header, productLines, summary: { envio: $('envio').value.trim(), factura: $('factura').value.trim(), formaPago } };
    const clave = $('envioOriginal').value;

    run(async () => {
        if (!clave) {
            const faltantes = await verificarStock(header.tienda, productLines);
            if (faltantes.length && !confirm('Inventario insuficiente:\n\n' + faltantes.join('\n') + '\n\n¿Registrar la venta de todas formas?')) return;
            const id = ok(await sb.rpc('registrar_venta', { p_venta: venta }));
            const total = productLines.reduce((t, l) => t + num(l.valorTotal), 0);
            showAlert(formaPago === 'EFECTIVO'
                ? `Venta en efectivo registrada. Pedido: ${id} · ${fmtQ(total)} pagados y sumados a su caja menor`
                : `Venta registrada con éxito. Pedido: ${id} · Fecha: ${fmtFecha(hoyISO())}`, 'success');
        } else {
            const m = ok(await sb.rpc('actualizar_venta', { p_envio: clave, p_venta: venta }));
            showAlert(m, 'success');
        }
        resetForm();
    });
}

// Compara lo que se va a vender con el saldo de la tienda (solo referencias que controlan inventario)
async function verificarStock(tienda, lineas) {
    const pedido = {};
    for (const l of lineas) {
        const ref = referencias.find(r => r.nombre === l.producto);
        if (ref?.controla_inventario) pedido[l.producto] = (pedido[l.producto] || 0) + num(l.cantidad);
    }
    if (!Object.keys(pedido).length) return [];
    const saldos = ok(await sb.from('inventario').select('producto,saldo').eq('kt', tienda.trim().toUpperCase()));
    return Object.entries(pedido).flatMap(([producto, cant]) => {
        const s = saldos.find(x => norm(x.producto) === norm(producto));
        const disp = s ? num(s.saldo) : 0;
        return cant > disp ? [`• ${producto}: disponible ${fmt(disp)}${s ? '' : ' (sin inventario cargado)'}, se venden ${fmt(cant)}`] : [];
    });
}

// Pedido = líneas con el mismo envío (o el mismo Id interno si no tiene envío)
async function lineasPedido(clave) {
    return ok(await sb.rpc('lineas_pedido', { p_clave: clave }));
}

function buscarPedidos() {
    const q = $('searchEnvioInput').value.trim();
    if (!q) return;
    run(async () => {
        const d = ordenarPorCodigo(ok(await sb.rpc('buscar_pedidos', { p_termino: q, p_campo: $('searchPedidoCampo').value })), 'cliente_id');
        $('pedidosTabla').classList.toggle('d-none', !d.length);
        $('pedidosTableBody').innerHTML = d.map(p => `<tr>
            <td class="fw-semibold">${fmtFecha(p.fecha_venta)}</td><td>${esc(p.pedido_id)}</td><td>${esc(p.envio)}</td>
            <td class="num">${esc(cod(p.cliente_id))}</td><td>${esc(p.cliente)}</td><td>${esc(p.tienda)}</td><td>${esc(p.vendedor)}</td>
            <td class="num">${fmtQ(p.total)}</td>
            <td><button type="button" class="btn btn-gold btn-sm abrir-pedido" data-clave="${esc(p.clave)}">Abrir</button></td></tr>`).join('');
        $('pedidosInfo').textContent = d.length ? `${d.length} pedido(s)${d.length === 100 ? ' (se muestran los 100 más recientes)' : ''}` : 'No se encontraron pedidos.';
    });
}

function abrirPedido(clave) {
    run(async () => {
        const rows = await lineasPedido(clave);
        if (!rows.length) { showAlert('No se encontró el pedido', 'warning'); return; }
        const h = rows[0];
        $('clientId').dataset.real = h.cliente_id ?? '';
        $('clientId').value = cod(h.cliente_id);
        $('clientDPI').value = h.documento_cliente || '';
        $('clientName').value = h.cliente || '';
        $('clientNIT').value = '';
        setSelectValue('tiendaSelect', h.tienda);
        setSelectValue('vendedorSelect', h.vendedor);
        $('pedidoId').value = h.pedido_id || '';
        $('envio').value = h.envio || '';
        $('envioOriginal').value = clave;
        $('factura').value = h.factura || '';
        $('fechaVentaVista').value = fmtFecha(h.fecha_venta);
        $('formaPago').value = h.forma_pago || 'CREDITO';
        notaFormaPago();
        $('productLines').innerHTML = '';
        rows.forEach(l => addProductLine(l));
        updateSubtotal();
        $('mainActionButton').textContent = 'Actualizar Venta';
        $('deleteOrderButton').classList.remove('d-none');
        $('newSaleButton').classList.remove('d-none');
        new bootstrap.Tab($('registro-tab')).show();
        showAlert(`Pedido ${h.pedido_id || clave} del ${fmtFecha(h.fecha_venta)} abierto para editar`, 'info');
    });
}

// Selecciona un valor aunque ya no exista en Maestros (lo agrega temporalmente)
function setSelectValue(idOElemento, value) {
    const s = typeof idOElemento === 'string' ? $(idOElemento) : idOElemento;
    if (value && ![...s.options].some(o => o.value === value)) {
        // antes de "+ Crear nuevo…", si existe
        s.add(new Option(value, value), [...s.options].find(o => o.value === OPCION_CREAR) ?? null);
    }
    s.value = value || '';
    s.dataset.previo = s.value;
}

// Usuario vinculado a una tienda: queda preseleccionada; para vendedores, fija.
// (La base también la impone al guardar ventas y cargas.)
function aplicarTiendaUsuario() {
    const t = perfil?.tienda;
    const fija = !!t && !esAdmin();
    for (const id of ['tiendaSelect', 'cargaTienda', 'saldoInicialTienda']) {
        if (t && (fija || !$(id).value)) setSelectValue(id, t);
        $(id).disabled = fija;
    }
}

function mostrarTiendaUsuario() {
    $('userTienda').textContent = perfil?.tienda || '';
    $('userTienda').classList.toggle('d-none', !perfil?.tienda);
}

function resetForm() {
    $('saleForm').reset();
    delete $('clientId').dataset.real;
    $('pedidoId').value = '';
    $('envioOriginal').value = '';
    $('clientId').value = '';
    $('productLines').innerHTML = '';
    $('mainActionButton').textContent = 'Registrar Venta';
    $('deleteOrderButton').classList.add('d-none');
    $('newSaleButton').classList.add('d-none');
    updateSubtotal();
    aplicarTiendaUsuario();
    notaFormaPago();
}

function deleteOrder() {
    const clave = $('envioOriginal').value;
    if (!clave || !confirm('¿Está seguro de eliminar este pedido?')) return;
    run(async () => {
        const m = ok(await sb.rpc('eliminar_pedido', { p_envio: clave }));
        showAlert(m, 'success');
        resetForm();
    });
}

// ---------------------------------------------------------------- pagos: abono al total del cliente
let clientePago = null, saldoClientePago = 0;

function seleccionarClientePago(c) {
    run(async () => {
        const [resumen, envios, pagosCliente] = await Promise.all([
            sb.from('cartera_clientes').select('*').eq('codigo', c.id).maybeSingle().then(ok),
            sb.rpc('envios_cliente', { p_cliente: c.id }).then(ok),
            fetchAll(() => sb.from('pagos').select('id,fecha_pago,envio,valor_pagado,metodo_pago,boleta,observaciones')
                .eq('cliente_id', c.id).order('fecha_pago', { ascending: false }).order('id', { ascending: false })),
        ]);
        const pagosSinEnvio = pagosCliente.filter(p => !(p.envio || '').trim());
        clientePago = c;
        saldoClientePago = num(resumen?.saldo);
        $('pagoInfoCodigo').textContent = cod(c.id);
        $('pagoInfoNombre').textContent = c.nombre;
        $('pagoInfoDoc').textContent = [c.dpi && `DPI ${c.dpi}`, c.nit && `NIT ${c.nit}`, c.telefono && `Tel. ${c.telefono}`].filter(Boolean).join(' · ');
        $('pagoInfoVentas').textContent = fmt(resumen?.total_ventas);
        $('pagoInfoPagos').textContent = fmt(resumen?.total_pagos);
        $('pagoInfoSaldo').textContent = fmt(saldoClientePago);
        $('pagoCliente').value = `${c.id} · ${c.nombre}`;

        enviosPago = envios;
        // Pagos antiguos que no quedaron aplicados a ningún envío
        const aFavor = pagosSinEnvio.reduce((s, p) => s + num(p.valor_pagado), 0);
        $('pagoSaldoFavor').textContent = aFavor > 0.005 ? `Saldo a favor (pagos sin envío): ${fmtQ(aFavor)}` : '';
        $('pagoSaldoFavor').classList.toggle('d-none', aFavor <= 0.005);
        $('pagoRepartir').value = '';
        $('pagoEnviosBody').innerHTML = '';   // abonos del cliente anterior no se conservan
        renderEnviosPago();
        renderPagosCliente(pagosCliente);
        $('pagoClienteInfo').classList.remove('d-none');
        mostrarNuevoSaldo();
    });
}

// Pagos ya registrados del cliente; el dueño del cliente o el admin pueden moverlos de envío
let pagosClienteLista = [], pagoMoviendo = null, moverPagoModal;
function renderPagosCliente(lista) {
    pagosClienteLista = lista;
    const puedeMover = esAdmin() || clientePago?.creado_por === perfil?.id;
    $('pagoHistorialCuenta').textContent = `(${lista.length})`;
    $('pagoHistorialBody').innerHTML = lista.map(p => `<tr><td>${fmtFecha(p.fecha_pago)}</td><td class="fw-semibold">${esc(p.envio || '(sin envío)')}</td>
        <td class="num">${fmtQ(p.valor_pagado)}</td><td>${esc(p.metodo_pago)}</td><td>${esc(p.boleta)}</td>
        <td class="small text-muted">${esc(p.observaciones)}</td>
        <td class="text-end">${puedeMover && !(p.observaciones || '').startsWith('Venta en efectivo') ? `<button type="button" class="btn btn-outline-secondary btn-sm mover-pago" data-id="${p.id}">Mover</button>` : ''}</td></tr>`).join('')
        || '<tr><td colspan="7" class="text-muted">El cliente no tiene pagos registrados.</td></tr>';
}

function abrirMoverPago(id) {
    pagoMoviendo = pagosClienteLista.find(p => p.id === id);
    if (!pagoMoviendo) return;
    const destinos = enviosPago.filter(e => e.envio !== (pagoMoviendo.envio || '').trim() && num(e.saldo) > 0.005);
    if (!destinos.length) { showAlert('El cliente no tiene otro envío con saldo pendiente al cual mover este pago.', 'warning'); return; }
    $('moverPagoInfo').innerHTML = `Pago del <strong>${fmtFecha(pagoMoviendo.fecha_pago)}</strong> por <strong>${fmtQ(pagoMoviendo.valor_pagado)}</strong>`
        + ` (${esc(pagoMoviendo.metodo_pago || '')}${pagoMoviendo.boleta ? `, boleta ${esc(pagoMoviendo.boleta)}` : ''}), hoy aplicado al envío <strong>${esc(pagoMoviendo.envio || '(sin envío)')}</strong>.`;
    $('moverPagoEnvio').innerHTML = destinos.map(e => `<option value="${esc(e.envio)}" data-saldo="${num(e.saldo)}">Envío ${esc(e.envio)} · debe ${fmtQ(e.saldo)}</option>`).join('');
    sugerirValorMover();
    moverPagoModal.show();
}

function sugerirValorMover() {
    const saldo = num($('moverPagoEnvio').selectedOptions[0]?.dataset.saldo);
    const max = Math.min(num(pagoMoviendo.valor_pagado), saldo);
    $('moverPagoValor').value = max.toFixed(2);
    $('moverPagoValor').max = max.toFixed(2);
}

function guardarMoverPago() {
    if (!$('moverPagoValor').checkValidity()) { $('moverPagoValor').reportValidity(); return; }
    const envio = $('moverPagoEnvio').value, valor = num($('moverPagoValor').value);
    run(async () => {
        ok(await sb.rpc('mover_pago', { p_pago: pagoMoviendo.id, p_envio: envio, p_valor: valor }));
        moverPagoModal.hide();
        showAlert(`${fmtQ(valor)} del pago del ${fmtFecha(pagoMoviendo.fecha_pago)} pasaron al envío ${envio}`, 'success');
        seleccionarClientePago(clientePago);
        $('pagoHistorialBox').open = true;
    });
}

// Envíos del cliente con un campo para abonar a cada uno (los pagados se ocultan salvo que se pidan)
let enviosPago = [];
function renderEnviosPago() {
    const previos = Object.fromEntries([...document.querySelectorAll('#pagoEnviosBody .abono-envio')].map(i => [i.dataset.envio, i.value]));
    const verPagados = $('pagoVerPagados').checked;
    const lista = enviosPago.filter(x => verPagados || num(x.saldo) > 0.005);
    $('pagoEnviosBody').innerHTML = lista.map(x => {
        const debe = num(x.saldo) > 0.005;
        return `<tr class="${debe ? '' : 'text-muted'}"><td>${fmtFecha(x.fecha)}</td><td class="fw-semibold">${esc(x.envio)}</td>
            <td class="num">${fmt(x.venta)}</td><td class="num">${fmt(x.pagado)}</td><td class="num fw-semibold">${fmt(x.saldo)}</td>
            <td class="num">${debe ? `<input type="number" class="form-control form-control-sm text-end abono-envio" data-envio="${esc(x.envio)}" data-saldo="${num(x.saldo)}"
                step="0.01" min="0" max="${num(x.saldo).toFixed(2)}" value="${esc(previos[x.envio] ?? '')}" aria-label="Abono al envío ${esc(x.envio)}">` : '<span class="small">Pagado</span>'}</td>
            <td>${debe ? `<button type="button" class="btn btn-outline-secondary btn-sm abono-todo" title="Pagar el saldo completo">Todo</button>` : ''}</td></tr>`;
    }).join('') || `<tr><td colspan="7" class="text-muted">${enviosPago.length ? 'El cliente no tiene envíos con saldo pendiente.' : 'El cliente no tiene compras registradas.'}</td></tr>`;
    mostrarNuevoSaldo();
}

const abonosPago = () => [...document.querySelectorAll('#pagoEnviosBody .abono-envio')]
    .map(i => ({ envio: i.dataset.envio, saldo: num(i.dataset.saldo), valor: Math.round(num(i.value) * 100) / 100 }))
    .filter(a => a.valor > 0);

// Reparte el valor recibido desde el envío más antiguo
function repartirPago() {
    let resta = num($('pagoRepartir').value);
    if (resta <= 0) { $('pagoRepartir').focus(); return; }
    document.querySelectorAll('#pagoEnviosBody .abono-envio').forEach(i => {
        const aplica = Math.min(resta, num(i.dataset.saldo));
        i.value = aplica > 0.005 ? aplica.toFixed(2) : '';
        resta = Math.round((resta - aplica) * 100) / 100;
    });
    mostrarNuevoSaldo();
    if (resta > 0.005) showAlert(`El valor recibido supera lo que debe el cliente por ${fmtQ(resta)}. Solo se puede aplicar hasta el saldo de sus envíos.`, 'warning');
}

function mostrarNuevoSaldo() {
    const total = abonosPago().reduce((s, a) => s + a.valor, 0);
    $('pagoTotal').textContent = fmtQ(total);
    $('pagoNuevoSaldo').textContent = total > 0 ? `Después de este pago el cliente debe: ${fmtQ(saldoClientePago - total)}` : '';
}

function handlePaymentSubmit(e) {
    e.preventDefault();
    if (!clientePago) { showAlert('Busque primero al cliente', 'warning'); return; }
    const abonos = abonosPago();
    if (!abonos.length) { showAlert('Escriba cuánto se abona a cada envío (al menos uno).', 'warning'); return; }
    const excedido = abonos.find(a => a.valor > a.saldo + 0.005);
    if (excedido) { showAlert(`El abono al envío ${excedido.envio} (${fmtQ(excedido.valor)}) es mayor que su saldo (${fmtQ(excedido.saldo)}).`, 'warning'); return; }
    const valor = abonos.reduce((s, a) => s + a.valor, 0);
    const comun = {
        cliente_id: clientePago.id,
        fecha_pago: $('fechaPago').value,
        metodo_pago: $('metodoPago').value,
        boleta: $('boleta').value.trim() || null,
        observaciones: $('pagoObservaciones').value.trim() || null,
    };
    // Un registro por envío (todos se guardan juntos o ninguno)
    const filas = abonos.map(a => ({ ...comun, envio: a.envio, valor_pagado: a.valor }));
    run(async () => {
        ok(await sb.from('pagos').insert(filas));
        const detalle = abonos.map(a => `${a.envio}: ${fmtQ(a.valor)}`).join(' · ');
        showAlert(`Pago de ${fmtQ(valor)} (${comun.metodo_pago}, ${fmtFecha(comun.fecha_pago)}) registrado a ${clientePago.nombre} → ${detalle}. Nuevo saldo: ${fmtQ(saldoClientePago - valor)}`, 'success');
        $('paymentForm').reset();
        $('fechaPago').value = hoyISO();
        seleccionarClientePago(clientePago);
    });
}

// ---------------------------------------------------------------- pagos recibidos (liquidación)
function loadRecibidos() {
    run(async () => {
        const desde = $('recDesde').value, hasta = $('recHasta').value, sinCliente = $('recSinCliente').checked;
        recibidosFilas = await fetchAll(() => {
            let q = sb.from('pagos_detalle').select('*');
            if (desde) q = q.gte('fecha_pago', desde);
            if (hasta) q = q.lte('fecha_pago', hasta);
            if (sinCliente) q = q.is('cliente_id', null);
            return q.order('fecha_pago', { ascending: false }).order('id', { ascending: false });
        });
        ordenarPorCodigo(recibidosFilas, 'cliente_id');
        const repoblarUnicos = (id, valores, placeholder) => {
            const v = $(id).value;
            populateDropdown(id, [...new Set(valores.filter(Boolean))].sort(), placeholder);
            $(id).value = v;
        };
        repoblarUnicos('recMetodo', recibidosFilas.map(r => r.metodo_pago), 'Todos');
        repoblarUnicos('recUsuario', recibidosFilas.map(r => r.registrado_por), 'Todos');
        renderRecibidos();
    });
}

function recibidosFiltrados() {
    const m = $('recMetodo').value, u = $('recUsuario').value, c = norm($('recCliente').value);
    return recibidosFilas.filter(r => (!m || r.metodo_pago === m) && (!u || r.registrado_por === u)
        && (!c || coincideCodigo(r.cliente_id, c) || norm(r.cliente).includes(c)));
}

function renderRecibidos() {
    const d = recibidosFiltrados();
    const total = d.reduce((s, r) => s + num(r.valor_pagado), 0);
    const agrupar = campo => {
        const g = {};
        d.forEach(r => { const k = r[campo] || '(sin dato)'; (g[k] ??= { n: 0, t: 0 }); g[k].n++; g[k].t += num(r.valor_pagado); });
        return Object.entries(g).sort((a, b) => b[1].t - a[1].t)
            .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num fw-semibold">${fmtQ(v.t)}</td></tr>`).join('')
            + `<tr class="table-light"><td>Total</td><td class="num">${d.length}</td><td class="num fw-semibold">${fmtQ(total)}</td></tr>`;
    };
    $('recPorMetodo').innerHTML = agrupar('metodo_pago');
    $('recPorUsuario').innerHTML = agrupar('registrado_por');
    $('recibidosTableBody').innerHTML = d.slice(0, 1000).map(r => `<tr>
        <td>${fmtFecha(r.fecha_pago)}</td><td class="num">${esc(cod(r.cliente_id))}</td><td>${esc(r.cliente)}</td><td>${esc(r.metodo_pago)}</td>
        <td class="num">${fmtQ(r.valor_pagado)}</td><td>${esc(r.boleta)}</td><td>${esc(r.envio)}</td><td>${esc(r.registrado_por)}</td>
        <td>${!r.cliente_id && esAdmin() ? `<button type="button" class="btn btn-outline-secondary btn-sm asignar-pago" data-id="${r.id}">Asignar cliente</button>` : ''}</td></tr>`).join('');
    $('recTotal').textContent = fmtQ(total);
    $('recInfo').textContent = `${d.length} pagos` + (d.length > 1000 ? ' (se muestran 1000; el Excel incluye todos)' : '');
}

function exportRecibidos() {
    exportarExcel('Pagos_recibidos', 'Pagos recibidos', recibidosFiltrados().map(r => ({
        'Fecha pago': aFecha(r.fecha_pago), 'Código cliente': cod(r.cliente_id), 'Cliente': r.cliente,
        'Método de pago': r.metodo_pago, 'Valor': num(r.valor_pagado), 'Boleta': r.boleta, 'Envío': r.envio,
        'Registrado por': r.registrado_por, 'Observaciones': r.observaciones,
    })));
}

let pagoPorAsignar = null;
function abrirAsignarCliente(id) {
    pagoPorAsignar = recibidosFilas.find(r => r.id === id);
    $('asignarPagoInfo').textContent = `Pago de ${fmtQ(pagoPorAsignar.valor_pagado)} del ${fmtFecha(pagoPorAsignar.fecha_pago)}` +
        (pagoPorAsignar.envio ? ` · escrito en ENVÍO: "${pagoPorAsignar.envio}"` : '');
    $('asignarCliente').value = pagoPorAsignar.envio || '';
    asignarClienteModal.show();
}

function asignarClienteAPago(c) {
    if (!pagoPorAsignar || !confirm(`¿Asignar el pago de ${fmtQ(pagoPorAsignar.valor_pagado)} a ${c.nombre} (código ${c.id})?`)) return;
    run(async () => {
        ok(await sb.from('pagos').update({ cliente_id: c.id }).eq('id', pagoPorAsignar.id));
        asignarClienteModal.hide();
        showAlert(`Pago asignado a ${c.nombre}`, 'success');
        loadRecibidos();
    });
}

// ---------------------------------------------------------------- histórico
// ---------------------------------------------------------------- mis comisiones (vendedor)
function cargarMisComisiones() {
    run(async () => {
        const hoy = hoyISO(), [y, m] = hoy.split('-').map(Number);
        const desde = new Date(Date.UTC(y, m - 12, 1)).toISOString().slice(0, 10);
        const [vend, filas] = await Promise.all([
            sb.rpc('mi_vendedor').then(ok),
            sb.rpc('mis_comisiones', { p_desde: desde, p_hasta: hoy }).then(ok),
        ]);
        $('misComSinVinculo').classList.toggle('d-none', !!vend);
        $('misComContenido').classList.toggle('d-none', !vend);
        $('misComVendedor').textContent = vend ? `· ${vend}` : '';
        if (!vend) return;
        const lista = filas.map(r => ({ ...r, mes: String(r.mes).slice(0, 10) }));
        const actual = lista.find(r => r.mes === hoy.slice(0, 7) + '-01');
        $('misComMes').textContent = nombreMes(hoy.slice(0, 7) + '-01');
        $('misComActual').textContent = fmtQ(actual?.comision);
        $('misComCumpl').textContent = actual?.cumplimiento != null ? fmtPct(actual.cumplimiento) : '—';
        $('misComCumplSub').textContent = actual
            ? (actual.esquema && actual.esquema !== 'FIJO' && num(actual.meta) === 0 ? `Ventas ${fmtQ(actual.ventas_q)} (meta de grupo)` : `Ventas ${fmtQ(actual.ventas_q)} de una meta de ${fmtQ(actual.meta)}`) : 'Sin ventas este mes';
        const det = actual?.detalle || [];
        $('misComTramo').textContent = det.length > 1 ? det.map(d => fmtPct(d.pct)).join(' + ') : actual?.comision_pct != null ? fmtPct(actual.comision_pct) : '—';
        $('misComTramoSub').innerHTML = det.length > 1
            ? det.map(d => `${esc(d.esquema)}: cumplimiento ${d.cumplimiento != null ? fmtPct(d.cumplimiento) : '—'} → ${fmtQ(d.comision)}`).join('<br>')
            : actual?.esquema ? esc(actual.esquema === 'FIJO' ? 'Comisión fija' : `Esquema ${actual.esquema}`) : '';
        const conDatos = lista.filter(r => num(r.ventas_q) > 0 || num(r.comision) > 0 || r.mes === hoy.slice(0, 7) + '-01');
        $('misComBody').innerHTML = conDatos.map(r => `<tr${r === actual ? ' class="fw-semibold"' : ''}>
            <td>${nombreMes(r.mes)}${r === actual ? ' <span class="badge text-bg-warning">en curso</span>' : ''}</td>
            <td class="num">${fmtQ(r.ventas_q)}</td><td class="num">${num(r.meta) > 0 ? fmtQ(r.meta) : '—'}</td>
            <td class="num">${r.cumplimiento != null ? fmtPct(r.cumplimiento) : '—'}</td><td class="num">${r.comision_pct != null ? fmtPct(r.comision_pct) : '—'}</td>
            <td class="num fw-semibold">${fmtQ(r.comision)}</td></tr>`
            + ((r.detalle || []).length > 1 ? r.detalle.map(d => `<tr class="small text-muted"><td class="ps-4">↳ ${esc(d.esquema)}</td>
                <td class="num">${fmtQ(d.ventas)}</td><td class="num">${num(d.meta) > 0 ? fmtQ(d.meta) : '—'}</td>
                <td class="num">${d.cumplimiento != null ? fmtPct(d.cumplimiento) : '—'}</td><td class="num">${fmtPct(d.pct)}</td><td class="num">${fmtQ(d.comision)}</td></tr>`).join('') : '')).join('')
            || '<tr><td colspan="6" class="text-muted">Todavía no tiene ventas en los últimos 12 meses.</td></tr>';
    });
}

function loadHistoryData() {
    run(async () => {
        const d = await fetchAll(() => sb.from('ventas')
            .select('id,pedido_id,fecha_venta,tienda,vendedor,cliente_id,cliente,tipo,producto,cantidad,valor_unitario,valor_total')
            .order('fecha_venta', { ascending: false })
            .order('id', { ascending: false }));
        fullHistoryData = ordenarPorCodigo(d.filter(r => (r.cliente || r.producto) && r.producto !== 'SALDO INICIAL'), 'cliente_id');
        filterHistory();
    });
}

function renderHistoryTable(d) {
    $('historicoTableBody').innerHTML = d.slice(0, 2000).map(r => `<tr><td>${fmtFecha(r.fecha_venta)}</td><td>${esc(r.pedido_id)}</td><td>${esc(r.tienda)}</td><td>${esc(r.vendedor)}</td><td class="num">${esc(cod(r.cliente_id))}</td><td>${esc(r.cliente)}</td><td>${esc(r.tipo || r.producto)}</td><td class="num">${esc(r.cantidad)}</td><td class="num">${fmtQ(r.valor_unitario)}</td><td class="num">${fmtQ(r.valor_total)}</td></tr>`).join('');
    $('rowCount').textContent = d.length + (d.length > 2000 ? ' (se muestran 2000; el Excel incluye todos)' : '');
}

function historicoFiltrado() {
    const c = norm($('filterCliente').value), t = $('filterTienda').value, tp = $('filterTipo').value, p = $('filterProducto').value;
    return fullHistoryData.filter(r =>
        (!c || coincideCodigo(r.cliente_id, c) || norm(r.cliente).includes(c)) &&
        (!t || r.tienda === t) && (!tp || r.tipo === tp) && (!p || r.producto === p));
}
const filterHistory = () => renderHistoryTable(historicoFiltrado());

function exportHistorico() {
    exportarExcel('Historico_ventas', 'Histórico', historicoFiltrado().map(r => ({
        'Fecha': aFecha(r.fecha_venta), 'Pedido': r.pedido_id, 'Tienda': r.tienda, 'Vendedor': r.vendedor,
        'Código cliente': cod(r.cliente_id), 'Cliente': r.cliente, 'Tipo': r.tipo || r.producto,
        'Cantidad': r.cantidad, 'Valor unitario': r.valor_unitario, 'Valor total': r.valor_total,
    })));
}

// ---------------------------------------------------------------- cartera: filtros comunes (bodega y vendedor)
const filtroCartera = () => ({ bodega: $('carBodega').value, vendedor: veEquipo() ? $('carVendedor').value : '' });
let vendedorDeCliente = {};   // código de cliente -> dueño

// Vendedores que puede elegir: el admin, todos; el supervisor, él y su equipo
function prepararVendedoresCartera() {
    if (!veEquipo()) return;
    const v = $('carVendedor').value;
    const lista = perfiles.filter(p => p.activo && (esAdmin() || p.id === perfil.id || p.supervisor_id === perfil.id));
    $('carVendedor').innerHTML = `<option value="">${esAdmin() ? 'Todos' : 'Todo mi equipo'}</option>`
        + lista.map(p => `<option value="${p.id}">${esc(p.nombre || p.usuario)}${p.id === perfil.id ? ' (yo)' : ''}</option>`).join('');
    $('carVendedor').value = v;
}

function loadCartera() {
    run(async () => {
        const [saldos, detalle] = await Promise.all([
            fetchAll(() => sb.from('cartera_clientes').select('*').order('codigo')),
            fetchAll(() => sb.from('cartera_detalle').select('*').order('fecha_venta', { ascending: false }).order('envio')),
            veEquipo() && !perfiles.length ? cargarPerfiles() : null,
        ]);
        fullSaldosData = saldos;
        fullCarteraDetalleData = detalle;
        vendedorDeCliente = Object.fromEntries(saldos.map(r => [r.codigo, r.vendedor_id]));
        saldos.forEach(r => recordarConsecutivo({ id: r.codigo, consecutivo: r.consecutivo }));
        ordenarPorCodigo(fullSaldosData, 'codigo');
        ordenarPorCodigo(fullCarteraDetalleData, 'cliente_id');
        prepararVendedoresCartera();
        aplicarFiltrosCartera();
    });
}

function aplicarFiltrosCartera() {
    const { bodega, vendedor } = filtroCartera();
    const vend = vendedor ? $('carVendedor').selectedOptions[0].textContent : '';
    $('carFiltroNota').textContent = !bodega && !vendedor ? 'Aplica a Saldos por cliente, Estado de cuenta (búsqueda) y Por envío.'
        : [vend && `Clientes de ${vend}`, bodega && `Saldos de los envíos de ${bodega}`].filter(Boolean).join(' · ');
    filterSaldos();
    filterCarteraDetalle();
}

// ¿El cliente cumple los filtros de cartera? (para la búsqueda del estado de cuenta)
function clienteEnFiltroCartera(c) {
    const { bodega, vendedor } = filtroCartera();
    if (vendedor && c.creado_por !== vendedor) return false;
    if (bodega && fullCarteraDetalleData.length && !fullCarteraDetalleData.some(r => r.cliente_id === c.id && r.tienda === bodega)) return false;
    return true;
}

// ---------------------------------------------------------------- cartera: saldos por cliente
// Con bodega elegida, compras, pagos y saldo son los de los envíos de esa bodega
function saldosFiltrados() {
    const q = norm($('filterSaldos').value), deudores = $('saldosSoloDeudores').checked;
    const { bodega, vendedor } = filtroCartera();
    let base = vendedor ? fullSaldosData.filter(r => r.vendedor_id === vendedor) : fullSaldosData;
    if (bodega) {
        const porCliente = {};
        fullCarteraDetalleData.filter(r => r.tienda === bodega && r.cliente_id != null).forEach(r => {
            const x = porCliente[r.cliente_id] ??= { ventas: 0, pagos: 0, saldo: 0 };
            x.ventas += num(r.valor_venta); x.pagos += num(r.valor_pago); x.saldo += num(r.cartera);
        });
        base = base.filter(r => porCliente[r.codigo]).map(r => ({ ...r,
            total_ventas: porCliente[r.codigo].ventas, total_pagos: porCliente[r.codigo].pagos, saldo: porCliente[r.codigo].saldo }));
    }
    return base.filter(r => (!deudores || num(r.saldo) > 0.005) &&
        (!q || coincideCodigo(r.codigo, q) || [r.nombre, r.dpi, r.nit, veEquipo() ? r.vendedor : ''].some(v => norm(v).includes(q))));
}

function filterSaldos() {
    const d = saldosFiltrados();
    $('saldosTableBody').innerHTML = d.map(r => `<tr data-codigo="${r.codigo}" style="cursor:pointer">
        <td class="num fw-semibold">${cod(r.codigo)}</td><td>${esc(r.nombre)}</td>${veEquipo() ? `<td>${esc(r.vendedor || '—')}</td>` : ''}<td>${esc(r.dpi || r.nit)}</td><td>${esc(r.telefono)}</td>
        <td class="num">${fmtQ(r.total_ventas)}</td><td class="num">${fmtQ(r.total_pagos)}</td>
        <td class="num fw-semibold ${num(r.saldo) < 0 ? 'saldo-negativo' : ''}">${fmtQ(r.saldo)}</td>
        <td>${fmtFecha(r.ultima_venta)}</td><td>${fmtFecha(r.ultimo_pago)}</td></tr>`).join('');
    const sum = k => d.reduce((s, r) => s + num(r[k]), 0);
    $('saldosVentas').textContent = fmtQ(sum('total_ventas'));
    $('saldosPagos').textContent = fmtQ(sum('total_pagos'));
    $('saldosSaldo').textContent = fmtQ(sum('saldo'));
    $('saldosRowCount').textContent = d.length;
}

function exportSaldos() {
    exportarExcel('Saldos_clientes', 'Saldos por cliente', saldosFiltrados().map(r => ({
        'Código cliente': cod(r.codigo), 'Cliente': r.nombre, ...(veEquipo() ? { 'Vendedor': r.vendedor } : {}), 'DPI': r.dpi, 'NIT': r.nit, 'Teléfono': r.telefono,
        'Compras': num(r.total_ventas), 'Pagos': num(r.total_pagos), 'Saldo': num(r.saldo),
        'Última venta': aFecha(r.ultima_venta), 'Último pago': aFecha(r.ultimo_pago),
    })));
}

// ---------------------------------------------------------------- cartera: estado de cuenta
let clienteEstado = null;

function verEstadoCuenta(codigo) {
    new bootstrap.Tab($('pills-estado-tab')).show();
    cargarEstadoCuenta(codigo);
}

function cargarEstadoCuenta(codigo) {
    run(async () => {
        const [c, movs] = await Promise.all([
            sb.from('clientes').select('*').eq('id', codigo).maybeSingle().then(ok),
            fetchAll(() => sb.from('estado_cuenta').select('*').eq('cliente_id', codigo)
                .order('fecha').order('movimiento', { ascending: false }).order('ref_id')),
        ]);
        if (!c) { showAlert('Cliente no encontrado', 'warning'); return; }
        clienteEstado = c;
        let saldo = 0;
        estadoCuentaFilas = movs.map(m => ({ ...m, saldo: saldo += num(m.cargo) - num(m.abono) }));
        recordarConsecutivo(c);
        $('ecCodigo').textContent = cod(c.id);
        $('ecNombre').textContent = c.nombre;
        $('ecSaldo').textContent = fmt(saldo);
        $('ecCliente').value = `${c.id} · ${c.nombre}`;
        $('ecTableBody').innerHTML = estadoCuentaFilas.map(m => `<tr>
            <td>${fmtFecha(m.fecha)}</td><td>${esc(m.movimiento)}</td><td>${esc(m.detalle)}</td><td>${esc(m.metodo_pago)}</td>
            <td class="num">${num(m.cargo) ? fmt(m.cargo) : ''}</td><td class="num">${num(m.abono) ? fmt(m.abono) : ''}</td>
            <td class="num fw-semibold ${m.saldo < 0 ? 'saldo-negativo' : ''}">${fmt(m.saldo)}</td></tr>`).join('')
            || '<tr><td colspan="7" class="text-muted">Sin movimientos</td></tr>';
        $('ecContenido').classList.remove('d-none');
    });
}

function exportEstadoCuenta() {
    if (!clienteEstado) { showAlert('Busque primero un cliente', 'warning'); return; }
    exportarExcel(`Estado_cuenta_${clienteEstado.id}`, 'Estado de cuenta', estadoCuentaFilas.map(m => ({
        'Código cliente': cod(clienteEstado.id), 'Cliente': clienteEstado.nombre, 'Fecha': aFecha(m.fecha),
        'Movimiento': m.movimiento, 'Detalle': m.detalle, 'Método de pago': m.metodo_pago,
        'Cargo': num(m.cargo), 'Abono': num(m.abono), 'Saldo': m.saldo,
    })));
}

// ---------------------------------------------------------------- cartera: por envío

function renderCarteraDetalleTable(d) {
    $('carteraDetalleTableBody').innerHTML = d.map(r => `<tr><td>${fmtFecha(r.fecha_venta)}</td><td>${esc(r.tienda)}</td><td class="num fw-semibold">${esc(cod(r.cliente_id))}</td><td>${esc(r.cliente)}</td>${veEquipo() ? `<td>${esc(r.vendedor || '—')}</td>` : ''}<td>${esc(r.envio)}</td><td class="num">${fmtQ(r.valor_venta)}</td><td class="num">${fmtQ(r.valor_pago)}</td><td class="num ${num(r.cartera) < 0 ? 'saldo-negativo' : ''}">${fmtQ(r.cartera)}</td></tr>`).join('');
    const sum = k => d.reduce((s, r) => s + num(r[k]), 0);
    $('carteraDetalleVenta').textContent = fmtQ(sum('valor_venta'));
    $('carteraDetallePago').textContent = fmtQ(sum('valor_pago'));
    $('carteraDetalleSaldo').textContent = fmtQ(sum('cartera'));
}

function carteraDetalleFiltrada() {
    const { bodega, vendedor } = filtroCartera();
    const c = norm($('filterCarteraDetalleCliente').value), e = norm($('filterCarteraDetalleEnvio').value);
    return fullCarteraDetalleData.filter(r =>
        (!bodega || r.tienda === bodega) && (!vendedor || vendedorDeCliente[r.cliente_id] === vendedor)
        && (!c || coincideCodigo(r.cliente_id, c) || norm(r.cliente).includes(c)) && norm(r.envio).includes(e));
}
const filterCarteraDetalle = () => renderCarteraDetalleTable(carteraDetalleFiltrada());

function exportCarteraDetalle() {
    exportarExcel('Cartera_por_envio', 'Cartera por envío', carteraDetalleFiltrada().map(r => ({
        'Fecha venta': aFecha(r.fecha_venta), 'Tienda': r.tienda, 'Código cliente': cod(r.cliente_id), 'Cliente': r.cliente,
        ...(veEquipo() ? { 'Vendedor': r.vendedor } : {}), 'Envío': r.envio,
        'Valor venta': r.valor_venta, 'Valor pago': r.valor_pago, 'Cartera': r.cartera,
    })));
}

// ---------------------------------------------------------------- inventario: referencias
// Carga el catálogo de referencias y actualiza todas las listas que lo usan
async function cargarReferencias() {
    referencias = ok(await sb.from('productos').select('*').order('orden').order('nombre'));
    dropdownData.productos = referencias.filter(r => r.activo).map(r => r.nombre);
    repoblar('cargaProducto', tiposConInventario(), 'Seleccione Tipo...');
    repoblar('trasladoProducto', tiposConInventario(), 'Seleccione...');
}

function loadReferencias() {
    run(async () => {
        const [, inv] = await Promise.all([cargarReferencias(), sb.from('inventario').select('kp,saldo').then(ok)]);
        const saldos = {};
        inv.forEach(r => saldos[r.kp] = (saldos[r.kp] || 0) + num(r.saldo));
        referencias.forEach(r => r.saldo_total = r.controla_inventario ? saldos[r.nombre.trim().toUpperCase()] ?? 0 : null);
        renderReferencias();
    });
}

function referenciasFiltradas() {
    const q = norm($('filterReferencias').value);
    return referencias.filter(r => !q || [r.nombre, r.codigo, r.tipo].some(v => norm(v).includes(q)));
}

function renderReferencias() {
    const si = v => v ? '<i class="bi bi-check-lg"></i>' : '<span class="text-muted">No</span>';
    $('referenciasTableBody').innerHTML = referenciasFiltradas().map(r => `<tr class="${r.activo ? '' : 'text-muted'}"><td>${esc(r.codigo)}</td><td>${esc(r.nombre)}</td><td>${r.tipo ? esc(r.tipo) : '<span class="badge text-bg-danger">Sin tipo</span>'}</td><td>${esc(r.unidad)}</td><td>${si(r.controla_inventario)}</td><td>${si(r.activo)}</td><td class="num ${num(r.saldo_total) < 0 ? 'saldo-negativo' : ''}">${r.saldo_total == null ? '' : fmt(r.saldo_total)}</td><td><button type="button" class="btn btn-outline-secondary btn-sm edit-ref" data-nombre="${esc(r.nombre)}" title="Editar"><i class="bi bi-pencil"></i></button></td></tr>`).join('');
}

// destino = lista que debe quedar con la referencia nueva seleccionada
let referenciaDestino = null;
function abrirModalReferencia(r = null, destino = null) {
    referenciaDestino = destino;
    $('referenciaForm').reset();
    $('refEditando').value = r ? r.nombre : '';
    $('referenciaModalTitle').textContent = r ? 'Editar Referencia' : 'Nueva Referencia';
    $('refNombre').value = r?.nombre ?? '';
    $('refNombre').readOnly = !!r;  // las ventas guardan el nombre: no se renombra
    $('refCodigo').value = r?.codigo ?? '';
    setSelectValue('refTipo', r?.tipo ?? '');
    $('refUnidad').value = r?.unidad ?? 'GRAMOS';
    $('refControla').checked = r ? r.controla_inventario : true;
    $('refActivo').checked = r ? r.activo : true;
    referenciaModal.show();
}

function guardarReferencia() {
    const editando = $('refEditando').value;
    const d = {
        codigo: $('refCodigo').value.trim().toUpperCase() || null,
        tipo: $('refTipo').value || null,
        unidad: $('refUnidad').value,
        controla_inventario: $('refControla').checked,
        activo: $('refActivo').checked,
    };
    const nombre = $('refNombre').value.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!nombre) { $('refNombre').reportValidity(); return; }
    if (!d.tipo) { $('refTipo').reportValidity(); return; }
    run(async () => {
        if (editando) {
            ok(await sb.from('productos').update(d).eq('nombre', editando));
        } else {
            if (referencias.some(r => norm(r.nombre) === norm(nombre))) throw new Error(`La referencia "${nombre}" ya existe.`);
            const orden = Math.max(0, ...referencias.map(r => r.orden || 0)) + 1;
            ok(await sb.from('productos').insert({ nombre, orden, ...d }));
        }
        referenciaModal.hide();
        await cargarReferencias();
        if (!editando && referenciaDestino) seleccionarCreado(referenciaDestino, nombre);
        if ($('pills-referencias-tab').classList.contains('active')) loadReferencias();
        showAlert(editando ? 'Referencia actualizada' : `Referencia "${nombre}" creada`, 'success');
    });
}

function exportReferencias() {
    exportarExcel('Referencias', 'Referencias', referenciasFiltradas().map(r => ({
        'Código': r.codigo, 'Referencia': r.nombre, 'Tipo': r.tipo, 'Unidad': r.unidad,
        'Controla inventario': r.controla_inventario ? 'SI' : 'NO', 'Activa': r.activo ? 'SI' : 'NO', 'Saldo total': r.saldo_total,
    })));
}

// ---------------------------------------------------------------- inventario: cargas
function loadCargas() {
    run(async () => {
        cargasFilas = await fetchAll(() => sb.from('ingresos_inventario').select('*').order('fecha', { ascending: false }).order('id', { ascending: false }));
        const repoblarUnicos = (id, valores, placeholder) => {
            const v = $(id).value;
            populateDropdown(id, [...new Set(valores.filter(Boolean))].sort(), placeholder);
            $(id).value = v;
        };
        repoblarUnicos('filterCargasTienda', cargasFilas.map(r => r.tienda), 'Todas las tiendas');
        repoblarUnicos('filterCargasProducto', cargasFilas.map(r => r.producto), 'Todos los tipos');
        renderCargas();
        mostrarSaldoCarga();
    });
}

function renderCargas() {
    const t = $('filterCargasTienda').value, p = $('filterCargasProducto').value;
    const d = cargasFilas.filter(r => (!t || r.tienda === t) && (!p || r.producto === p));
    $('cargasTableBody').innerHTML = d.slice(0, 500).map(r => `<tr><td>${fmtFecha(r.fecha)}</td><td>${esc(r.tienda)}</td><td>${esc(r.producto)}</td><td>${esc(r.concepto)}</td><td class="num">${r.entrada ? fmt(r.entrada) : ''}</td><td class="num">${r.salida ? fmt(r.salida) : ''}</td><td>${esc(r.observaciones)}</td><td class="text-end">${r.traslado_id
        ? `<span class="badge text-bg-light" title="Se anula desde Inventario > Traslados">Traslado #${r.traslado_id}</span>`
        : `<button type="button" class="btn btn-outline-danger btn-sm delete-carga" data-id="${r.id}"><i class="bi bi-trash"></i> Eliminar</button>`}</td></tr>`).join('')
        || '<tr><td colspan="8" class="text-muted">Sin cargas</td></tr>';
}

async function mostrarSaldoCarga() {
    const t = $('cargaTienda').value, p = $('cargaProducto').value;
    const ref = referencias.find(r => r.nombre === p);
    $('cargaUnidad').textContent = ref ? `(${ref.unidad.toLowerCase()})` : '';
    if (!t || !p) { $('cargaSaldoActual').textContent = ''; return; }
    const { data } = await sb.from('inventario').select('saldo').eq('kt', t.trim().toUpperCase()).eq('kp', p.trim().toUpperCase());
    $('cargaSaldoActual').textContent = data?.length
        ? `Saldo actual en ${t}: ${fmt(data[0].saldo)}`
        : `${t} no tiene inventario cargado de ${p}: esta será la carga inicial (las ventas se descuentan desde su fecha).`;
}

function handleCargaSubmit(e) {
    e.preventDefault();
    const cant = num($('cargaCantidad').value);
    const esEntrada = $('cargaMovimiento').value === 'entrada';
    const d = {
        fecha: $('cargaFecha').value,
        tienda: $('cargaTienda').value,
        producto: $('cargaProducto').value,
        concepto: $('cargaConcepto').value.trim().toUpperCase(),
        entrada: esEntrada ? cant : null,
        salida: esEntrada ? null : cant,
        observaciones: $('cargaObservaciones').value.trim() || null,
    };
    run(async () => {
        ok(await sb.from('ingresos_inventario').insert(d));
        showAlert(`${esEntrada ? 'Entrada' : 'Salida'} de ${fmt(cant)} de ${d.producto} en ${d.tienda} registrada`, 'success');
        $('cargaCantidad').value = '';
        $('cargaObservaciones').value = '';
        loadCargas();
    });
}

function eliminarCarga(id) {
    const r = cargasFilas.find(x => x.id === id);
    if (!confirm(`¿Eliminar la carga de ${fmt(r?.entrada || r?.salida)} de ${r?.producto} en ${r?.tienda} (${fmtFecha(r?.fecha)})?`)) return;
    run(async () => {
        ok(await sb.from('ingresos_inventario').delete().eq('id', id));
        showAlert('Carga eliminada; el saldo del inventario se recalculó', 'success');
        loadCargas();
    });
}

// ---------------------------------------------------------------- inventario: carga masiva desde Excel
const COLS_CARGA = ['Fecha', 'Tienda / Bodega', 'Tipo (material)', 'Movimiento', 'Cantidad', 'Concepto', 'Observaciones'];
const MAX_FILAS_CARGA = 5000;
let filasMasivas = [];

function descargarPlantillaCarga() {
    const fija = !esAdmin() && perfil?.tienda;
    const tiendas = fija ? [perfil.tienda] : maestros.tiendas.filter(x => x.activo !== false).map(x => x.nombre);
    const refs = referencias.filter(r => r.activo && r.controla_inventario);
    const wb = XLSX.utils.book_new();
    const carga = XLSX.utils.aoa_to_sheet([COLS_CARGA]);
    carga['!cols'] = [12, 24, 30, 12, 10, 16, 30].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, carga, 'Carga');
    const filas = Math.max(tiendas.length, refs.length, 5);
    const conceptos = ['INV INICIAL', 'COMPRA', 'AJUSTE', 'DEVOLUCION'];
    const listas = XLSX.utils.aoa_to_sheet([['Tiendas / Bodegas', 'Tipos (material)', 'Unidad', 'Movimiento', 'Conceptos sugeridos'],
        ...Array.from({ length: filas }, (_, i) => [tiendas[i] ?? '', refs[i]?.nombre ?? '', refs[i] ? (refs[i].unidad || '').toLowerCase() : '',
            ['ENTRADA', 'SALIDA'][i] ?? '', conceptos[i] ?? ''])]);
    listas['!cols'] = [24, 30, 10, 12, 20].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, listas, 'Listas');
    const ayuda = XLSX.utils.aoa_to_sheet([
        ['Cómo llenar la hoja "Carga" (una fila por movimiento)'], [],
        ['Fecha', 'Fecha del movimiento (dd/mm/aaaa). Si se deja vacía se usa la fecha de hoy.'],
        ['Tienda / Bodega', fija ? `Se carga siempre en su bodega (${fija}); puede dejarla vacía.` : 'Igual que en la hoja "Listas".'],
        ['Tipo (material)', 'Igual que en la hoja "Listas". Si no existe, créelo antes en Maestros > Tipos.'],
        ['Movimiento', 'ENTRADA (suma) o SALIDA (resta). Si se deja vacío se toma ENTRADA.'],
        ['Cantidad', 'Mayor que cero, en la unidad del tipo (gramos o unidades).'],
        ['Concepto', 'Ej. INV INICIAL, COMPRA, AJUSTE. Si se deja vacío se usa CARGA MASIVA.'],
        ['Observaciones', 'Opcional.'], [],
        ['Si alguna fila tiene un error no se carga nada: corrija el archivo y súbalo de nuevo.'],
    ]);
    ayuda['!cols'] = [{ wch: 18 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ayuda, 'Instrucciones');
    XLSX.writeFile(wb, 'Plantilla_carga_inventario.xlsx');
}

// "1,234.5" o "1234,5" -> número (la coma es decimal solo si no hay punto y no separa miles)
function numeroDeTexto(v) {
    const t = String(v ?? '').replace(/\s/g, '');
    if (!t) return NaN;
    if (t.includes('.') || /^\d{1,3}(,\d{3})+$/.test(t)) return Number(t.replace(/,/g, ''));
    return Number(t.replace(',', '.'));
}

// Fecha de Excel (número de serie, texto dd/mm/aaaa o aaaa-mm-dd) -> 'aaaa-mm-dd'
function fechaDeExcel(v) {
    if (v === '' || v === null || v === undefined) return hoyISO();
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    const t = String(v).trim();
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return valida(m[1], m[2], m[3]);
    m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
    if (m) return valida(m[3].length === 2 ? '20' + m[3] : m[3], m[2], m[1]);
    return null;
    function valida(y, mo, d) {
        const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const f = new Date(iso + 'T00:00:00Z');
        return !isNaN(f) && f.toISOString().slice(0, 10) === iso ? iso : null;
    }
}

function leerArchivoCarga(archivo) {
    run(async () => {
        const wb = XLSX.read(await archivo.arrayBuffer());
        const hoja = wb.Sheets.Carga || wb.Sheets[wb.SheetNames[0]];
        const crudas = XLSX.utils.sheet_to_json(hoja, { defval: '', raw: true });
        // Columnas por nombre (sin importar mayúsculas, tildes ni el orden)
        const clave = k => norm(k).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const col = (r, ...prefijos) => { const k = Object.keys(r).find(k => prefijos.some(p => clave(k).startsWith(p))); return k ? r[k] : ''; };
        const fija = !esAdmin() && perfil?.tienda;
        const tiendas = maestros.tiendas.filter(x => x.activo !== false);
        const refs = referencias.filter(r => r.activo && r.controla_inventario);
        filasMasivas = [];
        crudas.forEach((r, i) => {
            const valores = Object.values(r).map(v => String(v).trim());
            if (!valores.some(Boolean)) return;   // fila vacía
            const errores = [];
            const fecha = fechaDeExcel(col(r, 'fecha'));
            if (!fecha) errores.push('Fecha no válida');
            const tTexto = String(col(r, 'tienda', 'bodega')).trim();
            let tienda = tiendas.find(t => norm(t.nombre) === norm(tTexto))?.nombre;
            if (fija) {
                if (tTexto && norm(tTexto) !== norm(fija)) errores.push(`Solo puede cargar en su bodega (${fija})`);
                tienda = fija;
            } else if (!tTexto) errores.push('Falta la tienda / bodega');
            else if (!tienda) errores.push(`Tienda "${tTexto}" no existe o está inactiva`);
            const pTexto = String(col(r, 'tipo', 'referencia', 'producto', 'material')).trim();
            const ref = refs.find(x => norm(x.nombre) === norm(pTexto));
            if (!pTexto) errores.push('Falta el tipo (material)');
            else if (!ref) errores.push(`Tipo "${pTexto}" no existe, está inactivo o no lleva inventario`);
            const mov = norm(col(r, 'movimiento', 'tipo de movimiento'));
            const esEntrada = !mov || ['entrada', 'e', '+', 'ingreso'].includes(mov);
            if (!esEntrada && !['salida', 's', '-', 'ajuste', 'salida / ajuste'].includes(mov)) errores.push('Movimiento debe ser ENTRADA o SALIDA');
            const cTexto = col(r, 'cantidad');
            const cant = typeof cTexto === 'number' ? cTexto : numeroDeTexto(cTexto);
            if (!(cant > 0)) errores.push('Cantidad debe ser mayor que cero');
            filasMasivas.push({
                fila: (r.__rowNum__ ?? i + 1) + 1, errores,
                d: {
                    fecha, tienda: tienda || tTexto, producto: ref?.nombre || pTexto,
                    concepto: String(col(r, 'concepto')).trim().toUpperCase() || 'CARGA MASIVA',
                    entrada: esEntrada ? Math.round(cant * 100) / 100 : null,
                    salida: esEntrada ? null : Math.round(cant * 100) / 100,
                    observaciones: String(col(r, 'observ')).trim() || null,
                },
                unidad: (ref?.unidad || '').toLowerCase(),
            });
        });
        if (!filasMasivas.length) { limpiarCargaMasiva(); showAlert('El archivo no tiene filas para cargar (revise que use la hoja "Carga" de la plantilla).', 'warning'); return; }
        if (filasMasivas.length > MAX_FILAS_CARGA) { limpiarCargaMasiva(); showAlert(`El archivo tiene ${filasMasivas.length} filas; el máximo por carga es ${MAX_FILAS_CARGA}. Divídalo en varios archivos.`, 'warning'); return; }
        renderCargaMasiva();
    });
}

function renderCargaMasiva() {
    const malas = filasMasivas.filter(x => x.errores.length).length;
    // Primero las filas con error, para corregirlas
    const orden = [...filasMasivas].sort((a, b) => (b.errores.length > 0) - (a.errores.length > 0) || a.fila - b.fila);
    $('masivaBody').innerHTML = orden.map(({ fila, errores, d, unidad }) => `<tr class="${errores.length ? 'con-error' : ''}">
        <td class="num">${fila}</td><td>${d.fecha ? fmtFecha(d.fecha) : ''}</td><td>${esc(d.tienda)}</td><td>${esc(d.producto)}</td>
        <td>${d.entrada !== null ? 'Entrada' : 'Salida'}</td><td class="num">${fmt(d.entrada ?? d.salida)} <span class="text-muted small">${esc(unidad)}</span></td>
        <td>${esc(d.concepto)}</td><td>${esc(d.observaciones)}</td>
        <td>${errores.length ? `<span class="revision-error">${errores.map(esc).join('<br>')}</span>` : '<span class="revision-ok"><i class="bi bi-check2"></i> Lista</span>'}</td></tr>`).join('');
    const total = (campo) => filasMasivas.filter(x => !x.errores.length).reduce((s, x) => s + num(x.d[campo]), 0);
    $('masivaResumen').innerHTML = malas
        ? `<span class="revision-error fw-semibold">${malas} de ${filasMasivas.length} fila(s) con error.</span> Corrija el archivo y súbalo de nuevo; no se cargará nada mientras haya errores.`
        : `<strong>${filasMasivas.length}</strong> fila(s) listas · entradas ${fmt(total('entrada'))} · salidas ${fmt(total('salida'))}`;
    $('masivaConfirmar').disabled = malas > 0;
    $('masivaConfirmar').innerHTML = `<i class="bi bi-upload me-1"></i> Cargar ${filasMasivas.length} fila(s)`;
    $('masivaVista').classList.remove('d-none');
}

function limpiarCargaMasiva() {
    filasMasivas = [];
    $('archivoCarga').value = '';
    $('masivaVista').classList.add('d-none');
    $('masivaBody').innerHTML = '';
}

function confirmarCargaMasiva() {
    if (!filasMasivas.length || filasMasivas.some(x => x.errores.length)) return;
    if (!confirm(`¿Cargar ${filasMasivas.length} movimiento(s) de inventario?`)) return;
    run(async () => {
        // Un solo insert: se guardan todas las filas o ninguna
        ok(await sb.from('ingresos_inventario').insert(filasMasivas.map(x => x.d)));
        showAlert(`${filasMasivas.length} movimiento(s) de inventario cargados`, 'success');
        limpiarCargaMasiva();
        loadCargas();
    });
}

// ---------------------------------------------------------------- inventario: saldos
let inventarioAbierto = false;
function loadInventoryData() {
    run(async () => {
        fullInventoryData = ok(await sb.from('inventario').select('*').order('tienda').order('producto'));
        // Los filtros se arman con lo que existe en el inventario
        const keep = id => $(id).value;
        let [t, p] = [keep('filterInventarioTienda'), keep('filterInventarioProducto')];
        // La primera vez muestra la tienda del usuario
        if (!inventarioAbierto) { inventarioAbierto = true; t = t || perfil?.tienda || ''; }
        // Incluye la tienda del usuario aunque todavía no tenga inventario cargado
        populateDropdown('filterInventarioTienda', [...new Set([...fullInventoryData.map(r => r.tienda), perfil?.tienda].filter(Boolean))], 'Todas');
        populateDropdown('filterInventarioProducto', [...new Set(fullInventoryData.map(r => r.producto))].sort(), 'Todas');
        $('filterInventarioTienda').value = t;
        $('filterInventarioProducto').value = p;
        filterInventory();
    });
}

// Filas según la vista elegida: por tienda y referencia, o total por referencia
function inventarioFiltrado() {
    const t = $('filterInventarioTienda').value, p = $('filterInventarioProducto').value;
    const d = fullInventoryData.filter(r => (!t || r.tienda === t) && (!p || r.producto === p));
    if ($('inventarioVista').value === 'tienda') return d;
    const g = {};
    d.forEach(r => {
        const x = g[r.kp] ??= { tienda: t || 'Todas', producto: r.producto, unidad: r.unidad, entradas: 0, salidas: 0, saldo: 0 };
        x.entradas += num(r.entradas); x.salidas += num(r.salidas); x.saldo += num(r.saldo);
    });
    return Object.values(g).sort((a, b) => a.producto.localeCompare(b.producto));
}

function filterInventory() {
    const d = inventarioFiltrado();
    const porTienda = $('inventarioVista').value === 'tienda';
    $('inventarioTableBody').innerHTML = d.map(r => `<tr ${porTienda ? `data-tienda="${esc(r.tienda)}" data-producto="${esc(r.producto)}" style="cursor:pointer"` : ''}><td>${esc(r.tienda)}</td><td>${esc(r.producto)}</td><td>${esc((r.unidad || '').toLowerCase())}</td><td class="num">${fmt(r.entradas)}</td><td class="num">${fmt(r.salidas)}</td><td class="num ${num(r.saldo) < 0 ? 'saldo-negativo' : ''}">${fmt(r.saldo)}</td></tr>`).join('');
    const sum = k => d.reduce((s, r) => s + num(r[k]), 0);
    $('inventarioEntradas').textContent = fmt(sum('entradas'));
    $('inventarioSalidas').textContent = fmt(sum('salidas'));
    $('inventarioSaldo').textContent = fmt(sum('saldo'));
    $('inventarioRowCount').textContent = d.length;
}

function exportInventario() {
    exportarExcel('Inventario', 'Inventario', inventarioFiltrado().map(r => ({
        'Tienda': r.tienda, 'Tipo': r.producto, 'Unidad': r.unidad,
        'Entradas': num(r.entradas), 'Salidas': num(r.salidas), 'Saldo': num(r.saldo),
    })));
}

// ---------------------------------------------------------------- inventario: movimientos (kardex)
function verMovimientos(tienda, producto) {
    llenarFiltrosMovimientos(tienda, producto);
    const tab = $('pills-movimientos-tab');
    if (tab.classList.contains('active')) loadMovimientos();
    else new bootstrap.Tab(tab).show();  // el evento shown dispara loadMovimientos
}

function llenarFiltrosMovimientos(tienda, producto) {
    const t = tienda ?? $('movTienda').value, p = producto ?? $('movProducto').value;
    populateDropdown('movTienda', [...new Set(fullInventoryData.map(r => r.tienda))], 'Seleccione Tienda...');
    populateDropdown('movProducto', [...new Set(fullInventoryData.filter(r => !t || r.tienda === t).map(r => r.producto))].sort(), 'Seleccione Tipo...');
    $('movTienda').value = t;
    $('movProducto').value = p;
}

function loadMovimientos() {
    run(async () => {
        if (!fullInventoryData.length) fullInventoryData = ok(await sb.from('inventario').select('*').order('tienda').order('producto'));
        llenarFiltrosMovimientos();
        const t = $('movTienda').value, p = $('movProducto').value;
        if (!t || !p) {
            movimientosFilas = [];
            $('movimientosTableBody').innerHTML = '';
            $('movimientosInfo').textContent = 'Seleccione tienda y tipo.';
            return;
        }
        const d = await fetchAll(() => sb.from('inventario_movimientos').select('*')
            .eq('tienda', t).eq('producto', p).order('fecha').order('origen').order('origen_id'));
        let saldo = 0;
        movimientosFilas = d.map(r => ({ ...r, saldo: saldo += num(r.entrada) - num(r.salida) }));
        $('movimientosTableBody').innerHTML = movimientosFilas.map(r => `<tr><td>${fmtFecha(r.fecha)}</td><td>${esc(r.origen)}</td><td>${esc(r.detalle)}</td><td class="num">${num(r.entrada) ? fmt(r.entrada) : ''}</td><td class="num">${num(r.salida) ? fmt(r.salida) : ''}</td><td class="num ${r.saldo < 0 ? 'saldo-negativo' : ''}">${fmt(r.saldo)}</td></tr>`).join('');
        const inv = fullInventoryData.find(r => r.tienda === t && r.producto === p);
        $('movimientosInfo').textContent = `${d.length} movimientos · Ventas descontadas desde ${fmtFecha(inv?.fecha_inicio)} · Saldo final ${fmt(saldo)}`;
    });
}

function exportMovimientos() {
    exportarExcel(`Movimientos_${$('movProducto').value}`, 'Movimientos', movimientosFilas.map(r => ({
        'Tienda': r.tienda, 'Tipo': r.producto, 'Fecha': aFecha(r.fecha), 'Origen': r.origen, 'Detalle': r.detalle,
        'Entrada': num(r.entrada), 'Salida': num(r.salida), 'Saldo': r.saldo,
    })));
}

// ---------------------------------------------------------------- clientes (listado)
function loadClientesData() {
    run(async () => {
        const [d] = await Promise.all([
            fetchAll(() => sb.from('clientes').select('*').order('id')),
            veEquipo() ? cargarPerfiles() : null,
        ]);
        d.forEach(recordarConsecutivo);
        fullClientesData = ordenarPorCodigo(d, 'id');
        filterClientes();
    });
}

function clientesFiltrados() {
    const q = norm($('filterClientes').value), tipo = $('filterClientesTipo').value;
    return fullClientesData.filter(c => (!tipo || c.tipo_cliente === tipo) &&
        (!q || coincideCodigo(c.id, q) || [c.nombre, c.dpi, c.nit, c.telefono, c.telefono2, c.correo].some(v => norm(v).includes(q))));
}

function filterClientes() {
    const d = clientesFiltrados();
    const admin = veEquipo();
    $('clientesTableBody').innerHTML = d.slice(0, 1500).map(c => `<tr>
        <td class="num fw-semibold">${esc(cod(c.id))}</td><td>${esc(c.nombre)}</td>
        <td>${c.tipo_cliente === 'MAYORISTA' ? '<span class="badge text-bg-warning">Mayorista</span>' : '<span class="badge text-bg-light">Minorista</span>'}</td>
        <td>${esc(c.dpi)}</td><td>${esc(c.nit)}</td>
        <td>${esc([c.telefono, c.telefono2].filter(Boolean).join(' / '))}</td><td>${esc(c.correo)}</td><td>${esc(c.direccion)}</td>
        <td>${esc(c.departamento)}</td>${admin ? `<td>${c.creado_por ? `${esc(nombreUsuario(c.creado_por))} <span class="text-muted">#${c.consecutivo ?? ''}</span>` : '<span class="text-muted">—</span>'}</td>` : ''}
        <td><button type="button" class="btn btn-outline-secondary btn-sm edit-client" data-id="${c.id}" title="Editar"><i class="bi bi-pencil"></i></button></td></tr>`).join('');
    $('clientesRowCount').textContent = d.length + (d.length > 1500 ? ' (se muestran 1500; use el buscador)' : '');
}

function exportClientes() {
    exportarExcel('Clientes', 'Clientes', clientesFiltrados().map(c => ({
        'Código cliente': cod(c.id), ...(veEquipo() ? { 'Consecutivo del vendedor': c.consecutivo } : {}),
        'Tipo': c.tipo_cliente === 'MAYORISTA' ? 'Mayorista' : 'Minorista',
        'Nombre y apellido': c.nombre, 'DPI': c.dpi, 'NIT': c.nit, 'NIT2': c.nit2,
        'Teléfono': c.telefono, 'Otro teléfono': c.telefono2, 'Correo': c.correo, 'Dirección': c.direccion,
        'Departamento': c.departamento, 'Fecha de nacimiento': aFecha(c.fecha_nacimiento),
        'Referencia anterior': c.codigo_cliente, ...(veEquipo() ? { 'Responsable': nombreUsuario(c.creado_por) } : {}),
    })));
}

// ---------------------------------------------------------------- usuarios (administradores)
function loadUsuarios() {
    run(async () => {
        const [, clientes, uso] = await Promise.all([
            cargarPerfiles(),
            fetchAll(() => sb.from('clientes').select('creado_por')),
            sb.rpc('uso_rangos_clientes').then(({ data }) => data || []),
        ]);
        const usoRango = Object.fromEntries(uso.map(u => [u.perfil_id, u]));
        // Propone el siguiente bloque libre de 1,000 códigos: 1001-2000, 2001-3000...
        if (!$('usrRangoDesde').value && !$('usrRangoHasta').value) {
            const ultimo = Math.max(1000, ...perfiles.map(p => p.rango_hasta || 0));
            const desde = Math.ceil(ultimo / 1000) * 1000 + 1;
            $('usrRangoDesde').value = desde; $('usrRangoHasta').value = desde + 999;
        }
        const porUsuario = {};
        clientes.forEach(c => { if (c.creado_por) porUsuario[c.creado_por] = (porUsuario[c.creado_por] || 0) + 1; });
        $('usuariosTableBody').innerHTML = perfiles.map(p => {
            const yo = p.id === perfil.id;
            const u = usoRango[p.id];
            return `<tr class="${p.activo ? '' : 'text-muted'}" data-id="${p.id}">
                <td>${esc(p.nombre)}${yo ? ' <span class="badge text-bg-light">usted</span>' : ''}</td>
                <td class="fw-semibold">${esc(p.usuario || aUsuario(p.email))}</td>
                <td>${ROLES[p.rol] || 'Vendedor'}${p.supervisor_id ? `<div class="small text-muted">a cargo de ${esc(nombreUsuario(p.supervisor_id))}</div>` : ''}</td>
                <td><select class="form-select form-select-sm usr-tienda" data-id="${p.id}" aria-label="Tienda">
                    <option value="">(sin tienda)</option>
                    ${[...new Set([...maestros.tiendas.filter(x => x.activo !== false).map(x => x.nombre), p.tienda].filter(Boolean))]
                        .map(n => `<option value="${esc(n)}" ${n === p.tienda ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></td>
                <td><select class="form-select form-select-sm usr-vendedor" data-id="${p.id}" aria-label="Vendedor de Maestros">
                    ${(() => { const auto = maestros.vendedores.find(v => norm(v.nombre) === norm(p.nombre));
                        return `<option value="">${auto ? `(automático: ${esc(auto.nombre)})` : '(sin vincular)'}</option>`
                            + maestros.vendedores.map(v => `<option value="${esc(v.nombre)}" ${v.nombre === p.vendedor ? 'selected' : ''}>${esc(v.nombre)}</option>`).join(''); })()}</select></td>
                <td style="min-width: 210px"><div class="input-group input-group-sm">
                    <input type="number" class="form-control usr-rango usr-desde" value="${p.rango_desde ?? ''}" min="1" placeholder="desde" aria-label="Desde">
                    <span class="input-group-text">–</span>
                    <input type="number" class="form-control usr-rango usr-hasta" value="${p.rango_hasta ?? ''}" min="1" placeholder="hasta" aria-label="Hasta"></div>
                    <div class="small text-muted">${p.rango_desde == null ? 'Numeración general'
                        : u ? `${u.usados} usados · ${u.proximo == null ? '<span class="text-danger">rango lleno</span>' : `próximo ${u.proximo}`}` : ''}</div></td>
                <td class="text-center"><div class="form-check form-switch d-inline-block m-0"><input class="form-check-input usr-activo" type="checkbox" role="switch" data-id="${p.id}" ${p.activo ? 'checked' : ''} ${yo ? 'disabled' : ''} aria-label="Activo"></div></td>
                <td class="num">${porUsuario[p.id] || 0}</td>
                <td class="text-end"><button type="button" class="btn btn-outline-secondary btn-sm usr-password" data-id="${p.id}" data-nombre="${esc(p.nombre || p.usuario)}"><i class="bi bi-key"></i> Contraseña</button></td></tr>`;
        }).join('');
    });
}

function actualizarUsuario(el, cambio) {
    run(async () => {
        const r = ok(await sb.from('perfiles').update(cambio).eq('id', el.dataset.id).select());
        if (!r.length) throw new Error('No se pudo actualizar el usuario');
        if ('activo' in cambio) showAlert(cambio.activo ? 'Usuario activado' : 'Usuario desactivado: ya no puede entrar', 'success');
        else if ('vendedor' in cambio) showAlert(cambio.vendedor ? `Usuario vinculado al vendedor ${cambio.vendedor}` : 'Vínculo con vendedor: automático por nombre', 'success');
        else showAlert(cambio.tienda ? `Usuario vinculado a ${cambio.tienda}` : 'Usuario sin tienda asignada', 'success');
        // Si el admin cambia su propia tienda, se aplica de inmediato
        if (r[0].id === perfil.id) { perfil = { ...perfil, ...r[0] }; mostrarTiendaUsuario(); aplicarTiendaUsuario(); }
        loadUsuarios();
    });
}

function guardarRangoUsuario(tr) {
    const desde = tr.querySelector('.usr-desde').value, hasta = tr.querySelector('.usr-hasta').value;
    if (!!desde !== !!hasta) return;   // espera a que estén los dos (o ninguno)
    const cambio = { rango_desde: desde ? Number(desde) : null, rango_hasta: hasta ? Number(hasta) : null };
    run(async () => {
        try {
            ok(await sb.from('perfiles').update(cambio).eq('id', tr.dataset.id));
        } catch (err) { loadUsuarios(); throw err; }   // vuelve a mostrar el rango que quedó guardado
        showAlert(desde ? `Rango de códigos ${desde} a ${hasta} asignado` : 'Usuario con numeración general', 'success');
        loadUsuarios();
    });
}

function agregarUsuario(e) {
    e.preventDefault();
    const usuario = $('usrUsuario').value.trim().toLowerCase();
    if (!!$('usrRangoDesde').value !== !!$('usrRangoHasta').value) {
        showAlert('Para el rango de códigos indique "del" y "al", o deje ambos vacíos.', 'warning');
        return;
    }
    run(async () => {
        const tienda = $('usrTienda').value || null;
        const nuevo = unico(ok(await sb.rpc('admin_crear_usuario', {
            p_usuario: usuario, p_nombre: $('usrNombre').value.trim(),
            p_password: $('usrPassword').value, p_rol: 'vendedor',
        })));
        const desde = $('usrRangoDesde').value, hasta = $('usrRangoHasta').value;
        const extra = { ...(tienda ? { tienda } : {}), ...(desde && hasta ? { rango_desde: Number(desde), rango_hasta: Number(hasta) } : {}) };
        if (Object.keys(extra).length) {
            const { error } = await sb.from('perfiles').update(extra).eq('id', nuevo.id);
            if (error) { loadUsuarios(); throw new Error(`Usuario creado, pero no se pudo guardar su tienda o rango: ${error.message}`); }
        }
        $('usuarioForm').reset();
        showAlert(`Vendedor creado${tienda ? ` en ${tienda}` : ''}. Entra con el usuario "${usuario}" y la contraseña que le asignó.`, 'success');
        loadUsuarios();
    });
}

// ---------------------------------------------------------------- jerarquías (supervisores y sus vendedores)
const ROLES = { admin: 'Administrador', supervisor: 'Supervisor', vendedor: 'Vendedor' };
const etiquetaUsuario = p => `${p.nombre || p.usuario}${p.usuario ? ` (${p.usuario})` : ''}`;

function registrarJerarquias() {
    $('jerarquias-tab').addEventListener('shown.bs.tab', () => run(async () => { await cargarPerfiles(); renderJerarquias(); }));
    $('supervisorForm').addEventListener('submit', crearSupervisor);
    $('jerConvertirBoton').addEventListener('click', () => {
        const p = perfiles.find(x => x.id === $('jerConvertir').value);
        if (!p) return;
        if (!confirm(`¿Convertir a ${etiquetaUsuario(p)} en supervisor?`)) return;
        cambiarPerfil(p.id, { rol: 'supervisor', supervisor_id: null }, `${p.nombre || p.usuario} ahora es supervisor`);
    });
    $('jerarquias').addEventListener('click', e => {
        const b = e.target.closest('[data-jer]');
        if (!b) return;
        const { jer, id, sup } = b.dataset;
        const p = perfiles.find(x => x.id === id), s = perfiles.find(x => x.id === sup);
        if (jer === 'asignar') {
            const vid = b.closest('.input-group').querySelector('select').value;
            const v = perfiles.find(x => x.id === vid);
            if (!v) return;
            cambiarPerfil(vid, { supervisor_id: sup }, `${v.nombre || v.usuario} quedó a cargo de ${s.nombre || s.usuario}`);
        }
        if (jer === 'quitar') cambiarPerfil(id, { supervisor_id: null }, `${p.nombre || p.usuario} ya no está a cargo de ${s.nombre || s.usuario}`);
        if (jer === 'degradar' && confirm(`¿Quitar el rol de supervisor a ${etiquetaUsuario(p)}? Vuelve a ser vendedor y sus vendedores quedan sin supervisor.`))
            cambiarPerfil(id, { rol: 'vendedor' }, `${p.nombre || p.usuario} volvió a ser vendedor`);
    });
}

function cambiarPerfil(id, datos, mensaje) {
    run(async () => {
        ok(await sb.from('perfiles').update(datos).eq('id', id));
        await cargarPerfiles();
        renderJerarquias();
        showAlert(mensaje, 'success');
    });
}

function crearSupervisor(e) {
    e.preventDefault();
    const usuario = $('supUsuario').value.trim().toLowerCase();
    run(async () => {
        ok(await sb.rpc('admin_crear_usuario', {
            p_usuario: usuario, p_nombre: $('supNombre').value.trim(), p_password: $('supPassword').value, p_rol: 'supervisor',
        }));
        $('supervisorForm').reset();
        await cargarPerfiles();
        renderJerarquias();
        showAlert(`Supervisor creado. Entra con el usuario "${usuario}" y la contraseña que le asignó. Ahora asígnele sus vendedores.`, 'success');
    });
}

function renderJerarquias() {
    const activos = perfiles.filter(p => p.activo);
    const supervisores = activos.filter(p => p.rol === 'supervisor');
    const vendedores = activos.filter(p => p.rol === 'vendedor');
    const nombre = id => { const p = perfiles.find(x => x.id === id); return p ? (p.nombre || p.usuario) : ''; };
    const detalle = v => [v.usuario, v.tienda].filter(Boolean).map(esc).join(' · ');
    populateDropdown('jerConvertir', [], 'Seleccione un vendedor...');
    $('jerConvertir').innerHTML += vendedores.map(v => `<option value="${v.id}">${esc(etiquetaUsuario(v))}</option>`).join('');
    $('jerSupervisores').innerHTML = supervisores.map(s => {
        const equipo = vendedores.filter(v => v.supervisor_id === s.id);
        const libres = vendedores.filter(v => v.supervisor_id !== s.id);
        return `<div class="card mb-3">
          <div class="card-header card-header-custom d-flex justify-content-between align-items-center flex-wrap gap-2">
            <span><i class="bi bi-diagram-3 me-2"></i>${esc(s.nombre || s.usuario)} <small class="text-muted ms-1">${esc(s.usuario || '')}</small></span>
            <span class="small">${equipo.length} vendedor(es) a cargo</span></div>
          <div class="card-body">
            <ul class="list-group mb-3">${equipo.map(v => `<li class="list-group-item d-flex justify-content-between align-items-center gap-2">
                <span><strong>${esc(v.nombre || v.usuario)}</strong> <small class="text-muted ms-1">${detalle(v)}</small></span>
                <button type="button" class="btn btn-outline-secondary btn-sm" data-jer="quitar" data-id="${v.id}" data-sup="${s.id}">Quitar</button></li>`).join('')
                || '<li class="list-group-item text-muted">Sin vendedores asignados.</li>'}</ul>
            <div class="input-group">
              <select class="form-select" aria-label="Vendedor a asignar"><option value="">Asignar un vendedor...</option>
                ${libres.map(v => `<option value="${v.id}">${esc(etiquetaUsuario(v))}${v.supervisor_id ? ` — hoy con ${esc(nombre(v.supervisor_id))}` : ''}</option>`).join('')}</select>
              <button type="button" class="btn btn-gold" data-jer="asignar" data-sup="${s.id}">Asignar</button>
            </div>
            <div class="text-end mt-2"><button type="button" class="btn btn-link btn-sm text-danger p-0" data-jer="degradar" data-id="${s.id}">Quitar rol de supervisor</button></div>
          </div></div>`;
    }).join('') || '<div class="card mb-3"><div class="card-body text-muted">Todavía no hay supervisores. Cree uno o convierta a un usuario existente.</div></div>';
    const sin = vendedores.filter(v => !v.supervisor_id);
    $('jerSinCuenta').textContent = `${sin.length} de ${vendedores.length}`;
    $('jerSinSupervisor').innerHTML = sin.length
        ? `<div class="d-flex flex-wrap gap-2">${sin.map(v => `<span class="badge text-bg-light">${esc(v.nombre || v.usuario)}</span>`).join('')}</div>`
        : '<span class="text-muted small">Todos los vendedores tienen supervisor.</span>';
}

// ---------------------------------------------------------------- caja menor (efectivo de cada usuario)
// Entradas: ventas en efectivo (automáticas) y manuales. Salidas: liquidación / entrega a oficina, gastos...
let cajaMovs = [], cajaSaldos = [];
const cajaUsuarioElegido = () => veEquipo() ? $('cajaUsuario').value : perfil.id;   // '' = todas las cajas
const puedeMoverCaja = uid => !!uid && (esAdmin() || uid === perfil.id);
const nombreCaja = uid => uid === perfil?.id ? (perfil.nombre || perfil.usuario) : (nombreUsuario(uid) || cajaSaldos.find(s => s.usuario_id === uid)?.usuario || '');

function registrarCaja() {
    $('caja-tab').addEventListener('shown.bs.tab', loadCaja);
    $('cajaUsuario').addEventListener('change', loadCaja);
    ['cajaDesde', 'cajaHasta'].forEach(id => $(id).addEventListener('change', renderCaja));
    $('cajaForm').addEventListener('submit', guardarMovimientoCaja);
    $('cajaLiquidar').addEventListener('click', prepararLiquidacion);
    $('cajaExportar').addEventListener('click', exportarCaja);
    $('cajaResumenBody').addEventListener('click', e => {
        const tr = e.target.closest('tr[data-id]');
        if (tr) { $('cajaUsuario').value = tr.dataset.id; loadCaja(); }
    });
    $('cajaBody').addEventListener('click', e => {
        const b = e.target.closest('.caja-borrar');
        if (b) eliminarMovimientoCaja(Number(b.dataset.id));
    });
    // Venta: aviso según la forma de pago
    $('formaPago').addEventListener('change', notaFormaPago);
    notaFormaPago();
}

function notaFormaPago() {
    $('formaPagoNota').textContent = $('formaPago').value === 'EFECTIVO'
        ? 'El cliente paga al momento: el pago queda registrado (método EFECTIVO) y el total entra a la caja menor de quien registra la venta.'
        : 'El cliente queda debiendo el total; los abonos se registran en Pagos.';
}

// Lista "Caja de": el admin ve todas; el supervisor, la suya y las de su equipo
function prepararUsuariosCaja() {
    if (!veEquipo()) return;
    const v = $('cajaUsuario').value;
    const lista = perfiles.filter(p => p.activo && (esAdmin() || p.id === perfil.id || p.supervisor_id === perfil.id));
    $('cajaUsuario').innerHTML = `<option value="">${esAdmin() ? 'Todas las cajas' : 'Todo mi equipo'}</option>`
        + lista.map(p => `<option value="${p.id}">${esc(p.nombre || p.usuario)}${p.id === perfil.id ? ' (mi caja)' : ''}</option>`).join('');
    $('cajaUsuario').value = lista.some(p => p.id === v) ? v : '';
}

function loadCaja() {
    run(async () => {
        if (veEquipo() && !perfiles.length) await cargarPerfiles();
        prepararUsuariosCaja();
        const uid = cajaUsuarioElegido();
        const [saldos, movs] = await Promise.all([
            sb.from('caja_menor_saldos').select('*').then(ok),
            fetchAll(() => { let q = sb.from('caja_menor_detalle').select('*'); if (uid) q = q.eq('usuario_id', uid); return q.order('fecha').order('id'); }),
        ]);
        // Cajas que le corresponden a quien mira (las demás salen en 0 por los permisos)
        cajaSaldos = saldos.filter(s => esAdmin() ? (num(s.movimientos) > 0 || s.usuario_id === perfil.id)
            : esSupervisor() ? (s.usuario_id === perfil.id || perfiles.some(p => p.id === s.usuario_id && p.supervisor_id === perfil.id))
            : s.usuario_id === perfil.id)
            .sort((a, b) => num(b.saldo) - num(a.saldo) || String(a.usuario).localeCompare(b.usuario));
        cajaMovs = movs;
        if (!$('cajaFecha').value) $('cajaFecha').value = hoyISO();
        renderCaja();
    });
}

const saldoCaja = uid => cajaSaldos.filter(s => !uid || s.usuario_id === uid).reduce((t, s) => t + num(s.saldo), 0);

function movimientosCajaFiltrados() {
    const desde = $('cajaDesde').value, hasta = $('cajaHasta').value;
    // Saldo acumulado por caja, de más antiguo a más reciente (sobre todos los movimientos cargados)
    const acum = {};
    const conSaldo = cajaMovs.map(m => {
        acum[m.usuario_id] = (acum[m.usuario_id] || 0) + (m.tipo === 'ENTRADA' ? num(m.valor) : -num(m.valor));
        return { ...m, saldo: acum[m.usuario_id] };
    });
    return conSaldo.filter(m => (!desde || m.fecha >= desde) && (!hasta || m.fecha <= hasta)).reverse();
}

function renderCaja() {
    const uid = cajaUsuarioElegido(), todas = !uid;
    const d = movimientosCajaFiltrados();
    const desde = $('cajaDesde').value, hasta = $('cajaHasta').value;
    const periodo = desde || hasta ? `(${desde ? 'desde ' + fmtFecha(desde) : ''}${desde && hasta ? ' ' : ''}${hasta ? 'hasta ' + fmtFecha(hasta) : ''})` : '(todo el historial)';
    const fila = (a, b) => `<div class="fila"><span>${a}</span><b>${b}</b></div>`;

    // Indicadores
    const saldo = saldoCaja(uid);
    $('cajaAlcance').textContent = todas ? (esAdmin() ? '(todas las cajas)' : '(mi equipo)') : `(${nombreCaja(uid)})`;
    $('cajaSaldo').textContent = fmtQ(saldo);
    $('cajaSaldo').classList.toggle('saldo-negativo', saldo < -0.005);
    $('cajaSaldoSub').innerHTML = todas ? fila('Cajas con efectivo', cajaSaldos.filter(s => num(s.saldo) > 0.005).length) : '';
    const ent = d.filter(m => m.tipo === 'ENTRADA'), sal = d.filter(m => m.tipo === 'SALIDA');
    const suma = l => l.reduce((t, m) => t + num(m.valor), 0);
    $('cajaPeriodoTxt1').textContent = periodo; $('cajaPeriodoTxt2').textContent = periodo;
    $('cajaEntradas').textContent = fmtQ(suma(ent));
    $('cajaEntradasSub').innerHTML = fila('Ventas en efectivo', `${ent.filter(m => m.origen === 'VENTA').length} · ${fmtQ(suma(ent.filter(m => m.origen === 'VENTA')))}`)
        + fila('Entradas manuales', `${ent.filter(m => m.origen !== 'VENTA').length} · ${fmtQ(suma(ent.filter(m => m.origen !== 'VENTA')))}`);
    $('cajaSalidas').textContent = fmtQ(suma(sal));
    $('cajaSalidasSub').innerHTML = fila('Movimientos', sal.length);

    // Resumen por usuario (cuando se ven todas)
    $('cajaResumenBox').classList.toggle('d-none', !(todas && veEquipo()));
    if (todas && veEquipo()) {
        $('cajaResumenBody').innerHTML = cajaSaldos.map(s => `<tr data-id="${s.usuario_id}" style="cursor:pointer">
            <td class="fw-semibold">${esc(s.usuario)}${s.usuario_id === perfil.id ? ' <span class="badge text-bg-light">mi caja</span>' : ''}</td><td>${esc(s.tienda)}</td>
            <td class="num">${fmtQ(s.entradas)}</td><td class="num">${fmtQ(s.salidas)}</td>
            <td class="num fw-semibold ${num(s.saldo) < -0.005 ? 'saldo-negativo' : ''}">${fmtQ(s.saldo)}</td><td>${fmtFecha(s.ultimo_movimiento)}</td></tr>`).join('')
            || '<tr><td colspan="6" class="text-muted">Todavía no hay movimientos de caja.</td></tr>';
    }

    // Formulario: solo en la caja propia (o cualquiera, el admin)
    const puede = puedeMoverCaja(uid);
    $('cajaForm').querySelectorAll('input, select, button').forEach(el => el.disabled = !puede);
    $('cajaSoloLectura').classList.toggle('d-none', puede);
    $('cajaSoloLectura').textContent = todas ? 'Elija la caja de un usuario (arriba o en la tabla) para registrarle un movimiento.'
        : 'Solo puede consultar esta caja. Los movimientos los registra su dueño o el administrador.';
    $('cajaFormDe').textContent = puede && uid !== perfil.id ? `· en la caja de ${nombreCaja(uid)}` : '';

    // Movimientos
    $('cajaHead').innerHTML = `<tr><th>Fecha</th>${todas ? '<th>Caja de</th>' : ''}<th>Movimiento</th><th>Concepto</th><th>Observaciones</th>
        <th class="num">Entrada</th><th class="num">Salida</th>${todas ? '' : '<th class="num">Saldo</th>'}<th>Registró</th><th></th></tr>`;
    $('cajaBody').innerHTML = d.map(m => {
        const borrable = m.origen === 'MANUAL' && (esAdmin() || (m.usuario_id === perfil.id && m.creado_por === perfil.id));
        return `<tr><td>${fmtFecha(m.fecha)}</td>${todas ? `<td>${esc(m.usuario)}</td>` : ''}
            <td><span class="badge ${m.tipo === 'ENTRADA' ? 'text-bg-success' : 'text-bg-secondary'}">${m.tipo === 'ENTRADA' ? 'Entrada' : 'Salida'}</span>
                <span class="small text-muted ms-1">${m.origen === 'VENTA' ? 'venta en efectivo' : 'manual'}</span></td>
            <td>${esc(m.concepto)}${m.pedido_id && m.origen === 'VENTA' ? '' : ''}</td><td class="small text-muted">${esc(m.observaciones)}</td>
            <td class="num">${m.tipo === 'ENTRADA' ? fmtQ(m.valor) : ''}</td><td class="num">${m.tipo === 'SALIDA' ? fmtQ(m.valor) : ''}</td>
            ${todas ? '' : `<td class="num fw-semibold ${m.saldo < -0.005 ? 'saldo-negativo' : ''}">${fmtQ(m.saldo)}</td>`}
            <td class="small">${esc(m.registrado_por)}</td>
            <td class="text-end">${borrable ? `<button type="button" class="btn btn-outline-danger btn-sm caja-borrar" data-id="${m.id}" title="Eliminar"><i class="bi bi-trash"></i></button>` : ''}</td></tr>`;
    }).join('') || `<tr><td colspan="10" class="text-muted">Sin movimientos${desde || hasta ? ' en esas fechas' : ''}.</td></tr>`;
    $('cajaInfo').textContent = `${d.length} movimiento(s)`;
}

function guardarMovimientoCaja(e) {
    e.preventDefault();
    const uid = cajaUsuarioElegido();
    if (!puedeMoverCaja(uid)) { showAlert('Elija la caja de un usuario para registrar el movimiento.', 'warning'); return; }
    const d = {
        usuario_id: uid, tipo: $('cajaTipo').value, fecha: $('cajaFecha').value,
        valor: Math.round(num($('cajaValor').value) * 100) / 100,
        concepto: normalizarNombre($('cajaConcepto').value), observaciones: $('cajaObs').value.trim() || null,
    };
    if (!(d.valor > 0)) { $('cajaValor').reportValidity(); return; }
    const actual = saldoCaja(uid);
    if (d.tipo === 'SALIDA' && d.valor > actual + 0.005
        && !confirm(`La salida (${fmtQ(d.valor)}) es mayor que el efectivo en caja (${fmtQ(actual)}). ¿Registrarla de todas formas?`)) return;
    run(async () => {
        ok(await sb.from('caja_menor').insert(d));
        showAlert(`${d.tipo === 'SALIDA' ? 'Salida' : 'Entrada'} de ${fmtQ(d.valor)} registrada en la caja de ${nombreCaja(uid)}. Efectivo en caja: ${fmtQ(actual + (d.tipo === 'SALIDA' ? -d.valor : d.valor))}`, 'success');
        ['cajaValor', 'cajaObs', 'cajaConcepto'].forEach(id => $(id).value = '');
        loadCaja();
    });
}

// Liquidar: salida por todo el efectivo de la caja (se confirma al guardar)
function prepararLiquidacion() {
    const uid = cajaUsuarioElegido();
    if (!puedeMoverCaja(uid)) { showAlert('Elija la caja de un usuario para liquidarla.', 'warning'); return; }
    const actual = saldoCaja(uid);
    if (actual <= 0.005) { showAlert('La caja no tiene efectivo para liquidar.', 'info'); return; }
    $('cajaTipo').value = 'SALIDA';
    $('cajaFecha').value = hoyISO();
    $('cajaValor').value = actual.toFixed(2);
    $('cajaConcepto').value = 'LIQUIDACIÓN · ENTREGA A OFICINA';
    $('cajaObs').focus();
    showAlert(`Salida de ${fmtQ(actual)} preparada. Revise y pulse "Guardar movimiento".`, 'info');
}

function eliminarMovimientoCaja(id) {
    const m = cajaMovs.find(x => x.id === id);
    if (!m || !confirm(`¿Eliminar la ${m.tipo === 'ENTRADA' ? 'entrada' : 'salida'} de ${fmtQ(m.valor)} del ${fmtFecha(m.fecha)} (${m.concepto || 'sin concepto'})?`)) return;
    run(async () => {
        const borrados = ok(await sb.from('caja_menor').delete().eq('id', id).select());
        if (!borrados.length) throw new Error('No se pudo eliminar el movimiento (no tiene permiso o ya no existe).');
        showAlert('Movimiento eliminado', 'success');
        loadCaja();
    });
}

function exportarCaja() {
    const todas = !cajaUsuarioElegido();
    exportarExcel('Caja_menor', 'Caja menor', movimientosCajaFiltrados().map(m => ({
        'Fecha': aFecha(m.fecha), 'Caja de': m.usuario, 'Tienda': m.tienda, 'Movimiento': m.tipo,
        'Origen': m.origen === 'VENTA' ? 'VENTA EN EFECTIVO' : 'MANUAL', 'Concepto': m.concepto, 'Pedido': m.pedido_id,
        'Entrada': m.tipo === 'ENTRADA' ? num(m.valor) : null, 'Salida': m.tipo === 'SALIDA' ? num(m.valor) : null,
        ...(todas ? {} : { 'Saldo': m.saldo }), 'Observaciones': m.observaciones, 'Registró': m.registrado_por,
    })));
}

// ---------------------------------------------------------------- comisiones: esquemas por cumplimiento y asignación
const PANEL_COMISIONES = `<div class="tab-pane fade" id="maestro-panel-comisiones">
    <div class="card mb-3">
      <div class="card-header card-header-custom d-flex justify-content-between align-items-center flex-wrap gap-2">
        <span><i class="bi bi-diagram-2 me-2"></i> Esquemas de comisión</span>
        <button type="button" class="btn btn-gold btn-sm" id="esqNuevo"><i class="bi bi-plus-lg"></i> Nuevo esquema</button>
      </div>
      <div class="card-body">
        <p class="small text-muted">Cada tramo dice: desde qué % de cumplimiento de la meta se paga qué % sobre la venta. <strong>Individual</strong>: sobre las ventas y la meta de la persona.
          <strong>Grupal</strong>: sobre las ventas de su grupo (ella y quienes la tienen como supervisora) y la <strong>meta grupal</strong> de la supervisora (si es 0, la suma de las metas individuales del grupo). Una persona puede tener varios esquemas: su comisión es la suma.
          Las ventas a clientes <strong>mayoristas</strong> pagan el % de mayoreo y cuentan para el cumplimiento.</p>
        <div class="row g-3" id="esqLista"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-header card-header-custom"><i class="bi bi-person-vcard me-2"></i> Asignación por vendedor</div>
      <div class="card-body">
        <div class="table-responsive"><table class="table table-sm align-middle mb-0">
          <thead class="table-light"><tr><th>Vendedor</th><th>Esquemas</th><th>Supervisor(a)</th><th class="num">Meta individual Q</th><th class="num">Meta grupal Q</th><th class="num">% fijo (sin esquema)</th></tr></thead>
          <tbody id="asigComisiones"></tbody>
        </table></div>
        <div class="form-text">Los cambios se guardan al salir de cada campo. Con varios esquemas la comisión es la suma de cada uno (p. ej. una supervisora que también vende: SUPERVISORA RS + EJECUTIVA DE VENTA). La meta grupal aplica a los esquemas grupales; en 0 se usa la suma de las metas individuales del grupo. Sin esquemas se paga el % fijo.</div>
      </div>
    </div>
  </div>`;
let esquemasComision = [], vendedorEsquemas = [];   // vendedorEsquemas: [{ vendedor, esquema_id }]
const esquemasDe = nombre => vendedorEsquemas.filter(x => x.vendedor === nombre).map(x => esquemasComision.find(e => e.id === x.esquema_id)).filter(Boolean);

function construirPestanaComisiones() {
    // Eventos delegados (el panel se arma una vez)
    document.addEventListener('shown.bs.tab', e => { if (e.target.id === 'maestro-tab-comisiones') run(cargarComisiones); });
    document.addEventListener('click', e => {
        if (e.target.closest('#esqNuevo')) nuevoEsquema();
        const b = e.target.closest('[data-esq]');
        if (!b) return;
        const card = b.closest('[data-id]');
        if (b.dataset.esq === 'agregar-tramo') card.querySelector('.esq-tramos').insertAdjacentHTML('beforeend', filaTramo({ desde: '', pct: '' }));
        if (b.dataset.esq === 'quitar-tramo') b.closest('tr').remove();
        if (b.dataset.esq === 'guardar') guardarEsquema(card);
        if (b.dataset.esq === 'eliminar') eliminarEsquema(Number(card.dataset.id));
    });
    document.addEventListener('change', e => {
        const el = e.target.closest('[data-asig]');
        if (el) guardarAsignacion(el);
    });
}

async function cargarComisiones() {
    await cargarMaestros();   // trae también los esquemas y sus asignaciones
    renderEsquemas();
    renderAsignaciones();
}

const filaTramo = t => `<tr><td><div class="input-group input-group-sm"><span class="input-group-text">desde</span>
    <input type="number" class="form-control text-end esq-desde" value="${esc(t.desde)}" min="0" step="1" aria-label="Desde % de cumplimiento"><span class="input-group-text">%</span></div></td>
  <td><div class="input-group input-group-sm"><span class="input-group-text">paga</span>
    <input type="number" class="form-control text-end esq-pct" value="${esc(t.pct)}" min="0" max="100" step="0.01" aria-label="Porcentaje de pago"><span class="input-group-text">%</span></div></td>
  <td class="text-end"><button type="button" class="btn btn-outline-danger btn-sm" data-esq="quitar-tramo" title="Quitar tramo"><i class="bi bi-x-lg"></i></button></td></tr>`;

function renderEsquemas() {
    const usados = id => vendedorEsquemas.filter(x => x.esquema_id === id).length;
    $('esqLista').innerHTML = esquemasComision.map(e => {
        const tramos = [...(e.tramos || [])].sort((a, b) => num(a.desde) - num(b.desde));
        return `<div class="col-lg-6"><div class="border rounded p-3 h-100" data-id="${e.id}">
          <div class="row g-2 mb-2">
            <div class="col-7"><label class="form-label">Nombre</label><input type="text" class="form-control form-control-sm esq-nombre" value="${esc(e.nombre)}"></div>
            <div class="col-5"><label class="form-label">Tipo</label><select class="form-select form-select-sm esq-tipo">
              <option value="INDIVIDUAL" ${e.tipo === 'INDIVIDUAL' ? 'selected' : ''}>Individual</option><option value="GRUPAL" ${e.tipo === 'GRUPAL' ? 'selected' : ''}>Grupal</option></select></div>
          </div>
          <label class="form-label">Tramos por cumplimiento</label>
          <table class="table table-sm mb-1"><tbody class="esq-tramos">${tramos.map(filaTramo).join('')}</tbody></table>
          <button type="button" class="btn btn-link btn-sm p-0 mb-2" data-esq="agregar-tramo"><i class="bi bi-plus"></i> Agregar tramo</button>
          <div class="d-flex align-items-end justify-content-between gap-2 flex-wrap">
            <div style="max-width: 190px"><label class="form-label">Mayoreo</label><div class="input-group input-group-sm"><span class="input-group-text">paga</span>
              <input type="number" class="form-control text-end esq-mayoreo" value="${num(e.pct_mayoreo)}" min="0" max="100" step="0.01" aria-label="Porcentaje de mayoreo"><span class="input-group-text">%</span></div></div>
            <div class="d-flex gap-2 align-items-center"><span class="small text-muted">${usados(e.id)} vendedor(es)</span>
              <button type="button" class="btn btn-outline-danger btn-sm" data-esq="eliminar" title="Eliminar esquema"><i class="bi bi-trash"></i></button>
              <button type="button" class="btn btn-gold btn-sm" data-esq="guardar">Guardar</button></div>
          </div></div></div>`;
    }).join('') || '<div class="col-12 text-muted">No hay esquemas. Cree uno con "Nuevo esquema".</div>';
}

function guardarEsquema(card) {
    const id = Number(card.dataset.id);
    const tramos = [...card.querySelectorAll('.esq-tramos tr')].map(tr => ({ desde: tr.querySelector('.esq-desde').value, pct: tr.querySelector('.esq-pct').value }))
        .filter(t => t.desde !== '' || t.pct !== '').map(t => ({ desde: Math.round(num(t.desde) * 100) / 100, pct: Math.round(num(t.pct) * 100) / 100 }))
        .sort((a, b) => a.desde - b.desde);
    const d = { nombre: normalizarNombre(card.querySelector('.esq-nombre').value), tipo: card.querySelector('.esq-tipo').value,
                pct_mayoreo: Math.round(num(card.querySelector('.esq-mayoreo').value) * 100) / 100, tramos };
    if (!d.nombre) { showAlert('Escriba el nombre del esquema.', 'warning'); return; }
    if (!tramos.length || tramos[0].desde !== 0) { showAlert('El primer tramo debe empezar "desde 0 %".', 'warning'); return; }
    if (new Set(tramos.map(t => t.desde)).size !== tramos.length) { showAlert('Hay dos tramos que empiezan en el mismo %.', 'warning'); return; }
    if (tramos.some(t => t.pct < 0 || t.pct > 100) || d.pct_mayoreo > 100) { showAlert('Los % de pago deben estar entre 0 y 100.', 'warning'); return; }
    run(async () => {
        ok(await sb.from('esquemas_comision').update(d).eq('id', id));
        await cargarComisiones();
        showAlert(`Esquema "${d.nombre}" guardado: ${tramos.map(t => `desde ${t.desde}% → ${t.pct}%`).join(' · ')} · mayoreo ${d.pct_mayoreo}%`, 'success');
    });
}

function nuevoEsquema() {
    const nombre = normalizarNombre(prompt('Nombre del nuevo esquema de comisión:') || '');
    if (!nombre) return;
    run(async () => {
        const orden = Math.max(0, ...esquemasComision.map(e => e.orden || 0)) + 1;
        ok(await sb.from('esquemas_comision').insert({ nombre, tipo: 'INDIVIDUAL', tramos: [{ desde: 0, pct: 1 }], pct_mayoreo: 0, orden }));
        await cargarComisiones();
        showAlert(`Esquema "${nombre}" creado. Configure sus tramos y pulse Guardar.`, 'success');
    });
}

function eliminarEsquema(id) {
    const e = esquemasComision.find(x => x.id === id);
    const n = vendedorEsquemas.filter(x => x.esquema_id === id).length;
    if (!confirm(`¿Eliminar el esquema "${e.nombre}"?${n ? `\n\n${n} vendedor(es) lo tienen asignado y pasarán a su % fijo.` : ''}`)) return;
    run(async () => {
        ok(await sb.from('esquemas_comision').delete().eq('id', id));
        await cargarComisiones();
        showAlert(`Esquema "${e.nombre}" eliminado`, 'success');
    });
}

function renderAsignaciones() {
    const vendedores = maestros.vendedores.filter(v => v.activo !== false);
    $('asigComisiones').innerHTML = vendedores.map(v => {
        const datos = `data-nombre="${esc(v.nombre)}"`;
        const suyos = esquemasDe(v.nombre).map(e => e.id);
        const tieneGrupal = esquemasDe(v.nombre).some(e => e.tipo === 'GRUPAL');
        return `<tr><td class="fw-semibold">${esc(v.nombre)}</td>
          <td>${esquemasComision.map(e => `<div class="form-check form-check-inline m-0 me-2">
              <input class="form-check-input" type="checkbox" id="asig-${esc(v.nombre)}-${e.id}" data-asig="esquema" data-esquema="${e.id}" ${datos} ${suyos.includes(e.id) ? 'checked' : ''}>
              <label class="form-check-label small" for="asig-${esc(v.nombre)}-${e.id}">${esc(e.nombre)}${e.tipo === 'GRUPAL' ? ' <span class="text-muted">(grupal)</span>' : ''}</label></div>`).join('')
              || '<span class="text-muted small">Cree un esquema arriba</span>'}</td>
          <td><select class="form-select form-select-sm" data-asig="supervisor" ${datos} aria-label="Supervisor">
            <option value="">(ninguno)</option>${vendedores.filter(x => x.nombre !== v.nombre).map(x => `<option value="${esc(x.nombre)}" ${v.supervisor === x.nombre ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('')}</select></td>
          <td><input type="number" class="form-control form-control-sm text-end" style="min-width: 105px" data-asig="meta_mensual" ${datos} value="${num(v.meta_mensual)}" min="0" step="0.01" aria-label="Meta individual"></td>
          <td><input type="number" class="form-control form-control-sm text-end" style="min-width: 105px" data-asig="meta_grupal" ${datos} value="${num(v.meta_grupal)}" min="0" step="0.01"
              ${tieneGrupal ? '' : 'disabled title="Solo aplica con un esquema grupal"'} aria-label="Meta grupal"></td>
          <td><input type="number" class="form-control form-control-sm text-end" style="min-width: 75px" data-asig="comision_pct" ${datos} value="${num(v.comision_pct)}" min="0" max="100" step="0.01"
              ${suyos.length ? 'disabled title="Tiene esquemas asignados"' : ''} aria-label="Porcentaje fijo"></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="text-muted">No hay vendedores activos.</td></tr>';
}

function guardarAsignacion(el) {
    const campo = el.dataset.asig, nombre = el.dataset.nombre;
    if (campo === 'esquema') {
        const id = Number(el.dataset.esquema), e = esquemasComision.find(x => x.id === id);
        run(async () => {
            if (el.checked) ok(await sb.from('vendedor_esquemas').insert({ vendedor: nombre, esquema_id: id }));
            else ok(await sb.from('vendedor_esquemas').delete().eq('vendedor', nombre).eq('esquema_id', id));
            vendedorEsquemas = el.checked ? [...vendedorEsquemas, { vendedor: nombre, esquema_id: id }]
                : vendedorEsquemas.filter(x => !(x.vendedor === nombre && x.esquema_id === id));
            renderAsignaciones(); renderEsquemas(); renderMaestro('vendedores');
            const lista = esquemasDe(nombre).map(x => x.nombre);
            showAlert(`${nombre}: ${el.checked ? 'se agregó' : 'se quitó'} el esquema ${e?.nombre}. Esquemas: ${lista.length ? lista.join(' + ') : 'ninguno (% fijo)'}`, 'success');
        });
        return;
    }
    let valor = el.value;
    if (campo === 'supervisor') valor = valor || null;
    else {
        valor = Math.round(num(valor) * 100) / 100;
        if (valor < 0 || (campo === 'comision_pct' && valor > 100)) { el.reportValidity(); return; }
    }
    run(async () => {
        ok(await sb.from('vendedores').update({ [campo]: valor }).eq('nombre', nombre));
        const v = maestros.vendedores.find(x => x.nombre === nombre);
        if (v) v[campo] = valor;
        renderMaestro('vendedores');
        const txt = { supervisor: `supervisor(a) ${valor || 'ninguno'}`, meta_mensual: `meta individual ${fmtQ(valor)}`,
                      meta_grupal: `meta grupal ${fmtQ(valor)}`, comision_pct: `comisión fija ${fmtPct(valor)}` }[campo];
        showAlert(`${nombre}: ${txt}`, 'success');
    });
}

// ---------------------------------------------------------------- cuadre de tiendas (cierre mensual)
const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreMes = iso => { const [y, m] = iso.split('-').map(Number); return `${MESES_LARGOS[m - 1]} ${y}`; };
const mesAnterior = iso => { const [y, m] = iso.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 10); };
const fmtPct = v => `${num(v).toLocaleString('es-GT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

// bueno: si subir es bueno ('sube'), malo ('baja') o ninguno (null)
const INDICADORES_CUADRE = [
    { id: 'cartera', titulo: 'Cuentas por cobrar al cierre', icono: 'cash-stack', campo: 'cartera', fmt: v => fmtQ(v), dims: ['tienda'], bueno: 'baja' },
    { id: 'recaudo', titulo: 'Recaudo del mes', icono: 'cash-coin', campo: 'recaudo', recaudo: true, fmt: v => fmtQ(v), dims: ['tienda', 'metodo'], bueno: 'sube' },
    { id: 'inventario', titulo: 'Inventario disponible al cierre', icono: 'boxes', campo: 'inventario_gr', fmt: v => fmtG(v), dims: ['tienda'], bueno: null },
    { id: 'ventas_gr', titulo: 'Ventas en gramos', icono: 'gem', campo: 'ventas_gr', fmt: v => fmtG(v), dims: ['tienda', 'vendedor'], bueno: 'sube' },
    { id: 'ventas_q', titulo: 'Ventas en dinero', icono: 'currency-dollar', campo: 'ventas_q', fmt: v => fmtQ(v), dims: ['tienda', 'vendedor'], bueno: 'sube' },
    { id: 'comision', titulo: 'Comisiones', icono: 'percent', campo: 'comision', fmt: v => fmtQ(v), dims: ['vendedor'], totalDim: 'vendedor', bueno: null },
    { id: 'meta', titulo: 'Cumplimiento de meta', icono: 'bullseye', meta: true, dims: ['vendedor'], bueno: 'sube' },
    { id: 'caja', titulo: 'Caja menor al cierre', icono: 'safe2', campo: 'caja', caja: true, fmt: v => fmtQ(v), dims: ['tienda', 'usuario'], bueno: null },
];
let cuadreFilas = [];

function registrarCuadre() {
    const hoy = hoyISO().slice(0, 7);
    const [y, m] = hoy.split('-').map(Number);
    $('cuaHasta').value = hoy;
    $('cuaDesde').value = new Date(Date.UTC(y, m - 6, 1)).toISOString().slice(0, 7);
    $('cuadre-tab').addEventListener('shown.bs.tab', () => { if (!$('cuaMeses').children.length) cargarCuadre(); });
    ['cuaTienda', 'cuaDesde', 'cuaHasta'].forEach(id => $(id).addEventListener('change', cargarCuadre));
    $('cuaActualizar').addEventListener('click', cargarCuadre);
    $('cuaExportar').addEventListener('click', exportarCuadre);
}

function cargarCuadre() {
    const desde = $('cuaDesde').value, hasta = $('cuaHasta').value;
    if (!desde || !hasta) return;
    if (desde > hasta) { showAlert('El mes "Desde" es posterior a "Hasta".', 'warning'); return; }
    run(async () => {
        // Se pide un mes antes para calcular la variación del primero
        cuadreFilas = ok(await sb.rpc('cuadre_tiendas', {
            p_desde: mesAnterior(desde + '-01'), p_hasta: hasta + '-01', p_tienda: $('cuaTienda').value || null,
        })).map(r => ({ ...r, mes: String(r.mes).slice(0, 10) }));
        renderCuadre();
    });
}

// Valor de un indicador para un mes (total o de una clave de tienda/vendedor)
function valorCuadre(ind, mes, dim = null, clave = null) {
    const filas = cuadreFilas.filter(r => r.mes === mes && (ind.meta ? r.dimension === 'vendedor' : r.dimension === (dim || ind.totalDim || 'tienda'))
        && (clave === null || r.clave === clave));
    if (ind.meta) {
        const conMeta = filas.filter(r => num(r.meta) > 0);
        const metaTotal = conMeta.reduce((t, r) => t + num(r.meta), 0);
        const ventas = conMeta.reduce((t, r) => t + num(r.ventas_q), 0);
        return metaTotal > 0 ? { valor: ventas / metaTotal * 100, ventas, meta: metaTotal } : null;
    }
    const suma = c => filas.reduce((t, r) => t + num(r[c]), 0);
    if (ind.recaudo) return { valor: suma('recaudo'), efectivo: suma('recaudo_efectivo') };
    if (ind.id === 'comision' && clave !== null && filas[0])
        return { valor: suma('comision'),
                 detalle: cuadreFilas.filter(r => r.mes === mes && r.dimension === 'comision' && r.clave === clave) };
    return ind.caja ? { valor: suma('caja'), entradas: suma('caja_entradas'), salidas: suma('caja_salidas') } : { valor: suma(ind.campo) };
}

function variacionCuadre(ind, actual, previo) {
    if (!actual || !previo) return '<span class="variacion neutra">—</span>';
    let dif, txt;
    if (ind.meta) { dif = actual.valor - previo.valor; txt = `${dif >= 0 ? '+' : ''}${dif.toFixed(1)} pts`; }
    else {
        if (Math.abs(previo.valor) < 0.005) return `<span class="variacion neutra">${Math.abs(actual.valor) < 0.005 ? '0 %' : 'nuevo'}</span>`;
        dif = (actual.valor - previo.valor) / Math.abs(previo.valor) * 100;
        txt = `${dif >= 0 ? '+' : ''}${dif.toLocaleString('es-GT', { maximumFractionDigits: 1 })} %`;
    }
    const flecha = Math.abs(dif) < 0.05 ? '' : dif > 0 ? '▲ ' : '▼ ';
    const clase = !ind.bueno || Math.abs(dif) < 0.05 ? 'neutra' : (dif > 0) === (ind.bueno === 'sube') ? 'buena' : 'mala';
    return `<span class="variacion ${clase}">${flecha}${txt}</span>`;
}

const textoValorCuadre = (ind, v) => !v ? '—' : ind.meta ? fmtPct(v.valor) : ind.fmt(v.valor);

function renderCuadre() {
    const desde = $('cuaDesde').value + '-01', hasta = $('cuaHasta').value + '-01', mesHoy = hoyISO().slice(0, 7) + '-01';
    const meses = [...new Set(cuadreFilas.map(r => r.mes))].filter(m => m >= desde && m <= hasta).sort().reverse();
    $('cuaMeses').innerHTML = meses.map(mes => {
        const prev = mesAnterior(mes);
        const tarjetas = INDICADORES_CUADRE.map(ind => {
            const actual = valorCuadre(ind, mes), previo = valorCuadre(ind, prev);
            const sub = ind.meta
                ? (actual ? `Ventas ${fmtQ(actual.ventas)} de una meta de ${fmtQ(actual.meta)}` : 'Configure las metas en Maestros &gt; Vendedores')
                : ind.caja ? `Entradas del mes ${fmtQ(actual?.entradas)} · Salidas ${fmtQ(actual?.salidas)}`
                : ind.recaudo ? `Abonos a cartera ${fmtQ(num(actual?.valor) - num(actual?.efectivo))} · Ventas en efectivo ${fmtQ(actual?.efectivo)}`
                : `${nombreMes(prev)}: ${previo ? ind.fmt(previo.valor) : '—'}`;
            const detalle = ind.dims.map(dim => {
                const claves = [...new Set(cuadreFilas.filter(r => r.mes === mes && r.dimension === dim && (!ind.meta || num(r.meta) > 0)).map(r => r.clave))];
                const filas = claves.map(k => ({ k, a: valorCuadre(ind, mes, dim, k), p: valorCuadre(ind, prev, dim, k) }))
                    .filter(x => x.a && (ind.meta || Math.abs(x.a.valor) > 0.005 || (x.p && Math.abs(x.p.valor) > 0.005)))
                    .sort((x, y) => num(y.a.valor) - num(x.a.valor));
                if (!filas.length) return '';
                return `<details class="cuadre-detalle"><summary>Por ${dim === 'tienda' ? 'tienda / bodega' : dim === 'usuario' ? 'usuario' : dim === 'metodo' ? 'método de pago' : 'vendedor'} (${filas.length})</summary>
                    <table class="table table-sm mb-0"><tbody>${filas.map(x => `<tr><td>${esc(x.k)}${ind.meta ? `<div class="small text-muted">${fmtQ(x.a.ventas)} de ${fmtQ(x.a.meta)}</div>`
                        : ind.caja && (x.a.entradas || x.a.salidas) ? `<div class="small text-muted">+${fmtQ(x.a.entradas)} / −${fmtQ(x.a.salidas)}</div>`
                        : ind.id === 'comision' && x.a.detalle?.length ? x.a.detalle.map(d => `<div class="small text-muted">${esc(d.esquema)} · ${d.cumplimiento != null ? `cumplimiento ${fmtPct(d.cumplimiento)} · ` : ''}tramo ${fmtPct(d.comision_pct)}${x.a.detalle.length > 1 ? ` · ${fmtQ(d.comision)}` : ''}</div>`).join('') : ''}</td>
                    <td class="num fw-semibold">${textoValorCuadre(ind, x.a)}</td><td class="num">${variacionCuadre(ind, x.a, x.p)}</td></tr>`).join('')}</tbody></table></details>`;
            }).join('');
            return `<div class="col-md-6 col-xl-4"><div class="card kpi h-100"><div class="card-body">
                <div class="kpi-titulo"><i class="bi bi-${ind.icono}"></i> ${ind.titulo}</div>
                <div class="d-flex align-items-baseline justify-content-between gap-2 flex-wrap">
                  <div class="kpi-valor">${textoValorCuadre(ind, actual)}</div>${variacionCuadre(ind, actual, previo)}</div>
                <div class="kpi-sub mb-2">${sub}</div>${detalle}
              </div></div></div>`;
        }).join('');
        return `<section class="cuadre-mes mb-4">
            <h3 class="cuadre-mes-titulo">${nombreMes(mes)}${mes === mesHoy ? ' <span class="badge text-bg-warning">en curso</span>' : ''}</h3>
            <div class="row g-3">${tarjetas}</div></section>`;
    }).join('') || '<div class="card"><div class="card-body text-muted">No hay meses en ese rango.</div></div>';
}

function exportarCuadre() {
    const desde = $('cuaDesde').value + '-01', hasta = $('cuaHasta').value + '-01';
    const filas = cuadreFilas.filter(r => r.mes >= desde && r.mes <= hasta);
    exportarExcel('Cuadre_tiendas', 'Cuadre de tiendas', filas.map(r => ({
        'Mes': nombreMes(r.mes), 'Por': { tienda: 'Tienda', vendedor: 'Vendedor', usuario: 'Usuario (caja)', metodo: 'Método de pago' }[r.dimension] || r.dimension, 'Tienda / Vendedor / Usuario / Método': r.clave,
        'Cartera al cierre': r.cartera === null ? null : num(r.cartera), 'Inventario g al cierre': r.inventario_gr === null ? null : num(r.inventario_gr),
        'Ventas g': num(r.ventas_gr), 'Ventas Q': num(r.ventas_q), 'Comisión Q': num(r.comision),
        'Meta Q': r.meta === null ? null : num(r.meta),
        'Cumplimiento %': num(r.meta) > 0 ? Math.round(num(r.ventas_q) / num(r.meta) * 1000) / 10 : null,
        'Caja al cierre Q': r.caja == null ? null : num(r.caja), 'Caja entradas del mes': r.caja_entradas == null ? null : num(r.caja_entradas),
        'Caja salidas del mes': r.caja_salidas == null ? null : num(r.caja_salidas),
        'Recaudo Q': r.recaudo == null ? null : num(r.recaudo), 'Recaudo de ventas en efectivo Q': r.recaudo_efectivo == null ? null : num(r.recaudo_efectivo),
        'Esquema de comisión': r.esquema || null, 'Tramo de comisión %': r.comision_pct == null ? null : num(r.comision_pct),
        'Cumplimiento evaluado %': r.cumplimiento == null ? null : num(r.cumplimiento),
    })));
}

// ---------------------------------------------------------------- datos en bruto (administradores)
const TABLAS_DATOS = [
    { tabla: 'ventas', titulo: 'Ventas', orden: 'cliente_id,id' },
    { tabla: 'pagos', titulo: 'Pagos', orden: 'cliente_id,id' },
    { tabla: 'clientes', titulo: 'Clientes', orden: 'id' },
    { tabla: 'cartera_clientes', titulo: 'Cartera por cliente', orden: 'codigo' },
    { tabla: 'estado_cuenta', titulo: 'Estado de cuenta (todos)', orden: 'cliente_id,fecha,ref_id' },
    { tabla: 'pagos_detalle', titulo: 'Pagos recibidos (detalle)', orden: 'cliente_id,fecha_pago,id' },
    { tabla: 'cartera_detalle', titulo: 'Cartera por envío', orden: 'cliente_id,envio' },
    { tabla: 'devoluciones', titulo: 'Devoluciones', orden: 'id' },
    { tabla: 'ingresos_inventario', titulo: 'Ingresos de inventario', orden: 'id' },
    { tabla: 'devoluciones_oficina', titulo: 'Devolución a oficina', orden: 'id' },
    { tabla: 'inventario_items', titulo: 'Inventario (configuración)', orden: 'id' },
    { tabla: 'inventario', titulo: 'Inventario (saldos)', orden: 'tienda' },
    { tabla: 'inventario_movimientos', titulo: 'Inventario (movimientos)', orden: 'fecha' },
    { tabla: 'caja_menor', titulo: 'Caja menor', orden: 'usuario_id,fecha,id' },
    { tabla: 'tiendas', titulo: 'Maestro: Tiendas', orden: 'orden' },
    { tabla: 'vendedores', titulo: 'Maestro: Vendedores', orden: 'orden' },
    { tabla: 'tipos', titulo: 'Maestro: Tipos', orden: 'orden' },
    { tabla: 'productos', titulo: 'Referencias (productos)', orden: 'orden' },
    { tabla: 'metodos_pago', titulo: 'Maestro: Métodos de pago', orden: 'orden' },
    { tabla: 'departamentos', titulo: 'Maestro: Departamentos', orden: 'orden' },
    { tabla: 'perfiles', titulo: 'Usuarios', orden: 'nombre' },
    { tabla: 'coordenadas', titulo: 'Coordenadas', orden: 'departamento' },
];
const MAX_FILAS_PANTALLA = 500;
const tablaDatosActual = () => TABLAS_DATOS[Number($('datosTabla').value) || 0];

function loadDatos() {
    const t = tablaDatosActual();
    run(async () => {
        datosFilas = await fetchAll(() => t.orden.split(',').reduce((q, c) => q.order(c), sb.from(t.tabla).select('*')));
        filterDatos();
    });
}

function datosFiltrados() {
    const q = norm($('filterDatos').value);
    return q ? datosFilas.filter(r => Object.values(r).some(v => norm(v).includes(q))) : datosFilas;
}

function filterDatos() {
    const d = datosFiltrados();
    const cols = datosFilas.length ? Object.keys(datosFilas[0]) : [];
    $('datosTableHead').innerHTML = `<tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
    $('datosTableBody').innerHTML = d.slice(0, MAX_FILAS_PANTALLA).map(r =>
        `<tr>${cols.map(c => `<td class="${typeof r[c] === 'number' ? 'num' : ''}">${esc(r[c])}</td>`).join('')}</tr>`).join('');
    $('datosInfo').textContent = `${d.length} de ${datosFilas.length} registros` +
        (d.length > MAX_FILAS_PANTALLA ? ` (se muestran los primeros ${MAX_FILAS_PANTALLA}; la exportación incluye todos)` : '');
}

function exportDatos() {
    const t = tablaDatosActual();
    // Las fechas yyyy-mm-dd se exportan como fechas de Excel
    exportarExcel(t.titulo.replace(/[^\wÁÉÍÓÚáéíóúñÑ]+/g, '_'), t.titulo, datosFiltrados().map(r =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [k, /^\d{4}-\d{2}-\d{2}$/.test(v ?? '') ? aFecha(v) : v]))));
}

// ---------------------------------------------------------------- historial del administrador
// Ver, editar y eliminar cualquier registro. Tipos de campo: texto, larga, fecha, fechahora, num,
// dinero, codigo, tienda, vendedor, tipo, metodo, departamento, usuario, solo (no editable) o una lista.
const HISTORIALES = [
    { id: 'ventas', titulo: 'Ventas', tabla: 'ventas', fecha: 'fecha_venta', porCodigo: 'cliente_id', orden: [['fecha_venta', false], ['id', false]],
      campos: [['id', 'N°', 'solo'], ['fecha_venta', 'Fecha', 'fecha'], ['pedido_id', 'Pedido'], ['envio', 'Envío'], ['factura', 'Factura'],
               ['tienda', 'Tienda / Bodega', 'tienda'], ['vendedor', 'Vendedor', 'vendedor'], ['cliente_id', 'Código cliente', 'codigo'],
               ['cliente', 'Cliente'], ['documento_cliente', 'DPI / NIT'], ['tipo', 'Tipo (material)', 'tipo'], ['forma_pago', 'Forma de pago', ['CREDITO', 'EFECTIVO']], ['cantidad', 'Cantidad', 'num'],
               ['valor_unitario', 'Valor unitario', 'dinero'], ['valor_total', 'Valor total', 'dinero'], ['fecha_vencimiento', 'Vencimiento', 'fecha'],
               ['nota_importacion', 'Nota', 'larga'], ['creado_por', 'Registrado por', 'usuario'], ['created_at', 'Creado el', 'solo-fechahora']] },
    { id: 'pagos', titulo: 'Pagos recibidos', tabla: 'pagos', fecha: 'fecha_pago', porCodigo: 'cliente_id', orden: [['fecha_pago', false], ['id', false]],
      campos: [['id', 'N°', 'solo'], ['fecha_pago', 'Fecha de pago', 'fecha'], ['cliente_id', 'Código cliente', 'codigo'], ['envio', 'Envío'],
               ['metodo_pago', 'Método de pago', 'metodo'], ['valor_pagado', 'Valor', 'dinero'], ['boleta', 'Boleta'], ['factura', 'Factura'],
               ['vendedor', 'Vendedor', 'vendedor'], ['nit', 'NIT'], ['confirmacion', 'Confirmación'], ['contabilidad', 'Contabilidad'],
               ['observaciones', 'Observaciones', 'larga'], ['creado_por', 'Registrado por', 'usuario'], ['created_at', 'Creado el', 'solo-fechahora']] },
    { id: 'compras', titulo: 'Compras y cargas de inventario', tabla: 'ingresos_inventario', fecha: 'fecha', orden: [['fecha', false], ['id', false]],
      campos: [['id', 'N°', 'solo'], ['fecha', 'Fecha', 'fecha'], ['tienda', 'Tienda / Bodega', 'tienda'], ['producto', 'Tipo (material)', 'tipo'],
               ['concepto', 'Concepto'], ['entrada', 'Entrada', 'num'], ['salida', 'Salida', 'num'], ['observaciones', 'Observaciones', 'larga'],
               ['traslado_id', 'N° traslado', 'solo'], ['creado_por', 'Registrado por', 'usuario'], ['created_at', 'Creado el', 'solo-fechahora']] },
    { id: 'traslados', titulo: 'Traslados entre bodegas', tabla: 'traslados', fecha: 'fecha_envio', orden: [['id', false]],
      nota: 'Al eliminar un traslado también se eliminan sus movimientos de inventario. Editarlo no cambia esos movimientos: revíselos en "Compras y cargas".',
      campos: [['id', 'N°', 'solo'], ['fecha_envio', 'Fecha de envío', 'fecha'], ['origen', 'Origen', 'tienda'], ['destino', 'Destino', 'tienda'],
               ['producto', 'Tipo (material)', 'tipo'], ['cantidad', 'Cantidad', 'num'], ['estado', 'Estado', ['ENVIADO', 'RECIBIDO', 'ANULADO']],
               ['observaciones', 'Observaciones', 'larga'], ['enviado_por', 'Envió', 'usuario'], ['fecha_recepcion', 'Recibido el', 'fechahora'],
               ['recibido_por', 'Recibió', 'usuario'], ['obs_recepcion', 'Observaciones de recepción', 'larga']] },
    { id: 'devoluciones', titulo: 'Devoluciones de clientes', tabla: 'devoluciones', fecha: 'fecha_devolucion', orden: [['fecha_devolucion', false], ['id', false]],
      campos: [['id', 'N°', 'solo'], ['fecha_devolucion', 'Fecha', 'fecha'], ['tienda', 'Tienda / Bodega', 'tienda'], ['pedido_id', 'Pedido'],
               ['envio', 'Envío'], ['factura', 'Factura'], ['producto', 'Tipo (material)', 'tipo'], ['valor', 'Valor', 'dinero'],
               ['gramos', 'Gramos', 'num'], ['motivo', 'Motivo', 'larga'], ['creado_por', 'Registrado por', 'usuario']] },
    { id: 'devoluciones_oficina', titulo: 'Devoluciones a oficina', tabla: 'devoluciones_oficina', fecha: 'fecha_devolucion', orden: [['fecha_devolucion', false], ['id', false]],
      campos: [['id', 'N°', 'solo'], ['fecha_devolucion', 'Fecha', 'fecha'], ['tienda', 'Tienda / Bodega', 'tienda'],
               ['producto', 'Tipo (material)', 'tipo'], ['cantidad', 'Cantidad', 'num']] },
    { id: 'caja', titulo: 'Caja menor', tabla: 'caja_menor', fecha: 'fecha', orden: [['fecha', false], ['id', false]],
      nota: 'Las entradas por venta en efectivo (origen VENTA) siguen a su pedido: al editar o eliminar la venta se ajustan solas.',
      campos: [['id', 'N°', 'solo'], ['fecha', 'Fecha', 'fecha'], ['usuario_id', 'Caja de', 'usuario'], ['tipo', 'Movimiento', ['ENTRADA', 'SALIDA']],
               ['origen', 'Origen', 'solo'], ['valor', 'Valor', 'dinero'], ['concepto', 'Concepto'], ['observaciones', 'Observaciones', 'larga'],
               ['pedido_id', 'Pedido', 'solo'], ['creado_por', 'Registrado por', 'usuario'], ['created_at', 'Creado el', 'solo-fechahora']] },
    { id: 'clientes', titulo: 'Clientes', tabla: 'clientes', fecha: 'created_at', porCodigo: 'id', orden: [['id']],
      nota: 'Si cambia el dueño a un vendedor con rango, el cliente pasa a un código de ese rango. Al eliminar un cliente, sus ventas y pagos se conservan con el código anterior.',
      campos: [['id', 'Código', 'solo'], ['consecutivo', 'Consecutivo', 'num'], ['nombre', 'Nombre'], ['tipo_cliente', 'Tipo de cliente', ['MINORISTA', 'MAYORISTA']],
               ['dpi', 'DPI'], ['nit', 'NIT'], ['nit2', 'NIT 2'], ['telefono', 'Teléfono'], ['telefono2', 'Otro teléfono'], ['correo', 'Correo'],
               ['direccion', 'Dirección', 'larga'], ['departamento', 'Departamento', 'departamento'], ['fecha_nacimiento', 'Fecha de nacimiento', 'fecha'],
               ['codigo_cliente', 'Referencia anterior'], ['creado_por', 'Vendedor dueño', 'usuario'], ['nota_importacion', 'Nota', 'larga'],
               ['created_at', 'Creado el', 'solo-fechahora']] },
    { id: 'saldos_inventario', titulo: 'Saldos de inventario (solo lectura)', tabla: 'inventario', soloLectura: true, orden: [['tienda'], ['producto']],
      nota: 'Los saldos se calculan con las cargas, traslados y ventas: para corregirlos edite esos registros.',
      campos: [['tienda', 'Tienda / Bodega'], ['producto', 'Tipo (material)'], ['unidad', 'Unidad'], ['fecha_inicio', 'Control desde', 'fecha'],
               ['entradas', 'Entradas', 'num'], ['salidas', 'Salidas', 'num'], ['saldo', 'Saldo', 'num']] },
    { id: 'saldos_cartera', titulo: 'Saldos de cartera por cliente (solo lectura)', tabla: 'cartera_clientes', soloLectura: true, porCodigo: 'codigo', orden: [['codigo']],
      nota: 'La cartera se calcula con las ventas, pagos y devoluciones: para corregirla edite esos registros.',
      campos: [['codigo', 'Código', 'codigo'], ['nombre', 'Cliente'], ['vendedor', 'Vendedor'], ['total_ventas', 'Compras', 'dinero'],
               ['total_pagos', 'Pagos', 'dinero'], ['saldo', 'Saldo', 'dinero'], ['ultima_venta', 'Última venta', 'fecha'], ['ultimo_pago', 'Último pago', 'fecha']] },
].map(h => ({ ...h, campos: h.campos.map(([campo, titulo, tipo = 'texto']) => ({ campo, titulo, tipo })) }));

let hisFilas = [], hisEditando = null, historialModal;
const historialActual = () => HISTORIALES.find(h => h.id === $('hisTabla').value) || HISTORIALES[0];

function construirHistorialAdmin() {
    historialModal = new bootstrap.Modal($('historialModal'));
    $('hisTabla').innerHTML = HISTORIALES.map(h => `<option value="${h.id}">${h.titulo}</option>`).join('');
    $('hisTabla').addEventListener('change', cargarHistorialAdmin);
    ['hisDesde', 'hisHasta'].forEach(id => $(id).addEventListener('change', cargarHistorialAdmin));
    $('hisBuscar').addEventListener('input', renderHistorialAdmin);
    $('hisExportar').addEventListener('click', exportarHistorialAdmin);
    $('hisBody').addEventListener('click', e => {
        const b = e.target.closest('[data-accion]');
        if (!b) return;
        const fila = hisFilas.find(r => String(r.id) === b.dataset.id);
        if (b.dataset.accion === 'editar') abrirEdicionHistorial(fila); else eliminarRegistroHistorial(fila);
    });
    $('hisGuardar').addEventListener('click', guardarEdicionHistorial);
    $('hisEliminarModal').addEventListener('click', () => eliminarRegistroHistorial(hisEditando));
    // Ventas: el total se recalcula al cambiar cantidad o valor unitario
    $('hisCampos').addEventListener('input', e => {
        if (historialActual().tabla !== 'ventas' || !['cantidad', 'valor_unitario'].includes(e.target.name)) return;
        const v = n => num($('hisForm').elements[n].value);
        $('hisForm').elements.valor_total.value = (v('cantidad') * v('valor_unitario')).toFixed(2);
    });
}

function cargarHistorialAdmin() {
    const h = historialActual();
    document.querySelectorAll('#historialAdmin .his-fecha').forEach(e => e.classList.toggle('d-none', !h.fecha));
    $('hisNota').textContent = h.nota || (h.soloLectura ? '' : 'Puede editar o eliminar cualquier registro con los botones de cada fila. No se puede deshacer.');
    const desde = $('hisDesde').value, hasta = $('hisHasta').value;
    run(async () => {
        const filas = await fetchAll(() => {
            let q = sb.from(h.tabla).select('*');
            if (h.fecha && desde) q = q.gte(h.fecha, desde);
            if (h.fecha && hasta) q = h.fecha === 'created_at' ? q.lt(h.fecha, sumarDia(hasta)) : q.lte(h.fecha, hasta);
            return h.orden.reduce((q2, [c, asc = true]) => q2.order(c, { ascending: asc }), q);
        });
        if (!perfiles.length) await cargarPerfiles();
        hisFilas = h.porCodigo ? ordenarPorCodigo(filas, h.porCodigo) : filas;
        renderHistorialAdmin();
    });
}

function valorHistorial(c, v) {
    if (v === null || v === undefined || v === '') return '';
    switch (c.tipo) {
        case 'fecha': return fmtFecha(v);
        case 'fechahora': case 'solo-fechahora': return new Date(v).toLocaleString('es-GT', { timeZone: CFG.ZONA_HORARIA, dateStyle: 'short', timeStyle: 'short' });
        case 'num': return fmt(v);
        case 'dinero': return fmtQ(v);
        case 'usuario': return nombreUsuario(v) || String(v).slice(0, 8);
        default: return String(v);
    }
}

function historialFiltrado() {
    const h = historialActual(), q = norm($('hisBuscar').value);
    return q ? hisFilas.filter(r => h.campos.some(c => norm(valorHistorial(c, r[c.campo])).includes(q))) : hisFilas;
}

const MAX_FILAS_HISTORIAL = 500;
function renderHistorialAdmin() {
    const h = historialActual(), d = historialFiltrado();
    const derecha = c => ['num', 'dinero', 'codigo'].includes(c.tipo) || c.campo === 'id' ? ' class="num"' : '';
    $('hisHead').innerHTML = `<tr>${h.campos.map(c => `<th${derecha(c)}>${esc(c.titulo)}</th>`).join('')}${h.soloLectura ? '' : '<th></th>'}</tr>`;
    $('hisBody').innerHTML = d.slice(0, MAX_FILAS_HISTORIAL).map(r => `<tr>${h.campos.map(c =>
        `<td${derecha(c)}${c.tipo === 'larga' ? ' class="text-truncate" style="max-width: 220px"' : ''}>${esc(valorHistorial(c, r[c.campo]))}</td>`).join('')}
        ${h.soloLectura ? '' : `<td class="text-nowrap text-end">
          <button type="button" class="btn btn-outline-secondary btn-sm" data-accion="editar" data-id="${r.id}" title="Editar"><i class="bi bi-pencil"></i></button>
          <button type="button" class="btn btn-outline-danger btn-sm" data-accion="eliminar" data-id="${r.id}" title="Eliminar"><i class="bi bi-trash"></i></button></td>`}</tr>`).join('')
        || `<tr><td colspan="${h.campos.length + 1}" class="text-muted">Sin registros</td></tr>`;
    $('hisInfo').textContent = `${d.length} registro(s)` + (d.length > MAX_FILAS_HISTORIAL ? ` · en pantalla se muestran ${MAX_FILAS_HISTORIAL}; use el buscador o las fechas (el Excel incluye todos)` : '');
}

function exportarHistorialAdmin() {
    const h = historialActual();
    exportarExcel(`Historial_${h.id}`, h.titulo, historialFiltrado().map(r => Object.fromEntries(h.campos.map(c => {
        const v = r[c.campo];
        if (v === null || v === undefined || v === '') return [c.titulo, null];
        if (c.tipo === 'fecha') return [c.titulo, aFecha(v)];
        if (['num', 'dinero'].includes(c.tipo)) return [c.titulo, num(v)];
        return [c.titulo, valorHistorial(c, v)];
    }))));
}

// datetime-local <-> ISO
const aFechaHoraLocal = v => { if (!v) return ''; const d = new Date(v); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

function opcionesCampo(c, actual) {
    const listas = { tienda: 'tiendas', vendedor: 'vendedores', tipo: 'tipos', metodo: 'metodos_pago', departamento: 'departamentos' };
    let ops;
    if (Array.isArray(c.tipo)) ops = c.tipo.map(v => [v, v]);
    else if (c.tipo === 'usuario') ops = perfiles.map(p => [p.id, p.nombre || p.usuario]);
    else ops = maestros[listas[c.tipo]].map(x => [x.nombre, x.nombre + (x.activo === false ? ' (inactivo)' : '')]);
    if (actual && !ops.some(([v]) => v === actual)) ops.push([actual, actual]);
    return `<option value="">(vacío)</option>` + ops.map(([v, t]) => `<option value="${esc(v)}" ${v === actual ? 'selected' : ''}>${esc(t)}</option>`).join('');
}

function abrirEdicionHistorial(r) {
    const h = historialActual();
    hisEditando = r;
    $('hisModalTitulo').textContent = `Editar · ${h.titulo} · N° ${r.id}`;
    $('hisCampos').innerHTML = h.campos.map(c => {
        const v = r[c.campo], id = `his-${c.campo}`;
        const etiqueta = `<label class="form-label" for="${id}">${esc(c.titulo)}</label>`;
        let control;
        if (c.tipo === 'solo' || c.tipo === 'solo-fechahora')
            control = `<input type="text" class="form-control" id="${id}" value="${esc(valorHistorial(c, v))}" disabled>`;
        else if (Array.isArray(c.tipo) || ['tienda', 'vendedor', 'tipo', 'metodo', 'departamento', 'usuario'].includes(c.tipo))
            control = `<select class="form-select" id="${id}" name="${c.campo}">${opcionesCampo(c, v ?? '')}</select>`;
        else if (c.tipo === 'larga')
            control = `<textarea class="form-control" id="${id}" name="${c.campo}" rows="2">${esc(v ?? '')}</textarea>`;
        else {
            const tipoInput = { fecha: 'date', fechahora: 'datetime-local', num: 'number', dinero: 'number', codigo: 'number' }[c.tipo] || 'text';
            const valor = c.tipo === 'fecha' ? String(v ?? '').slice(0, 10) : c.tipo === 'fechahora' ? aFechaHoraLocal(v) : (v ?? '');
            control = `<input type="${tipoInput}" class="form-control" id="${id}" name="${c.campo}" value="${esc(valor)}"${tipoInput === 'number' ? ' step="any"' : ''}>`;
        }
        return `<div class="${c.tipo === 'larga' ? 'col-12' : 'col-md-6 col-lg-4'}">${etiqueta}${control}</div>`;
    }).join('');
    historialModal.show();
}

// Solo se envían los campos que cambiaron
function cambiosHistorial() {
    const h = historialActual(), r = hisEditando, datos = {};
    for (const c of h.campos) {
        const el = $('hisForm').elements[c.campo];
        if (!el) continue;
        let nuevo = el.value.trim();
        let antes = r[c.campo] ?? '';
        if (c.tipo === 'fecha') antes = String(antes).slice(0, 10);
        if (c.tipo === 'fechahora') antes = aFechaHoraLocal(antes);
        if (['num', 'dinero', 'codigo'].includes(c.tipo)) { if (nuevo !== '' && antes !== '' && Number(nuevo) === Number(antes)) continue; }
        if (String(nuevo) === String(antes)) continue;
        datos[c.campo] = nuevo === '' ? null
            : ['num', 'dinero', 'codigo'].includes(c.tipo) ? Number(nuevo)
            : c.tipo === 'fechahora' ? new Date(nuevo).toISOString() : nuevo;
    }
    return datos;
}

function guardarEdicionHistorial() {
    const h = historialActual(), datos = cambiosHistorial();
    if (!Object.keys(datos).length) { historialModal.hide(); showAlert('No hubo cambios', 'info'); return; }
    run(async () => {
        const fila = ok(await sb.rpc('admin_editar_registro', { p_tabla: h.tabla, p_id: hisEditando.id, p_datos: datos }));
        const i = hisFilas.findIndex(x => x.id === hisEditando.id);
        if (i >= 0) hisFilas[i] = { ...hisFilas[i], ...fila };
        historialModal.hide();
        renderHistorialAdmin();
        showAlert(`Registro N° ${hisEditando.id} actualizado${fila?.id !== undefined && fila.id !== hisEditando.id ? ` (ahora N° ${fila.id})` : ''}`, 'success');
    });
}

function eliminarRegistroHistorial(r) {
    const h = historialActual();
    if (!r) return;
    const resumen = h.campos.filter(c => c.campo !== 'id').slice(0, 4).map(c => valorHistorial(c, r[c.campo])).filter(Boolean).join(' · ');
    const extra = h.tabla === 'traslados' ? '\n\nTambién se eliminarán sus movimientos de inventario.'
        : h.tabla === 'clientes' ? '\n\nSus ventas y pagos se conservan, pero quedarán sin cliente.' : '';
    if (!confirm(`¿Eliminar definitivamente el registro N° ${r.id} de ${h.titulo}?\n${resumen}${extra}\n\nNo se puede deshacer.`)) return;
    run(async () => {
        ok(await sb.rpc('admin_eliminar_registro', { p_tabla: h.tabla, p_id: r.id }));
        hisFilas = hisFilas.filter(x => x.id !== r.id);
        if (hisEditando?.id === r.id) historialModal.hide();
        renderHistorialAdmin();
        showAlert(`Registro N° ${r.id} eliminado`, 'success');
    });
}

// ---------------------------------------------------------------- reportes (columnas a elección)
// Cada reporte: de dónde salen los datos, qué campo es la fecha y la tienda (para filtrar)
// y sus columnas. tipo: texto | fecha | fechahora | num | dinero | codigo. def: va marcada por defecto.
const REPORTES = [
    {
        id: 'ventas', grupo: 'Ventas', titulo: 'Ventas (detalle por línea)', fuente: 'ventas', fecha: 'fecha_venta', tienda: 'tienda',
        descripcion: 'Cada línea vendida, con su pedido, cliente, tipo y valores.',
        orden: [['fecha_venta', false], ['id', false]], porCodigo: 'cliente_id',
        opciones: [{ id: 'saldosIniciales', texto: 'Incluir saldos iniciales de clientes', excluir: r => r.producto === 'SALDO INICIAL' }],
        columnas: [
            ['fecha_venta', 'Fecha', 'fecha', 1], ['pedido_id', 'Pedido', 'texto', 1], ['envio', 'Envío', 'texto', 1], ['factura', 'Factura'],
            ['tienda', 'Tienda / Bodega', 'texto', 1], ['vendedor', 'Vendedor', 'texto', 1], ['cliente_id', 'Código cliente', 'codigo', 1],
            ['cliente', 'Cliente', 'texto', 1], ['_tipo_cliente', 'Tipo de cliente'], ['_departamento', 'Departamento'],
            ['_dueno', 'Dueño del cliente', 'texto', 0, 'admin'], ['tipo', 'Tipo (material)', 'texto', 1],
            ['forma_pago', 'Forma de pago', 'texto', 1], ['_unidad', 'Unidad'], ['cantidad', 'Cantidad', 'num', 1], ['valor_unitario', 'Valor unitario', 'dinero', 1],
            ['valor_total', 'Valor total', 'dinero', 1], ['fecha_vencimiento', 'Vencimiento', 'fecha'], ['created_at', 'Registrado el', 'fechahora'],
        ],
    },
    {
        id: 'pagos', grupo: 'Ventas', titulo: 'Pagos recibidos', fuente: 'pagos_detalle', fecha: 'fecha_pago',
        descripcion: 'Pagos y abonos de clientes: cuándo, cómo y quién los registró.',
        orden: [['fecha_pago', false], ['id', false]], porCodigo: 'cliente_id',
        columnas: [
            ['fecha_pago', 'Fecha de pago', 'fecha', 1], ['cliente_id', 'Código cliente', 'codigo', 1], ['cliente', 'Cliente', 'texto', 1],
            ['_dueno', 'Dueño del cliente', 'texto', 0, 'admin'], ['metodo_pago', 'Método de pago', 'texto', 1], ['valor_pagado', 'Valor', 'dinero', 1],
            ['boleta', 'Boleta', 'texto', 1], ['envio', 'Envío'], ['vendedor', 'Vendedor'], ['registrado_por', 'Registrado por', 'texto', 1],
            ['observaciones', 'Observaciones'], ['created_at', 'Registrado el', 'fechahora'],
        ],
    },
    {
        id: 'compras', grupo: 'Inventario', titulo: 'Compras y cargas de inventario', fuente: 'ingresos_inventario', fecha: 'fecha', tienda: 'tienda',
        descripcion: 'Entradas (compras, inventario inicial, traslados recibidos) y salidas manuales registradas en Cargar Inventario.',
        orden: [['fecha', false], ['id', false]],
        opciones: [{ id: 'soloEntradas', texto: 'Solo entradas (compras)', incluir: r => num(r.entrada) > 0 }],
        columnas: [
            ['fecha', 'Fecha', 'fecha', 1], ['tienda', 'Tienda / Bodega', 'texto', 1], ['producto', 'Tipo (material)', 'texto', 1],
            ['_unidad', 'Unidad', 'texto', 1], ['concepto', 'Concepto', 'texto', 1], ['entrada', 'Entrada', 'num', 1], ['salida', 'Salida', 'num', 1],
            ['_origen', 'Origen'], ['traslado_id', 'N° traslado'], ['observaciones', 'Observaciones', 'texto', 1], ['created_at', 'Registrado el', 'fechahora'],
        ],
    },
    {
        id: 'inventario', grupo: 'Inventario', titulo: 'Saldos de inventario', fuente: 'inventario', tienda: 'tienda',
        descripcion: 'Saldo actual por tienda/bodega y tipo (entradas menos ventas y salidas).',
        orden: [['tienda'], ['producto']],
        opciones: [{ id: 'conSaldo', texto: 'Solo con saldo distinto de cero', incluir: r => Math.abs(num(r.saldo)) > 0.005 }],
        columnas: [
            ['tienda', 'Tienda / Bodega', 'texto', 1], ['producto', 'Tipo (material)', 'texto', 1],
            ['unidad', 'Unidad', 'texto', 1], ['fecha_inicio', 'Control desde', 'fecha'], ['entradas', 'Entradas', 'num', 1],
            ['salidas', 'Salidas', 'num', 1], ['saldo', 'Saldo', 'num', 1],
        ],
    },
    {
        id: 'movimientos', grupo: 'Inventario', titulo: 'Movimientos de inventario (kardex)', fuente: 'inventario_movimientos', fecha: 'fecha', tienda: 'tienda',
        descripcion: 'Todas las entradas y salidas: cargas, traslados, ventas y devoluciones a oficina.',
        orden: [['fecha', false], ['origen_id', false]],
        columnas: [
            ['fecha', 'Fecha', 'fecha', 1], ['tienda', 'Tienda / Bodega', 'texto', 1], ['producto', 'Tipo (material)', 'texto', 1], ['_unidad', 'Unidad'],
            ['origen', 'Origen', 'texto', 1], ['detalle', 'Detalle', 'texto', 1], ['entrada', 'Entrada', 'num', 1], ['salida', 'Salida', 'num', 1],
        ],
    },
    {
        id: 'traslados', grupo: 'Inventario', titulo: 'Traslados entre bodegas', fuente: 'traslados', fecha: 'fecha_envio', tienda: ['origen', 'destino'],
        descripcion: 'Envíos entre bodegas con su estado (enviado, recibido o anulado).',
        orden: [['id', false]],
        columnas: [
            ['id', 'N° traslado', 'texto', 1], ['fecha_envio', 'Fecha de envío', 'fecha', 1], ['origen', 'Origen', 'texto', 1], ['destino', 'Destino', 'texto', 1],
            ['producto', 'Tipo (material)', 'texto', 1], ['cantidad', 'Cantidad', 'num', 1], ['estado', 'Estado', 'texto', 1], ['observaciones', 'Observaciones'],
            ['fecha_recepcion', 'Recibido el', 'fechahora', 1], ['obs_recepcion', 'Observaciones de recepción'],
        ],
    },
    {
        id: 'cartera', grupo: 'Cartera', titulo: 'Cartera por cliente', fuente: 'cartera_clientes',
        descripcion: 'Compras, pagos y saldo pendiente de cada cliente.',
        orden: [['codigo']], porCodigo: 'codigo',
        opciones: [{ id: 'conSaldo', texto: 'Solo clientes con saldo pendiente', incluir: r => num(r.saldo) > 0.005, def: true }],
        columnas: [
            ['codigo', 'Código cliente', 'codigo', 1], ['nombre', 'Cliente', 'texto', 1], ['vendedor', 'Vendedor', 'texto', 1, 'admin'],
            ['dpi', 'DPI'], ['nit', 'NIT'], ['telefono', 'Teléfono', 'texto', 1], ['total_ventas', 'Compras', 'dinero', 1],
            ['total_pagos', 'Pagos', 'dinero', 1], ['saldo', 'Saldo', 'dinero', 1], ['ultima_venta', 'Última venta', 'fecha', 1], ['ultimo_pago', 'Último pago', 'fecha', 1],
        ],
    },
    {
        id: 'cartera_envio', grupo: 'Cartera', titulo: 'Cartera por envío', fuente: 'cartera_detalle', fecha: 'fecha_venta', tienda: 'tienda',
        descripcion: 'Saldo de cada envío: valor vendido menos pagos y devoluciones aplicados a ese envío.',
        orden: [['fecha_venta', false], ['envio']], porCodigo: 'cliente_id',
        opciones: [{ id: 'conSaldo', texto: 'Solo envíos con saldo pendiente', incluir: r => num(r.cartera) > 0.005, def: true }],
        columnas: [
            ['fecha_venta', 'Fecha', 'fecha', 1], ['tienda', 'Tienda / Bodega', 'texto', 1], ['cliente_id', 'Código cliente', 'codigo', 1],
            ['cliente', 'Cliente', 'texto', 1], ['vendedor', 'Vendedor', 'texto', 1, 'admin'], ['envio', 'Envío', 'texto', 1],
            ['valor_venta', 'Venta', 'dinero', 1], ['valor_pago', 'Pagos', 'dinero', 1], ['cartera', 'Saldo', 'dinero', 1],
        ],
    },
    {
        id: 'estado_cuenta', grupo: 'Cartera', titulo: 'Estado de cuenta (todos los clientes)', fuente: 'estado_cuenta', fecha: 'fecha',
        descripcion: 'Cargos (ventas) y abonos (pagos y devoluciones) de todos los clientes, en orden.',
        orden: [['cliente_id'], ['fecha'], ['ref_id']], porCodigo: 'cliente_id',
        columnas: [
            ['cliente_id', 'Código cliente', 'codigo', 1], ['_cliente', 'Cliente', 'texto', 1], ['fecha', 'Fecha', 'fecha', 1],
            ['movimiento', 'Movimiento', 'texto', 1], ['detalle', 'Detalle', 'texto', 1], ['metodo_pago', 'Método de pago'],
            ['cargo', 'Cargo', 'dinero', 1], ['abono', 'Abono', 'dinero', 1],
        ],
    },
    {
        // Datos del cuadre (solo administrador): un registro por mes y vendedor
        id: 'comisiones', grupo: 'Comisiones', titulo: 'Comisiones por vendedor (mensual)', soloAdmin: true, fecha: 'mes', tienda: 'tienda',
        descripcion: 'Por cada mes, vendedor y esquema: ventas y meta evaluadas (las del grupo en esquemas grupales), cumplimiento, tramo aplicado y comisión. Quien tiene varios esquemas sale en varias filas. Las fechas eligen los meses (sin fechas: últimos 12 meses).',
        orden: [],
        opciones: [{ id: 'conMovimiento', texto: 'Solo vendedores con ventas o comisión en el mes', incluir: r => num(r.ventas_q) > 0 || num(r.comision) > 0, def: true }],
        cargar: async ({ desde, hasta, tienda }) => {
            const hoy = hoyISO();
            const ini = desde || new Date(Date.UTC(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)) - 12, 1)).toISOString().slice(0, 10);
            const filas = ok(await sb.rpc('cuadre_tiendas', { p_desde: ini, p_hasta: hasta || hoy, p_tienda: tienda || null }));
            return filas.filter(r => r.dimension === 'comision')
                .map(r => ({ ...r, mes: String(r.mes).slice(0, 10), _mes: nombreMes(String(r.mes).slice(0, 10)) }))
                .sort((a, b) => b.mes.localeCompare(a.mes) || a.clave.localeCompare(b.clave) || String(a.esquema).localeCompare(String(b.esquema)));
        },
        columnas: [
            ['_mes', 'Mes', 'texto', 1], ['clave', 'Vendedor', 'texto', 1], ['esquema', 'Esquema', 'texto', 1],
            ['ventas_q', 'Ventas evaluadas', 'dinero', 1], ['meta', 'Meta evaluada', 'dinero', 1],
            ['cumplimiento', 'Cumplimiento', 'pct', 1], ['comision_pct', 'Tramo aplicado', 'pct', 1], ['comision', 'Comisión', 'dinero', 1],
        ],
    },
    {
        id: 'caja', grupo: 'Caja menor', titulo: 'Caja menor (movimientos)', fuente: 'caja_menor_detalle', fecha: 'fecha',
        descripcion: 'Entradas (ventas en efectivo y manuales) y salidas de la caja menor de cada usuario.',
        orden: [['fecha', false], ['id', false]],
        columnas: [
            ['fecha', 'Fecha', 'fecha', 1], ['usuario', 'Caja de', 'texto', 1], ['tienda', 'Tienda / Bodega'], ['tipo', 'Movimiento', 'texto', 1],
            ['origen', 'Origen', 'texto', 1], ['concepto', 'Concepto', 'texto', 1], ['pedido_id', 'Pedido'], ['valor', 'Valor', 'dinero', 1],
            ['observaciones', 'Observaciones'], ['registrado_por', 'Registrado por'], ['created_at', 'Registrado el', 'fechahora'],
        ],
    },
    {
        id: 'clientes', grupo: 'Clientes', titulo: 'Listado de clientes', fuente: 'clientes', fecha: 'created_at',
        descripcion: 'Datos de los clientes. El filtro de fechas se aplica a la fecha de creación.',
        orden: [['id']], porCodigo: 'id',
        columnas: [
            ['id', 'Código cliente', 'codigo', 1], ['nombre', 'Nombre', 'texto', 1], ['tipo_cliente', 'Tipo de cliente', 'texto', 1],
            ['dpi', 'DPI', 'texto', 1], ['nit', 'NIT', 'texto', 1], ['telefono', 'Teléfono', 'texto', 1], ['telefono2', 'Otro teléfono'],
            ['correo', 'Correo'], ['direccion', 'Dirección'], ['departamento', 'Departamento', 'texto', 1], ['fecha_nacimiento', 'Fecha de nacimiento', 'fecha'],
            ['_dueno', 'Vendedor dueño', 'texto', 1, 'admin'], ['created_at', 'Creado el', 'fechahora'],
        ],
    },
].map(r => ({ ...r, columnas: r.columnas.map(([campo, titulo, tipo = 'texto', def = 0, solo]) => ({ campo, titulo, tipo, def: !!def, solo })) }));

let repFilas = [], repColumnas = [];   // filas del último reporte generado y columnas en su orden
let repGenerado = false;
const reporteActual = () => REPORTES.find(r => r.id === $('repTipo').value) || REPORTES[0];
const columnasDisponibles = rep => rep.columnas.filter(c => c.solo !== 'admin' || veEquipo());
const claveColumnas = rep => `ariga.reporte.${rep.id}`;

function pintarTiposReporte() {
    const v = $('repTipo').value;
    const lista = REPORTES.filter(r => !r.soloAdmin || esAdmin());
    const grupos = [...new Set(lista.map(r => r.grupo))];
    $('repTipo').innerHTML = grupos.map(g => `<optgroup label="${g}">${lista.filter(r => r.grupo === g)
        .map(r => `<option value="${r.id}">${r.titulo}</option>`).join('')}</optgroup>`).join('');
    if (lista.some(r => r.id === v)) $('repTipo').value = v;
}

function construirReportes() {
    pintarTiposReporte();
    $('repTipo').addEventListener('change', () => elegirReporte(true));
    $('repGenerar').addEventListener('click', generarReporte);
    $('repExportar').addEventListener('click', exportarReporte);
    $('repBuscar').addEventListener('input', renderReporte);
    $('repOpciones').addEventListener('change', renderReporte);
    $('repColumnas').addEventListener('change', e => { if (e.target.matches('input[type=checkbox]')) columnasCambiaron(); });
    $('repColumnas').addEventListener('click', e => {
        const b = e.target.closest('[data-mover]');
        if (!b) return;
        const li = b.closest('li'), otro = b.dataset.mover === 'arriba' ? li.previousElementSibling : li.nextElementSibling;
        if (!otro) return;
        if (b.dataset.mover === 'arriba') li.parentNode.insertBefore(li, otro); else li.parentNode.insertBefore(otro, li);
        b.focus();
        columnasCambiaron();
    });
    const marcar = fn => e => { e.preventDefault(); $('repColumnas').querySelectorAll('li').forEach(li => li.querySelector('input').checked = fn(li.dataset.campo)); columnasCambiaron(); };
    $('repColTodas').addEventListener('click', marcar(() => true));
    $('repColNinguna').addEventListener('click', marcar(() => false));
    $('repColDefecto').addEventListener('click', e => {
        e.preventDefault();
        try { localStorage.removeItem(claveColumnas(reporteActual())); } catch { /* sin almacenamiento */ }
        pintarColumnas(reporteActual());
        columnasCambiaron();
    });
    $('reportes-tab').addEventListener('shown.bs.tab', () => {
        const antes = $('repTipo').value;
        pintarTiposReporte();
        if (!$('repColumnas').children.length || $('repTipo').value !== antes) elegirReporte(!!$('repColumnas').children.length);
    });
}

// Al cambiar de reporte: filtros que aplican, opciones y columnas (las guardadas o las de defecto)
function elegirReporte(limpiar) {
    const rep = reporteActual();
    $('repDescripcion').textContent = rep.descripcion;
    document.querySelectorAll('#reportes .rep-fecha').forEach(e => e.classList.toggle('d-none', !rep.fecha));
    document.querySelectorAll('#reportes .rep-tienda').forEach(e => e.classList.toggle('d-none', !rep.tienda));
    $('repOpciones').innerHTML = (rep.opciones || []).map(o => `<div class="form-check"><input class="form-check-input" type="checkbox" id="repOp-${o.id}" ${o.def ? 'checked' : ''}>
        <label class="form-check-label" for="repOp-${o.id}">${o.texto}</label></div>`).join('');
    pintarColumnas(rep);
    if (limpiar) {
        repFilas = [];
        repGenerado = false;
        $('repTabla').classList.add('d-none');
        $('repExportar').disabled = true;
        $('repTitulo').textContent = rep.titulo;
        $('repInfo').innerHTML = 'Pulse <strong>Generar reporte</strong>.';
    }
    columnasCambiaron(false);
}

function pintarColumnas(rep) {
    const disp = columnasDisponibles(rep);
    let guardadas = null;
    try { guardadas = JSON.parse(localStorage.getItem(claveColumnas(rep))); } catch { guardadas = null; }
    // Orden guardado primero; las columnas nuevas (que no estaban guardadas) al final con su valor por defecto
    const lista = Array.isArray(guardadas)
        ? [...guardadas.map(g => ({ ...disp.find(c => c.campo === g.campo), activa: g.activa })).filter(c => c.campo),
           ...disp.filter(c => !guardadas.some(g => g.campo === c.campo)).map(c => ({ ...c, activa: c.def }))]
        : disp.map(c => ({ ...c, activa: c.def }));
    $('repColumnas').innerHTML = lista.map(c => `<li class="list-group-item" data-campo="${c.campo}">
        <input class="form-check-input" type="checkbox" id="repCol-${c.campo}" ${c.activa ? 'checked' : ''}>
        <label class="form-check-label" for="repCol-${c.campo}">${esc(c.titulo)}</label>
        <span class="rep-mover"><button type="button" class="btn-icono-claro" data-mover="arriba" title="Subir" aria-label="Subir ${esc(c.titulo)}"><i class="bi bi-chevron-up"></i></button>
        <button type="button" class="btn-icono-claro" data-mover="abajo" title="Bajar" aria-label="Bajar ${esc(c.titulo)}"><i class="bi bi-chevron-down"></i></button></span></li>`).join('');
}

function columnasCambiaron(guardar = true) {
    const rep = reporteActual();
    const items = [...$('repColumnas').querySelectorAll('li')].map(li => ({ campo: li.dataset.campo, activa: li.querySelector('input').checked }));
    if (guardar) try { localStorage.setItem(claveColumnas(rep), JSON.stringify(items)); } catch { /* sin almacenamiento */ }
    repColumnas = items.filter(i => i.activa).map(i => rep.columnas.find(c => c.campo === i.campo));
    $('repColumnasCuenta').textContent = `${repColumnas.length} de ${items.length}`;
    renderReporte();
}

function generarReporte() {
    const rep = reporteActual();
    const desde = $('repDesde').value, hasta = $('repHasta').value, tienda = $('repTienda').value;
    if (rep.fecha && desde && hasta && desde > hasta) { showAlert('La fecha "Desde" es posterior a "Hasta".', 'warning'); return; }
    run(async () => {
        const consulta = () => {
            let q = sb.from(rep.fuente).select('*');
            if (rep.fecha && desde) q = q.gte(rep.fecha, desde);
            // created_at es fecha y hora: "hasta" incluye todo ese día
            if (rep.fecha && hasta) q = rep.fecha === 'created_at' ? q.lt(rep.fecha, sumarDia(hasta)) : q.lte(rep.fecha, hasta);
            if (rep.tienda && tienda && !Array.isArray(rep.tienda)) q = q.eq(rep.tienda, tienda);
            return rep.orden.reduce((q2, [c, asc = true]) => q2.order(c, { ascending: asc }), q);
        };
        const [filas] = await Promise.all([
            rep.cargar ? rep.cargar({ desde, hasta, tienda }) : fetchAll(consulta),
            rep.columnas.some(c => ['_dueno', '_tipo_cliente', '_departamento', '_cliente'].includes(c.campo)) ? cargarClientesReporte() : null,
            veEquipo() && !perfiles.length ? cargarPerfiles() : null,
        ]);
        // Traslados: la bodega puede ser el origen o el destino
        repFilas = filas.filter(r => !tienda || !Array.isArray(rep.tienda) || rep.tienda.some(c => r[c] === tienda))
            .map(r => enriquecerFila(rep, r));
        repGenerado = true;
        if (rep.porCodigo) { repFilas.forEach(r => recordarConsecutivo({ id: r[rep.porCodigo], consecutivo: r.consecutivo })); ordenarPorCodigo(repFilas, rep.porCodigo); }
        $('repTitulo').textContent = rep.titulo;
        renderReporte();
    });
}

const sumarDia = iso => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

// Datos de clientes para las columnas calculadas (tipo de cliente, departamento, dueño)
let clientesReporte = {};
async function cargarClientesReporte() {
    const l = await fetchAll(() => sb.from('clientes').select('id,nombre,tipo_cliente,departamento,creado_por,consecutivo').order('id'));
    clientesReporte = Object.fromEntries(l.map(c => [c.id, c]));
    l.forEach(recordarConsecutivo);
}

function enriquecerFila(rep, r) {
    const c = (rep.porCodigo && clientesReporte[r[rep.porCodigo]]) || {};
    const ref = referencias.find(x => norm(x.nombre) === norm(r.producto)) || {};
    return {
        ...r,
        _tipo_cliente: c.tipo_cliente, _departamento: c.departamento, _cliente: c.nombre,
        _dueno: rep.fuente === 'clientes' ? nombreUsuario(r.creado_por) : (c.creado_por ? nombreUsuario(c.creado_por) : ''),
        _tipo: ref.tipo, _unidad: (ref.unidad || '').toLowerCase(),
        _origen: rep.fuente === 'ingresos_inventario' ? (r.traslado_id ? 'TRASLADO' : 'CARGA') : undefined,
    };
}

function repFiltradas() {
    const rep = reporteActual(), q = norm($('repBuscar').value);
    const ops = (rep.opciones || []).map(o => ({ ...o, on: $(`repOp-${o.id}`)?.checked }));
    return repFilas.filter(r => ops.every(o => o.incluir ? (!o.on || o.incluir(r)) : (o.on || !o.excluir(r)))
        && (!q || repColumnas.some(c => norm(valorPantalla(c, r[c.campo])).includes(q)) || coincideCodigo(r[rep.porCodigo], q)));
}

function valorPantalla(c, v) {
    if (v === null || v === undefined || v === '') return '';
    switch (c.tipo) {
        case 'fecha': return fmtFecha(v);
        case 'fechahora': return new Date(v).toLocaleString('es-GT', { timeZone: CFG.ZONA_HORARIA, dateStyle: 'short', timeStyle: 'short' });
        case 'num': return fmt(v);
        case 'dinero': return fmtQ(v);
        case 'pct': return fmtPct(v);
        case 'codigo': return String(cod(v));
        default: return String(v);
    }
}

function valorExcel(c, v) {
    if (v === null || v === undefined || v === '') return null;
    switch (c.tipo) {
        case 'fecha': return aFecha(v);
        case 'fechahora': return valorPantalla(c, v);
        case 'num': case 'dinero': case 'pct': return num(v);
        case 'codigo': return Number(cod(v)) || cod(v);
        default: return v;
    }
}

const MAX_FILAS_REPORTE = 500;
function renderReporte() {
    if (!repGenerado) return;
    const d = repFiltradas(), cols = repColumnas;
    const derecha = c => ['num', 'dinero', 'codigo', 'pct'].includes(c.tipo) ? ' class="num"' : '';
    $('repHead').innerHTML = `<tr>${cols.map(c => `<th${derecha(c)}>${esc(c.titulo)}</th>`).join('')}</tr>`;
    $('repBody').innerHTML = d.slice(0, MAX_FILAS_REPORTE).map(r => `<tr>${cols.map(c => `<td${derecha(c)}>${esc(valorPantalla(c, r[c.campo]))}</td>`).join('')}</tr>`).join('');
    const sumables = cols.filter(c => c.tipo === 'num' || c.tipo === 'dinero');
    $('repFoot').innerHTML = sumables.length && d.length ? `<tr>${cols.map((c, i) => sumables.includes(c)
        ? `<td class="num fw-semibold">${valorPantalla(c, d.reduce((s, r) => s + num(r[c.campo]), 0))}</td>` : `<td>${i === 0 ? 'Total' : ''}</td>`).join('')}</tr>` : '';
    $('repTabla').classList.toggle('d-none', !cols.length);
    $('repExportar').disabled = !d.length || !cols.length;
    $('repInfo').textContent = !cols.length ? 'Marque al menos una columna.'
        : `${d.length} fila(s)` + (d.length > MAX_FILAS_REPORTE ? ` · en pantalla se muestran ${MAX_FILAS_REPORTE}; el Excel incluye todas` : '') + (d.length ? '' : ' · no hay datos con estos filtros');
}

function exportarReporte() {
    const rep = reporteActual(), cols = repColumnas;
    const filas = repFiltradas().map(r => Object.fromEntries(cols.map(c => [c.titulo, valorExcel(c, r[c.campo])])));
    const rango = rep.fecha && ($('repDesde').value || $('repHasta').value) ? `_${$('repDesde').value || 'inicio'}_a_${$('repHasta').value || 'hoy'}` : '';
    exportarExcel(`Reporte_${rep.id}${rango}`, rep.titulo, filas);
}

// ---------------------------------------------------------------- Excel
// 'yyyy-mm-dd' -> Date local (Excel la muestra como fecha, sin corrimiento de zona)
function aFecha(f) {
    if (!f) return null;
    const [y, m, d] = String(f).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
}

function exportarExcel(nombre, hoja, filas) {
    if (!filas.length) { showAlert('No hay datos para exportar', 'warning'); return; }
    const ws = XLSX.utils.json_to_sheet(filas);
    const cols = Object.keys(filas[0]);
    // Fechas como número de serie de Excel (evita el corrimiento de un día por zona horaria)
    filas.forEach((r, i) => cols.forEach((c, j) => {
        const v = r[c];
        if (v instanceof Date) {
            const serie = (Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()) - Date.UTC(1899, 11, 30)) / 86400000;
            ws[XLSX.utils.encode_cell({ r: i + 1, c: j })] = { t: 'n', v: serie, z: 'dd/mm/yyyy' };
        }
    }));
    // Ancho de columnas según el contenido
    ws['!cols'] = cols.map(c => ({
        wch: Math.min(50, Math.max(c.length, ...filas.slice(0, 300).map(r =>
            r[c] instanceof Date ? 10 : String(r[c] ?? '').length)) + 2),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, hoja.replace(/[\/?*[\]:]/g, ' ').slice(0, 31));
    XLSX.writeFile(wb, `${nombre}_${hoyISO()}.xlsx`);
}

// ---------------------------------------------------------------- maestros
const MAESTROS = {
    tiendas: { grupo: 'tiendas', nuevo: 'Nueva tienda o bodega', titulo: 'Tiendas y bodegas', icono: 'shop', ayuda: 'Nombre de la nueva tienda o bodega' },
    vendedores: { grupo: 'vendedores', nuevo: 'Nuevo vendedor', titulo: 'Vendedores', icono: 'person-vcard', ayuda: 'Nombre del nuevo vendedor' },
    metodos_pago: { grupo: 'métodos de pago', nuevo: 'Nuevo método de pago', titulo: 'Métodos de pago', icono: 'credit-card', ayuda: 'Nombre del nuevo método de pago' },
    tipos: { grupo: 'productos y servicios', nuevo: 'Nuevo producto o servicio', titulo: 'Productos y servicios', icono: 'gem', ayuda: 'Nuevo producto o servicio (ej. ORO 18K, LIMPIEZA DE JOYAS)' },
    departamentos: { grupo: 'departamentos', nuevo: 'Nuevo departamento', titulo: 'Departamentos', icono: 'geo-alt', ayuda: 'Nuevo departamento' },
};
let maestroEditando = null;   // { m, nombre } del que se está renombrando
// Unidad de un tipo: gramos o unidades, con o sin inventario
// Categoría de cada producto: con inventario (en gramos o unidades) o servicio (se vende sin descontar inventario)
const OPCIONES_UNIDAD = [['GRAMOS', 'Producto · gramos'], ['UNIDADES', 'Producto · unidades'], ['SIN', 'Servicio']];
const unidadDeTipo = x => x.controla_inventario === false ? 'SIN' : (x.unidad || 'GRAMOS');
const datosUnidad = v => v === 'SIN' ? { unidad: 'UNIDADES', controla_inventario: false } : { unidad: v || 'GRAMOS', controla_inventario: true };

// Una pestaña por maestro, cada una con su formulario para agregar, buscador y lista
function construirMaestros() {
    construirPestanaComisiones();
    const claves = Object.keys(MAESTROS);
    $('maestrosPestanas').innerHTML = claves.map((m, i) => `<li class="nav-item"><button class="nav-link ${i ? '' : 'active'}" id="maestro-tab-${m}"
        data-bs-toggle="pill" data-bs-target="#maestro-panel-${m}" type="button"><i class="bi bi-${MAESTROS[m].icono} me-1"></i>${MAESTROS[m].titulo}
        <span class="text-muted small ms-1" id="maestro-n-${m}"></span></button></li>`).join('');
    $('maestrosPaneles').innerHTML = claves.map((m, i) => `<div class="tab-pane fade ${i ? '' : 'show active'}" id="maestro-panel-${m}">
        <div class="card"><div class="card-body">
          <div class="row g-2 mb-3">
            <div class="col-lg-7"><form class="input-group maestro-form" data-maestro="${m}">
              ${m === 'tiendas' ? `<select class="form-select flex-grow-0 w-auto maestro-clase-nueva" aria-label="Tipo"><option value="TIENDA">Tienda</option><option value="BODEGA">Bodega</option></select>` : ''}
              ${m === 'tipos' ? `<select class="form-select flex-grow-0 w-auto maestro-clase-nueva" aria-label="Unidad">${OPCIONES_UNIDAD.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>` : ''}
              <input type="text" class="form-control" placeholder="${MAESTROS[m].ayuda}" aria-label="${MAESTROS[m].nuevo}" required>
              <button class="btn btn-gold" type="submit"><i class="bi bi-plus-lg"></i> Agregar</button></form></div>
            <div class="col-lg-5"><input type="search" class="form-control maestro-buscar" data-maestro="${m}" placeholder="Buscar en ${MAESTROS[m].grupo}…" aria-label="Buscar"></div>
          </div>
          <ul class="list-group maestro-lista" id="maestro-${m}"></ul>
        </div></div></div>`).join('');
    $('maestrosPestanas').insertAdjacentHTML('beforeend', `<li class="nav-item solo-admin d-none"><button class="nav-link" id="maestro-tab-comisiones"
        data-bs-toggle="pill" data-bs-target="#maestro-panel-comisiones" type="button"><i class="bi bi-percent me-1"></i>Comisiones</button></li>`);
    $('maestrosPaneles').insertAdjacentHTML('beforeend', PANEL_COMISIONES);
}

function renderMaestro(m) {
    const q = norm(document.querySelector(`.maestro-buscar[data-maestro="${m}"]`)?.value);
    const admin = esAdmin();
    const lista = maestros[m].filter(x => !q || norm(x.nombre).includes(q));
    const n = maestros[m].length, inactivos = maestros[m].filter(x => x.activo === false).length;
    $(`maestro-n-${m}`).textContent = n;
    $(`maestro-${m}`).innerHTML = lista.map(x => {
        const nombre = esc(x.nombre), datos = `data-maestro="${m}" data-nombre="${nombre}"`;
        if (maestroEditando?.m === m && maestroEditando.nombre === x.nombre)
            return `<li class="list-group-item"><form class="maestro-editar-form" ${datos}>
                <input type="text" class="form-control form-control-sm" value="${nombre}" aria-label="Nuevo nombre" required>
                <button type="submit" class="btn btn-gold btn-sm">Guardar</button>
                <button type="button" class="btn btn-outline-secondary btn-sm maestro-cancelar">Cancelar</button></form></li>`;
        const detalle = m === 'tiendas' ? `<small>Usuarios: ${esc(usuariosPorTienda[x.nombre]?.join(', ') || '—')}</small>`
            : m === 'tipos' ? (x.controla_inventario === false
                ? `<small><span class="badge text-bg-info me-1">Servicio</span>se vende sin descontar inventario</small>`
                : `<small>Producto · inventario en ${(x.unidad || 'GRAMOS').toLowerCase()}</small>`)
            : m === 'vendedores' ? `<small>${esc(esquemasDe(x.nombre).map(e => e.nombre).join(' + ') || `Comisión fija ${fmtPct(x.comision_pct)}`)}
                · Meta ${fmtQ(x.meta_mensual)}${num(x.meta_grupal) > 0 ? ` · Meta grupal ${fmtQ(x.meta_grupal)}` : ''}${x.supervisor ? ` · a cargo de ${esc(x.supervisor)}` : ''}</small>` : '';
        return `<li class="list-group-item ${x.activo === false ? 'inactivo' : ''}">
            <div class="maestro-nombre">${admin ? `<span role="button" class="maestro-editar" ${datos} title="Cambiar nombre">${nombre}</span>` : nombre}${detalle}</div>
            <div class="maestro-acciones">
              ${m === 'tiendas' ? `<select class="form-select form-select-sm maestro-clase" data-nombre="${nombre}" aria-label="Tipo">
                ${['TIENDA', 'BODEGA'].map(c => `<option value="${c}" ${x.clase === c ? 'selected' : ''}>${c === 'TIENDA' ? 'Tienda' : 'Bodega'}</option>`).join('')}</select>` : ''}
              ${m === 'tipos' ? `<select class="form-select form-select-sm maestro-clase maestro-unidad" data-nombre="${nombre}" aria-label="Unidad">
                ${OPCIONES_UNIDAD.map(([v, t]) => `<option value="${v}" ${unidadDeTipo(x) === v ? 'selected' : ''}>${t}</option>`).join('')}</select>` : ''}
              <div class="form-check form-switch m-0" title="${x.activo === false ? 'Inactivo' : 'Activo'}"><input class="form-check-input maestro-activo" type="checkbox" role="switch" ${datos} ${x.activo === false ? '' : 'checked'} aria-label="Activo"></div>
              ${admin ? `<button type="button" class="btn btn-outline-secondary btn-sm maestro-editar" ${datos} title="Cambiar nombre"><i class="bi bi-pencil"></i></button>` : ''}
              <button type="button" class="btn btn-outline-danger btn-sm maestro-delete" ${datos} title="Eliminar"><i class="bi bi-trash"></i></button>
            </div></li>`;
    }).join('') || `<li class="list-group-item text-muted">${q ? 'Sin coincidencias' : 'Sin registros'}</li>`;
    $(`maestro-n-${m}`).title = inactivos ? `${inactivos} inactivo(s)` : '';
}

function editarMaestro(m, nombre) {
    const antes = maestroEditando?.m;
    maestroEditando = m ? { m, nombre } : null;
    if (antes && antes !== m) renderMaestro(antes);
    if (m || antes) renderMaestro(m || antes);
    if (m) { const i = document.querySelector(`#maestro-${m} .maestro-editar-form input`); i?.focus(); i?.select(); }
}

function renombrarMaestro(form) {
    const { maestro: m, nombre } = form.dataset;
    const nuevo = normalizarNombre(form.querySelector('input').value);
    if (!nuevo) return;
    if (nuevo === nombre) { editarMaestro(null); return; }
    if (!confirm(`¿Cambiar "${nombre}" por "${nuevo}"?\n\nEl nombre se actualizará también en todas las ventas, pagos, cargas y demás registros que lo usan.`)) return;
    run(async () => {
        const guardado = ok(await sb.rpc('renombrar_maestro', { p_maestro: m, p_viejo: nombre, p_nuevo: nuevo }));
        maestroEditando = null;
        await Promise.all([cargarMaestros(), m === 'tiendas' && esAdmin() ? cargarPerfiles() : null]);
        showAlert(`"${nombre}" ahora se llama "${guardado || nuevo}"`, 'success');
    });
}
const maestros = { tiendas: [], vendedores: [], metodos_pago: [], tipos: [], departamentos: [] };
let usuariosPorTienda = {};

// Vuelve a llenar un select conservando lo que estaba elegido
function repoblar(id, opts, placeholder) {
    const v = $(id).value;
    populateDropdown(id, opts, placeholder);
    if (v && v !== OPCION_CREAR) setSelectValue(id, v);
}

async function cargarMaestros() {
    // Si a la base le falta una tabla (esquema sin actualizar) la lista queda vacía y se avisa
    const faltantes = [];
    const [tiendas, vendedores, metodos_pago, tipos, departamentos] = await Promise.all(Object.keys(MAESTROS).map(t =>
        sb.from(t).select('*').order('orden').order('nombre').then(({ data, error }) => {
            if (error) { console.warn(t, error.message); faltantes.push(t); return []; }
            return data;
        })));
    await cargarReferencias();   // copia de los tipos: unidad e inventario
    { const { data } = await sb.from('esquemas_comision').select('*').order('orden'); esquemasComision = data || []; }
    { const { data } = await sb.from('vendedor_esquemas').select('*'); vendedorEsquemas = data || []; }
    // Usuarios vinculados a cada bodega (una bodega puede tener varios)
    const { data: usuarios } = await sb.from('perfiles').select('nombre,usuario,tienda,activo');
    usuariosPorTienda = {};
    (usuarios || []).filter(u => u.tienda && u.activo).forEach(u => (usuariosPorTienda[u.tienda] ??= []).push(u.nombre || u.usuario));
    if (faltantes.length) showAlert(`La base de datos no está actualizada (${faltantes.join(', ')}). Ejecute supabase/01_esquema.sql en el SQL Editor de Supabase.`, 'warning');
    Object.assign(maestros, { tiendas, vendedores, metodos_pago, tipos, departamentos });
    const todos = l => l.map(x => x.nombre);
    const activos = l => l.filter(x => x.activo !== false).map(x => x.nombre);

    // Filtros de consulta: todos. Formularios: solo activos.
    ['filterTienda', 'carBodega', 'repTienda', 'cuaTienda'].forEach(id => repoblar(id, todos(tiendas), 'Todas'));
    repoblar('tiendaSelect', activos(tiendas), 'Seleccione Tienda...');
    repoblar('cargaTienda', activos(tiendas), 'Seleccione Tienda...');
    repoblar('saldoInicialTienda', activos(tiendas), '(opcional)');
    repoblar('vendedorSelect', activos(vendedores), 'Seleccione Vendedor...');
    repoblar('saldoInicialVendedor', activos(vendedores), '(opcional)');
    repoblar('metodoPago', activos(metodos_pago), 'Seleccione...');
    dropdownData.tipos = activos(tipos);
    repoblar('filterTipo', todos(tipos), 'Todos');

    repoblar('refTipo', activos(tipos), '(sin tipo)');
    repoblar('newClientDepto', activos(departamentos), 'Seleccione...');
    repoblar('usrTienda', activos(tiendas), '(sin tienda)');
    aplicarTiendaUsuario();

    Object.keys(MAESTROS).forEach(renderMaestro);
}

const normalizarNombre = v => v.trim().toUpperCase().replace(/\s+/g, ' ');

// Inserta en un maestro y recarga las listas. Devuelve el nombre guardado.
// Si ya existe activo y permitirExistente, devuelve el existente.
async function insertarMaestro(m, nombre, clase, permitirExistente = false) {
    const existente = maestros[m].find(x => norm(x.nombre) === norm(nombre));
    if (existente && existente.activo !== false && permitirExistente) return existente.nombre;
    if (existente) throw new Error(`"${existente.nombre}" ya existe${existente.activo === false ? ' (está inactivo: actívelo en Maestros)' : ''}.`);
    const orden = Math.max(0, ...maestros[m].map(x => x.orden || 0)) + 1;
    ok(await sb.from(m).insert({ nombre, orden, activo: true, ...(m === 'tiendas' ? { clase } : m === 'tipos' ? datosUnidad(clase) : {}) }));
    await cargarMaestros();
    return nombre;
}

function agregarMaestro(m, input, clase) {
    const nombre = normalizarNombre(input.value);
    if (!nombre) return;
    run(async () => {
        await insertarMaestro(m, nombre, clase);
        input.value = '';
        showAlert(`"${nombre}" agregado${m === 'tiendas' ? ` como ${clase === 'BODEGA' ? 'bodega' : 'tienda'}` : ` a ${MAESTROS[m].grupo}`}`, 'success');
        if (m === 'tipos') input.focus();
    });
}

// ---------------------------------------------------------------- "+ Crear nuevo…" desde cualquier lista
let crearModal, crearDestino = null;

function abrirCrear(m, destino) {
    if (m === 'productos') { abrirModalReferencia(null, destino); return; }
    crearDestino = { m, destino };
    $('crearForm').reset();
    $('crearTitulo').textContent = MAESTROS[m].nuevo;
    $('crearClaseGrupo').classList.toggle('d-none', m !== 'tiendas');
    $('crearUnidadGrupo').classList.toggle('d-none', m !== 'tipos');
    crearModal.show();
}

function guardarCrear(e) {
    e.preventDefault();
    const { m, destino } = crearDestino;
    const nombre = normalizarNombre($('crearNombre').value);
    if (!nombre) return;
    const clase = m === 'tipos' ? $('crearUnidad').value : $('crearClase').value;
    run(async () => {
        const yaExistia = maestros[m].some(x => norm(x.nombre) === norm(nombre) && x.activo !== false);
        const guardado = await insertarMaestro(m, nombre, clase, true);
        crearModal.hide();
        seleccionarCreado(destino, guardado);
        showAlert(yaExistia ? `"${guardado}" ya existía; quedó seleccionado` : `"${guardado}" creado y seleccionado`, 'success');
    });
}

// Deja seleccionado lo recién creado y avisa a la lista (dispara sus efectos)
function seleccionarCreado(destino, valor) {
    if (!destino) return;
    setSelectValue(destino, valor);
    destino.dispatchEvent(new Event('change', { bubbles: true }));
}

function cambiarActivoMaestro(chk) {
    const { maestro: m, nombre } = chk.dataset;
    run(async () => {
        try {
            ok(await sb.from(m).update({ activo: chk.checked }).eq('nombre', nombre));
        } catch (err) {
            chk.checked = !chk.checked;  // revierte el interruptor si falló
            throw err;
        }
        await cargarMaestros();
        showAlert(`"${nombre}" ${chk.checked ? 'activado' : 'desactivado'}`, 'success');
    });
}

function eliminarMaestro(m, nombre) {
    run(async () => {
        // Revisa todos los registros del sistema, no solo los visibles para el usuario
        if (ok(await sb.rpc('maestro_en_uso', { p_maestro: m, p_nombre: nombre }))) {
            showAlert(`"${nombre}" está en uso (ventas, pagos, clientes, inventario o usuarios) y no se puede eliminar. Desactívelo para que no aparezca en los formularios.`, 'warning');
            return;
        }
        if (!confirm(`¿Eliminar "${nombre}"?`)) return;
        ok(await sb.from(m).delete().eq('nombre', nombre));
        await cargarMaestros();
        showAlert(`"${nombre}" eliminado`, 'success');
    });
}

function cambiarUnidadTipo(sel) {
    const nombre = sel.dataset.nombre;
    const antes = unidadDeTipo(maestros.tipos.find(x => x.nombre === nombre) || {});
    // Reclasificar entre producto y servicio cambia cómo afecta el inventario: se confirma
    if ((sel.value === 'SIN') !== (antes === 'SIN')) {
        const aServicio = sel.value === 'SIN';
        const msg = aServicio
            ? `¿Reclasificar "${nombre}" como SERVICIO?\n\nDesde ahora se vende sin descontar inventario, deja de aparecer en saldos, cargas y traslados, y no cuenta en las ventas en gramos.`
            : `¿Reclasificar "${nombre}" como PRODUCTO con inventario?\n\nSus ventas descontarán inventario y aparecerá en saldos, cargas y traslados (cargue su inventario inicial).`;
        if (!confirm(msg)) { sel.value = antes; return; }
    }
    run(async () => {
        try {
            ok(await sb.from('tipos').update(datosUnidad(sel.value)).eq('nombre', sel.dataset.nombre));
        } catch (err) {
            sel.value = antes;
            throw err;
        }
        await cargarMaestros();
        showAlert(sel.value === 'SIN' ? `"${sel.dataset.nombre}" ahora es un servicio: se vende sin descontar inventario`
            : `"${sel.dataset.nombre}": ${OPCIONES_UNIDAD.find(o => o[0] === sel.value)[1].toLowerCase()}`, 'success');
    });
}

function cambiarClaseTienda(sel) {
    run(async () => {
        const antes = maestros.tiendas.find(x => x.nombre === sel.dataset.nombre)?.clase;
        try {
            ok(await sb.from('tiendas').update({ clase: sel.value }).eq('nombre', sel.dataset.nombre));
        } catch (err) {
            sel.value = antes;
            throw err;
        }
        await cargarMaestros();
        showAlert(`"${sel.dataset.nombre}" ahora es ${sel.value === 'BODEGA' ? 'bodega' : 'tienda'}`, 'success');
    });
}

// ---------------------------------------------------------------- inteligencia comercial
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const etiquetaMes = ym => { const [y, m] = ym.split('-'); return `${MESES[Number(m) - 1]} ${y.slice(2)}`; };
const fmtG = v => num(v).toLocaleString('es-GT', { maximumFractionDigits: 2 }) + ' g';
let indicadores = null;

// Desde / hasta del periodo elegido para el precio promedio
function rangoPeriodo() {
    const hoy = hoyISO(), [y, m] = hoy.split('-').map(Number);
    const hace = meses => { const d = new Date(Date.UTC(y, m - 1 - meses, 1)); return d.toISOString().slice(0, 10); };
    switch ($('intPeriodo').value) {
        case 'mes': return [hace(0), hoy];
        case '3m': return [hace(2), hoy];
        case '12m': return [hace(11), hoy];
        case 'anio': return [`${y}-01-01`, hoy];
        case 'rango': return [$('intDesde').value || null, $('intHasta').value || null];
        default: return [null, null];
    }
}

let bodegaInteligenciaLista = false;
function loadInteligencia() {
    run(async () => {
        const [desde, hasta] = rangoPeriodo();
        if (!bodegaInteligenciaLista) {   // la primera vez, el vendedor ve su bodega
            bodegaInteligenciaLista = true;
            repoblar('intBodega', maestros.tiendas.map(t => t.nombre), 'Todas las bodegas');
            if (!esAdmin() && perfil?.tienda) setSelectValue('intBodega', perfil.tienda);
            if (veEquipo()) {
                // Admin: todos los usuarios. Supervisor: él y su equipo.
                if (!perfiles.length) await cargarPerfiles();
                const lista = perfiles.filter(p => p.activo && p.rol !== 'admin' && (esAdmin() || p.id === perfil.id || p.supervisor_id === perfil.id));
                $('intVendedor').innerHTML = `<option value="">${esAdmin() ? 'Todos' : 'Todo mi equipo'}</option>`
                    + lista.map(p => `<option value="${p.id}">${esc(p.nombre || p.usuario)}${p.id === perfil.id ? ' (yo)' : ''}</option>`).join('');
            }
        }
        const vendedor = veEquipo() ? $('intVendedor').value : '';
        indicadores = ok(await sb.rpc('indicadores_comerciales', {
            p_desde: desde, p_hasta: hasta, p_tienda: $('intBodega').value || null, ...(vendedor ? { p_vendedor: vendedor } : {}),
        }));
        renderInteligencia();
    });
}

function renderInteligencia() {
    const d = indicadores;
    const bodega = $('intBodega').value;
    $('kpiGramosAlcance').textContent = bodega ? `(${bodega})` : '(todas las bodegas)';
    const vend = veEquipo() && $('intVendedor').value ? $('intVendedor').selectedOptions[0].textContent : '';
    $('intAlcance').textContent = (vend ? `Clientes de ${vend}` : esAdmin() ? 'Clientes de todos los vendedores' : esSupervisor() ? 'Sus clientes y los de su equipo' : 'Sus clientes')
        + (bodega ? ` · cartera de clientes cuya última compra fue en ${bodega}` : ' · todas las bodegas')
        + (bodega && d.usuarios_bodega?.length ? ` · usuarios: ${d.usuarios_bodega.join(', ')}` : '');
    const fila = (a, b) => `<div class="fila"><span>${a}</span><b>${b}</b></div>`;

    // 1. Cartera por cobrar
    $('kpiCartera').textContent = fmtQ(d.cartera.por_cobrar);
    $('kpiCarteraSub').innerHTML = fila('Clientes con saldo', `${d.cartera.clientes_con_saldo} de ${d.cartera.clientes}`)
        + (num(d.cartera.saldo_a_favor) ? fila('Saldo a favor de clientes', fmtQ(d.cartera.saldo_a_favor)) : '');

    // 2. Gramos disponibles por tipo + en tránsito
    const porTipo = {};
    d.gramos.forEach(g => porTipo[g.tipo] = (porTipo[g.tipo] || 0) + num(g.gramos));
    const total = Object.values(porTipo).reduce((a, b) => a + b, 0);
    const transito = d.transito.reduce((a, t) => a + num(t.gramos), 0);
    $('kpiGramos').textContent = fmtG(total);
    $('kpiGramosSub').innerHTML = Object.entries(porTipo).map(([t, g]) => fila(esc(t), fmtG(g))).join('')
        + (transito ? fila('<i class="bi bi-truck"></i> En tránsito (no incluido)', fmtG(transito)) : '')
        + (d.traslados_por_recibir ? fila('Traslados por recibir', d.traslados_por_recibir) : '');

    // 3. Precio promedio del gramo vendido (general y por tipo)
    const p = d.promedio;
    $('kpiPromedio').textContent = num(p.gramos) ? `${fmtQ(num(p.valor) / num(p.gramos))} / g` : 'Sin ventas';
    $('kpiPromedioSub').innerHTML = p.por_tipo.map(t => fila(esc(t.tipo), `${fmtQ(num(t.valor) / num(t.gramos))} / g`)).join('')
        + fila('Gramos vendidos', fmtG(p.gramos)) + fila('Valor vendido', fmtQ(p.valor));

    // Gramos por bodega: una columna por tipo
    const tipos = [...new Set(d.gramos.map(g => g.tipo))].sort();
    const bodegas = {};
    d.gramos.forEach(g => (bodegas[g.tienda] ??= {})[g.tipo] = num(g.gramos));
    const totalFila = b => tipos.reduce((a, t) => a + (bodegas[b][t] || 0), 0);
    const celda = v => `<td class="num ${v < 0 ? 'saldo-negativo' : ''}">${v === undefined ? '' : fmt(v)}</td>`;
    $('intGramosHead').innerHTML = `<tr><th>Bodega</th>${tipos.map(t => `<th class="num">${esc(t)}</th>`).join('')}<th class="num">Total</th></tr>`;
    $('intGramosBody').innerHTML = Object.keys(bodegas).sort().map(b =>
        `<tr><td>${esc(b)}</td>${tipos.map(t => celda(bodegas[b][t])).join('')}${celda(totalFila(b))}</tr>`).join('')
        || `<tr><td colspan="${tipos.length + 2}" class="text-muted">Sin inventario en gramos</td></tr>`;
    $('intGramosFoot').innerHTML = `<tr><td>Total</td>${tipos.map(t => celda(porTipo[t])).join('')}${celda(total)}</tr>`;

    // Evolución mensual: un gráfico por tipo (oro y plata tienen escalas muy distintas)
    const meses = [];
    for (let i = 11; i >= 0; i--) {
        const [y, m] = hoyISO().split('-').map(Number);
        meses.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
    }
    const tiposMes = [...new Set(d.mensual.map(x => x.tipo))].sort();
    $('intGraficos').innerHTML = tiposMes.length ? '' : '<p class="text-muted small mb-0">Sin ventas por gramo en los últimos 12 meses.</p>';
    tiposMes.forEach(t => {
        const puntos = meses.map(mes => {
            const x = d.mensual.find(r => r.mes === mes && r.tipo === t);
            return { mes, gramos: x ? num(x.gramos) : 0, valor: x ? num(x.valor) / num(x.gramos) : null };
        });
        const div = document.createElement('div');
        $('intGraficos').appendChild(div);
        graficoLinea(div, `${t} · Q por gramo`, puntos);
    });
    $('intMensualBody').innerHTML = [...d.mensual].reverse().map(x => `<tr><td>${etiquetaMes(x.mes)}</td><td>${esc(x.tipo)}</td>
        <td class="num">${fmt(x.gramos)}</td><td class="num">${fmtQ(x.valor)}</td><td class="num">${fmtQ(num(x.valor) / num(x.gramos))}</td></tr>`).join('');
}

// Línea simple en SVG: una serie, un eje, cuadrícula tenue, marcadores con anillo,
// etiqueta directa en el último valor y tooltip con guía al pasar el cursor.
function graficoLinea(cont, titulo, puntos) {
    const W = 600, H = 150, M = { t: 14, r: 56, b: 22, l: 58 };
    const vals = puntos.map(p => p.valor).filter(v => v !== null);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min *= 0.9; max *= 1.1; }
    const pad = (max - min) * 0.15; min -= pad; max += pad;
    const x = i => M.l + i * (W - M.l - M.r) / (puntos.length - 1);
    const y = v => M.t + (max - v) * (H - M.t - M.b) / (max - min);
    const ticks = [0, 0.5, 1].map(f => min + (max - min) * f);

    // Tramos de línea: se cortan en los meses sin ventas
    let d = '', abierto = false;
    puntos.forEach((p, i) => {
        if (p.valor === null) { abierto = false; return; }
        d += `${abierto ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.valor).toFixed(1)}`; abierto = true;
    });
    const ultimo = [...puntos.keys()].reverse().find(i => puntos[i].valor !== null);
    const ancho = (W - M.l - M.r) / (puntos.length - 1);

    cont.className = 'viz';
    cont.innerHTML = `<div class="viz-titulo">${esc(titulo)}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(titulo)}, últimos 12 meses">
        <g class="grid">${ticks.map(t => `<line x1="${M.l}" x2="${W - M.r}" y1="${y(t)}" y2="${y(t)}"></line>`).join('')}</g>
        <g class="eje">${ticks.map(t => `<text x="${M.l - 6}" y="${y(t) + 4}" text-anchor="end">Q${Math.round(t).toLocaleString('es-GT')}</text>`).join('')}
          ${puntos.map((p, i) => i % 2 === (puntos.length - 1) % 2 ? `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${etiquetaMes(p.mes)}</text>` : '').join('')}</g>
        <line class="guia" y1="${M.t}" y2="${H - M.b}"></line>
        <path class="linea" d="${d}"></path>
        ${puntos.map((p, i) => p.valor === null ? '' : `<circle class="punto" cx="${x(i)}" cy="${y(p.valor)}" r="4"></circle>`).join('')}
        ${ultimo !== undefined ? `<text class="etiqueta" x="${x(ultimo) + 8}" y="${y(puntos[ultimo].valor) + 4}">Q${fmt(puntos[ultimo].valor)}</text>` : ''}
        ${puntos.map((p, i) => `<rect class="zona" data-i="${i}" x="${x(i) - ancho / 2}" y="${M.t}" width="${ancho}" height="${H - M.t - M.b}"></rect>`).join('')}
      </svg>
      <div class="viz-tooltip"></div>`;

    const svg = cont.querySelector('svg'), guia = cont.querySelector('.guia'), tip = cont.querySelector('.viz-tooltip');
    svg.addEventListener('mousemove', e => {
        const z = e.target.closest('.zona');
        if (!z) return;
        const i = Number(z.dataset.i), p = puntos[i], escala = svg.getBoundingClientRect().width / W;
        guia.setAttribute('x1', x(i)); guia.setAttribute('x2', x(i)); guia.style.opacity = 1;
        tip.innerHTML = `${etiquetaMes(p.mes)}<br>` + (p.valor === null ? 'Sin ventas'
            : `<b>Q${fmt(p.valor)}</b> / g · ${fmtG(p.gramos)}`);
        tip.style.left = `${x(i) * escala}px`;
        tip.style.top = `${(p.valor === null ? M.t : y(p.valor)) * escala + cont.querySelector('.viz-titulo').offsetHeight}px`;
        tip.style.opacity = 1;
    });
    svg.addEventListener('mouseleave', () => { guia.style.opacity = 0; tip.style.opacity = 0; });
}

function exportGramos() {
    if (!indicadores) return;
    exportarExcel('Gramos_por_bodega', 'Gramos por bodega', indicadores.gramos.map(g => ({
        'Bodega': g.tienda, 'Tipo': g.tipo, 'Gramos': num(g.gramos),
    })));
}

// ---------------------------------------------------------------- traslados entre bodegas
let trasladosFilas = [];

// El vendedor envía desde su tienda; el administrador desde cualquiera
function puedeRecibir(t) { return t.estado === 'ENVIADO' && (esAdmin() || t.destino === perfil?.tienda); }
function puedeAnular(t) {
    return t.estado === 'ENVIADO' && (esAdmin() || [t.origen, t.destino].includes(perfil?.tienda) || t.enviado_por === perfil?.id);
}

async function actualizarBadgeTraslados() {
    const { data } = await sb.from('traslados').select('id,destino').eq('estado', 'ENVIADO');
    const n = (data || []).filter(t => esAdmin() || t.destino === perfil?.tienda).length;
    for (const id of ['badgeTraslados', 'badgeTrasladosMenu']) {
        $(id).textContent = n;
        $(id).classList.toggle('d-none', !n);
    }
}

function loadTraslados() {
    run(async () => {
        const [filas] = await Promise.all([
            fetchAll(() => sb.from('traslados').select('*').order('id', { ascending: false })),
            cargarPerfiles(),
        ]);
        trasladosFilas = filas;
        // Formulario
        const activas = maestros.tiendas.filter(x => x.activo !== false).map(x => x.nombre);
        const sinTienda = !esAdmin() && !perfil?.tienda;
        $('trasladoSinTienda').classList.toggle('d-none', !sinTienda);
        $('trasladoForm').querySelectorAll('input, select, button').forEach(el => el.disabled = sinTienda);
        if (esAdmin()) repoblar('trasladoOrigen', activas, 'Seleccione...');
        else { populateDropdown('trasladoOrigen', perfil?.tienda ? [perfil.tienda] : [], '—'); $('trasladoOrigen').value = perfil?.tienda || ''; $('trasladoOrigen').disabled = true; }
        repoblar('trasladoProducto', tiposConInventario(), 'Seleccione...');
        if (!$('trasladoFecha').value) $('trasladoFecha').value = hoyISO();
        prepararDestinos();
        mostrarSaldoTraslado();
        renderTraslados();
        actualizarBadgeTraslados();
    });
}

function prepararDestinos() {
    const origen = $('trasladoOrigen').value;
    repoblar('trasladoDestino', maestros.tiendas.filter(x => x.activo !== false && x.nombre !== origen).map(x => x.nombre), 'Seleccione...');
    const ref = referencias.find(r => r.nombre === $('trasladoProducto').value);
    $('trasladoUnidad').textContent = ref ? `(${ref.unidad.toLowerCase()})` : '';
}

async function mostrarSaldoTraslado() {
    const o = $('trasladoOrigen').value, p = $('trasladoProducto').value;
    if (!o || !p) { $('trasladoSaldo').textContent = ''; return; }
    const { data } = await sb.from('inventario').select('saldo').eq('kt', o.trim().toUpperCase()).eq('kp', p.trim().toUpperCase());
    $('trasladoSaldo').textContent = `Disponible en ${o}: ${data?.length ? fmt(data[0].saldo) : 'sin inventario cargado'}`;
    $('trasladoSaldo').dataset.saldo = data?.length ? data[0].saldo : 0;
}

function renderTraslados() {
    const usuario = id => nombreUsuario(id) || '';
    const fechaHora = f => f ? new Date(f).toLocaleString('es-GT', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const insignia = { ENVIADO: 'text-bg-warning', RECIBIDO: 'text-bg-success', ANULADO: 'text-bg-secondary' };
    const nombreEstado = { ENVIADO: 'En tránsito', RECIBIDO: 'Recibido', ANULADO: 'Anulado' };
    const botones = t => (puedeRecibir(t) ? `<button type="button" class="btn btn-gold btn-sm" data-accion="recibir" data-id="${t.id}"><i class="bi bi-box-arrow-in-down"></i> Recibir</button> ` : '')
        + (puedeAnular(t) ? `<button type="button" class="btn btn-outline-danger btn-sm" data-accion="anular" data-id="${t.id}">${t.destino === perfil?.tienda && !esAdmin() ? 'Rechazar' : 'Anular'}</button>` : '');

    const pendientes = trasladosFilas.filter(puedeRecibir);
    $('porRecibirBody').innerHTML = pendientes.map(t => `<tr><td>${t.id}</td><td>${fmtFecha(t.fecha_envio)}</td><td>${esc(t.origen)}</td><td>${esc(t.destino)}</td>
        <td>${esc(t.producto)}</td><td class="num fw-semibold">${fmt(t.cantidad)}</td><td>${esc(usuario(t.enviado_por))}</td><td>${esc(t.observaciones)}</td>
        <td class="text-nowrap">${botones(t)}</td></tr>`).join('')
        || '<tr><td colspan="9" class="text-muted">No hay traslados pendientes por recibir.</td></tr>';

    const e = $('filterTrasladoEstado').value;
    $('trasladosBody').innerHTML = trasladosFilas.filter(t => !e || t.estado === e).map(t => `<tr>
        <td>${t.id}</td><td>${fmtFecha(t.fecha_envio)}<div class="small text-muted">${esc(usuario(t.enviado_por))}</div></td>
        <td>${esc(t.origen)} → ${esc(t.destino)}</td><td>${esc(t.producto)}</td><td class="num">${fmt(t.cantidad)}</td>
        <td><span class="badge ${insignia[t.estado]}">${nombreEstado[t.estado]}</span></td>
        <td class="small">${fechaHora(t.fecha_recepcion)}<div class="text-muted">${esc(usuario(t.recibido_por))}</div></td>
        <td class="small">${esc([t.observaciones, t.obs_recepcion].filter(Boolean).join(' · '))}</td>
        <td class="text-nowrap">${puedeRecibir(t) ? '' : botones(t)}</td></tr>`).join('')
        || '<tr><td colspan="9" class="text-muted">Sin traslados.</td></tr>';
}

function enviarTraslado(e) {
    e.preventDefault();
    const datos = {
        p_origen: $('trasladoOrigen').value, p_destino: $('trasladoDestino').value, p_producto: $('trasladoProducto').value,
        p_cantidad: num($('trasladoCantidad').value), p_fecha: $('trasladoFecha').value, p_observaciones: $('trasladoObs').value.trim() || null,
    };
    const disponible = num($('trasladoSaldo').dataset.saldo);
    if (datos.p_cantidad > disponible && !confirm(`${datos.p_origen} tiene ${fmt(disponible)} disponibles de ${datos.p_producto} y va a enviar ${fmt(datos.p_cantidad)}. ¿Enviar de todas formas?`)) return;
    if (!confirm(`¿Enviar ${fmt(datos.p_cantidad)} de ${datos.p_producto} de ${datos.p_origen} a ${datos.p_destino}?`)) return;
    run(async () => {
        const t = unico(ok(await sb.rpc('enviar_traslado', datos)));
        showAlert(`Traslado #${t.id} enviado: ${fmt(t.cantidad)} de ${t.producto} a ${t.destino}. Queda en tránsito hasta que lo reciban.`, 'success');
        $('trasladoCantidad').value = ''; $('trasladoObs').value = '';
        loadTraslados();
    });
}

function recibirTraslado(id) {
    const t = trasladosFilas.find(x => x.id === id);
    if (!confirm(`¿Confirmar que ${t.destino} recibió ${fmt(t.cantidad)} de ${t.producto} enviados por ${t.origen}?`)) return;
    const obs = prompt('Observación de la recepción (opcional):', '');
    if (obs === null) return;
    run(async () => {
        ok(await sb.rpc('recibir_traslado', { p_id: id, p_observaciones: obs || null }));
        showAlert(`Traslado #${id} recibido: ${fmt(t.cantidad)} de ${t.producto} ingresaron a ${t.destino}.`, 'success');
        loadTraslados();
    });
}

function anularTraslado(id) {
    const t = trasladosFilas.find(x => x.id === id);
    const motivo = prompt(`Motivo para anular el traslado #${id} (${fmt(t.cantidad)} de ${t.producto}). El inventario vuelve a ${t.origen}:`, '');
    if (motivo === null) return;
    run(async () => {
        ok(await sb.rpc('anular_traslado', { p_id: id, p_motivo: motivo || null }));
        showAlert(`Traslado #${id} anulado; ${fmt(t.cantidad)} de ${t.producto} regresaron a ${t.origen}.`, 'success');
        loadTraslados();
    });
}

function exportTraslados() {
    const e = $('filterTrasladoEstado').value;
    exportarExcel('Traslados', 'Traslados', trasladosFilas.filter(t => !e || t.estado === e).map(t => ({
        'Traslado': t.id, 'Fecha envío': aFecha(t.fecha_envio), 'Origen': t.origen, 'Destino': t.destino,
        'Tipo': t.producto, 'Cantidad': num(t.cantidad), 'Estado': t.estado, 'Enviado por': nombreUsuario(t.enviado_por),
        'Recibido / anulado por': nombreUsuario(t.recibido_por), 'Observaciones': t.observaciones, 'Obs. recepción': t.obs_recepcion,
    })));
}
