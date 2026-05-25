// ═══════════════════════════════════════════════════════════════
// server.js  —  Servidor HTTP para el Agente de Horarios UNIAJC
// Puerto: 3000  |  Ejecutar: node server.js
// ═══════════════════════════════════════════════════════════════
import { createRequire } from 'node:module';
import { createServer }  from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname }   from 'node:path';
import { fileURLToPath }   from 'node:url';

const require = createRequire(import.meta.url);
require('dotenv').config();
process.removeAllListeners('warning');

import { correrAgente, ejecutarTool } from './agent-horarios.js';

const PORT    = process.env.PORT || 3000;
const __dir   = dirname(fileURLToPath(import.meta.url));

// ── Verificar que la BD existe
if (!existsSync(join(__dir, 'horarios.db'))) {
  console.error('❌ horarios.db no encontrada. Ejecuta primero: node seed-horarios.js');
  process.exit(1);
}

// ── Router
const server = createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const path   = url.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET / → interfaz HTML
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    const html = readFileSync(join(__dir, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── POST /api/agente → ejecutar pregunta al agente
  if (method === 'POST' && path === '/api/agente') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { pregunta } = JSON.parse(body);
      if (!pregunta?.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'El campo "pregunta" es requerido' }));
        return;
      }

      console.log(`\n📩 Nueva consulta: "${pregunta}"`);
      const logs = [];
      const respuesta = await correrAgente(pregunta, (msg) => {
        logs.push(msg);
        process.stdout.write(msg + '\n');
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ respuesta, logs }));
    } catch (e) {
      console.error('Error en /api/agente:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/estado → snapshot de la BD
  if (method === 'GET' && path === '/api/estado') {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync('./horarios.db');

      const data = {
        docentes:    db.prepare('SELECT id, nombre, tipo, carga_max, carga_actual FROM docentes').all(),
        materias:    db.prepare('SELECT id, codigo, nombre, semestre FROM materias').all(),
        aulas:       db.prepare('SELECT id, codigo, tipo, capacidad FROM aulas').all(),
        grupos:      db.prepare('SELECT g.id, g.num_grupo, g.inscritos, m.nombre as materia FROM grupos g JOIN materias m ON g.materia_id=m.id').all(),
        horario:     db.prepare(`
          SELECT ha.id, ha.dia, ha.franja, ha.estado, ha.periodo,
                 m.nombre as materia, d.nombre as docente, a.codigo as aula,
                 g.num_grupo, g.inscritos
          FROM horario_asignado ha
          JOIN grupos g ON ha.grupo_id=g.id
          JOIN materias m ON g.materia_id=m.id
          JOIN docentes d ON ha.docente_id=d.id
          JOIN aulas a ON ha.aula_id=a.id
          ORDER BY ha.dia, ha.franja
        `).all(),
        conflictos:  db.prepare('SELECT * FROM conflictos_detectados ORDER BY fecha DESC').all(),
      };

      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/tool → ejecutar tool directamente (para pruebas)
  if (method === 'POST' && path === '/api/tool') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const { tool, args } = JSON.parse(body);
      const resultado = ejecutarTool(tool, args || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resultado: JSON.parse(resultado) }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║  🎓 Agente UNIAJC — Horarios 2025-1       ║');
  console.log(`║  🌐 http://localhost:${PORT}                  ║`);
  console.log('╠════════════════════════════════════════════╣');
  console.log('║  Endpoints:                                ║');
  console.log('║  GET  /           → Interfaz web           ║');
  console.log('║  POST /api/agente → Consultar al agente    ║');
  console.log('║  GET  /api/estado → Estado de la BD        ║');
  console.log('║  POST /api/tool   → Ejecutar tool directo  ║');
  console.log('╚════════════════════════════════════════════╝\n');
});
