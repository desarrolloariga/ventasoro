-- =====================================================================
--  Joyería ARIGA - Actualización 37: COMISIÓN POR PRECIO PROMEDIO DEL GRAMO
--  * El plan individual de cada vendedor puede ser de dos tipos:
--      - CUMPLIMIENTO (el de siempre): rangos por % de cumplimiento de la
--        meta sobre lo cobrado.
--      - PRECIO_GRAMO: rangos por precio promedio del gramo de oro vendido
--        en el mes (valor vendido en gramos / gramos vendidos). Ej.: desde
--        Q 800/g gana 2 %, desde Q 900/g gana 3 %. Sin ventas de oro en el
--        mes no hay rango (0 %).
--    En los dos casos el % se paga sobre lo COBRADO en el mes.
--  * cuadre_calculo devuelve además precio_gramo (por vendedor y en el
--    detalle de los planes por precio).
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 36. Se puede repetir.
-- =====================================================================

alter table tiendaariga.planes_comision add column if not exists tipo text not null default 'CUMPLIMIENTO';
alter table tiendaariga.planes_comision drop constraint if exists planes_comision_tipo_chk;
alter table tiendaariga.planes_comision add constraint planes_comision_tipo_chk check (tipo in ('CUMPLIMIENTO', 'PRECIO_GRAMO'));

drop function if exists tiendaariga.guardar_plan_comision(text, date, numeric, jsonb);
create or replace function tiendaariga.guardar_plan_comision(p_vendedor text, p_desde date, p_meta numeric, p_tramos jsonb,
                                                            p_tipo text default 'CUMPLIMIENTO')
returns tiendaariga.planes_comision
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare r planes_comision; v_tramos jsonb; t jsonb; v_tipo text := upper(coalesce(nullif(trim(p_tipo), ''), 'CUMPLIMIENTO'));
begin
  if not es_admin() then raise exception 'Solo el administrador configura los planes de comisión.'; end if;
  if v_tipo not in ('CUMPLIMIENTO', 'PRECIO_GRAMO') then raise exception 'Tipo de comisión no válido: %', p_tipo; end if;
  if not exists (select 1 from vendedores where nombre = p_vendedor) then raise exception 'El vendedor % no existe.', p_vendedor; end if;
  if p_desde is null then raise exception 'Indique desde qué mes aplica el plan.'; end if;
  if coalesce(p_meta, 0) < 0 then raise exception 'La meta no puede ser negativa.'; end if;
  if v_tipo = 'CUMPLIMIENTO' and coalesce(p_meta, 0) <= 0 then raise exception 'Escriba la meta mensual (sobre lo cobrado).'; end if;
  for t in select * from jsonb_array_elements(coalesce(p_tramos, '[]'::jsonb)) loop
    if (t->>'desde') is null or (t->>'pct') is null then raise exception 'Cada rango necesita su "desde" y su %% de comisión.'; end if;
    if (t->>'desde')::numeric < 0 then raise exception 'El inicio de un rango no puede ser negativo.'; end if;
    if (t->>'pct')::numeric < 0 or (t->>'pct')::numeric > 100 then raise exception 'El %% de comisión debe estar entre 0 y 100.'; end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('desde', d, 'pct', p) order by d), '[]'::jsonb) into v_tramos
  from (select distinct on ((x->>'desde')::numeric) (x->>'desde')::numeric as d, (x->>'pct')::numeric as p
        from jsonb_array_elements(coalesce(p_tramos, '[]'::jsonb)) x
        order by (x->>'desde')::numeric) y;
  if jsonb_array_length(v_tramos) = 0 then raise exception 'Agregue al menos un rango.'; end if;
  insert into planes_comision (vendedor, desde, meta, tramos, tipo, creado_por)
  values (p_vendedor, date_trunc('month', p_desde)::date, round(coalesce(p_meta, 0), 2), v_tramos, v_tipo, auth.uid())
  on conflict (vendedor, desde) do update set meta = excluded.meta, tramos = excluded.tramos, tipo = excluded.tipo,
                                              creado_por = excluded.creado_por, created_at = now()
  returning * into r;
  return r;
end;
$$;
revoke execute on function tiendaariga.guardar_plan_comision(text, date, numeric, jsonb, text) from public, anon;
grant  execute on function tiendaariga.guardar_plan_comision(text, date, numeric, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------
-- Cálculo del cuadre y comisiones (con el tipo de plan)
-- ---------------------------------------------------------------------
drop function if exists tiendaariga.cuadre_tiendas(date, date, text);
drop function if exists tiendaariga.cuadre_calculo(date, date, text);
create function tiendaariga.cuadre_calculo(p_desde date, p_hasta date, p_tienda text default null)
returns table (mes date, dimension text, clave text,
               cartera numeric, inventario_gr numeric, ventas_gr numeric, ventas_q numeric,
               comision numeric, meta numeric,
               caja numeric, caja_entradas numeric, caja_salidas numeric,
               recaudo numeric, recaudo_efectivo numeric,
               comision_pct numeric, cumplimiento numeric, esquema text, precio_gramo numeric)
language plpgsql stable
security definer
set search_path = tiendaariga
as $$
#variable_conflict use_column
begin
  return query
  with meses as (
    select m::date as mes, (m + interval '1 month' - interval '1 day')::date as fin
    from generate_series(date_trunc('month', p_desde), date_trunc('month', p_hasta), interval '1 month') m
  ),
  filtro as (select upper(trim(p_tienda)) as kt),
  -- Ventas reales del periodo (sin saldos iniciales)
  vt as (
    select date_trunc('month', v.fecha_venta)::date as mes,
           upper(trim(coalesce(v.tienda, '(SIN TIENDA)'))) as kt,
           upper(trim(coalesce(v.vendedor, '(SIN VENDEDOR)'))) as kv,
           coalesce(v.valor_total, 0) as q,
           case when pr.unidad = 'GRAMOS' then coalesce(v.cantidad, 0) else 0 end as gr,
           case when pr.unidad = 'GRAMOS' then coalesce(v.valor_total, 0) else 0 end as qg,
           coalesce(cl.tipo_cliente, '') = 'MAYORISTA' as mayoreo
    from ventas v
    left join productos pr on upper(trim(pr.nombre)) = upper(trim(v.producto))
    left join clientes cl on cl.id = v.cliente_id
    where upper(trim(coalesce(v.producto, ''))) <> 'SALDO INICIAL'
      and v.fecha_venta between (select min(mes) from meses) and (select max(fin) from meses)
      and ((select kt from filtro) is null or upper(trim(v.tienda)) = (select kt from filtro))
  ),
  -- Cobrado del mes por vendedor (base de la comisión): abonos recibidos a envíos de sus ventas
  -- (si el envío no se encuentra, al vendedor dueño del cliente)
  cb as (
    select date_trunc('month', p.fecha_pago)::date as mes,
           coalesce((select upper(trim(v.vendedor)) from ventas v
                      where clave_pedido(v.envio, v.pedido_id) = trim(p.envio) and nullif(trim(v.vendedor), '') is not null
                        and (p.cliente_id is null or v.cliente_id is not distinct from p.cliente_id) limit 1),
                    (select upper(trim(coalesce(nullif(u.vendedor, ''), u.nombre))) from clientes c join perfiles u on u.id = c.creado_por
                      where c.id = p.cliente_id),
                    '(SIN VENDEDOR)') as kv,
           coalesce(p.valor_pagado, 0) as q,
           coalesce((select cl.tipo_cliente from clientes cl where cl.id = p.cliente_id), '') = 'MAYORISTA' as mayoreo
    from pagos p
    where p.fecha_pago between (select min(mes) from meses) and (select max(fin) from meses)
      and ((select kt from filtro) is null
           or exists (select 1 from ventas v where clave_pedido(v.envio, v.pedido_id) = trim(p.envio)
                                               and upper(trim(v.tienda)) = (select kt from filtro)))
  ),
  vend as (select upper(trim(nombre)) as kv, comision_pct, meta_mensual, meta_grupal, activo,
                  upper(trim(nullif(supervisor, ''))) as ksup from vendedores),
  -- Esquemas de cada vendedor (puede tener varios)
  asign as (
    select upper(trim(ve.vendedor)) as kv, e.id as esq_id, e.nombre, e.tipo, e.tramos, e.pct_mayoreo
    from vendedor_esquemas ve join esquemas_comision e on e.id = ve.esquema_id and e.activo
  ),
  -- Plan individual vigente de cada vendedor en cada mes (el más reciente con desde <= mes)
  plan as (
    select distinct on (m.mes, upper(trim(p.vendedor))) m.mes, upper(trim(p.vendedor)) as kv, p.id, p.meta, p.tramos, p.tipo
    from meses m join planes_comision p on p.desde <= m.mes
    order by m.mes, upper(trim(p.vendedor)), p.desde desc
  ),
  -- Esquemas de cada mes: el plan individual reemplaza los esquemas individuales compartidos
  asign_m as (
    select pl.mes, pl.kv, -pl.id as esq_id,
           case when pl.tipo = 'PRECIO_GRAMO' then 'PLAN PRECIO POR GRAMO' else 'PLAN INDIVIDUAL' end::text as nombre,
           'INDIVIDUAL'::text as tipo, pl.tramos, null::numeric as pct_mayoreo, true as es_plan, pl.tipo as criterio
    from plan pl
    union all
    select m.mes, a.kv, a.esq_id, a.nombre, a.tipo, a.tramos, a.pct_mayoreo, false, 'CUMPLIMIENTO'::text
    from meses m cross join asign a
    where not (a.tipo = 'INDIVIDUAL' and exists (select 1 from plan pl where pl.mes = m.mes and pl.kv = a.kv))
  ),
  -- Cartera: cada envío (por cliente) con lo abonado hasta el cierre de cada mes
  env as (
    select coalesce(nullif(trim(v.envio), ''), v.pedido_id) as k, v.cliente_id,
           min(v.fecha_venta) as f, upper(trim(coalesce(max(v.tienda), '(SIN TIENDA)'))) as kt,
           sum(coalesce(v.valor_total, 0)) as t
    from ventas v
    where coalesce(nullif(trim(v.envio), ''), v.pedido_id) is not null
    group by 1, 2
  ),
  abonos as (
    select trim(p.envio) as k, p.cliente_id, p.fecha_pago as f, coalesce(p.valor_pagado, 0) as t
    from pagos p where coalesce(trim(p.envio), '') <> ''
    union all
    select trim(d.envio), null, d.fecha_devolucion, coalesce(d.valor, 0)
    from devoluciones d where coalesce(trim(d.envio), '') <> ''
  ),
  cart as (
    select m.mes, e.kt,
           greatest(e.t - coalesce((select sum(a.t) from abonos a
                                    where a.k = e.k
                                      and (a.cliente_id is null or a.cliente_id is not distinct from e.cliente_id)
                                      and coalesce(a.f, e.f) <= m.fin), 0), 0) as saldo
    from meses m join env e on e.f <= m.fin
    where (select kt from filtro) is null or e.kt = (select kt from filtro)
  ),
  -- Inventario en gramos al cierre (misma regla que el saldo de inventario)
  items as (
    select upper(trim(x.tienda)) as kt, upper(trim(x.producto)) as kp, min(x.fecha) as f
    from (select g.tienda, g.producto, g.fecha from ingresos_inventario g
          union all select i.tienda, i.producto, i.fecha_inicio from inventario_items i) x
    where coalesce(trim(x.tienda), '') <> '' and coalesce(trim(x.producto), '') <> ''
    group by 1, 2
  ),
  inicio as (
    select it.kt, it.kp,
           coalesce((select max(ii.fecha_inicio) from inventario_items ii
                     where upper(trim(ii.tienda)) = it.kt and upper(trim(ii.producto)) = it.kp), it.f) as fi
    from items it
    join productos pr on upper(trim(pr.nombre)) = it.kp and pr.unidad = 'GRAMOS'
    where (select kt from filtro) is null or it.kt = (select kt from filtro)
  ),
  inv as (
    select m.mes, i.kt,
           coalesce((select sum(coalesce(g.entrada, 0) - coalesce(g.salida, 0)) from ingresos_inventario g
                     where upper(trim(g.tienda)) = i.kt and upper(trim(g.producto)) = i.kp and g.fecha <= m.fin), 0)
         - coalesce((select sum(coalesce(v.cantidad, 0)) from ventas v
                     where upper(trim(v.tienda)) = i.kt and upper(trim(v.producto)) = i.kp
                       and v.fecha_venta >= i.fi and v.fecha_venta <= m.fin), 0)
         - coalesce((select sum(coalesce(o.cantidad, 0)) from devoluciones_oficina o
                     where upper(trim(o.tienda)) = i.kt and upper(trim(o.producto)) = i.kp
                       and o.fecha_devolucion <= m.fin), 0) as gr
    from meses m cross join inicio i
  ),
  -- Recaudo: pagos recibidos en el mes; la tienda es la de la venta del envío pagado
  rec as (
    select date_trunc('month', p.fecha_pago)::date as mes,
           coalesce((select e.kt from env e where e.k = trim(p.envio)
                       and (p.cliente_id is null or e.cliente_id is not distinct from p.cliente_id) limit 1), '(SIN ENVÍO)') as kt,
           upper(trim(coalesce(nullif(p.metodo_pago, ''), '(SIN MÉTODO)'))) as km,
           coalesce(p.valor_pagado, 0) as t,
           coalesce(p.observaciones, '') like 'Venta en efectivo%' as de_venta_efectivo
    from pagos p
    where p.fecha_pago between (select min(mes) from meses) and (select max(fin) from meses)
  ),
  recf as (
    select * from rec where (select kt from filtro) is null or kt = (select kt from filtro)
  ),
  -- Caja menor: saldo al cierre y movimientos del mes, por usuario (con su tienda)
  cj as (
    select m.mes, u.id as uid, coalesce(u.nombre, u.usuario) as nombre,
           upper(trim(coalesce(u.tienda, '(SIN TIENDA)'))) as kt,
           coalesce(sum(case when c.tipo = 'ENTRADA' then c.valor else -c.valor end) filter (where c.fecha <= m.fin), 0) as saldo,
           coalesce(sum(c.valor) filter (where c.tipo = 'ENTRADA' and c.fecha between m.mes and m.fin), 0) as ent,
           coalesce(sum(c.valor) filter (where c.tipo = 'SALIDA'  and c.fecha between m.mes and m.fin), 0) as sal
    from meses m
    join caja_menor c on c.fecha <= m.fin
    join perfiles u on u.id = c.usuario_id
    where (select kt from filtro) is null or upper(trim(u.tienda)) = (select kt from filtro)
    group by m.mes, u.id
  ),
  por_tienda as (
    select c.mes, c.kt, sum(c.saldo) as cartera, 0::numeric as inv, 0::numeric as gr, 0::numeric as q, 0::numeric as com,
           0::numeric as caja, 0::numeric as ent, 0::numeric as sal, 0::numeric as rec, 0::numeric as rec_ef
      from cart c group by 1, 2
    union all
    select i.mes, i.kt, 0, sum(i.gr), 0, 0, 0, 0, 0, 0, 0, 0 from inv i group by 1, 2
    union all
    select x.mes, x.kt, 0, 0, sum(x.gr), sum(x.q), 0, 0, 0, 0, 0, 0
      from vt x group by 1, 2
    union all
    select j.mes, j.kt, 0, 0, 0, 0, 0, sum(j.saldo), sum(j.ent), sum(j.sal), 0, 0 from cj j group by 1, 2
    union all
    select r.mes, r.kt, 0, 0, 0, 0, 0, 0, 0, 0, sum(r.t), sum(r.t) filter (where r.de_venta_efectivo) from recf r group by 1, 2
  ),
  -- Por vendedor: ventas (para mostrar) y cobrado (base de la comisión)
  por_vendedor as (
    select z.mes, z.kv, sum(z.gr) as gr, sum(z.q) as q, sum(z.qg) as qg, sum(z.cq) as cq, sum(z.cqm) as cqm
    from (select x.mes, x.kv, x.gr, x.q, x.qg, 0::numeric as cq, 0::numeric as cqm from vt x
          union all
          select c.mes, c.kv, 0, 0, 0, c.q, case when c.mayoreo then c.q else 0 end from cb c) z
    group by 1, 2
  ),
  -- Vendedores del mes: los que vendieron y, sin filtro de tienda, los que tienen meta
  base as (
    select m.mes, ks.kv, coalesce(pv.gr, 0) as gr, coalesce(pv.q, 0) as q, coalesce(pv.cq, 0) as cq, coalesce(pv.cqm, 0) as qm,
           case when coalesce(pv.gr, 0) > 0 then pv.qg / pv.gr end as precio,
           coalesce(plm.meta, vd.meta_mensual, 0) as meta, coalesce(vd.meta_grupal, 0) as meta_grupal,
           coalesce(vd.comision_pct, 0) as pct_fijo, vd.ksup
    from meses m
    cross join lateral (
      select kv from por_vendedor where por_vendedor.mes = m.mes
      union
      select kv from vend where activo and (meta_mensual > 0 or meta_grupal > 0 or kv in (select kv from asign)
                                            or kv in (select pl.kv from plan pl where pl.mes = m.mes))
                                and (select kt from filtro) is null
      union   -- supervisores(as) de quienes vendieron, aunque ellas no vendieran
      select v2.ksup from vend v2 join por_vendedor p2 on p2.kv = v2.kv and p2.mes = m.mes where v2.ksup is not null
    ) ks
    left join por_vendedor pv on pv.mes = m.mes and pv.kv = ks.kv
    left join vend vd on vd.kv = ks.kv
    left join plan plm on plm.mes = m.mes and plm.kv = ks.kv
  ),
  -- Grupo de cada persona: ella misma y quienes la tienen como supervisora
  grupo as (
    select b.mes, b.kv, sum(t.cq) as q, sum(t.qm) as qm, sum(t.meta) as meta
    from base b join base t on t.mes = b.mes and (t.kv = b.kv or t.ksup = b.kv)
    group by 1, 2
  ),
  -- Una fila por vendedor y esquema (sin esquemas: una fila con su % fijo)
  evalua as (
    select b.*, a.esq_id, a.nombre as esquema, a.tipo, a.tramos, coalesce(a.criterio, 'CUMPLIMIENTO') as criterio,
           case when a.es_plan then null else coalesce(a.pct_mayoreo, 0) end as pct_mayoreo,
           case when a.tipo = 'GRUPAL' then g.q  else b.cq end as q_eval,
           case when a.tipo = 'GRUPAL' then g.qm else b.qm end as qm_eval,
           case when a.tipo = 'GRUPAL' then (case when b.meta_grupal > 0 then b.meta_grupal else g.meta end) else b.meta end as meta_eval
    from base b
    left join asign_m a on a.kv = b.kv and a.mes = b.mes
    left join grupo g on g.mes = b.mes and g.kv = b.kv
  ),
  tramo as (
    select ev.*,
           case when ev.meta_eval > 0 then ev.q_eval / ev.meta_eval * 100 end as cumpl,
           case when ev.tipo is null then ev.pct_fijo
                when ev.criterio = 'PRECIO_GRAMO' then
                     coalesce((select (tr->>'pct')::numeric from jsonb_array_elements(ev.tramos) tr
                               where ev.precio is not null and (tr->>'desde')::numeric <= ev.precio
                               order by (tr->>'desde')::numeric desc limit 1), 0)
                else coalesce((select (tr->>'pct')::numeric from jsonb_array_elements(ev.tramos) tr
                               where (tr->>'desde')::numeric <= coalesce(floor(ev.q_eval / nullif(ev.meta_eval, 0) * 100), 0)
                               order by (tr->>'desde')::numeric desc limit 1), 0) end as pct
    from evalua ev
  ),
  comis as (
    select t.*, case when t.tipo is null then t.cq * t.pct / 100
                     else (t.q_eval - t.qm_eval) * t.pct / 100 + t.qm_eval * coalesce(t.pct_mayoreo, t.pct) / 100 end as com
    from tramo t
  )
  select t.mes, 'tienda'::text, t.kt,
         round(sum(t.cartera), 2), round(sum(t.inv), 2), round(sum(t.gr), 2), round(sum(t.q), 2),
         round(sum(t.com), 2), null::numeric,
         round(sum(t.caja), 2), round(sum(t.ent), 2), round(sum(t.sal), 2),
         round(sum(t.rec), 2), round(coalesce(sum(t.rec_ef), 0), 2),
         null::numeric, null::numeric, null::text, null::numeric
  from por_tienda t group by t.mes, t.kt
  union all
  -- Vendedores: ventas, meta individual y comisión total (suma de sus esquemas)
  --   sin esquema: cobrado x % fijo
  --   con esquema: (cobrado - cobrado a mayoristas) x % del tramo + cobrado a mayoristas x % de mayoreo
  --   esquema grupal: sobre lo cobrado y la meta de su grupo
  select c.mes, 'vendedor'::text, c.kv,
         null::numeric, null::numeric, round(max(c.gr), 2), round(max(c.q), 2),
         round(sum(c.com), 2), max(c.meta),
         null::numeric, null::numeric, null::numeric, round(max(c.cq), 2), null::numeric,
         case when count(*) = 1 then max(c.pct) end,
         round(case when count(*) = 1 then max(c.cumpl) when max(c.meta) > 0 then max(c.cq) / max(c.meta) * 100 end, 1),
         coalesce(string_agg(c.esquema, ' + ' order by c.tipo desc, c.esquema), case when max(c.pct) > 0 then 'FIJO' end),
         round(max(c.precio), 2)
  from comis c group by c.mes, c.kv
  union all
  -- Detalle de la comisión por esquema (ventas_q = cobrado evaluado por ese esquema; meta evaluada)
  select c.mes, 'comision'::text, c.kv,
         null::numeric, null::numeric, null::numeric, round(coalesce(c.q_eval, c.cq), 2),
         round(c.com, 2), case when c.tipo is null then null else c.meta_eval end,
         null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
         c.pct, case when c.criterio = 'PRECIO_GRAMO' then null else round(c.cumpl, 1) end,
         coalesce(c.esquema || case when c.tipo = 'GRUPAL' then ' (grupal)' else '' end, 'FIJO'),
         case when c.criterio = 'PRECIO_GRAMO' then round(c.precio, 2) end
  from comis c
  where c.esquema is not null or c.pct > 0
  union all
  -- Caja menor por usuario
  select j.mes, 'usuario'::text, j.nombre,
         null::numeric, null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
         round(j.saldo, 2), round(j.ent, 2), round(j.sal, 2), null::numeric, null::numeric,
         null::numeric, null::numeric, null::text, null::numeric
  from cj j
  union all
  -- Recaudo por método de pago
  select r.mes, 'metodo'::text, r.km,
         null::numeric, null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
         null::numeric, null::numeric, null::numeric,
         round(sum(r.t), 2), round(coalesce(sum(r.t) filter (where r.de_venta_efectivo), 0), 2),
         null::numeric, null::numeric, null::text, null::numeric
  from recf r group by r.mes, r.km
  order by 1, 2, 3;
end;
$$;

revoke execute on function tiendaariga.cuadre_calculo(date, date, text) from public, anon, authenticated;

-- Cuadre de tiendas (administrador), con la nueva columna
create function tiendaariga.cuadre_tiendas(p_desde date, p_hasta date, p_tienda text default null)
returns table (mes date, dimension text, clave text,
               cartera numeric, inventario_gr numeric, ventas_gr numeric, ventas_q numeric,
               comision numeric, meta numeric,
               caja numeric, caja_entradas numeric, caja_salidas numeric,
               recaudo numeric, recaudo_efectivo numeric,
               comision_pct numeric, cumplimiento numeric, esquema text, precio_gramo numeric)
language plpgsql stable
security definer
set search_path = tiendaariga
as $$
begin
  if not es_admin() then
    raise exception 'Solo el administrador puede ver el cuadre de tiendas.';
  end if;
  return query select * from cuadre_calculo(p_desde, p_hasta, p_tienda);
end;
$$;
revoke execute on function tiendaariga.cuadre_tiendas(date, date, text) from public, anon;
grant  execute on function tiendaariga.cuadre_tiendas(date, date, text) to authenticated;

-- Comisión mes a mes del usuario con sesión (con el precio por gramo)
drop function if exists tiendaariga.mis_comisiones(date, date);
create function tiendaariga.mis_comisiones(p_desde date, p_hasta date)
returns table (mes date, vendedor text, esquema text, meta numeric, ventas_q numeric, ventas_gr numeric,
               cumplimiento numeric, comision_pct numeric, comision numeric, detalle jsonb, cobrado numeric, precio_gramo numeric)
language plpgsql stable
security definer
set search_path = tiendaariga
as $$
#variable_conflict use_column
declare v_vend text := mi_vendedor();
begin
  if v_vend is null then
    return;   -- usuario sin vendedor vinculado
  end if;
  return query
  with c as (select * from cuadre_calculo(p_desde, p_hasta, null) x where x.clave = upper(trim(v_vend)))
  select v.mes, v_vend, v.esquema, v.meta, v.ventas_q, v.ventas_gr, v.cumplimiento, v.comision_pct, v.comision,
         coalesce((select jsonb_agg(jsonb_build_object('esquema', d.esquema, 'ventas', d.ventas_q, 'meta', d.meta,
                                                       'cumplimiento', d.cumplimiento, 'pct', d.comision_pct, 'comision', d.comision,
                                                       'precio', d.precio_gramo)
                                    order by d.esquema)
                   from c d where d.dimension = 'comision' and d.mes = v.mes), '[]'::jsonb),
         coalesce(v.recaudo, 0), v.precio_gramo
  from c v
  where v.dimension = 'vendedor'
  order by v.mes desc;
end;
$$;
revoke execute on function tiendaariga.mis_comisiones(date, date) from public, anon;
grant  execute on function tiendaariga.mis_comisiones(date, date) to authenticated;

-- Resumen del vendedor (Inteligencia), con el precio por gramo
create or replace function tiendaariga.mi_resumen(p_desde date default null, p_hasta date default null)
returns jsonb
language plpgsql stable
security definer
set search_path = tiendaariga
as $$
declare
  v_nombre text := mi_vendedor();
  kv text; d date; h date; r jsonb;
begin
  if not usuario_activo() then raise exception 'Usuario inactivo.'; end if;
  if v_nombre is null then
    return jsonb_build_object('vendedor', null);
  end if;
  kv := upper(trim(v_nombre));
  h := coalesce(p_hasta, (now() at time zone 'America/Guatemala')::date);
  d := coalesce(p_desde, (select min(fecha_venta) from ventas where upper(trim(vendedor)) = kv), h);

  with
  vt as (
    select v.*, coalesce(v.valor_total, 0) as q,
           case when pr.unidad = 'GRAMOS' and coalesce(pr.controla_inventario, true) then coalesce(v.cantidad, 0) else 0 end as gr
    from ventas v left join productos pr on upper(trim(pr.nombre)) = upper(trim(v.producto))
    where upper(trim(v.vendedor)) = kv
      and upper(trim(coalesce(v.producto, ''))) <> 'SALDO INICIAL'
      and v.fecha_venta between d and h
  ),
  -- Envíos de sus ventas (de cualquier fecha): a ellos se aplican los abonos
  mis_envios as (
    select distinct clave_pedido(v.envio, v.pedido_id) as k, v.cliente_id
    from ventas v where upper(trim(v.vendedor)) = kv
  ),
  cob as (
    select pg.*, coalesce(pg.observaciones, '') like 'Venta en efectivo%' as contado
    from pagos pg
    where pg.fecha_pago between d and h
      and exists (select 1 from mis_envios e where e.k = trim(pg.envio)
                                               and (pg.cliente_id is null or e.cliente_id is not distinct from pg.cliente_id))
  ),
  cc as (select * from cuadre_calculo(d, h, null) where clave = kv and dimension in ('vendedor', 'comision'))
  select jsonb_build_object(
    'vendedor', v_nombre, 'desde', d, 'hasta', h,
    'ventas_q',  (select coalesce(sum(q), 0) from vt),
    'ventas_gr', (select coalesce(sum(gr), 0) from vt),
    'pedidos',   (select count(distinct clave_pedido(envio, pedido_id)) from vt),
    'clientes',  (select count(distinct cliente_id) from vt),
    'cobrado',   (select coalesce(sum(valor_pagado), 0) from cob where not contado),
    'pagos',     (select count(*) from cob where not contado),
    'contado',   (select coalesce(sum(valor_pagado), 0) from cob where contado),
    'cobro_por_metodo', (select coalesce(jsonb_agg(m order by m.valor desc), '[]'::jsonb) from (
                           select upper(trim(coalesce(nullif(metodo_pago, ''), 'SIN MÉTODO'))) as metodo, count(*) as pagos, sum(valor_pagado) as valor
                           from cob where not contado group by 1) m),
    'comision',  (select coalesce(sum(comision), 0) from cc where dimension = 'vendedor'),
    'meta',      (select coalesce(sum(meta), 0) from cc where dimension = 'vendedor'),
    'cumplimiento', (select case when count(*) = 1 then max(cumplimiento) end from cc where dimension = 'vendedor'),
    'precio_gramo', (select case when sum(ventas_gr) > 0 then (select sum(x.qg) from (select coalesce(v.valor_total, 0) as qg from ventas v join productos pr on upper(trim(pr.nombre)) = upper(trim(v.producto)) and pr.unidad = 'GRAMOS' where upper(trim(v.vendedor)) = kv and v.fecha_venta between d and h) x) / sum(ventas_gr) end from cc where dimension = 'vendedor'),
    'detalle_comision', (select coalesce(jsonb_agg(jsonb_build_object(
                            'mes', mes, 'esquema', esquema, 'ventas_q', ventas_q, 'meta', meta,
                            'cumplimiento', cumplimiento, 'pct', comision_pct, 'comision', comision, 'precio', precio_gramo) order by mes, esquema), '[]'::jsonb)
                         from cc where dimension = 'comision'),
    'por_mes', (select coalesce(jsonb_agg(jsonb_build_object('mes', mes, 'ventas_q', ventas_q, 'ventas_gr', ventas_gr, 'comision', comision) order by mes), '[]'::jsonb)
                from cc where dimension = 'vendedor'),
    'caja', (select coalesce(sum(case when m.tipo = 'ENTRADA' then m.valor else -m.valor end), 0) from caja_menor m where m.usuario_id = auth.uid())
  ) into r;
  return r;
end;
$$;

revoke execute on function tiendaariga.mi_resumen(date, date) from public, anon;
grant  execute on function tiendaariga.mi_resumen(date, date) to authenticated;

notify pgrst, 'reload schema';
