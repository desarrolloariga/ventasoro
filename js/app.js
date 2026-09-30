// =====================================================================
//  Joyería ARIGA - Lógica de la aplicación (equivalente a Index.html +
//  Código.gs de Apps Script, usando Supabase como base de datos).
// =====================================================================
const CFG = window.ARIGA_CONFIG;
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    db: { schema: CFG.SCHEMA },
    auth: { persistSession: false, autoRefreshToken: false },
});

let dropdownData = { tiendas: [], vendedores: [], tipos: [], productos: [], metodos: [] };
let createClientModal;
let fullHistoryData = [], fullCarteraTotalData = [], fullCarteraDetalleData = [], fullInventoryData = [];
let fullClientesData = [], datosFilas = [];
let referencias = [], movimientosFilas = [];
let referenciaModal;

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

// ---------------------------------------------------------------- inicio
document.addEventListener('DOMContentLoaded', () => {
    createClientModal = new bootstrap.Modal($('createClientModal'));
    referenciaModal = new bootstrap.Modal($('referenciaModal'));
    iniciarApp();
});

function iniciarApp() {
    run(async () => {
        const [tiendas, tipos, vendedores, metodos, deptos] = await Promise.all(
            ['tiendas', 'tipos', 'vendedores', 'metodos_pago'].map(t =>
                sb.from(t).select('nombre').order('orden').then(ok).then(r => r.map(x => x.nombre)))
            .concat(sb.from('coordenadas').select('departamento').order('departamento').then(ok).then(r => r.map(x => x.departamento)))
        );
        dropdownData = { ...dropdownData, tiendas, tipos, vendedores, metodos };
        await cargarReferencias();

        ['tiendaSelect', 'filterTienda', 'filterCarteraTotalTienda', 'filterCarteraDetalleTienda']
            .forEach(id => populateDropdown(id, tiendas, 'Todas'));
        $('tiendaSelect').options[0].textContent = 'Seleccione Tienda...';
        populateDropdown('cargaTienda', tiendas, 'Seleccione Tienda...');
        populateDropdown('filterTipo', tipos, 'Todos');
        populateDropdown('refTipo', tipos, '(sin tipo)');
        populateDropdown('vendedorSelect', vendedores, 'Seleccione Vendedor...');
        $('cargaFecha').value = hoyISO();
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
    // Al elegir una referencia se completa su tipo
    $('productLines').addEventListener('change', e => {
        if (!e.target.classList.contains('product-producto')) return;
        const ref = referencias.find(r => r.nombre === e.target.value);
        if (ref?.tipo) setSelectValue(e.target.closest('tr').querySelector('.product-tipo'), ref.tipo);
    });
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

    // Inventario: cada sub-sección se recarga al abrirla
    const subInventario = { 'pills-saldos-tab': loadInventoryData, 'pills-carga-tab': loadCargas,
        'pills-referencias-tab': loadReferencias, 'pills-movimientos-tab': loadMovimientos };
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
    $('cargaNuevaRefButton').addEventListener('click', () => abrirModalReferencia());
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
    $('exportMovimientosButton').addEventListener('click', exportMovimientos);

    // Clientes
    $('clientes-tab').addEventListener('shown.bs.tab', loadClientesData);
    $('filterClientes').addEventListener('input', filterClientes);
    $('newClientButton').addEventListener('click', () => abrirModalCliente({}, 'clientes'));
    $('clientesTableBody').addEventListener('click', e => {
        const b = e.target.closest('.edit-client');
        if (b) abrirModalCliente(fullClientesData.find(c => c.id === Number(b.dataset.id)), 'clientes');
    });

    // Datos en bruto
    $('datosTabla').innerHTML = TABLAS_DATOS.map((t, i) => `<option value="${i}">${esc(t.titulo)}</option>`).join('');
    $('datos-tab').addEventListener('shown.bs.tab', loadDatos);
    $('datosTabla').addEventListener('change', loadDatos);
    $('filterDatos').addEventListener('input', filterDatos);

    // Exportar a Excel (exporta lo que está filtrado en pantalla)
    $('exportHistoricoButton').addEventListener('click', exportHistorico);
    $('exportCarteraTotalButton').addEventListener('click', exportCarteraTotal);
    $('exportCarteraDetalleButton').addEventListener('click', exportCarteraDetalle);
    $('exportClientesButton').addEventListener('click', exportClientes);
    $('exportDatosButton').addEventListener('click', exportDatos);
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
            // Precarga el dato buscado: si es numérico va a DPI, si no al nombre
            abrirModalCliente(/^\d[\d-]*$/.test(s) ? { dpi: s } : { nombre: s }, 'venta');
        }
    });
}

// Campos del modal <-> columnas de la tabla clientes
const CAMPOS_CLIENTE = {
    newClientDPI: 'dpi', newClientNIT: 'nit', newClientNombre: 'nombre',
    newClientFechaNac: 'fecha_nacimiento', newClientDepto: 'departamento',
    newClientTel: 'telefono', newClientNIT2: 'nit2', newClientCodigo: 'codigo_cliente',
};
let origenModalCliente = 'venta'; // 'venta' llena el formulario de venta al guardar

// c.id presente = edición; origen: 'venta' o 'clientes'
function abrirModalCliente(c = {}, origen = 'clientes') {
    origenModalCliente = origen;
    $('createClientForm').reset();
    $('editClientId').value = c.id || '';
    $('clientModalTitle').textContent = c.id ? 'Editar Cliente' : 'Crear Nuevo Cliente';
    for (const [id, col] of Object.entries(CAMPOS_CLIENTE)) {
        if (id === 'newClientDepto') setSelectValue(id, c[col]); else $(id).value = c[col] ?? '';
    }
    createClientModal.show();
}

function saveNewClient() {
    const d = {};
    for (const [id, col] of Object.entries(CAMPOS_CLIENTE)) d[col] = $(id).value.trim() || null;
    if (!d.nombre) { $('newClientNombre').reportValidity(); return; }
    const id = $('editClientId').value;
    run(async () => {
        const c = id
            ? ok(await sb.from('clientes').update(d).eq('id', id).select().single())
            : ok(await sb.from('clientes').insert(d).select().single());
        createClientModal.hide();
        if (origenModalCliente === 'venta') {
            $('clientDPI').value = c.dpi || c.nit || c.nombre;
            $('clientName').value = c.nombre;
            $('clientNIT').value = c.nit || '';
        } else {
            const i = fullClientesData.findIndex(x => x.id === c.id);
            if (i >= 0) fullClientesData[i] = c; else fullClientesData.unshift(c);
            filterClientes();
        }
        showAlert(id ? 'Cliente actualizado con éxito' : 'Cliente creado con éxito', 'success');
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
            const faltantes = await verificarStock(header.tienda, productLines);
            if (faltantes.length && !confirm('Inventario insuficiente:\n\n' + faltantes.join('\n') + '\n\n¿Registrar la venta de todas formas?')) return;
            const id = ok(await sb.rpc('registrar_venta', { p_venta: venta }));
            showAlert('Venta registrada con éxito. ID: ' + id, 'success');
        } else {
            const m = ok(await sb.rpc('actualizar_venta', { p_envio: envioOriginal, p_venta: venta }));
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
function setSelectValue(idOElemento, value) {
    const s = typeof idOElemento === 'string' ? $(idOElemento) : idOElemento;
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

function historicoFiltrado() {
    const c = norm($('filterCliente').value), t = $('filterTienda').value, tp = $('filterTipo').value, p = $('filterProducto').value;
    return fullHistoryData.filter(r =>
        norm(r.cliente).includes(c) && (!t || r.tienda === t) && (!tp || r.tipo === tp) && (!p || r.producto === p));
}
const filterHistory = () => renderHistoryTable(historicoFiltrado());

function exportHistorico() {
    exportarExcel('Historico_ventas', 'Histórico', historicoFiltrado().map(r => ({
        'Fecha': aFecha(r.fecha_venta), 'Tienda': r.tienda, 'Vendedor': r.vendedor, 'Cliente': r.cliente,
        'Tipo': r.tipo, 'Producto': r.producto, 'Cantidad': r.cantidad, 'Valor unitario': r.valor_unitario,
    })));
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

function carteraTotalFiltrada() {
    const t = $('filterCarteraTotalTienda').value, c = norm($('filterCarteraTotalCliente').value);
    return fullCarteraTotalData.filter(r => (!t || r.tienda === t) && norm(r.cliente).includes(c));
}
const filterCarteraTotal = () => renderCarteraTotalTable(carteraTotalFiltrada());

function exportCarteraTotal() {
    exportarExcel('Cartera_total', 'Total Cartera', carteraTotalFiltrada().map(r => ({
        'Tienda': r.tienda, 'Cliente': r.cliente, 'Valor cartera': r.valor_cartera,
    })));
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

function carteraDetalleFiltrada() {
    const t = $('filterCarteraDetalleTienda').value, c = norm($('filterCarteraDetalleCliente').value), e = norm($('filterCarteraDetalleEnvio').value);
    return fullCarteraDetalleData.filter(r =>
        (!t || r.tienda === t) && norm(r.cliente).includes(c) && norm(r.envio).includes(e));
}
const filterCarteraDetalle = () => renderCarteraDetalleTable(carteraDetalleFiltrada());

function exportCarteraDetalle() {
    exportarExcel('Cartera_detalle', 'Detalle Cartera', carteraDetalleFiltrada().map(r => ({
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
    const sel = $('cargaProducto').value;
    populateDropdown('cargaProducto', conInventario, 'Seleccione Referencia...');
    $('cargaProducto').value = sel;
    const selH = $('filterProducto').value;
    populateDropdown('filterProducto', referencias.map(r => r.nombre), 'Todos');
    $('filterProducto').value = selH;
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

function abrirModalReferencia(r = null) {
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
        // Si se creó desde "Cargar inventario", queda seleccionada
        if (!editando && $('pills-carga-tab').classList.contains('active')) { $('cargaProducto').value = nombre; mostrarSaldoCarga(); }
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
        const d = ok(await sb.from('ingresos_inventario').select('*').order('id', { ascending: false }).limit(100));
        $('cargasTableBody').innerHTML = d.map(r => `<tr><td>${fmtFecha(r.fecha)}</td><td>${esc(r.tienda)}</td><td>${esc(r.producto)}</td><td>${esc(r.concepto)}</td><td class="num">${r.entrada ? fmt(r.entrada) : ''}</td><td class="num">${r.salida ? fmt(r.salida) : ''}</td><td>${esc(r.observaciones)}</td><td><button type="button" class="btn btn-outline-danger btn-sm delete-carga" data-id="${r.id}" title="Eliminar"><i class="bi bi-trash"></i></button></td></tr>`).join('');
        mostrarSaldoCarga();
    });
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
    if (!confirm('¿Eliminar esta carga de inventario?')) return;
    run(async () => {
        ok(await sb.from('ingresos_inventario').delete().eq('id', id));
        showAlert('Carga eliminada', 'success');
        loadCargas();
    });
}

// ---------------------------------------------------------------- inventario: saldos
function loadInventoryData() {
    run(async () => {
        fullInventoryData = ok(await sb.from('inventario').select('*').order('tienda').order('producto'));
        // Los filtros se arman con lo que existe en el inventario
        const keep = id => $(id).value;
        const [t, p] = [keep('filterInventarioTienda'), keep('filterInventarioProducto')];
        populateDropdown('filterInventarioTienda', [...new Set(fullInventoryData.map(r => r.tienda))], 'Todas');
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
        fullClientesData = await fetchAll(() => sb.from('clientes').select('*').order('nombre').order('id'));
        filterClientes();
    });
}

function clientesFiltrados() {
    const q = norm($('filterClientes').value);
    return fullClientesData.filter(c =>
        !q || [c.nombre, c.dpi, c.nit, c.telefono].some(v => norm(v).includes(q)));
}

function filterClientes() {
    const d = clientesFiltrados();
    $('clientesTableBody').innerHTML = d.map(c => `<tr><td>${esc(c.nombre)}</td><td>${esc(c.dpi)}</td><td>${esc(c.nit)}</td><td>${esc(c.telefono)}</td><td>${esc(c.departamento)}</td><td>${fmtFecha(c.fecha_nacimiento)}</td><td><button type="button" class="btn btn-outline-secondary btn-sm edit-client" data-id="${c.id}" title="Editar"><i class="bi bi-pencil"></i></button></td></tr>`).join('');
    $('clientesRowCount').textContent = d.length;
}

function exportClientes() {
    exportarExcel('Clientes', 'Clientes', clientesFiltrados().map(c => ({
        'DPI': c.dpi, 'NIT': c.nit, 'Nombre y apellido': c.nombre, 'Fecha de nacimiento': aFecha(c.fecha_nacimiento),
        'Departamento': c.departamento, 'Teléfono': c.telefono, 'NIT2': c.nit2, 'Código cliente': c.codigo_cliente,
    })));
}

// ---------------------------------------------------------------- datos en bruto
const TABLAS_DATOS = [
    { tabla: 'ventas', titulo: 'Ventas', orden: 'id' },
    { tabla: 'pagos', titulo: 'Pagos', orden: 'id' },
    { tabla: 'clientes', titulo: 'Clientes', orden: 'id' },
    { tabla: 'devoluciones', titulo: 'Devoluciones', orden: 'id' },
    { tabla: 'ingresos_inventario', titulo: 'Ingresos de inventario', orden: 'id' },
    { tabla: 'devoluciones_oficina', titulo: 'Devolución a oficina', orden: 'id' },
    { tabla: 'inventario_items', titulo: 'Inventario (configuración)', orden: 'id' },
    { tabla: 'inventario', titulo: 'Inventario (saldos)', orden: 'tienda' },
    { tabla: 'inventario_movimientos', titulo: 'Inventario (movimientos)', orden: 'fecha' },
    { tabla: 'cartera_detalle', titulo: 'Cartera detalle', orden: 'envio' },
    { tabla: 'cartera_total', titulo: 'Cartera total', orden: 'tienda' },
    { tabla: 'tiendas', titulo: 'Maestro: Tiendas', orden: 'orden' },
    { tabla: 'vendedores', titulo: 'Maestro: Vendedores', orden: 'orden' },
    { tabla: 'tipos', titulo: 'Maestro: Tipos', orden: 'orden' },
    { tabla: 'productos', titulo: 'Referencias (productos)', orden: 'orden' },
    { tabla: 'metodos_pago', titulo: 'Maestro: Métodos de pago', orden: 'orden' },
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
