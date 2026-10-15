-- =====================================================================
--  Joyería ARIGA - Actualización 18: EDITAR EL SALDO INICIAL DEL CLIENTE
--  * El saldo pendiente con el que se creó un cliente (venta "SALDO
--    INICIAL", envío SI-<código>) se puede cambiar al editar el cliente:
--    valor, fecha, tienda y vendedor. Si no tenía, se crea; en 0 se elimina.
--  * No puede quedar por debajo de lo que ya se abonó a ese saldo.
--  * Lo puede hacer el dueño del cliente o un administrador.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 17. Se puede repetir.
-- =====================================================================

create or replace function tiendaariga.guardar_saldo_inicial(p_cliente bigint, p_saldo jsonb)
returns numeric
language plpgsql
security definer
set search_path = tiendaariga
as $$
declare
  c        clientes;
  v        ventas;
  n        int;
  v_valor  numeric := coalesce(nullif(p_saldo->>'valor', '')::numeric, 0);
  v_fecha  date := coalesce(nullif(p_saldo->>'fecha', '')::date, (now() at time zone 'America/Guatemala')::date);
  v_envio  text;
  v_pagado numeric;
begin
  select * into c from clientes where id = p_cliente;
  if not found then
    raise exception 'El cliente % no existe.', p_cliente;
  end if;
  if not (es_admin() or (usuario_activo() and c.creado_por = auth.uid())) then
    raise exception 'Solo el dueño del cliente o un administrador puede cambiar su saldo inicial.';
  end if;
  if v_valor < 0 then
    raise exception 'El saldo inicial no puede ser negativo.';
  end if;

  select count(*) into n from ventas where cliente_id = c.id and upper(trim(producto)) = 'SALDO INICIAL';
  if n > 1 then
    raise exception 'El cliente tiene % registros de saldo inicial; el administrador debe corregirlos en Histórico > Ventas.', n;
  end if;
  select * into v from ventas where cliente_id = c.id and upper(trim(producto)) = 'SALDO INICIAL';
  v_envio := coalesce(nullif(trim(v.envio), ''), v.pedido_id, 'SI-' || c.id);

  -- Lo ya abonado a este saldo (pagos y devoluciones del envío)
  select coalesce((select sum(valor_pagado) from pagos where cliente_id = c.id and trim(envio) = v_envio), 0)
       + coalesce((select sum(valor) from devoluciones where trim(envio) = v_envio), 0)
    into v_pagado;
  if v_valor < v_pagado - 0.005 then
    raise exception 'A este saldo inicial ya se le abonaron Q%; el nuevo valor no puede ser menor.', to_char(v_pagado, 'FM999G999G990D00');
  end if;

  if v.id is null then
    if v_valor > 0 then
      insert into ventas (pedido_id, fecha_venta, fecha_vencimiento, tienda, vendedor,
                          cliente_id, cliente, documento_cliente, envio,
                          producto, cantidad, valor_unitario, valor_total, creado_por)
      values (siguiente_pedido_id(), v_fecha, v_fecha + 30,
              nullif(p_saldo->>'tienda', ''), nullif(p_saldo->>'vendedor', ''),
              c.id, c.nombre, coalesce(c.dpi, c.nit), 'SI-' || c.id,
              'SALDO INICIAL', 1, v_valor, v_valor, coalesce(c.creado_por, auth.uid()));
    end if;
  elsif v_valor = 0 then
    delete from ventas where id = v.id;
  else
    update ventas
       set valor_unitario = v_valor, valor_total = v_valor, cantidad = 1,
           fecha_venta = v_fecha, fecha_vencimiento = v_fecha + 30,
           tienda = nullif(p_saldo->>'tienda', ''), vendedor = nullif(p_saldo->>'vendedor', ''),
           cliente = c.nombre
     where id = v.id;
  end if;

  return v_valor - v_pagado;   -- lo que queda pendiente del saldo inicial
end;
$$;

revoke execute on function tiendaariga.guardar_saldo_inicial(bigint, jsonb) from public, anon;
grant  execute on function tiendaariga.guardar_saldo_inicial(bigint, jsonb) to authenticated;

notify pgrst, 'reload schema';
