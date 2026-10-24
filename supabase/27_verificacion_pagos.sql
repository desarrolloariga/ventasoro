-- =====================================================================
--  Joyería ARIGA - Actualización 27: VERIFICACIÓN DE PAGOS
--  * pagos: comprobante (archivo adjunto), recibo (agrupa las partes de un
--    mismo pago aplicado a varios envíos) y verificación: estado PENDIENTE /
--    VALIDADO / RECHAZADO, quién y cuándo lo verificó, y nota.
--  * Solo el administrador cambia la verificación (función verificar_pagos).
--  * Almacenamiento privado "comprobantes": sube cualquier usuario activo;
--    ve el archivo el administrador o quien lo subió.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 26. Se puede repetir.
-- =====================================================================

alter table tiendaariga.pagos add column if not exists recibo uuid;
alter table tiendaariga.pagos add column if not exists comprobante text;          -- ruta en el almacenamiento
alter table tiendaariga.pagos add column if not exists estado_verificacion text not null default 'PENDIENTE';
alter table tiendaariga.pagos add column if not exists verificado_por uuid references auth.users(id) on delete set null;
alter table tiendaariga.pagos add column if not exists verificado_en timestamptz;
alter table tiendaariga.pagos add column if not exists nota_verificacion text;
alter table tiendaariga.pagos drop constraint if exists pagos_verificacion_chk;
alter table tiendaariga.pagos add constraint pagos_verificacion_chk
  check (estado_verificacion in ('PENDIENTE', 'VALIDADO', 'RECHAZADO'));
create index if not exists pagos_verificacion_idx on tiendaariga.pagos (estado_verificacion, fecha_pago);
create index if not exists pagos_recibo_idx on tiendaariga.pagos (recibo);

-- Solo el administrador cambia la verificación
create or replace function tiendaariga.proteger_verificacion_pago()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if auth.uid() is null or es_admin() then return new; end if;
  if tg_op = 'INSERT' then
    new.estado_verificacion := 'PENDIENTE';
    new.verificado_por := null; new.verificado_en := null; new.nota_verificacion := null;
  elsif new.estado_verificacion is distinct from old.estado_verificacion
     or new.verificado_por is distinct from old.verificado_por
     or new.verificado_en is distinct from old.verificado_en
     or new.nota_verificacion is distinct from old.nota_verificacion then
    raise exception 'Solo el administrador puede verificar pagos.';
  end if;
  return new;
end;
$$;
revoke execute on function tiendaariga.proteger_verificacion_pago() from public, anon, authenticated;
drop trigger if exists pagos_proteger_verificacion on tiendaariga.pagos;
create trigger pagos_proteger_verificacion
  before insert or update on tiendaariga.pagos
  for each row execute function tiendaariga.proteger_verificacion_pago();

-- Validar o rechazar varios pagos (todas las partes de un recibo) de una vez
create or replace function tiendaariga.verificar_pagos(p_ids bigint[], p_estado text, p_nota text default null)
returns int
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare n int;
begin
  if not es_admin() then
    raise exception 'Solo el administrador puede verificar pagos.';
  end if;
  if p_estado not in ('PENDIENTE', 'VALIDADO', 'RECHAZADO') then
    raise exception 'Estado no válido: %', p_estado;
  end if;
  update pagos
     set estado_verificacion = p_estado,
         verificado_por = case when p_estado = 'PENDIENTE' then null else auth.uid() end,
         verificado_en  = case when p_estado = 'PENDIENTE' then null else now() end,
         nota_verificacion = nullif(trim(coalesce(p_nota, '')), '')
   where id = any(p_ids);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function tiendaariga.verificar_pagos(bigint[], text, text) from public, anon;
grant  execute on function tiendaariga.verificar_pagos(bigint[], text, text) to authenticated;

-- Pagos recibidos: con comprobante y verificación (columnas nuevas al final)
create or replace view tiendaariga.pagos_detalle
with (security_invoker = true) as
select p.id, p.fecha_pago, p.cliente_id,
       coalesce(c.nombre, (select v.cliente from tiendaariga.ventas v
                           where v.envio = p.envio limit 1)) as cliente,
       p.envio, p.metodo_pago, p.valor_pagado, p.boleta, p.vendedor, p.observaciones,
       coalesce(u.nombre, u.email) as registrado_por, p.created_at,
       p.creado_por, p.recibo, p.comprobante, p.estado_verificacion,
       coalesce(vp.nombre, vp.usuario) as verificado_por_nombre, p.verificado_en, p.nota_verificacion
from tiendaariga.pagos p
left join tiendaariga.clientes c on c.id = p.cliente_id
left join tiendaariga.perfiles u on u.id = p.creado_por
left join tiendaariga.perfiles vp on vp.id = p.verificado_por;

-- ---------------------------------------------------------------------
-- Almacenamiento de comprobantes (privado)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'Sin esquema storage (base de prueba): se omite el almacenamiento.';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('comprobantes', 'comprobantes', false, 10485760,
          array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                                 allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists "comprobantes_subir" on storage.objects';
  execute $p$create policy "comprobantes_subir" on storage.objects for insert to authenticated
            with check (bucket_id = 'comprobantes' and (select tiendaariga.usuario_activo()))$p$;
  execute 'drop policy if exists "comprobantes_ver" on storage.objects';
  execute $p$create policy "comprobantes_ver" on storage.objects for select to authenticated
            using (bucket_id = 'comprobantes'
                   and ((select tiendaariga.es_admin()) or owner = (select auth.uid())))$p$;
end $$;

-- Mover un pago (script 19): la parte separada conserva comprobante, recibo y verificación
create or replace function tiendaariga.mover_pago(p_pago bigint, p_envio text, p_valor numeric default null)
returns void
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  pg      pagos;
  c       clientes;
  v_valor numeric;
  v_saldo numeric;
  v_recibo uuid;
begin
  select * into pg from pagos where id = p_pago;
  if not found then raise exception 'El pago % no existe.', p_pago; end if;
  if pg.cliente_id is null then raise exception 'El pago no tiene cliente.'; end if;
  select * into c from clientes where id = pg.cliente_id;
  if not (es_admin() or (usuario_activo() and c.creado_por = auth.uid())) then
    raise exception 'Solo el dueño del cliente o un administrador puede mover sus pagos.';
  end if;
  if trim(coalesce(p_envio, '')) = '' or trim(p_envio) = trim(coalesce(pg.envio, '')) then
    raise exception 'Elija un envío distinto al actual.';
  end if;
  v_valor := round(coalesce(p_valor, pg.valor_pagado), 2);
  if v_valor <= 0 or v_valor > pg.valor_pagado + 0.005 then
    raise exception 'El valor a mover debe ser mayor que 0 y no mayor que el pago (Q%).', pg.valor_pagado;
  end if;
  select saldo into v_saldo from envios_cliente(pg.cliente_id) where envio = trim(p_envio);
  if v_saldo is null then
    raise exception 'El envío % no pertenece a este cliente.', p_envio;
  end if;
  if v_valor > v_saldo + 0.005 then
    raise exception 'El envío % solo debe Q%; no se le pueden aplicar Q%.', p_envio, v_saldo, v_valor;
  end if;

  if v_valor >= pg.valor_pagado - 0.005 then
    update pagos set envio = trim(p_envio),
           observaciones = concat_ws(' · ', observaciones, 'Movido desde envío ' || coalesce(pg.envio, '(sin envío)'))
     where id = pg.id;
  else
    update pagos set valor_pagado = valor_pagado - v_valor where id = pg.id;
    v_recibo := coalesce(pg.recibo, gen_random_uuid());
    insert into pagos (fecha_pago, envio, factura, metodo_pago, tipo, valor_pagado, boleta, contabilidad,
                       vendedor, nit, confirmacion, observaciones, nota_importacion, cliente_id, creado_por, created_at,
                       recibo, comprobante, estado_verificacion, verificado_por, verificado_en, nota_verificacion)
    values (pg.fecha_pago, trim(p_envio), pg.factura, pg.metodo_pago, pg.tipo, v_valor, pg.boleta, pg.contabilidad,
            pg.vendedor, pg.nit, pg.confirmacion,
            concat_ws(' · ', pg.observaciones, 'Separado del pago N° ' || pg.id || ' (envío ' || coalesce(pg.envio, '-') || ')'),
            pg.nota_importacion, pg.cliente_id, pg.creado_por, pg.created_at,
            v_recibo, pg.comprobante, pg.estado_verificacion, pg.verificado_por, pg.verificado_en, pg.nota_verificacion);
    -- la parte que se queda pertenece al mismo recibo que la nueva
    update pagos set recibo = v_recibo where id = pg.id and recibo is null;
  end if;
end;
$$;

notify pgrst, 'reload schema';
