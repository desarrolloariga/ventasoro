-- =====================================================================
--  Joyería ARIGA - Actualización 03
--  * Usuarios con nombre de usuario (sin correo) y administrador inicial
--    usuario: admin  /  contraseña: admin123
--  * El administrador crea vendedores y les cambia la contraseña
--  * Búsqueda de pedidos por cliente, código de cliente, pedido o envío
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 01_esquema.sql.
--  Se puede ejecutar varias veces: no borra datos ni cambia la contraseña
--  del admin si ya existe.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Usuario (login) en el perfil. Internamente Supabase Auth usa un correo:
-- el usuario "maria" entra como maria@ariga.local (no se envían correos).
-- ---------------------------------------------------------------------
alter table tiendaariga.perfiles add column if not exists usuario text;
create unique index if not exists perfiles_usuario_uq on tiendaariga.perfiles (lower(usuario));

create or replace function tiendaariga.email_de_usuario(p_usuario text)
returns text language sql immutable as $$
  select case when position('@' in p_usuario) > 0 then lower(trim(p_usuario))
              else lower(trim(p_usuario)) || '@ariga.local' end
$$;

-- Crea una cuenta en Supabase Auth con contraseña (uso interno, sin correo
-- de confirmación). Falla si la cuenta ya existe.
create or replace function tiendaariga.crear_cuenta_auth(p_email text, p_password text, p_nombre text)
returns uuid
language plpgsql
security definer
set search_path = tiendaariga, auth, extensions
as $$
declare u uuid := gen_random_uuid();
begin
  if exists (select 1 from auth.users where lower(email) = lower(p_email)) then
    raise exception 'Ya existe una cuenta con el usuario %', split_part(p_email, '@', 1);
  end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', lower(p_email),
          crypt(p_password, gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('nombre', p_nombre, 'app', 'tiendaariga'),
          now(), now(), '', '', '', '');
  insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), u::text, u,
          jsonb_build_object('sub', u::text, 'email', lower(p_email), 'email_verified', true),
          'email', now(), now(), now());
  return u;
end;
$$;
revoke execute on function tiendaariga.crear_cuenta_auth(text, text, text) from public, anon, authenticated;

-- El administrador crea un vendedor (o administrador) con usuario y contraseña
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
  if coalesce(p_rol,'vendedor') not in ('vendedor', 'admin') then
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

-- El administrador cambia la contraseña de un usuario de ARIGA
create or replace function tiendaariga.admin_cambiar_password(p_perfil uuid, p_password text)
returns text
language plpgsql
security definer
set search_path = tiendaariga, auth, extensions
as $$
begin
  if not es_admin() then
    raise exception 'Solo un administrador puede cambiar contraseñas';
  end if;
  if length(coalesce(p_password,'')) < 6 then
    raise exception 'La contraseña debe tener al menos 6 caracteres.';
  end if;
  if not exists (select 1 from perfiles where id = p_perfil) then
    raise exception 'Usuario no encontrado';
  end if;
  update auth.users
     set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now()
   where id = p_perfil;
  return 'Contraseña actualizada';
end;
$$;

-- ---------------------------------------------------------------------
-- Administrador inicial: usuario "admin", contraseña "admin123"
-- (si ya existe, no se toca su contraseña)
-- ---------------------------------------------------------------------
do $$
declare u uuid;
begin
  select id into u from auth.users where lower(email) = 'admin@ariga.local';
  if u is null then
    u := tiendaariga.crear_cuenta_auth('admin@ariga.local', 'admin123', 'Administrador');
  end if;
  insert into tiendaariga.perfiles (id, email, usuario, nombre, rol, activo)
  values (u, 'admin@ariga.local', 'admin', 'Administrador', 'admin', true)
  on conflict (id) do update set usuario = 'admin', rol = 'admin', activo = true;
end $$;

-- Perfiles creados antes por correo: su usuario es la parte antes de la @
update tiendaariga.perfiles
   set usuario = split_part(email, '@', 1)
 where usuario is null
   and not exists (select 1 from tiendaariga.perfiles p2
                   where lower(p2.usuario) = lower(split_part(tiendaariga.perfiles.email, '@', 1)));

-- ---------------------------------------------------------------------
-- Búsqueda de pedidos por: cliente (nombre), código de cliente, número de
-- pedido o envío. p_campo: 'todo' | 'cliente' | 'codigo' | 'pedido' | 'envio'
-- ---------------------------------------------------------------------
drop function if exists tiendaariga.buscar_pedidos(text);
drop function if exists tiendaariga.buscar_pedidos(text, text);
create function tiendaariga.buscar_pedidos(p_termino text, p_campo text default 'todo')
returns table (clave text, pedido_id text, envio text, fecha_venta date, cliente_id bigint,
               cliente text, tienda text, vendedor text, total numeric, lineas bigint)
language sql stable
set search_path = tiendaariga
as $$
  with t as (select lower(trim(coalesce(p_termino,''))) as q, coalesce(p_campo,'todo') as campo)
  select clave_pedido(v.envio, v.pedido_id), v.pedido_id, v.envio, min(v.fecha_venta),
         max(v.cliente_id), max(coalesce(c.nombre, v.cliente)), max(v.tienda), max(v.vendedor),
         sum(coalesce(v.valor_total,0)), count(*)
  from ventas v
  left join clientes c on c.id = v.cliente_id
  cross join t
  where t.q <> ''
    and case t.campo
          when 'cliente' then lower(coalesce(c.nombre, v.cliente, '')) like '%' || t.q || '%'
          when 'codigo'  then v.cliente_id::text = t.q
          when 'pedido'  then lower(coalesce(v.pedido_id,'')) like '%' || t.q || '%'
          when 'envio'   then lower(coalesce(v.envio,'')) like '%' || t.q || '%'
          else lower(coalesce(c.nombre, v.cliente, '')) like '%' || t.q || '%'
            or v.cliente_id::text = t.q
            or lower(coalesce(v.pedido_id,'')) like '%' || t.q || '%'
            or lower(coalesce(v.envio,'')) like '%' || t.q || '%'
        end
  group by 1, 2, 3
  order by min(v.fecha_venta) desc nulls last, 2 desc
  limit 100;
$$;

-- Permisos de las funciones nuevas
revoke execute on function tiendaariga.admin_crear_usuario(text, text, text, text) from public, anon;
revoke execute on function tiendaariga.admin_cambiar_password(uuid, text)          from public, anon;
revoke execute on function tiendaariga.buscar_pedidos(text, text)                   from public, anon;
grant  execute on function tiendaariga.admin_crear_usuario(text, text, text, text) to authenticated;
grant  execute on function tiendaariga.admin_cambiar_password(uuid, text)          to authenticated;
grant  execute on function tiendaariga.buscar_pedidos(text, text)                   to authenticated;
grant  execute on function tiendaariga.email_de_usuario(text)                       to authenticated;

notify pgrst, 'reload schema';
