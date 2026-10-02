-- =====================================================================
--  Joyería ARIGA - Esquema "tiendaariga" en Supabase
--  Replica la estructura del libro "Registro de ventas 2do".
--  Ejecutar completo en: Supabase > SQL Editor.
-- =====================================================================

create schema if not exists tiendaariga;
set search_path = tiendaariga, public;

-- ---------------------------------------------------------------------
-- USUARIOS (Supabase Auth). Un usuario de Auth solo entra a ARIGA si tiene
-- perfil activo aquí. rol: admin (ve todo) o vendedor (ve sus clientes).
-- ---------------------------------------------------------------------
create table if not exists tiendaariga.perfiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  nombre      text,
  rol         text not null default 'vendedor' check (rol in ('admin', 'vendedor')),
  activo      boolean not null default true,
  created_at  timestamptz not null default now()
);

create or replace function tiendaariga.usuario_activo()
returns boolean language sql stable security definer set search_path = tiendaariga as $$
  select exists (select 1 from perfiles where id = auth.uid() and activo)
$$;

create or replace function tiendaariga.es_admin()
returns boolean language sql stable security definer set search_path = tiendaariga as $$
  select exists (select 1 from perfiles where id = auth.uid() and activo and rol = 'admin')
$$;

-- ---------------------------------------------------------------------
-- MAESTROS (hoja "Maestros": una tabla por columna)
-- ---------------------------------------------------------------------
create table if not exists tiendaariga.tiendas (
  nombre text primary key,
  orden  int not null default 0
);
create table if not exists tiendaariga.tipos (          -- columna MATERIALES
  nombre text primary key,
  orden  int not null default 0
);
create table if not exists tiendaariga.vendedores (
  nombre text primary key,
  orden  int not null default 0
);
-- Tiendas y vendedores inactivos no aparecen al vender, pero se conservan
-- en el histórico (las ventas guardan el nombre).
alter table tiendaariga.tiendas    add column if not exists activo boolean not null default true;
alter table tiendaariga.vendedores add column if not exists activo boolean not null default true;
alter table tiendaariga.tipos      add column if not exists activo boolean not null default true;

-- Departamentos para la ficha del cliente. Si la tabla está vacía se
-- precarga con los 22 departamentos de Guatemala.
create table if not exists tiendaariga.departamentos (
  nombre text primary key,
  orden  int not null default 0,
  activo boolean not null default true
);
insert into tiendaariga.departamentos (nombre, orden)
select d, n
from unnest(array['ALTA VERAPAZ','BAJA VERAPAZ','CHIMALTENANGO','CHIQUIMULA','EL PROGRESO',
                  'ESCUINTLA','GUATEMALA','HUEHUETENANGO','IZABAL','JALAPA','JUTIAPA','PETÉN',
                  'QUETZALTENANGO','QUICHÉ','RETALHULEU','SACATEPÉQUEZ','SAN MARCOS','SANTA ROSA',
                  'SOLOLÁ','SUCHITEPÉQUEZ','TOTONICAPÁN','ZACAPA']) with ordinality as t(d, n)
where not exists (select 1 from tiendaariga.departamentos);

-- Tiendas y bodegas son el mismo concepto; "clase" solo las distingue.
-- Al crear la columna, las que se llaman "BODEGA ..." quedan como BODEGA.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'tiendaariga' and table_name = 'tiendas' and column_name = 'clase') then
    alter table tiendaariga.tiendas
      add column clase text not null default 'TIENDA' check (clase in ('TIENDA', 'BODEGA'));
    update tiendaariga.tiendas set clase = 'BODEGA' where nombre ilike 'BODEGA%';
  end if;
end $$;
-- Referencias: catálogo de lo que se vende y se controla en inventario.
-- Las ventas guardan el nombre de la referencia (ventas.producto).
create table if not exists tiendaariga.productos (
  nombre               text primary key,
  orden                int not null default 0,
  codigo               text,
  tipo                 text,
  unidad               text    not null default 'GRAMOS',
  controla_inventario  boolean not null default true,
  activo               boolean not null default true,
  created_at           timestamptz not null default now()
);
-- Para bases creadas con la versión anterior del esquema
alter table tiendaariga.productos add column if not exists codigo              text;
alter table tiendaariga.productos add column if not exists tipo                text;
alter table tiendaariga.productos add column if not exists unidad              text    not null default 'GRAMOS';
alter table tiendaariga.productos add column if not exists controla_inventario boolean not null default true;
alter table tiendaariga.productos add column if not exists activo              boolean not null default true;
alter table tiendaariga.productos add column if not exists created_at          timestamptz not null default now();
create unique index if not exists productos_codigo_uq on tiendaariga.productos (upper(codigo)) where codigo is not null;
create table if not exists tiendaariga.metodos_pago (
  nombre text primary key,
  orden  int not null default 0
);
alter table tiendaariga.metodos_pago add column if not exists activo boolean not null default true;

-- ---------------------------------------------------------------------
-- CLIENTES (hoja "Clientes")
-- ---------------------------------------------------------------------
create table if not exists tiendaariga.clientes (
  id                bigint generated always as identity primary key,
  dpi               text,
  nit               text,
  nombre            text not null,
  fecha_nacimiento  date,
  departamento      text,
  telefono          text,
  nit2              text,
  codigo_cliente    text,
  nota_importacion  text,          -- valores originales que no se pudieron convertir
  created_at        timestamptz not null default now()
);
create index if not exists clientes_dpi_idx    on tiendaariga.clientes (lower(dpi));
create index if not exists clientes_nit_idx    on tiendaariga.clientes (lower(nit));
create index if not exists clientes_nombre_idx on tiendaariga.clientes (lower(nombre));
alter table tiendaariga.clientes add column if not exists direccion  text;
alter table tiendaariga.clientes add column if not exists correo     text;
alter table tiendaariga.clientes add column if not exists telefono2  text;
-- Usuario dueño del cliente: solo él (y el administrador) lo ve
alter table tiendaariga.clientes add column if not exists creado_por uuid default auth.uid() references auth.users(id) on delete set null;
create index if not exists clientes_creado_por_idx on tiendaariga.clientes (creado_por);

-- ¿El cliente pertenece al usuario actual? (para la visibilidad de ventas y pagos)
create or replace function tiendaariga.cliente_propio(p_cliente_id bigint)
returns boolean language sql stable security definer set search_path = tiendaariga as $$
  select p_cliente_id is not null
     and exists (select 1 from clientes where id = p_cliente_id and creado_por = auth.uid())
$$;

-- ---------------------------------------------------------------------
-- VENTAS (hoja "Ventas": una fila por línea de producto)
-- ---------------------------------------------------------------------
create table if not exists tiendaariga.ventas (
  id                 bigint generated always as identity primary key,
  pedido_id          text,          -- "Id interno" (yyyyMMdd-NNN)
  fecha_venta        date,
  fecha_vencimiento  date,
  tienda             text,
  vendedor           text,
  cliente            text,
  documento_cliente  text,
  factura            text,
  envio              text,
  tipo               text,
  producto           text,
  cantidad           numeric(14,2),
  valor_unitario     numeric(14,2),
  valor_total        numeric(14,2),
  nota_importacion   text,
  created_at         timestamptz not null default now()
);
-- Consecutivo único del cliente (clientes.id). Las ventas importadas del
-- Excel no lo tienen; las nuevas lo guardan.
alter table tiendaariga.ventas add column if not exists cliente_id bigint;
create index if not exists ventas_cliente_idx on tiendaariga.ventas (cliente_id);
create index if not exists ventas_envio_idx  on tiendaariga.ventas (envio);
create index if not exists ventas_pedido_idx on tiendaariga.ventas (pedido_id);
create index if not exists ventas_fecha_idx  on tiendaariga.ventas (fecha_venta);
alter table tiendaariga.ventas add column if not exists creado_por uuid default auth.uid() references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------
-- PAGOS (hoja "Pagos")
-- ---------------------------------------------------------------------
create table if not exists tiendaariga.pagos (
  id                bigint generated always as identity primary key,
  fecha_pago        date,
  envio             text,
  factura           text,
  metodo_pago       text,
  tipo              text,
  valor_pagado      numeric(14,2),
  boleta            text,
  contabilidad      text,
  vendedor          text,
  nit               text,
  confirmacion      text,
  observaciones     text,
  nota_importacion  text,
  created_at        timestamptz not null default now()
);
create index if not exists pagos_envio_idx on tiendaariga.pagos (envio);
-- El pago es un abono al total del cliente; el envío es opcional
alter table tiendaariga.pagos add column if not exists cliente_id bigint;
alter table tiendaariga.pagos add column if not exists creado_por uuid default auth.uid() references auth.users(id) on delete set null;
create index if not exists pagos_cliente_idx on tiendaariga.pagos (cliente_id);
create index if not exists pagos_fecha_idx   on tiendaariga.pagos (fecha_pago);

-- ---------------------------------------------------------------------
-- DEVOLUCIONES (hoja "Devoluciones": abonan a la cartera del envío)
-- ---------------------------------------------------------------------
create table if not exists tiendaariga.devoluciones (
  id                 bigint generated always as identity primary key,
  tienda             text,
  pedido_id          text,
  fecha_devolucion   date,
  factura            text,
  envio              text,
  producto           text,
  valor              numeric(14,2),
  gramos             numeric(14,2),
  motivo             text,
  created_at         timestamptz not null default now()
);
create index if not exists devoluciones_envio_idx on tiendaariga.devoluciones (envio);
alter table tiendaariga.devoluciones add column if not exists creado_por uuid default auth.uid() references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------
-- INVENTARIO
-- ---------------------------------------------------------------------
-- Hoja "Ingresos de inventario": cargas (entradas) y ajustes (salidas)
create table if not exists tiendaariga.ingresos_inventario (
  id             bigint generated always as identity primary key,
  fecha          date,
  producto       text,
  tienda         text,
  concepto       text,
  entrada        numeric(14,2),
  salida         numeric(14,2),
  observaciones  text,
  created_at     timestamptz not null default now()
);
alter table tiendaariga.ingresos_inventario add column if not exists observaciones text;
alter table tiendaariga.ingresos_inventario add column if not exists creado_por uuid default auth.uid() references auth.users(id) on delete set null;

-- Hoja "Devolución a oficina"
create table if not exists tiendaariga.devoluciones_oficina (
  id                bigint generated always as identity primary key,
  fecha_devolucion  date,
  tienda            text,
  producto          text,
  cantidad          numeric(14,2),
  created_at        timestamptz not null default now()
);

-- Fechas de corte heredadas de la hoja "Inventario" (criterio ">=fecha" de
-- cada SUMIFS). Las referencias nuevas no la necesitan: usan su primera carga.
create table if not exists tiendaariga.inventario_items (
  id            bigint generated always as identity primary key,
  tienda        text not null,
  producto      text not null,
  fecha_inicio  date not null,
  unique (tienda, producto)
);

-- Hoja "Coordenadas"
create table if not exists tiendaariga.coordenadas (
  departamento  text primary key,
  latitud       numeric(12,8),
  longitud      numeric(12,8)
);

-- =====================================================================
-- VISTAS (reemplazan las hojas calculadas)
-- =====================================================================

-- "Cartera 1": venta por envío menos pagos y devoluciones
create or replace view tiendaariga.cartera_detalle
with (security_invoker = true) as
with v as (
  select envio,
         min(fecha_venta)      as fecha_venta,
         tienda,
         cliente,
         sum(coalesce(valor_total,0)) as valor_venta
  from tiendaariga.ventas
  where coalesce(trim(envio),'') <> ''
  group by envio, tienda, cliente
),
p as (select envio, sum(coalesce(valor_pagado,0)) as total from tiendaariga.pagos group by envio),
d as (select envio, sum(coalesce(valor,0))        as total from tiendaariga.devoluciones group by envio)
select v.fecha_venta,
       v.tienda,
       v.cliente,
       v.envio,
       v.valor_venta,
       coalesce(p.total,0) + coalesce(d.total,0)                 as valor_pago,
       v.valor_venta - coalesce(p.total,0) - coalesce(d.total,0) as cartera
from v
left join p on p.envio = v.envio
left join d on d.envio = v.envio;

-- "Cartera 2": saldo por tienda y cliente
create or replace view tiendaariga.cartera_total
with (security_invoker = true) as
select tienda, cliente, sum(cartera) as valor_cartera
from tiendaariga.cartera_detalle
group by tienda, cliente;

-- ---------------------------------------------------------------------
-- SALDOS DE INVENTARIO por tienda y referencia
--   entradas = cargas de inventario
--   salidas  = ventas desde la fecha de inicio + salidas manuales
--              + devoluciones a oficina
--   fecha de inicio = la definida en inventario_items (hoja original) o,
--                     si no hay, la fecha de la primera carga.
-- ---------------------------------------------------------------------
drop view if exists tiendaariga.inventario_movimientos;
drop view if exists tiendaariga.inventario;

-- Se calcula con TODAS las ventas (security definer) para que el saldo sea
-- real aunque el usuario solo vea sus propios clientes.
create view tiendaariga.inventario
with (security_invoker = false) as
with claves as (
  select trim(tienda) as tienda, trim(producto) as producto, fecha
  from tiendaariga.ingresos_inventario
  where coalesce(trim(tienda),'') <> '' and coalesce(trim(producto),'') <> ''
  union all
  select trim(tienda), trim(producto), fecha_inicio
  from tiendaariga.inventario_items
),
items as (
  select upper(tienda) as kt, upper(producto) as kp,
         min(tienda) as tienda, min(producto) as producto, min(fecha) as primera_fecha
  from claves
  group by 1, 2
),
base as (
  select it.*,
         coalesce((select max(ii.fecha_inicio) from tiendaariga.inventario_items ii
                   where upper(trim(ii.tienda)) = it.kt and upper(trim(ii.producto)) = it.kp),
                  it.primera_fecha) as fecha_inicio
  from items it
)
select b.tienda,
       b.producto,
       b.fecha_inicio,
       e.entradas,
       s.salidas,
       e.entradas - s.salidas as saldo,
       p.tipo,
       p.unidad,
       b.kt,
       b.kp
from base b
left join tiendaariga.productos p on upper(trim(p.nombre)) = b.kp
cross join lateral (
  select coalesce(sum(g.entrada),0) as entradas
  from tiendaariga.ingresos_inventario g
  where upper(trim(g.tienda)) = b.kt and upper(trim(g.producto)) = b.kp
) e
cross join lateral (
  select
    coalesce((select sum(v.cantidad) from tiendaariga.ventas v
              where upper(trim(v.tienda)) = b.kt and upper(trim(v.producto)) = b.kp
                and v.fecha_venta >= b.fecha_inicio),0)
  + coalesce((select sum(g.salida) from tiendaariga.ingresos_inventario g
              where upper(trim(g.tienda)) = b.kt and upper(trim(g.producto)) = b.kp),0)
  + coalesce((select sum(o.cantidad) from tiendaariga.devoluciones_oficina o
              where upper(trim(o.tienda)) = b.kt and upper(trim(o.producto)) = b.kp),0)
  as salidas
) s
where coalesce(p.controla_inventario, true)
  and tiendaariga.usuario_activo();

-- Kardex: cada movimiento que afecta el saldo de una tienda/referencia
create view tiendaariga.inventario_movimientos
with (security_invoker = false) as
select i.tienda, i.producto, g.fecha, 'CARGA'::text as origen,
       concat_ws(' · ', g.concepto, g.observaciones) as detalle,
       coalesce(g.entrada,0) as entrada, coalesce(g.salida,0) as salida, g.id as origen_id
from tiendaariga.inventario i
join tiendaariga.ingresos_inventario g
  on upper(trim(g.tienda)) = i.kt and upper(trim(g.producto)) = i.kp
union all
select i.tienda, i.producto, v.fecha_venta, 'VENTA',
       concat_ws(' · ', 'Pedido ' || v.pedido_id, 'Envío ' || v.envio),  -- sin cliente: puede ser de otro usuario
       0, coalesce(v.cantidad,0), v.id
from tiendaariga.inventario i
join tiendaariga.ventas v
  on upper(trim(v.tienda)) = i.kt and upper(trim(v.producto)) = i.kp
 and v.fecha_venta >= i.fecha_inicio
union all
select i.tienda, i.producto, o.fecha_devolucion, 'DEVOLUCIÓN A OFICINA', null,
       0, coalesce(o.cantidad,0), o.id
from tiendaariga.inventario i
join tiendaariga.devoluciones_oficina o
  on upper(trim(o.tienda)) = i.kt and upper(trim(o.producto)) = i.kp;

-- ---------------------------------------------------------------------
-- CARTERA POR CLIENTE: lo que compra suma, lo que paga (y devuelve) resta
-- ---------------------------------------------------------------------
create or replace view tiendaariga.estado_cuenta
with (security_invoker = true) as
select v.cliente_id, min(v.fecha_venta) as fecha, 'VENTA'::text as movimiento,
       concat_ws(' · ', 'Pedido ' || v.pedido_id, 'Envío ' || v.envio,
                 string_agg(distinct v.producto, ', ')) as detalle,
       sum(coalesce(v.valor_total,0)) as cargo, 0::numeric as abono,
       null::text as metodo_pago, min(v.id) as ref_id
from tiendaariga.ventas v
where v.cliente_id is not null
group by v.cliente_id, v.pedido_id, v.envio
union all
select p.cliente_id, p.fecha_pago, 'PAGO',
       concat_ws(' · ', 'Boleta ' || p.boleta, 'Envío ' || p.envio, p.observaciones),
       0, coalesce(p.valor_pagado,0), p.metodo_pago, p.id
from tiendaariga.pagos p
where p.cliente_id is not null
union all
select x.cliente_id, d.fecha_devolucion, 'DEVOLUCIÓN',
       concat_ws(' · ', d.producto, d.motivo, 'Envío ' || d.envio),
       0, coalesce(d.valor,0), null, d.id
from tiendaariga.devoluciones d
join lateral (select v.cliente_id from tiendaariga.ventas v
              where v.envio = d.envio and v.cliente_id is not null limit 1) x on true;

create or replace view tiendaariga.cartera_clientes
with (security_invoker = true) as
select c.id as codigo, c.nombre, c.dpi, c.nit, c.telefono,
       coalesce(m.cargos,0)                     as total_ventas,
       coalesce(m.abonos,0)                     as total_pagos,
       coalesce(m.cargos,0) - coalesce(m.abonos,0) as saldo,
       m.ultima_venta, m.ultimo_pago
from tiendaariga.clientes c
left join (
  select cliente_id, sum(cargo) as cargos, sum(abono) as abonos,
         max(fecha) filter (where movimiento = 'VENTA') as ultima_venta,
         max(fecha) filter (where movimiento = 'PAGO')  as ultimo_pago
  from tiendaariga.estado_cuenta
  group by cliente_id
) m on m.cliente_id = c.id;

-- Pagos recibidos: cómo, cuándo y quién registró cada pago
create or replace view tiendaariga.pagos_detalle
with (security_invoker = true) as
select p.id, p.fecha_pago, p.cliente_id,
       coalesce(c.nombre, (select v.cliente from tiendaariga.ventas v
                           where v.envio = p.envio limit 1)) as cliente,
       p.envio, p.metodo_pago, p.valor_pagado, p.boleta, p.vendedor, p.observaciones,
       coalesce(u.nombre, u.email) as registrado_por, p.created_at
from tiendaariga.pagos p
left join tiendaariga.clientes c on c.id = p.cliente_id
left join tiendaariga.perfiles u on u.id = p.creado_por;

-- =====================================================================
-- FUNCIONES
-- =====================================================================

-- Siguiente Id interno yyyyMMdd-NNN. Ve todas las ventas (security definer)
-- para que dos usuarios nunca obtengan el mismo número.
create or replace function tiendaariga.siguiente_pedido_id()
returns text
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  v_prefijo text := to_char((now() at time zone 'America/Guatemala')::date, 'YYYYMMDD');
  v_num     int;
begin
  perform pg_advisory_xact_lock(hashtext('tiendaariga.registrar_venta'));
  select coalesce(max(split_part(pedido_id,'-',2)::int),0) + 1 into v_num
  from ventas
  where pedido_id like v_prefijo || '-%'
    and split_part(pedido_id,'-',2) ~ '^\d+$';
  return v_prefijo || '-' || lpad(v_num::text, 3, '0');
end;
$$;

-- searchClient (compatibilidad): coincidencia exacta por DPI, NIT, nombre o código
create or replace function tiendaariga.buscar_cliente(p_termino text)
returns setof tiendaariga.clientes
language sql stable
set search_path = tiendaariga
as $$
  select *
  from clientes
  where nullif(lower(trim(p_termino)),'') is not null
    and (lower(trim(p_termino)) in (lower(trim(coalesce(dpi,''))),
                                    lower(trim(coalesce(nit,''))),
                                    lower(trim(nombre)))
         or id::text = trim(p_termino))
  order by (id::text = trim(p_termino)), id
  limit 1;
$$;

-- Búsqueda de clientes: código exacto, DPI/NIT/teléfono que empiece por el
-- término, o nombre que lo contenga. Solo devuelve los clientes visibles.
create or replace function tiendaariga.buscar_clientes(p_termino text)
returns setof tiendaariga.clientes
language sql stable
set search_path = tiendaariga
as $$
  with t as (select lower(trim(coalesce(p_termino,''))) as q)
  select c.*
  from clientes c, t
  where t.q <> ''
    and (c.id::text = t.q
         or lower(coalesce(c.dpi,'')) like t.q || '%'
         or lower(coalesce(c.nit,'')) like t.q || '%'
         or coalesce(c.telefono,'') like t.q || '%'
         or lower(c.nombre) like '%' || t.q || '%')
  order by (c.id::text = t.q) desc,
           (lower(coalesce(c.dpi,'')) = t.q or lower(coalesce(c.nit,'')) = t.q) desc,
           c.nombre
  limit 25;
$$;

-- Crea un cliente y, si se indica, su saldo pendiente inicial (queda como
-- una venta de producto "SALDO INICIAL" con envío SI-<código>).
create or replace function tiendaariga.crear_cliente(p_cliente jsonb, p_saldo jsonb default null)
returns tiendaariga.clientes
language plpgsql
set search_path = tiendaariga
as $$
declare
  c        clientes;
  x        clientes := jsonb_populate_record(null::clientes, p_cliente);
  v_valor  numeric := nullif(p_saldo->>'valor','')::numeric;
  v_fecha  date := coalesce(nullif(p_saldo->>'fecha','')::date, (now() at time zone 'America/Guatemala')::date);
begin
  if coalesce(trim(x.nombre),'') = '' then
    raise exception 'El nombre del cliente es obligatorio';
  end if;
  insert into clientes (dpi, nit, nombre, fecha_nacimiento, departamento, telefono, telefono2,
                        direccion, correo, nit2, codigo_cliente)
  values (x.dpi, x.nit, trim(x.nombre), x.fecha_nacimiento, x.departamento, x.telefono, x.telefono2,
          x.direccion, x.correo, x.nit2, x.codigo_cliente)
  returning * into c;

  if coalesce(v_valor,0) > 0 then
    insert into ventas (pedido_id, fecha_venta, fecha_vencimiento, tienda, vendedor,
                        cliente_id, cliente, documento_cliente, envio,
                        producto, cantidad, valor_unitario, valor_total)
    values (siguiente_pedido_id(), v_fecha, v_fecha + 30,
            nullif(p_saldo->>'tienda',''), nullif(p_saldo->>'vendedor',''),
            c.id, c.nombre, coalesce(c.dpi, c.nit), 'SI-' || c.id,
            'SALDO INICIAL', 1, v_valor, v_valor);
  end if;
  return c;
end;
$$;

-- registerSale: genera el Id interno e inserta las líneas
create or replace function tiendaariga.registrar_venta(p_venta jsonb)
returns text
language plpgsql
set search_path = tiendaariga
as $$
declare
  v_hoy date := (now() at time zone 'America/Guatemala')::date;
  v_id  text;
  h     jsonb := p_venta->'header';
  s     jsonb := p_venta->'summary';
begin
  if jsonb_array_length(coalesce(p_venta->'productLines','[]'::jsonb)) = 0 then
    raise exception 'La venta no tiene productos';
  end if;
  v_id := siguiente_pedido_id();

  insert into ventas (pedido_id, fecha_venta, fecha_vencimiento, tienda, vendedor,
                      cliente_id, cliente, documento_cliente, factura, envio,
                      tipo, producto, cantidad, valor_unitario, valor_total)
  select v_id, v_hoy, v_hoy + 30,
         h->>'tienda', h->>'vendedor', nullif(h->>'clienteId','')::bigint,
         h->>'clienteNombre', nullif(h->>'clienteDPI',''),
         nullif(s->>'factura',''), nullif(trim(s->>'envio'),''),
         l->>'tipo', l->>'producto',
         nullif(l->>'cantidad','')::numeric,
         nullif(l->>'valorUnitario','')::numeric,
         nullif(l->>'valorTotal','')::numeric
  from jsonb_array_elements(p_venta->'productLines') l;

  return v_id;
end;
$$;

-- Un pedido se identifica por su envío; si no tiene envío, por su Id interno.
create or replace function tiendaariga.clave_pedido(p_envio text, p_pedido text)
returns text language sql immutable as $$
  select coalesce(nullif(trim(p_envio),''), p_pedido)
$$;

create or replace function tiendaariga.lineas_pedido(p_clave text)
returns setof tiendaariga.ventas
language sql stable
set search_path = tiendaariga
as $$
  select * from ventas where clave_pedido(envio, pedido_id) = trim(p_clave) order by id;
$$;

-- Búsqueda de pedidos por envío, Id interno, cliente o código de cliente
create or replace function tiendaariga.buscar_pedidos(p_termino text)
returns table (clave text, pedido_id text, envio text, fecha_venta date, cliente_id bigint,
               cliente text, tienda text, vendedor text, total numeric, lineas bigint)
language sql stable
set search_path = tiendaariga
as $$
  with t as (select lower(trim(coalesce(p_termino,''))) as q)
  select clave_pedido(v.envio, v.pedido_id), v.pedido_id, v.envio, min(v.fecha_venta),
         max(v.cliente_id), max(v.cliente), max(v.tienda), max(v.vendedor),
         sum(coalesce(v.valor_total,0)), count(*)
  from ventas v, t
  where t.q <> ''
    and (lower(coalesce(v.envio,'')) like '%' || t.q || '%'
         or lower(coalesce(v.pedido_id,'')) like '%' || t.q || '%'
         or lower(coalesce(v.cliente,'')) like '%' || t.q || '%'
         or v.cliente_id::text = t.q)
  group by 1, 2, 3
  order by min(v.fecha_venta) desc nulls last, 2 desc
  limit 60;
$$;

-- updateSale: reemplaza las líneas de un pedido conservando Id, fechas y cliente
drop function if exists tiendaariga.actualizar_venta(text, jsonb);
create function tiendaariga.actualizar_venta(p_envio text, p_venta jsonb)
returns text
language plpgsql
set search_path = tiendaariga
as $$
declare
  v_pedido  text;
  v_fecha   date;
  v_vence   date;
  v_cliente bigint;
  h         jsonb := p_venta->'header';
  s         jsonb := p_venta->'summary';
begin
  select pedido_id, fecha_venta, fecha_vencimiento, cliente_id
    into v_pedido, v_fecha, v_vence, v_cliente
  from ventas where clave_pedido(envio, pedido_id) = trim(p_envio)
  order by id limit 1;

  if not found then
    raise exception 'No se encontró el pedido para actualizar.';
  end if;
  if jsonb_array_length(coalesce(p_venta->'productLines','[]'::jsonb)) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  delete from ventas where clave_pedido(envio, pedido_id) = trim(p_envio);

  insert into ventas (pedido_id, fecha_venta, fecha_vencimiento, tienda, vendedor,
                      cliente_id, cliente, documento_cliente, factura, envio,
                      tipo, producto, cantidad, valor_unitario, valor_total)
  select coalesce(nullif(h->>'pedidoId',''), v_pedido), v_fecha, v_vence,
         h->>'tienda', h->>'vendedor', coalesce(nullif(h->>'clienteId','')::bigint, v_cliente),
         h->>'clienteNombre', nullif(h->>'clienteDPI',''),
         nullif(s->>'factura',''), nullif(trim(s->>'envio'),''),
         l->>'tipo', l->>'producto',
         nullif(l->>'cantidad','')::numeric,
         nullif(l->>'valorUnitario','')::numeric,
         nullif(l->>'valorTotal','')::numeric
  from jsonb_array_elements(p_venta->'productLines') l;

  return format('Pedido %s actualizado correctamente.', p_envio);
end;
$$;

-- deleteOrder
create or replace function tiendaariga.eliminar_pedido(p_envio text)
returns text
language plpgsql
set search_path = tiendaariga
as $$
declare n int;
begin
  delete from ventas where clave_pedido(envio, pedido_id) = trim(p_envio);
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'No se encontró ningún pedido con ese número de envío.';
  end if;
  return format('Pedido %s ha sido eliminado.', p_envio);
end;
$$;

-- Normaliza un nombre para compararlo: mayúsculas, sin tildes ni signos
create or replace function tiendaariga.normalizar_nombre(t text)
returns text language sql immutable as $$
  select trim(regexp_replace(regexp_replace(
           translate(upper(coalesce(t,'')), 'ÁÉÍÓÚÜ', 'AEIOUU'),
           '[^A-Z0-9Ñ ]', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- Vincula ventas y pagos importados (sin cliente_id) con su cliente: primero
-- por DPI/NIT, luego por nombre exacto; los nombres que no existen en
-- clientes se crean. Los pagos toman el cliente de la venta de su envío.
-- Se ejecuta al final de la carga de datos; se puede repetir.
create or replace function tiendaariga.vincular_clientes()
returns text
language plpgsql
set search_path = tiendaariga
as $$
declare n_doc int; n_nom int; n_nuevos int; n_nom2 int := 0; n_pag int; n_pnom int;
begin
  update ventas v set cliente_id = c.id
  from clientes c
  where v.cliente_id is null
    and trim(v.documento_cliente) ~ '\d{5,}'
    and trim(v.documento_cliente) in (trim(c.dpi), trim(c.nit));
  get diagnostics n_doc = row_count;

  update ventas v set cliente_id = c.id
  from (select distinct on (upper(trim(nombre))) id, upper(trim(nombre)) as k
        from clientes order by upper(trim(nombre)), id) c
  where v.cliente_id is null and upper(trim(v.cliente)) = c.k;
  get diagnostics n_nom = row_count;

  insert into clientes (nombre, dpi, nota_importacion)
  select min(trim(cliente)),
         min(case when trim(documento_cliente) ~ '\d{5,}' then trim(documento_cliente) end),
         'Creado al vincular ventas importadas'
  from ventas
  where cliente_id is null and coalesce(trim(cliente),'') <> ''
  group by upper(trim(cliente));
  get diagnostics n_nuevos = row_count;

  if n_nuevos > 0 then
    update ventas v set cliente_id = c.id
    from (select distinct on (upper(trim(nombre))) id, upper(trim(nombre)) as k
          from clientes order by upper(trim(nombre)), id) c
    where v.cliente_id is null and upper(trim(v.cliente)) = c.k;
    get diagnostics n_nom2 = row_count;
  end if;

  update pagos p set cliente_id = x.cliente_id
  from (select distinct on (envio) envio, cliente_id
        from ventas where cliente_id is not null and coalesce(trim(envio),'') <> ''
        order by envio, id) x
  where p.cliente_id is null and p.envio = x.envio;
  get diagnostics n_pag = row_count;

  -- En la hoja, muchos abonos se registraron con el NOMBRE del cliente en la
  -- columna ENVÍO. Se vinculan solo si coinciden con un único cliente:
  -- nombre exacto, o todas las palabras contenidas en el nombre del cliente.
  with pp as (
    select p.id, trim(regexp_replace(normalizar_nombre(p.envio), '^(ABONOS?|PAGOS?) ', '')) as k
    from pagos p
    where p.cliente_id is null and normalizar_nombre(p.envio) ~ '[A-Z]{3}'
  ),
  cc as (select id, normalizar_nombre(nombre) as n from clientes),
  exacto as (
    select pp.id, min(cc.id) as cliente_id from pp join cc on cc.n = pp.k
    group by pp.id having count(*) = 1
  ),
  palabras as (
    select pp.id, min(cc.id) as cliente_id
    from pp join cc
      on length(pp.k) >= 4
     and not exists (select 1 from unnest(string_to_array(pp.k, ' ')) w
                     where position(' ' || w || ' ' in ' ' || cc.n || ' ') = 0)
    where pp.id not in (select id from exacto)
    group by pp.id having count(*) = 1
  ),
  asignar as (select * from exacto union all select * from palabras)
  update pagos p
     set cliente_id = a.cliente_id,
         nota_importacion = concat_ws('; ', p.nota_importacion, 'Cliente asignado por el nombre escrito en ENVIO')
  from asignar a where p.id = a.id;
  get diagnostics n_pnom = row_count;

  return format('Ventas vinculadas por documento: %s, por nombre: %s. Clientes creados: %s. Pagos vinculados por envío: %s, por nombre del cliente: %s.',
                n_doc, n_nom + n_nom2, n_nuevos, n_pag, n_pnom);
end;
$$;

-- ¿Un elemento de un maestro está en uso? Revisa TODOS los registros (no solo
-- los visibles para el usuario) antes de permitir eliminarlo.
create or replace function tiendaariga.maestro_en_uso(p_maestro text, p_nombre text)
returns boolean
language plpgsql stable
security definer
set search_path = tiendaariga
as $$
begin
  if not usuario_activo() then return true; end if;
  return case p_maestro
    when 'tiendas'       then exists (select 1 from ventas where tienda = p_nombre)
                           or exists (select 1 from ingresos_inventario where tienda = p_nombre)
    when 'vendedores'    then exists (select 1 from ventas where vendedor = p_nombre)
    when 'tipos'         then exists (select 1 from ventas where tipo = p_nombre)
                           or exists (select 1 from productos where tipo = p_nombre)
    when 'metodos_pago'  then exists (select 1 from pagos where metodo_pago = p_nombre)
    when 'departamentos' then exists (select 1 from clientes where departamento = p_nombre)
    else true
  end;
end;
$$;

-- ---------------------------------------------------------------------
-- Administración de usuarios
-- ---------------------------------------------------------------------
-- Da acceso a ARIGA a un usuario que ya existe en Supabase Auth (creado
-- desde la app o desde el panel). Solo administradores.
create or replace function tiendaariga.admin_agregar_usuario(p_email text, p_nombre text, p_rol text)
returns tiendaariga.perfiles
language plpgsql
security definer
set search_path = tiendaariga, auth
as $$
declare u uuid; r perfiles;
begin
  if not es_admin() then
    raise exception 'Solo un administrador puede agregar usuarios';
  end if;
  select id into u from auth.users where lower(email) = lower(trim(p_email));
  if u is null then
    raise exception 'No existe un usuario con el correo %', p_email;
  end if;
  insert into perfiles (id, email, nombre, rol, activo)
  values (u, lower(trim(p_email)), nullif(trim(p_nombre),''), coalesce(nullif(p_rol,''),'vendedor'), true)
  on conflict (id) do update
    set nombre = coalesce(excluded.nombre, perfiles.nombre), rol = excluded.rol, activo = true
  returning * into r;
  return r;
end;
$$;

-- Primer administrador (o cualquier otro): ejecutar en el SQL Editor
--   select tiendaariga.hacer_admin('correo@dominio.com');
create or replace function tiendaariga.hacer_admin(p_email text)
returns text
language plpgsql
security definer
set search_path = tiendaariga, auth
as $$
declare u uuid;
begin
  select id into u from auth.users where lower(email) = lower(trim(p_email));
  if u is null then
    raise exception 'No existe un usuario con el correo %. Créelo en Authentication > Users.', p_email;
  end if;
  insert into perfiles (id, email, nombre, rol, activo)
  values (u, lower(trim(p_email)), split_part(p_email,'@',1), 'admin', true)
  on conflict (id) do update set rol = 'admin', activo = true;
  return format('%s ahora es administrador de ARIGA.', p_email);
end;
$$;

-- =====================================================================
-- SEGURIDAD
--   * Sin sesión (rol anon) no hay acceso a nada.
--   * Usuarios activos: maestros, referencias e inventario compartidos.
--   * Clientes: cada usuario ve los que creó; el administrador ve todos.
--   * Ventas y pagos: visibles si el cliente es visible o si los registró
--     el usuario; el administrador ve todos.
-- =====================================================================
revoke all on all tables    in schema tiendaariga from anon;
revoke all on all sequences in schema tiendaariga from anon;
revoke all on all functions in schema tiendaariga from anon, public;
revoke usage on schema tiendaariga from anon;
grant usage on schema tiendaariga to authenticated, service_role;
grant select, insert, update, delete on all tables in schema tiendaariga to authenticated, service_role;
grant usage, select on all sequences in schema tiendaariga to authenticated, service_role;
grant execute on all functions in schema tiendaariga to authenticated, service_role;
-- Solo desde el SQL Editor
revoke execute on function tiendaariga.hacer_admin(text)     from authenticated;
revoke execute on function tiendaariga.vincular_clientes()   from authenticated;

do $$
declare t text;
begin
  -- Tablas compartidas entre usuarios activos
  foreach t in array array['tiendas','tipos','vendedores','productos','metodos_pago','departamentos',
                           'coordenadas','ingresos_inventario','devoluciones_oficina','inventario_items']
  loop
    execute format('alter table tiendaariga.%I enable row level security', t);
    execute format('drop policy if exists "autenticados_todo" on tiendaariga.%I', t);
    execute format('drop policy if exists "usuarios_activos" on tiendaariga.%I', t);
    execute format('create policy "usuarios_activos" on tiendaariga.%I for all to authenticated
                    using ((select tiendaariga.usuario_activo()))
                    with check ((select tiendaariga.usuario_activo()))', t);
  end loop;

  foreach t in array array['clientes','ventas','pagos','devoluciones','perfiles']
  loop
    execute format('alter table tiendaariga.%I enable row level security', t);
    execute format('drop policy if exists "autenticados_todo" on tiendaariga.%I', t);
  end loop;
end $$;

drop policy if exists "clientes_propios" on tiendaariga.clientes;
create policy "clientes_propios" on tiendaariga.clientes for all to authenticated
  using ((select tiendaariga.usuario_activo())
         and ((select tiendaariga.es_admin()) or creado_por = (select auth.uid())))
  with check ((select tiendaariga.usuario_activo())
              and ((select tiendaariga.es_admin()) or creado_por = (select auth.uid())));

drop policy if exists "ventas_visibles" on tiendaariga.ventas;
create policy "ventas_visibles" on tiendaariga.ventas for all to authenticated
  using ((select tiendaariga.usuario_activo())
         and ((select tiendaariga.es_admin()) or creado_por = (select auth.uid())
              or tiendaariga.cliente_propio(cliente_id)))
  -- Solo se registra sobre clientes propios (o sin cliente); el admin, sobre cualquiera
  with check ((select tiendaariga.usuario_activo())
              and ((select tiendaariga.es_admin())
                   or (creado_por = (select auth.uid())
                       and (cliente_id is null or tiendaariga.cliente_propio(cliente_id)))));

drop policy if exists "pagos_visibles" on tiendaariga.pagos;
create policy "pagos_visibles" on tiendaariga.pagos for all to authenticated
  using ((select tiendaariga.usuario_activo())
         and ((select tiendaariga.es_admin()) or creado_por = (select auth.uid())
              or tiendaariga.cliente_propio(cliente_id)))
  -- Solo se registra sobre clientes propios (o sin cliente); el admin, sobre cualquiera
  with check ((select tiendaariga.usuario_activo())
              and ((select tiendaariga.es_admin())
                   or (creado_por = (select auth.uid())
                       and (cliente_id is null or tiendaariga.cliente_propio(cliente_id)))));

drop policy if exists "devoluciones_visibles" on tiendaariga.devoluciones;
create policy "devoluciones_visibles" on tiendaariga.devoluciones for all to authenticated
  using ((select tiendaariga.usuario_activo())
         and ((select tiendaariga.es_admin()) or creado_por = (select auth.uid())))
  with check ((select tiendaariga.usuario_activo())
              and ((select tiendaariga.es_admin()) or creado_por = (select auth.uid())));

-- Perfiles: cada uno ve el suyo (aunque esté inactivo); los activos ven la
-- lista (nombres en reportes). Solo el administrador los modifica.
drop policy if exists "perfiles_ver" on tiendaariga.perfiles;
create policy "perfiles_ver" on tiendaariga.perfiles for select to authenticated
  using (id = (select auth.uid()) or (select tiendaariga.usuario_activo()));
drop policy if exists "perfiles_admin" on tiendaariga.perfiles;
create policy "perfiles_admin" on tiendaariga.perfiles for update to authenticated
  using ((select tiendaariga.es_admin())) with check ((select tiendaariga.es_admin()));

-- Vincula datos importados que aún no tengan cliente (no hace nada si no hay)
select tiendaariga.vincular_clientes();

-- Recargar el caché de la API para que aparezcan las tablas nuevas
notify pgrst, 'reload schema';
