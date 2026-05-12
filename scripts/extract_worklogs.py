"""
extract_worklogs.py
────────────────────────────────────────────────────────────
Extrae worklogs de Jira Cloud para un rango de fechas,
cruza con el mapping Excel y guarda un JSON para el dashboard
+ un Excel listo para abrir.

Uso:
    python scripts/extract_worklogs.py --from 2026-05-01 --to 2026-05-31
    python scripts/extract_worklogs.py --from 2026-05-01 --to 2026-05-31 --mapping data/mapping_sample.xlsx
"""

import os, sys, json, base64, argparse, io
from datetime import datetime, date
from pathlib import Path

# Forzar UTF-8 en stdout para evitar UnicodeEncodeError en Windows (cp1252)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

import requests
import pandas as pd
from dotenv import load_dotenv
from concurrent.futures import ThreadPoolExecutor, as_completed

# ─── Config ──────────────────────────────────────────────────────────────────
load_dotenv(Path(__file__).parent.parent / ".env")

BASE_URL   = os.getenv("JIRA_BASE_URL", "").rstrip("/")
EMAIL      = os.getenv("JIRA_EMAIL", "")
API_TOKEN  = os.getenv("JIRA_API_TOKEN", "")
DATA_DIR   = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

# ─── Cliente HTTP ─────────────────────────────────────────────────────────────
encoded = base64.b64encode(f"{EMAIL}:{API_TOKEN}".encode()).decode()
HEADERS = {
    "Authorization": f"Basic {encoded}",
    "Accept": "application/json",
    "Content-Type": "application/json"
}

def jira_get(path, params=None):
    url = f"{BASE_URL}/rest/api/3{path}"
    r = requests.get(url, headers=HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()

def jira_post(path, body):
    url = f"{BASE_URL}/rest/api/3{path}"
    r = requests.post(url, headers=HEADERS, json=body, timeout=30)
    if not r.ok:
        print(f"  [HTTP {r.status_code}] {r.text[:500]}")
    r.raise_for_status()
    return r.json()

# ─── Extracción de issues con worklogs ───────────────────────────────────────
def fetch_issues(date_from: str, date_to: str) -> list:
    """Busca todos los issues con worklogs en el rango via JQL (GET /search/jql con cursor)."""
    issues = []
    jql = f'worklogDate >= "{date_from}" AND worklogDate <= "{date_to}" ORDER BY updated DESC'
    next_page_token = None
    max_results = 100

    print(f"  Buscando issues con worklogs entre {date_from} y {date_to}...")

    while True:
        params = {
            "jql": jql,
            "fields": "summary,issuetype,project,status,assignee,worklog",
            "maxResults": max_results
        }
        if next_page_token:
            params["nextPageToken"] = next_page_token

        data = jira_get("/search/jql", params=params)
        batch = data.get("issues", [])
        issues.extend(batch)
        print(f"    {len(issues)} issues obtenidos...")

        next_page_token = data.get("nextPageToken")
        if not next_page_token or not batch:
            break

    return issues

def fetch_worklogs_for_issue(issue_key: str) -> list:
    """Obtiene todos los worklogs de un issue (maneja paginación)."""
    data = jira_get(f"/issue/{issue_key}/worklog")
    worklogs = data.get("worklogs", [])
    total = data.get("total", 0)
    # Paginar si hay más de los devueltos
    if total > len(worklogs):
        all_wl = list(worklogs)
        start = len(worklogs)
        while start < total:
            page = jira_get(f"/issue/{issue_key}/worklog", params={"startAt": start, "maxResults": 100})
            all_wl.extend(page.get("worklogs", []))
            start += 100
        return all_wl
    return worklogs

# ─── Mapping ─────────────────────────────────────────────────────────────────
def load_mapping(mapping_path: Path) -> dict:
    if not mapping_path.exists():
        print(f"  [warn] Mapping no encontrado en {mapping_path}. Se usará sin enriquecimiento.")
        return {}

    ext = mapping_path.suffix.lower()
    if ext == ".csv":
        df = pd.read_csv(mapping_path, dtype=str).fillna("")
    else:
        df = pd.read_excel(mapping_path, dtype=str).fillna("")

    mapping = {}
    key_col = next((c for c in df.columns if c.strip().lower() in ("clave", "key", "issue key")), None)
    if not key_col:
        print("  [warn] No se encontró columna 'Clave' en el mapping.")
        return {}

    for _, row in df.iterrows():
        k = str(row[key_col]).strip()
        if k:
            mapping[k] = row.to_dict()
    print(f"  Mapping cargado: {len(mapping)} claves.")
    return mapping


def load_personas() -> dict:
    """Carga data/personas.json (email → {funcion, nombreNomina})."""
    personas_path = Path(__file__).parent.parent / "data" / "personas.json"
    if not personas_path.exists():
        return {}
    try:
        with open(personas_path, encoding="utf-8") as f:
            data = json.load(f)
        print(f"  Personas cargadas: {len(data)} registros.")
        return data
    except Exception as e:
        print(f"  [warn] No se pudo leer personas.json: {e}")
        return {}


def load_prefix_mapping() -> dict:
    """Carga data/prefix_mapping.json (prefijo de issue → centroCosto + prodImproductivo)."""
    path = Path(__file__).parent.parent / "data" / "prefix_mapping.json"
    if not path.exists():
        print("  [warn] prefix_mapping.json no encontrado.")
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        # Normalizar claves a mayúsculas para comparación segura
        return {k.upper(): v for k, v in data.items()}
    except Exception as e:
        print(f"  [warn] No se pudo leer prefix_mapping.json: {e}")
        return {}

# ─── Procesamiento principal ──────────────────────────────────────────────────
def build_rows(issues: list, date_from: str, date_to: str, mapping: dict, personas: dict, prefix_map: dict) -> list:
    rows = []
    total = len(issues)

    # Pre-fetch paralelo: identificar issues que necesitan llamada extra a Jira
    issues_extra = [
        iss for iss in issues
        if iss["fields"].get("worklog", {}).get("total", 0)
           > len(iss["fields"].get("worklog", {}).get("worklogs", []))
    ]
    extra_wl = {}
    if issues_extra:
        print(f"  Obteniendo worklogs completos de {len(issues_extra)} issues en paralelo...")
        with ThreadPoolExecutor(max_workers=8) as executor:
            fut_map = {
                executor.submit(fetch_worklogs_for_issue, iss["key"]): iss["key"]
                for iss in issues_extra
            }
            for fut in as_completed(fut_map):
                k = fut_map[fut]
                try:
                    extra_wl[k] = fut.result()
                except Exception as e:
                    print(f"\n  [warn] Error en worklogs de {k}: {e}")
                    extra_wl[k] = []

    for i, issue in enumerate(issues, 1):
        key = issue["key"]
        fields = issue["fields"]
        print(f"  [{i}/{total}] {key}...", end="\r")

        if key in extra_wl:
            worklogs = extra_wl[key]
        else:
            worklogs = fields.get("worklog", {}).get("worklogs", [])

        map_row = mapping.get(key, {})
        # CC y Prod/Improductivo se derivan del prefijo del issue (ej: "CAPI" de "CAPI-123")
        prefix = key.split("-")[0].upper()
        pm = prefix_map.get(prefix, {})

        for wl in worklogs:
            started = (wl.get("started") or "")[:10]
            if not started or started < date_from or started > date_to:
                continue

            hours = round(wl.get("timeSpentSeconds", 0) / 3600, 2)
            email = (wl.get("author", {}).get("emailAddress") or "").lower()

            # Persona: solo Función y Nombre Nómina (CC viene del prefijo del issue)
            p = personas.get(email, {})

            rows.append({
                "fecha":              started,
                "issueKey":           key,
                "issueSummary":       fields.get("summary", ""),
                "proyecto":           fields.get("project", {}).get("name", ""),
                "tipoIssue":          fields.get("issuetype", {}).get("name", ""),
                "estado":             fields.get("status", {}).get("name", ""),
                "autor":              wl.get("author", {}).get("displayName", ""),
                "autorEmail":         email,
                "horasLogueadas":     hours,
                "segundosLogueados":  wl.get("timeSpentSeconds", 0),
                # CC y Prod/Improductivo: prefijo del issue (fuente primaria) → mapping de issue → vacío
                "centroCosto":        pm.get("centroCosto")      or map_row.get("Centro de Costo", ""),
                "prodImproductivo":   pm.get("prodImproductivo") or map_row.get("Prod / Improductivo", ""),
                "proyectoMapeado":    map_row.get("Proyecto", ""),
                "nombre":             p.get("nombreNomina")     or map_row.get("Nombre", ""),
                "funcion":            p.get("funcion")          or map_row.get("Funcion", ""),
                "nombreNomina":       p.get("nombreNomina")     or map_row.get("Nombre nomina", ""),
            })

    print()
    return rows

# ─── Resúmenes ────────────────────────────────────────────────────────────────
def build_resumen_persona(rows):
    df = pd.DataFrame(rows)
    if df.empty:
        return []
    # CC no se agrupa por persona (una persona puede tener múltiples CCs según los issues)
    grp = df.groupby(["autorEmail","autor","nombreNomina","funcion"], dropna=False)
    result = grp["horasLogueadas"].agg(totalHoras="sum", entradas="count").reset_index()
    result["totalHoras"] = result["totalHoras"].round(2)
    return result.sort_values("totalHoras", ascending=False).to_dict(orient="records")

def build_resumen_proyecto(rows):
    df = pd.DataFrame(rows)
    if df.empty:
        return []
    col = "proyectoMapeado"
    df[col] = df[col].where(df[col] != "", df["proyecto"])
    grp = df.groupby(col, dropna=False)
    result = grp.agg(
        totalHoras=("horasLogueadas", "sum"),
        entradas=("horasLogueadas", "count"),
        personas=("autorEmail", "nunique")
    ).reset_index()
    result.columns = ["proyecto", "totalHoras", "entradas", "personas"]
    result["totalHoras"] = result["totalHoras"].round(2)
    return result.sort_values("totalHoras", ascending=False).to_dict(orient="records")

def build_resumen_cc(rows):
    df = pd.DataFrame(rows)
    if df.empty:
        return []
    df["cc"] = df["centroCosto"].where(df["centroCosto"] != "", "Sin Centro de Costo")
    df["esProd"] = df["prodImproductivo"].str.lower().apply(
        lambda x: "prod" in x and "improd" not in x
    )
    grp = df.groupby("cc", dropna=False)
    result = grp.agg(
        totalHoras=("horasLogueadas", "sum"),
        productivo=("horasLogueadas", lambda s: s[df.loc[s.index, "esProd"]].sum()),
        improductivo=("horasLogueadas", lambda s: s[~df.loc[s.index, "esProd"]].sum()),
    ).reset_index()
    result.columns = ["centroCosto", "totalHoras", "productivo", "improductivo"]
    for c in ["totalHoras","productivo","improductivo"]:
        result[c] = result[c].round(2)
    return result.sort_values("totalHoras", ascending=False).to_dict(orient="records")

# ─── Export Excel ─────────────────────────────────────────────────────────────
def export_excel(rows, resumen_persona, resumen_proyecto, resumen_cc, date_from, date_to):
    out_path = DATA_DIR / f"worklogs_{date_from}_{date_to}.xlsx"
    with pd.ExcelWriter(out_path, engine="openpyxl") as writer:
        pd.DataFrame(resumen_persona).to_excel(writer, sheet_name="Por Persona", index=False)
        pd.DataFrame(resumen_proyecto).to_excel(writer, sheet_name="Por Proyecto", index=False)
        pd.DataFrame(resumen_cc).to_excel(writer, sheet_name="Centro de Costo", index=False)
        pd.DataFrame(rows).to_excel(writer, sheet_name="Detalle", index=False)
    print(f"  Excel guardado: {out_path}")
    return out_path

# ─── Export JSON para dashboard ───────────────────────────────────────────────
def export_json(rows, resumen_persona, resumen_proyecto, resumen_cc, date_from, date_to):
    total_horas = round(sum(r["horasLogueadas"] for r in rows), 2)
    payload = {
        "meta": {
            "from": date_from,
            "to": date_to,
            "generatedAt": datetime.now().isoformat(),
            "totalIssues": len(set(r["issueKey"] for r in rows)),
            "totalEntradas": len(rows),
            "totalHoras": total_horas
        },
        "detalle": rows,
        "resumenPersona": resumen_persona,
        "resumenProyecto": resumen_proyecto,
        "resumenCentroCosto": resumen_cc
    }
    out_path = DATA_DIR / "last_report.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  JSON para dashboard guardado: {out_path}")
    return out_path

# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Extrae worklogs de Jira")
    parser.add_argument("--from", dest="date_from", required=True, help="Fecha inicio YYYY-MM-DD")
    parser.add_argument("--to",   dest="date_to",   required=True, help="Fecha fin YYYY-MM-DD")
    parser.add_argument("--mapping", default=str(DATA_DIR / "mapping.xlsx"),
                        help="Ruta al archivo de mapping (.xlsx o .csv)")
    args = parser.parse_args()

    if not BASE_URL or not EMAIL or not API_TOKEN:
        print("ERROR: Configurá JIRA_BASE_URL, JIRA_EMAIL y JIRA_API_TOKEN en el .env")
        sys.exit(1)

    print(f"\n{'-'*55}")
    print(f"  Jira Worklog Extractor")
    print(f"  Rango: {args.date_from} -> {args.date_to}")
    print(f"{'-'*55}")

    mapping     = load_mapping(Path(args.mapping))
    personas    = load_personas()
    prefix_map  = load_prefix_mapping()
    issues      = fetch_issues(args.date_from, args.date_to)

    if not issues:
        print("  Sin resultados para el periodo indicado.")
        sys.exit(0)

    rows = build_rows(issues, args.date_from, args.date_to, mapping, personas, prefix_map)

    print(f"\n  Total worklogs en rango: {len(rows)}")
    print(f"  Total horas: {round(sum(r['horasLogueadas'] for r in rows), 2)}")

    rp = build_resumen_persona(rows)
    rproj = build_resumen_proyecto(rows)
    rcc = build_resumen_cc(rows)

    export_json(rows, rp, rproj, rcc, args.date_from, args.date_to)
    export_excel(rows, rp, rproj, rcc, args.date_from, args.date_to)

    print(f"\n  Listo. Refresca el dashboard en http://localhost:3000\n")

if __name__ == "__main__":
    main()
