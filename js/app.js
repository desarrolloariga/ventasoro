// =====================================================================
//  Joyería ARIGA - Lógica de la aplicación (equivalente a Index.html +
//  Código.gs de Apps Script, usando Supabase como base de datos).
// =====================================================================
const CFG = window.ARIGA_CONFIG;
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    db: { schema: CFG.SCHEMA },
});

let dropdownData = { tiendas: [], vendedores: [], tipos: [], productos: [], metodos: [] };
let createClientModal;
let fullHistoryData = [], fullCarteraTotalData = [], fullCarteraDetalleData = [], fullInventoryData = [];
let appIniciada = false;

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
const norm = v => String(v ?? '').trim().toLowerCase();

const showAlert = (m, t = 'info') => {
    $('alert-container').innerHTML =
        `<div class="alert alert-${t} alert-dismissible fade show">${esc(m)}<button class="btn-close" data-bs-dismiss="alert"></button></div>`;
    $('alert-container').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const populateDropdown = (id, opts, placeholder) => {
    const s = $(id);
    if (!s) return;
    s.innerHTML = `<option value="">${esc(placeholder)}</option>` +
        opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
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

// ---------------------------------------------------------------- autenticación
document.addEventListener('DOMContentLoaded', async () => {
    createClientModal = new bootstrap.Modal($('createClientModal'));
    $('loginForm').addEventListener('submit', handleLogin);
    $('logoutButton').addEventListener('click', () => sb.auth.signOut());

    sb.auth.onAuthStateChange((_event, session) => mostrarVista(session));
    const { data } = await sb.auth.getSession();
    mostrarVista(data.session);
});

function mostrarVista(session) {
    const logueado = !!session;
    $('loginView').classList.toggle('d-none', logueado);
    $('appView').classList.toggle('d-none', !logueado);
    $('userBox').classList.toggle('d-none', !logueado);
    if (logueado) {
        $('userEmail').textContent = session.user.email;
        if (!appIniciada) { appIniciada = true; iniciarApp(); }
    }
}

async function handleLogin(e) {
    e.preventDefault();
    $('loginError').classList.add('d-none');
    showSpinner();
    const { error } = await sb.auth.signInWithPassword({
        email: $('loginEmail').value.trim(),
        password: $('loginPassword').value,
    });
    hideSpinner();
    if (error) {
        $('loginError').textContent = 'No se pudo iniciar sesión: ' + error.message;
        $('loginError').classList.remove('d-none');
    }
}

// ---------------------------------------------------------------- inicio
function iniciarApp() {
    run(async () => {
        const [tiendas, tipos, vendedores, productos, metodos, deptos] = await Promise.all(
            ['tiendas', 'tipos', 'vendedores', 'productos', 'metodos_pago'].map(t =>
                sb.from(t).select('nombre').order('orden').then(ok).then(r => r.map(x => x.nombre)))
            .concat(sb.from('coordenadas').select('departamento').order('departamento').then(ok).then(r => r.map(x => x.departamento)))
        );
        dropdownData = { tiendas, tipos, vendedores, productos, metodos };

        ['tiendaSelect', 'filterTienda', 'filterCarteraTotalTienda', 'filterCarteraDetalleTienda']
            .forEach(id => populateDropdown(id, tiendas, 'Todas'));
        $('tiendaSelect').options[0].textContent = 'Seleccione Tienda...';
        populateDropdown('filterTipo', tipos, 'Todos');
        populateDropdown('filterProducto', productos, 'Todos');
        populateDropdown('vendedorSelect', vendedores, 'Seleccione Vendedor...');
        populateDropdown('newClientDepto', deptos, 'Seleccione...');
        $('metodosPagoList').innerHTML = metodos.map(m => `<option value="${esc(m)}">`).join('');
        $('fechaPago').value = hoyISO();
    });

    // Registro y Clientes
    $('searchClientButton').addEventListener('click', searchClient);
    $('clientDPI').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchClient(); } });
    $('saveClientButton').addEventListener('click', saveNewClient);
    $('addProductButton').addEventListener('click', () => addProductLine());
    $('saleForm').addEventListener('submit', handleFormSubmit);
    $('productLines').addEventListener('input', updateLineTotal);
    $('productLines').addEventListener('click', e => {
        if (e.target.classList.contains('delete-row')) { e.target.closest('tr').remove(); updateSubtotal(); }
    });

    // Búsqueda de Pedidos
    $('searchEnvioButton').addEventListener('click', searchOrder);
    $('searchEnvioInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchOrder(); });
    $('deleteOrderButton').addEventListener('click', deleteOrder);
    $('newSaleButton').addEventListener('click', resetForm);

    // Pagos
    $('searchPaymentEnvioButton').addEventListener('click', searchShipmentForPayment);
    $('searchPaymentEnvioInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchShipmentForPayment(); } });
    $('paymentForm').addEventListener('submit', handlePaymentSubmit);

    // Consultas (se recargan cada vez que se abre la pestaña)
    $('historico-tab').addEventListener('shown.bs.tab', loadHistoryData);
    ['filterCliente', 'filterTienda', 'filterTipo', 'filterProducto'].forEach(id => $(id).addEventListener('input', filterHistory));

    $('cartera-tab').addEventListener('shown.bs.tab', () =>
        $('pills-detalle-tab').classList.contains('active') ? loadCarteraDetalleData() : loadCarteraTotalData());
    $('pills-total-tab').addEventListener('shown.bs.tab', loadCarteraTotalData);
    $('pills-detalle-tab').addEventListener('shown.bs.tab', loadCarteraDetalleData);
    ['filterCarteraTotalTienda', 'filterCarteraTotalCliente'].forEach(id => $(id).addEventListener('input', filterCarteraTotal));
    ['filterCarteraDetalleTienda', 'filterCarteraDetalleCliente', 'filterCarteraDetalleEnvio'].forEach(id => $(id).addEventListener('input', filterCarteraDetalle));

    $('inventario-tab').addEventListener('shown.bs.tab', loadInventoryData);
    ['filterInventarioTienda', 'filterInventarioProducto'].forEach(id => $(id).addEventListener('input', filterInventory));
}

// ---------------------------------------------------------------- clientes
function searchClient() {
    const s = $('clientDPI').value.trim();
    if (!s) return;
    run(async () => {
        const [c] = ok(await sb.rpc('buscar_cliente', { p_termino: s }));
        if (c) {
            $('clientDPI').value = c.dpi || c.nit || c.nombre;
            $('clientName').value = c.nombre;
            $('clientNIT').value = c.nit || '';
        } else if (confirm('Cliente no encontrado. ¿Desea crearlo?')) {
            $('createClientForm').reset();
            // Precarga el dato buscado: si es numérico va a DPI, si no al nombre
            if (/^\d[\d-]*$/.test(s)) $('newClientDPI').value = s; else $('newClientNombre').value = s;
            createClientModal.show();
        }
    });
}

function saveNewClient() {
    const d = {
        dpi: $('newClientDPI').value.trim() || null,
        nit: $('newClientNIT').value.trim() || null,
        nombre: $('newClientNombre').value.trim(),
        fecha_nacimiento: $('newClientFechaNac').value || null,
        departamento: $('newClientDepto').value || null,
        telefono: $('newClientTel').value.trim() || null,
    };
    if (!d.nombre) { $('newClientNombre').reportValidity(); return; }
    run(async () => {
        const c = ok(await sb.from('clientes').insert(d).select().single());
        createClientModal.hide();
        $('clientDPI').value = c.dpi || c.nit || c.nombre;
        $('clientName').value = c.nombre;
        $('clientNIT').value = c.nit || '';
        showAlert('Cliente creado con éxito', 'success');
    });
}

// ---------------------------------------------------------------- ventas
const getOptionsHTML = (opts, sel) => {
    // Si el valor guardado ya no está en Maestros se conserva igual
    const lista = sel && !opts.includes(sel) ? [...opts, sel] : opts;
    return `<option value="">...</option>` +
        lista.map(x => `<option value="${esc(x)}" ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('');
};

function addProductLine(d = {}) {
    const r = document.createElement('tr');
    r.innerHTML = `
        <td><select class="form-select form-select-sm product-tipo" required>${getOptionsHTML(dropdownData.tipos, d.tipo)}</select></td>
        <td><select class="form-select form-select-sm product-producto" required>${getOptionsHTML(dropdownData.productos, d.producto)}</select></td>
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
    const envioOriginal = $('envioOriginal').value;

    run(async () => {
        if (!envioOriginal) {
            const id = ok(await sb.rpc('registrar_venta', { p_venta: venta }));
            showAlert('Venta registrada con éxito. ID: ' + id, 'success');
        } else {
            const m = ok(await sb.rpc('actualizar_venta', { p_envio: envioOriginal, p_venta: venta }));
            showAlert(m, 'success');
        }
        resetForm();
    });
}

async function obtenerLineasEnvio(envio) {
    return ok(await sb.from('ventas').select('*').eq('envio', envio.trim()).order('id'));
}

function searchOrder() {
    const i = $('searchEnvioInput').value.trim();
    if (!i) return;
    run(async () => {
        const rows = await obtenerLineasEnvio(i);
        if (!rows.length) { showAlert('No se encontró el pedido', 'warning'); return; }
        const h = rows[0];
        $('clientDPI').value = h.documento_cliente || '';
        $('clientName').value = h.cliente || '';
        $('clientNIT').value = '';
        setSelectValue('tiendaSelect', h.tienda);
        setSelectValue('vendedorSelect', h.vendedor);
        $('pedidoId').value = h.pedido_id || '';
        $('envio').value = h.envio || '';
        $('envioOriginal').value = h.envio || '';
        $('factura').value = h.factura || '';
        $('productLines').innerHTML = '';
        rows.forEach(l => addProductLine(l));
        updateSubtotal();
        $('mainActionButton').textContent = 'Actualizar Venta';
        $('deleteOrderButton').classList.remove('d-none');
        $('newSaleButton').classList.remove('d-none');
        new bootstrap.Tab($('registro-tab')).show();
    });
}

// Selecciona un valor aunque ya no exista en Maestros (lo agrega temporalmente)
function setSelectValue(id, value) {
    const s = $(id);
    if (value && ![...s.options].some(o => o.value === value)) s.add(new Option(value, value));
    s.value = value || '';
}

function resetForm() {
    $('saleForm').reset();
    $('pedidoId').value = '';
    $('envioOriginal').value = '';
    $('productLines').innerHTML = '';
    $('mainActionButton').textContent = 'Registrar Venta';
    $('deleteOrderButton').classList.add('d-none');
    $('newSaleButton').classList.add('d-none');
    updateSubtotal();
}

function deleteOrder() {
    const i = $('envioOriginal').value;
    if (!i || !confirm('¿Está seguro de eliminar este pedido?')) return;
    run(async () => {
        const m = ok(await sb.rpc('eliminar_pedido', { p_envio: i }));
        showAlert(m, 'success');
        resetForm();
    });
}

// ---------------------------------------------------------------- pagos
function searchShipmentForPayment() {
    const i = $('searchPaymentEnvioInput').value.trim();
    if (!i) return;
    run(async () => {
        const [rows, pagos, devs] = await Promise.all([
            obtenerLineasEnvio(i),
            sb.from('pagos').select('valor_pagado').eq('envio', i).then(ok),
            sb.from('devoluciones').select('valor').eq('envio', i).then(ok),
        ]);
        if (!rows.length) {
            $('shipmentInfoContainer').classList.add('d-none');
            showAlert('Envío no encontrado', 'warning');
            return;
        }
        const h = rows[0];
        const total = rows.reduce((s, r) => s + num(r.valor_total), 0);
        const pagado = pagos.reduce((s, r) => s + num(r.valor_pagado), 0) + devs.reduce((s, r) => s + num(r.valor), 0);
        $('infoCliente').textContent = h.cliente || '';
        $('infoDocumento').textContent = h.documento_cliente || '';
        $('infoTienda').textContent = h.tienda || '';
        $('infoVendedor').textContent = h.vendedor || '';
        $('infoTipo').textContent = h.tipo || '';
        $('infoFechaVenta').textContent = fmtFecha(h.fecha_venta);
        $('infoTotal').textContent = fmt(total);
        $('infoPagado').textContent = fmt(pagado);
        $('infoSaldo').textContent = fmt(total - pagado);
        $('shipmentInfoContainer').dataset.envio = h.envio;
        $('shipmentInfoContainer').classList.remove('d-none');
    });
}

function handlePaymentSubmit(e) {
    e.preventDefault();
    const envio = $('shipmentInfoContainer').dataset.envio;
    if (!envio) { showAlert('Busque primero el envío', 'warning'); return; }
    const p = {
        fecha_pago: $('fechaPago').value,
        envio,
        metodo_pago: $('metodoPago').value.trim(),
        tipo: $('infoTipo').textContent || null,
        valor_pagado: num($('valorPagar').value),
        boleta: $('boleta').value.trim() || null,
        vendedor: $('infoVendedor').textContent || null,
    };
    run(async () => {
        ok(await sb.from('pagos').insert(p));
        showAlert(`Pago para el envío ${envio} registrado correctamente.`, 'success');
        $('paymentForm').reset();
        $('fechaPago').value = hoyISO();
        delete $('shipmentInfoContainer').dataset.envio;
        $('shipmentInfoContainer').classList.add('d-none');
    });
}

// ---------------------------------------------------------------- histórico
function loadHistoryData() {
    run(async () => {
        const d = await fetchAll(() => sb.from('ventas')
            .select('fecha_venta,tienda,vendedor,cliente,tipo,producto,cantidad,valor_unitario')
            .order('fecha_venta', { ascending: false })
            .order('id', { ascending: false }));
        fullHistoryData = d.filter(r => (r.cliente || r.producto) && r.producto !== 'SALDO INICIAL');
        filterHistory();
    });
}

function renderHistoryTable(d) {
    $('historicoTableBody').innerHTML = d.map(r => `<tr><td>${fmtFecha(r.fecha_venta)}</td><td>${esc(r.tienda)}</td><td>${esc(r.vendedor)}</td><td>${esc(r.cliente)}</td><td>${esc(r.tipo)}</td><td>${esc(r.producto)}</td><td class="num">${esc(r.cantidad)}</td><td class="num">${fmtQ(r.valor_unitario)}</td></tr>`).join('');
    $('rowCount').textContent = d.length;
}

function filterHistory() {
    const c = norm($('filterCliente').value), t = $('filterTienda').value, tp = $('filterTipo').value, p = $('filterProducto').value;
    renderHistoryTable(fullHistoryData.filter(r =>
        norm(r.cliente).includes(c) && (!t || r.tienda === t) && (!tp || r.tipo === tp) && (!p || r.producto === p)));
}

// ---------------------------------------------------------------- cartera
function loadCarteraTotalData() {
    run(async () => {
        fullCarteraTotalData = await fetchAll(() => sb.from('cartera_total').select('*')
            .order('tienda').order('cliente'));
        filterCarteraTotal();
    });
}

function renderCarteraTotalTable(d) {
    $('carteraTotalTableBody').innerHTML = d.map(r => `<tr><td>${esc(r.tienda)}</td><td>${esc(r.cliente)}</td><td class="num ${num(r.valor_cartera) < 0 ? 'saldo-negativo' : ''}">${fmtQ(r.valor_cartera)}</td></tr>`).join('');
    $('carteraTotalSuma').textContent = fmtQ(d.reduce((s, r) => s + num(r.valor_cartera), 0));
}

function filterCarteraTotal() {
    const t = $('filterCarteraTotalTienda').value, c = norm($('filterCarteraTotalCliente').value);
    renderCarteraTotalTable(fullCarteraTotalData.filter(r => (!t || r.tienda === t) && norm(r.cliente).includes(c)));
}

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

function filterCarteraDetalle() {
    const t = $('filterCarteraDetalleTienda').value, c = norm($('filterCarteraDetalleCliente').value), e = norm($('filterCarteraDetalleEnvio').value);
    renderCarteraDetalleTable(fullCarteraDetalleData.filter(r =>
        (!t || r.tienda === t) && norm(r.cliente).includes(c) && norm(r.envio).includes(e)));
}

// ---------------------------------------------------------------- inventario
function loadInventoryData() {
    run(async () => {
        fullInventoryData = ok(await sb.from('inventario').select('*').order('tienda').order('producto'));
        // Los filtros se arman con lo que existe en el inventario
        const keep = id => $(id).value;
        const [t, p] = [keep('filterInventarioTienda'), keep('filterInventarioProducto')];
        populateDropdown('filterInventarioTienda', [...new Set(fullInventoryData.map(r => r.tienda))], 'Todas');
        populateDropdown('filterInventarioProducto', [...new Set(fullInventoryData.map(r => r.producto))], 'Todos');
        $('filterInventarioTienda').value = t;
        $('filterInventarioProducto').value = p;
        filterInventory();
    });
}

function renderInventoryTable(d) {
    $('inventarioTableBody').innerHTML = d.map(r => `<tr><td>${esc(r.tienda)}</td><td>${esc(r.producto)}</td><td class="num">${fmt(r.entradas)}</td><td class="num">${fmt(r.salidas)}</td><td class="num ${num(r.saldo) < 0 ? 'saldo-negativo' : ''}">${fmt(r.saldo)}</td></tr>`).join('');
    $('inventarioRowCount').textContent = d.length;
}

function filterInventory() {
    const t = $('filterInventarioTienda').value, p = $('filterInventarioProducto').value;
    renderInventoryTable(fullInventoryData.filter(r => (!t || r.tienda === t) && (!p || r.producto === p)));
}
