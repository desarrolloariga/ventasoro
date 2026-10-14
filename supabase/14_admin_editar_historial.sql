-- =====================================================================
--  Joyería ARIGA - Actualización 14
--  * Historial del administrador: puede editar o eliminar CUALQUIER registro
--    de ventas, pagos, devoluciones, cargas de inventario (compras),
--    devoluciones a oficina, traslados y clientes, sin las restricciones
--    normales (cargas de traslados, tienda del vendedor, permisos por fila).
--  * Solo el administrador puede usar estas funciones.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 13. Se puede repetir.
-- =====================================================================

create or replace function tiendaariga.admin_tabla_historial(p_tabla text)
returns void
language plpgsql stable
security definer
set search_path = tiendaariga
as $$
begin
  if not es_admin() then
    raise exception 'Solo un administrador puede modificar el historial.';
  end if;
  if p_tabla not in ('ventas', 'pagos', 'devoluciones', 'ingresos_inventario',
                     'devoluciones_oficina', 'traslados', 'clientes') then
    raise exception 'Tabla no permitida: %', p_tabla;
  end if;
end;
$$;

-- Edita las columnas que vengan en p_datos ({"columna": valor, ...}); null vacía el campo.
-- El id no se cambia. Devuelve el registro guardado.
create or replace function tiendaariga.admin_editar_registro(p_tabla text, p_id bigint, p_datos jsonb)
returns jsonb
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  v_cols text;
  v_fila jsonb;
begin
  perform admin_tabla_historial(p_tabla);

  select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position) into v_cols
    from information_schema.columns c
   where c.table_schema = 'tiendaariga' and c.table_name = p_tabla
     and c.column_name not in ('id', 'created_at')
     and c.is_identity = 'NO' and c.is_generated = 'NEVER'
     and p_datos ? c.column_name;
  if v_cols is null then
    raise exception 'No hay cambios para guardar.';
  end if;

  perform set_config('tiendaariga.traslado', 'si', true);   -- permite editar cargas de traslados
  execute format('update %I t set (%s) = (select %s from jsonb_populate_record(null::%I, $1)) where t.id = $2 returning to_jsonb(t)',
                 p_tabla, v_cols, v_cols, p_tabla)
     into v_fila using p_datos, p_id;
  if v_fila is null then
    raise exception 'El registro % ya no existe.', p_id;
  end if;
  return v_fila;
end;
$$;

-- Elimina un registro. Un traslado se elimina junto con sus movimientos de inventario.
create or replace function tiendaariga.admin_eliminar_registro(p_tabla text, p_id bigint)
returns void
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare n int;
begin
  perform admin_tabla_historial(p_tabla);
  perform set_config('tiendaariga.traslado', 'si', true);
  if p_tabla = 'traslados' then
    delete from ingresos_inventario where traslado_id = p_id;
  end if;
  execute format('delete from %I where id = $1', p_tabla) using p_id;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'El registro % ya no existe.', p_id;
  end if;
end;
$$;

revoke execute on function tiendaariga.admin_tabla_historial(text)                  from public, anon;
revoke execute on function tiendaariga.admin_editar_registro(text, bigint, jsonb)   from public, anon;
revoke execute on function tiendaariga.admin_eliminar_registro(text, bigint)        from public, anon;
grant  execute on function tiendaariga.admin_editar_registro(text, bigint, jsonb)   to authenticated;
grant  execute on function tiendaariga.admin_eliminar_registro(text, bigint)        to authenticated;

notify pgrst, 'reload schema';
