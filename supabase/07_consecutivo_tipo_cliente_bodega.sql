-- =====================================================================
--  Joyería ARIGA - Actualización 07
--  * Consecutivo interno de clientes por vendedor (1, 2, 3...). Con rango,
--    el código general es inicio del rango - 1 + consecutivo: rango
--    1001-2000 => 1001, 1002, 1003... El admin puede crear clientes PARA un
--    vendedor y toman el consecutivo de ese vendedor.
--  * Tipo de cliente: MINORISTA o MAYORISTA. Solo el administrador crea o
--    marca mayoristas.
--  * Inteligencia comercial filtrable por bodega.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 06_rangos_codigo_cliente.sql.
--  Se puede ejecutar varias veces. No cambia los códigos ya existentes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Columnas nuevas del cliente
-- ---------------------------------------------------------------------
alter table tiendaariga.clientes add column if not exists consecutivo integer;
alter table tiendaariga.clientes add column if not exists tipo_cliente text not null default 'MINORISTA';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clientes_tipo_ck') then
    alter table tiendaariga.clientes add constraint clientes_tipo_ck check (tipo_cliente in ('MINORISTA', 'MAYORISTA'));
  end if;
end $$;

-- Consecutivo de los clientes que ya existen: en orden de código, por dueño
with numerados as (
  select id, row_number() over (partition by creado_por order by id) as rn
  from tiendaariga.clientes where consecutivo is null
)
update tiendaariga.clientes c
   set consecutivo = n.rn + coalesce((select max(x.consecutivo) from tiendaariga.clientes x
                                      where x.creado_por is not distinct from c.creado_por
                                        and x.consecutivo is not null), 0)
  from numerados n
 where c.id = n.id;

create unique index if not exists clientes_consecutivo_uq
  on tiendaariga.clientes (coalesce(creado_por, '00000000-0000-0000-0000-000000000000'::uuid), consecutivo);

-- ---------------------------------------------------------------------
-- Siguiente código y consecutivo para un dueño (sin reservarlos)
-- ---------------------------------------------------------------------
create or replace function tiendaariga.siguiente_codigo_cliente(p_dueno uuid, out codigo bigint, out consecutivo integer)
language plpgsql stable
security definer
set search_path = tiendaariga
as $$
declare
  r     perfiles;
  v_sig integer;
begin
  select coalesce(max(c.consecutivo), 0) + 1 into consecutivo
    from clientes c where c.creado_por is not distinct from p_dueno;
  select * into r from perfiles where id = p_dueno;
  if r.rango_desde is not null then
    -- Con rango: código = inicio del rango - 1 + consecutivo (1001, 1002...).
    -- El consecutivo siempre sigue 1, 2, 3; si el código ya lo tiene otro
    -- cliente (p. ej. importado), solo el código salta al siguiente libre.
    v_sig := consecutivo;
    select greatest(r.rango_desde - 1 + v_sig, coalesce(max(c.id) + 1, 0)) into codigo
      from clientes c
     where c.creado_por = p_dueno and c.id between r.rango_desde and r.rango_hasta;
    while exists (select 1 from clientes where id = codigo) loop
      codigo := codigo + 1;
    end loop;
    if codigo > r.rango_hasta then codigo := null; end if;
  else
    codigo := calcular_codigo_cliente(null);   -- numeración general (salta los rangos)
  end if;
end;
$$;

-- Compatibilidad con 06: código siguiente de un usuario
create or replace function tiendaariga.calcular_codigo_cliente(p_usuario uuid)
returns bigint
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  r perfiles;
  v bigint;
  h bigint;
begin
  select * into r from perfiles where id = p_usuario;
  if r.rango_desde is not null then
    return (siguiente_codigo_cliente(p_usuario)).codigo;
  end if;
  -- Numeración general: después del código más alto que no es de ningún
  -- rango, saltando los rangos asignados y los códigos ya usados
  select coalesce(max(c.id), 0) + 1 into v
    from clientes c
   where not exists (select 1 from perfiles p
                     where p.rango_desde is not null and c.id between p.rango_desde and p.rango_hasta);
  loop
    select rango_hasta into h from perfiles
     where rango_desde is not null and v between rango_desde and rango_hasta;
    if found then v := h + 1; continue; end if;
    exit when not exists (select 1 from clientes where id = v);
    v := v + 1;
  end loop;
  return v;
end;
$$;

-- Al crear: código y consecutivo según el DUEÑO del cliente (creado_por),
-- que puede ser otro usuario si lo crea el admin. Solo admin crea mayoristas.
create or replace function tiendaariga.asignar_codigo_cliente()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare s record;
begin
  if new.tipo_cliente = 'MAYORISTA' and auth.uid() is not null and not es_admin() then
    raise exception 'Solo un administrador puede crear clientes mayoristas.';
  end if;
  perform pg_advisory_xact_lock(hashtext('tiendaariga.codigo_cliente'));
  s := siguiente_codigo_cliente(new.creado_por);
  if s.codigo is null then
    raise exception 'Se acabó el rango de códigos de cliente de ese vendedor. Pida al administrador que lo amplíe.';
  end if;
  new.id := s.codigo;
  new.consecutivo := s.consecutivo;
  return new;
end;
$$;

-- Al editar: un vendedor no puede volver mayorista a un cliente. Si el admin
-- cambia el dueño, el cliente toma el siguiente consecutivo del nuevo dueño
-- (su código general no cambia).
create or replace function tiendaariga.validar_cambio_cliente()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
begin
  if new.tipo_cliente = 'MAYORISTA' and old.tipo_cliente <> 'MAYORISTA'
     and auth.uid() is not null and not es_admin() then
    raise exception 'Solo un administrador puede marcar clientes como mayoristas.';
  end if;
  if new.creado_por is distinct from old.creado_por then
    perform pg_advisory_xact_lock(hashtext('tiendaariga.codigo_cliente'));
    select coalesce(max(consecutivo), 0) + 1 into new.consecutivo
      from clientes where creado_por is not distinct from new.creado_por;
  end if;
  return new;
end;
$$;
drop trigger if exists clientes_validar_cambio on tiendaariga.clientes;
create trigger clientes_validar_cambio
  before update of tipo_cliente, creado_por on tiendaariga.clientes
  for each row execute function tiendaariga.validar_cambio_cliente();

-- Vista previa en la ficha: código y consecutivo que tendrá el cliente nuevo.
-- Un vendedor solo consulta los suyos; el admin, los de cualquier usuario.
drop function if exists tiendaariga.proximo_codigo_cliente();
drop function if exists tiendaariga.proximo_codigo_cliente(uuid);
create function tiendaariga.proximo_codigo_cliente(p_dueno uuid default null)
returns table (codigo bigint, consecutivo integer)
language sql stable
security definer
set search_path = tiendaariga
as $$
  select s.codigo, s.consecutivo
  from siguiente_codigo_cliente(case when es_admin() then coalesce(p_dueno, auth.uid()) else auth.uid() end) s
  where usuario_activo()
$$;

-- ---------------------------------------------------------------------
-- Crear cliente: con dueño (el admin puede elegir otro usuario) y tipo
-- ---------------------------------------------------------------------
create or replace function tiendaariga.crear_cliente(p_cliente jsonb, p_saldo jsonb default null)
returns tiendaariga.clientes
language plpgsql
set search_path = tiendaariga
as $$
declare
  c        clientes;
  x        clientes := jsonb_populate_record(null::clientes, p_cliente);
  v_valor  numeric := nullif(p_saldo->>'valor','')::numeric;
  v_fecha  date := coalesce(nullif(p_saldo->>'fecha','')::date, (now() at time zone 'America/Guatemala')::date);
begin
  if coalesce(trim(x.nombre),'') = '' then
    raise exception 'El nombre del cliente es obligatorio';
  end if;
  if x.creado_por is not null and x.creado_por is distinct from auth.uid() and not es_admin() then
    raise exception 'Solo un administrador puede crear clientes para otro usuario';
  end if;
  insert into clientes (dpi, nit, nombre, fecha_nacimiento, departamento, telefono, telefono2,
                        direccion, correo, nit2, codigo_cliente, tipo_cliente, creado_por)
  values (x.dpi, x.nit, trim(x.nombre), x.fecha_nacimiento, x.departamento, x.telefono, x.telefono2,
          x.direccion, x.correo, x.nit2, x.codigo_cliente,
          coalesce(nullif(x.tipo_cliente,''), 'MINORISTA'), coalesce(x.creado_por, auth.uid()))
  returning * into c;

  if coalesce(v_valor,0) > 0 then
    insert into ventas (pedido_id, fecha_venta, fecha_vencimiento, tienda, vendedor,
                        cliente_id, cliente, documento_cliente, envio,
                        producto, cantidad, valor_unitario, valor_total)
    values (siguiente_pedido_id(), v_fecha, v_fecha + 30,
            nullif(p_saldo->>'tienda',''), nullif(p_saldo->>'vendedor',''),
            c.id, c.nombre, coalesce(c.dpi, c.nit), 'SI-' || c.id,
            'SALDO INICIAL', 1, v_valor, v_valor);
  end if;
  return c;
end;
$$;

-- ---------------------------------------------------------------------
-- Búsquedas: el vendedor encuentra a sus clientes por su consecutivo
-- ---------------------------------------------------------------------
create or replace function tiendaariga.buscar_clientes(p_termino text)
returns setof tiendaariga.clientes
language sql stable
set search_path = tiendaariga
as $$
  with t as (select lower(trim(coalesce(p_termino,''))) as q)
  select c.*
  from clientes c, t
  where t.q <> ''
    and (c.id::text = t.q
         or (c.consecutivo::text = t.q and c.creado_por = auth.uid())
         or lower(coalesce(c.dpi,'')) like t.q || '%'
         or lower(coalesce(c.nit,'')) like t.q || '%'
         or coalesce(c.telefono,'') like t.q || '%'
         or lower(c.nombre) like '%' || t.q || '%')
  order by (c.consecutivo::text = t.q and c.creado_por = auth.uid()) desc,
           (c.id::text = t.q) desc,
           (lower(coalesce(c.dpi,'')) = t.q or lower(coalesce(c.nit,'')) = t.q) desc,
           c.nombre
  limit 25;
$$;

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
                           or (c.consecutivo::text = t.q and c.creado_por = auth.uid())
          when 'pedido'  then lower(coalesce(v.pedido_id,'')) like '%' || t.q || '%'
          when 'envio'   then lower(coalesce(v.envio,'')) like '%' || t.q || '%'
          else lower(coalesce(c.nombre, v.cliente, '')) like '%' || t.q || '%'
            or v.cliente_id::text = t.q
            or (c.consecutivo::text = t.q and c.creado_por = auth.uid())
            or lower(coalesce(v.pedido_id,'')) like '%' || t.q || '%'
            or lower(coalesce(v.envio,'')) like '%' || t.q || '%'
        end
  group by 1, 2, 3
  order by min(v.fecha_venta) desc nulls last, 2 desc
  limit 100;
$$;

-- ---------------------------------------------------------------------
-- Inteligencia comercial por bodega
-- ---------------------------------------------------------------------
drop function if exists tiendaariga.indicadores_comerciales(date, date);
drop function if exists tiendaariga.indicadores_comerciales(date, date, text);
drop function if exists tiendaariga.gramos_en_transito();
drop function if exists tiendaariga.gramos_en_transito(text);

-- Gramos en tránsito: todos, o los que van HACIA la bodega indicada
create function tiendaariga.gramos_en_transito(p_tienda text default null)
returns table (tipo text, gramos numeric)
language sql stable
security definer
set search_path = tiendaariga
as $$
  select coalesce(nullif(upper(trim(p.tipo)),''), 'SIN TIPO'), sum(t.cantidad)
  from traslados t
  left join productos p on upper(trim(p.nombre)) = upper(trim(t.producto))
  where t.estado = 'ENVIADO' and coalesce(p.unidad, 'GRAMOS') = 'GRAMOS' and usuario_activo()
    and (p_tienda is null or upper(trim(t.destino)) = upper(trim(p_tienda)))
  group by 1
$$;

-- p_tienda null = todas las bodegas. La cartera de una bodega es la de los
-- clientes cuya última compra fue en esa bodega.
create function tiendaariga.indicadores_comerciales(p_desde date default null, p_hasta date default null,
                                                    p_tienda text default null)
returns jsonb
language sql stable
set search_path = tiendaariga
as $$
  with vg as (   -- ventas de referencias que se venden por gramo
    select v.fecha_venta,
           coalesce(nullif(upper(trim(p.tipo)),''), nullif(upper(trim(rtrim(trim(v.tipo), '.'))),''), 'SIN TIPO') as tipo,
           v.cantidad, v.valor_total
    from ventas v
    join productos p on upper(trim(p.nombre)) = upper(trim(v.producto))
    where p.unidad = 'GRAMOS'
      and upper(trim(v.producto)) <> 'SALDO INICIAL'
      and coalesce(v.cantidad, 0) > 0 and coalesce(v.valor_total, 0) > 0
      and (p_tienda is null or upper(trim(v.tienda)) = upper(trim(p_tienda)))
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
    where p_tienda is null
       or cc.codigo in (select cliente_id from ultima_bodega where upper(trim(tienda)) = upper(trim(p_tienda)))
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

-- Permisos
revoke execute on function tiendaariga.siguiente_codigo_cliente(uuid)                from public, anon, authenticated;
revoke execute on function tiendaariga.validar_cambio_cliente()                      from public, anon, authenticated;
revoke execute on function tiendaariga.proximo_codigo_cliente(uuid)                  from public, anon;
revoke execute on function tiendaariga.buscar_pedidos(text, text)                    from public, anon;
revoke execute on function tiendaariga.gramos_en_transito(text)                      from public, anon;
revoke execute on function tiendaariga.indicadores_comerciales(date, date, text)     from public, anon;
grant  execute on function tiendaariga.proximo_codigo_cliente(uuid)                  to authenticated;
grant  execute on function tiendaariga.buscar_pedidos(text, text)                    to authenticated;
grant  execute on function tiendaariga.gramos_en_transito(text)                      to authenticated;
grant  execute on function tiendaariga.indicadores_comerciales(date, date, text)     to authenticated;

notify pgrst, 'reload schema';
