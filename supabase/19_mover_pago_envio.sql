-- =====================================================================
--  Joyería ARIGA - Actualización 19: MOVER UN PAGO A OTRO ENVÍO
--  * mover_pago(pago, envío, valor): pasa un pago (o una parte de él) a otro
--    envío del mismo cliente. Lo hace el dueño del cliente o el admin.
--    El envío destino no puede quedar pagado de más.
--  * Corrige los abonos repartidos automáticamente (script 15) cuyo valor
--    coincide EXACTO con el de un envío del cliente: se aplican completos a
--    ese envío (p. ej. DAILI HERRERA Q2,708.30 -> envío 003231;
--    DORIS ELISABETH Q720 -> envío 3424).
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 18. Se puede repetir.
-- =====================================================================

create or replace function tiendaariga.mover_pago(p_pago bigint, p_envio text, p_valor numeric default null)
returns void
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  pg      pagos;
  c       clientes;
  v_valor numeric;
  v_saldo numeric;
begin
  select * into pg from pagos where id = p_pago;
  if not found then raise exception 'El pago % no existe.', p_pago; end if;
  if pg.cliente_id is null then raise exception 'El pago no tiene cliente.'; end if;
  select * into c from clientes where id = pg.cliente_id;
  if not (es_admin() or (usuario_activo() and c.creado_por = auth.uid())) then
    raise exception 'Solo el dueño del cliente o un administrador puede mover sus pagos.';
  end if;
  if trim(coalesce(p_envio, '')) = '' or trim(p_envio) = trim(coalesce(pg.envio, '')) then
    raise exception 'Elija un envío distinto al actual.';
  end if;
  v_valor := round(coalesce(p_valor, pg.valor_pagado), 2);
  if v_valor <= 0 or v_valor > pg.valor_pagado + 0.005 then
    raise exception 'El valor a mover debe ser mayor que 0 y no mayor que el pago (Q%).', pg.valor_pagado;
  end if;
  select saldo into v_saldo from envios_cliente(pg.cliente_id) where envio = trim(p_envio);
  if v_saldo is null then
    raise exception 'El envío % no pertenece a este cliente.', p_envio;
  end if;
  if v_valor > v_saldo + 0.005 then
    raise exception 'El envío % solo debe Q%; no se le pueden aplicar Q%.', p_envio, v_saldo, v_valor;
  end if;

  if v_valor >= pg.valor_pagado - 0.005 then
    update pagos set envio = trim(p_envio),
           observaciones = concat_ws(' · ', observaciones, 'Movido desde envío ' || coalesce(pg.envio, '(sin envío)'))
     where id = pg.id;
  else
    update pagos set valor_pagado = valor_pagado - v_valor where id = pg.id;
    insert into pagos (fecha_pago, envio, factura, metodo_pago, tipo, valor_pagado, boleta, contabilidad,
                       vendedor, nit, confirmacion, observaciones, nota_importacion, cliente_id, creado_por, created_at)
    values (pg.fecha_pago, trim(p_envio), pg.factura, pg.metodo_pago, pg.tipo, v_valor, pg.boleta, pg.contabilidad,
            pg.vendedor, pg.nit, pg.confirmacion,
            concat_ws(' · ', pg.observaciones, 'Separado del pago N° ' || pg.id || ' (envío ' || coalesce(pg.envio, '-') || ')'),
            pg.nota_importacion, pg.cliente_id, pg.creado_por, pg.created_at);
  end if;
end;
$$;
revoke execute on function tiendaariga.mover_pago(bigint, text, numeric) from public, anon;
grant  execute on function tiendaariga.mover_pago(bigint, text, numeric) to authenticated;

-- ---------------------------------------------------------------------
-- Abonos repartidos automáticamente cuyo valor total = valor exacto de un envío
-- ---------------------------------------------------------------------
do $$
declare
  o record; k text; n int := 0;
begin
  for o in
    with partes as (
      select coalesce(substring(observaciones from '(?:Repartido del|Saldo a favor del) pago N° (\d+)')::bigint, id) as original,
             id, cliente_id, envio, valor_pagado
      from tiendaariga.pagos
      where observaciones like '%Aplicado automáticamente a envíos%'
         or observaciones ~ '(Repartido del|Saldo a favor del) pago N° \d+'
    )
    select original, min(cliente_id) as cliente_id, round(sum(valor_pagado), 2) as total,
           array_agg(id) as ids, array_agg(distinct envio) as envios
    from partes group by original
    having count(*) > 1
  loop
    -- Envío del cliente cuyo valor es exactamente el del pago (si hay uno solo)
    select min(e.envio) into k
    from tiendaariga.envios_cliente(o.cliente_id) e
    where abs(round(e.venta, 2) - o.total) < 0.005
    having count(*) = 1;
    continue when k is null;
    -- Debe poder recibirlo completo (su saldo + lo que ya le aplicaron estas partes)
    continue when (select e.saldo from tiendaariga.envios_cliente(o.cliente_id) e where e.envio = k)
                  + coalesce((select sum(valor_pagado) from tiendaariga.pagos where id = any(o.ids) and envio = k), 0)
                  < o.total - 0.005;
    delete from tiendaariga.pagos where id = any(o.ids) and id <> o.original;
    update tiendaariga.pagos
       set envio = k, valor_pagado = o.total,
           observaciones = replace(observaciones, 'Aplicado automáticamente a envíos', 'Aplicado al envío ' || k || ' (valor exacto)')
     where id = o.original;
    n := n + 1;
  end loop;
  raise notice 'Pagos reasignados a su envío exacto: %', n;
end $$;

notify pgrst, 'reload schema';
