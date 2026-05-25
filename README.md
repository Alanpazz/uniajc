# 🎓 Agente IA — Optimización de Horarios UNIAJC

**Facultad de Ingeniería de Sistemas · Periodo 2025-1**

Agente conversacional basado en IA con patrón **ReAct** (Razona → Actúa → Observa) que automatiza y valida la construcción del horario académico de la UNIAJC, detectando conflictos en tiempo real.

---

## 🚀 Requisitos

- **Node.js v22+** (usa SQLite nativo — sin dependencias de compilación)
- API Key de [Groq](https://console.groq.com) (gratuita)

## 📦 Instalación

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Edita .env y pon tu GROQ_API_KEY

# 3. Crear la base de datos (solo una vez)
node seed-horarios.js

# 4. Iniciar el servidor
node server.js
```

Abre **http://localhost:3000** en tu navegador.

## 🗂️ Estructura del proyecto

```
uniajc-horarios/
├── .env                  ← API keys (nunca a Git)
├── .gitignore
├── package.json
├── seed-horarios.js      ← Crea la BD y carga datos iniciales
├── agent-horarios.js     ← Agente ReAct con ciclo razona→actúa→observa
├── server.js             ← Servidor HTTP (Node 22 nativo, sin Express)
├── public/
│   └── index.html        ← Interfaz web de consultas
└── horarios.db           ← SQLite (generado por seed-horarios.js)
```

## 🛠️ Tools implementadas (≥4 requeridas)

| Tool | Descripción |
|------|-------------|
| `detectar_conflictos(periodo)` | Detecta cruces de docente, aulas doble-asignadas y carga excedida |
| `verificar_disponibilidad(docente_id, dia, franja)` | Verifica si un docente puede dictar en ese slot |
| `asignar_clase(grupo_id, docente_id, aula_id, dia, franja)` | Asigna con validación completa anti-conflicto |
| `listar_grupos_sin_horario()` | Lista grupos que aún no tienen asignación |
| `ejecutar_sql(query)` | Ejecuta SELECT libre para consultas analíticas |
| `listar_tablas()` | Muestra el schema completo de la BD |

## 🗄️ Base de datos (SQLite nativo Node 22)

| Tabla | Descripción |
|-------|-------------|
| `docentes` | Planta y cátedra con carga máxima |
| `disponibilidad_docente` | Franjas disponibles por docente |
| `materias` | Materias con prerequisitos encadenados |
| `aulas` | Presencial, laboratorio y virtual |
| `grupos` | Grupos con inscritos a programar |
| `horario_asignado` | Resultado del agente (inicia vacío) |
| `conflictos_detectados` | Log de conflictos detectados |

## 📡 API endpoints

```
GET  /              → Interfaz web
POST /api/agente    → { "pregunta": "..." }  → { "respuesta": "..." }
GET  /api/estado    → Snapshot completo de la BD
POST /api/tool      → { "tool": "detectar_conflictos", "args": {...} }
```

## 💬 Ejemplos de consultas

- `¿Cuántos grupos faltan por asignar horario?`
- `¿Está disponible Felipe Vasco el Lunes a las 8-10?`
- `Detecta todos los conflictos del periodo 2025-1`
- `Asigna Programación 1 grupo 1 con Felipe Vasco en A101 el Lunes 8-10`
- `¿Cuál es la carga actual de cada docente?`
- `¿Qué materias tienen prerequisitos?`

## 🏗️ Arquitectura ReAct

```
Usuario → Pregunta
    ↓
[system prompt + schema + tools]
    ↓
Groq LLM (llama-3.1-70b-versatile)
    ↓
¿tool_calls? → Ejecutar tool → resultado → LLM
    ↓ (si no)
Respuesta final en español
```

## 📋 Criterios de evaluación

| Componente | Estado |
|-----------|--------|
| ✅ BD funcional con seed y FK | Implementado |
| ✅ ≥4 tools funcionales | 6 tools implementadas |
| ✅ Agente ReAct con Groq | Ciclo completo |
| ✅ Detección ≥2 tipos conflicto | docente_cruce, aula_ocupada, carga_excedida |
| ✅ Interfaz HTML5 | Incluida con chat interactivo |
| ✅ README con instrucciones | Este archivo |
# uniajc
