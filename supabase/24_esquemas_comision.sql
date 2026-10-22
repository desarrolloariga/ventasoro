-- =====================================================================
--  Joyería ARIGA - Actualización 24: ESQUEMAS DE COMISIÓN POR CUMPLIMIENTO
--  * esquemas_comision: tramos de % de pago según el cumplimiento de meta,
--    individual (sobre sus ventas y su meta) o grupal (sobre las ventas y
--    la meta de su grupo: ella + quienes la tienen como supervisora), y un
--    % fijo para las ventas a clientes MAYORISTAS (mayoreo).
--  * Vendedores (Maestros): esquema asignado y supervisor(a).
--    Sin esquema se sigue usando el % fijo de comisión.
--  * Se crean los esquemas "EJECUTIVA DE VENTA" y "SUPERVISORA RS" con la
--    matriz entregada (se pueden editar después).
--  * cuadre_tiendas calcula la comisión de cada persona con su esquema.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 23. Se puede repetir.
-- =====================================================================

create table if not exists tiendaariga.esquemas_comision (
  id           bigint generated always as identity primary key,
  nombre       text not null unique,
  tipo         text not null default 'INDIVIDUAL' check (tipo in ('INDIVIDUAL', 'GRUPAL')),
  tramos       jsonb not null default '[]'::jsonb,       -- [{"desde": 0, "pct": 1.0}, ...] (desde = % de cumplimiento)
  pct_mayoreo  numeric(6,2) not null default 0 check (pct_mayoreo between 0 and 100),
  activo       boolean not null default true,
  orden        int not null default 0,
  created_at   timestamptz not null default now()
);

alter table tiendaariga.vendedores add column if not exists esquema_id bigint
  references tiendaariga.esquemas_comision(id) on delete set null;
alter table tiendaariga.vendedores add column if not exists supervisor text;   -- nombre de otro vendedor (Maestros)

insert into tiendaariga.esquemas_comision (nombre, tipo, tramos, pct_mayoreo, orden) values
  ('EJECUTIVA DE VENTA', 'INDIVIDUAL',
   '[{"desde":0,"pct":1.0},{"desde":34,"pct":1.5},{"desde":68,"pct":2.5},{"desde":96,"pct":3.5}]', 1.0, 1),
  ('SUPERVISORA RS', 'GRUPAL',
   '[{"desde":0,"pct":0.5},{"desde":70,"pct":1.0},{"desde":101,"pct":1.2}]', 0.5, 2)
on conflict (nombre) do nothing;

-- Esquemas: todos los ven, solo el administrador los modifica
alter table tiendaariga.esquemas_comision enable row level security;
grant select, insert, update, delete on tiendaariga.esquemas_comision to authenticated;
drop policy if exists "esquemas_ver" on tiendaariga.esquemas_comision;
create policy "esquemas_ver" on tiendaariga.esquemas_comision for select to authenticated
  using ((select tiendaariga.usuario_activo()));
drop policy if exists "esquemas_admin" on tiendaariga.esquemas_comision;
create policy "esquemas_admin" on tiendaariga.esquemas_comision for all to authenticated
  using ((select tiendaariga.es_admin())) with check ((select tiendaariga.es_admin()));

-- Comisión, meta, esquema y supervisor(a) de un vendedor: solo el administrador
create or replace function tiendaariga.proteger_parametros_vendedor()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if auth.uid() is not null and not es_admin()
     and (new.comision_pct is distinct from coalesce(old.comision_pct, 0)
          or new.meta_mensual is distinct from coalesce(old.meta_mensual, 0)
          or new.esquema_id is distinct from old.esquema_id
          or new.supervisor is distinct from old.supervisor) then
    raise exception 'Solo el administrador puede cambiar la comisión, la meta, el esquema y el supervisor de los vendedores.';
  end if;
  return new;
end;
$$;

-- Si se renombra un vendedor, quienes lo tienen de supervisor lo siguen
create or replace function tiendaariga.seguir_supervisor_renombrado()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if new.nombre <> old.nombre then
    update vendedores set supervisor = new.nombre where supervisor = old.nombre;
  end if;
  return new;
end;
$$;
revoke execute on function tiendaariga.seguir_supervisor_renombrado() from public, anon, authenticated;
drop trigger if exists vendedores_seguir_supervisor on tiendaariga.vendedores;
create trigger vendedores_seguir_supervisor
  after update of nombre on tiendaariga.vendedores
  for each row execute function tiendaariga.seguir_supervisor_renombrado();

-- ---------------------------------------------------------------------
-- Cuadre de tiendas con la comisión por esquema
-- ---------------------------------------------------------------------
drop function if exists tiendaariga.cuadre_tiendas(date, date, text);
create function tiendaariga.cuadre_tiendas(p_desde date, p_hasta date, p_tienda text default null)
returns table (mes date, dimension text, clave text,
               cartera numeric, inventario_gr numeric, ventas_gr numeric, ventas_q numeric,
               comision numeric, meta numeric,
               caja numeric, caja_entradas numeric, caja_salidas numeric,
               recaudo numeric, recaudo_efectivo numeric,
               comision_pct numeric, cumplimiento numeric, esquema text)
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
           case when pr.unidad = 'GRAMOS' then coalesce(v.cantidad, 0) else 0 end as gr,
           coalesce(cl.tipo_cliente, '') = 'MAYORISTA' as mayoreo
    from ventas v
    left join productos pr on upper(trim(pr.nombre)) = upper(trim(v.producto))
    left join clientes cl on cl.id = v.cliente_id
    where upper(trim(coalesce(v.producto, ''))) <> 'SALDO INICIAL'
      and v.fecha_venta between (select min(mes) from meses) and (select max(fin) from meses)
      and ((select kt from filtro) is null or upper(trim(v.tienda)) = (select kt from filtro))
  ),
  vend as (select upper(trim(nombre)) as kv, comision_pct, meta_mensual, activo, esquema_id,
                  upper(trim(nullif(supervisor, ''))) as ksup from vendedores),
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
  por_vendedor as (
    select x.mes, x.kv, sum(x.gr) as gr, sum(x.q) as q, coalesce(sum(x.q) filter (where x.mayoreo), 0) as qm
    from vt x group by 1, 2
  ),
  -- Vendedores del mes: los que vendieron y, sin filtro de tienda, los que tienen meta
  base as (
    select m.mes, ks.kv, coalesce(pv.gr, 0) as gr, coalesce(pv.q, 0) as q, coalesce(pv.qm, 0) as qm,
           coalesce(vd.meta_mensual, 0) as meta, coalesce(vd.comision_pct, 0) as pct_fijo,
           vd.esquema_id, vd.ksup
    from meses m
    cross join lateral (
      select kv from por_vendedor where por_vendedor.mes = m.mes
      union
      select kv from vend where activo and (meta_mensual > 0 or esquema_id is not null) and (select kt from filtro) is null
      union   -- supervisores(as) de quienes vendieron, aunque ellas no vendieran
      select v2.ksup from vend v2 join por_vendedor p2 on p2.kv = v2.kv and p2.mes = m.mes where v2.ksup is not null
    ) ks
    left join por_vendedor pv on pv.mes = m.mes and pv.kv = ks.kv
    left join vend vd on vd.kv = ks.kv
  ),
  -- Grupo de cada persona: ella misma y quienes la tienen como supervisora
  grupo as (
    select b.mes, b.kv, sum(t.q) as q, sum(t.qm) as qm, sum(t.meta) as meta
    from base b join base t on t.mes = b.mes and (t.kv = b.kv or t.ksup = b.kv)
    group by 1, 2
  ),
  evalua as (
    select b.*, e.nombre as esquema, e.tipo, e.tramos, coalesce(e.pct_mayoreo, 0) as pct_mayoreo,
           case when e.tipo = 'GRUPAL' then g.q  else b.q  end as q_eval,
           case when e.tipo = 'GRUPAL' then g.qm else b.qm end as qm_eval,
           case when e.tipo = 'GRUPAL' then (case when b.meta > 0 then b.meta else g.meta end) else b.meta end as meta_eval
    from base b
    left join esquemas_comision e on e.id = b.esquema_id and e.activo
    left join grupo g on g.mes = b.mes and g.kv = b.kv
  ),
  tramo as (
    select ev.*,
           case when ev.meta_eval > 0 then ev.q_eval / ev.meta_eval * 100 end as cumpl,
           case when ev.tipo is null then ev.pct_fijo
                else coalesce((select (tr->>'pct')::numeric from jsonb_array_elements(ev.tramos) tr
                               where (tr->>'desde')::numeric <= coalesce(floor(ev.q_eval / nullif(ev.meta_eval, 0) * 100), 0)
                               order by (tr->>'desde')::numeric desc limit 1), 0) end as pct
    from evalua ev
  )
  select t.mes, 'tienda'::text, t.kt,
         round(sum(t.cartera), 2), round(sum(t.inv), 2), round(sum(t.gr), 2), round(sum(t.q), 2),
         round(sum(t.com), 2), null::numeric,
         round(sum(t.caja), 2), round(sum(t.ent), 2), round(sum(t.sal), 2),
         round(sum(t.rec), 2), round(coalesce(sum(t.rec_ef), 0), 2),
         null::numeric, null::numeric, null::text
  from por_tienda t group by t.mes, t.kt
  union all
  -- Vendedores: ventas, meta y comisión según su esquema
  --   sin esquema: venta x % fijo
  --   con esquema: (venta - mayoreo) x % del tramo de cumplimiento + mayoreo x % de mayoreo
  --   esquema grupal: sobre las ventas y la meta de su grupo
  select t.mes, 'vendedor'::text, t.kv,
         null::numeric, null::numeric, round(t.gr, 2), round(t.q, 2),
         round(case when t.tipo is null then t.q * t.pct / 100
                    else (t.q_eval - t.qm_eval) * t.pct / 100 + t.qm_eval * t.pct_mayoreo / 100 end, 2),
         t.meta,
         null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
         t.pct, round(t.cumpl, 1), coalesce(t.esquema, case when t.pct > 0 then 'FIJO' end)
  from tramo t
  union all
  -- Caja menor por usuario
  select j.mes, 'usuario'::text, j.nombre,
         null::numeric, null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
         round(j.saldo, 2), round(j.ent, 2), round(j.sal, 2), null::numeric, null::numeric,
         null::numeric, null::numeric, null::text
  from cj j
  union all
  -- Recaudo por método de pago
  select r.mes, 'metodo'::text, r.km,
         null::numeric, null::numeric, null::numeric, null::numeric, null::numeric, null::numeric,
         null::numeric, null::numeric, null::numeric,
         round(sum(r.t), 2), round(coalesce(sum(r.t) filter (where r.de_venta_efectivo), 0), 2),
         null::numeric, null::numeric, null::text
  from recf r group by r.mes, r.km
  order by 1, 2, 3;
end;
$$;

revoke execute on function tiendaariga.cuadre_tiendas(date, date, text) from public, anon;
grant  execute on function tiendaariga.cuadre_tiendas(date, date, text) to authenticated;

notify pgrst, 'reload schema';
