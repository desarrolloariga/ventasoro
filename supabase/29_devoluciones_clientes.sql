-- =====================================================================
--  Joyería ARIGA - Actualización 29: DEVOLUCIONES DE CLIENTES
--  * registrar_devolucion(pedido/envío, fecha, motivo, líneas): devuelve
--    cantidad y valor de los productos de un pedido (total o parcial, sin
--    pasar de lo vendido). La devolución:
--      - reduce la cuenta por cobrar del cliente en ese envío, y
--      - regresa la cantidad al inventario de la tienda de la venta
--        (entrada "DEVOLUCIÓN DE CLIENTE"; los servicios no mueven inventario).
--  * eliminar_devolucion(id): revierte las dos cosas.
--  * Lo hace el administrador o el dueño del cliente / quien registró la venta.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 28. Se puede repetir.
-- =====================================================================

alter table tiendaariga.devoluciones add column if not exists cliente_id bigint;
alter table tiendaariga.ingresos_inventario add column if not exists devolucion_id bigint
  references tiendaariga.devoluciones(id) on delete cascade;
create index if not exists ingresos_devolucion_idx on tiendaariga.ingresos_inventario (devolucion_id);

-- El dueño del cliente también ve las devoluciones de sus clientes
drop policy if exists "devoluciones_cliente" on tiendaariga.devoluciones;
create policy "devoluciones_cliente" on tiendaariga.devoluciones for select to authenticated
  using (tiendaariga.cliente_propio(cliente_id) or tiendaariga.cliente_de_mi_equipo(cliente_id));

-- La entrada de inventario de una devolución solo se cambia desde la devolución
create or replace function tiendaariga.proteger_movimiento_devolucion()
returns trigger
language plpgsql
as $$
begin
  if old.devolucion_id is not null and coalesce(current_setting('tiendaariga.devolucion', true), '') <> 'si' then
    raise exception 'Este movimiento es de la devolución N° %. Elimínela desde el pedido (Devolución).', old.devolucion_id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists ingresos_proteger_devolucion on tiendaariga.ingresos_inventario;
create trigger ingresos_proteger_devolucion
  before update or delete on tiendaariga.ingresos_inventario
  for each row execute function tiendaariga.proteger_movimiento_devolucion();

-- Devolución -> entrada de inventario (si el producto lleva inventario)
create or replace function tiendaariga.sincronizar_devolucion_inventario()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare v_controla boolean;
begin
  perform set_config('tiendaariga.devolucion', 'si', true);
  if tg_op = 'DELETE' then
    delete from ingresos_inventario where devolucion_id = old.id;
    return old;
  end if;
  select controla_inventario into v_controla from productos where upper(trim(nombre)) = upper(trim(new.producto));
  if coalesce(v_controla, false) and coalesce(new.gramos, 0) > 0 and coalesce(trim(new.tienda), '') <> '' then
    update ingresos_inventario
       set fecha = coalesce(new.fecha_devolucion, fecha), tienda = new.tienda, producto = new.producto, entrada = new.gramos,
           observaciones = concat_ws(' · ', 'Pedido ' || new.pedido_id, 'Envío ' || new.envio, new.motivo)
     where devolucion_id = new.id;
    if not found then
      insert into ingresos_inventario (fecha, tienda, producto, concepto, entrada, observaciones, devolucion_id, creado_por)
      values (coalesce(new.fecha_devolucion, (now() at time zone 'America/Guatemala')::date), new.tienda, new.producto,
              'DEVOLUCIÓN DE CLIENTE', new.gramos,
              concat_ws(' · ', 'Pedido ' || new.pedido_id, 'Envío ' || new.envio, new.motivo), new.id, new.creado_por);
    end if;
  else
    delete from ingresos_inventario where devolucion_id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function tiendaariga.sincronizar_devolucion_inventario() from public, anon, authenticated;
drop trigger if exists devoluciones_inventario_del on tiendaariga.devoluciones;
create trigger devoluciones_inventario_del
  before delete on tiendaariga.devoluciones
  for each row execute function tiendaariga.sincronizar_devolucion_inventario();
drop trigger if exists devoluciones_inventario on tiendaariga.devoluciones;
create trigger devoluciones_inventario
  after insert or update of producto, gramos, tienda, fecha_devolucion, motivo on tiendaariga.devoluciones
  for each row execute function tiendaariga.sincronizar_devolucion_inventario();

-- ¿Puede el usuario devolver / anular devoluciones de este pedido?
create or replace function tiendaariga.puede_devolver(p_clave text)
returns boolean
language sql stable
security definer
set search_path = tiendaariga
as $$
  select es_admin() or exists (
    select 1 from ventas v
    where clave_pedido(v.envio, v.pedido_id) = trim(p_clave)
      and (v.creado_por = auth.uid() or cliente_propio(v.cliente_id)))
$$;

-- Registrar una devolución: p_lineas = [{"producto": "...", "cantidad": 2, "valor": 500}, ...]
create or replace function tiendaariga.registrar_devolucion(p_clave text, p_fecha date, p_motivo text, p_lineas jsonb)
returns int
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  l jsonb; n int := 0;
  v_tienda text; v_pedido text; v_factura text; v_cliente bigint;
  v_cant numeric; v_valor numeric;
  vend_cant numeric; vend_valor numeric; dev_cant numeric; dev_valor numeric;
begin
  if not usuario_activo() or not puede_devolver(p_clave) then
    raise exception 'Solo el administrador, el dueño del cliente o quien registró la venta puede hacer devoluciones de este pedido.';
  end if;
  if coalesce(trim(p_motivo), '') = '' then
    raise exception 'Escriba el motivo de la devolución.';
  end if;
  select max(tienda), max(pedido_id), max(factura), max(cliente_id)
    into v_tienda, v_pedido, v_factura, v_cliente
  from ventas where clave_pedido(envio, pedido_id) = trim(p_clave);
  if v_pedido is null and v_tienda is null then
    raise exception 'No se encontró el pedido %.', p_clave;
  end if;

  for l in select * from jsonb_array_elements(coalesce(p_lineas, '[]'::jsonb)) loop
    v_cant  := round(coalesce(nullif(l->>'cantidad', '')::numeric, 0), 2);
    v_valor := round(coalesce(nullif(l->>'valor', '')::numeric, 0), 2);
    continue when v_cant <= 0 and v_valor <= 0;
    if v_cant < 0 or v_valor < 0 then raise exception 'Cantidad y valor no pueden ser negativos.'; end if;

    select coalesce(sum(cantidad), 0), coalesce(sum(valor_total), 0) into vend_cant, vend_valor
    from ventas where clave_pedido(envio, pedido_id) = trim(p_clave) and upper(trim(producto)) = upper(trim(l->>'producto'));
    select coalesce(sum(gramos), 0), coalesce(sum(valor), 0) into dev_cant, dev_valor
    from devoluciones where trim(envio) = trim(p_clave) and upper(trim(producto)) = upper(trim(l->>'producto'));

    if vend_cant = 0 and vend_valor = 0 then
      raise exception 'El producto % no está en el pedido.', l->>'producto';
    end if;
    if v_cant > vend_cant - dev_cant + 0.005 then
      raise exception 'De % solo quedan % por devolver (vendido %, ya devuelto %).', l->>'producto', vend_cant - dev_cant, vend_cant, dev_cant;
    end if;
    if v_valor > vend_valor - dev_valor + 0.005 then
      raise exception 'De % solo quedan Q% por devolver.', l->>'producto', vend_valor - dev_valor;
    end if;

    insert into devoluciones (tienda, pedido_id, fecha_devolucion, factura, envio, producto, valor, gramos, motivo, cliente_id, creado_por)
    values (v_tienda, v_pedido, coalesce(p_fecha, (now() at time zone 'America/Guatemala')::date), v_factura, trim(p_clave),
            l->>'producto', v_valor, v_cant, trim(p_motivo), v_cliente, auth.uid());
    n := n + 1;
  end loop;
  if n = 0 then
    raise exception 'Indique la cantidad o el valor a devolver de al menos un producto.';
  end if;
  return n;
end;
$$;

create or replace function tiendaariga.eliminar_devolucion(p_id bigint)
returns void
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare d devoluciones;
begin
  select * into d from devoluciones where id = p_id;
  if not found then raise exception 'La devolución % no existe.', p_id; end if;
  if not (es_admin() or (usuario_activo() and d.creado_por = auth.uid())) then
    raise exception 'Solo el administrador o quien registró la devolución puede eliminarla.';
  end if;
  delete from devoluciones where id = p_id;
end;
$$;

revoke execute on function tiendaariga.puede_devolver(text)                          from public, anon;
revoke execute on function tiendaariga.registrar_devolucion(text, date, text, jsonb) from public, anon;
revoke execute on function tiendaariga.eliminar_devolucion(bigint)                   from public, anon;
grant  execute on function tiendaariga.puede_devolver(text)                          to authenticated;
grant  execute on function tiendaariga.registrar_devolucion(text, date, text, jsonb) to authenticated;
grant  execute on function tiendaariga.eliminar_devolucion(bigint)                   to authenticated;

-- Estado de cuenta: la devolución se identifica por su cliente (o por el envío/pedido)
create or replace view tiendaariga.estado_cuenta
with (security_invoker = true) as
select v.cliente_id, min(v.fecha_venta) as fecha, 'VENTA'::text as movimiento,
       concat_ws(' · ', 'Pedido ' || v.pedido_id, 'Envío ' || v.envio,
                 string_agg(distinct v.producto, ', ')) as detalle,
       sum(coalesce(v.valor_total,0)) as cargo, 0::numeric as abono,
       null::text as metodo_pago, min(v.id) as ref_id
from tiendaariga.ventas v
where v.cliente_id is not null
group by v.cliente_id, v.pedido_id, v.envio
union all
select p.cliente_id, p.fecha_pago, 'PAGO',
       concat_ws(' · ', 'Boleta ' || p.boleta, 'Envío ' || p.envio, p.observaciones),
       0, coalesce(p.valor_pagado,0), p.metodo_pago, p.id
from tiendaariga.pagos p
where p.cliente_id is not null
union all
select coalesce(d.cliente_id, x.cliente_id), d.fecha_devolucion, 'DEVOLUCIÓN',
       concat_ws(' · ', d.producto, d.motivo, 'Envío ' || d.envio),
       0, coalesce(d.valor,0), null, d.id
from tiendaariga.devoluciones d
left join lateral (select v.cliente_id from tiendaariga.ventas v
                   where tiendaariga.clave_pedido(v.envio, v.pedido_id) = trim(d.envio) and v.cliente_id is not null
                   limit 1) x on true
where coalesce(d.cliente_id, x.cliente_id) is not null;

notify pgrst, 'reload schema';
