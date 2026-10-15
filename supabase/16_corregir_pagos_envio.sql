-- =====================================================================
--  Joyería ARIGA - Actualización 16
--  * Corrige pagos registrados con un envío equivocado:
--    - Pagos escritos con el número de PEDIDO de una venta que sí tiene
--      envío -> se pasan a ese envío (p. ej. LIMNE CASTILLO, pago N° 89).
--    - CELESTE DE LEÓN (9008): sus pagos N° 113 y 114 estaban al envío
--      ELE-000084, que es de YURI ARROYO -> se pasan a su envío ELE-000096.
--  * Cartera por envío: un pago solo cuenta en los envíos de SU cliente.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 15. Se puede repetir.
-- =====================================================================

-- 1) Pago escrito con el número de pedido -> envío de esa venta (mismo cliente)
update tiendaariga.pagos p
   set envio = trim(v.envio),
       observaciones = concat_ws(' · ', p.observaciones, 'Envío corregido (antes: ' || p.envio || ')')
  from tiendaariga.ventas v
 where v.cliente_id = p.cliente_id
   and trim(p.envio) = v.pedido_id
   and coalesce(trim(v.envio), '') <> ''
   and trim(p.envio) <> trim(v.envio);

-- 2) CELESTE DE LEÓN: pagos al envío de otra clienta
update tiendaariga.pagos
   set envio = 'ELE-000096',
       observaciones = concat_ws(' · ', observaciones, 'Envío corregido (antes: ELE-000084)')
 where id in (113, 114) and cliente_id = 9008 and envio = 'ELE-000084';

-- 3) Cartera por envío: pagos del mismo cliente (o pagos antiguos sin cliente)
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
p as (select trim(envio) as envio, cliente_id, sum(coalesce(valor_pagado,0)) as total
      from tiendaariga.pagos group by 1, 2),
d as (select trim(envio) as envio, sum(coalesce(valor,0)) as total from tiendaariga.devoluciones group by 1)
select v.fecha_venta,
       v.tienda,
       v.cliente,
       v.envio,
       v.valor_venta,
       coalesce(pp.total,0) + coalesce(d.total,0)                 as valor_pago,
       v.valor_venta - coalesce(pp.total,0) - coalesce(d.total,0) as cartera,
       v.cliente_id,
       c.consecutivo,
       coalesce(pf.nombre, pf.usuario)                            as vendedor
from v
left join lateral (select sum(p.total) as total from p
                   where p.envio = v.envio
                     and (p.cliente_id is not distinct from v.cliente_id or p.cliente_id is null)) pp on true
left join d on d.envio = v.envio
left join tiendaariga.clientes c  on c.id = v.cliente_id
left join tiendaariga.perfiles pf on pf.id = c.creado_por;

notify pgrst, 'reload schema';

-- Verificación: pagos cuyo envío no es de su cliente (debería salir vacío)
select p.id, p.cliente_id, p.envio, p.valor_pagado
from tiendaariga.pagos p
where p.cliente_id is not null and coalesce(trim(p.envio), '') <> ''
  and not exists (select 1 from tiendaariga.ventas v
                  where v.cliente_id = p.cliente_id
                    and coalesce(nullif(trim(v.envio), ''), v.pedido_id) = trim(p.envio));
