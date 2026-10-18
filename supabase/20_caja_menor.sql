-- =====================================================================
--  Joyería ARIGA - Actualización 20: VENTAS EN EFECTIVO Y CAJA MENOR
--  * Una venta puede ser a CRÉDITO (queda en cartera, como siempre) o en
--    EFECTIVO: el cliente paga al momento. La venta en efectivo registra
--    sola su pago (método EFECTIVO, aplicado al envío) y una ENTRADA en la
--    caja menor del usuario que la registró. Si la venta se edita o se
--    elimina, el pago y la entrada se ajustan solos.
--  * Caja menor por usuario: entradas (ventas en efectivo o manuales) y
--    salidas manuales (liquidación / entrega a oficina, gastos...).
--    Cada vendedor ve y mueve su caja; el supervisor ve las de su equipo;
--    el administrador ve y mueve todas.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 19. Se puede repetir.
-- =====================================================================

alter table tiendaariga.ventas add column if not exists forma_pago text not null default 'CREDITO';
alter table tiendaariga.ventas drop constraint if exists ventas_forma_pago_chk;
alter table tiendaariga.ventas add constraint ventas_forma_pago_chk check (forma_pago in ('CREDITO', 'EFECTIVO'));

create table if not exists tiendaariga.caja_menor (
  id             bigint generated always as identity primary key,
  fecha          date not null default ((now() at time zone 'America/Guatemala')::date),
  usuario_id     uuid not null references tiendaariga.perfiles(id) on delete cascade,
  tipo           text not null check (tipo in ('ENTRADA', 'SALIDA')),
  origen         text not null default 'MANUAL' check (origen in ('VENTA', 'MANUAL')),
  valor          numeric(14,2) not null check (valor > 0),
  concepto       text,
  observaciones  text,
  pedido_id      text,                                   -- venta en efectivo que la originó
  pago_id        bigint references tiendaariga.pagos(id) on delete set null,
  creado_por     uuid default auth.uid() references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists caja_menor_usuario_idx on tiendaariga.caja_menor (usuario_id, fecha);
create index if not exists caja_menor_pedido_idx  on tiendaariga.caja_menor (pedido_id);

-- ---------------------------------------------------------------------
-- Venta en efectivo: pago automático + entrada a la caja del vendedor.
-- Se recalcula cada vez que cambian las líneas del pedido.
-- ---------------------------------------------------------------------
create or replace function tiendaariga.sincronizar_venta_efectivo(p_pedido text)
returns void
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  v       record;
  m       caja_menor;
  v_pago  bigint;
  v_dueno uuid;
begin
  select min(fecha_venta)                         as fecha,
         max(cliente_id)                          as cliente_id,
         bool_or(forma_pago = 'EFECTIVO')         as efectivo,
         sum(coalesce(valor_total, 0))            as total,
         max(clave_pedido(envio, pedido_id))      as clave,
         max(creado_por::text)::uuid              as creado_por,
         max(vendedor)                            as vendedor
    into v
    from ventas where pedido_id = p_pedido;
  select * into m from caja_menor where pedido_id = p_pedido and origen = 'VENTA' order by id limit 1;

  if v.total is null or not coalesce(v.efectivo, false) or v.total <= 0 then
    -- No es (o dejó de ser) venta en efectivo: se quitan el pago y la entrada
    if m.id is not null then
      delete from caja_menor where id = m.id;
      if m.pago_id is not null then delete from pagos where id = m.pago_id; end if;
    end if;
    return;
  end if;

  if v.cliente_id is null then
    raise exception 'Una venta en efectivo debe tener cliente.';
  end if;
  v_dueno := coalesce(v.creado_por, m.usuario_id, auth.uid());

  if m.id is null then
    insert into pagos (fecha_pago, envio, metodo_pago, valor_pagado, vendedor, observaciones, cliente_id, creado_por)
    values (v.fecha, v.clave, 'EFECTIVO', v.total, v.vendedor, 'Venta en efectivo · pedido ' || p_pedido, v.cliente_id, v_dueno)
    returning id into v_pago;
    insert into caja_menor (fecha, usuario_id, tipo, origen, valor, concepto, pedido_id, pago_id, creado_por)
    values (v.fecha, v_dueno, 'ENTRADA', 'VENTA', v.total, 'Venta en efectivo · pedido ' || p_pedido, p_pedido, v_pago, v_dueno);
  else
    if m.pago_id is not null then
      update pagos set valor_pagado = v.total, envio = v.clave, fecha_pago = v.fecha,
                       cliente_id = v.cliente_id, vendedor = v.vendedor
       where id = m.pago_id;
    end if;
    update caja_menor set valor = v.total, fecha = v.fecha, usuario_id = v_dueno where id = m.id;
  end if;
end;
$$;
revoke execute on function tiendaariga.sincronizar_venta_efectivo(text) from public, anon, authenticated;

create or replace function tiendaariga.ventas_efectivo_ins()
returns trigger language plpgsql security definer set search_path = tiendaariga as $$
declare p text;
begin
  for p in select distinct pedido_id from nuevas where pedido_id is not null loop
    perform sincronizar_venta_efectivo(p);
  end loop;
  return null;
end $$;
create or replace function tiendaariga.ventas_efectivo_upd()
returns trigger language plpgsql security definer set search_path = tiendaariga as $$
declare p text;
begin
  for p in select pedido_id from viejas union select pedido_id from nuevas loop
    if p is not null then perform sincronizar_venta_efectivo(p); end if;
  end loop;
  return null;
end $$;
create or replace function tiendaariga.ventas_efectivo_del()
returns trigger language plpgsql security definer set search_path = tiendaariga as $$
declare p text;
begin
  for p in select distinct pedido_id from viejas where pedido_id is not null loop
    perform sincronizar_venta_efectivo(p);
  end loop;
  return null;
end $$;
revoke execute on function tiendaariga.ventas_efectivo_ins() from public, anon, authenticated;
revoke execute on function tiendaariga.ventas_efectivo_upd() from public, anon, authenticated;
revoke execute on function tiendaariga.ventas_efectivo_del() from public, anon, authenticated;

drop trigger if exists ventas_efectivo_ins on tiendaariga.ventas;
create trigger ventas_efectivo_ins after insert on tiendaariga.ventas
  referencing new table as nuevas for each statement execute function tiendaariga.ventas_efectivo_ins();
drop trigger if exists ventas_efectivo_upd on tiendaariga.ventas;
create trigger ventas_efectivo_upd after update on tiendaariga.ventas
  referencing old table as viejas new table as nuevas for each statement execute function tiendaariga.ventas_efectivo_upd();
drop trigger if exists ventas_efectivo_del on tiendaariga.ventas;
create trigger ventas_efectivo_del after delete on tiendaariga.ventas
  referencing old table as viejas for each statement execute function tiendaariga.ventas_efectivo_del();

-- ---------------------------------------------------------------------
-- Registrar y actualizar ventas: ahora reciben la forma de pago
-- ---------------------------------------------------------------------
create or replace function tiendaariga.registrar_venta(p_venta jsonb)
returns text
language plpgsql
set search_path = tiendaariga
as $$
declare
  v_hoy date := (now() at time zone 'America/Guatemala')::date;
  v_id  text;
  h     jsonb := p_venta->'header';
  s     jsonb := p_venta->'summary';
  v_fp  text := coalesce(nullif(upper(trim(s->>'formaPago')), ''), 'CREDITO');
begin
  if jsonb_array_length(coalesce(p_venta->'productLines','[]'::jsonb)) = 0 then
    raise exception 'La venta no tiene productos';
  end if;
  if v_fp = 'EFECTIVO' and nullif(h->>'clienteId','') is null then
    raise exception 'Una venta en efectivo debe tener cliente.';
  end if;
  v_id := siguiente_pedido_id();

  insert into ventas (pedido_id, fecha_venta, fecha_vencimiento, tienda, vendedor,
                      cliente_id, cliente, documento_cliente, factura, envio,
                      tipo, producto, cantidad, valor_unitario, valor_total, forma_pago)
  select v_id, v_hoy, v_hoy + 30,
         h->>'tienda', h->>'vendedor', nullif(h->>'clienteId','')::bigint,
         h->>'clienteNombre', nullif(h->>'clienteDPI',''),
         nullif(s->>'factura',''), nullif(trim(s->>'envio'),''),
         l->>'tipo', l->>'producto',
         nullif(l->>'cantidad','')::numeric,
         nullif(l->>'valorUnitario','')::numeric,
         nullif(l->>'valorTotal','')::numeric,
         v_fp
  from jsonb_array_elements(p_venta->'productLines') l;

  return v_id;
end;
$$;

create or replace function tiendaariga.actualizar_venta(p_envio text, p_venta jsonb)
returns text
language plpgsql
set search_path = tiendaariga
as $$
declare
  v_pedido  text;
  v_fecha   date;
  v_vence   date;
  v_cliente bigint;
  v_fp_ant  text;
  h         jsonb := p_venta->'header';
  s         jsonb := p_venta->'summary';
  v_fp      text;
begin
  select pedido_id, fecha_venta, fecha_vencimiento, cliente_id, forma_pago
    into v_pedido, v_fecha, v_vence, v_cliente, v_fp_ant
  from ventas where clave_pedido(envio, pedido_id) = trim(p_envio)
  order by id limit 1;

  if not found then
    raise exception 'No se encontró el pedido para actualizar.';
  end if;
  if jsonb_array_length(coalesce(p_venta->'productLines','[]'::jsonb)) = 0 then
    raise exception 'La venta no tiene productos';
  end if;
  v_fp := coalesce(nullif(upper(trim(s->>'formaPago')), ''), v_fp_ant, 'CREDITO');
  if v_fp = 'EFECTIVO' and coalesce(nullif(h->>'clienteId','')::bigint, v_cliente) is null then
    raise exception 'Una venta en efectivo debe tener cliente.';
  end if;

  delete from ventas where clave_pedido(envio, pedido_id) = trim(p_envio);

  insert into ventas (pedido_id, fecha_venta, fecha_vencimiento, tienda, vendedor,
                      cliente_id, cliente, documento_cliente, factura, envio,
                      tipo, producto, cantidad, valor_unitario, valor_total, forma_pago)
  select coalesce(nullif(h->>'pedidoId',''), v_pedido), v_fecha, v_vence,
         h->>'tienda', h->>'vendedor', coalesce(nullif(h->>'clienteId','')::bigint, v_cliente),
         h->>'clienteNombre', nullif(h->>'clienteDPI',''),
         nullif(s->>'factura',''), nullif(trim(s->>'envio'),''),
         l->>'tipo', l->>'producto',
         nullif(l->>'cantidad','')::numeric,
         nullif(l->>'valorUnitario','')::numeric,
         nullif(l->>'valorTotal','')::numeric,
         v_fp
  from jsonb_array_elements(p_venta->'productLines') l;

  return format('Pedido %s actualizado correctamente.', p_envio);
end;
$$;

-- ---------------------------------------------------------------------
-- Vistas: movimientos con nombres y saldo por usuario
-- ---------------------------------------------------------------------
create or replace view tiendaariga.caja_menor_detalle
with (security_invoker = true) as
select m.id, m.fecha, m.usuario_id, coalesce(u.nombre, u.usuario) as usuario, u.tienda,
       m.tipo, m.origen, m.valor, m.concepto, m.observaciones, m.pedido_id, m.pago_id,
       m.creado_por, coalesce(r.nombre, r.usuario) as registrado_por, m.created_at
from tiendaariga.caja_menor m
join tiendaariga.perfiles u on u.id = m.usuario_id
left join tiendaariga.perfiles r on r.id = m.creado_por;

create or replace view tiendaariga.caja_menor_saldos
with (security_invoker = true) as
select p.id as usuario_id, coalesce(p.nombre, p.usuario) as usuario, p.usuario as acceso, p.rol, p.tienda, p.activo,
       coalesce(sum(m.valor) filter (where m.tipo = 'ENTRADA'), 0) as entradas,
       coalesce(sum(m.valor) filter (where m.tipo = 'SALIDA'), 0)  as salidas,
       coalesce(sum(case when m.tipo = 'ENTRADA' then m.valor else -m.valor end), 0) as saldo,
       max(m.fecha) as ultimo_movimiento,
       count(m.id)  as movimientos
from tiendaariga.perfiles p
left join tiendaariga.caja_menor m on m.usuario_id = p.id
group by p.id;

-- ---------------------------------------------------------------------
-- Permisos: cada uno su caja; supervisor ve su equipo; admin todo.
-- Las entradas por venta solo las crea el sistema.
-- ---------------------------------------------------------------------
alter table tiendaariga.caja_menor enable row level security;
grant select, insert, update, delete on tiendaariga.caja_menor to authenticated;
grant select on tiendaariga.caja_menor_detalle, tiendaariga.caja_menor_saldos to authenticated;
grant usage, select on all sequences in schema tiendaariga to authenticated;

drop policy if exists "caja_ver" on tiendaariga.caja_menor;
create policy "caja_ver" on tiendaariga.caja_menor for select to authenticated
  using ((select tiendaariga.usuario_activo())
         and ((select tiendaariga.es_admin()) or usuario_id = (select auth.uid())
              or tiendaariga.es_de_mi_equipo(usuario_id)));

drop policy if exists "caja_registrar" on tiendaariga.caja_menor;
create policy "caja_registrar" on tiendaariga.caja_menor for insert to authenticated
  with check ((select tiendaariga.usuario_activo()) and origen = 'MANUAL'
              and ((select tiendaariga.es_admin()) or usuario_id = (select auth.uid())));

drop policy if exists "caja_editar" on tiendaariga.caja_menor;
create policy "caja_editar" on tiendaariga.caja_menor for update to authenticated
  using ((select tiendaariga.es_admin()) and origen = 'MANUAL')
  with check ((select tiendaariga.es_admin()) and origen = 'MANUAL');

drop policy if exists "caja_borrar" on tiendaariga.caja_menor;
create policy "caja_borrar" on tiendaariga.caja_menor for delete to authenticated
  using ((select tiendaariga.usuario_activo()) and origen = 'MANUAL'
         and ((select tiendaariga.es_admin())
              or (usuario_id = (select auth.uid()) and creado_por = (select auth.uid()))));

-- El historial del administrador también puede tocar la caja menor
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
                     'devoluciones_oficina', 'traslados', 'clientes', 'caja_menor') then
    raise exception 'Tabla no permitida: %', p_tabla;
  end if;
end;
$$;

notify pgrst, 'reload schema';
