// ═══════════════════════════════════════════════════════════════
// agent-horarios.js  —  Agente ReAct de horarios UNIAJC
// Ciclo: Razona → Actúa (tool) → Observa → repite hasta respuesta
// ═══════════════════════════════════════════════════════════════
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();
process.removeAllListeners('warning');

const GROQ_KEY   = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const DB_PATH = process.env.DB_PATH || './horarios.db';
const PERIODO    = '2025-1';

if (!GROQ_KEY) {
  console.error('❌ No se encontró GROQ_API_KEY en .env');
  process.exit(1);
}

// ── Schema para el system prompt (el LLM necesita conocer la BD)
export const SCHEMA = `
TABLAS DISPONIBLES:
- docentes(id, nombre, email, tipo[planta|catedra], carga_max, carga_actual)
- disponibilidad_docente(id, docente_id, dia[Lunes|Martes|Miercoles|Jueves|Viernes|Sabado], franja[6-8|8-10|10-12|14-16|16-18|18-20|20-22])
- materias(id, codigo, nombre, creditos, horas_semana, programa, semestre, prerequisito_id)
- aulas(id, codigo, tipo[presencial|virtual|laboratorio], capacidad, bloque)
- grupos(id, materia_id, num_grupo, cupo_max, inscritos, programa, semestre)
- horario_asignado(id, grupo_id, docente_id, aula_id, dia, franja, periodo, estado[propuesto|confirmado|conflicto])
- conflictos_detectados(id, tipo[aula_ocupada|docente_cruce|prerequisito|carga_excedida], descripcion, entidad_id, resuelto, fecha)
`.trim();

// ── Definición de tools para el LLM
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'detectar_conflictos',
      description: 'Analiza la tabla horario_asignado buscando cruces: mismo docente en dos lugares, misma aula doble-asignada, o carga docente excedida. Registra conflictos en conflictos_detectados.',
      parameters: {
        type: 'object',
        properties: {
          periodo: { type: 'string', description: 'Periodo a revisar, ej: "2025-1"' }
        },
        required: ['periodo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'verificar_disponibilidad',
      description: 'Consulta si un docente está disponible en un día y franja específicos.',
      parameters: {
        type: 'object',
        properties: {
          docente_id: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'ID del docente' },
          dia:        { type: 'string', description: 'Día: Lunes|Martes|Miercoles|Jueves|Viernes|Sabado' },
          franja:     { type: 'string', description: 'Franja horaria: 6-8|8-10|10-12|14-16|16-18|18-20|20-22' }
        },
        required: ['docente_id', 'dia', 'franja']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'asignar_clase',
      description: 'Inserta una asignación en horario_asignado si no hay conflicto previo. Verifica disponibilidad del docente, que el aula no esté ocupada y que el docente no tenga otra clase al mismo tiempo.',
      parameters: {
        type: 'object',
        properties: {
          grupo_id:   { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'ID del grupo' },
          docente_id: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'ID del docente' },
          aula_id:    { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'ID del aula' },
          dia:        { type: 'string', description: 'Día de la semana' },
          franja:     { type: 'string', description: 'Franja horaria' }
        },
        required: ['grupo_id', 'docente_id', 'aula_id', 'dia', 'franja']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_grupos_sin_horario',
      description: 'Retorna los grupos del periodo actual que aún no tienen asignación en horario_asignado.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ejecutar_sql',
      description: 'Ejecuta una query SQL SELECT de solo lectura en la BD de horarios UNIAJC y retorna los resultados.',
      parameters: {
        type: 'object',
        properties: {
          query:       { type: 'string', description: 'Query SQL SELECT válida' },
          descripcion: { type: 'string', description: 'Qué hace esta query en una frase' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_tablas',
      description: 'Muestra el schema completo de todas las tablas y columnas disponibles en la BD.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  }
];

// ── Forzar tipos numéricos en los args (el LLM a veces manda strings)
function coerceArgs(toolName, args) {
  const numFields = {
    verificar_disponibilidad: ['docente_id'],
    asignar_clase:            ['grupo_id', 'docente_id', 'aula_id'],
    detectar_conflictos:      [],
    listar_grupos_sin_horario:[],
    ejecutar_sql:             [],
    listar_tablas:            [],
  };
  const fields = numFields[toolName] || [];
  const out = { ...args };
  for (const f of fields) {
    if (out[f] !== undefined) out[f] = Number(out[f]);
  }
  return out;
}

// ── Implementación de tools
export function ejecutarTool(nombre, args) {
  args = coerceArgs(nombre, args);          // ← sanitizar antes de todo
  const db = new DatabaseSync(DB_PATH);
  try {
    switch (nombre) {

      case 'ejecutar_sql': {
        if (!/^\s*SELECT/i.test(args.query)) {
          return JSON.stringify({ error: 'Solo se permiten queries SELECT' });
        }
        try {
          const rows = db.prepare(args.query).all();
          console.log(`  📊 SQL: ${args.descripcion || args.query}`);
          console.log(`     → ${rows.length} fila(s)`);
          return JSON.stringify({ filas: rows, total: rows.length, query: args.query });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      }

      case 'listar_tablas':
        return SCHEMA;

      case 'verificar_disponibilidad': {
        const { docente_id, dia, franja } = args;
        const disp = db.prepare(
          'SELECT * FROM disponibilidad_docente WHERE docente_id=? AND dia=? AND franja=?'
        ).get(docente_id, dia, franja);

        // Verificar si ya tiene clase ese día/franja
        const ocupado = db.prepare(
          'SELECT ha.*, m.nombre as materia FROM horario_asignado ha ' +
          'JOIN grupos g ON ha.grupo_id=g.id ' +
          'JOIN materias m ON g.materia_id=m.id ' +
          'WHERE ha.docente_id=? AND ha.dia=? AND ha.franja=? AND ha.periodo=?'
        ).get(docente_id, dia, franja, PERIODO);

        const docente = db.prepare('SELECT nombre FROM docentes WHERE id=?').get(docente_id);
        console.log(`  🔍 Disponibilidad: ${docente?.nombre} el ${dia} ${franja}`);

        return JSON.stringify({
          disponible_en_horario: !!disp,
          ya_tiene_clase: !!ocupado,
          clase_existente: ocupado || null,
          puede_asignarse: !!disp && !ocupado,
          docente: docente?.nombre
        });
      }

      case 'listar_grupos_sin_horario': {
        const rows = db.prepare(`
          SELECT g.id, g.num_grupo, g.inscritos, g.cupo_max, g.semestre,
                 m.codigo, m.nombre as materia, m.creditos
          FROM grupos g
          JOIN materias m ON g.materia_id = m.id
          WHERE g.id NOT IN (
            SELECT DISTINCT grupo_id FROM horario_asignado WHERE periodo=?
          )
          ORDER BY g.semestre, m.codigo
        `).all(PERIODO);
        console.log(`  📋 Grupos sin horario: ${rows.length}`);
        return JSON.stringify({ grupos: rows, total: rows.length });
      }

      case 'asignar_clase': {
        const { grupo_id, docente_id, aula_id, dia, franja } = args;

        // 1. Verificar disponibilidad docente
        const dispDocente = db.prepare(
          'SELECT 1 FROM disponibilidad_docente WHERE docente_id=? AND dia=? AND franja=?'
        ).get(docente_id, dia, franja);
        if (!dispDocente) {
          return JSON.stringify({ exito: false, razon: `El docente ${docente_id} no está disponible el ${dia} ${franja}` });
        }

        // 2. Verificar que el docente no tenga otra clase ese día/franja
        const docenteOcupado = db.prepare(
          'SELECT 1 FROM horario_asignado WHERE docente_id=? AND dia=? AND franja=? AND periodo=?'
        ).get(docente_id, dia, franja, PERIODO);
        if (docenteOcupado) {
          // Registrar conflicto
          db.prepare(
            'INSERT INTO conflictos_detectados (tipo,descripcion,entidad_id) VALUES (?,?,?)'
          ).run('docente_cruce', `Docente ${docente_id} ya tiene clase el ${dia} ${franja} en ${PERIODO}`, docente_id);
          return JSON.stringify({ exito: false, razon: `CONFLICTO: Docente ya tiene clase ese día/franja. Conflicto registrado.` });
        }

        // 3. Verificar que el aula no esté ocupada
        const aulaOcupada = db.prepare(
          'SELECT 1 FROM horario_asignado WHERE aula_id=? AND dia=? AND franja=? AND periodo=?'
        ).get(aula_id, dia, franja, PERIODO);
        if (aulaOcupada) {
          db.prepare(
            'INSERT INTO conflictos_detectados (tipo,descripcion,entidad_id) VALUES (?,?,?)'
          ).run('aula_ocupada', `Aula ${aula_id} ya está ocupada el ${dia} ${franja} en ${PERIODO}`, aula_id);
          return JSON.stringify({ exito: false, razon: `CONFLICTO: Aula ya está ocupada. Conflicto registrado.` });
        }

        // 4. Verificar capacidad del aula vs inscritos
        const grupo = db.prepare('SELECT inscritos FROM grupos WHERE id=?').get(grupo_id);
        const aula  = db.prepare('SELECT capacidad, codigo FROM aulas WHERE id=?').get(aula_id);
        if (grupo && aula && grupo.inscritos > aula.capacidad) {
          return JSON.stringify({ exito: false, razon: `Aula ${aula.codigo} (cap. ${aula.capacidad}) tiene menos capacidad que inscritos (${grupo.inscritos})` });
        }

        // 5. Insertar asignación
        const result = db.prepare(
          'INSERT INTO horario_asignado (grupo_id,docente_id,aula_id,dia,franja,periodo,estado) VALUES (?,?,?,?,?,?,?)'
        ).run(grupo_id, docente_id, aula_id, dia, franja, PERIODO, 'propuesto');

        // 6. Actualizar carga docente
        db.prepare('UPDATE docentes SET carga_actual = carga_actual + 2 WHERE id=?').run(docente_id);

        console.log(`  ✅ Asignada: grupo ${grupo_id} → docente ${docente_id} | ${dia} ${franja} | aula ${aula_id}`);
        return JSON.stringify({ exito: true, id: result.lastInsertRowid, mensaje: `Clase asignada: grupo ${grupo_id}, docente ${docente_id}, aula ${aula_id}, ${dia} ${franja}` });
      }

      case 'detectar_conflictos': {
        const { periodo } = args;
        const conflictos = [];

        // Conflicto: mismo docente, mismo día, misma franja → más de una clase
        const docenteCruce = db.prepare(`
          SELECT docente_id, dia, franja, COUNT(*) as clases,
                 GROUP_CONCAT(grupo_id) as grupos
          FROM horario_asignado
          WHERE periodo=?
          GROUP BY docente_id, dia, franja
          HAVING clases > 1
        `).all(periodo);

        for (const c of docenteCruce) {
          const desc = `Docente ${c.docente_id} tiene ${c.clases} clases el ${c.dia} ${c.franja} (grupos: ${c.grupos})`;
          db.prepare('INSERT INTO conflictos_detectados (tipo,descripcion,entidad_id) VALUES (?,?,?)')
            .run('docente_cruce', desc, c.docente_id);
          conflictos.push({ tipo: 'docente_cruce', descripcion: desc });
        }

        // Conflicto: misma aula, mismo día, misma franja → más de una clase
        const aulaCruce = db.prepare(`
          SELECT aula_id, dia, franja, COUNT(*) as clases,
                 GROUP_CONCAT(grupo_id) as grupos
          FROM horario_asignado
          WHERE periodo=?
          GROUP BY aula_id, dia, franja
          HAVING clases > 1
        `).all(periodo);

        for (const c of aulaCruce) {
          const desc = `Aula ${c.aula_id} tiene ${c.clases} clases el ${c.dia} ${c.franja} (grupos: ${c.grupos})`;
          db.prepare('INSERT INTO conflictos_detectados (tipo,descripcion,entidad_id) VALUES (?,?,?)')
            .run('aula_ocupada', desc, c.aula_id);
          conflictos.push({ tipo: 'aula_ocupada', descripcion: desc });
        }

        // Conflicto: docente con carga excedida
        const cargaExcedida = db.prepare(`
          SELECT d.id, d.nombre, d.carga_max, d.carga_actual
          FROM docentes d
          WHERE d.carga_actual > d.carga_max
        `).all();

        for (const d of cargaExcedida) {
          const desc = `${d.nombre} tiene carga ${d.carga_actual}h > máximo ${d.carga_max}h`;
          db.prepare('INSERT INTO conflictos_detectados (tipo,descripcion,entidad_id) VALUES (?,?,?)')
            .run('carga_excedida', desc, d.id);
          conflictos.push({ tipo: 'carga_excedida', descripcion: desc });
        }

        console.log(`  🔎 Detección de conflictos: ${conflictos.length} encontrados`);
        return JSON.stringify({
          periodo,
          conflictos_detectados: conflictos.length,
          detalle: conflictos,
          mensaje: conflictos.length === 0 ? 'Sin conflictos detectados' : `${conflictos.length} conflicto(s) registrado(s)`
        });
      }

      default:
        return JSON.stringify({ error: `Tool desconocida: ${nombre}` });
    }
  } finally {
    db.close();
  }
}

// ── Llamar a Groq
async function llamarGroq(mensajes) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: mensajes,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 2000
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`Groq error: ${data.error.message}`);
  return data.choices[0].message;
}

// ── Ciclo ReAct principal
export async function correrAgente(pregunta, onStep) {
  const log = (msg) => { if (onStep) onStep(msg); else console.log(msg); };

  log(`\n🤖 Agente UNIAJC iniciado\n📝 Pregunta: "${pregunta}"\n${'─'.repeat(60)}`);

  const mensajes = [
    {
      role: 'system',
      content: `Eres el Agente de Optimización de Horarios de la Facultad de Ingeniería de la UNIAJC 
(Institución Universitaria Antonio José Camacho, Cali, Colombia).

Tu misión: ayudar a construir y validar el horario académico 2025-1, detectando conflictos y respondiendo consultas.

SCHEMA de la base de datos:
${SCHEMA}

REGLAS:
1. Usa las tools disponibles para consultar la BD antes de responder.
2. Cuando detectes o asignes conflictos, explica claramente qué pasó.
3. Para asignaciones, verifica siempre: disponibilidad docente → aula libre → sin cruce.
4. Cuando tengas suficiente información, da una respuesta final clara en español.
5. Si te piden detectar conflictos, usa detectar_conflictos primero.
6. Responde siempre en español, con claridad y profesionalismo.`
    },
    { role: 'user', content: pregunta }
  ];

  let pasos = 0;
  const MAX_PASOS = 8;

  while (pasos++ < MAX_PASOS) {
    log(`\n🔄 Paso ${pasos}/${MAX_PASOS} — consultando Groq...`);

    const resp = await llamarGroq(mensajes);
    mensajes.push(resp);

    // Si el LLM quiere ejecutar tools
    if (resp.tool_calls?.length) {
      for (const tc of resp.tool_calls) {
        const toolName = tc.function.name;
        const toolArgs = JSON.parse(tc.function.arguments);
        log(`  🛠️  Tool: ${toolName}(${JSON.stringify(toolArgs)})`);

        const resultado = ejecutarTool(toolName, toolArgs);
        mensajes.push({ role: 'tool', tool_call_id: tc.id, content: resultado });
      }
      continue;
    }

    // Si el LLM da respuesta final
    if (resp.content) {
      log(`\n✅ Respuesta final:\n${'─'.repeat(60)}\n${resp.content}\n${'─'.repeat(60)}`);
      return resp.content;
    }

    break;
  }

  const fallback = 'El agente no pudo completar la respuesta en el número máximo de pasos.';
  log(`\n⚠️ ${fallback}`);
  return fallback;
}

// ── Modo CLI: ejecutar directamente con node agent-horarios.js
if (process.argv[1]?.endsWith('agent-horarios.js')) {
  const preguntas = [
    '¿Cuántos grupos faltan por asignar horario?',
    '¿Qué docentes están disponibles el Lunes en la franja 8-10?',
    'Detecta conflictos en el periodo 2025-1',
  ];

  for (const p of preguntas) {
    await correrAgente(p);
    console.log('\n' + '═'.repeat(60) + '\n');
  }
}
