import requests, base64, sys, os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

email    = os.getenv("JIRA_EMAIL", "")
token    = os.getenv("JIRA_API_TOKEN", "")
base_url = os.getenv("JIRA_BASE_URL", "").rstrip("/")

encoded = base64.b64encode(f"{email}:{token}".encode()).decode()
headers = {"Authorization": f"Basic {encoded}", "Accept": "application/json"}

r = requests.get(f"{base_url}/rest/api/3/myself", headers=headers)
if r.status_code == 200:
    print("Conexion OK:", r.json().get("displayName"), r.json().get("emailAddress"))
else:
    print("ERROR:", r.status_code, r.text[:300])
