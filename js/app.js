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
    $('userRol').textContent = perfil ? (perfil.rol === 'admin' ? 'Administrador' : 'Vendedor') : '';
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
        await Promise.all([cargarMaestros(), cargarReferencias(), esAdmin() ? cargarPerfiles() : null]);
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

function registrarEventos() {
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
    crearBuscadorCliente('ecCliente', c => cargarEstadoCuenta(c.id));
    crearBuscadorCliente('asignarCliente', asignarClienteAPago);

    // Venta
    $('newClientSaleButton').addEventListener('click', () => abrirModalCliente({}, 'venta'));
    $('saveClientButton').addEventListener('click', saveNewClient);
    $('addProductButton').addEventListener('click', () => addProductLine());
    $('saleForm').addEventListener('submit', handleFormSubmit);
    $('productLines').addEventListener('input', updateLineTotal);
    // Al elegir una referencia se completa su tipo
    $('productLines').addEventListener('change', e => {
        if (!e.target.classList.contains('product-producto')) return;
        const ref = referencias.find(r => r.nombre === e.target.value);
        if (ref?.tipo) setSelectValue(e.target.closest('tr').querySelector('.product-tipo'), ref.tipo);
    });
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
    $('valorPagar').addEventListener('input', mostrarNuevoSaldo);
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
    $('historico-tab').addEventListener('shown.bs.tab', loadHistoryData);
    ['filterCliente', 'filterTienda', 'filterTipo', 'filterProducto'].forEach(id => $(id).addEventListener('input', filterHistory));

    // Cartera
    const subCartera = { 'pills-saldoscli-tab': loadSaldos, 'pills-estado-tab': () => {}, 'pills-detalle-tab': loadCarteraDetalleData };
    $('cartera-tab').addEventListener('shown.bs.tab', () =>
        subCartera[document.querySelector('#cartera .nav-pills .active').id]());
    $('pills-saldoscli-tab').addEventListener('shown.bs.tab', loadSaldos);
    $('pills-detalle-tab').addEventListener('shown.bs.tab', loadCarteraDetalleData);
    ['filterSaldos', 'saldosSoloDeudores'].forEach(id => $(id).addEventListener('input', filterSaldos));
    $('saldosTableBody').addEventListener('click', e => {
        const tr = e.target.closest('tr[data-codigo]');
        if (tr) verEstadoCuenta(Number(tr.dataset.codigo));
    });
    ['filterCarteraDetalleTienda', 'filterCarteraDetalleCliente', 'filterCarteraDetalleEnvio'].forEach(id => $(id).addEventListener('input', filterCarteraDetalle));

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
    $('cargaNuevaRefButton').addEventListener('click', () => abrirModalReferencia(null, $('cargaProducto')));
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
    $('newClientButton').addEventListener('click', () => abrirModalCliente({}, 'clientes'));
    $('clientesTableBody').addEventListener('click', e => {
        const b = e.target.closest('.edit-client');
        if (b) abrirModalCliente(fullClientesData.find(c => c.id === Number(b.dataset.id)), 'clientes');
    });

    // Maestros
    $('maestros-tab').addEventListener('shown.bs.tab', () => run(cargarMaestros));
    $('maestros').addEventListener('submit', e => {
        if (!e.target.classList.contains('maestro-form')) return;
        e.preventDefault();
        agregarMaestro(e.target.dataset.maestro, e.target.querySelector('input'), e.target.querySelector('.maestro-clase-nueva')?.value);
    });
    $('maestros').addEventListener('change', e => {
        if (e.target.classList.contains('maestro-activo')) cambiarActivoMaestro(e.target);
        if (e.target.classList.contains('maestro-clase')) cambiarClaseTienda(e.target);
    });
    $('maestros').addEventListener('click', e => {
        const b = e.target.closest('.maestro-delete');
        if (b) eliminarMaestro(b.dataset.maestro, b.dataset.nombre);
    });

    // Usuarios (administradores)
    $('usuarios-tab').addEventListener('shown.bs.tab', loadUsuarios);
    $('usuarioForm').addEventListener('submit', agregarUsuario);
    $('usuariosTableBody').addEventListener('change', e => {
        if (e.target.matches('.usr-activo')) actualizarUsuario(e.target, { activo: e.target.checked });
        if (e.target.matches('.usr-tienda')) actualizarUsuario(e.target, { tienda: e.target.value || null });
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
function crearBuscadorCliente(id, alElegir, { alNoEncontrar } = {}) {
    const input = $(id), lista = $(id + 'Resultados');
    let resultados = [];
    const cerrar = () => lista.classList.add('d-none');
    const buscar = () => {
        const q = input.value.trim();
        if (!q) return;
        run(async () => {
            resultados = ok(await sb.rpc('buscar_clientes', { p_termino: q }));
            if (resultados.length === 1) { cerrar(); alElegir(resultados[0]); return; }
            if (!resultados.length) {
                cerrar();
                if (alNoEncontrar) alNoEncontrar(q); else showAlert(`No se encontró ningún cliente con "${q}"`, 'warning');
                return;
            }
            lista.innerHTML = resultados.map((c, i) => `<button type="button" class="list-group-item list-group-item-action" data-i="${i}">
                <span class="badge text-bg-secondary me-2">${c.id}</span>${esc(c.nombre)}
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
        if (b) { cerrar(); alElegir(resultados[Number(b.dataset.i)]); }
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
};
let origenModalCliente = 'venta'; // 'venta' llena el formulario de venta al guardar

// c.id presente = edición; origen: 'venta' o 'clientes'
function abrirModalCliente(c = {}, origen = 'clientes') {
    origenModalCliente = origen;
    $('createClientForm').reset();
    $('editClientId').value = c.id || '';
    $('clientModalTitle').textContent = c.id ? 'Editar Cliente' : 'Crear Nuevo Cliente';
    $('clientModalId').textContent = c.id ?? 'se asigna automáticamente al guardar';
    if (!c.id) mostrarProximoCodigo();
    for (const [id, col] of Object.entries(CAMPOS_CLIENTE)) {
        if (id === 'newClientDepto') setSelectValue(id, c[col]); else $(id).value = c[col] ?? '';
    }
    // Saldo inicial: solo al crear
    $('saldoInicialGrupo').classList.toggle('d-none', !!c.id);
    $('saldoInicialFecha').value = hoyISO();
    aplicarTiendaUsuario();  // el reset del formulario borra la tienda fija
    // Responsable: solo el administrador, al editar
    const verResponsable = esAdmin() && !!c.id;
    $('clientResponsableGrupo').classList.toggle('d-none', !verResponsable);
    if (verResponsable) {
        $('clientResponsable').innerHTML = '<option value="">(sin asignar: solo administradores)</option>' +
            perfiles.map(p => `<option value="${p.id}">${esc(p.nombre || p.email)}${p.activo ? '' : ' (inactivo)'}</option>`).join('');
        $('clientResponsable').value = c.creado_por ?? '';
    }
    createClientModal.show();
}

// Código que tendrá el cliente nuevo según el rango del usuario
async function mostrarProximoCodigo() {
    const { data, error } = await sb.rpc('proximo_codigo_cliente');
    if (error || $('editClientId').value) return;   // base sin actualizar o se abrió otra ficha
    $('clientModalId').textContent = data === null ? 'su rango de códigos está lleno: pida al administrador que lo amplíe'
        : `${data} (se confirma al guardar)`;
}

function saveNewClient() {
    const d = {};
    for (const [id, col] of Object.entries(CAMPOS_CLIENTE)) d[col] = $(id).value.trim() || null;
    if (!d.nombre) { $('newClientNombre').reportValidity(); return; }
    if (d.correo && !$('newClientCorreo').checkValidity()) { $('newClientCorreo').reportValidity(); return; }
    const id = $('editClientId').value;
    const saldo = num($('saldoInicialValor').value);
    run(async () => {
        let c;
        if (id) {
            if (esAdmin()) d.creado_por = $('clientResponsable').value || null;
            c = ok(await sb.from('clientes').update(d).eq('id', id).select().single());
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
        if (origenModalCliente === 'venta') {
            ponerClienteEnVenta(c);
        } else {
            const i = fullClientesData.findIndex(x => x.id === c.id);
            if (i >= 0) fullClientesData[i] = c; else fullClientesData.unshift(c);
            filterClientes();
        }
        showAlert(id ? `Cliente ${c.id} actualizado con éxito`
            : `Cliente creado. Código cliente: ${c.id}` + (saldo > 0 ? ` · Saldo inicial ${fmtQ(saldo)} registrado` : ''), 'success');
    });
}

function ponerClienteEnVenta(c) {
    $('clientId').value = c.id ?? '';
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

function addProductLine(d = {}) {
    const r = document.createElement('tr');
    r.innerHTML = `
        <td><select class="form-select form-select-sm product-tipo" data-crear="tipos" required>${getOptionsHTML(dropdownData.tipos, d.tipo, 'tipos')}</select></td>
        <td><select class="form-select form-select-sm product-producto" data-crear="productos" required>${getOptionsHTML(dropdownData.productos, d.producto, 'productos')}</select></td>
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
        clienteId: $('clientId').value,
        pedidoId: $('pedidoId').value,
    };
    const productLines = [...document.querySelectorAll('#productLines tr')].map(r => ({
        tipo: r.querySelector('.product-tipo').value,
        producto: r.querySelector('.product-producto').value,
        cantidad: r.querySelector('.product-cantidad').value,
        valorUnitario: r.querySelector('.product-valor-unitario').value,
        valorTotal: r.querySelector('.product-valor-total').value,
    }));
    if (!header.tienda || !header.vendedor || !header.clienteNombre || productLines.length === 0) {
        showAlert('Complete los datos requeridos (cliente, tienda, vendedor y al menos un producto)', 'warning');
        return;
    }
    const venta = { header, productLines, summary: { envio: $('envio').value.trim(), factura: $('factura').value.trim() } };
    const clave = $('envioOriginal').value;

    run(async () => {
        if (!clave) {
            const faltantes = await verificarStock(header.tienda, productLines);
            if (faltantes.length && !confirm('Inventario insuficiente:\n\n' + faltantes.join('\n') + '\n\n¿Registrar la venta de todas formas?')) return;
            const id = ok(await sb.rpc('registrar_venta', { p_venta: venta }));
            showAlert(`Venta registrada con éxito. Pedido: ${id} · Fecha: ${fmtFecha(hoyISO())}`, 'success');
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
        const d = ok(await sb.rpc('buscar_pedidos', { p_termino: q, p_campo: $('searchPedidoCampo').value }));
        $('pedidosTabla').classList.toggle('d-none', !d.length);
        $('pedidosTableBody').innerHTML = d.map(p => `<tr>
            <td class="fw-semibold">${fmtFecha(p.fecha_venta)}</td><td>${esc(p.pedido_id)}</td><td>${esc(p.envio)}</td>
            <td class="num">${esc(p.cliente_id)}</td><td>${esc(p.cliente)}</td><td>${esc(p.tienda)}</td><td>${esc(p.vendedor)}</td>
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
        $('clientId').value = h.cliente_id ?? '';
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
    $('pedidoId').value = '';
    $('envioOriginal').value = '';
    $('clientId').value = '';
    $('productLines').innerHTML = '';
    $('mainActionButton').textContent = 'Registrar Venta';
    $('deleteOrderButton').classList.add('d-none');
    $('newSaleButton').classList.add('d-none');
    updateSubtotal();
    aplicarTiendaUsuario();
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
        const [resumen, ventas, pagos] = await Promise.all([
            sb.from('cartera_clientes').select('*').eq('codigo', c.id).maybeSingle().then(ok),
            fetchAll(() => sb.from('ventas').select('envio,pedido_id,fecha_venta,valor_total').eq('cliente_id', c.id)),
            fetchAll(() => sb.from('pagos').select('envio,valor_pagado').eq('cliente_id', c.id)),
        ]);
        clientePago = c;
        saldoClientePago = num(resumen?.saldo);
        $('pagoInfoCodigo').textContent = c.id;
        $('pagoInfoNombre').textContent = c.nombre;
        $('pagoInfoDoc').textContent = [c.dpi && `DPI ${c.dpi}`, c.nit && `NIT ${c.nit}`, c.telefono && `Tel. ${c.telefono}`].filter(Boolean).join(' · ');
        $('pagoInfoVentas').textContent = fmt(resumen?.total_ventas);
        $('pagoInfoPagos').textContent = fmt(resumen?.total_pagos);
        $('pagoInfoSaldo').textContent = fmt(saldoClientePago);
        $('pagoCliente').value = `${c.id} · ${c.nombre}`;

        // Saldo por envío (informativo): ventas del envío menos pagos aplicados a él
        const envios = {};
        ventas.forEach(v => {
            const k = (v.envio || '').trim() || v.pedido_id;
            const x = envios[k] ??= { envio: k, fecha: v.fecha_venta, venta: 0, pagado: 0 };
            x.venta += num(v.valor_total);
            if (v.fecha_venta < x.fecha) x.fecha = v.fecha_venta;
        });
        pagos.forEach(p => { const k = (p.envio || '').trim(); if (envios[k]) envios[k].pagado += num(p.valor_pagado); });
        const lista = Object.values(envios).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
        $('pagoEnviosBody').innerHTML = lista.map(x => `<tr><td>${fmtFecha(x.fecha)}</td><td>${esc(x.envio)}</td><td class="num">${fmt(x.venta)}</td><td class="num">${fmt(x.pagado)}</td><td class="num">${fmt(x.venta - x.pagado)}</td></tr>`).join('')
            || '<tr><td colspan="5" class="text-muted">Sin compras registradas</td></tr>';
        $('pagoEnvio').innerHTML = '<option value="">Abono al total del cliente</option>' +
            lista.filter(x => x.venta - x.pagado > 0.005)
                .map(x => `<option value="${esc(x.envio)}">Envío ${esc(x.envio)} · saldo ${fmtQ(x.venta - x.pagado)}</option>`).join('');
        $('pagoClienteInfo').classList.remove('d-none');
        mostrarNuevoSaldo();
    });
}

function mostrarNuevoSaldo() {
    const v = num($('valorPagar').value);
    $('pagoNuevoSaldo').textContent = v > 0 ? `Después de este pago el cliente debe: ${fmtQ(saldoClientePago - v)}` : '';
}

function handlePaymentSubmit(e) {
    e.preventDefault();
    if (!clientePago) { showAlert('Busque primero al cliente', 'warning'); return; }
    const valor = num($('valorPagar').value);
    if (valor > saldoClientePago + 0.005 && !confirm(`El pago (${fmtQ(valor)}) es mayor que lo que debe el cliente (${fmtQ(saldoClientePago)}). ¿Registrarlo de todas formas?`)) return;
    const p = {
        cliente_id: clientePago.id,
        fecha_pago: $('fechaPago').value,
        valor_pagado: valor,
        metodo_pago: $('metodoPago').value,
        boleta: $('boleta').value.trim() || null,
        envio: $('pagoEnvio').value || null,
        observaciones: $('pagoObservaciones').value.trim() || null,
    };
    run(async () => {
        ok(await sb.from('pagos').insert(p));
        showAlert(`Pago de ${fmtQ(valor)} (${p.metodo_pago}, ${fmtFecha(p.fecha_pago)}) registrado a ${clientePago.nombre}. Nuevo saldo: ${fmtQ(saldoClientePago - valor)}`, 'success');
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
        && (!c || String(r.cliente_id) === c || norm(r.cliente).includes(c)));
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
        <td>${fmtFecha(r.fecha_pago)}</td><td class="num">${esc(r.cliente_id)}</td><td>${esc(r.cliente)}</td><td>${esc(r.metodo_pago)}</td>
        <td class="num">${fmtQ(r.valor_pagado)}</td><td>${esc(r.boleta)}</td><td>${esc(r.envio)}</td><td>${esc(r.registrado_por)}</td>
        <td>${!r.cliente_id && esAdmin() ? `<button type="button" class="btn btn-outline-secondary btn-sm asignar-pago" data-id="${r.id}">Asignar cliente</button>` : ''}</td></tr>`).join('');
    $('recTotal').textContent = fmtQ(total);
    $('recInfo').textContent = `${d.length} pagos` + (d.length > 1000 ? ' (se muestran 1000; el Excel incluye todos)' : '');
}

function exportRecibidos() {
    exportarExcel('Pagos_recibidos', 'Pagos recibidos', recibidosFiltrados().map(r => ({
        'Fecha pago': aFecha(r.fecha_pago), 'Código cliente': r.cliente_id, 'Cliente': r.cliente,
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
function loadHistoryData() {
    run(async () => {
        const d = await fetchAll(() => sb.from('ventas')
            .select('id,pedido_id,fecha_venta,tienda,vendedor,cliente_id,cliente,tipo,producto,cantidad,valor_unitario,valor_total')
            .order('fecha_venta', { ascending: false })
            .order('id', { ascending: false }));
        fullHistoryData = d.filter(r => (r.cliente || r.producto) && r.producto !== 'SALDO INICIAL');
        filterHistory();
    });
}

function renderHistoryTable(d) {
    $('historicoTableBody').innerHTML = d.slice(0, 2000).map(r => `<tr><td>${fmtFecha(r.fecha_venta)}</td><td>${esc(r.pedido_id)}</td><td>${esc(r.tienda)}</td><td>${esc(r.vendedor)}</td><td class="num">${esc(r.cliente_id)}</td><td>${esc(r.cliente)}</td><td>${esc(r.tipo)}</td><td>${esc(r.producto)}</td><td class="num">${esc(r.cantidad)}</td><td class="num">${fmtQ(r.valor_unitario)}</td><td class="num">${fmtQ(r.valor_total)}</td></tr>`).join('');
    $('rowCount').textContent = d.length + (d.length > 2000 ? ' (se muestran 2000; el Excel incluye todos)' : '');
}

function historicoFiltrado() {
    const c = norm($('filterCliente').value), t = $('filterTienda').value, tp = $('filterTipo').value, p = $('filterProducto').value;
    return fullHistoryData.filter(r =>
        (!c || String(r.cliente_id) === c || norm(r.cliente).includes(c)) &&
        (!t || r.tienda === t) && (!tp || r.tipo === tp) && (!p || r.producto === p));
}
const filterHistory = () => renderHistoryTable(historicoFiltrado());

function exportHistorico() {
    exportarExcel('Historico_ventas', 'Histórico', historicoFiltrado().map(r => ({
        'Fecha': aFecha(r.fecha_venta), 'Pedido': r.pedido_id, 'Tienda': r.tienda, 'Vendedor': r.vendedor,
        'Código cliente': r.cliente_id, 'Cliente': r.cliente, 'Tipo': r.tipo, 'Producto': r.producto,
        'Cantidad': r.cantidad, 'Valor unitario': r.valor_unitario, 'Valor total': r.valor_total,
    })));
}

// ---------------------------------------------------------------- cartera: saldos por cliente
function loadSaldos() {
    run(async () => {
        fullSaldosData = await fetchAll(() => sb.from('cartera_clientes').select('*').order('nombre').order('codigo'));
        filterSaldos();
    });
}

function saldosFiltrados() {
    const q = norm($('filterSaldos').value), deudores = $('saldosSoloDeudores').checked;
    return fullSaldosData.filter(r => (!deudores || num(r.saldo) > 0.005) &&
        (!q || String(r.codigo) === q || [r.nombre, r.dpi, r.nit].some(v => norm(v).includes(q))));
}

function filterSaldos() {
    const d = saldosFiltrados();
    $('saldosTableBody').innerHTML = d.map(r => `<tr data-codigo="${r.codigo}" style="cursor:pointer">
        <td class="num fw-semibold">${r.codigo}</td><td>${esc(r.nombre)}</td><td>${esc(r.dpi || r.nit)}</td><td>${esc(r.telefono)}</td>
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
        'Código cliente': r.codigo, 'Cliente': r.nombre, 'DPI': r.dpi, 'NIT': r.nit, 'Teléfono': r.telefono,
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
        $('ecCodigo').textContent = c.id;
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
        'Código cliente': clienteEstado.id, 'Cliente': clienteEstado.nombre, 'Fecha': aFecha(m.fecha),
        'Movimiento': m.movimiento, 'Detalle': m.detalle, 'Método de pago': m.metodo_pago,
        'Cargo': num(m.cargo), 'Abono': num(m.abono), 'Saldo': m.saldo,
    })));
}

// ---------------------------------------------------------------- cartera: por envío
function loadCarteraDetalleData() {
    run(async () => {
        fullCarteraDetalleData = await fetchAll(() => sb.from('cartera_detalle').select('*')
            .order('fecha_venta', { ascending: false }).order('envio'));
        filterCarteraDetalle();
    });
}

function renderCarteraDetalleTable(d) {
    $('carteraDetalleTableBody').innerHTML = d.map(r => `<tr><td>${fmtFecha(r.fecha_venta)}</td><td>${esc(r.tienda)}</td><td>${esc(r.cliente)}</td><td>${esc(r.envio)}</td><td class="num">${fmtQ(r.valor_venta)}</td><td class="num">${fmtQ(r.valor_pago)}</td><td class="num ${num(r.cartera) < 0 ? 'saldo-negativo' : ''}">${fmtQ(r.cartera)}</td></tr>`).join('');
    const sum = k => d.reduce((s, r) => s + num(r[k]), 0);
    $('carteraDetalleVenta').textContent = fmtQ(sum('valor_venta'));
    $('carteraDetallePago').textContent = fmtQ(sum('valor_pago'));
    $('carteraDetalleSaldo').textContent = fmtQ(sum('cartera'));
}

function carteraDetalleFiltrada() {
    const t = $('filterCarteraDetalleTienda').value, c = norm($('filterCarteraDetalleCliente').value), e = norm($('filterCarteraDetalleEnvio').value);
    return fullCarteraDetalleData.filter(r =>
        (!t || r.tienda === t) && norm(r.cliente).includes(c) && norm(r.envio).includes(e));
}
const filterCarteraDetalle = () => renderCarteraDetalleTable(carteraDetalleFiltrada());

function exportCarteraDetalle() {
    exportarExcel('Cartera_por_envio', 'Cartera por envío', carteraDetalleFiltrada().map(r => ({
        'Fecha venta': aFecha(r.fecha_venta), 'Tienda': r.tienda, 'Cliente': r.cliente, 'Envío': r.envio,
        'Valor venta': r.valor_venta, 'Valor pago': r.valor_pago, 'Cartera': r.cartera,
    })));
}

// ---------------------------------------------------------------- inventario: referencias
// Carga el catálogo de referencias y actualiza todas las listas que lo usan
async function cargarReferencias() {
    referencias = ok(await sb.from('productos').select('*').order('orden').order('nombre'));
    dropdownData.productos = referencias.filter(r => r.activo).map(r => r.nombre);
    const conInventario = referencias.filter(r => r.activo && r.controla_inventario).map(r => r.nombre);
    repoblar('cargaProducto', conInventario, 'Seleccione Referencia...');
    repoblar('filterProducto', referencias.map(r => r.nombre), 'Todos');
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
    $('referenciasTableBody').innerHTML = referenciasFiltradas().map(r => `<tr class="${r.activo ? '' : 'text-muted'}"><td>${esc(r.codigo)}</td><td>${esc(r.nombre)}</td><td>${esc(r.tipo)}</td><td>${esc(r.unidad)}</td><td>${si(r.controla_inventario)}</td><td>${si(r.activo)}</td><td class="num ${num(r.saldo_total) < 0 ? 'saldo-negativo' : ''}">${r.saldo_total == null ? '' : fmt(r.saldo_total)}</td><td><button type="button" class="btn btn-outline-secondary btn-sm edit-ref" data-nombre="${esc(r.nombre)}" title="Editar"><i class="bi bi-pencil"></i></button></td></tr>`).join('');
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
        repoblarUnicos('filterCargasProducto', cargasFilas.map(r => r.producto), 'Todas las referencias');
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
        'Tienda': r.tienda, 'Referencia': r.producto, 'Unidad': r.unidad,
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
    populateDropdown('movProducto', [...new Set(fullInventoryData.filter(r => !t || r.tienda === t).map(r => r.producto))].sort(), 'Seleccione Referencia...');
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
            $('movimientosInfo').textContent = 'Seleccione tienda y referencia.';
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
        'Tienda': r.tienda, 'Referencia': r.producto, 'Fecha': aFecha(r.fecha), 'Origen': r.origen, 'Detalle': r.detalle,
        'Entrada': num(r.entrada), 'Salida': num(r.salida), 'Saldo': r.saldo,
    })));
}

// ---------------------------------------------------------------- clientes (listado)
function loadClientesData() {
    run(async () => {
        const [d] = await Promise.all([
            fetchAll(() => sb.from('clientes').select('*').order('nombre').order('id')),
            esAdmin() ? cargarPerfiles() : null,
        ]);
        fullClientesData = d;
        filterClientes();
    });
}

function clientesFiltrados() {
    const q = norm($('filterClientes').value);
    return fullClientesData.filter(c =>
        !q || String(c.id) === q || [c.nombre, c.dpi, c.nit, c.telefono, c.telefono2, c.correo].some(v => norm(v).includes(q)));
}

function filterClientes() {
    const d = clientesFiltrados();
    const admin = esAdmin();
    $('clientesTableBody').innerHTML = d.slice(0, 1500).map(c => `<tr>
        <td class="num fw-semibold">${c.id}</td><td>${esc(c.nombre)}</td><td>${esc(c.dpi)}</td><td>${esc(c.nit)}</td>
        <td>${esc([c.telefono, c.telefono2].filter(Boolean).join(' / '))}</td><td>${esc(c.correo)}</td><td>${esc(c.direccion)}</td>
        <td>${esc(c.departamento)}</td>${admin ? `<td>${esc(nombreUsuario(c.creado_por)) || '<span class="text-muted">—</span>'}</td>` : ''}
        <td><button type="button" class="btn btn-outline-secondary btn-sm edit-client" data-id="${c.id}" title="Editar"><i class="bi bi-pencil"></i></button></td></tr>`).join('');
    $('clientesRowCount').textContent = d.length + (d.length > 1500 ? ' (se muestran 1500; use el buscador)' : '');
}

function exportClientes() {
    exportarExcel('Clientes', 'Clientes', clientesFiltrados().map(c => ({
        'Código cliente': c.id, 'Nombre y apellido': c.nombre, 'DPI': c.dpi, 'NIT': c.nit, 'NIT2': c.nit2,
        'Teléfono': c.telefono, 'Otro teléfono': c.telefono2, 'Correo': c.correo, 'Dirección': c.direccion,
        'Departamento': c.departamento, 'Fecha de nacimiento': aFecha(c.fecha_nacimiento),
        'Referencia anterior': c.codigo_cliente, ...(esAdmin() ? { 'Responsable': nombreUsuario(c.creado_por) } : {}),
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
        const porUsuario = {};
        clientes.forEach(c => { if (c.creado_por) porUsuario[c.creado_por] = (porUsuario[c.creado_por] || 0) + 1; });
        $('usuariosTableBody').innerHTML = perfiles.map(p => {
            const yo = p.id === perfil.id;
            const u = usoRango[p.id];
            return `<tr class="${p.activo ? '' : 'text-muted'}" data-id="${p.id}">
                <td>${esc(p.nombre)}${yo ? ' <span class="badge text-bg-light">usted</span>' : ''}</td>
                <td class="fw-semibold">${esc(p.usuario || aUsuario(p.email))}</td>
                <td>${p.rol === 'admin' ? 'Administrador' : 'Vendedor'}</td>
                <td><select class="form-select form-select-sm usr-tienda" data-id="${p.id}" aria-label="Tienda">
                    <option value="">(sin tienda)</option>
                    ${[...new Set([...maestros.tiendas.filter(x => x.activo !== false).map(x => x.nombre), p.tienda].filter(Boolean))]
                        .map(n => `<option value="${esc(n)}" ${n === p.tienda ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></td>
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

// ---------------------------------------------------------------- datos en bruto (administradores)
const TABLAS_DATOS = [
    { tabla: 'ventas', titulo: 'Ventas', orden: 'id' },
    { tabla: 'pagos', titulo: 'Pagos', orden: 'id' },
    { tabla: 'clientes', titulo: 'Clientes', orden: 'id' },
    { tabla: 'cartera_clientes', titulo: 'Cartera por cliente', orden: 'codigo' },
    { tabla: 'estado_cuenta', titulo: 'Estado de cuenta (todos)', orden: 'cliente_id' },
    { tabla: 'pagos_detalle', titulo: 'Pagos recibidos (detalle)', orden: 'fecha_pago' },
    { tabla: 'cartera_detalle', titulo: 'Cartera por envío', orden: 'envio' },
    { tabla: 'devoluciones', titulo: 'Devoluciones', orden: 'id' },
    { tabla: 'ingresos_inventario', titulo: 'Ingresos de inventario', orden: 'id' },
    { tabla: 'devoluciones_oficina', titulo: 'Devolución a oficina', orden: 'id' },
    { tabla: 'inventario_items', titulo: 'Inventario (configuración)', orden: 'id' },
    { tabla: 'inventario', titulo: 'Inventario (saldos)', orden: 'tienda' },
    { tabla: 'inventario_movimientos', titulo: 'Inventario (movimientos)', orden: 'fecha' },
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
        datosFilas = await fetchAll(() => sb.from(t.tabla).select('*').order(t.orden));
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
    tiendas: { grupo: 'tiendas', nuevo: 'Nueva tienda o bodega' },
    vendedores: { grupo: 'vendedores', nuevo: 'Nuevo vendedor' },
    metodos_pago: { grupo: 'métodos de pago', nuevo: 'Nuevo método de pago' },
    tipos: { grupo: 'tipos', nuevo: 'Nuevo tipo' },
    departamentos: { grupo: 'departamentos', nuevo: 'Nuevo departamento' },
};
const maestros = { tiendas: [], vendedores: [], metodos_pago: [], tipos: [], departamentos: [] };

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
    if (faltantes.length) showAlert(`La base de datos no está actualizada (${faltantes.join(', ')}). Ejecute supabase/01_esquema.sql en el SQL Editor de Supabase.`, 'warning');
    Object.assign(maestros, { tiendas, vendedores, metodos_pago, tipos, departamentos });
    const todos = l => l.map(x => x.nombre);
    const activos = l => l.filter(x => x.activo !== false).map(x => x.nombre);

    // Filtros de consulta: todos. Formularios: solo activos.
    ['filterTienda', 'filterCarteraDetalleTienda'].forEach(id => repoblar(id, todos(tiendas), 'Todas'));
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

    for (const m of Object.keys(MAESTROS)) {
        $(`maestro-${m}`).innerHTML = maestros[m].map(x => `<tr class="${x.activo === false ? 'text-muted' : ''}">
            <td>${esc(x.nombre)}</td>
            ${m === 'tiendas' ? `<td><select class="form-select form-select-sm maestro-clase" data-nombre="${esc(x.nombre)}" aria-label="Tipo">
                ${['TIENDA', 'BODEGA'].map(c => `<option value="${c}" ${x.clase === c ? 'selected' : ''}>${c === 'TIENDA' ? 'Tienda' : 'Bodega'}</option>`).join('')}</select></td>` : ''}
            <td class="text-center"><div class="form-check form-switch d-inline-block m-0"><input class="form-check-input maestro-activo" type="checkbox" role="switch" data-maestro="${m}" data-nombre="${esc(x.nombre)}" ${x.activo === false ? '' : 'checked'} aria-label="Activo"></div></td>
            <td class="text-end"><button type="button" class="btn btn-outline-danger btn-sm maestro-delete" data-maestro="${m}" data-nombre="${esc(x.nombre)}" title="Eliminar"><i class="bi bi-trash"></i></button></td>
        </tr>`).join('');
    }
}

const normalizarNombre = v => v.trim().toUpperCase().replace(/\s+/g, ' ');

// Inserta en un maestro y recarga las listas. Devuelve el nombre guardado.
// Si ya existe activo y permitirExistente, devuelve el existente.
async function insertarMaestro(m, nombre, clase, permitirExistente = false) {
    const existente = maestros[m].find(x => norm(x.nombre) === norm(nombre));
    if (existente && existente.activo !== false && permitirExistente) return existente.nombre;
    if (existente) throw new Error(`"${existente.nombre}" ya existe${existente.activo === false ? ' (está inactivo: actívelo en Maestros)' : ''}.`);
    const orden = Math.max(0, ...maestros[m].map(x => x.orden || 0)) + 1;
    ok(await sb.from(m).insert({ nombre, orden, activo: true, ...(m === 'tiendas' ? { clase } : {}) }));
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
    crearModal.show();
}

function guardarCrear(e) {
    e.preventDefault();
    const { m, destino } = crearDestino;
    const nombre = normalizarNombre($('crearNombre').value);
    if (!nombre) return;
    const clase = $('crearClase').value;
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

function loadInteligencia() {
    run(async () => {
        const [desde, hasta] = rangoPeriodo();
        indicadores = ok(await sb.rpc('indicadores_comerciales', { p_desde: desde, p_hasta: hasta }));
        renderInteligencia();
    });
}

function renderInteligencia() {
    const d = indicadores;
    $('intAlcance').textContent = esAdmin() ? 'Cartera y ventas de todos los clientes · inventario de todas las bodegas'
        : 'Cartera y ventas de sus clientes · inventario de todas las bodegas';
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
    $('badgeTraslados').textContent = n;
    $('badgeTraslados').classList.toggle('d-none', !n);
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
        const refs = referencias.filter(r => r.activo && r.controla_inventario)
            .sort((a, b) => (a.unidad === 'GRAMOS' ? 0 : 1) - (b.unidad === 'GRAMOS' ? 0 : 1));
        repoblar('trasladoProducto', refs.map(r => r.nombre), 'Seleccione...');
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
        'Referencia': t.producto, 'Cantidad': num(t.cantidad), 'Estado': t.estado, 'Enviado por': nombreUsuario(t.enviado_por),
        'Recibido / anulado por': nombreUsuario(t.recibido_por), 'Observaciones': t.observaciones, 'Obs. recepción': t.obs_recepcion,
    })));
}
