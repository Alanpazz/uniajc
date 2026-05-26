// ═══════════════════════════════════════════════════════════════
// seed-horarios.js  —  Base de datos UNIAJC v2.0
// ═══════════════════════════════════════════════════════════════
import { DatabaseSync } from 'node:sqlite';
process.removeAllListeners('warning');

const DB_PATH = process.env.DB_PATH || './horarios.db';
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS docentes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre       TEXT NOT NULL,
    email        TEXT UNIQUE,
    tipo         TEXT CHECK(tipo IN ('planta','catedra')) NOT NULL,
    carga_max    INTEGER DEFAULT 20,
    carga_actual INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS disponibilidad_docente (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    docente_id INTEGER REFERENCES docentes(id),
    dia        TEXT CHECK(dia IN ('Lunes','Martes','Miercoles','Jueves','Viernes','Sabado')),
    franja     TEXT CHECK(franja IN ('6-8','8-10','10-12','14-16','16-18','18-20','20-22'))
  );
  CREATE TABLE IF NOT EXISTS materias (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo          TEXT UNIQUE NOT NULL,
    nombre          TEXT NOT NULL,
    creditos        INTEGER NOT NULL,
    horas_semana    INTEGER NOT NULL,
    programa        TEXT NOT NULL,
    semestre        INTEGER NOT NULL,
    prerequisito_id INTEGER REFERENCES materias(id)
  );
  CREATE TABLE IF NOT EXISTS aulas (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo    TEXT UNIQUE NOT NULL,
    tipo      TEXT CHECK(tipo IN ('presencial','virtual','laboratorio')),
    capacidad INTEGER NOT NULL,
    bloque    TEXT
  );
  CREATE TABLE IF NOT EXISTS grupos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    materia_id INTEGER REFERENCES materias(id),
    num_grupo  INTEGER NOT NULL,
    cupo_max   INTEGER NOT NULL,
    inscritos  INTEGER DEFAULT 0,
    programa   TEXT NOT NULL,
    semestre   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS horario_asignado (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    grupo_id   INTEGER REFERENCES grupos(id),
    docente_id INTEGER REFERENCES docentes(id),
    aula_id    INTEGER REFERENCES aulas(id),
    dia        TEXT NOT NULL,
    franja     TEXT NOT NULL,
    periodo    TEXT NOT NULL,
    estado     TEXT DEFAULT 'propuesto'
  );
  CREATE TABLE IF NOT EXISTS conflictos_detectados (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo        TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    entidad_id  INTEGER,
    resuelto    INTEGER DEFAULT 0,
    fecha       TEXT DEFAULT (date('now'))
  );
`);

// Docentes
const iD = db.prepare('INSERT OR IGNORE INTO docentes (nombre,email,tipo,carga_max) VALUES (?,?,?,?)');
[
  ['Felipe Vasco',    'f.vasco@uniajc.edu.co',    'planta',  24],
  ['Lucía Restrepo',  'l.restrepo@uniajc.edu.co',  'planta',  24],
  ['Hernán Peña',     'h.pena@uniajc.edu.co',     'catedra', 12],
  ['Gloria Martínez', 'g.martinez@uniajc.edu.co', 'planta',  24],
  ['Raúl Quintero',   'r.quintero@uniajc.edu.co', 'catedra',  8],
].forEach(r => iD.run(...r));

// Disponibilidad
const iDd = db.prepare('INSERT OR IGNORE INTO disponibilidad_docente (docente_id,dia,franja) VALUES (?,?,?)');
[
  [1,'Lunes','8-10'],[1,'Lunes','10-12'],[1,'Martes','8-10'],[1,'Martes','14-16'],
  [1,'Miercoles','10-12'],[1,'Jueves','8-10'],[1,'Viernes','14-16'],
  [2,'Lunes','16-18'],[2,'Lunes','18-20'],[2,'Miercoles','16-18'],[2,'Jueves','18-20'],
  [3,'Sabado','6-8'],[3,'Sabado','8-10'],[3,'Sabado','10-12'],
  [4,'Lunes','14-16'],[4,'Martes','16-18'],[4,'Jueves','14-16'],[4,'Viernes','16-18'],
  [5,'Miercoles','8-10'],[5,'Miercoles','10-12'],[5,'Viernes','8-10'],
].forEach(r => iDd.run(...r));

// Materias
const iM = db.prepare('INSERT OR IGNORE INTO materias (codigo,nombre,creditos,horas_semana,programa,semestre,prerequisito_id) VALUES (?,?,?,?,?,?,?)');
[
  ['IS101','Programación 1',           3,3,'IS',1,null],
  ['IS201','Programación 2',           3,3,'IS',2,1],
  ['IS301','Bases de Datos',           4,4,'IS',3,2],
  ['IS401','Ingeniería de Software 1', 4,4,'IS',4,3],
  ['IS501','Programación 4 (Angular)', 4,4,'IS',5,4],
  ['IS601','Ingeniería de Software 2', 4,4,'IS',6,5],
].forEach(r => iM.run(...r));

// Aulas
const iA = db.prepare('INSERT OR IGNORE INTO aulas (codigo,tipo,capacidad,bloque) VALUES (?,?,?,?)');
[
  ['A101','presencial',40,'Bloque A'],['A102','presencial',30,'Bloque A'],
  ['B201','laboratorio',25,'Bloque B'],['B202','laboratorio',25,'Bloque B'],
  ['VIR1','virtual',80,'Virtual'],['VIR2','virtual',80,'Virtual'],
].forEach(r => iA.run(...r));

// Grupos
const iG = db.prepare('INSERT OR IGNORE INTO grupos (materia_id,num_grupo,cupo_max,inscritos,programa,semestre) VALUES (?,?,?,?,?,?)');
[
  [1,1,35,28,'IS',1],[1,2,35,30,'IS',1],
  [2,1,30,22,'IS',2],[3,1,25,18,'IS',3],
  [4,1,30,20,'IS',4],[5,1,30,15,'IS',5],
].forEach(r => iG.run(...r));

const c = {
  docentes: db.prepare('SELECT COUNT(*) as n FROM docentes').get().n,
  materias: db.prepare('SELECT COUNT(*) as n FROM materias').get().n,
  aulas:    db.prepare('SELECT COUNT(*) as n FROM aulas').get().n,
  grupos:   db.prepare('SELECT COUNT(*) as n FROM grupos').get().n,
};
db.close();
console.log('✅ horarios.db v2.0 lista');
console.log(`   👨‍🏫 Docentes: ${c.docentes} | 📚 Materias: ${c.materias} | 🏫 Aulas: ${c.aulas} | 👥 Grupos: ${c.grupos}`);
