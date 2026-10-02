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

Venta, Buscar Pedido, Pagos, Clientes, Histórico, Cartera, Inventario, Maestros
y, solo para administradores, Usuarios y Datos.

- **Clientes**: cada cliente tiene un **código** automático (consecutivo único,
  `clientes.id`). Ficha con DPI, NIT, teléfonos, correo, dirección y
  departamento. Al crearlo se puede indicar un **saldo pendiente inicial**, que
  queda como una venta "SALDO INICIAL" (envío `SI-<código>`).
- **Venta / Pagos / Estado de cuenta**: buscador de clientes por código,
  nombre, DPI, NIT o teléfono (muestra la lista si hay varios).
- **Buscar Pedido**: por envío, Id de pedido, nombre o código del cliente; la
  lista muestra la fecha de venta. Al abrir un pedido se ve su fecha.
- **Pagos**: el pago es un **abono al total del cliente** (opcionalmente
  aplicado a un envío). Muestra cuánto debe y cómo queda tras el pago.
  **Pagos Recibidos**: filtro por fechas, método, usuario y cliente, con totales
  por método de pago y por usuario (para saber cuánto hay que liquidar).
- **Cartera**: Saldos por Cliente, Estado de Cuenta (compras, pagos y saldo
  acumulado) y Por Envío.
- **Histórico**: incluye el código del cliente y se puede filtrar por él.
- **Maestros**: tiendas, bodegas, vendedores, métodos de pago, tipos y
  departamentos (agregar, activar/desactivar, eliminar si no están en uso).
- Todas las listas desplegables de los formularios terminan con **+ Crear
  nuevo…**.
- Histórico, Cartera, Pagos Recibidos, Clientes, Inventario y Datos tienen
  **Exportar a Excel** (exporta lo filtrado en pantalla).

## Inventario

- **Referencias**: la tabla `productos` es el catálogo de referencias (nombre,
  código, tipo, unidad, controla inventario, activa). Solo las activas aparecen
  al vender. El nombre no se puede cambiar porque las ventas lo guardan.
- **Cargar inventario**: entradas (compras, inventario inicial, traslados) y
  salidas/ajustes por tienda y referencia (tabla `ingresos_inventario`).
- **Saldos** (vista `inventario`): entradas − (ventas + salidas + devoluciones a
  oficina), por tienda y referencia o total por referencia.
- **Movimientos** (vista `inventario_movimientos`): kardex con saldo acumulado.
- Cada tienda/referencia descuenta ventas desde su **fecha de inicio**: la de la
  hoja original (`inventario_items`) o, si no tiene, la de su primera carga.
- Al registrar una venta nueva, si no hay saldo suficiente la app avisa y pide
  confirmación (no bloquea).

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
| Cartera 1 | vista `cartera_detalle` (por envío) |
| Cartera 2 | vistas `cartera_clientes` y `estado_cuenta` (por cliente) |
| Inventario | tabla `inventario_items` (tienda, producto y fecha de corte) + vista `inventario` |

Funciones: `buscar_clientes`, `crear_cliente`, `registrar_venta` (genera el Id
`yyyyMMdd-NNN`), `actualizar_venta`, `eliminar_pedido`, `buscar_pedidos`,
`lineas_pedido`, `vincular_clientes`, `admin_agregar_usuario` y `hacer_admin`.
Usuarios: tabla `perfiles`. Pagos recibidos: vista `pagos_detalle`.

## Instalación

1. **Crear o actualizar la base**: en Supabase → *SQL Editor*, ejecutar
   `supabase/01_esquema.sql`. Se puede repetir sin perder datos.
2. **Cargar datos del Excel** (solo la primera vez): ejecutar en orden
   `02_datos_1.sql` … `02_datos_7.sql`. El primero vacía las tablas. El último
   vincula ventas y pagos importados con su cliente (`vincular_clientes()`).
3. **Exponer el esquema**: *Project Settings → Data API → Exposed schemas* debe
   incluir `tiendaariga`.
4. **Actualizaciones**: ejecutar en orden los scripts `03_…`, `04_…` de
   `supabase/` (ver *Actualizaciones de la base*).
5. **Administrador inicial**: lo crea `03_usuarios_y_pedidos.sql`:
   usuario **admin**, contraseña **admin123**. Cámbiela al entrar (botón
   *Contraseña* de la barra superior). Los vendedores se crean desde la pestaña
   **Usuarios** con usuario y contraseña; no se necesitan correos ni configurar
   el envío de correos de Supabase.
6. **Publicar la web**: ver *Despliegue en Vercel*. Para probar en local:
   `npx serve .` y abrir http://localhost:3000.

## Actualizaciones de la base

`01_esquema.sql` es la base inicial. Cada cambio posterior va en **un script
propio y numerado**, que se ejecuta una vez en el SQL Editor, en orden, y se
puede repetir sin dañar datos:

| Script | Qué hace |
|---|---|
| `03_usuarios_y_pedidos.sql` | Usuarios con nombre de usuario (sin correo), administrador inicial `admin` / `admin123`, creación de vendedores y cambio de contraseñas por el admin, búsqueda de pedidos por cliente, código de cliente, número de pedido o envío. |

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

- Hay que **iniciar sesión** con usuario y contraseña (Supabase Auth; el
  usuario `maria` se guarda internamente como `maria@ariga.local`). Un usuario de Auth solo entra a
  ARIGA si tiene un perfil activo en `tiendaariga.perfiles`; sin sesión (clave
  publicable sola) no se puede leer ni escribir nada.
- **Roles**: *admin* ve y edita todo; *vendedor* ve solo los clientes que creó,
  con sus ventas y pagos. El administrador puede reasignar un cliente a otro
  usuario desde su ficha.
- Maestros, referencias e inventario son compartidos entre usuarios activos. Los
  saldos de inventario se calculan con todas las ventas (sin mostrar clientes
  ajenos).
- Los clientes y ventas importados del Excel no tienen dueño: solo los ve el
  administrador, que puede asignarlos.
- Todo está aplicado con RLS en la base, no solo en la app.

## Pagos antiguos

En la hoja, muchos abonos se registraron con el **nombre del cliente** en la
columna ENVÍO. Al cargar los datos se vinculan con su cliente cuando el nombre
coincide con un solo cliente (quedan marcados en `nota_importacion`). Los
restantes se asignan a mano: *Pagos → Pagos Recibidos → "Solo pagos antiguos
sin cliente asignado" → Asignar cliente* (administradores).

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
