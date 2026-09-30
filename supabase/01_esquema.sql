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
create table if not exists tiendaariga.productos (
  nombre text primary key,
  orden  int not null default 0
);
create table if not exists tiendaariga.metodos_pago (
  nombre text primary key,
  orden  int not null default 0
);

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
-- Hoja "Ingresos de inventario"
create table if not exists tiendaariga.ingresos_inventario (
  id          bigint generated always as identity primary key,
  fecha       date,
  producto    text,
  tienda      text,
  concepto    text,
  entrada     numeric(14,2),
  salida      numeric(14,2),
  created_at  timestamptz not null default now()
);

-- Hoja "Devolución a oficina"
create table if not exists tiendaariga.devoluciones_oficina (
  id                bigint generated always as identity primary key,
  fecha_devolucion  date,
  tienda            text,
  producto          text,
  cantidad          numeric(14,2),
  created_at        timestamptz not null default now()
);

-- Filas de la hoja "Inventario": qué tienda/producto se controla y desde qué
-- fecha se descuentan las ventas (el criterio ">=fecha" de cada SUMIFS).
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

-- "Inventario": entradas - salidas (ventas desde fecha_inicio + salidas manuales
-- + devoluciones a oficina). Comparación sin mayúsculas ni espacios, como SUMIFS.
create or replace view tiendaariga.inventario
with (security_invoker = true) as
select i.tienda,
       i.producto,
       i.fecha_inicio,
       e.entradas,
       s.salidas,
       e.entradas - s.salidas as saldo
from tiendaariga.inventario_items i
cross join lateral (
  select coalesce(sum(g.entrada),0) as entradas
  from tiendaariga.ingresos_inventario g
  where upper(trim(g.tienda)) = upper(trim(i.tienda))
    and upper(trim(g.producto)) = upper(trim(i.producto))
) e
cross join lateral (
  select
    coalesce((select sum(v.cantidad) from tiendaariga.ventas v
              where upper(trim(v.tienda)) = upper(trim(i.tienda))
                and upper(trim(v.producto)) = upper(trim(i.producto))
                and v.fecha_venta >= i.fecha_inicio),0)
  + coalesce((select sum(g.salida) from tiendaariga.ingresos_inventario g
              where upper(trim(g.tienda)) = upper(trim(i.tienda))
                and upper(trim(g.producto)) = upper(trim(i.producto))),0)
  + coalesce((select sum(o.cantidad) from tiendaariga.devoluciones_oficina o
              where upper(trim(o.tienda)) = upper(trim(i.tienda))
                and upper(trim(o.producto)) = upper(trim(i.producto))),0)
  as salidas
) s;

-- =====================================================================
-- FUNCIONES (equivalentes a las funciones de Apps Script)
-- =====================================================================

-- searchClient: coincidencia exacta por DPI, NIT o nombre (sin mayúsculas)
create or replace function tiendaariga.buscar_cliente(p_termino text)
returns setof tiendaariga.clientes
language sql stable
set search_path = tiendaariga
as $$
  select *
  from clientes
  where nullif(lower(trim(p_termino)),'') is not null
    and lower(trim(p_termino)) in (lower(trim(coalesce(dpi,''))),
                                   lower(trim(coalesce(nit,''))),
                                   lower(trim(nombre)))
  order by id
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
                      cliente, documento_cliente, factura, envio,
                      tipo, producto, cantidad, valor_unitario, valor_total)
  select v_id, v_hoy, v_hoy + 30,
         h->>'tienda', h->>'vendedor', h->>'clienteNombre', nullif(h->>'clienteDPI',''),
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
  h         jsonb := p_venta->'header';
  s         jsonb := p_venta->'summary';
begin
  select pedido_id, fecha_venta, fecha_vencimiento
    into v_pedido, v_fecha, v_vence
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
                      cliente, documento_cliente, factura, envio,
                      tipo, producto, cantidad, valor_unitario, valor_total)
  select coalesce(nullif(h->>'pedidoId',''), v_pedido), v_fecha, v_vence,
         h->>'tienda', h->>'vendedor', h->>'clienteNombre', nullif(h->>'clienteDPI',''),
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
-- SEGURIDAD: solo usuarios autenticados (Supabase Auth) leen y escriben.
-- La clave publicable sola (rol anon) no ve ningún dato.
-- =====================================================================
grant usage on schema tiendaariga to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema tiendaariga to authenticated, service_role;
grant usage, select on all sequences in schema tiendaariga to authenticated, service_role;
grant execute on all functions in schema tiendaariga to authenticated, service_role;
revoke execute on all functions in schema tiendaariga from anon, public;

do $$
declare t text;
begin
  foreach t in array array['tiendas','tipos','vendedores','productos','metodos_pago',
                           'clientes','ventas','pagos','devoluciones',
                           'ingresos_inventario','devoluciones_oficina',
                           'inventario_items','coordenadas']
  loop
    execute format('alter table tiendaariga.%I enable row level security', t);
    execute format('drop policy if exists "autenticados_todo" on tiendaariga.%I', t);
    execute format('create policy "autenticados_todo" on tiendaariga.%I
                    for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Recargar el caché de la API para que aparezcan las tablas nuevas
notify pgrst, 'reload schema';
