-- =====================================================================
--  Joyería ARIGA - Actualización 34: INTELIGENCIA PARA VENDEDORES
--  * mi_resumen(desde, hasta): lo vendido, lo cobrado y la comisión del
--    vendedor (Maestros > Vendedores) vinculado al usuario que consulta.
--    Solo devuelve datos de ese vendedor.
--      - Vendido: ventas cuyo vendedor es él (sin saldos iniciales).
--      - Cobrado: abonos del periodo a envíos de sus ventas (las ventas de
--        contado van aparte).
--      - Comisión: según sus esquemas (la misma del cuadre), con detalle.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 33. Se puede repetir.
-- =====================================================================

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
    'detalle_comision', (select coalesce(jsonb_agg(jsonb_build_object(
                            'mes', mes, 'esquema', esquema, 'ventas_q', ventas_q, 'meta', meta,
                            'cumplimiento', cumplimiento, 'pct', comision_pct, 'comision', comision) order by mes, esquema), '[]'::jsonb)
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
