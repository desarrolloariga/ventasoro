-- =====================================================================
--  Joyería ARIGA - Actualización 32: RESUMEN DEL ADMINISTRADOR, ABONOS Y
--  CUADRE (ARQUEO) DE CAJA MENOR
--  * abonos_periodo: abonos recibidos en un periodo (cada usuario ve los
--    suyos por los permisos; el administrador, todos).
--  * resumen_admin (solo administrador), para el tablero de Inteligencia:
--      - por vendedor: ventas Q y gramos, cobrado, comisión, meta y
--        efectivo en caja;
--      - cuadre de inventario en gramos por bodega: inicial + ingresos
--        ± traslados - ventas - otras salidas = final (misma regla que el
--        saldo de Inventario);
--      - cajas: efectivo, movimientos del periodo y último cuadre.
--  * Cuadre de caja (arqueo): el administrador cuenta el efectivo de una
--    caja; se registra la entrega y, si no cuadra, el faltante o sobrante.
--    La caja queda en cero y empieza de nuevo.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 31. Se puede repetir.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Cuadre (arqueo) de caja menor
-- ---------------------------------------------------------------------
create table if not exists tiendaariga.cuadres_caja (
  id             bigint generated always as identity primary key,
  usuario_id     uuid not null references tiendaariga.perfiles(id) on delete cascade,
  fecha          date not null default ((now() at time zone 'America/Guatemala')::date),
  saldo_sistema  numeric(14,2) not null,
  contado        numeric(14,2) not null check (contado >= 0),
  diferencia     numeric(14,2) not null,
  observaciones  text,
  creado_por     uuid default auth.uid() references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists cuadres_caja_usuario_idx on tiendaariga.cuadres_caja (usuario_id, created_at);

alter table tiendaariga.caja_menor add column if not exists cuadre_id bigint
  references tiendaariga.cuadres_caja(id) on delete cascade;
alter table tiendaariga.caja_menor drop constraint if exists caja_menor_origen_check;
alter table tiendaariga.caja_menor add constraint caja_menor_origen_check check (origen in ('VENTA', 'MANUAL', 'PAGO', 'CUADRE'));

alter table tiendaariga.cuadres_caja enable row level security;
grant select on tiendaariga.cuadres_caja to authenticated;
drop policy if exists "cuadres_caja_ver" on tiendaariga.cuadres_caja;
create policy "cuadres_caja_ver" on tiendaariga.cuadres_caja for select to authenticated
  using ((select tiendaariga.usuario_activo())
         and ((select tiendaariga.es_admin()) or usuario_id = (select auth.uid())
              or tiendaariga.es_de_mi_equipo(usuario_id)));

create or replace function tiendaariga.cuadrar_caja(p_usuario uuid, p_contado numeric, p_fecha date default null, p_observaciones text default null)
returns tiendaariga.cuadres_caja
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  c cuadres_caja; v_saldo numeric; v_dif numeric; v_fecha date; v_nombre text;
begin
  if not es_admin() then raise exception 'Solo el administrador puede cuadrar las cajas.'; end if;
  if p_contado is null or p_contado < 0 then raise exception 'Escriba el efectivo contado (0 o más).'; end if;
  select coalesce(nombre, usuario) into v_nombre from perfiles where id = p_usuario;
  if not found then raise exception 'El usuario de la caja no existe.'; end if;
  v_fecha := coalesce(p_fecha, (now() at time zone 'America/Guatemala')::date);
  select coalesce(sum(case when tipo = 'ENTRADA' then valor else -valor end), 0) into v_saldo
    from caja_menor where usuario_id = p_usuario;
  v_dif := round(p_contado - v_saldo, 2);
  insert into cuadres_caja (usuario_id, fecha, saldo_sistema, contado, diferencia, observaciones, creado_por)
  values (p_usuario, v_fecha, round(v_saldo, 2), round(p_contado, 2), v_dif, nullif(trim(p_observaciones), ''), auth.uid())
  returning * into c;
  -- Diferencia del arqueo: sobrante entra, faltante sale
  if v_dif <> 0 then
    insert into caja_menor (fecha, usuario_id, tipo, origen, valor, concepto, observaciones, cuadre_id, creado_por)
    values (v_fecha, p_usuario, case when v_dif > 0 then 'ENTRADA' else 'SALIDA' end, 'CUADRE', abs(v_dif),
            case when v_dif > 0 then 'SOBRANTE EN ARQUEO' else 'FALTANTE EN ARQUEO' end,
            concat_ws(' · ', 'Cuadre N° ' || c.id, nullif(trim(p_observaciones), '')), c.id, auth.uid());
  end if;
  -- Entrega del efectivo contado: la caja queda en cero
  if p_contado > 0 then
    insert into caja_menor (fecha, usuario_id, tipo, origen, valor, concepto, observaciones, cuadre_id, creado_por)
    values (v_fecha, p_usuario, 'SALIDA', 'CUADRE', round(p_contado, 2), 'CUADRE DE CAJA · ENTREGA A ADMINISTRACIÓN',
            concat_ws(' · ', 'Cuadre N° ' || c.id, nullif(trim(p_observaciones), '')), c.id, auth.uid());
  end if;
  return c;
end;
$$;

create or replace function tiendaariga.anular_cuadre_caja(p_id bigint)
returns void
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if not es_admin() then raise exception 'Solo el administrador puede anular un cuadre de caja.'; end if;
  delete from cuadres_caja where id = p_id;   -- sus movimientos se borran en cascada
  if not found then raise exception 'El cuadre % no existe.', p_id; end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Abonos recibidos en un periodo (con los permisos de quien consulta)
-- ---------------------------------------------------------------------
create or replace function tiendaariga.abonos_periodo(p_desde date default null, p_hasta date default null,
                                                     p_tienda text default null, p_vendedor uuid default null)
returns jsonb
language sql stable
set search_path = tiendaariga
as $$
  with p as (
    select pg.*, coalesce(pg.observaciones, '') like 'Venta en efectivo%' as contado
    from pagos pg
    where (p_desde is null or pg.fecha_pago >= p_desde) and (p_hasta is null or pg.fecha_pago <= p_hasta)
      and (p_vendedor is null or pg.creado_por = p_vendedor
           or pg.cliente_id in (select id from clientes where creado_por = p_vendedor))
      and (p_tienda is null or exists (select 1 from ventas v
                                       where clave_pedido(v.envio, v.pedido_id) = trim(pg.envio)
                                         and upper(trim(v.tienda)) = upper(trim(p_tienda))))
  )
  select jsonb_build_object(
    'total',    coalesce(sum(valor_pagado) filter (where not contado), 0),
    'pagos',    count(*) filter (where not contado),
    'clientes', count(distinct cliente_id) filter (where not contado),
    'contado',  coalesce(sum(valor_pagado) filter (where contado), 0),
    'por_metodo', coalesce((select jsonb_agg(m order by m.valor desc)
                            from (select upper(trim(coalesce(nullif(metodo_pago, ''), 'SIN MÉTODO'))) as metodo,
                                         count(*) as pagos, sum(valor_pagado) as valor
                                  from p where not contado group by 1) m), '[]'::jsonb))
  from p
$$;

-- ---------------------------------------------------------------------
-- Resumen del administrador
-- ---------------------------------------------------------------------
create or replace function tiendaariga.resumen_admin(p_desde date default null, p_hasta date default null, p_tienda text default null)
returns jsonb
language plpgsql stable
security definer
set search_path = tiendaariga
as $$
declare
  d date; h date; kt_f text := upper(trim(nullif(p_tienda, '')));
  r jsonb;
begin
  if not es_admin() then raise exception 'Solo el administrador puede ver el resumen.'; end if;
  h := coalesce(p_hasta, (now() at time zone 'America/Guatemala')::date);
  d := coalesce(p_desde, (select min(fecha_venta) from ventas), h);

  with
  -- Ventas del periodo por vendedor (sin saldos iniciales)
  vt as (
    select upper(trim(coalesce(nullif(v.vendedor, ''), '(SIN VENDEDOR)'))) as kv,
           coalesce(v.valor_total, 0) as q,
           case when pr.unidad = 'GRAMOS' and coalesce(pr.controla_inventario, true) then coalesce(v.cantidad, 0) else 0 end as gr
    from ventas v left join productos pr on upper(trim(pr.nombre)) = upper(trim(v.producto))
    where upper(trim(coalesce(v.producto, ''))) <> 'SALDO INICIAL'
      and v.fecha_venta between d and h
      and (kt_f is null or upper(trim(v.tienda)) = kt_f)
  ),
  -- Cobrado: pagos del periodo, al vendedor de la venta del envío pagado (si no, al dueño del cliente)
  cob as (
    select coalesce(
             (select upper(trim(v.vendedor)) from ventas v
               where clave_pedido(v.envio, v.pedido_id) = trim(pg.envio) and nullif(trim(v.vendedor), '') is not null
                 and (pg.cliente_id is null or v.cliente_id is not distinct from pg.cliente_id) limit 1),
             (select upper(trim(coalesce(nullif(u.vendedor, ''), u.nombre))) from clientes c join perfiles u on u.id = c.creado_por
               where c.id = pg.cliente_id),
             '(SIN VENDEDOR)') as kv,
           coalesce(pg.valor_pagado, 0) as t,
           coalesce(pg.observaciones, '') like 'Venta en efectivo%' as contado
    from pagos pg
    where pg.fecha_pago between d and h
      and (kt_f is null or exists (select 1 from ventas v where clave_pedido(v.envio, v.pedido_id) = trim(pg.envio)
                                                         and upper(trim(v.tienda)) = kt_f))
  ),
  com as (
    select clave as kv, sum(comision) as comision, sum(meta) as meta,
           case when count(*) = 1 then max(cumplimiento) end as cumplimiento, max(esquema) as esquema
    from cuadre_calculo(d, h, kt_f) where dimension = 'vendedor' group by 1
  ),
  saldo_caja as (
    select m.usuario_id, sum(case when m.tipo = 'ENTRADA' then m.valor else -m.valor end) as saldo from caja_menor m group by 1
  ),
  caja_vend as (
    select upper(trim(coalesce(nullif(u.vendedor, ''), u.nombre))) as kv, sum(s.saldo) as caja
    from saldo_caja s join perfiles u on u.id = s.usuario_id group by 1
  ),
  claves as (
    select kv from vt union select kv from cob union select kv from com where comision > 0 or meta > 0
  ),
  vendedores_j as (
    select coalesce(jsonb_agg(x order by x.ventas_q desc, x.vendedor), '[]'::jsonb) as j from (
      select k.kv as vendedor,
             coalesce((select sum(q) from vt where vt.kv = k.kv), 0) as ventas_q,
             coalesce((select sum(gr) from vt where vt.kv = k.kv), 0) as ventas_gr,
             coalesce((select sum(t) from cob where cob.kv = k.kv and not contado), 0) as cobrado,
             coalesce((select sum(t) from cob where cob.kv = k.kv and contado), 0) as contado,
             coalesce(c.comision, 0) as comision, coalesce(c.meta, 0) as meta, c.cumplimiento, c.esquema,
             cv.caja
      from claves k left join com c on c.kv = k.kv left join caja_vend cv on cv.kv = k.kv) x
  ),
  -- Inventario en gramos (misma regla que la vista inventario)
  items as (
    select upper(trim(x.tienda)) as kt, upper(trim(x.producto)) as kp, min(x.tienda) as tienda, min(x.producto) as producto, min(x.fecha) as f
    from (select g.tienda, g.producto, g.fecha from ingresos_inventario g
          union all select i.tienda, i.producto, i.fecha_inicio from inventario_items i) x
    where coalesce(trim(x.tienda), '') <> '' and coalesce(trim(x.producto), '') <> ''
    group by 1, 2
  ),
  inicio as (
    select it.*, coalesce((select max(ii.fecha_inicio) from inventario_items ii
                           where upper(trim(ii.tienda)) = it.kt and upper(trim(ii.producto)) = it.kp), it.f) as fi
    from items it
    join productos pr on upper(trim(pr.nombre)) = it.kp and pr.unidad = 'GRAMOS' and coalesce(pr.controla_inventario, true)
    where kt_f is null or it.kt = kt_f
  ),
  mov as (
    select upper(trim(g.tienda)) as kt, upper(trim(g.producto)) as kp, g.fecha,
           coalesce(g.entrada, 0) as e, coalesce(g.salida, 0) as s,
           case when g.traslado_id is not null or upper(coalesce(g.concepto, '')) like 'TRASLADO%' then 'T'
                when upper(coalesce(g.concepto, '')) like 'INVENTARIO INICIAL%' then 'I' else 'O' end as cl
    from ingresos_inventario g
  ),
  inv as (
    select i.tienda, i.producto,
           -- Inicial: todo lo anterior al periodo (las cargas de "inventario inicial" dentro del periodo también)
           coalesce((select sum(m.e - m.s) from mov m where m.kt = i.kt and m.kp = i.kp
                       and (m.fecha is null or m.fecha < d or (m.cl = 'I' and m.fecha <= h))), 0)
         - coalesce((select sum(coalesce(v.cantidad, 0)) from ventas v where upper(trim(v.tienda)) = i.kt and upper(trim(v.producto)) = i.kp
                       and v.fecha_venta >= i.fi and v.fecha_venta < d), 0)
         - coalesce((select sum(coalesce(o.cantidad, 0)) from devoluciones_oficina o where upper(trim(o.tienda)) = i.kt and upper(trim(o.producto)) = i.kp
                       and o.fecha_devolucion < d), 0) as inicial,
           coalesce((select sum(m.e) from mov m where m.kt = i.kt and m.kp = i.kp and m.cl = 'O' and m.fecha between d and h), 0) as ingresos,
           coalesce((select sum(m.e) from mov m where m.kt = i.kt and m.kp = i.kp and m.cl = 'T' and m.fecha between d and h), 0) as traslados_recibidos,
           coalesce((select sum(m.s) from mov m where m.kt = i.kt and m.kp = i.kp and m.cl = 'T' and m.fecha between d and h), 0) as traslados_enviados,
           coalesce((select sum(coalesce(v.cantidad, 0)) from ventas v where upper(trim(v.tienda)) = i.kt and upper(trim(v.producto)) = i.kp
                       and v.fecha_venta >= greatest(i.fi, d) and v.fecha_venta <= h), 0) as ventas,
           coalesce((select sum(m.s) from mov m where m.kt = i.kt and m.kp = i.kp and m.cl = 'O' and m.fecha between d and h), 0)
         + coalesce((select sum(coalesce(o.cantidad, 0)) from devoluciones_oficina o where upper(trim(o.tienda)) = i.kt and upper(trim(o.producto)) = i.kp
                       and o.fecha_devolucion between d and h), 0) as otras_salidas
    from inicio i
  ),
  inventario_j as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tienda', tienda, 'producto', producto, 'inicial', round(inicial, 2), 'ingresos', round(ingresos, 2),
             'traslados_recibidos', round(traslados_recibidos, 2), 'traslados_enviados', round(traslados_enviados, 2),
             'ventas', round(ventas, 2), 'otras_salidas', round(otras_salidas, 2),
             'final', round(inicial + ingresos + traslados_recibidos - traslados_enviados - ventas - otras_salidas, 2))
             order by tienda, producto), '[]'::jsonb) as j
    from inv
  ),
  -- Cajas: efectivo actual, movimientos del periodo y último cuadre
  cajas_j as (
    select coalesce(jsonb_agg(x order by x.saldo desc, x.usuario), '[]'::jsonb) as j from (
      select u.id as usuario_id, coalesce(u.nombre, u.usuario) as usuario, u.tienda,
             coalesce(sum(case when m.tipo = 'ENTRADA' then m.valor else -m.valor end), 0) as saldo,
             coalesce(sum(m.valor) filter (where m.tipo = 'ENTRADA' and m.fecha between d and h and m.origen <> 'CUADRE'), 0) as entradas,
             coalesce(sum(m.valor) filter (where m.tipo = 'SALIDA' and m.fecha between d and h and m.origen <> 'CUADRE'), 0) as salidas,
             (select max(cc.fecha) from cuadres_caja cc where cc.usuario_id = u.id) as ultimo_cuadre
      from perfiles u join caja_menor m on m.usuario_id = u.id
      where kt_f is null or upper(trim(u.tienda)) = kt_f
      group by u.id) x
  )
  select jsonb_build_object('desde', d, 'hasta', h,
                            'vendedores', (select j from vendedores_j),
                            'inventario', (select j from inventario_j),
                            'cajas', (select j from cajas_j))
    into r;
  return r;
end;
$$;

revoke execute on function tiendaariga.cuadrar_caja(uuid, numeric, date, text)     from public, anon;
revoke execute on function tiendaariga.anular_cuadre_caja(bigint)                  from public, anon;
revoke execute on function tiendaariga.abonos_periodo(date, date, text, uuid)      from public, anon;
revoke execute on function tiendaariga.resumen_admin(date, date, text)             from public, anon;
grant  execute on function tiendaariga.cuadrar_caja(uuid, numeric, date, text)     to authenticated;
grant  execute on function tiendaariga.anular_cuadre_caja(bigint)                  to authenticated;
grant  execute on function tiendaariga.abonos_periodo(date, date, text, uuid)      to authenticated;
grant  execute on function tiendaariga.resumen_admin(date, date, text)             to authenticated;

notify pgrst, 'reload schema';
