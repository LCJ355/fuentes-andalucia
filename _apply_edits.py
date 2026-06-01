"""
Apply corrections from correcciones.json to FUENTES_Andalucia.accdb,
then regenerate fuentes_complete.json and fuentes_complete.js.

Usage:
  python _apply_edits.py [correcciones.json]

If no file is given, defaults to correcciones.json in the same directory.
"""
import sys, os, json, math, pyodbc

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    corrections_file = sys.argv[1] if len(sys.argv) > 1 else 'correcciones.json'
    if not os.path.exists(corrections_file):
        print(f'Error: {corrections_file} not found')
        print('Exporta las correcciones desde la app web primero (boton 📥)')
        sys.exit(1)

    with open(corrections_file, 'r', encoding='utf-8') as f:
        corrections = json.load(f)

    if not corrections:
        print('No hay correcciones para aplicar')
        return

    accdb_path = os.path.abspath('FUENTES_Andalucia.accdb')
    if not os.path.exists(accdb_path):
        print(f'Error: {accdb_path} not found')
        sys.exit(1)

    print(f'Aplicando {len(corrections)} correcciones a {os.path.basename(accdb_path)}...')

    conn = pyodbc.connect(
        f'Driver={{Microsoft Access Driver (*.mdb, *.accdb)}};DBQ={accdb_path};'
    )
    cursor = conn.cursor()

    # Get column info for data type handling
    col_info = {}
    for row in cursor.columns('Fuentes'):
        col_info[row.column_name] = row.type_name

    NUMERIC_TYPES = {'INTEGER', 'LONG', 'SHORT', 'SINGLE', 'DOUBLE', 'DECIMAL', 'BYTE', 'COUNTER'}

    updated = 0
    for corr in corrections:
        fid = corr.get('id')
        changes = corr.get('changes', {})
        if not fid or not changes:
            continue

        set_clauses = []
        params = []
        for field, val in changes.items():
            if field in ('lat', 'lon', 'id_fuente'):
                continue
            if val is None:
                set_clauses.append(f'[{field}] = NULL')
            elif isinstance(val, str):
                set_clauses.append(f'[{field}] = ?')
                params.append(val)
            elif isinstance(val, bool):
                set_clauses.append(f'[{field}] = ?')
                params.append(-1 if val else 0)
            else:
                set_clauses.append(f'[{field}] = ?')
                params.append(val)

        if not set_clauses:
            continue

        sql = f'UPDATE Fuentes SET {", ".join(set_clauses)} WHERE id_fuente = ?'
        params.append(fid)
        cursor.execute(sql, params)
        if cursor.rowcount:
            updated += 1

    conn.commit()
    cursor.close()
    conn.close()

    print(f'Actualizados {updated} registros en la base de datos')

    # Regenerate fuentes_complete.json and fuentes_complete.js
    print('Regenerando archivos de datos...')
    regenerate_data()

    print('Hecho. Las correcciones ya están aplicadas en el .accdb y en los archivos de datos.')


# ---- UTM to lat/lon ----
def utm_to_latlon(easting, northing, zone, northern=True):
    if easting is None or northing is None:
        return None, None
    e = float(easting)
    n = float(northing)
    k0 = 0.9996
    a = 6378137.0
    f = 1 / 298.257223563
    b = a * (1 - f)
    e2 = (a * a - b * b) / (a * a)
    n_f = (a - b) / (a + b)
    n2 = n_f * n_f
    n3 = n2 * n_f
    n4 = n3 * n_f

    zone_cm = zone * 6 - 183
    e -= 500000
    if not northern:
        n = 10000000 - n

    m = n / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256))

    e1 = (1 - (1 - e2) ** 0.5) / (1 + (1 - e2) ** 0.5)
    j1 = 3 * e1 / 2 - 27 * e1 ** 3 / 32
    j2 = 21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32
    j3 = 151 * e1 ** 3 / 96
    j4 = 1097 * e1 ** 4 / 512
    fp = mu + j1 * math.sin(2 * mu) + j2 * math.sin(4 * mu) + j3 * math.sin(6 * mu) + j4 * math.sin(8 * mu)

    c1 = e2 * math.cos(fp) ** 2
    t1 = math.tan(fp) ** 2
    n1 = a / (1 - e2 * math.sin(fp) ** 2) ** 0.5
    r1 = a * (1 - e2) / (1 - e2 * math.sin(fp) ** 2) ** 1.5
    d = e / (n1 * k0)

    lat = fp - (n1 * math.tan(fp) / r1) * (
            d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * e2) * d ** 4 / 24 + (
            61 + 90 * t1 + 298 * c1 + 45 * t1 * t1) * d ** 6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * e2 + 24 * t1 * t1) * d ** 5 / 120) / math.cos(
        fp)

    return round(math.degrees(lat), 6), round(math.degrees(lon) + zone_cm, 6)


def regenerate_data():
    path = os.path.abspath('FUENTES_Andalucia.accdb')
    conn = pyodbc.connect(f'Driver={{Microsoft Access Driver (*.mdb, *.accdb)}};DBQ={path};')

    col_cursor = conn.cursor()
    cols = [row.column_name for row in col_cursor.columns('Fuentes')]
    col_cursor.close()

    data_cursor = conn.cursor()
    data_cursor.execute('SELECT * FROM Fuentes')

    rows = []
    for row in data_cursor.fetchall():
        d = {}
        for i, col in enumerate(cols):
            if col in ('otra_informacion', 'url'):
                continue
            val = row[i]
            if val is None:
                d[col] = None
            elif isinstance(val, str):
                val = val.strip()
                d[col] = val if val else None
            else:
                d[col] = val

        la, lo = utm_to_latlon(d.get('coordenada_x'), d.get('coordenada_y'), d.get('huso') or 30)
        d['lat'] = la
        d['lon'] = lo

        rows.append(d)

    data_cursor.close()

    # Write JS
    with open('fuentes_complete.js', 'w', encoding='utf-8') as f:
        f.write('window.FUENTES_DATA = ')
        json.dump(rows, f, ensure_ascii=False, default=str)
        f.write(';\ndocument.dispatchEvent(new CustomEvent("fuentesReady", {detail: window.FUENTES_DATA}));\n')

    # Write JSON
    with open('fuentes_complete.json', 'w', encoding='utf-8') as f:
        json.dump(rows, f, ensure_ascii=False, default=str)

    # Province mapping
    pc = conn.cursor()
    pc.execute('SELECT * FROM Provincias')
    provs = []
    for row in pc.fetchall():
        provs.append({
            'id': row[0],
            'nombre': row[1].strip() if row[1] else '',
            'codigo': row[2].strip() if row[2] else ''
        })
    pc.close()

    with open('provincias.js', 'w', encoding='utf-8') as f:
        f.write('const PROVINCIAS = ')
        json.dump(provs, f, ensure_ascii=False, default=str)
        f.write(';\n')

    conn.close()
    print(f'Regenerados {len(rows)} registros en fuentes_complete.json y fuentes_complete.js')


if __name__ == '__main__':
    main()
