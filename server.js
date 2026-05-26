// ═══════════════════════════════════════════════════════════════
// server.js  —  Servidor UNIAJC v2.0
// ═══════════════════════════════════════════════════════════════
import { createRequire } from 'node:module';
import { createServer }  from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname }   from 'node:path';
import { fileURLToPath }   from 'node:url';
import { DatabaseSync }    from 'node:sqlite';

const require = createRequire(import.meta.url);
require('dotenv').config();
process.removeAllListeners('warning');

import { correrAgente, ejecutarTool } from './agent-horarios.js';

const PORT    = process.env.PORT    || 3000;
const DB_PATH = process.env.DB_PATH || './horarios.db';
const __dir   = dirname(fileURLToPath(import.meta.url));


if (!existsSync(DB_PATH) && !existsSync(join(__dir, 'horarios.db'))) {
  console.error('❌ horarios.db no encontrada. Ejecuta: node seed-horarios.js');
  process.exit(1);
}

// ── Leer body de request
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const server = createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const path   = url.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const json = (data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  // ── GET / → interfaz web
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    const html = readFileSync(join(__dir, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── POST /api/agente → chat con el agente
  if (method === 'POST' && path === '/api/agente') {
    try {
      const { pregunta } = JSON.parse(await readBody(req));
      if (!pregunta?.trim()) return json({ error: 'Falta el campo "pregunta"' }, 400);
      console.log(`\n📩 "${pregunta}"`);
      const logs = [];
      const respuesta = await correrAgente(pregunta, msg => { logs.push(msg); process.stdout.write(msg + '\n'); });
      json({ respuesta, logs });
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── GET /api/estado → snapshot completo de la BD
  if (method === 'GET' && path === '/api/estado') {
    try {
      const db = new DatabaseSync(DB_PATH);
      const data = {
        docentes:  db.prepare('SELECT id, nombre, email, tipo, carga_max, carga_actual FROM docentes').all(),
        materias:  db.prepare('SELECT id, codigo, nombre, semestre, creditos FROM materias ORDER BY semestre, codigo').all(),
        aulas:     db.prepare('SELECT id, codigo, tipo, capacidad, bloque FROM aulas').all(),
        grupos:    db.prepare('SELECT g.id, g.num_grupo, g.inscritos, g.cupo_max, g.semestre, m.nombre as materia, m.codigo FROM grupos g JOIN materias m ON g.materia_id=m.id ORDER BY g.semestre').all(),
        horario:   db.prepare(`
          SELECT ha.id, ha.dia, ha.franja, ha.estado, ha.periodo,
                 m.nombre as materia, m.codigo as materia_codigo,
                 d.nombre as docente, d.email as docente_email,
                 a.codigo as aula, a.tipo as tipo_aula,
                 g.num_grupo, g.inscritos, g.semestre
          FROM horario_asignado ha
          JOIN grupos g ON ha.grupo_id=g.id
          JOIN materias m ON g.materia_id=m.id
          JOIN docentes d ON ha.docente_id=d.id
          JOIN aulas a ON ha.aula_id=a.id
          ORDER BY ha.dia, ha.franja
        `).all(),
        conflictos: db.prepare('SELECT * FROM conflictos_detectados ORDER BY fecha DESC LIMIT 50').all(),
      };
      db.close();
      json(data);
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── GET /api/exportar?formato=csv&periodo=2025-1 → descarga directa
  if (method === 'GET' && path === '/api/exportar') {
    try {
      const formato  = url.searchParams.get('formato') || 'csv';
      const periodo  = url.searchParams.get('periodo') || '2025-1';
      const resultado = JSON.parse(await ejecutarTool('exportar_horario', { formato, periodo }));

      if (!resultado.exito) return json({ error: resultado.razon }, 400);

      if (formato === 'csv') {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="horario-${periodo}.csv"`
        });
        res.end(resultado.contenido);
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="horario-${periodo}.json"`
        });
        res.end(JSON.stringify(resultado.horario, null, 2));
      }
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── POST /api/notificar → notificar docente
  if (method === 'POST' && path === '/api/notificar') {
    try {
      const { docente_id, tipo_aviso = 'horario', mensaje_extra = '' } = JSON.parse(await readBody(req));
      if (!docente_id) return json({ error: 'Falta docente_id' }, 400);
      const resultado = JSON.parse(await ejecutarTool('notificar_docente', { docente_id, tipo_aviso, mensaje_extra }));
      json(resultado);
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── POST /api/tool → ejecutar tool directamente (debug)
  if (method === 'POST' && path === '/api/tool') {
    try {
      const { tool, args } = JSON.parse(await readBody(req));
      const resultado = await ejecutarTool(tool, args || {});
      json({ resultado: JSON.parse(resultado) });
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── DELETE /api/horario/:id → eliminar asignación
  if (method === 'DELETE' && path.startsWith('/api/horario/')) {
    try {
      const id = Number(path.split('/')[3]);
      const db = new DatabaseSync(DB_PATH);
      // recuperar docente_id antes de borrar para actualizar carga
      const asig = db.prepare('SELECT docente_id FROM horario_asignado WHERE id=?').get(id);
      if (!asig) { db.close(); return json({ error: 'Asignación no encontrada' }, 404); }
      db.prepare('DELETE FROM horario_asignado WHERE id=?').run(id);
      db.prepare('UPDATE docentes SET carga_actual = MAX(0, carga_actual - 2) WHERE id=?').run(asig.docente_id);
      db.close();
      json({ exito: true, mensaje: `Asignación ${id} eliminada` });
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  json({ error: 'Ruta no encontrada' }, 404);
});

server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  🎓 Agente UNIAJC v2.0 — Horarios 2025-1        ║');
  console.log(`║  🌐 http://localhost:${PORT}                        ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  POST /api/agente          → Chat con la IA      ║');
  console.log('║  GET  /api/estado          → Estado de la BD     ║');
  console.log('║  GET  /api/exportar?formato=csv → Descargar CSV  ║');
  console.log('║  POST /api/notificar       → Email a docente     ║');
  console.log('║  DELETE /api/horario/:id   → Eliminar asignación ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
});
