-- =====================================================================
--  Joyería ARIGA - Actualización 30: LISTADO DE PEDIDOS Y MÓDULO DE DEVOLUCIONES
--  * listar_pedidos: todos los pedidos/facturas (sin escribir nada se listan
--    todos), con filtro opcional por texto y fechas, paginado, con el total
--    de filas y lo ya devuelto de cada pedido. Respeta los permisos: cada
--    vendedor ve solo lo suyo (y el supervisor lo de su equipo).
--  * listar_devoluciones: devoluciones registradas con cliente, vendedor y factura.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 29. Se puede repetir.
-- =====================================================================

drop function if exists tiendaariga.listar_pedidos(text, text, date, date, int, int);
create function tiendaariga.listar_pedidos(p_termino text default '', p_campo text default 'todo',
                                           p_desde date default null, p_hasta date default null,
                                           p_limite int default 1000, p_offset int default 0)
returns table (clave text, pedido_id text, envio text, factura text, fecha_venta date, cliente_id bigint,
               cliente text, tienda text, vendedor text, total numeric, devuelto numeric, lineas bigint, total_filas bigint)
language sql stable
set search_path = tiendaariga
as $$
  with t as (select lower(trim(coalesce(p_termino, ''))) as q, coalesce(nullif(p_campo, ''), 'todo') as campo),
  p as (
    select clave_pedido(v.envio, v.pedido_id) as clave, v.pedido_id, v.envio,
           max(v.factura) as factura, min(v.fecha_venta) as fecha_venta,
           max(v.cliente_id) as cliente_id, max(coalesce(c.nombre, v.cliente)) as cliente,
           max(v.tienda) as tienda, max(v.vendedor) as vendedor,
           sum(coalesce(v.valor_total, 0)) as total, count(*) as lineas
    from ventas v
    left join clientes c on c.id = v.cliente_id
    cross join t
    where (p_desde is null or v.fecha_venta >= p_desde)
      and (p_hasta is null or v.fecha_venta <= p_hasta)
      and (t.q = '' or case t.campo
          when 'cliente' then lower(coalesce(c.nombre, v.cliente, '')) like '%' || t.q || '%'
          when 'codigo'  then v.cliente_id::text = t.q
                           or (c.consecutivo::text = t.q and c.creado_por = auth.uid())
          when 'pedido'  then lower(coalesce(v.pedido_id, '')) like '%' || t.q || '%'
          when 'envio'   then lower(coalesce(v.envio, '')) like '%' || t.q || '%'
          when 'factura' then lower(coalesce(v.factura, '')) like '%' || t.q || '%'
          else lower(coalesce(c.nombre, v.cliente, '')) like '%' || t.q || '%'
            or v.cliente_id::text = t.q
            or (c.consecutivo::text = t.q and c.creado_por = auth.uid())
            or lower(coalesce(v.pedido_id, '')) like '%' || t.q || '%'
            or lower(coalesce(v.envio, '')) like '%' || t.q || '%'
            or lower(coalesce(v.factura, '')) like '%' || t.q || '%'
        end)
    group by 1, 2, 3
  ),
  d as (select trim(envio) as clave, sum(coalesce(valor, 0)) as devuelto from devoluciones group by 1)
  select p.clave, p.pedido_id, p.envio, p.factura, p.fecha_venta, p.cliente_id, p.cliente, p.tienda, p.vendedor,
         p.total, coalesce(d.devuelto, 0), p.lineas, count(*) over ()
  from p left join d on d.clave = p.clave
  order by p.fecha_venta desc nulls last, p.pedido_id desc
  limit greatest(coalesce(p_limite, 1000), 1) offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists tiendaariga.listar_devoluciones(date, date);
create function tiendaariga.listar_devoluciones(p_desde date default null, p_hasta date default null)
returns table (id bigint, fecha_devolucion date, clave text, pedido_id text, factura text, cliente_id bigint, cliente text,
               tienda text, vendedor text, producto text, cantidad numeric, valor numeric, motivo text,
               creado_por uuid, registrado_por text)
language sql stable
set search_path = tiendaariga
as $$
  select d.id, d.fecha_devolucion, d.envio, d.pedido_id, d.factura, coalesce(d.cliente_id, x.cliente_id),
         coalesce(c.nombre, x.cliente), d.tienda, x.vendedor, d.producto, d.gramos, d.valor, d.motivo,
         d.creado_por, u.nombre
  from devoluciones d
  left join lateral (select v.cliente_id, v.cliente, v.vendedor from ventas v
                     where clave_pedido(v.envio, v.pedido_id) = trim(d.envio) limit 1) x on true
  left join clientes c on c.id = coalesce(d.cliente_id, x.cliente_id)
  left join perfiles u on u.id = d.creado_por
  where (p_desde is null or d.fecha_devolucion >= p_desde)
    and (p_hasta is null or d.fecha_devolucion <= p_hasta)
  order by d.fecha_devolucion desc nulls last, d.id desc;
$$;

revoke execute on function tiendaariga.listar_pedidos(text, text, date, date, int, int) from public, anon;
revoke execute on function tiendaariga.listar_devoluciones(date, date)                  from public, anon;
grant  execute on function tiendaariga.listar_pedidos(text, text, date, date, int, int) to authenticated;
grant  execute on function tiendaariga.listar_devoluciones(date, date)                  to authenticated;

notify pgrst, 'reload schema';
