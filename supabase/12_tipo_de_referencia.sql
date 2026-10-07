-- =====================================================================
--  Joyería ARIGA - Actualización 12
--  * Cada referencia pertenece a un Tipo (material). En las ventas el tipo
--    lo define la referencia: al guardar una venta se toma el tipo de su
--    referencia, y si se cambia el tipo de una referencia, sus ventas
--    también cambian.
--  * Alinea las ventas existentes con el tipo de su referencia (solo las
--    referencias que tienen tipo).
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 11. Se puede repetir.
-- =====================================================================

-- Venta: el tipo es el de la referencia (si la referencia tiene tipo)
create or replace function tiendaariga.tipo_desde_referencia()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare v_tipo text;
begin
  select p.tipo into v_tipo from productos p
   where upper(trim(p.nombre)) = upper(trim(new.producto)) and p.tipo is not null
   limit 1;
  if v_tipo is not null then
    new.tipo := v_tipo;
  end if;
  return new;
end;
$$;

drop trigger if exists ventas_tipo_referencia on tiendaariga.ventas;
create trigger ventas_tipo_referencia
  before insert or update of producto, tipo on tiendaariga.ventas
  for each row execute function tiendaariga.tipo_desde_referencia();

-- Referencia: al cambiar su tipo, sus ventas lo siguen
create or replace function tiendaariga.propagar_tipo_referencia()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if new.tipo is not null and new.tipo is distinct from old.tipo then
    update ventas set tipo = new.tipo
     where upper(trim(producto)) = upper(trim(new.nombre))
       and tipo is distinct from new.tipo;
  end if;
  return new;
end;
$$;

drop trigger if exists productos_propagar_tipo on tiendaariga.productos;
create trigger productos_propagar_tipo
  after update of tipo on tiendaariga.productos
  for each row execute function tiendaariga.propagar_tipo_referencia();

revoke execute on function tiendaariga.tipo_desde_referencia()    from public, anon, authenticated;
revoke execute on function tiendaariga.propagar_tipo_referencia() from public, anon, authenticated;

-- Ventas existentes: tomar el tipo de su referencia
do $$
declare n int;
begin
  update tiendaariga.ventas v
     set tipo = p.tipo
    from tiendaariga.productos p
   where upper(trim(p.nombre)) = upper(trim(v.producto))
     and p.tipo is not null
     and v.tipo is distinct from p.tipo;
  get diagnostics n = row_count;
  raise notice 'Ventas alineadas con el tipo de su referencia: %', n;
end $$;

-- Referencias que todavía no tienen tipo (asígnelo en Inventario > Referencias)
select nombre as referencia_sin_tipo from tiendaariga.productos where tipo is null order by nombre;
