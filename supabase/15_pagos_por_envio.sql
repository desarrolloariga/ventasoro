-- =====================================================================
--  Joyería ARIGA - Actualización 15: PAGOS APLICADOS A ENVÍOS
--  * Cada venta (envío) genera cartera del cliente. Un pago se aplica
--    siempre a uno o varios envíos del cliente (puede quedar parcial).
--    Así el saldo del cliente = suma de los saldos de sus envíos.
--  * Una venta sin número de envío se identifica por su número de pedido.
--  * Los abonos antiguos "al total del cliente" (sin envío) se reparten
--    a sus envíos con saldo, del más antiguo al más reciente. Si sobra,
--    el resto queda como saldo a favor (sin envío).
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 14. Se puede repetir.
-- =====================================================================

-- Envíos de un cliente con su venta, lo pagado (pagos + devoluciones) y el saldo
create or replace function tiendaariga.envios_cliente(p_cliente bigint)
returns table (envio text, fecha date, venta numeric, pagado numeric, saldo numeric)
language sql stable
set search_path = tiendaariga
as $$
  with v as (
    select coalesce(nullif(trim(envio), ''), pedido_id) as k,
           min(fecha_venta) as f, sum(coalesce(valor_total, 0)) as t
    from ventas where cliente_id = p_cliente
    group by 1
  ),
  p as (
    select trim(envio) as k, sum(coalesce(valor_pagado, 0)) as t
    from pagos where cliente_id = p_cliente and coalesce(trim(envio), '') <> ''
    group by 1
  ),
  d as (
    select trim(envio) as k, sum(coalesce(valor, 0)) as t
    from devoluciones where trim(envio) in (select k from v)
    group by 1
  )
  select v.k, v.f, v.t, coalesce(p.t, 0) + coalesce(d.t, 0), v.t - coalesce(p.t, 0) - coalesce(d.t, 0)
  from v left join p on p.k = v.k left join d on d.k = v.k
  where v.k is not null
  order by v.f nulls first, v.k
$$;
grant execute on function tiendaariga.envios_cliente(bigint) to authenticated;

-- Un pago nuevo de un cliente debe indicar a cuál de SUS envíos se aplica
create or replace function tiendaariga.validar_pago_envio()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if auth.uid() is null or new.cliente_id is null then return new; end if;
  if coalesce(trim(new.envio), '') = '' then
    raise exception 'Elija a qué envío del cliente se aplica el pago.';
  end if;
  if not exists (select 1 from ventas
                 where cliente_id = new.cliente_id
                   and coalesce(nullif(trim(envio), ''), pedido_id) = trim(new.envio)) then
    raise exception 'El envío % no pertenece a este cliente.', new.envio;
  end if;
  return new;
end;
$$;
revoke execute on function tiendaariga.validar_pago_envio() from public, anon, authenticated;
drop trigger if exists pagos_validar_envio on tiendaariga.pagos;
create trigger pagos_validar_envio
  before insert on tiendaariga.pagos
  for each row execute function tiendaariga.validar_pago_envio();

-- Cartera por envío: la venta sin envío se identifica por su pedido
create or replace view tiendaariga.cartera_detalle
with (security_invoker = true) as
with v as (
  select coalesce(nullif(trim(envio), ''), pedido_id) as envio,
         min(fecha_venta)      as fecha_venta,
         tienda,
         cliente,
         sum(coalesce(valor_total,0)) as valor_venta,
         max(cliente_id)       as cliente_id
  from tiendaariga.ventas
  where coalesce(nullif(trim(envio), ''), pedido_id) is not null
  group by 1, tienda, cliente
),
p as (select trim(envio) as envio, sum(coalesce(valor_pagado,0)) as total from tiendaariga.pagos group by 1),
d as (select trim(envio) as envio, sum(coalesce(valor,0))        as total from tiendaariga.devoluciones group by 1)
select v.fecha_venta,
       v.tienda,
       v.cliente,
       v.envio,
       v.valor_venta,
       coalesce(p.total,0) + coalesce(d.total,0)                 as valor_pago,
       v.valor_venta - coalesce(p.total,0) - coalesce(d.total,0) as cartera,
       v.cliente_id,
       c.consecutivo,
       coalesce(pf.nombre, pf.usuario)                           as vendedor
from v
left join p on p.envio = v.envio
left join d on d.envio = v.envio
left join tiendaariga.clientes c  on c.id = v.cliente_id
left join tiendaariga.perfiles pf on pf.id = c.creado_por;

-- ---------------------------------------------------------------------
-- Repartir los abonos antiguos sin envío entre los envíos del cliente
-- ---------------------------------------------------------------------
do $$
declare
  pg record; e record;
  resta numeric; aplica numeric; primero boolean;
  n_pagos int := 0; n_nuevos int := 0; n_favor int := 0;
begin
  for pg in
    select * from tiendaariga.pagos
    where cliente_id is not null and coalesce(trim(envio), '') = '' and coalesce(valor_pagado, 0) > 0
    order by fecha_pago nulls first, id
  loop
    resta := pg.valor_pagado;
    primero := true;
    for e in select * from tiendaariga.envios_cliente(pg.cliente_id) where saldo > 0.005 loop
      exit when resta <= 0.005;
      aplica := least(resta, e.saldo);
      if primero then
        update tiendaariga.pagos
           set envio = e.envio, valor_pagado = aplica,
               observaciones = concat_ws(' · ', observaciones, 'Aplicado automáticamente a envíos')
         where id = pg.id;
        primero := false;
        n_pagos := n_pagos + 1;
      else
        insert into tiendaariga.pagos (fecha_pago, envio, factura, metodo_pago, tipo, valor_pagado, boleta,
                                       contabilidad, vendedor, nit, confirmacion, observaciones,
                                       nota_importacion, cliente_id, creado_por, created_at)
        values (pg.fecha_pago, e.envio, pg.factura, pg.metodo_pago, pg.tipo, aplica, pg.boleta,
                pg.contabilidad, pg.vendedor, pg.nit, pg.confirmacion,
                concat_ws(' · ', pg.observaciones, 'Repartido del pago N° ' || pg.id),
                pg.nota_importacion, pg.cliente_id, pg.creado_por, pg.created_at);
        n_nuevos := n_nuevos + 1;
      end if;
      resta := resta - aplica;
    end loop;
    -- Lo que no alcanzó a aplicarse queda como saldo a favor (sin envío)
    if resta > 0.005 then
      n_favor := n_favor + 1;
      if not primero then
        insert into tiendaariga.pagos (fecha_pago, factura, metodo_pago, tipo, valor_pagado, boleta,
                                       contabilidad, vendedor, nit, confirmacion, observaciones,
                                       nota_importacion, cliente_id, creado_por, created_at)
        values (pg.fecha_pago, pg.factura, pg.metodo_pago, pg.tipo, resta, pg.boleta,
                pg.contabilidad, pg.vendedor, pg.nit, pg.confirmacion,
                concat_ws(' · ', pg.observaciones, 'Saldo a favor del pago N° ' || pg.id),
                pg.nota_importacion, pg.cliente_id, pg.creado_por, pg.created_at);
      end if;
    end if;
  end loop;
  raise notice 'Abonos aplicados a envíos: % · Partes nuevas por reparto: % · Con saldo a favor: %', n_pagos, n_nuevos, n_favor;
end $$;

notify pgrst, 'reload schema';

-- Verificación: clientes cuyo saldo no coincide con la suma de sus envíos (debería salir vacío,
-- salvo clientes con saldo a favor)
select c.codigo, c.nombre, c.saldo as saldo_cliente,
       (select coalesce(sum(saldo), 0) from tiendaariga.envios_cliente(c.codigo)) as suma_envios
from tiendaariga.cartera_clientes c
where abs(c.saldo - (select coalesce(sum(saldo), 0) from tiendaariga.envios_cliente(c.codigo))) > 0.005;
