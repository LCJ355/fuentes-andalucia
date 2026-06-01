import pyodbc, os, json, math

path = os.path.abspath('FUENTES_Andalucia.accdb')
conn = pyodbc.connect(f'Driver={{Microsoft Access Driver (*.mdb, *.accdb)}};DBQ={path};')

# Get column names
col_cursor = conn.cursor()
cols = [row.column_name for row in col_cursor.columns('Fuentes')]
col_cursor.close()
print('Columns:', cols)

# UTM to lat/lon (WGS84)
def utm_to_latlon(easting, northing, zone, northern=True):
    if easting is None or northing is None:
        return None, None
    e = float(easting); n = float(northing)
    k0 = 0.9996
    a = 6378137.0; f = 1/298.257223563; b = a*(1-f); e2 = (a*a-b*b)/(a*a)
    n_f = (a-b)/(a+b); n2 = n_f*n_f; n3 = n2*n_f; n4 = n3*n_f
    
    zone_cm = zone * 6 - 183
    e -= 500000
    if not northern: n = 10000000 - n
    
    m = n / k0
    mu = m / (a*(1 - e2/4 - 3*e2*e2/64 - 5*e2*e2*e2/256))
    
    e1 = (1 - (1 - e2)**0.5) / (1 + (1 - e2)**0.5)
    j1 = 3*e1/2 - 27*e1**3/32; j2 = 21*e1*e1/16 - 55*e1**4/32; j3 = 151*e1**3/96; j4 = 1097*e1**4/512
    fp = mu + j1*math.sin(2*mu) + j2*math.sin(4*mu) + j3*math.sin(6*mu) + j4*math.sin(8*mu)
    
    c1 = e2*math.cos(fp)**2; t1 = math.tan(fp)**2
    n1 = a / (1 - e2*math.sin(fp)**2)**0.5
    r1 = a*(1-e2) / (1 - e2*math.sin(fp)**2)**1.5
    d = e / (n1*k0)
    
    lat = fp - (n1*math.tan(fp)/r1)*(d*d/2 - (5+3*t1+10*c1-4*c1*c1-9*e2)*d**4/24 + (61+90*t1+298*c1+45*t1*t1)*d**6/720)
    lon = (d - (1+2*t1+c1)*d**3/6 + (5-2*c1+28*t1-3*c1*c1+8*e2+24*t1*t1)*d**5/120) / math.cos(fp)
    
    return round(math.degrees(lat), 6), round(math.degrees(lon) + zone_cm, 6)

# Fetch all data
data_cursor = conn.cursor()
data_cursor.execute('SELECT * FROM Fuentes')

rows = []
for row in data_cursor.fetchall():
    d = {}
    for i, col in enumerate(cols):
        if col in ('otra_informacion', 'url'): continue
        val = row[i]
        if val is None:
            d[col] = None
        elif isinstance(val, str):
            val = val.strip()
            d[col] = val if val else None
        else:
            d[col] = val
    
    # Convert UTM to lat/lon
    la, lo = utm_to_latlon(d.get('coordenada_x'), d.get('coordenada_y'), d.get('huso') or 30)
    d['lat'] = la
    d['lon'] = lo
    
    rows.append(d)

data_cursor.close()
print(f'Extracted {len(rows)} records')

# Output as JS (for file:// fallback via script injection)
with open('fuentes_complete.js', 'w', encoding='utf-8') as f:
    f.write('window.FUENTES_DATA = ')
    json.dump(rows, f, ensure_ascii=False, default=str)
    f.write(';\ndocument.dispatchEvent(new CustomEvent("fuentesReady", {detail: window.FUENTES_DATA}));\n')

# Output as JSON
with open('fuentes_complete.json', 'w', encoding='utf-8') as f:
    json.dump(rows, f, ensure_ascii=False, default=str)

# Province mapping
pc = conn.cursor()
pc.execute('SELECT * FROM Provincias')
provs = []
for row in pc.fetchall():
    provs.append({'id': row[0], 'nombre': row[1].strip() if row[1] else '', 'codigo': row[2].strip() if row[2] else ''})
pc.close()

with open('provincias.js', 'w', encoding='utf-8') as f:
    f.write('const PROVINCIAS = ')
    json.dump(provs, f, ensure_ascii=False, default=str)
    f.write(';\n')

conn.close()
print('Done.')
