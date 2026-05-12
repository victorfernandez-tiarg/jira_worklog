import json, pathlib
d = json.loads(pathlib.Path("data/last_report.json").read_text(encoding="utf-8"))
m = d["meta"]
print(f"Horas totales : {m['totalHoras']}")
print(f"Entradas      : {m['totalEntradas']}")
print(f"Issues        : {m['totalIssues']}")
print(f"Rango         : {m['from']} → {m['to']}")
print(f"Personas      : {len(d['resumenPersona'])}")
print()
print("Top 5 personas:")
for p in d["resumenPersona"][:5]:
    print(f"  {p['autor']:<30} {p['totalHoras']} hs")
