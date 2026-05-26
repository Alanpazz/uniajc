// ═══════════════════════════════════════════════════════════════
// agent-horarios.js  —  Agente ReAct de horarios UNIAJC
// Ciclo: Razona → Actúa (tool) → Observa → repite hasta respuesta
// ═══════════════════════════════════════════════════════════════
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();
process.removeAllListeners('warning');

//const GROQ_KEY   = process.env.GROQ_API_KEY;
//const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_KEY   = process.env.DEEPSEEK_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL;

const DB_PATH = process.env.DB_PATH || './horarios.db';
const PERIODO    = '2025-1';



if (!GROQ_KEY) {
  console.error('❌ No se encontró GROQ_API_KEY en .env');
  process.exit(1);
}

// ── Schema de la BD para el LLM
export const SCHEMA = `
TABLAS DISPONIBLES:
- docentes(id, nombre, email, tipo[planta|catedra], carga_max, carga_actual)
- disponibilidad_docente(id, docente_id, dia[Lunes|Martes|Miercoles|Jueves|Viernes|Sabado], franja[6-8|8-10|10-12|14-16|16-18|18-20|20-22])
- materias(id, codigo, nombre, creditos, horas_semana, programa, semestre, prerequisito_id)
- aulas(id, codigo, tipo[presencial|virtual|laboratorio], capacidad, bloque)
- grupos(id, materia_id, num_grupo, cupo_max, inscritos, programa, semestre)
- horario_asignado(id, grupo_id, docente_id, aula_id, dia, franja, periodo, estado[propuesto|confirmado|conflicto])
- conflictos_detectados(id, tipo[aula_ocupada|docente_cruce|carga_excedida], descripcion, entidad_id, resuelto, fecha)
`.trim();

// ── Tools definidas para el LLM
export const TOOLS = [
  // ── CONSULTA ─────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'ejecutar_sql',
      description: 'Ejecuta una query SQL SELECT de solo lectura. Úsala para consultar cualquier dato de la BD.',
      parameters: {
        type: 'object',
        properties: {
          query:       { type: 'string', description: 'Query SQL SELECT válida' },
          descripcion: { type: 'string', description: 'Qué hace esta query' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_tablas',
      description: 'Muestra el schema completo de todas las tablas de la BD.',
      parameters: { type: 'object', properties: {} }
    }
  },
  // ── HORARIO ──────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'verificar_disponibilidad',
      description: 'Consulta si un docente está disponible en un día y franja, y si ya tiene clase asignada.',
      parameters: {
        type: 'object',
        properties: {
          docente_id: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          dia:        { type: 'string', description: 'Lunes|Martes|Miercoles|Jueves|Viernes|Sabado' },
          franja:     { type: 'string', description: '6-8|8-10|10-12|14-16|16-18|18-20|20-22' }
        },
        required: ['docente_id', 'dia', 'franja']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'asignar_clase',
      description: 'Asigna una clase validando: disponibilidad del docente, aula libre, sin cruce horario y cupo suficiente.',
      parameters: {
        type: 'object',
        properties: {
          grupo_id:   { anyOf: [{ type: 'number' }, { type: 'string' }] },
          docente_id: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          aula_id:    { anyOf: [{ type: 'number' }, { type: 'string' }] },
          dia:        { type: 'string' },
          franja:     { type: 'string' }
        },
        required: ['grupo_id', 'docente_id', 'aula_id', 'dia', 'franja']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_grupos_sin_horario',
      description: 'Lista los grupos que aún no tienen horario asignado en el periodo actual.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'detectar_conflictos',
      description: 'Escanea el horario completo buscando: docente con dos clases simultáneas, aula ocupada dos veces, o docente con carga excedida.',
      parameters: {
        type: 'object',
        properties: {
          periodo: { type: 'string', description: 'Periodo a revisar ej: 2025-1' }
        },
        required: ['periodo']
      }
    }
  },
  // ── CREACIÓN ─────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'crear_docente',
      description: 'Crea un nuevo docente en la base de datos. También puede registrar su disponibilidad horaria.',
      parameters: {
        type: 'object',
        properties: {
          nombre:        { type: 'string', description: 'Nombre completo del docente' },
          email:         { type: 'string', description: 'Correo institucional' },
          tipo:          { type: 'string', description: 'planta o catedra' },
          carga_max:     { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Horas máximas por semana' },
          disponibilidad: {
            type: 'array',
            description: 'Lista de franjas disponibles. Cada item: { dia, franja }',
            items: {
              type: 'object',
              properties: {
                dia:    { type: 'string' },
                franja: { type: 'string' }
              }
            }
          }
        },
        required: ['nombre', 'email', 'tipo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'crear_materia',
      description: 'Crea una nueva materia en el programa académico.',
      parameters: {
        type: 'object',
        properties: {
          codigo:         { type: 'string', description: 'Código único ej: IS701' },
          nombre:         { type: 'string', description: 'Nombre de la materia' },
          creditos:       { anyOf: [{ type: 'number' }, { type: 'string' }] },
          horas_semana:   { anyOf: [{ type: 'number' }, { type: 'string' }] },
          programa:       { type: 'string', description: 'Código del programa ej: IS' },
          semestre:       { anyOf: [{ type: 'number' }, { type: 'string' }] },
          prerequisito_id:{ anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }], description: 'ID de la materia prerequisito (opcional)' }
        },
        required: ['codigo', 'nombre', 'creditos', 'horas_semana', 'programa', 'semestre']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'crear_aula',
      description: 'Registra un nuevo salón o espacio de clase.',
      parameters: {
        type: 'object',
        properties: {
          codigo:    { type: 'string', description: 'Código único del aula ej: C301' },
          tipo:      { type: 'string', description: 'presencial, virtual o laboratorio' },
          capacidad: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Cuántos estudiantes caben' },
          bloque:    { type: 'string', description: 'Bloque o ubicación ej: Bloque C' }
        },
        required: ['codigo', 'tipo', 'capacidad']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'crear_grupo',
      description: 'Crea un nuevo grupo para una materia existente.',
      parameters: {
        type: 'object',
        properties: {
          materia_id: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'ID de la materia' },
          num_grupo:  { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Número del grupo ej: 1, 2, 3' },
          cupo_max:   { anyOf: [{ type: 'number' }, { type: 'string' }] },
          inscritos:  { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'Estudiantes inscritos actualmente' },
          programa:   { type: 'string' },
          semestre:   { anyOf: [{ type: 'number' }, { type: 'string' }] }
        },
        required: ['materia_id', 'num_grupo', 'cupo_max', 'programa', 'semestre']
      }
    }
  },
  // ── EXPORTAR / NOTIFICAR ──────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'exportar_horario',
      description: 'Genera el horario completo del periodo en formato CSV o JSON listo para descargar.',
      parameters: {
        type: 'object',
        properties: {
          formato:  { type: 'string', description: 'csv o json' },
          periodo:  { type: 'string', description: 'Periodo a exportar ej: 2025-1' },
          filtro_docente_id: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }], description: 'Opcional: exportar solo el horario de un docente' }
        },
        required: ['formato', 'periodo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notificar_docente',
      description: 'Envía un email al docente con su horario asignado o con un aviso de conflicto.',
      parameters: {
        type: 'object',
        properties: {
          docente_id: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          tipo_aviso: { type: 'string', description: 'horario o conflicto' },
          mensaje_extra: { type: 'string', description: 'Texto adicional opcional para incluir en el email' }
        },
        required: ['docente_id', 'tipo_aviso']
      }
    }
  }
];

// ── Corrector de tipos numéricos
function coerceArgs(toolName, args) {
  const numFields = {
    verificar_disponibilidad: ['docente_id'],
    asignar_clase:            ['grupo_id', 'docente_id', 'aula_id'],
    detectar_conflictos:      [],
    listar_grupos_sin_horario:[],
    ejecutar_sql:             [],
    listar_tablas:            [],
    crear_docente:            ['carga_max'],
    crear_materia:            ['creditos', 'horas_semana', 'semestre', 'prerequisito_id'],
    crear_aula:               ['capacidad'],
    crear_grupo:              ['materia_id', 'num_grupo', 'cupo_max', 'inscritos', 'semestre'],
    exportar_horario:         ['filtro_docente_id'],
    notificar_docente:        ['docente_id'],
  };
  const fields = numFields[toolName] || [];
  const out = { ...args };
  for (const f of fields) {
    if (out[f] !== undefined && out[f] !== null) out[f] = Number(out[f]);
  }
  return out;
}

// ── Ejecutor de tools
export async function ejecutarTool(nombre, args) {
  args = coerceArgs(nombre, args);
  const db = new DatabaseSync(DB_PATH);

  try {
    switch (nombre) {

      // ────────────────────────────────────────
      case 'ejecutar_sql': {
        if (!/^\s*SELECT/i.test(args.query)) {
          return JSON.stringify({ error: 'Solo se permiten queries SELECT' });
        }
        try {
          const rows = db.prepare(args.query).all();
          console.log(`  📊 SQL: ${args.descripcion || args.query.substring(0, 60)}`);
          return JSON.stringify({ filas: rows, total: rows.length });
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      }

      case 'listar_tablas':
        return SCHEMA;

      // ────────────────────────────────────────
      case 'verificar_disponibilidad': {
        const { docente_id, dia, franja } = args;
        const disp    = db.prepare('SELECT * FROM disponibilidad_docente WHERE docente_id=? AND dia=? AND franja=?').get(docente_id, dia, franja);
        const ocupado = db.prepare('SELECT ha.*, m.nombre as materia FROM horario_asignado ha JOIN grupos g ON ha.grupo_id=g.id JOIN materias m ON g.materia_id=m.id WHERE ha.docente_id=? AND ha.dia=? AND ha.franja=? AND ha.periodo=?').get(docente_id, dia, franja, PERIODO);
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

      // ────────────────────────────────────────
      case 'listar_grupos_sin_horario': {
        const rows = db.prepare(`
          SELECT g.id, g.num_grupo, g.inscritos, g.cupo_max, g.semestre,
                 m.codigo, m.nombre as materia, m.creditos
          FROM grupos g JOIN materias m ON g.materia_id=m.id
          WHERE g.id NOT IN (SELECT DISTINCT grupo_id FROM horario_asignado WHERE periodo=?)
          ORDER BY g.semestre, m.codigo
        `).all(PERIODO);
        console.log(`  📋 Grupos sin horario: ${rows.length}`);
        return JSON.stringify({ grupos: rows, total: rows.length });
      }

      // ────────────────────────────────────────
      case 'asignar_clase': {
        const { grupo_id, docente_id, aula_id, dia, franja } = args;

        const dispDocente = db.prepare('SELECT 1 FROM disponibilidad_docente WHERE docente_id=? AND dia=? AND franja=?').get(docente_id, dia, franja);
        if (!dispDocente) return JSON.stringify({ exito: false, razon: `El docente ${docente_id} no está disponible el ${dia} ${franja}` });

        const docenteOcupado = db.prepare('SELECT 1 FROM horario_asignado WHERE docente_id=? AND dia=? AND franja=? AND periodo=?').get(docente_id, dia, franja, PERIODO);
        if (docenteOcupado) {
          db.prepare('INSERT INTO conflictos_detectados (tipo,descripcion,entidad_id) VALUES (?,?,?)').run('docente_cruce', `Docente ${docente_id} ya tiene clase el ${dia} ${franja} en ${PERIODO}`, docente_id);
          return JSON.stringify({ exito: false, razon: `CONFLICTO: Docente ya tiene clase ese horario.` });
        }

        const aulaOcupada = db.prepare('SELECT 1 FROM horario_asignado WHERE aula_id=? AND dia=? AND franja=? AND periodo=?').get(aula_id, dia, franja, PERIODO);
        if (aulaOcupada) {
          db.prepare('INSERT INTO conflictos_detectados (tipo,descripcion,entidad_id) VALUES (?,?,?)').run('aula_ocupada', `Aula ${aula_id} ya está ocupada el ${dia} ${franja} en ${PERIODO}`, aula_id);
          return JSON.stringify({ exito: false, razon: `CONFLICTO: Aula ya está ocupada.` });
        }

        const grupo = db.prepare('SELECT inscritos FROM grupos WHERE id=?').get(grupo_id);
        const aula  = db.prepare('SELECT capacidad, codigo FROM aulas WHERE id=?').get(aula_id);
        if (grupo && aula && grupo.inscritos > aula.capacidad) {
          return JSON.stringify({ exito: false, razon: `Aula ${aula.codigo} (cap.${aula.capacidad}) insuficiente para ${grupo.inscritos} inscritos.` });
        }

        const result = db.prepare('INSERT INTO horario_asignado (grupo_id,docente_id,aula_id,dia,franja,periodo,estado) VALUES (?,?,?,?,?,?,?)').run(grupo_id, docente_id, aula_id, dia, franja, PERIODO, 'propuesto');
        db.prepare('UPDATE docentes SET carga_actual = carga_actual + 2 WHERE id=?').run(docente_id);
        console.log(`  ✅ Clase asignada: grupo ${grupo_id} | docente ${docente_id} | ${dia} ${franja} | aula ${aula_id}`);
        return JSON.stringify({ exito: true, id: result.lastInsertRowid, mensaje: `Clase asignada exitosamente.` });
      }

      // ────────────────────────────────────────
      case 'detectar_conflictos': {
        const { periodo } = args;
        const conflictos = [];

        const docenteCruce = db.prepare(`SELECT docente_id, dia, franja, COUNT(*) as clases, GROUP_CONCAT(grupo_id) as grupos FROM horario_asignado WHERE periodo=? GROUP BY docente_id, dia, franja HAVING clases > 1`).all(periodo);
        for (const c of docenteCruce) {
          const desc = `Docente ${c.docente_id} tiene ${c.clases} clases el ${c.dia} ${c.franja} (grupos: ${c.grupos})`;
          db.prepare('INSERT INTO conflictos_detectados (tipo,descripcion,entidad_id) VALUES (?,?,?)').run('docente_cruce', desc, c.docente_id);
          conflictos.push({ tipo: 'docente_cruce', descripcion: desc });
        }

        const aulaCruce = db.prepare(`SELECT aula_id, dia, franja, COUNT(*) as clases, GROUP_CONCAT(grupo_id) as grupos FROM horario_asignado WHERE periodo=? GROUP BY aula_id, dia, franja HAVING clases > 1`).all(periodo);
        for (const c of aulaCruce) {
          const desc = `Aula ${c.aula_id} tiene ${c.clases} clases el ${c.dia} ${c.franja} (grupos: ${c.grupos})`;
          db.prepare('INSERT INTO conflictos_detectados (tipo,descripcion,entidad_id) VALUES (?,?,?)').run('aula_ocupada', desc, c.aula_id);
          conflictos.push({ tipo: 'aula_ocupada', descripcion: desc });
        }

        const cargaExcedida = db.prepare(`SELECT d.id, d.nombre, d.carga_max, d.carga_actual FROM docentes d WHERE d.carga_actual > d.carga_max`).all();
        for (const d of cargaExcedida) {
          const desc = `${d.nombre} tiene carga ${d.carga_actual}h > máximo ${d.carga_max}h`;
          db.prepare('INSERT INTO conflictos_detectados (tipo,descripcion,entidad_id) VALUES (?,?,?)').run('carga_excedida', desc, d.id);
          conflictos.push({ tipo: 'carga_excedida', descripcion: desc });
        }

        console.log(`  🔎 Conflictos detectados: ${conflictos.length}`);
        return JSON.stringify({ periodo, conflictos_detectados: conflictos.length, detalle: conflictos, mensaje: conflictos.length === 0 ? 'Sin conflictos detectados' : `${conflictos.length} conflicto(s) registrado(s)` });
      }

      // ────────────────────────────────────────
      case 'crear_docente': {
        const { nombre, email, tipo, carga_max = 20, disponibilidad = [] } = args;
        if (!['planta','catedra'].includes(tipo)) return JSON.stringify({ exito: false, razon: 'tipo debe ser planta o catedra' });

        try {
          const result = db.prepare('INSERT INTO docentes (nombre,email,tipo,carga_max) VALUES (?,?,?,?)').run(nombre, email, tipo, Number(carga_max));
          const id = result.lastInsertRowid;

          const iDisp = db.prepare('INSERT INTO disponibilidad_docente (docente_id,dia,franja) VALUES (?,?,?)');
          let dispInsertadas = 0;
          for (const d of disponibilidad) {
            try { iDisp.run(id, d.dia, d.franja); dispInsertadas++; } catch (_) {}
          }
          console.log(`  👨‍🏫 Docente creado: ${nombre} (id: ${id}) | ${dispInsertadas} franjas de disponibilidad`);
          return JSON.stringify({ exito: true, id, nombre, email, tipo, carga_max, disponibilidad_registrada: dispInsertadas });
        } catch (e) {
          return JSON.stringify({ exito: false, razon: e.message.includes('UNIQUE') ? `El email ${email} ya está registrado` : e.message });
        }
      }

      // ────────────────────────────────────────
      case 'crear_materia': {
        const { codigo, nombre, creditos, horas_semana, programa, semestre, prerequisito_id = null } = args;
        try {
          const result = db.prepare('INSERT INTO materias (codigo,nombre,creditos,horas_semana,programa,semestre,prerequisito_id) VALUES (?,?,?,?,?,?,?)').run(codigo, nombre, Number(creditos), Number(horas_semana), programa, Number(semestre), prerequisito_id || null);
          console.log(`  📚 Materia creada: ${codigo} - ${nombre} (id: ${result.lastInsertRowid})`);
          return JSON.stringify({ exito: true, id: result.lastInsertRowid, codigo, nombre, semestre });
        } catch (e) {
          return JSON.stringify({ exito: false, razon: e.message.includes('UNIQUE') ? `El código ${codigo} ya existe` : e.message });
        }
      }

      // ────────────────────────────────────────
      case 'crear_aula': {
        const { codigo, tipo, capacidad, bloque = '' } = args;
        if (!['presencial','virtual','laboratorio'].includes(tipo)) return JSON.stringify({ exito: false, razon: 'tipo debe ser presencial, virtual o laboratorio' });
        try {
          const result = db.prepare('INSERT INTO aulas (codigo,tipo,capacidad,bloque) VALUES (?,?,?,?)').run(codigo, tipo, Number(capacidad), bloque);
          console.log(`  🏫 Aula creada: ${codigo} (id: ${result.lastInsertRowid})`);
          return JSON.stringify({ exito: true, id: result.lastInsertRowid, codigo, tipo, capacidad });
        } catch (e) {
          return JSON.stringify({ exito: false, razon: e.message.includes('UNIQUE') ? `El código ${codigo} ya existe` : e.message });
        }
      }

      // ────────────────────────────────────────
      case 'crear_grupo': {
        const { materia_id, num_grupo, cupo_max, inscritos = 0, programa, semestre } = args;
        const materia = db.prepare('SELECT nombre, codigo FROM materias WHERE id=?').get(Number(materia_id));
        if (!materia) return JSON.stringify({ exito: false, razon: `No existe la materia con id ${materia_id}` });
        try {
          const result = db.prepare('INSERT INTO grupos (materia_id,num_grupo,cupo_max,inscritos,programa,semestre) VALUES (?,?,?,?,?,?)').run(Number(materia_id), Number(num_grupo), Number(cupo_max), Number(inscritos), programa, Number(semestre));
          console.log(`  👥 Grupo creado: ${materia.codigo} Grupo ${num_grupo} (id: ${result.lastInsertRowid})`);
          return JSON.stringify({ exito: true, id: result.lastInsertRowid, materia: materia.nombre, num_grupo, cupo_max, inscritos });
        } catch (e) {
          return JSON.stringify({ exito: false, razon: e.message });
        }
      }

      // ────────────────────────────────────────
      case 'exportar_horario': {
        const { formato, periodo, filtro_docente_id } = args;

        let query = `
          SELECT ha.id, ha.dia, ha.franja, ha.estado, ha.periodo,
                 m.codigo as materia_codigo, m.nombre as materia,
                 d.nombre as docente, d.email as docente_email,
                 a.codigo as aula, a.tipo as tipo_aula,
                 g.num_grupo, g.inscritos, g.semestre
          FROM horario_asignado ha
          JOIN grupos g ON ha.grupo_id=g.id
          JOIN materias m ON g.materia_id=m.id
          JOIN docentes d ON ha.docente_id=d.id
          JOIN aulas a ON ha.aula_id=a.id
          WHERE ha.periodo=?
        `;
        const params = [periodo];
        if (filtro_docente_id) { query += ' AND ha.docente_id=?'; params.push(filtro_docente_id); }
        query += ' ORDER BY ha.dia, ha.franja, g.semestre';

        const rows = db.prepare(query).all(...params);

        if (formato === 'csv') {
          const headers = ['id','dia','franja','materia_codigo','materia','docente','docente_email','aula','tipo_aula','num_grupo','inscritos','semestre','estado','periodo'];
          const csv = [
            headers.join(','),
            ...rows.map(r => headers.map(h => `"${String(r[h] ?? '').replace(/"/g,'""')}"`).join(','))
          ].join('\n');
          console.log(`  📤 Exportando ${rows.length} clases en CSV`);
          return JSON.stringify({ exito: true, formato: 'csv', total: rows.length, contenido: csv });
        } else {
          console.log(`  📤 Exportando ${rows.length} clases en JSON`);
          return JSON.stringify({ exito: true, formato: 'json', total: rows.length, horario: rows });
        }
      }

      // ────────────────────────────────────────
      case 'notificar_docente': {
        const { docente_id, tipo_aviso, mensaje_extra = '' } = args;

        const docente = db.prepare('SELECT * FROM docentes WHERE id=?').get(docente_id);
        if (!docente) return JSON.stringify({ exito: false, razon: `No existe el docente con id ${docente_id}` });

        // Obtener su horario
        const clases = db.prepare(`
          SELECT ha.dia, ha.franja, ha.estado, m.nombre as materia,
                 a.codigo as aula, g.num_grupo, g.inscritos
          FROM horario_asignado ha
          JOIN grupos g ON ha.grupo_id=g.id
          JOIN materias m ON g.materia_id=m.id
          JOIN aulas a ON ha.aula_id=a.id
          WHERE ha.docente_id=? AND ha.periodo=?
          ORDER BY ha.dia, ha.franja
        `).all(docente_id, PERIODO);

        // Obtener conflictos relacionados
        const conflictos = db.prepare(`SELECT * FROM conflictos_detectados WHERE entidad_id=? AND resuelto=0 ORDER BY fecha DESC`).all(docente_id);

        // Enviar email
        db.close(); // cerrar antes del await
        const resultado = await enviarEmail({ docente, clases, conflictos, tipo_aviso, mensaje_extra, periodo: PERIODO });
        return JSON.stringify(resultado);
      }

      default:
        return JSON.stringify({ error: `Tool desconocida: ${nombre}` });
    }
  } finally {
    try { db.close(); } catch (_) {}
  }
}

// ── Envío de email con Nodemailer
async function enviarEmail({ docente, clases, conflictos, tipo_aviso, mensaje_extra, periodo }) {
  const nodemailer = require('nodemailer');

  const smtpConfigured = process.env.SMTP_USER && process.env.SMTP_PASS &&
    !process.env.SMTP_USER.includes('tu_correo');

  if (!smtpConfigured) {
    // Modo simulación: mostrar en consola pero no enviar
    console.log(`  📧 [SIMULACIÓN] Email para: ${docente.nombre} <${docente.email}>`);
    console.log(`     Tipo: ${tipo_aviso} | Clases: ${clases.length} | Conflictos: ${conflictos.length}`);
    return {
      exito: true,
      simulado: true,
      mensaje: `Email simulado (configura SMTP_USER y SMTP_PASS en .env para envío real)`,
      destinatario: docente.email,
      clases_incluidas: clases.length,
      conflictos_incluidos: conflictos.length
    };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const asunto = tipo_aviso === 'conflicto'
    ? `⚠️ Conflicto en su horario — UNIAJC ${periodo}`
    : `📅 Su horario asignado — UNIAJC ${periodo}`;

  const tablaClases = clases.length > 0
    ? `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
        <tr style="background:#1B3A5C;color:white">
          <th>Día</th><th>Franja</th><th>Materia</th><th>Aula</th><th>Grupo</th><th>Estado</th>
        </tr>
        ${clases.map(c => `<tr>
          <td>${c.dia}</td><td>${c.franja}</td><td>${c.materia}</td>
          <td>${c.aula}</td><td>Grupo ${c.num_grupo}</td>
          <td style="color:${c.estado==='confirmado'?'green':c.estado==='conflicto'?'red':'orange'}">${c.estado}</td>
        </tr>`).join('')}
      </table>`
    : '<p>No tiene clases asignadas aún.</p>';

  const tablaConflictos = conflictos.length > 0
    ? `<h3 style="color:#DC2626">⚠️ Conflictos activos (${conflictos.length})</h3>
       <ul>${conflictos.map(c => `<li><strong>${c.tipo}:</strong> ${c.descripcion}</li>`).join('')}</ul>`
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
      <div style="background:#1B3A5C;color:white;padding:24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">🎓 UNIAJC — Agente de Horarios</h2>
        <p style="margin:4px 0;opacity:0.8">Facultad de Ingeniería de Sistemas · Periodo ${periodo}</p>
      </div>
      <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
        <p>Estimado/a <strong>${docente.nombre}</strong>,</p>
        ${tipo_aviso === 'conflicto'
          ? '<p>Se han detectado conflictos en su horario que requieren atención:</p>'
          : '<p>A continuación encontrará su horario asignado para el periodo <strong>' + periodo + '</strong>:</p>'
        }
        ${tablaConflictos}
        <h3>📅 Sus clases asignadas</h3>
        ${tablaClases}
        ${mensaje_extra ? `<div style="margin-top:16px;padding:12px;background:#FFF7ED;border-left:4px solid #D97706;border-radius:4px"><p><strong>Nota adicional:</strong> ${mensaje_extra}</p></div>` : ''}
        <hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb">
        <p style="color:#6B7280;font-size:13px">Este mensaje fue generado automáticamente por el Agente IA de Horarios UNIAJC.</p>
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || `"Agente Horarios UNIAJC" <${process.env.SMTP_USER}>`,
      to: docente.email,
      subject: asunto,
      html
    });
    console.log(`  ✉️  Email enviado a ${docente.nombre} <${docente.email}>`);
    return { exito: true, simulado: false, mensaje: `Email enviado a ${docente.email}`, clases_incluidas: clases.length };
  } catch (e) {
    console.error(`  ❌ Error enviando email: ${e.message}`);
    return { exito: false, razon: e.message };
  }
}

// ── Llamar a Groq
async function llamarGroq(mensajes) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${GROQ_KEY}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: mensajes,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 2000
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`DeepSeek error: ${data.error.message}`);
  return data.choices[0].message;
}

// ── Ciclo ReAct principal
export async function correrAgente(pregunta, onStep) {
  const log = (msg) => { if (onStep) onStep(msg); else console.log(msg); };
  log(`\n🤖 Agente UNIAJC v2.0\n📝 "${pregunta}"\n${'─'.repeat(60)}`);

  const mensajes = [
    {
      role: 'system',
      content: `Eres el Agente de Optimización de Horarios de la UNIAJC (Cali, Colombia), periodo ${PERIODO}.

Tu misión: gestionar el horario académico completo — consultar, crear, asignar, detectar conflictos, exportar y notificar.

SCHEMA:
${SCHEMA}

CAPACIDADES:
- Crear docentes, materias, aulas y grupos directamente en la BD
- Asignar clases con validación anti-conflicto automática
- Detectar 3 tipos de conflicto: cruce docente, aula ocupada, carga excedida
- Exportar el horario en CSV o JSON
- Notificar a docentes por email (con su horario o con alertas de conflicto)

REGLAS:
1. Siempre usa las tools para leer o escribir en la BD. Nunca inventes datos.
2. Para crear cualquier entidad, primero verifica si ya existe con ejecutar_sql.
3. Para asignar, siempre verifica disponibilidad primero.
4. Al detectar conflictos, ofrece notificar a los docentes afectados.
5. Responde siempre en español, con claridad.`
    },
    { role: 'user', content: pregunta }
  ];

  let pasos = 0;
  const MAX_PASOS = 10;

  while (pasos++ < MAX_PASOS) {
    log(`\n🔄 Paso ${pasos}/${MAX_PASOS}...`);
    const resp = await llamarGroq(mensajes);
    mensajes.push(resp);

    if (resp.tool_calls?.length) {
      for (const tc of resp.tool_calls) {
        const toolName = tc.function.name;
        const toolArgs = JSON.parse(tc.function.arguments);
        log(`  🛠️  ${toolName}(${JSON.stringify(toolArgs)})`);
        const resultado = await ejecutarTool(toolName, toolArgs);
        mensajes.push({ role: 'tool', tool_call_id: tc.id, content: resultado });
      }
      continue;
    }

    if (resp.content) {
      log(`\n✅ ${resp.content}`);
      return resp.content;
    }
    break;
  }

  return 'El agente no pudo completar la respuesta en el número máximo de pasos.';
}
