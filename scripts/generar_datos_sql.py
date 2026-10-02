"""
Convierte "Registro de ventas 2do.xlsx" en archivos SQL de carga para el
esquema tiendaariga (supabase/02_datos_*.sql).

Uso:
    python scripts/generar_datos_sql.py "C:/Users/Personal/Downloads/Registro de ventas 2do.xlsx"

Los valores que no se pueden convertir (fechas o montos escritos a mano) se
dejan en NULL y el texto original queda en la columna nota_importacion.
"""
import datetime as dt
import json
import re
import sys
import warnings
from pathlib import Path

import openpyxl

warnings.filterwarnings("ignore")

SALIDA = Path(__file__).resolve().parent.parent / "supabase"
FILAS_POR_ARCHIVO = 1500


# ---------------------------------------------------------------- conversores
def texto(v):
    """Texto limpio; los números enteros guardados como float pierden el '.0'."""
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime("%Y-%m-%d")
    s = str(v).replace("\ufeff", "").strip()
    return s or None


def numero(v, notas, campo):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return round(float(v), 2)
    s = str(v).replace("\ufeff", "").strip()
    if not s:
        return None
    if re.fullmatch(r"-?\d+,\d{2}", s):  # coma decimal: "2762,60"
        notas.append(f"{campo}={s} (coma decimal)")
        return round(float(s.replace(",", ".")), 2)
    if re.fullmatch(r"-?[\d,]*\.?\d+", s):
        return round(float(s.replace(",", "")), 2)
    notas.append(f"{campo}={s}")
    return None


def fecha(v, notas, campo):
    if v is None or v == "":
        return None
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime("%Y-%m-%d")
    s = str(v).strip()
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", s)
    if m:
        d, mth, y = map(int, m.groups())
        corregido = y < 1900  # años mal digitados: 0205, 1015 -> 2025
        if corregido:
            y = 2025
        try:
            r = dt.date(y, mth, d).isoformat()
            if corregido:
                notas.append(f"{campo}={s} (año corregido a 2025)")
            return r
        except ValueError:
            pass
    notas.append(f"{campo}={s}")
    return None


def nota(notas):
    return "; ".join(notas) or None


# ---------------------------------------------------------------- lectura
def filas(ws, desde=2):
    for r in ws.iter_rows(min_row=desde, values_only=True):
        if any(x not in (None, "") for x in r):
            yield r


def columna_unica(ws, idx):
    vistos, out = set(), []
    for r in ws.iter_rows(min_row=2, values_only=True):
        v = texto(r[idx]) if idx < len(r) else None
        if v and v not in vistos:
            vistos.add(v)
            out.append({"nombre": v, "orden": len(out) + 1})
    return out


def leer(ruta):
    wb = openpyxl.load_workbook(ruta, data_only=True)
    wbf = openpyxl.load_workbook(ruta)  # fórmulas (para fechas de Inventario)
    datos = {}

    m = wb["Maestros"]
    datos["tiendas"] = columna_unica(m, 0)
    datos["tipos"] = columna_unica(m, 1)
    datos["vendedores"] = columna_unica(m, 2)
    datos["productos"] = columna_unica(m, 3)
    datos["metodos_pago"] = columna_unica(m, 4)

    out = []
    for r in filas(wb["Clientes"]):
        n = []
        nombre = texto(r[2])
        if not nombre:
            continue
        out.append({
            "dpi": texto(r[0]), "nit": texto(r[1]), "nombre": nombre,
            "fecha_nacimiento": None if texto(r[3]) in (None, "?") else fecha(r[3], n, "fecha_nacimiento"),
            "departamento": texto(r[4]), "telefono": texto(r[5]),
            "nit2": texto(r[6]), "codigo_cliente": texto(r[7]),
            "nota_importacion": nota(n),
        })
    datos["clientes"] = out

    out = []
    for r in filas(wb["Ventas"]):
        if not any(x not in (None, "") for x in r[:14]):
            continue
        n = []
        out.append({
            "pedido_id": texto(r[0]),
            "fecha_venta": fecha(r[1], n, "fecha_venta"),
            "fecha_vencimiento": fecha(r[2], n, "fecha_vencimiento"),
            "tienda": texto(r[3]), "vendedor": texto(r[4]), "cliente": texto(r[5]),
            "documento_cliente": texto(r[6]), "factura": texto(r[7]), "envio": texto(r[8]),
            "tipo": texto(r[9]), "producto": texto(r[10]),
            "cantidad": numero(r[11], n, "cantidad"),
            "valor_unitario": numero(r[12], n, "valor_unitario"),
            "valor_total": numero(r[13], n, "valor_total"),
            "nota_importacion": nota(n),
        })
    datos["ventas"] = out

    out = []
    for r in filas(wb["Pagos"]):
        if texto(r[0]) == "Fecha de boleta":  # encabezado repetido
            continue
        n = []
        out.append({
            "fecha_pago": fecha(r[0], n, "fecha_pago"),
            "envio": texto(r[1]), "factura": texto(r[2]), "metodo_pago": texto(r[3]),
            "tipo": texto(r[4]), "valor_pagado": numero(r[5], n, "valor_pagado"),
            "boleta": texto(r[6]), "contabilidad": texto(r[7]), "vendedor": texto(r[8]),
            "nit": texto(r[9]), "confirmacion": texto(r[10]),
            "observaciones": texto(r[11]) if len(r) > 11 else None,
            "nota_importacion": nota(n),
        })
    datos["pagos"] = out

    out = []
    for r in filas(wb["Devoluciones"]):
        n = []
        out.append({
            "tienda": texto(r[0]), "pedido_id": texto(r[1]),
            "fecha_devolucion": fecha(r[2], n, "fecha"), "factura": texto(r[3]),
            "envio": texto(r[4]), "producto": texto(r[5]),
            "valor": numero(r[6], n, "valor"), "gramos": numero(r[7], n, "gramos"),
            "motivo": texto(r[8]),
        })
    datos["devoluciones"] = out

    out = []
    for r in filas(wb["Ingresos de inventario"]):
        n = []
        out.append({
            "fecha": fecha(r[0], n, "fecha"), "producto": texto(r[1]), "tienda": texto(r[2]),
            "concepto": texto(r[3]), "entrada": numero(r[4], n, "entrada"),
            "salida": numero(r[5], n, "salida"),
        })
    datos["ingresos_inventario"] = out

    hoja_dev = next(ws for ws in wb.worksheets if ws.title.startswith("Devoluci") and ws.title != "Devoluciones")
    out = []
    for r in filas(hoja_dev):
        n = []
        out.append({
            "fecha_devolucion": fecha(r[0], n, "fecha"), "tienda": texto(r[1]),
            "producto": texto(r[2]), "cantidad": numero(r[3], n, "cantidad"),
        })
    datos["devoluciones_oficina"] = out

    # Inventario: la fecha de corte está dentro de la fórmula SUMIFS (dd/mm/yyyy)
    out = []
    for r in filas(wbf["Inventario"]):
        m_ = re.search(r'">=(\d{1,2})/(\d{1,2})/(\d{4})"', str(r[3]))
        if not (r[0] and r[1] and m_):
            continue
        d, mth, y = map(int, m_.groups())
        out.append({"tienda": texto(r[0]), "producto": texto(r[1]),
                    "fecha_inicio": dt.date(y, mth, d).isoformat()})
    datos["inventario_items"] = out

    out = []
    for r in filas(wb["Coordenadas"]):
        n = []
        out.append({"departamento": texto(r[0]),
                    "latitud": float(texto(r[1])), "longitud": float(texto(r[2]))})
    datos["coordenadas"] = out

    # Error de digitación en la hoja de inventario
    for t in ("ingresos_inventario", "inventario_items"):
        for r in datos[t]:
            if (r["producto"] or "").upper() == "GRAMO ESPEDCIAL":
                r["producto"] = "GRAMO ESPECIAL"

    # Tiendas y bodegas son lo mismo; la clase solo las distingue
    for t in datos["tiendas"]:
        t["clase"] = "BODEGA" if t["nombre"].upper().startswith("BODEGA") else "TIENDA"

    # Referencias: tipo = el más usado en las ventas de ese producto
    conteo = {}
    for v in datos["ventas"]:
        if v["producto"] and v["tipo"]:
            k = (v["producto"].upper(), v["tipo"].rstrip("."))
            conteo[k] = conteo.get(k, 0) + 1
    for p in datos["productos"]:
        tipos = sorted(((n, t) for (prod, t), n in conteo.items() if prod == p["nombre"].upper()), reverse=True)
        p["tipo"] = tipos[0][1] if tipos else None
        p["unidad"] = "GRAMOS" if p["nombre"].upper().startswith(("GRAMO", "ORO")) else "UNIDADES"
        p["controla_inventario"] = p["nombre"].upper() not in ("SALDO INICIAL", "SERVICIO JOYERIA")
    return datos


# ---------------------------------------------------------------- escritura
def insert(tabla, registros):
    cols = list(registros[0].keys())
    lista = ", ".join(cols)
    js = json.dumps(registros, ensure_ascii=False)
    assert "$json$" not in js
    return (f"insert into tiendaariga.{tabla} ({lista})\n"
            f"select {lista} from jsonb_populate_recordset(null::tiendaariga.{tabla}, $json$"
            f"{js}$json$::jsonb);\n")


def main(ruta):
    datos = leer(ruta)
    orden = ["tiendas", "tipos", "vendedores", "productos", "metodos_pago", "coordenadas",
             "inventario_items", "ingresos_inventario", "devoluciones_oficina",
             "clientes", "devoluciones", "pagos", "ventas"]

    bloques = []
    for t in orden:
        regs = datos[t]
        for i in range(0, len(regs), FILAS_POR_ARCHIVO):
            bloques.append((t, regs[i:i + FILAS_POR_ARCHIVO]))

    for f in SALIDA.glob("02_datos_*.sql"):
        f.unlink()

    # Agrupa bloques en archivos de ~FILAS_POR_ARCHIVO filas
    archivos, actual, n = [], [], 0
    for t, regs in bloques:
        if actual and n + len(regs) > FILAS_POR_ARCHIVO:
            archivos.append(actual)
            actual, n = [], 0
        actual.append((t, regs))
        n += len(regs)
    archivos.append(actual)

    for i, contenido in enumerate(archivos, 1):
        partes = [f"-- Carga de datos {i}/{len(archivos)} (generado desde Excel)\n"]
        if i == 1:
            partes.append("-- Vacía las tablas antes de cargar (permite re-ejecutar la carga)\n"
                          "truncate " + ", ".join(f"tiendaariga.{t}" for t in orden) +
                          " restart identity;\n\n")
        for t, regs in contenido:
            partes.append(insert(t, regs) + "\n")
        if i == len(archivos):
            partes.append("-- Vincula ventas y pagos importados con su cliente (saldo por cliente)\n"
                          "select tiendaariga.vincular_clientes();\n")
        (SALIDA / f"02_datos_{i}.sql").write_text("".join(partes), encoding="utf-8")

    for t in orden:
        malos = sum(1 for r in datos[t] if r.get("nota_importacion"))
        print(f"{t:22} {len(datos[t]):5} filas" + (f"  ({malos} con nota_importacion)" if malos else ""))
    print(f"{len(archivos)} archivos generados en {SALIDA}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else
         str(Path.home() / "Downloads" / "Registro de ventas 2do.xlsx"))
