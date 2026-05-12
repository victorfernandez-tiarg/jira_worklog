# Jira Worklog Dashboard

Dashboard web para reportes de worklogs de Jira Cloud. Reemplaza el proceso manual de descargar worklogs por persona y pegar en Excel.

## Características

- **Rango de fechas libre** con atajos (esta semana, mes anterior, etc.)
- **Mapping configurable** vía Excel/CSV: clave de issue → Centro de Costo, Proyecto, Nombre, etc.
- **4 vistas**: Por persona | Por proyecto | Centro de Costo | Detalle completo
- **Export a Excel y CSV** directamente desde el browser
- **Filtro y ordenamiento** en todas las tablas
- **KPIs** resumen al tope

---

## Instalación rápida

### 1. Requisitos
- Node.js 18+

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar credenciales

Copiar y editar el archivo de configuración:
```bash
copy .env.example .env
```

Editar `.env`:

**Opción A — API Token (recomendado, más simple):**
```
AUTH_MODE=token
JIRA_BASE_URL=https://tu-empresa.atlassian.net
JIRA_EMAIL=tu@email.com
JIRA_API_TOKEN=tu_token_aqui
```
> Obtener token en: https://id.atlassian.com/manage-profile/security/api-tokens

**Opción B — OAuth 2.0:**
1. Crear app en https://developer.atlassian.com/console/myapps/
2. Agregar scopes: `read:jira-work`, `read:jira-user`, `offline_access`
3. Completar en `.env`: `AUTH_MODE=oauth`, `JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET`

### 4. Generar archivo de ejemplo de mapping
```bash
node scripts/generate_sample_mapping.js
```

### 5. Iniciar
```bash
npm start
```

Abrir en el navegador: **http://localhost:3000**

---

## Uso del Mapping

El mapping conecta cada **clave de issue Jira** con información de negocio:

| Columna | Descripción |
|---------|-------------|
| `Clave` | Key del issue en Jira (ej: `PROJ-123`) |
| `Centro de Costo` | Centro de costo asociado |
| `Prod / Improductivo` | Si la tarea es productiva o improductiva |
| `Proyecto` | Nombre de proyecto interno |
| `Nombre` | Nombre del recurso en Jira |
| `Funcion` | Función del recurso |
| `Nombre nomina` | Nombre tal como aparece en nómina |

**Para actualizar el mapping:**
1. Descargar el ejemplo desde el dashboard (botón "Descargar Ejemplo")
2. Completar/actualizar las filas
3. Subir el archivo con el botón "Subir Mapping"

---

## Estructura del proyecto

```
├── server.js              # Entrada principal
├── routes/
│   ├── auth.js            # Autenticación Jira (Token / OAuth)
│   ├── worklogs.js        # Consulta y procesamiento de worklogs
│   └── mapping.js         # Upload y gestión del mapping
├── public/
│   ├── index.html         # Dashboard UI
│   ├── style.css          # Estilos
│   └── app.js             # Lógica frontend
├── data/
│   ├── mapping.json       # Mapping activo (se genera al subir archivo)
│   └── mapping_sample.xlsx
├── scripts/
│   └── generate_sample_mapping.js
├── .env.example
└── package.json
```

---

## Desarrollo
```bash
npm run dev    # Con nodemon (hot-reload)
```
