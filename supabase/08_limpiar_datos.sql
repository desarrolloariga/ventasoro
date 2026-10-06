-- =====================================================================
--  Joyería ARIGA - Actualización 08: LIMPIEZA DE DATOS (no se puede deshacer)
--
--  BORRA:     ventas, pagos (recibos), devoluciones, clientes, cargas de
--             inventario, traslados, devoluciones a oficina y fechas de corte
--             de inventario. Los códigos y consecutivos vuelven a empezar.
--  CONSERVA:  usuarios y sus contraseñas, rangos y bodegas asignadas;
--             tiendas/bodegas, vendedores, referencias (productos), tipos,
--             métodos de pago, departamentos y coordenadas.
--
--  SEGURO: para ejecutarlo, cambie 'NO' por 'BORRAR' en la línea indicada.
--  Después de usarlo, vuelva a dejar 'NO' para que no se ejecute otra vez.
--
--  Ejecutar en Supabase > SQL Editor DESPUÉS de 07.
-- =====================================================================

do $$
declare
  confirmar text := 'NO';   -- <<< cambie 'NO' por 'BORRAR' para ejecutar
begin
  if confirmar <> 'BORRAR' then
    raise exception 'No se borró nada. Para limpiar los datos cambie ''NO'' por ''BORRAR'' en la línea "confirmar" y ejecute de nuevo.';
  end if;

  truncate table
    tiendaariga.ventas,
    tiendaariga.pagos,
    tiendaariga.devoluciones,
    tiendaariga.clientes,
    tiendaariga.ingresos_inventario,
    tiendaariga.traslados,
    tiendaariga.devoluciones_oficina,
    tiendaariga.inventario_items
  restart identity;

  raise notice 'Datos operativos borrados. Se conservaron usuarios, bodegas, vendedores, referencias y demás maestros.';
end $$;

notify pgrst, 'reload schema';
