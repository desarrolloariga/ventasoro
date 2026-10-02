-- =====================================================================
--  Joyería ARIGA - Actualización 04
--  * Vincular cada usuario a una tienda o bodega.
--  * Las ventas y cargas de inventario de un vendedor vinculado siempre se
--    guardan con su tienda (lo asegura la base, no solo la pantalla).
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 03_usuarios_y_pedidos.sql.
--  Se puede ejecutar varias veces.
-- =====================================================================

-- Tienda o bodega del usuario (opcional). Si la tienda se elimina, el
-- usuario queda sin tienda.
alter table tiendaariga.perfiles add column if not exists tienda text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'perfiles_tienda_fk') then
    alter table tiendaariga.perfiles
      add constraint perfiles_tienda_fk foreign key (tienda)
      references tiendaariga.tiendas(nombre) on update cascade on delete set null;
  end if;
end $$;

-- Tienda del usuario con sesión (null si no tiene)
create or replace function tiendaariga.tienda_usuario()
returns text
language sql stable
security definer
set search_path = tiendaariga
as $$
  select tienda from perfiles where id = auth.uid() and activo
$$;

-- Fuerza la tienda del vendedor vinculado en ventas y cargas de inventario.
-- No afecta a administradores ni a cargas hechas desde el SQL Editor.
create or replace function tiendaariga.forzar_tienda_usuario()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare v_tienda text := tienda_usuario();
begin
  if v_tienda is not null and not es_admin() then
    new.tienda := v_tienda;
  end if;
  return new;
end;
$$;

drop trigger if exists ventas_tienda_usuario on tiendaariga.ventas;
create trigger ventas_tienda_usuario
  before insert or update of tienda on tiendaariga.ventas
  for each row execute function tiendaariga.forzar_tienda_usuario();

drop trigger if exists ingresos_tienda_usuario on tiendaariga.ingresos_inventario;
create trigger ingresos_tienda_usuario
  before insert or update of tienda on tiendaariga.ingresos_inventario
  for each row execute function tiendaariga.forzar_tienda_usuario();

-- Una tienda vinculada a usuarios está "en uso": no se puede eliminar desde Maestros
create or replace function tiendaariga.maestro_en_uso(p_maestro text, p_nombre text)
returns boolean
language plpgsql stable
security definer
set search_path = tiendaariga
as $$
begin
  if not usuario_activo() then return true; end if;
  return case p_maestro
    when 'tiendas'       then exists (select 1 from ventas where tienda = p_nombre)
                           or exists (select 1 from ingresos_inventario where tienda = p_nombre)
                           or exists (select 1 from perfiles where tienda = p_nombre)
    when 'vendedores'    then exists (select 1 from ventas where vendedor = p_nombre)
    when 'tipos'         then exists (select 1 from ventas where tipo = p_nombre)
                           or exists (select 1 from productos where tipo = p_nombre)
    when 'metodos_pago'  then exists (select 1 from pagos where metodo_pago = p_nombre)
    when 'departamentos' then exists (select 1 from clientes where departamento = p_nombre)
    else true
  end;
end;
$$;

revoke execute on function tiendaariga.tienda_usuario()         from public, anon;
revoke execute on function tiendaariga.forzar_tienda_usuario()  from public, anon;
grant  execute on function tiendaariga.tienda_usuario()         to authenticated;

notify pgrst, 'reload schema';
