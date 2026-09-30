# Joyería ARIGA - Registro de ventas (Supabase)

Réplica de la aplicación de Apps Script "Aplicación Ariga", usando Supabase
(esquema `tiendaariga`) en lugar de la hoja "Registro de ventas 2do".

## Estructura

| Archivo | Qué es |
|---|---|
| `index.html`, `css/estilos.css`, `js/app.js` | La aplicación web (equivale a `Index.html` + `CSS.html` + `Código.gs`) |
| `js/config.js` | URL de Supabase, clave publicable y esquema |
| `supabase/01_esquema.sql` | Tablas, vistas, funciones y seguridad |
| `supabase/02_datos_*.sql` | Datos del Excel (generados) |
| `scripts/generar_datos_sql.py` | Regenera `02_datos_*.sql` desde el Excel |

## Pestañas

Venta, Buscar Pedido, Pagos, **Clientes** (listado, búsqueda, crear y editar),
Histórico, Cartera, Inventario y **Datos** (cualquier tabla o vista en bruto).
Histórico, Cartera, Clientes y Datos tienen botón **Exportar a Excel**, que
descarga lo que está filtrado en pantalla.

## Hojas → tablas

| Hoja | En Supabase |
|---|---|
| Maestros | `tiendas`, `tipos`, `vendedores`, `productos`, `metodos_pago` |
| Clientes | `clientes` |
| Ventas | `ventas` |
| Pagos | `pagos` |
| Devoluciones | `devoluciones` |
| Ingresos de inventario | `ingresos_inventario` |
| Devolución a oficina | `devoluciones_oficina` |
| Coordenadas | `coordenadas` |
| Cartera 1 | vista `cartera_detalle` |
| Cartera 2 | vista `cartera_total` |
| Inventario | tabla `inventario_items` (tienda, producto y fecha de corte) + vista `inventario` |

Funciones: `buscar_cliente`, `registrar_venta` (genera el Id `yyyyMMdd-NNN`),
`actualizar_venta` y `eliminar_pedido`.

## Instalación

1. **Crear la base**: en Supabase → *SQL Editor*, ejecutar `supabase/01_esquema.sql`.
2. **Cargar datos**: ejecutar en orden `02_datos_1.sql` … `02_datos_7.sql`.
   El primero vacía las tablas, así que la carga se puede repetir.
3. **Exponer el esquema**: *Project Settings → Data API → Exposed schemas*:
   debe incluir `tiendaariga` (ya estaba expuesto al momento de crear esto).
4. **Publicar la web**: ver *Despliegue en Vercel*. Para probar en local:
   `npx serve .` y abrir http://localhost:3000.

## Despliegue en Vercel

Es un sitio estático; el único paso de build genera `js/config.js` desde las variables de entorno.

1. Subir el repositorio a GitHub (privado).
2. En https://vercel.com/new → *Import Git Repository* → elegir el repositorio.
3. En *Environment Variables*, pegar:
   ```
   SUPABASE_URL=https://aijexrcfmakphpqihkig.supabase.co
   SUPABASE_KEY=sb_publishable_ipr6oXXU484KmKMPigiM5g_dwBiJm_b
   SUPABASE_SCHEMA=tiendaariga
   ZONA_HORARIA=America/Guatemala
   ```
   El resto de la configuración (build, carpeta `dist/`) ya viene en `vercel.json`.
   Si falta una variable se usa el valor de `js/config.js`. El build falla a
   propósito si `SUPABASE_KEY` es una clave secreta.
4. *Deploy*. Cada `git push` a `main` vuelve a publicar automáticamente, y cada
   rama o pull request genera una URL de vista previa.

`vercel.json` agrega encabezados de seguridad (incluida una Content-Security-Policy
que solo permite jsDelivr, Google Fonts, imgur y proyectos *.supabase.co). Si se
agrega otro CDN, hay que actualizarla.
`.vercelignore` evita publicar `supabase/` y este README; solo se sirve la carpeta `dist/` que genera el build.

## Datos de clientes y git

`supabase/02_datos_*.sql` contiene DPI, nombres y teléfonos de clientes, por eso
está en `.gitignore` y nunca se sube. Para recrearlos en otra máquina:
`python scripts/generar_datos_sql.py "ruta/al/Registro de ventas 2do.xlsx"`.

## Seguridad

**Acceso libre, sin inicio de sesión y sin RLS.** El rol `anon` (clave
publicable) tiene lectura y escritura completas sobre todas las tablas. Como la
clave va en la página y el repositorio es público, cualquier persona puede leer
los datos de clientes (DPI, teléfonos), y modificar o borrar ventas y pagos
directamente contra la API de Supabase, sin pasar por la app.

Para volver a proteger la base: activar RLS en las tablas y crear políticas
(ver el historial de git de `supabase/01_esquema.sql`, versión con login).

## Diferencias con la versión de Apps Script

- Al **actualizar** una venta se conservan la fecha de venta y el vencimiento
  originales (antes se reemplazaban por la fecha del día).
- Si en una actualización se cambia el número de envío, se actualiza el pedido
  correcto (antes buscaba por el envío nuevo y fallaba).
- El formulario de cliente nuevo guarda también la fecha de nacimiento, el
  departamento y el teléfono.
- En Pagos se muestran también el total pagado y el saldo del envío.
- Cartera e Inventario se calculan en vivo. Los nombres se comparan sin
  espacios sobrantes, por eso el inventario puede diferir del Excel (en el Excel,
  las ventas con `"BODEGA PABLO ARIAS "` con espacio no se descontaban).
- La cartera agrupa por envío, tienda y cliente. La hoja agrupaba además por
  fecha, lo que duplicaba los pagos de envíos vendidos en fechas distintas.
- El inventario también descuenta la columna *Salida* de Ingresos y la hoja
  *Devolución a oficina* (hoy ambas están vacías).
- La zona horaria de las fechas es America/Guatemala (antes GMT-5).

## Datos que no se pudieron convertir

Las fechas o montos escritos a mano (por ejemplo `31/04/2025`, `#VALUE!` o
`1,705.5/1,645.07`) quedaron en NULL y el texto original quedó en la columna
`nota_importacion`. Los años mal digitados (`0205`, `1015`) se corrigieron a 2025.
Para revisarlos:

```sql
select 'ventas' tabla, id, nota_importacion from tiendaariga.ventas where nota_importacion is not null
union all
select 'pagos', id, nota_importacion from tiendaariga.pagos where nota_importacion is not null
union all
select 'clientes', id, nota_importacion from tiendaariga.clientes where nota_importacion is not null;
```
