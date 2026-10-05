-- =====================================================================
--  Joyería ARIGA - Actualización 05
--  * Traslados de inventario entre bodegas: el origen envía (sale del
--    inventario) y el destino recibe (entra). Se puede anular o rechazar
--    mientras está en tránsito.
--  * Indicadores de Inteligencia Comercial: cartera por cobrar, gramos
--    disponibles por bodega y precio promedio del gramo vendido.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 04_usuario_tienda.sql.
--  Se puede ejecutar varias veces.
-- =====================================================================

-- ---------------------------------------------------------------------
-- TRASLADOS
-- ---------------------------------------------------------------------
create table if not exists tiendaariga.traslados (
  id               bigint generated always as identity primary key,
  fecha_envio      date not null default ((now() at time zone 'America/Guatemala')::date),
  origen           text not null,
  destino          text not null,
  producto         text not null,
  cantidad         numeric(14,2) not null check (cantidad > 0),
  estado           text not null default 'ENVIADO' check (estado in ('ENVIADO', 'RECIBIDO', 'ANULADO')),
  observaciones    text,
  enviado_por      uuid default auth.uid() references auth.users(id) on delete set null,
  fecha_recepcion  timestamptz,
  recibido_por     uuid references auth.users(id) on delete set null,
  obs_recepcion    text,
  created_at       timestamptz not null default now(),
  check (origen <> destino)
);
create index if not exists traslados_estado_idx  on tiendaariga.traslados (estado);
create index if not exists traslados_destino_idx on tiendaariga.traslados (destino);

-- Los movimientos de inventario de un traslado quedan ligados a él
alter table tiendaariga.ingresos_inventario add column if not exists traslado_id bigint references tiendaariga.traslados(id);
create index if not exists ingresos_traslado_idx on tiendaariga.ingresos_inventario (traslado_id);

-- Solo se ven los traslados de la tienda del usuario (o todos si es admin).
-- Se crean y cambian únicamente con las funciones de abajo.
alter table tiendaariga.traslados enable row level security;
drop policy if exists "traslados_visibles" on tiendaariga.traslados;
create policy "traslados_visibles" on tiendaariga.traslados for select to authenticated
  using ((select tiendaariga.usuario_activo())
         and ((select tiendaariga.es_admin())
              or (select tiendaariga.tienda_usuario()) in (origen, destino)
              or enviado_por = (select auth.uid())));
revoke all on tiendaariga.traslados from anon, authenticated;
grant select on tiendaariga.traslados to authenticated;

-- Un movimiento de traslado no se borra ni se edita desde "Cargas": se anula el traslado
create or replace function tiendaariga.proteger_movimiento_traslado()
returns trigger
language plpgsql
as $$
begin
  if old.traslado_id is not null and coalesce(current_setting('tiendaariga.traslado', true), '') <> 'si' then
    raise exception 'Este movimiento pertenece al traslado #%. Anúlelo desde Inventario > Traslados.', old.traslado_id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists ingresos_proteger_traslado on tiendaariga.ingresos_inventario;
create trigger ingresos_proteger_traslado
  before update or delete on tiendaariga.ingresos_inventario
  for each row execute function tiendaariga.proteger_movimiento_traslado();

-- Enviar: el inventario sale del origen. Un vendedor solo envía desde su tienda.
create or replace function tiendaariga.enviar_traslado(p_origen text, p_destino text, p_producto text,
                                                       p_cantidad numeric, p_fecha date default null,
                                                       p_observaciones text default null)
returns tiendaariga.traslados
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  v_origen text := p_origen;
  v_fecha  date := coalesce(p_fecha, (now() at time zone 'America/Guatemala')::date);
  t traslados;
begin
  if not usuario_activo() then raise exception 'Usuario sin acceso'; end if;
  if not es_admin() then
    v_origen := tienda_usuario();
    if v_origen is null then
      raise exception 'Su usuario no tiene tienda o bodega asignada. Pida al administrador que lo vincule para poder enviar traslados.';
    end if;
  end if;
  if coalesce(v_origen,'') = '' or coalesce(p_destino,'') = '' then raise exception 'Indique origen y destino'; end if;
  if v_origen = p_destino then raise exception 'El origen y el destino deben ser distintos'; end if;
  if not exists (select 1 from tiendas where nombre = p_destino) then raise exception 'La bodega destino % no existe', p_destino; end if;
  if not exists (select 1 from productos where nombre = p_producto) then raise exception 'La referencia % no existe', p_producto; end if;
  if coalesce(p_cantidad,0) <= 0 then raise exception 'La cantidad debe ser mayor que cero'; end if;

  insert into traslados (fecha_envio, origen, destino, producto, cantidad, observaciones, enviado_por)
  values (v_fecha, v_origen, p_destino, p_producto, p_cantidad, nullif(trim(p_observaciones),''), auth.uid())
  returning * into t;

  insert into ingresos_inventario (fecha, producto, tienda, concepto, salida, observaciones, traslado_id)
  values (v_fecha, p_producto, v_origen, 'TRASLADO ENVIADO',
          p_cantidad, format('A %s · Traslado #%s', p_destino, t.id), t.id);
  return t;
end;
$$;

-- Recibir: el inventario entra al destino. Solo el destino (o un admin).
create or replace function tiendaariga.recibir_traslado(p_id bigint, p_observaciones text default null)
returns tiendaariga.traslados
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  t traslados;
  v_hoy date := (now() at time zone 'America/Guatemala')::date;
begin
  if not usuario_activo() then raise exception 'Usuario sin acceso'; end if;
  select * into t from traslados where id = p_id for update;
  if not found then raise exception 'Traslado no encontrado'; end if;
  if t.estado <> 'ENVIADO' then raise exception 'El traslado #% ya está %', p_id, lower(t.estado); end if;
  if not es_admin() and coalesce(tienda_usuario(), '') <> t.destino then
    raise exception 'Solo la bodega destino (%) puede recibir este traslado', t.destino;
  end if;

  insert into ingresos_inventario (fecha, producto, tienda, concepto, entrada, observaciones, traslado_id)
  values (v_hoy, t.producto, t.destino, 'TRASLADO RECIBIDO', t.cantidad,
          format('De %s · Traslado #%s', t.origen, t.id), t.id);

  update traslados
     set estado = 'RECIBIDO', fecha_recepcion = now(), recibido_por = auth.uid(),
         obs_recepcion = nullif(trim(p_observaciones),'')
   where id = p_id
  returning * into t;
  return t;
end;
$$;

-- Anular (origen) o rechazar (destino) un traslado en tránsito: el
-- inventario vuelve al origen.
create or replace function tiendaariga.anular_traslado(p_id bigint, p_motivo text default null)
returns tiendaariga.traslados
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare t traslados;
begin
  if not usuario_activo() then raise exception 'Usuario sin acceso'; end if;
  select * into t from traslados where id = p_id for update;
  if not found then raise exception 'Traslado no encontrado'; end if;
  if t.estado <> 'ENVIADO' then raise exception 'Solo se puede anular un traslado en tránsito (este está %)', lower(t.estado); end if;
  if not es_admin() and coalesce(tienda_usuario(), '') not in (t.origen, t.destino)
     and t.enviado_por is distinct from auth.uid() then
    raise exception 'Solo el origen, el destino o un administrador pueden anular este traslado';
  end if;

  perform set_config('tiendaariga.traslado', 'si', true);
  delete from ingresos_inventario where traslado_id = p_id;
  perform set_config('tiendaariga.traslado', '', true);

  update traslados
     set estado = 'ANULADO', fecha_recepcion = now(), recibido_por = auth.uid(),
         obs_recepcion = nullif(trim(p_motivo),'')
   where id = p_id
  returning * into t;
  return t;
end;
$$;

-- En el kardex, los movimientos de traslado se identifican como TRASLADO
create or replace view tiendaariga.inventario_movimientos
with (security_invoker = false) as
select i.tienda, i.producto, g.fecha,
       case when g.traslado_id is not null then 'TRASLADO' else 'CARGA' end::text as origen,
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
-- INTELIGENCIA COMERCIAL
-- ---------------------------------------------------------------------
-- Gramos en tránsito (traslados enviados sin recibir), de todas las bodegas
create or replace function tiendaariga.gramos_en_transito()
returns table (tipo text, gramos numeric)
language sql stable
security definer
set search_path = tiendaariga
as $$
  select coalesce(nullif(upper(trim(p.tipo)),''), 'SIN TIPO'), sum(t.cantidad)
  from traslados t
  left join productos p on upper(trim(p.nombre)) = upper(trim(t.producto))
  where t.estado = 'ENVIADO' and coalesce(p.unidad, 'GRAMOS') = 'GRAMOS' and usuario_activo()
  group by 1
$$;

-- Indicadores en un solo JSON. Cartera y ventas respetan la visibilidad del
-- usuario (el vendedor ve lo de sus clientes); el inventario es de todas las
-- bodegas. p_desde / p_hasta: periodo del precio promedio (null = sin límite).
create or replace function tiendaariga.indicadores_comerciales(p_desde date default null, p_hasta date default null)
returns jsonb
language sql stable
set search_path = tiendaariga
as $$
  with vg as (   -- ventas de referencias que se venden por gramo
    select v.fecha_venta,
           coalesce(nullif(upper(trim(p.tipo)),''), nullif(upper(trim(rtrim(trim(v.tipo), '.'))),''), 'SIN TIPO') as tipo,
           v.cantidad, v.valor_total
    from ventas v
    join productos p on upper(trim(p.nombre)) = upper(trim(v.producto))
    where p.unidad = 'GRAMOS'
      and upper(trim(v.producto)) <> 'SALDO INICIAL'
      and coalesce(v.cantidad, 0) > 0 and coalesce(v.valor_total, 0) > 0
  ),
  periodo as (
    select * from vg
    where (p_desde is null or fecha_venta >= p_desde) and (p_hasta is null or fecha_venta <= p_hasta)
  )
  select jsonb_build_object(
    'cartera', (
      select jsonb_build_object(
        'por_cobrar',         coalesce(sum(saldo) filter (where saldo > 0.005), 0),
        'clientes_con_saldo', count(*) filter (where saldo > 0.005),
        'saldo_a_favor',      coalesce(-sum(saldo) filter (where saldo < -0.005), 0),
        'clientes',           count(*))
      from cartera_clientes),
    'gramos', (
      select coalesce(jsonb_agg(x order by x.tipo, x.tienda), '[]'::jsonb)
      from (select i.tienda, coalesce(nullif(upper(trim(i.tipo)),''), 'SIN TIPO') as tipo, sum(i.saldo) as gramos
            from inventario i where i.unidad = 'GRAMOS' group by 1, 2) x),
    'transito', (
      select coalesce(jsonb_agg(t), '[]'::jsonb) from gramos_en_transito() t),
    'promedio', (
      select jsonb_build_object(
        'gramos', coalesce(sum(cantidad), 0),
        'valor',  coalesce(sum(valor_total), 0),
        'por_tipo', coalesce((select jsonb_agg(y order by y.tipo)
                              from (select tipo, sum(cantidad) as gramos, sum(valor_total) as valor
                                    from periodo group by tipo) y), '[]'::jsonb))
      from periodo),
    'mensual', (   -- últimos 12 meses, para la evolución del precio por gramo
      select coalesce(jsonb_agg(m order by m.mes, m.tipo), '[]'::jsonb)
      from (select to_char(date_trunc('month', fecha_venta), 'YYYY-MM') as mes, tipo,
                   sum(cantidad) as gramos, sum(valor_total) as valor
            from vg
            where fecha_venta >= (date_trunc('month', (now() at time zone 'America/Guatemala')) - interval '11 months')::date
            group by 1, 2) m),
    'traslados_por_recibir', (
      select count(*) from traslados t
      where t.estado = 'ENVIADO' and (es_admin() or t.destino = tienda_usuario()))
  )
$$;

-- Permisos
revoke execute on function tiendaariga.enviar_traslado(text, text, text, numeric, date, text) from public, anon;
revoke execute on function tiendaariga.recibir_traslado(bigint, text)                         from public, anon;
revoke execute on function tiendaariga.anular_traslado(bigint, text)                          from public, anon;
revoke execute on function tiendaariga.gramos_en_transito()                                   from public, anon;
revoke execute on function tiendaariga.indicadores_comerciales(date, date)                    from public, anon;
revoke execute on function tiendaariga.proteger_movimiento_traslado()                         from public, anon;
grant  execute on function tiendaariga.enviar_traslado(text, text, text, numeric, date, text) to authenticated;
grant  execute on function tiendaariga.recibir_traslado(bigint, text)                         to authenticated;
grant  execute on function tiendaariga.anular_traslado(bigint, text)                          to authenticated;
grant  execute on function tiendaariga.gramos_en_transito()                                   to authenticated;
grant  execute on function tiendaariga.indicadores_comerciales(date, date)                    to authenticated;

notify pgrst, 'reload schema';
