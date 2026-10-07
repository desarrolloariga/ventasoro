-- =====================================================================
--  Joyería ARIGA - Actualización 11
--  * Renombrar un maestro (tienda/bodega, vendedor, método de pago, tipo o
--    departamento) desde Maestros. El nombre nuevo se aplica también a todo
--    lo que lo usa: ventas, pagos, devoluciones, cargas de inventario,
--    traslados, referencias, clientes y usuarios vinculados.
--  * Solo el administrador puede renombrar.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 10. Se puede repetir.
-- =====================================================================

create or replace function tiendaariga.renombrar_maestro(p_maestro text, p_viejo text, p_nuevo text)
returns text
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  v_nuevo text := upper(regexp_replace(trim(coalesce(p_nuevo, '')), '\s+', ' ', 'g'));
  v_existe boolean;
begin
  if not es_admin() then
    raise exception 'Solo un administrador puede cambiar nombres en Maestros.';
  end if;
  if p_maestro not in ('tiendas', 'vendedores', 'metodos_pago', 'tipos', 'departamentos') then
    raise exception 'Maestro no válido: %', p_maestro;
  end if;
  if v_nuevo = '' then
    raise exception 'Escriba el nuevo nombre.';
  end if;
  if v_nuevo = p_viejo then
    return v_nuevo;
  end if;

  execute format('select exists (select 1 from %I where nombre = $1)', p_maestro) into v_existe using p_viejo;
  if not v_existe then
    raise exception '"%" ya no existe; recargue la página.', p_viejo;
  end if;
  execute format('select exists (select 1 from %I where upper(nombre) = $1 and nombre <> $2)', p_maestro)
    into v_existe using v_nuevo, p_viejo;
  if v_existe then
    raise exception 'Ya existe "%". Elija otro nombre.', v_nuevo;
  end if;

  -- Permite actualizar las cargas que vienen de un traslado
  perform set_config('tiendaariga.traslado', 'si', true);

  -- perfiles.tienda se actualiza sola (on update cascade)
  execute format('update %I set nombre = $1 where nombre = $2', p_maestro) using v_nuevo, p_viejo;

  case p_maestro
    when 'tiendas' then
      update ventas               set tienda  = v_nuevo where tienda  = p_viejo;
      update devoluciones         set tienda  = v_nuevo where tienda  = p_viejo;
      update ingresos_inventario  set tienda  = v_nuevo where tienda  = p_viejo;
      update devoluciones_oficina set tienda  = v_nuevo where tienda  = p_viejo;
      update inventario_items     set tienda  = v_nuevo where tienda  = p_viejo;
      update traslados            set origen  = v_nuevo where origen  = p_viejo;
      update traslados            set destino = v_nuevo where destino = p_viejo;
    when 'vendedores' then
      update ventas set vendedor = v_nuevo where vendedor = p_viejo;
      update pagos  set vendedor = v_nuevo where vendedor = p_viejo;
    when 'tipos' then
      update ventas    set tipo = v_nuevo where tipo = p_viejo;
      update pagos     set tipo = v_nuevo where tipo = p_viejo;
      update productos set tipo = v_nuevo where tipo = p_viejo;
    when 'metodos_pago' then
      update pagos set metodo_pago = v_nuevo where metodo_pago = p_viejo;
    when 'departamentos' then
      update clientes set departamento = v_nuevo where departamento = p_viejo;
      update coordenadas set departamento = v_nuevo
       where departamento = p_viejo
         and not exists (select 1 from coordenadas where departamento = v_nuevo);
  end case;

  return v_nuevo;
end;
$$;

revoke execute on function tiendaariga.renombrar_maestro(text, text, text) from public, anon;
grant  execute on function tiendaariga.renombrar_maestro(text, text, text) to authenticated;

notify pgrst, 'reload schema';
