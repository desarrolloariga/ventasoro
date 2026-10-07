-- =====================================================================
--  Joyería ARIGA - Actualización 09
--  * Al cambiar el dueño de un cliente a un vendedor CON rango, el cliente
--    pasa a un código del rango de ese vendedor (y su siguiente consecutivo).
--    Sus ventas y pagos se actualizan con el código nuevo.
--  * Repara los clientes que ya fueron reasignados y quedaron con un código
--    fuera del rango de su vendedor: se renumeran en el orden en que se
--    crearon, después de los que ya estaban bien.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 07. Se puede repetir.
-- =====================================================================

-- Mueve un cliente a otro código: ventas y pagos lo siguen. El envío del
-- saldo inicial (SI-<código>) también se actualiza.
create or replace function tiendaariga.mover_codigo_cliente(p_viejo bigint, p_nuevo bigint)
returns void
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if p_viejo = p_nuevo then return; end if;
  update ventas set envio = 'SI-' || p_nuevo where cliente_id = p_viejo and envio = 'SI-' || p_viejo;
  update pagos  set envio = 'SI-' || p_nuevo where cliente_id = p_viejo and envio = 'SI-' || p_viejo;
  update ventas set cliente_id = p_nuevo where cliente_id = p_viejo;
  update pagos  set cliente_id = p_nuevo where cliente_id = p_viejo;
end;
$$;
revoke execute on function tiendaariga.mover_codigo_cliente(bigint, bigint) from public, anon, authenticated;

-- Al editar: solo el admin marca mayoristas. Si cambia el dueño:
--  * nuevo dueño con rango  -> código del rango + su siguiente consecutivo
--  * nuevo dueño sin rango  -> conserva el código, siguiente consecutivo
create or replace function tiendaariga.validar_cambio_cliente()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  s record;
  r perfiles;
begin
  if new.tipo_cliente = 'MAYORISTA' and old.tipo_cliente <> 'MAYORISTA'
     and auth.uid() is not null and not es_admin() then
    raise exception 'Solo un administrador puede marcar clientes como mayoristas.';
  end if;

  if new.creado_por is distinct from old.creado_por then
    perform pg_advisory_xact_lock(hashtext('tiendaariga.codigo_cliente'));
    s := siguiente_codigo_cliente(new.creado_por);
    new.consecutivo := s.consecutivo;
    select * into r from perfiles where id = new.creado_por;
    if r.rango_desde is not null
       and not (old.id between r.rango_desde and r.rango_hasta) then
      if s.codigo is null then
        raise exception 'El rango de códigos de ese vendedor está lleno. Amplíelo en Usuarios antes de asignarle el cliente.';
      end if;
      new.id := s.codigo;
      perform mover_codigo_cliente(old.id, new.id);
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Reparación de los clientes ya reasignados fuera del rango de su dueño
-- ---------------------------------------------------------------------
do $$
declare
  c   record;
  s   record;
  n   int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('tiendaariga.codigo_cliente'));

  -- 1) Liberar sus consecutivos para volver a numerarlos en orden
  update tiendaariga.clientes cl
     set consecutivo = null
    from tiendaariga.perfiles p
   where p.id = cl.creado_por and p.rango_desde is not null
     and not (cl.id between p.rango_desde and p.rango_hasta);

  -- 2) Asignarles código del rango y consecutivo, en el orden en que se crearon
  for c in
    select cl.id, cl.creado_por
    from tiendaariga.clientes cl
    join tiendaariga.perfiles p on p.id = cl.creado_por
    where p.rango_desde is not null and not (cl.id between p.rango_desde and p.rango_hasta)
    order by cl.creado_por, cl.created_at, cl.id
  loop
    s := tiendaariga.siguiente_codigo_cliente(c.creado_por);
    if s.codigo is null then
      raise exception 'El rango del vendedor del cliente % está lleno; amplíelo y ejecute de nuevo.', c.id;
    end if;
    perform tiendaariga.mover_codigo_cliente(c.id, s.codigo);
    update tiendaariga.clientes set id = s.codigo, consecutivo = s.consecutivo where id = c.id;
    n := n + 1;
  end loop;

  -- 3) Por si quedó algún cliente sin consecutivo (dueño sin rango)
  update tiendaariga.clientes cl
     set consecutivo = sub.siguiente
    from (select x.id, coalesce((select max(y.consecutivo) from tiendaariga.clientes y
                                 where y.creado_por is not distinct from x.creado_por), 0)
                       + row_number() over (partition by x.creado_por order by x.created_at, x.id) as siguiente
          from tiendaariga.clientes x where x.consecutivo is null) sub
   where cl.id = sub.id;

  raise notice 'Clientes movidos al rango de su vendedor: %', n;
end $$;

notify pgrst, 'reload schema';
