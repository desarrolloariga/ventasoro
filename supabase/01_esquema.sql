-- =====================================================================
--  Joyería ARIGA - Esquema "tiendaariga" en Supabase
--  Replica la estructura del libro "Registro de ventas 2do".
--  Ejecutar completo en: Supabase > SQL Editor.
-- =====================================================================

create schema if not exists tiendaariga;
set search_path = tiendaariga, public;

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

create view tiendaariga.inventario
with (security_invoker = true) as
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
where coalesce(p.controla_inventario, true);

-- Kardex: cada movimiento que afecta el saldo de una tienda/referencia
create view tiendaariga.inventario_movimientos
with (security_invoker = true) as
select i.tienda, i.producto, g.fecha, 'CARGA'::text as origen,
       concat_ws(' · ', g.concepto, g.observaciones) as detalle,
       coalesce(g.entrada,0) as entrada, coalesce(g.salida,0) as salida, g.id as origen_id
from tiendaariga.inventario i
join tiendaariga.ingresos_inventario g
  on upper(trim(g.tienda)) = i.kt and upper(trim(g.producto)) = i.kp
union all
select i.tienda, i.producto, v.fecha_venta, 'VENTA',
       concat_ws(' · ', 'Pedido ' || v.pedido_id, 'Envío ' || v.envio, v.cliente),
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

-- =====================================================================
-- FUNCIONES (equivalentes a las funciones de Apps Script)
-- =====================================================================

-- searchClient: coincidencia exacta por DPI, NIT, nombre (sin mayúsculas) o
-- ID de cliente. Si el término coincide con un DPI/NIT/nombre, gana ese.
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

-- registerSale: genera el Id interno yyyyMMdd-NNN e inserta las líneas
create or replace function tiendaariga.registrar_venta(p_venta jsonb)
returns text
language plpgsql
set search_path = tiendaariga
as $$
declare
  v_hoy     date := (now() at time zone 'America/Guatemala')::date;
  v_prefijo text := to_char(v_hoy, 'YYYYMMDD');
  v_num     int;
  v_id      text;
  h         jsonb := p_venta->'header';
  s         jsonb := p_venta->'summary';
begin
  if jsonb_array_length(coalesce(p_venta->'productLines','[]'::jsonb)) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  -- Evita que dos ventas simultáneas obtengan el mismo número
  perform pg_advisory_xact_lock(hashtext('tiendaariga.registrar_venta'));

  select coalesce(max(split_part(pedido_id,'-',2)::int),0) + 1 into v_num
  from ventas
  where pedido_id like v_prefijo || '-%'
    and split_part(pedido_id,'-',2) ~ '^\d+$';

  v_id := v_prefijo || '-' || lpad(v_num::text, 3, '0');

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

-- updateSale: reemplaza las líneas de un envío conservando Id y fechas originales
create or replace function tiendaariga.actualizar_venta(p_envio text, p_venta jsonb)
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
  from ventas where trim(envio) = trim(p_envio)
  order by id limit 1;

  if not found then
    raise exception 'No se encontró el pedido para actualizar.';
  end if;
  if jsonb_array_length(coalesce(p_venta->'productLines','[]'::jsonb)) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  delete from ventas where trim(envio) = trim(p_envio);

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

  return format('Pedido con envío %s actualizado correctamente.', p_envio);
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
  delete from ventas where trim(envio) = trim(p_envio);
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'No se encontró ningún pedido con ese número de envío.';
  end if;
  return format('Pedido con envío %s ha sido eliminado.', p_envio);
end;
$$;

-- =====================================================================
-- ACCESO LIBRE: sin inicio de sesión y sin RLS. Cualquiera con la clave
-- publicable (rol anon) puede leer, crear, modificar y borrar datos.
-- =====================================================================
grant usage on schema tiendaariga to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema tiendaariga to anon, authenticated, service_role;
grant usage, select on all sequences in schema tiendaariga to anon, authenticated, service_role;
grant execute on all functions in schema tiendaariga to anon, authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array['tiendas','tipos','vendedores','productos','metodos_pago','departamentos',
                           'clientes','ventas','pagos','devoluciones',
                           'ingresos_inventario','devoluciones_oficina',
                           'inventario_items','coordenadas']
  loop
    execute format('drop policy if exists "autenticados_todo" on tiendaariga.%I', t);
    execute format('alter table tiendaariga.%I disable row level security', t);
  end loop;
end $$;

-- Recargar el caché de la API para que aparezcan las tablas nuevas
notify pgrst, 'reload schema';
