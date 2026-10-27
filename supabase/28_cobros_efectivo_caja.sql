-- =====================================================================
--  Joyería ARIGA - Actualización 28: COBROS EN EFECTIVO A LA CAJA MENOR
--  * Todo pago con método EFECTIVO registrado en Pagos (abono a cartera)
--    entra a la caja menor de quien lo registró (origen PAGO). Si el pago se
--    edita, se mueve, se divide o se elimina, la caja se ajusta sola.
--  * Los pagos que genera una venta en efectivo ya entran por la venta
--    (origen VENTA) y no se duplican.
--  * Carga los cobros en efectivo registrados desde que existe la caja menor
--    (18-oct-2026) que todavía no estaban en la caja.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 27. Se puede repetir.
-- =====================================================================

alter table tiendaariga.caja_menor drop constraint if exists caja_menor_origen_check;
alter table tiendaariga.caja_menor add constraint caja_menor_origen_check check (origen in ('VENTA', 'MANUAL', 'PAGO'));

-- ¿El pago es un cobro en efectivo que debe ir a la caja? (no los de ventas en efectivo)
drop function if exists tiendaariga.es_cobro_efectivo(tiendaariga.pagos);
create or replace function tiendaariga.es_cobro_efectivo(p_metodo text, p_valor numeric, p_creado_por uuid, p_observaciones text)
returns boolean
language sql immutable
as $$
  select upper(trim(coalesce(p_metodo, ''))) = 'EFECTIVO'
     and coalesce(p_valor, 0) > 0
     and p_creado_por is not null
     and coalesce(p_observaciones, '') not like 'Venta en efectivo%'
$$;

create or replace function tiendaariga.sincronizar_cobro_efectivo()
returns trigger
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  v_cliente text;
  v_concepto text;
begin
  if tg_op = 'DELETE' then
    delete from caja_menor where pago_id = old.id and origen = 'PAGO';
    return old;
  end if;

  if not es_cobro_efectivo(new.metodo_pago, new.valor_pagado, new.creado_por, new.observaciones) then
    delete from caja_menor where pago_id = new.id and origen = 'PAGO';
    return new;
  end if;

  select nombre into v_cliente from clientes where id = new.cliente_id;
  v_concepto := concat_ws(' · ', 'Cobro en efectivo', v_cliente, 'envío ' || nullif(trim(new.envio), ''),
                          'boleta ' || nullif(trim(new.boleta), ''));
  update caja_menor
     set fecha = coalesce(new.fecha_pago, fecha), usuario_id = new.creado_por, valor = new.valor_pagado, concepto = v_concepto
   where pago_id = new.id and origen = 'PAGO';
  if not found then
    insert into caja_menor (fecha, usuario_id, tipo, origen, valor, concepto, pago_id, creado_por)
    values (coalesce(new.fecha_pago, (now() at time zone 'America/Guatemala')::date), new.creado_por, 'ENTRADA', 'PAGO',
            new.valor_pagado, v_concepto, new.id, new.creado_por);
  end if;
  return new;
end;
$$;
revoke execute on function tiendaariga.sincronizar_cobro_efectivo() from public, anon, authenticated;

-- Al eliminar el pago se quita antes (la referencia de la caja se borraría primero)
drop trigger if exists pagos_cobro_efectivo_del on tiendaariga.pagos;
create trigger pagos_cobro_efectivo_del
  before delete on tiendaariga.pagos
  for each row execute function tiendaariga.sincronizar_cobro_efectivo();
drop trigger if exists pagos_cobro_efectivo on tiendaariga.pagos;
create trigger pagos_cobro_efectivo
  after insert or update of metodo_pago, valor_pagado, fecha_pago, creado_por, observaciones, envio, boleta, cliente_id
  on tiendaariga.pagos
  for each row execute function tiendaariga.sincronizar_cobro_efectivo();

-- Cobros en efectivo ya registrados desde que existe la caja menor
do $$
declare n int;
begin
  insert into tiendaariga.caja_menor (fecha, usuario_id, tipo, origen, valor, concepto, pago_id, creado_por, created_at)
  select coalesce(p.fecha_pago, p.created_at::date), p.creado_por, 'ENTRADA', 'PAGO', p.valor_pagado,
         concat_ws(' · ', 'Cobro en efectivo', c.nombre, 'envío ' || nullif(trim(p.envio), ''), 'boleta ' || nullif(trim(p.boleta), '')),
         p.id, p.creado_por, p.created_at
  from tiendaariga.pagos p
  left join tiendaariga.clientes c on c.id = p.cliente_id
  join tiendaariga.perfiles u on u.id = p.creado_por
  where tiendaariga.es_cobro_efectivo(p.metodo_pago, p.valor_pagado, p.creado_por, p.observaciones)
    and p.created_at >= '2026-10-18'
    and not exists (select 1 from tiendaariga.caja_menor m where m.pago_id = p.id);
  get diagnostics n = row_count;
  raise notice 'Cobros en efectivo cargados a la caja menor: %', n;
end $$;

notify pgrst, 'reload schema';

-- Resultado: efectivo en caja por usuario
select usuario, entradas, salidas, saldo from tiendaariga.caja_menor_saldos where movimientos > 0 order by saldo desc;
