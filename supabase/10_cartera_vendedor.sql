-- =====================================================================
--  Joyería ARIGA - Actualización 10
--  * Cartera: cada cliente y cada envío muestran su vendedor (el dueño del
--    cliente) y el código del cliente, para verlo y ordenar por código.
--    Las columnas nuevas van al final, así que no cambia nada de lo existente.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 09. Se puede repetir.
-- =====================================================================

create or replace view tiendaariga.cartera_clientes
with (security_invoker = true) as
select c.id as codigo, c.nombre, c.dpi, c.nit, c.telefono,
       coalesce(m.cargos,0)                     as total_ventas,
       coalesce(m.abonos,0)                     as total_pagos,
       coalesce(m.cargos,0) - coalesce(m.abonos,0) as saldo,
       m.ultima_venta, m.ultimo_pago,
       c.consecutivo,
       c.creado_por                             as vendedor_id,
       coalesce(pf.nombre, pf.usuario)          as vendedor
from tiendaariga.clientes c
left join tiendaariga.perfiles pf on pf.id = c.creado_por
left join (
  select cliente_id, sum(cargo) as cargos, sum(abono) as abonos,
         max(fecha) filter (where movimiento = 'VENTA') as ultima_venta,
         max(fecha) filter (where movimiento = 'PAGO')  as ultimo_pago
  from tiendaariga.estado_cuenta
  group by cliente_id
) m on m.cliente_id = c.id;

create or replace view tiendaariga.cartera_detalle
with (security_invoker = true) as
with v as (
  select envio,
         min(fecha_venta)      as fecha_venta,
         tienda,
         cliente,
         sum(coalesce(valor_total,0)) as valor_venta,
         max(cliente_id)       as cliente_id
  from tiendaariga.ventas
  where coalesce(trim(envio),'') <> ''
  group by envio, tienda, cliente
),
p as (select envio, sum(coalesce(valor_pagado,0)) as total from tiendaariga.pagos group by envio),
d as (select envio, sum(coalesce(valor,0))        as total from tiendaariga.devoluciones group by envio)
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

notify pgrst, 'reload schema';
