-- =====================================================================
--  Joyería ARIGA - Actualización 13: EL TIPO REEMPLAZA A LA REFERENCIA
--  * Ventas, cargas de inventario, traslados y saldos se manejan por Tipo
--    (material) de Maestros. Cada tipo tiene su unidad (gramos o unidades)
--    y dice si lleva inventario.
--  * La tabla de referencias (productos) queda como copia automática de los
--    tipos, para que saldos, kardex, traslados e inteligencia sigan igual.
--  * Datos existentes: cada venta, carga, traslado y devolución pasa al tipo
--    de su referencia. Las referencias sin tipo se convierten en un tipo con
--    su mismo nombre (p. ej. SERVICIO JOYERIA). El nombre anterior queda
--    anotado (ventas: nota de importación; cargas: observaciones).
--  * Reemplaza lo del script 12 (no hace falta haberlo ejecutado).
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 11. Se puede repetir.
-- =====================================================================

alter table tiendaariga.tipos add column if not exists unidad text not null default 'GRAMOS';
alter table tiendaariga.tipos add column if not exists controla_inventario boolean not null default true;
alter table tiendaariga.tipos drop constraint if exists tipos_unidad_chk;
alter table tiendaariga.tipos add constraint tipos_unidad_chk check (unidad in ('GRAMOS', 'UNIDADES'));

-- Lo del script 12 ya no aplica
drop trigger if exists ventas_tipo_referencia on tiendaariga.ventas;
drop trigger if exists productos_propagar_tipo on tiendaariga.productos;
drop function if exists tiendaariga.tipo_desde_referencia();
drop function if exists tiendaariga.propagar_tipo_referencia();

-- ---------------------------------------------------------------------
-- Migración de los datos existentes (solo actúa si quedan referencias
-- que no son copia de un tipo)
-- ---------------------------------------------------------------------
do $$
declare
  n_v int := 0; n_c int := 0; n_t int := 0; n_tipos int := 0;
begin
  if not exists (select 1 from tiendaariga.productos p
                 where p.tipo is null or upper(trim(p.nombre)) <> upper(trim(p.tipo))) then
    raise notice 'No hay referencias por convertir.';
    return;
  end if;

  perform set_config('tiendaariga.traslado', 'si', true);  -- permite tocar cargas de traslados

  -- 1) Referencias sin tipo -> tipo con su mismo nombre
  insert into tiendaariga.tipos (nombre, orden, activo, unidad, controla_inventario)
  select upper(trim(p.nombre)),
         (select coalesce(max(orden), 0) from tiendaariga.tipos) + row_number() over (order by p.orden, p.nombre),
         p.activo, coalesce(p.unidad, 'GRAMOS'), p.controla_inventario
  from tiendaariga.productos p
  where nullif(trim(p.tipo), '') is null
    and not exists (select 1 from tiendaariga.tipos t where upper(t.nombre) = upper(trim(p.nombre)));
  get diagnostics n_tipos = row_count;
  update tiendaariga.productos p
     set tipo = (select t.nombre from tiendaariga.tipos t where upper(t.nombre) = upper(trim(p.nombre)))
   where nullif(trim(p.tipo), '') is null;

  -- Tipos escritos distinto en las referencias (mayúsculas/espacios) -> nombre del maestro
  update tiendaariga.productos p set tipo = t.nombre
    from tiendaariga.tipos t
   where upper(trim(p.tipo)) = upper(t.nombre) and p.tipo <> t.nombre;
  -- Tipos usados por referencias que no están en Maestros
  insert into tiendaariga.tipos (nombre, orden, activo)
  select distinct p.tipo, (select coalesce(max(orden), 0) + 1 from tiendaariga.tipos), true
  from tiendaariga.productos p
  where not exists (select 1 from tiendaariga.tipos t where t.nombre = p.tipo)
  on conflict (nombre) do nothing;

  -- 2) Unidad e inventario de cada tipo según sus referencias
  update tiendaariga.tipos t
     set unidad = x.unidad, controla_inventario = x.controla
    from (select tipo,
                 case when bool_or(unidad = 'GRAMOS') then 'GRAMOS' else 'UNIDADES' end as unidad,
                 bool_or(controla_inventario) as controla
          from tiendaariga.productos group by tipo) x
   where x.tipo = t.nombre;

  -- 3) Equivalencia referencia -> tipo
  create temp table mapa_ref on commit drop as
    select upper(trim(nombre)) as k, tipo from tiendaariga.productos;

  -- 4) Ventas (el saldo inicial de clientes no se toca)
  update tiendaariga.ventas v
     set nota_importacion = case when upper(trim(v.producto)) <> upper(m.tipo)
                                 then concat_ws(' · ', v.nota_importacion, 'Referencia: ' || v.producto)
                                 else v.nota_importacion end,
         producto = m.tipo, tipo = m.tipo
    from mapa_ref m
   where upper(trim(v.producto)) = m.k
     and (v.producto is distinct from m.tipo or v.tipo is distinct from m.tipo);
  get diagnostics n_v = row_count;
  -- Ventas antiguas con un producto que no era referencia pero sí tienen tipo
  update tiendaariga.ventas v
     set nota_importacion = concat_ws(' · ', v.nota_importacion, 'Producto: ' || v.producto),
         producto = t.nombre, tipo = t.nombre
    from tiendaariga.tipos t
   where upper(trim(v.tipo)) = upper(t.nombre)
     and v.producto is not null and upper(trim(v.producto)) <> 'SALDO INICIAL'
     and not exists (select 1 from mapa_ref m where m.k = upper(trim(v.producto)))
     and upper(trim(v.producto)) <> upper(t.nombre);

  -- 5) Inventario: cargas, traslados, devoluciones
  update tiendaariga.ingresos_inventario g
     set observaciones = concat_ws(' · ', g.observaciones, 'Ref. ' || g.producto), producto = m.tipo
    from mapa_ref m
   where upper(trim(g.producto)) = m.k and upper(trim(g.producto)) <> upper(m.tipo);
  get diagnostics n_c = row_count;
  update tiendaariga.ingresos_inventario g set producto = m.tipo
    from mapa_ref m where upper(trim(g.producto)) = m.k and g.producto <> m.tipo;
  update tiendaariga.traslados x set producto = m.tipo
    from mapa_ref m where upper(trim(x.producto)) = m.k and x.producto <> m.tipo;
  get diagnostics n_t = row_count;
  update tiendaariga.devoluciones_oficina o set producto = m.tipo
    from mapa_ref m where upper(trim(o.producto)) = m.k and o.producto <> m.tipo;
  update tiendaariga.devoluciones d set producto = m.tipo
    from mapa_ref m where upper(trim(d.producto)) = m.k and d.producto <> m.tipo;

  -- Fechas de inicio de control: una por bodega y tipo (la más antigua)
  create temp table items_tipo on commit drop as
    select i.tienda, m.tipo as producto, min(i.fecha_inicio) as fecha_inicio
    from tiendaariga.inventario_items i join mapa_ref m on m.k = upper(trim(i.producto))
    group by i.tienda, m.tipo;
  delete from tiendaariga.inventario_items i using mapa_ref m where m.k = upper(trim(i.producto));
  insert into tiendaariga.inventario_items (tienda, producto, fecha_inicio)
  select tienda, producto, fecha_inicio from items_tipo
  on conflict (tienda, producto) do update set fecha_inicio = least(excluded.fecha_inicio, tiendaariga.inventario_items.fecha_inicio);

  -- 6) Las referencias pasan a ser copia de los tipos
  delete from tiendaariga.productos;

  raise notice 'Tipos nuevos (referencias sin tipo): % · Ventas: % · Cargas: % · Traslados: %', n_tipos, n_v, n_c, n_t;
end $$;

-- ---------------------------------------------------------------------
-- Copia automática tipos -> productos (lo que usan saldos, kardex, etc.)
-- ---------------------------------------------------------------------
create or replace function tiendaariga.sincronizar_tipo_producto()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if tg_op = 'DELETE' then
    delete from productos where nombre = old.nombre;
    return old;
  end if;
  if tg_op = 'UPDATE' and new.nombre <> old.nombre then
    update productos set nombre = new.nombre where nombre = old.nombre;
  end if;
  insert into productos (nombre, orden, tipo, unidad, controla_inventario, activo)
  values (new.nombre, new.orden, new.nombre, new.unidad, new.controla_inventario, new.activo)
  on conflict (nombre) do update
    set orden = excluded.orden, tipo = excluded.tipo, unidad = excluded.unidad,
        controla_inventario = excluded.controla_inventario, activo = excluded.activo;
  return new;
end;
$$;
revoke execute on function tiendaariga.sincronizar_tipo_producto() from public, anon, authenticated;

drop trigger if exists tipos_sincronizar_producto on tiendaariga.tipos;
create trigger tipos_sincronizar_producto
  after insert or update or delete on tiendaariga.tipos
  for each row execute function tiendaariga.sincronizar_tipo_producto();

-- Copia inicial (y reparación si se repite el script)
insert into tiendaariga.productos (nombre, orden, tipo, unidad, controla_inventario, activo)
select nombre, orden, nombre, unidad, controla_inventario, activo from tiendaariga.tipos
on conflict (nombre) do update
  set orden = excluded.orden, tipo = excluded.tipo, unidad = excluded.unidad,
      controla_inventario = excluded.controla_inventario, activo = excluded.activo;
delete from tiendaariga.productos p where not exists (select 1 from tiendaariga.tipos t where t.nombre = p.nombre);

-- Venta: producto y tipo son lo mismo (salvo el saldo inicial de clientes)
create or replace function tiendaariga.venta_por_tipo()
returns trigger
language plpgsql
as $$
begin
  if upper(trim(coalesce(new.producto, ''))) = 'SALDO INICIAL' then return new; end if;
  if nullif(trim(new.tipo), '') is not null then
    new.producto := new.tipo;
  elsif nullif(trim(new.producto), '') is not null then
    new.tipo := new.producto;
  end if;
  return new;
end;
$$;
drop trigger if exists ventas_por_tipo on tiendaariga.ventas;
create trigger ventas_por_tipo
  before insert or update of producto, tipo on tiendaariga.ventas
  for each row execute function tiendaariga.venta_por_tipo();

-- ---------------------------------------------------------------------
-- Maestros: renombrar y "en uso" para tipos ahora incluyen el inventario
-- ---------------------------------------------------------------------
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

  perform set_config('tiendaariga.traslado', 'si', true);

  -- perfiles.tienda (on update cascade) y productos (trigger) se actualizan solos
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
      update ventas               set tipo = v_nuevo, producto = v_nuevo where tipo = p_viejo or producto = p_viejo;
      update pagos                set tipo = v_nuevo where tipo = p_viejo;
      update ingresos_inventario  set producto = v_nuevo where producto = p_viejo;
      update traslados            set producto = v_nuevo where producto = p_viejo;
      update devoluciones_oficina set producto = v_nuevo where producto = p_viejo;
      update devoluciones         set producto = v_nuevo where producto = p_viejo;
      update inventario_items     set producto = v_nuevo where producto = p_viejo;
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
    when 'tipos'         then exists (select 1 from ventas where tipo = p_nombre or producto = p_nombre)
                           or exists (select 1 from ingresos_inventario where producto = p_nombre)
                           or exists (select 1 from traslados where producto = p_nombre)
    when 'metodos_pago'  then exists (select 1 from pagos where metodo_pago = p_nombre)
    when 'departamentos' then exists (select 1 from clientes where departamento = p_nombre)
    else true
  end;
end;
$$;

notify pgrst, 'reload schema';

-- Resultado: tipos con su unidad y si llevan inventario
select nombre as tipo, unidad, controla_inventario as lleva_inventario, activo
from tiendaariga.tipos order by orden, nombre;
