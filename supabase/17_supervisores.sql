-- =====================================================================
--  Joyería ARIGA - Actualización 17: SUPERVISORES Y JERARQUÍAS
--  * Nuevo rol "supervisor". Un supervisor tiene a su cargo varios
--    vendedores (perfiles.supervisor_id) y puede VER (no modificar) los
--    clientes, ventas, pagos, devoluciones y traslados de su equipo, para
--    indicadores y gestión. Lo suyo propio lo maneja igual que un vendedor.
--  * Solo el administrador crea supervisores y arma la jerarquía.
--  * Inteligencia comercial se puede filtrar por vendedor.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 16. Se puede repetir.
-- =====================================================================

-- Rol supervisor
alter table tiendaariga.perfiles drop constraint if exists perfiles_rol_check;
alter table tiendaariga.perfiles add constraint perfiles_rol_check check (rol in ('admin', 'supervisor', 'vendedor'));

-- Supervisor de cada vendedor
alter table tiendaariga.perfiles add column if not exists supervisor_id uuid
  references tiendaariga.perfiles(id) on delete set null;
create index if not exists perfiles_supervisor_idx on tiendaariga.perfiles (supervisor_id);

-- ¿El usuario con sesión es supervisor activo?
create or replace function tiendaariga.es_supervisor()
returns boolean
language sql stable
security definer
set search_path = tiendaariga
as $$
  select exists (select 1 from perfiles where id = auth.uid() and activo and rol = 'supervisor')
$$;

-- ¿p_usuario es un vendedor del equipo del supervisor con sesión?
create or replace function tiendaariga.es_de_mi_equipo(p_usuario uuid)
returns boolean
language sql stable
security definer
set search_path = tiendaariga
as $$
  select p_usuario is not null and exists (
    select 1 from perfiles s join perfiles v on v.supervisor_id = s.id
    where s.id = auth.uid() and s.activo and s.rol = 'supervisor' and v.id = p_usuario)
$$;

-- ¿El cliente pertenece a un vendedor del equipo?
create or replace function tiendaariga.cliente_de_mi_equipo(p_cliente_id bigint)
returns boolean
language sql stable
security definer
set search_path = tiendaariga
as $$
  select p_cliente_id is not null
     and exists (select 1 from clientes where id = p_cliente_id and es_de_mi_equipo(creado_por))
$$;

-- Tiendas/bodegas de los vendedores del equipo (para traslados)
create or replace function tiendaariga.tiendas_de_mi_equipo()
returns setof text
language sql stable
security definer
set search_path = tiendaariga
as $$
  select distinct v.tienda from perfiles v
  where v.tienda is not null and es_de_mi_equipo(v.id)
$$;

-- Jerarquía: solo se asigna a un supervisor (no a sí mismo). Si un supervisor
-- deja de serlo, su equipo queda sin supervisor.
create or replace function tiendaariga.validar_jerarquia()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if new.supervisor_id is not null then
    if new.supervisor_id = new.id then
      raise exception 'Un usuario no puede ser su propio supervisor.';
    end if;
    if not exists (select 1 from perfiles where id = new.supervisor_id and rol = 'supervisor') then
      raise exception 'El usuario elegido no es supervisor.';
    end if;
    if new.rol = 'admin' then
      raise exception 'Un administrador no se asigna a un supervisor.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists perfiles_validar_jerarquia on tiendaariga.perfiles;
create trigger perfiles_validar_jerarquia
  before insert or update of supervisor_id, rol on tiendaariga.perfiles
  for each row execute function tiendaariga.validar_jerarquia();

create or replace function tiendaariga.liberar_equipo()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if old.rol = 'supervisor' and new.rol <> 'supervisor' then
    update perfiles set supervisor_id = null where supervisor_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists perfiles_liberar_equipo on tiendaariga.perfiles;
create trigger perfiles_liberar_equipo
  after update of rol on tiendaariga.perfiles
  for each row execute function tiendaariga.liberar_equipo();

-- Crear usuarios ahora acepta el rol supervisor
create or replace function tiendaariga.admin_crear_usuario(p_usuario text, p_nombre text, p_password text,
                                                           p_rol text default 'vendedor')
returns tiendaariga.perfiles
language plpgsql
security definer
set search_path = tiendaariga, auth, extensions
as $$
declare
  v_usuario text := lower(trim(p_usuario));
  u uuid;
  r perfiles;
begin
  if not es_admin() then
    raise exception 'Solo un administrador puede crear usuarios';
  end if;
  if v_usuario !~ '^[a-z0-9._-]{3,30}$' then
    raise exception 'El usuario debe tener de 3 a 30 caracteres: letras, números, punto, guion o guion bajo (sin espacios).';
  end if;
  if length(coalesce(p_password,'')) < 6 then
    raise exception 'La contraseña debe tener al menos 6 caracteres.';
  end if;
  if coalesce(p_rol,'vendedor') not in ('vendedor', 'supervisor', 'admin') then
    raise exception 'Rol no válido';
  end if;
  if exists (select 1 from perfiles where lower(usuario) = v_usuario) then
    raise exception 'El usuario % ya existe', v_usuario;
  end if;

  u := crear_cuenta_auth(email_de_usuario(v_usuario), p_password, coalesce(nullif(trim(p_nombre),''), v_usuario));
  insert into perfiles (id, email, usuario, nombre, rol, activo)
  values (u, email_de_usuario(v_usuario), v_usuario, coalesce(nullif(trim(p_nombre),''), v_usuario),
          coalesce(p_rol,'vendedor'), true)
  returning * into r;
  return r;
end;
$$;

-- ---------------------------------------------------------------------
-- Permisos de LECTURA del supervisor sobre su equipo (se suman a los que ya
-- existen; para modificar siguen aplicando los de siempre)
-- ---------------------------------------------------------------------
drop policy if exists "clientes_equipo" on tiendaariga.clientes;
create policy "clientes_equipo" on tiendaariga.clientes for select to authenticated
  using (tiendaariga.es_de_mi_equipo(creado_por));

drop policy if exists "ventas_equipo" on tiendaariga.ventas;
create policy "ventas_equipo" on tiendaariga.ventas for select to authenticated
  using (tiendaariga.es_de_mi_equipo(creado_por) or tiendaariga.cliente_de_mi_equipo(cliente_id));

drop policy if exists "pagos_equipo" on tiendaariga.pagos;
create policy "pagos_equipo" on tiendaariga.pagos for select to authenticated
  using (tiendaariga.es_de_mi_equipo(creado_por) or tiendaariga.cliente_de_mi_equipo(cliente_id));

drop policy if exists "devoluciones_equipo" on tiendaariga.devoluciones;
create policy "devoluciones_equipo" on tiendaariga.devoluciones for select to authenticated
  using (tiendaariga.es_de_mi_equipo(creado_por));

drop policy if exists "traslados_equipo" on tiendaariga.traslados;
create policy "traslados_equipo" on tiendaariga.traslados for select to authenticated
  using (tiendaariga.es_de_mi_equipo(enviado_por)
         or origen in (select tiendaariga.tiendas_de_mi_equipo())
         or destino in (select tiendaariga.tiendas_de_mi_equipo()));

-- ---------------------------------------------------------------------
-- Inteligencia comercial: filtro opcional por vendedor (dueño del cliente
-- o quien registró la venta). Cada usuario sigue viendo solo lo que le toca.
-- ---------------------------------------------------------------------
drop function if exists tiendaariga.indicadores_comerciales(date, date, text);
drop function if exists tiendaariga.indicadores_comerciales(date, date, text, uuid);
create function tiendaariga.indicadores_comerciales(p_desde date default null, p_hasta date default null,
                                                    p_tienda text default null, p_vendedor uuid default null)
returns jsonb
language sql stable
set search_path = tiendaariga
as $$
  with vg as (   -- ventas de lo que se vende por gramo
    select v.fecha_venta,
           coalesce(nullif(upper(trim(p.tipo)),''), nullif(upper(trim(rtrim(trim(v.tipo), '.'))),''), 'SIN TIPO') as tipo,
           v.cantidad, v.valor_total
    from ventas v
    join productos p on upper(trim(p.nombre)) = upper(trim(v.producto))
    where p.unidad = 'GRAMOS'
      and upper(trim(v.producto)) <> 'SALDO INICIAL'
      and coalesce(v.cantidad, 0) > 0 and coalesce(v.valor_total, 0) > 0
      and (p_tienda is null or upper(trim(v.tienda)) = upper(trim(p_tienda)))
      and (p_vendedor is null or v.creado_por = p_vendedor
           or v.cliente_id in (select id from clientes where creado_por = p_vendedor))
  ),
  periodo as (
    select * from vg
    where (p_desde is null or fecha_venta >= p_desde) and (p_hasta is null or fecha_venta <= p_hasta)
  ),
  ultima_bodega as (
    select distinct on (cliente_id) cliente_id, tienda
    from ventas where cliente_id is not null
    order by cliente_id, fecha_venta desc nulls last, id desc
  ),
  cartera as (
    select cc.* from cartera_clientes cc
    where (p_tienda is null
           or cc.codigo in (select cliente_id from ultima_bodega where upper(trim(tienda)) = upper(trim(p_tienda))))
      and (p_vendedor is null or cc.vendedor_id = p_vendedor)
  )
  select jsonb_build_object(
    'cartera', (
      select jsonb_build_object(
        'por_cobrar',         coalesce(sum(saldo) filter (where saldo > 0.005), 0),
        'clientes_con_saldo', count(*) filter (where saldo > 0.005),
        'saldo_a_favor',      coalesce(-sum(saldo) filter (where saldo < -0.005), 0),
        'clientes',           count(*))
      from cartera),
    'gramos', (
      select coalesce(jsonb_agg(x order by x.tipo, x.tienda), '[]'::jsonb)
      from (select i.tienda, coalesce(nullif(upper(trim(i.tipo)),''), 'SIN TIPO') as tipo, sum(i.saldo) as gramos
            from inventario i
            where i.unidad = 'GRAMOS' and (p_tienda is null or i.kt = upper(trim(p_tienda)))
            group by 1, 2) x),
    'transito', (
      select coalesce(jsonb_agg(t), '[]'::jsonb) from gramos_en_transito(p_tienda) t),
    'promedio', (
      select jsonb_build_object(
        'gramos', coalesce(sum(cantidad), 0),
        'valor',  coalesce(sum(valor_total), 0),
        'por_tipo', coalesce((select jsonb_agg(y order by y.tipo)
                              from (select tipo, sum(cantidad) as gramos, sum(valor_total) as valor
                                    from periodo group by tipo) y), '[]'::jsonb))
      from periodo),
    'mensual', (
      select coalesce(jsonb_agg(m order by m.mes, m.tipo), '[]'::jsonb)
      from (select to_char(date_trunc('month', fecha_venta), 'YYYY-MM') as mes, tipo,
                   sum(cantidad) as gramos, sum(valor_total) as valor
            from vg
            where fecha_venta >= (date_trunc('month', (now() at time zone 'America/Guatemala')) - interval '11 months')::date
            group by 1, 2) m),
    'traslados_por_recibir', (
      select count(*) from traslados t
      where t.estado = 'ENVIADO'
        and (es_admin() or t.destino = tienda_usuario())
        and (p_tienda is null or upper(trim(t.destino)) = upper(trim(p_tienda)))),
    'usuarios_bodega', (
      select coalesce(jsonb_agg(coalesce(nombre, usuario) order by nombre), '[]'::jsonb)
      from perfiles where activo and p_tienda is not null and upper(trim(tienda)) = upper(trim(p_tienda)))
  )
$$;

revoke execute on function tiendaariga.es_supervisor()                                   from public, anon;
revoke execute on function tiendaariga.es_de_mi_equipo(uuid)                             from public, anon;
revoke execute on function tiendaariga.cliente_de_mi_equipo(bigint)                      from public, anon;
revoke execute on function tiendaariga.tiendas_de_mi_equipo()                            from public, anon;
revoke execute on function tiendaariga.validar_jerarquia()                               from public, anon, authenticated;
revoke execute on function tiendaariga.liberar_equipo()                                  from public, anon, authenticated;
revoke execute on function tiendaariga.indicadores_comerciales(date, date, text, uuid)   from public, anon;
grant  execute on function tiendaariga.es_supervisor()                                   to authenticated;
grant  execute on function tiendaariga.es_de_mi_equipo(uuid)                             to authenticated;
grant  execute on function tiendaariga.cliente_de_mi_equipo(bigint)                      to authenticated;
grant  execute on function tiendaariga.tiendas_de_mi_equipo()                            to authenticated;
grant  execute on function tiendaariga.indicadores_comerciales(date, date, text, uuid)   to authenticated;

notify pgrst, 'reload schema';
