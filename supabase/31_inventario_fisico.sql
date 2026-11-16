-- =====================================================================
--  Joyería ARIGA - Actualización 31: INVENTARIO FÍSICO (solo administrador)
--  * Se abre un conteo por bodega y producto en gramos (oro). Se registra
--    pieza por pieza con su gramaje.
--  * Al CERRAR el conteo se guarda el saldo teórico del sistema en ese
--    momento y la diferencia (físico - teórico).
--  * Al APROBAR se hace el ajuste de inventario: entrada si sobra, salida si
--    falta (concepto "AJUSTE INVENTARIO FÍSICO").
--  * Estados: EN_CONTEO -> CERRADO -> APROBADO  (o ANULADO). Un cerrado se
--    puede reabrir para corregir piezas mientras no esté aprobado.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 30. Se puede repetir.
-- =====================================================================

create table if not exists tiendaariga.inventarios_fisicos (
  id             bigint generated always as identity primary key,
  tienda         text not null,
  producto       text not null,
  fecha          date not null default ((now() at time zone 'America/Guatemala')::date),
  estado         text not null default 'EN_CONTEO' check (estado in ('EN_CONTEO', 'CERRADO', 'APROBADO', 'ANULADO')),
  teorico        numeric(14,2),
  fisico         numeric(14,2),
  piezas         int,
  observaciones  text,
  creado_por     uuid default auth.uid() references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  cerrado_por    uuid references auth.users(id) on delete set null,
  cerrado_at     timestamptz,
  aprobado_por   uuid references auth.users(id) on delete set null,
  aprobado_at    timestamptz,
  ajuste_id      bigint
);
-- Un solo conteo abierto por bodega y producto
create unique index if not exists inventarios_fisicos_abierto
  on tiendaariga.inventarios_fisicos (upper(trim(tienda)), upper(trim(producto)))
  where estado in ('EN_CONTEO', 'CERRADO');

create table if not exists tiendaariga.inventario_fisico_piezas (
  id           bigint generated always as identity primary key,
  conteo_id    bigint not null references tiendaariga.inventarios_fisicos(id) on delete cascade,
  descripcion  text,
  gramos       numeric(12,2) not null check (gramos > 0),
  creado_por   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists inventario_fisico_piezas_conteo on tiendaariga.inventario_fisico_piezas (conteo_id, id);

alter table tiendaariga.ingresos_inventario add column if not exists inventario_fisico_id bigint
  references tiendaariga.inventarios_fisicos(id) on delete set null;

-- Solo el administrador
alter table tiendaariga.inventarios_fisicos enable row level security;
alter table tiendaariga.inventario_fisico_piezas enable row level security;
grant select, insert, update, delete on tiendaariga.inventarios_fisicos to authenticated;
grant select, insert, update, delete on tiendaariga.inventario_fisico_piezas to authenticated;
drop policy if exists "invfis_admin" on tiendaariga.inventarios_fisicos;
create policy "invfis_admin" on tiendaariga.inventarios_fisicos for all to authenticated
  using ((select tiendaariga.es_admin())) with check ((select tiendaariga.es_admin()));
drop policy if exists "invfis_piezas_admin" on tiendaariga.inventario_fisico_piezas;
create policy "invfis_piezas_admin" on tiendaariga.inventario_fisico_piezas for all to authenticated
  using ((select tiendaariga.es_admin())) with check ((select tiendaariga.es_admin()));

-- Las piezas solo se cambian mientras el conteo está abierto
create or replace function tiendaariga.proteger_piezas_conteo()
returns trigger
language plpgsql
set search_path = tiendaariga
as $$
declare v_estado text;
begin
  select estado into v_estado from inventarios_fisicos where id = coalesce(new.conteo_id, old.conteo_id);
  if v_estado is distinct from 'EN_CONTEO' and coalesce(current_setting('tiendaariga.invfis', true), '') <> 'si' then
    raise exception 'El conteo % está %: reábralo para cambiar las piezas.', coalesce(new.conteo_id, old.conteo_id), lower(coalesce(v_estado, 'eliminado'));
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists piezas_proteger_conteo on tiendaariga.inventario_fisico_piezas;
create trigger piezas_proteger_conteo
  before insert or update or delete on tiendaariga.inventario_fisico_piezas
  for each row execute function tiendaariga.proteger_piezas_conteo();

-- Datos del conteo (tienda, producto, fecha) solo mientras no esté aprobado; estados solo por las funciones
create or replace function tiendaariga.proteger_conteo()
returns trigger
language plpgsql
set search_path = tiendaariga
as $$
begin
  if coalesce(current_setting('tiendaariga.invfis', true), '') = 'si' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.estado = 'APROBADO' then raise exception 'Un inventario físico aprobado no se puede eliminar.'; end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    new.estado := 'EN_CONTEO'; new.teorico := null; new.fisico := null; new.piezas := null;
    new.cerrado_por := null; new.cerrado_at := null; new.aprobado_por := null; new.aprobado_at := null; new.ajuste_id := null;
    return new;
  end if;
  if new.estado is distinct from old.estado or new.teorico is distinct from old.teorico or new.fisico is distinct from old.fisico
     or new.ajuste_id is distinct from old.ajuste_id or new.aprobado_por is distinct from old.aprobado_por then
    raise exception 'El estado del inventario físico se cambia con los botones Cerrar, Reabrir, Aprobar o Anular.';
  end if;
  if old.estado <> 'EN_CONTEO' and (new.tienda is distinct from old.tienda or new.producto is distinct from old.producto) then
    raise exception 'La bodega y el producto solo se cambian mientras el conteo está abierto.';
  end if;
  return new;
end;
$$;
drop trigger if exists conteo_proteger on tiendaariga.inventarios_fisicos;
create trigger conteo_proteger
  before insert or update or delete on tiendaariga.inventarios_fisicos
  for each row execute function tiendaariga.proteger_conteo();

-- Saldo teórico (sistema) de una bodega y producto
create or replace function tiendaariga.saldo_teorico(p_tienda text, p_producto text)
returns numeric
language sql stable
security definer
set search_path = tiendaariga
as $$
  select coalesce(sum(saldo), 0) from inventario
  where kt = upper(trim(p_tienda)) and kp = upper(trim(p_producto))
$$;

create or replace function tiendaariga.cerrar_inventario_fisico(p_id bigint)
returns tiendaariga.inventarios_fisicos
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare c inventarios_fisicos;
begin
  if not es_admin() then raise exception 'Solo el administrador maneja el inventario físico.'; end if;
  select * into c from inventarios_fisicos where id = p_id for update;
  if not found then raise exception 'El inventario físico % no existe.', p_id; end if;
  if c.estado <> 'EN_CONTEO' then raise exception 'El conteo % ya está %.', p_id, lower(c.estado); end if;
  perform set_config('tiendaariga.invfis', 'si', true);
  update inventarios_fisicos
     set estado = 'CERRADO', cerrado_por = auth.uid(), cerrado_at = now(),
         teorico = saldo_teorico(c.tienda, c.producto),
         fisico  = (select coalesce(sum(gramos), 0) from inventario_fisico_piezas where conteo_id = p_id),
         piezas  = (select count(*) from inventario_fisico_piezas where conteo_id = p_id)
   where id = p_id returning * into c;
  return c;
end;
$$;

create or replace function tiendaariga.reabrir_inventario_fisico(p_id bigint)
returns void
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if not es_admin() then raise exception 'Solo el administrador maneja el inventario físico.'; end if;
  perform set_config('tiendaariga.invfis', 'si', true);
  update inventarios_fisicos set estado = 'EN_CONTEO', teorico = null, fisico = null, piezas = null, cerrado_por = null, cerrado_at = null
   where id = p_id and estado = 'CERRADO';
  if not found then raise exception 'Solo se puede reabrir un conteo cerrado y sin aprobar.'; end if;
end;
$$;

-- Aprobar: ajuste por la diferencia guardada al cerrar
create or replace function tiendaariga.aprobar_inventario_fisico(p_id bigint, p_observaciones text default null)
returns tiendaariga.inventarios_fisicos
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare c inventarios_fisicos; v_dif numeric; v_ajuste bigint;
begin
  if not es_admin() then raise exception 'Solo el administrador puede aprobar el inventario físico.'; end if;
  select * into c from inventarios_fisicos where id = p_id for update;
  if not found then raise exception 'El inventario físico % no existe.', p_id; end if;
  if c.estado <> 'CERRADO' then raise exception 'Solo se aprueba un conteo cerrado (este está %).', lower(c.estado); end if;
  v_dif := round(coalesce(c.fisico, 0) - coalesce(c.teorico, 0), 2);
  perform set_config('tiendaariga.invfis', 'si', true);
  if v_dif <> 0 then
    insert into ingresos_inventario (fecha, tienda, producto, concepto, entrada, salida, observaciones, inventario_fisico_id, creado_por)
    values ((now() at time zone 'America/Guatemala')::date, c.tienda, c.producto, 'AJUSTE INVENTARIO FÍSICO',
            case when v_dif > 0 then v_dif else 0 end, case when v_dif < 0 then -v_dif else 0 end,
            concat_ws(' · ', 'Inventario físico N° ' || c.id, case when v_dif > 0 then 'sobrante' else 'faltante' end,
                      nullif(trim(p_observaciones), '')),
            c.id, auth.uid())
    returning id into v_ajuste;
  end if;
  update inventarios_fisicos
     set estado = 'APROBADO', aprobado_por = auth.uid(), aprobado_at = now(), ajuste_id = v_ajuste,
         observaciones = coalesce(nullif(trim(p_observaciones), ''), observaciones)
   where id = p_id returning * into c;
  return c;
end;
$$;

create or replace function tiendaariga.anular_inventario_fisico(p_id bigint)
returns void
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if not es_admin() then raise exception 'Solo el administrador maneja el inventario físico.'; end if;
  perform set_config('tiendaariga.invfis', 'si', true);
  update inventarios_fisicos set estado = 'ANULADO' where id = p_id and estado in ('EN_CONTEO', 'CERRADO');
  if not found then raise exception 'Solo se anula un conteo abierto o cerrado (los aprobados no).'; end if;
end;
$$;

-- Lista con nombres de quién contó, cerró y aprobó
create or replace view tiendaariga.inventarios_fisicos_lista
with (security_invoker = true) as
select f.*, uc.nombre as creado_nombre, ue.nombre as cerrado_nombre, ua.nombre as aprobado_nombre,
       (select count(*) from tiendaariga.inventario_fisico_piezas x where x.conteo_id = f.id) as piezas_actuales,
       (select coalesce(sum(x.gramos), 0) from tiendaariga.inventario_fisico_piezas x where x.conteo_id = f.id) as gramos_actuales
from tiendaariga.inventarios_fisicos f
left join tiendaariga.perfiles uc on uc.id = f.creado_por
left join tiendaariga.perfiles ue on ue.id = f.cerrado_por
left join tiendaariga.perfiles ua on ua.id = f.aprobado_por;
grant select on tiendaariga.inventarios_fisicos_lista to authenticated;

revoke execute on function tiendaariga.saldo_teorico(text, text)                   from public, anon;
revoke execute on function tiendaariga.cerrar_inventario_fisico(bigint)           from public, anon;
revoke execute on function tiendaariga.reabrir_inventario_fisico(bigint)          from public, anon;
revoke execute on function tiendaariga.aprobar_inventario_fisico(bigint, text)    from public, anon;
revoke execute on function tiendaariga.anular_inventario_fisico(bigint)           from public, anon;
grant  execute on function tiendaariga.saldo_teorico(text, text)                   to authenticated;
grant  execute on function tiendaariga.cerrar_inventario_fisico(bigint)           to authenticated;
grant  execute on function tiendaariga.reabrir_inventario_fisico(bigint)          to authenticated;
grant  execute on function tiendaariga.aprobar_inventario_fisico(bigint, text)    to authenticated;
grant  execute on function tiendaariga.anular_inventario_fisico(bigint)           to authenticated;

notify pgrst, 'reload schema';
