-- =====================================================================
--  Joyería ARIGA - Actualización 33: LOS PAGOS SIGUEN AL ENVÍO DEL PEDIDO
--  * Problema: al editar un pedido y ponerle (o cambiarle) el número de
--    envío, sus pagos y devoluciones se quedaban con el número anterior.
--    El envío aparecía sin pagar aunque el cliente sí pagó, y el recaudo
--    por tienda no los contaba.
--  * Ahora actualizar_venta mueve los pagos y devoluciones al número nuevo.
--  * Corrige los pagos que ya habían quedado sueltos:
--      1. apuntan al N° de pedido de una venta que hoy tiene envío;
--      2. apuntan a un envío que no existe y el cliente tiene UN solo envío
--         pendiente por exactamente el mismo valor (error al digitar).
--    Los demás se dejan para revisión (se listan al final).
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 32. Se puede repetir.
-- =====================================================================

-- Mueve pagos y devoluciones de un número de pedido/envío a otro
create or replace function tiendaariga.mover_clave_pedido(p_vieja text, p_nueva text, p_cliente bigint)
returns int
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare n int := 0; m int;
begin
  if coalesce(trim(p_vieja), '') = '' or coalesce(trim(p_nueva), '') = '' or trim(p_vieja) = trim(p_nueva) then return 0; end if;
  if not puede_devolver(p_nueva) then return 0; end if;
  -- Solo si el número anterior ya no existe en ninguna venta
  if exists (select 1 from ventas where clave_pedido(envio, pedido_id) = trim(p_vieja)) then return 0; end if;
  update pagos set envio = trim(p_nueva)
   where trim(envio) = trim(p_vieja) and (cliente_id is null or p_cliente is null or cliente_id = p_cliente);
  get diagnostics m = row_count; n := n + m;
  update devoluciones set envio = trim(p_nueva)
   where trim(envio) = trim(p_vieja) and (cliente_id is null or p_cliente is null or cliente_id = p_cliente);
  get diagnostics m = row_count; n := n + m;
  return n;
end;
$$;
revoke execute on function tiendaariga.mover_clave_pedido(text, text, bigint) from public, anon;
grant  execute on function tiendaariga.mover_clave_pedido(text, text, bigint) to authenticated;

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
  v_fp_ant  text;
  h         jsonb := p_venta->'header';
  s         jsonb := p_venta->'summary';
  v_fp      text;
  v_nueva   text;
  v_movidos int := 0;
begin
  select pedido_id, fecha_venta, fecha_vencimiento, cliente_id, forma_pago
    into v_pedido, v_fecha, v_vence, v_cliente, v_fp_ant
  from ventas where clave_pedido(envio, pedido_id) = trim(p_envio)
  order by id limit 1;

  if not found then
    raise exception 'No se encontró el pedido para actualizar.';
  end if;
  if jsonb_array_length(coalesce(p_venta->'productLines','[]'::jsonb)) = 0 then
    raise exception 'La venta no tiene productos';
  end if;
  v_fp := coalesce(nullif(upper(trim(s->>'formaPago')), ''), v_fp_ant, 'CREDITO');
  if v_fp = 'EFECTIVO' and coalesce(nullif(h->>'clienteId','')::bigint, v_cliente) is null then
    raise exception 'Una venta en efectivo debe tener cliente.';
  end if;

  delete from ventas where clave_pedido(envio, pedido_id) = trim(p_envio);

  insert into ventas (pedido_id, fecha_venta, fecha_vencimiento, tienda, vendedor,
                      cliente_id, cliente, documento_cliente, factura, envio,
                      tipo, producto, cantidad, valor_unitario, valor_total, forma_pago)
  select coalesce(nullif(h->>'pedidoId',''), v_pedido), v_fecha, v_vence,
         h->>'tienda', h->>'vendedor', coalesce(nullif(h->>'clienteId','')::bigint, v_cliente),
         h->>'clienteNombre', nullif(h->>'clienteDPI',''),
         nullif(s->>'factura',''), nullif(trim(s->>'envio'),''),
         l->>'tipo', l->>'producto',
         nullif(l->>'cantidad','')::numeric,
         nullif(l->>'valorUnitario','')::numeric,
         nullif(l->>'valorTotal','')::numeric,
         v_fp
  from jsonb_array_elements(p_venta->'productLines') l;

  -- Si cambió el número del pedido (se le puso o cambió el envío), los pagos y devoluciones lo siguen
  v_nueva := clave_pedido(nullif(trim(s->>'envio'),''), coalesce(nullif(h->>'pedidoId',''), v_pedido));
  if v_nueva is distinct from trim(p_envio) then
    v_movidos := mover_clave_pedido(trim(p_envio), v_nueva, coalesce(nullif(h->>'clienteId','')::bigint, v_cliente));
  end if;

  return format('Pedido %s actualizado correctamente.%s', v_nueva,
                case when v_movidos > 0 then format(' %s pago(s)/devolución(es) pasaron al envío %s.', v_movidos, v_nueva) else '' end);
end;
$$;

-- ---------------------------------------------------------------------
-- Corrección de los pagos que ya habían quedado sueltos
-- ---------------------------------------------------------------------
do $$
declare n1 int; n2 int; n3 int;
begin
  -- 1. Apuntan al número de pedido de una venta (del mismo cliente) que hoy tiene envío
  update tiendaariga.pagos p
     set envio = x.envio
    from (select distinct on (v.pedido_id, v.cliente_id) v.pedido_id, v.cliente_id, trim(v.envio) as envio
            from tiendaariga.ventas v
           where nullif(trim(v.envio), '') is not null and v.pedido_id is not null
           order by v.pedido_id, v.cliente_id, v.id) x
   where trim(p.envio) = x.pedido_id
     and p.cliente_id is not distinct from x.cliente_id
     and not exists (select 1 from tiendaariga.ventas v2 where tiendaariga.clave_pedido(v2.envio, v2.pedido_id) = trim(p.envio));
  get diagnostics n1 = row_count;

  update tiendaariga.devoluciones d
     set envio = x.envio
    from (select distinct on (v.pedido_id) v.pedido_id, trim(v.envio) as envio
            from tiendaariga.ventas v
           where nullif(trim(v.envio), '') is not null and v.pedido_id is not null
           order by v.pedido_id, v.id) x
   where trim(d.envio) = x.pedido_id
     and not exists (select 1 from tiendaariga.ventas v2 where tiendaariga.clave_pedido(v2.envio, v2.pedido_id) = trim(d.envio));
  get diagnostics n3 = row_count;

  -- 2. Envío inexistente y el cliente tiene un solo envío pendiente por exactamente ese valor
  update tiendaariga.pagos p
     set envio = c.envio
    from (select pg.id, (array_agg(e.envio))[1] as envio
            from tiendaariga.pagos pg
            cross join lateral tiendaariga.envios_cliente(pg.cliente_id) e
           where pg.cliente_id is not null and coalesce(trim(pg.envio), '') <> ''
             and not exists (select 1 from tiendaariga.ventas v where tiendaariga.clave_pedido(v.envio, v.pedido_id) = trim(pg.envio))
             and e.saldo > 0.005
             -- ningún otro pago suelto del cliente por el mismo valor
             and not exists (select 1 from tiendaariga.pagos o
                              where o.cliente_id = pg.cliente_id and o.id <> pg.id and abs(o.valor_pagado - pg.valor_pagado) < 0.01
                                and not exists (select 1 from tiendaariga.ventas v where tiendaariga.clave_pedido(v.envio, v.pedido_id) = trim(o.envio)))
           group by pg.id, pg.valor_pagado
          having count(*) filter (where abs(e.saldo - pg.valor_pagado) < 0.01) = 1
             and count(*) = 1) c
   where p.id = c.id;
  get diagnostics n2 = row_count;

  raise notice 'Pagos movidos al envío de su pedido: % · por envío mal digitado: % · devoluciones: %', n1, n2, n3;
end $$;

notify pgrst, 'reload schema';

-- Pagos que siguen apuntando a un envío inexistente (revisar a mano en Pagos > Mover pago)
select p.id, p.fecha_pago, p.cliente_id, c.nombre as cliente, p.envio as envio_inexistente, p.valor_pagado, p.metodo_pago
from tiendaariga.pagos p
left join tiendaariga.clientes c on c.id = p.cliente_id
where coalesce(trim(p.envio), '') <> ''
  and not exists (select 1 from tiendaariga.ventas v where tiendaariga.clave_pedido(v.envio, v.pedido_id) = trim(p.envio))
order by p.fecha_pago;
