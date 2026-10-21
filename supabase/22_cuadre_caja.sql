-- =====================================================================
--  Joyería ARIGA - Actualización 22: CAJA MENOR EN EL CUADRE DE TIENDAS
--  * cuadre_tiendas ahora también trae, para cada mes, la caja menor al
--    cierre (efectivo en caja el último día del mes) y las entradas y
--    salidas del mes, por tienda (la del usuario) y por usuario.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 21. Se puede repetir.
-- =====================================================================

drop function if exists tiendaariga.cuadre_tiendas(date, date, text);
create function tiendaariga.cuadre_tiendas(p_desde date, p_hasta date, p_tienda text default null)
returns table (mes date, dimension text, clave text,
               cartera numeric, inventario_gr numeric, ventas_gr numeric, ventas_q numeric,
               comision numeric, meta numeric,
               caja numeric, caja_entradas numeric, caja_salidas numeric)
language plpgsql stable
security definer
set search_path = tiendaariga
as $$
#variable_conflict use_column
begin
  if not es_admin() then
    raise exception 'Solo el administrador puede ver el cuadre de tiendas.';
  end if;

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
           case when pr.unidad = 'GRAMOS' then coalesce(v.cantidad, 0) else 0 end as gr
    from ventas v
    left join productos pr on upper(trim(pr.nombre)) = upper(trim(v.producto))
    where upper(trim(coalesce(v.producto, ''))) <> 'SALDO INICIAL'
      and v.fecha_venta between (select min(mes) from meses) and (select max(fin) from meses)
      and ((select kt from filtro) is null or upper(trim(v.tienda)) = (select kt from filtro))
  ),
  vend as (select upper(trim(nombre)) as kv, comision_pct, meta_mensual, activo from vendedores),
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
           0::numeric as caja, 0::numeric as ent, 0::numeric as sal
      from cart c group by 1, 2
    union all
    select i.mes, i.kt, 0, sum(i.gr), 0, 0, 0, 0, 0, 0 from inv i group by 1, 2
    union all
    select x.mes, x.kt, 0, 0, sum(x.gr), sum(x.q), sum(x.q * coalesce(vd.comision_pct, 0) / 100), 0, 0, 0
      from vt x left join vend vd on vd.kv = x.kv group by 1, 2
    union all
    select j.mes, j.kt, 0, 0, 0, 0, 0, sum(j.saldo), sum(j.ent), sum(j.sal) from cj j group by 1, 2
  ),
  por_vendedor as (
    select x.mes, x.kv, sum(x.gr) as gr, sum(x.q) as q from vt x group by 1, 2
  )
  select t.mes, 'tienda'::text, t.kt,
         round(sum(t.cartera), 2), round(sum(t.inv), 2), round(sum(t.gr), 2), round(sum(t.q), 2),
         round(sum(t.com), 2), null::numeric,
         round(sum(t.caja), 2), round(sum(t.ent), 2), round(sum(t.sal), 2)
  from por_tienda t group by t.mes, t.kt
  union all
  -- Vendedores: los que vendieron y, sin filtro de tienda, los que tienen meta aunque no vendieran
  select m.mes, 'vendedor'::text, coalesce(pv.kv, vd.kv),
         null::numeric, null::numeric, round(coalesce(pv.gr, 0), 2), round(coalesce(pv.q, 0), 2),
         round(coalesce(pv.q, 0) * coalesce(vd.comision_pct, 0) / 100, 2), coalesce(vd.meta_mensual, 0),
         null::numeric, null::numeric, null::numeric
  from meses m
  cross join lateral (
    select kv from por_vendedor where por_vendedor.mes = m.mes
    union
    select kv from vend where meta_mensual > 0 and activo and (select kt from filtro) is null
  ) ks
  left join por_vendedor pv on pv.mes = m.mes and pv.kv = ks.kv
  left join vend vd on vd.kv = ks.kv
  union all
  -- Caja menor por usuario
  select j.mes, 'usuario'::text, j.nombre,
         null::numeric, null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
         round(j.saldo, 2), round(j.ent, 2), round(j.sal, 2)
  from cj j
  order by 1, 2, 3;
end;
$$;

revoke execute on function tiendaariga.cuadre_tiendas(date, date, text) from public, anon;
grant  execute on function tiendaariga.cuadre_tiendas(date, date, text) to authenticated;

notify pgrst, 'reload schema';
