require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { Pool } = require('pg');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { parseCdxml } = require('./lib/chemistry');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
const maxUploadBytes = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 10)) * 1024 * 1024;
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxUploadBytes, files: 2 }, fileFilter: (_req, file, callback) => {
  const allowed = file.fieldname === 'chemdraw' ? /\.(cdxml|cdx)$/i.test(file.originalname) : /\.(png|jpe?g|webp|svg)$/i.test(file.originalname);
  callback(allowed ? null : new Error(file.fieldname === 'chemdraw' ? 'Only .cdxml and .cdx files are supported. .chm is not supported.' : 'Structure images must be PNG, JPEG, WEBP, or SVG.'), allowed);
} });
const taCompoundUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 2 }, fileFilter: (_req, file, callback) => {
  const allowed = file.fieldname === 'chemdraw'
    ? /\.(cdxml|cdx)$/i.test(file.originalname)
    : file.fieldname === 'structureImage' && /\.(png|jpe?g|svg)$/i.test(file.originalname);
  callback(null, allowed);
} });

app.use(helmet({ contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'img-src': ["'self'", 'data:'], 'script-src': ["'self'"], 'style-src': ["'self'", 'https://fonts.googleapis.com'], 'font-src': ["'self'", 'https://fonts.gstatic.com'] } } }));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadDir, { dotfiles: 'deny', index: false, setHeaders: (res, filePath) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (path.extname(filePath).toLowerCase() === '.svg') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
} }));
app.use(express.static(path.join(__dirname, 'public')));

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const text = (value, max = 5000) => String(value ?? '').trim().slice(0, max);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();
function crc32Update(crc, chunk) {
  let value = crc;
  for (const byte of chunk) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}
function zipDateTime(date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}
async function writeWithBackpressure(response, chunk) {
  if (!response.write(chunk)) await once(response, 'drain');
}
function safeArchiveName(value) {
  return path.basename(String(value || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'file';
}
function csvCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
async function streamZipEntry(response, entry, archiveState) {
  const filename = Buffer.from(entry.name, 'utf8');
  if (filename.length > 65535) throw new Error('ZIP entry filename is too long.');
  const { dosTime, dosDate } = zipDateTime();
  const localOffset = archiveState.offset;
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0808, 6); // Data descriptor + UTF-8 filename.
  localHeader.writeUInt16LE(0, 8); // Store without compression.
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt16LE(filename.length, 26);
  await writeWithBackpressure(response, localHeader); archiveState.offset += localHeader.length;
  await writeWithBackpressure(response, filename); archiveState.offset += filename.length;

  let crc = 0xffffffff; let size = 0;
  const input = entry.buffer ? Readable.from([entry.buffer]) : fs.createReadStream(entry.path);
  for await (const chunk of input) {
    crc = crc32Update(crc, chunk); size += chunk.length;
    await writeWithBackpressure(response, chunk); archiveState.offset += chunk.length;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12);
  await writeWithBackpressure(response, descriptor); archiveState.offset += descriptor.length;

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0808, 8); central.writeUInt16LE(0, 10);
  central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24);
  central.writeUInt16LE(filename.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
  central.writeUInt32LE(localOffset, 42);
  archiveState.directory.push(Buffer.concat([central, filename]));
  archiveState.count += 1;
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

const requireTaToken = asyncRoute(async (req, res, next) => {
  const result = await pool.query('SELECT edit_token_hash FROM tas WHERE id = $1 AND archived_at IS NULL', [req.params.id]);
  const token = req.get('x-edit-token') || req.query.token || '';
  if (!result.rowCount || !safeEqual(result.rows[0].edit_token_hash, tokenHash(token))) return res.status(403).json({ error: 'A valid TA edit link is required.' });
  next();
});
const requireProfessorToken = asyncRoute(async (req, res, next) => {
  const result = await pool.query('SELECT edit_token_hash FROM professors WHERE id = $1 AND archived_at IS NULL', [req.params.id]);
  const token = req.get('x-edit-token') || req.query.token || '';
  if (!result.rowCount || !safeEqual(result.rows[0].edit_token_hash, tokenHash(token))) return res.status(403).json({ error: 'A valid professor edit link is required.' });
  next();
});
const requireAdmin = (req, res, next) => {
  const key = req.get('x-admin-key') || req.body?.adminKey || req.query.key || '';
  if (!process.env.ADMIN_KEY || !safeEqual(process.env.ADMIN_KEY, key)) return res.status(403).json({ error: 'Invalid master admin key.' });
  next();
};

function saveUpload(file) {
  if (!file) return null;
  const extension = path.extname(file.originalname).toLowerCase();
  const filename = `${crypto.randomUUID()}${extension}`;
  fs.writeFileSync(path.join(uploadDir, filename), file.buffer, { flag: 'wx' });
  return `/uploads/${filename}`;
}
function removeUpload(uploadPath) {
  if (!uploadPath?.startsWith('/uploads/')) return;
  const filePath = path.join(uploadDir, path.basename(uploadPath));
  try { fs.unlinkSync(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const compoundView = `SELECT c.id AS compound_id, c.name, c.molecular_formula, c.molecular_weight, c.smiles, c.compound_type, c.extra_properties,
  s.id AS synthesis_id, s.procedure, s.yield, s.date_made, s.status, s.image_path, s.chemdraw_file_path, s.created_at,
  p.id AS professor_id, p.name AS professor_name,
  json_agg(json_build_object('id', t.id, 'name', t.name, 'batch_year', t.batch_year) ORDER BY t.name) AS creators
  FROM synthesis_records s JOIN compounds c ON c.id = s.compound_id
  JOIN professors p ON p.id = s.professor_id JOIN synthesis_creators sc ON sc.synthesis_record_id = s.id
  JOIN tas t ON t.id = sc.ta_id`;
const normalizeIds = (value) => [...new Set((Array.isArray(value) ? value : [value]).map((id) => text(id, 36)).filter(Boolean))];
async function setTaProfessors(client, taId, professorIds) {
  const ids = normalizeIds(professorIds);
  const found = ids.length ? await client.query('SELECT id FROM professors WHERE id=ANY($1::uuid[]) AND archived_at IS NULL', [ids]) : { rowCount: 0 };
  if (found.rowCount !== ids.length) throw Object.assign(new Error('One or more professors were not found.'), { status: 400 });
  await client.query('UPDATE ta_professors SET is_active=false,updated_at=now() WHERE ta_id=$1 AND is_active=true AND NOT (professor_id=ANY($2::uuid[]))', [taId,ids]);
  for (const professorId of ids) {
    await client.query(`INSERT INTO ta_professors (ta_id,professor_id,is_active) VALUES ($1,$2,true)
      ON CONFLICT (ta_id,professor_id) DO UPDATE SET is_active=true,updated_at=now()`, [taId,professorId]);
  }
  await client.query('UPDATE tas SET professor_id=$2,updated_at=now() WHERE id=$1', [taId,ids[0] || null]);
  return ids;
}

app.get('/api/home', asyncRoute(async (_req, res) => {
  const professors = await pool.query(`SELECT p.id, p.name, p.department, p.lab_name, p.research_area, count(DISTINCT t.id)::int AS ta_count, count(DISTINCT tc.id)::int AS compound_count
      FROM professors p LEFT JOIN ta_professors tp ON tp.professor_id=p.id AND tp.is_active=true
      LEFT JOIN tas t ON t.id=tp.ta_id AND t.archived_at IS NULL
      LEFT JOIN ta_compounds tc ON tc.ta_id=t.id
      WHERE p.archived_at IS NULL GROUP BY p.id ORDER BY p.name`);
  res.json({ professors: professors.rows });
}));

app.get('/api/search', asyncRoute(async (req, res) => {
  const query = text(req.query.q, 120).replace(/\s+/g, ' ');
  if (!query) return res.json({ people: [], taCompounds: [] });
  const [people, taCompounds] = await Promise.all([
    pool.query(`SELECT * FROM (
      SELECT 'ta' AS kind, t.id, t.name, COALESCE(string_agg(DISTINCT p.name, ', ' ORDER BY p.name), '') AS professor_name, t.batch_year,
        (SELECT count(*)::int FROM ta_compounds tc WHERE tc.ta_id=t.id) AS compound_count
      FROM tas t LEFT JOIN ta_professors tp ON tp.ta_id=t.id AND tp.is_active=true LEFT JOIN professors p ON p.id=tp.professor_id AND p.archived_at IS NULL
      WHERE t.archived_at IS NULL AND (
        (SELECT bool_and(concat_ws(' ', t.name, p.name, t.bio) ILIKE '%' || term || '%')
          FROM unnest(regexp_split_to_array(lower($1), '[[:space:]]+')) AS term)
        OR t.name ILIKE '%' || $1 || '%'
      )
      GROUP BY t.id
      UNION ALL
      SELECT 'professor', p.id, p.name, p.name, NULL::int,
        (SELECT count(*)::int FROM ta_compounds tc JOIN ta_professors tp ON tp.ta_id=tc.ta_id AND tp.is_active=true WHERE tp.professor_id=p.id)
      FROM professors p
      WHERE p.archived_at IS NULL AND (
        (SELECT bool_and(p.name ILIKE '%' || term || '%')
          FROM unnest(regexp_split_to_array(lower($1), '[[:space:]]+')) AS term)
        OR p.name ILIKE '%' || $1 || '%'
      )
    ) results ORDER BY CASE WHEN lower(name)=lower($1) THEN 0 WHEN name ILIKE $1 || '%' THEN 1 ELSE 2 END, name LIMIT 20`, [query]),
    pool.query(`SELECT tc.id,tc.ta_id,t.name AS researcher_name,tc.compound_name,tc.cdx_file_name,
        COALESCE(string_agg(DISTINCT p.name, ', ' ORDER BY p.name), '') AS professor_name
      FROM ta_compounds tc JOIN tas t ON t.id=tc.ta_id AND t.archived_at IS NULL
      LEFT JOIN ta_professors tp ON tp.ta_id=t.id AND tp.is_active=true
      LEFT JOIN professors p ON p.id=tp.professor_id AND p.archived_at IS NULL
      WHERE (
        (SELECT bool_and(concat_ws(' ', tc.compound_name, tc.cdx_file_name) ILIKE '%' || term || '%')
          FROM unnest(regexp_split_to_array(lower($1), '[[:space:]]+')) AS term)
        OR tc.compound_name ILIKE '%' || $1 || '%' OR tc.cdx_file_name ILIKE '%' || $1 || '%'
      )
      GROUP BY tc.id,t.name ORDER BY CASE WHEN lower(tc.compound_name)=lower($1) THEN 0 WHEN tc.compound_name ILIKE $1 || '%' THEN 1 ELSE 2 END, tc.compound_name LIMIT 12`, [query])
  ]);
  res.json({ people: people.rows, taCompounds: taCompounds.rows });
}));

app.get('/api/professors/:id', asyncRoute(async (req, res) => {
  const [professor, tas] = await Promise.all([
    pool.query('SELECT id,name,department,lab_name,photo,research_area FROM professors WHERE id=$1 AND archived_at IS NULL', [req.params.id]),
    pool.query(`SELECT t.id,t.name,t.batch_year,t.bio,t.photo,t.is_alumni, count(tc.id)::int AS compound_count FROM tas t
      JOIN ta_professors tp ON tp.ta_id=t.id AND tp.is_active=true
      LEFT JOIN ta_compounds tc ON tc.ta_id=t.id
      WHERE tp.professor_id=$1 AND t.archived_at IS NULL GROUP BY t.id ORDER BY t.name`, [req.params.id])
  ]);
  if (!professor.rowCount) return res.status(404).json({ error: 'Professor not found.' });
  res.json({ professor: professor.rows[0], tas: tas.rows });
}));

app.get('/api/tas/:id', asyncRoute(async (req, res) => {
  const token = req.get('x-edit-token') || '';
  const tokenResult = token ? await pool.query('SELECT edit_token_hash FROM tas WHERE id=$1 AND archived_at IS NULL', [req.params.id]) : null;
  const owner = Boolean(tokenResult?.rowCount && safeEqual(tokenResult.rows[0].edit_token_hash, tokenHash(token)));
  const [ta, taCompounds] = await Promise.all([
    pool.query(`SELECT t.id,t.name,t.roll_number,t.email,t.batch_year,t.bio,t.photo,t.is_alumni,
      COALESCE(json_agg(json_build_object('id',p.id,'name',p.name,'department',p.department,'lab_name',p.lab_name))
        FILTER (WHERE p.id IS NOT NULL),'[]'::json) AS professors
      FROM tas t LEFT JOIN ta_professors tp ON tp.ta_id=t.id AND tp.is_active=true
      LEFT JOIN professors p ON p.id=tp.professor_id AND p.archived_at IS NULL WHERE t.id=$1 AND t.archived_at IS NULL GROUP BY t.id`, [req.params.id]),
    pool.query(`SELECT id,compound_name,molecular_formula,image_path,cdx_file_path,cdx_file_name,notes,created_at FROM ta_compounds WHERE ta_id=$1 ORDER BY compound_name`, [req.params.id])
  ]);
  if (!ta.rowCount) return res.status(404).json({ error: 'TA not found.' });
  if (!owner) { delete ta.rows[0].roll_number; delete ta.rows[0].email; }
  res.json({ ta: ta.rows[0], taCompounds: taCompounds.rows, owner });
}));

app.get('/api/tas/:id/compounds.zip', asyncRoute(async (req, res) => {
  const [taResult, compoundsResult] = await Promise.all([
    pool.query('SELECT name FROM tas WHERE id=$1 AND archived_at IS NULL', [req.params.id]),
    pool.query(`SELECT compound_name,molecular_formula,image_path,cdx_file_path,cdx_file_name
      FROM ta_compounds WHERE ta_id=$1 ORDER BY compound_name`, [req.params.id])
  ]);
  if (!taResult.rowCount) return res.status(404).json({ error: 'Researcher profile not found.' });
  if (!compoundsResult.rowCount) return res.status(404).json({ error: 'This researcher has no compounds to download.' });

  const folder = safeArchiveName(taResult.rows[0].name);
  const entries = [];
  const manifest = [['Number', 'Compound', 'Formula', 'ChemDraw file', 'Structure preview', 'Status'].map(csvCell).join(',')];
  for (const [index, compound] of compoundsResult.rows.entries()) {
    const sequence = String(index + 1).padStart(3, '0');
    const compoundSlug = safeArchiveName(compound.compound_name).replace(/\s+/g, '_');
    const chemDrawName = safeArchiveName(compound.cdx_file_name || `compound-${sequence}.cdx`);
    const sourcePath = compound.cdx_file_path?.startsWith('/uploads/')
      ? path.resolve(uploadDir, path.basename(compound.cdx_file_path)) : null;
    const previewPath = compound.image_path?.startsWith('/uploads/')
      ? path.resolve(uploadDir, path.basename(compound.image_path)) : null;
    if (!sourcePath || !sourcePath.startsWith(`${uploadDir}${path.sep}`) || !fs.existsSync(sourcePath)) {
      return res.status(409).json({ error: `The ChemDraw source file for “${compound.compound_name}” is missing.` });
    }
    const archiveSourceName = `${folder}/${sequence}_${compoundSlug}_${chemDrawName}`;
    entries.push({ name: archiveSourceName, path: sourcePath });
    let archivePreviewName = '';
    if (previewPath && previewPath.startsWith(`${uploadDir}${path.sep}`) && fs.existsSync(previewPath)) {
      const previewExtension = path.extname(previewPath).toLowerCase() || '.png';
      archivePreviewName = `${folder}/${sequence}_${compoundSlug}_structure${previewExtension}`;
      entries.push({ name: archivePreviewName, path: previewPath });
    }
    manifest.push([sequence, compound.compound_name, compound.molecular_formula || '', chemDrawName, archivePreviewName ? path.basename(archivePreviewName) : '', 'Included'].map(csvCell).join(','));
  }
  const manifestName = `${folder}/manifest.csv`;
  entries.push({ name: manifestName, buffer: Buffer.from(`\ufeff${manifest.join('\r\n')}\r\n`, 'utf8') });
  const totalSize = entries.reduce((total, entry) => total + (entry.buffer?.length ?? fs.statSync(entry.path).size), 0);
  if (totalSize > 0xffffffff) return res.status(413).json({ error: 'This collection is too large for a single ZIP download.' });

  const zipFilename = `${folder}_compounds.zip`;
  res.status(200);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(zipFilename)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  const state = { offset: 0, count: 0, directory: [] };
  try {
    for (const entry of entries) await streamZipEntry(res, entry, state);
    const directoryOffset = state.offset;
    for (const record of state.directory) { await writeWithBackpressure(res, record); state.offset += record.length; }
    const directorySize = state.offset - directoryOffset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
    end.writeUInt16LE(state.count, 8); end.writeUInt16LE(state.count, 10);
    end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(directoryOffset, 16); end.writeUInt16LE(0, 20);
    await writeWithBackpressure(res, end); res.end();
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else throw error;
  }
}));

app.post('/api/tas/:id/ta-compounds', requireTaToken, taCompoundUpload.fields([{ name: 'structureImage', maxCount: 1 }, { name: 'chemdraw', maxCount: 1 }]), asyncRoute(async (req, res) => {
  const image = req.files?.structureImage?.[0];
  const drawing = req.files?.chemdraw?.[0];
  if (!text(req.body.compoundName, 200)) return res.status(400).json({ error: 'Compound name is required.' });
  if (!image || !drawing) return res.status(400).json({ error: 'Upload both a structure image and a ChemDraw file.' });
  if (image.size > 5 * 1024 * 1024) return res.status(413).json({ error: 'Structure image must be 5 MB or smaller.' });
  const imagePath = saveUpload(image);
  const cdxFilePath = saveUpload(drawing);
  const result = await pool.query(`INSERT INTO ta_compounds (ta_id,compound_name,molecular_formula,image_path,cdx_file_path,cdx_file_name,notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [req.params.id,text(req.body.compoundName,200),text(req.body.molecularFormula,80)||null,imagePath,cdxFilePath,path.basename(drawing.originalname),text(req.body.notes)]);
  res.status(201).json({ id: result.rows[0].id });
}));

app.post('/api/admin/tas/:id/ta-compounds', requireAdmin, taCompoundUpload.fields([{ name: 'structureImage', maxCount: 1 }, { name: 'chemdraw', maxCount: 1 }]), asyncRoute(async (req, res) => {
  const image = req.files?.structureImage?.[0];
  const drawing = req.files?.chemdraw?.[0];
  if (!text(req.body.compoundName, 200)) return res.status(400).json({ error: 'Compound name is required.' });
  if (!image || !drawing) return res.status(400).json({ error: 'Upload both a structure image and a ChemDraw file.' });
  if (image.size > 5 * 1024 * 1024) return res.status(413).json({ error: 'Structure image must be 5 MB or smaller.' });
  const ta = await pool.query('SELECT id FROM tas WHERE id=$1 AND archived_at IS NULL', [req.params.id]);
  if (!ta.rowCount) return res.status(404).json({ error: 'Active TA profile not found.' });
  const imagePath = saveUpload(image);
  const cdxFilePath = saveUpload(drawing);
  try {
    const result = await pool.query(`INSERT INTO ta_compounds (ta_id,compound_name,molecular_formula,image_path,cdx_file_path,cdx_file_name,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [req.params.id,text(req.body.compoundName,200),text(req.body.molecularFormula,80)||null,imagePath,cdxFilePath,path.basename(drawing.originalname),text(req.body.notes)]);
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    removeUpload(imagePath);
    removeUpload(cdxFilePath);
    throw error;
  }
}));

app.patch('/api/tas/:id/ta-compounds/:compoundId', requireTaToken, taCompoundUpload.fields([{ name: 'structureImage', maxCount: 1 }, { name: 'chemdraw', maxCount: 1 }]), asyncRoute(async (req, res) => {
  if (!text(req.body.compoundName, 200)) return res.status(400).json({ error: 'Compound name is required.' });
  const current = await pool.query('SELECT image_path,cdx_file_path,cdx_file_name FROM ta_compounds WHERE id=$1 AND ta_id=$2', [req.params.compoundId,req.params.id]);
  if (!current.rowCount) return res.status(404).json({ error: 'Compound not found for this TA.' });
  const image = req.files?.structureImage?.[0];
  const drawing = req.files?.chemdraw?.[0];
  if (image?.size > 5 * 1024 * 1024) return res.status(413).json({ error: 'Structure image must be 5 MB or smaller.' });
  const imagePath = image ? saveUpload(image) : current.rows[0].image_path;
  const cdxFilePath = drawing ? saveUpload(drawing) : current.rows[0].cdx_file_path;
  const cdxFileName = drawing ? path.basename(drawing.originalname) : current.rows[0].cdx_file_name;
  await pool.query(`UPDATE ta_compounds SET compound_name=$3,molecular_formula=$4,notes=$5,image_path=$6,cdx_file_path=$7,cdx_file_name=$8
    WHERE id=$1 AND ta_id=$2`, [req.params.compoundId,req.params.id,text(req.body.compoundName,200),text(req.body.molecularFormula,80)||null,text(req.body.notes),imagePath,cdxFilePath,cdxFileName]);
  if (image) removeUpload(current.rows[0].image_path);
  if (drawing) removeUpload(current.rows[0].cdx_file_path);
  res.json({ ok: true });
}));

app.delete('/api/tas/:id/ta-compounds/:compoundId', requireTaToken, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM ta_compounds WHERE id=$1 AND ta_id=$2 RETURNING image_path,cdx_file_path', [req.params.compoundId,req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Compound not found for this TA.' });
  removeUpload(result.rows[0].image_path);
  removeUpload(result.rows[0].cdx_file_path);
  res.json({ ok: true });
}));

app.get('/api/compounds/:id', asyncRoute(async (req, res) => {
  const result = await pool.query(`${compoundView} WHERE c.id=$1 AND s.status='approved' GROUP BY c.id,s.id,p.id ORDER BY s.created_at DESC`, [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Compound not found.' });
  res.json({ records: result.rows });
}));

app.post('/api/preview', upload.fields([{ name: 'chemdraw', maxCount: 1 }, { name: 'image', maxCount: 1 }]), asyncRoute(async (req, res) => {
  const drawing = req.files?.chemdraw?.[0];
  if (drawing && path.extname(drawing.originalname).toLowerCase() === '.cdxml') {
    try { return res.json({ ...parseCdxml(drawing.buffer), source: 'cdxml' }); }
    catch (error) { return res.status(422).json({ error: error.message }); }
  }
  if (drawing && !req.files?.image?.length) return res.status(422).json({ error: 'For .cdx, upload a PNG, JPEG, WEBP, or SVG structure image too.' });
  const image = req.files?.image?.[0];
  res.json({ formula: text(req.body.formula, 80), molecularWeight: Number(req.body.molecularWeight) || null, imagePreview: image ? `data:${image.mimetype};base64,${image.buffer.toString('base64')}` : null, source: drawing ? 'cdx-image' : 'manual' });
}));

app.post('/api/tas/:id/compounds', requireTaToken, upload.fields([{ name: 'chemdraw', maxCount: 1 }, { name: 'image', maxCount: 1 }]), asyncRoute(async (req, res) => {
  const body = req.body;
  const creators = [...new Set([req.params.id, ...String(body.creatorIds || '').split(',').filter(Boolean)])];
  const allCreators = await pool.query('SELECT id FROM tas WHERE id=ANY($1::uuid[])', [creators]);
  if (allCreators.rowCount !== creators.length) return res.status(400).json({ error: 'One or more creators do not exist.' });
  const professorId = text(body.professorId, 36);
  const linkedCreators = await pool.query('SELECT ta_id FROM ta_professors WHERE professor_id=$1 AND ta_id=ANY($2::uuid[]) AND is_active=true', [professorId,creators]);
  if (!professorId || linkedCreators.rowCount !== creators.length) return res.status(400).json({ error: 'Choose a professor linked to every creator.' });
  const drawing = req.files?.chemdraw?.[0];
  let chemistry = {};
  if (drawing && path.extname(drawing.originalname).toLowerCase() === '.cdxml') chemistry = parseCdxml(drawing.buffer);
  if (drawing && path.extname(drawing.originalname).toLowerCase() === '.cdx' && !req.files?.image?.length) return res.status(400).json({ error: '.cdx requires an accompanying structure image.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const compound = await client.query(`INSERT INTO compounds (name,molecular_formula,molecular_weight,smiles,compound_type,created_by)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [text(body.name, 200), chemistry.formula || text(body.formula, 80), chemistry.molecularWeight || (Number(body.molecularWeight) || null), text(body.smiles, 1000) || null, ['organic','inorganic','organometallic','polymer','other'].includes(body.compoundType) ? body.compoundType : 'other', req.params.id]);
    const svgPath = chemistry.svg ? saveUpload({ originalname: `${crypto.randomUUID()}.svg`, buffer: Buffer.from(chemistry.svg) }) : null;
    const imagePath = svgPath || saveUpload(req.files?.image?.[0]);
    const filePath = saveUpload(drawing);
    const synthesis = await client.query(`INSERT INTO synthesis_records (compound_id,professor_id,procedure,yield,date_made,status,image_path,chemdraw_file_path,created_by)
      VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8) RETURNING id`, [compound.rows[0].id, professorId, text(body.procedure), text(body.yield, 100), body.dateMade || null, imagePath, filePath, req.params.id]);
    for (const creator of creators) await client.query('INSERT INTO synthesis_creators (synthesis_record_id,ta_id) VALUES ($1,$2)', [synthesis.rows[0].id, creator]);
    await client.query('COMMIT');
    res.status(201).json({ id: compound.rows[0].id, synthesisId: synthesis.rows[0].id, status: 'pending' });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

app.patch('/api/tas/:id/synthesis/:synthesisId', requireTaToken, asyncRoute(async (req, res) => {
  const ownership = await pool.query('SELECT s.compound_id FROM synthesis_records s JOIN synthesis_creators sc ON sc.synthesis_record_id=s.id WHERE s.id=$1 AND sc.ta_id=$2', [req.params.synthesisId, req.params.id]);
  if (!ownership.rowCount) return res.status(404).json({ error: 'Synthesis record not found for this TA.' });
  if (req.body.professorId) {
    const link = await pool.query('SELECT 1 FROM ta_professors WHERE ta_id=$1 AND professor_id=$2 AND is_active=true', [req.params.id,req.body.professorId]);
    if (!link.rowCount) return res.status(400).json({ error: 'Choose one of this TA’s linked professors.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE compounds SET name=$2,molecular_formula=$3,molecular_weight=$4,smiles=$5,updated_at=now() WHERE id=$1`, [ownership.rows[0].compound_id,text(req.body.name,200),text(req.body.formula,80),Number(req.body.molecularWeight)||null,text(req.body.smiles,1000)||null]);
    await client.query(`UPDATE synthesis_records SET professor_id=COALESCE($5,professor_id),procedure=$2,yield=$3,date_made=$4,status='pending',updated_at=now() WHERE id=$1`, [req.params.synthesisId,text(req.body.procedure),text(req.body.yield,100),req.body.dateMade||null,req.body.professorId||null]);
    await client.query('COMMIT');
    res.json({ ok: true, status: 'pending' });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

app.delete('/api/tas/:id/synthesis/:synthesisId', requireTaToken, asyncRoute(async (req, res) => {
  const ownership = await pool.query('SELECT s.compound_id FROM synthesis_records s JOIN synthesis_creators sc ON sc.synthesis_record_id=s.id WHERE s.id=$1 AND sc.ta_id=$2', [req.params.synthesisId, req.params.id]);
  if (!ownership.rowCount) return res.status(404).json({ error: 'Synthesis record not found for this TA.' });
  await pool.query('DELETE FROM synthesis_records WHERE id=$1', [req.params.synthesisId]);
  await pool.query('DELETE FROM compounds c WHERE c.id=$1 AND NOT EXISTS (SELECT 1 FROM synthesis_records s WHERE s.compound_id=c.id)', [ownership.rows[0].compound_id]);
  res.json({ ok: true });
}));

app.patch('/api/tas/:id', requireTaToken, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE tas SET name=COALESCE(NULLIF($2,''),name),roll_number=$3,email=$4,batch_year=$5,bio=$6,is_alumni=$7,updated_at=now() WHERE id=$1 RETURNING id`, [req.params.id, text(req.body.name,200), text(req.body.rollNumber,80)||null, text(req.body.email,240)||null, Number(req.body.batchYear)||null, text(req.body.bio), Boolean(req.body.isAlumni)]);
    if (result.rowCount && req.body.professorIds) await setTaProfessors(client,req.params.id,req.body.professorIds);
    await client.query('COMMIT');
    res.json({ ok: Boolean(result.rowCount) });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

app.post('/api/admin/professors', requireAdmin, asyncRoute(async (req, res) => {
  const token = newToken();
  const result = await pool.query(`INSERT INTO professors (name,department,lab_name,research_area,edit_token_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id,name`, [text(req.body.name,200),text(req.body.department,200),text(req.body.labName,200),text(req.body.researchArea,1000),tokenHash(token)]);
  res.status(201).json({ professor: result.rows[0], editToken: token });
}));

app.post('/api/admin/tas', requireAdmin, asyncRoute(async (req, res) => {
  const token = newToken();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const professorIds = normalizeIds(req.body.professorIds || req.body.professorId);
    const result = await client.query(`INSERT INTO tas (name,roll_number,email,batch_year,bio,professor_id,edit_token_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,name`, [text(req.body.name,200),text(req.body.rollNumber,80)||null,text(req.body.email,240)||null,Number(req.body.batchYear)||null,text(req.body.bio),professorIds[0] || null,tokenHash(token)]);
    await setTaProfessors(client,result.rows[0].id,professorIds);
    await client.query('COMMIT');
    res.status(201).json({ ta: result.rows[0], editToken: token });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

app.post('/api/professors/:id/tas', requireProfessorToken, asyncRoute(async (req, res) => {
  const token = newToken();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const professorIds = normalizeIds([req.params.id,...normalizeIds(req.body.professorIds)]);
    const result = await client.query(`INSERT INTO tas (name,roll_number,email,batch_year,bio,professor_id,edit_token_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,name`, [text(req.body.name,200),text(req.body.rollNumber,80)||null,text(req.body.email,240)||null,Number(req.body.batchYear)||null,text(req.body.bio),req.params.id,tokenHash(token)]);
    await setTaProfessors(client,result.rows[0].id,professorIds);
    await client.query('COMMIT');
    res.status(201).json({ ta: result.rows[0], editToken: token });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

app.delete('/api/professors/:id/tas/:taId', requireProfessorToken, asyncRoute(async (req, res) => {
  const result = await pool.query('UPDATE ta_professors SET is_active=false,updated_at=now() WHERE ta_id=$1 AND professor_id=$2 AND is_active=true RETURNING ta_id', [req.params.taId,req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'TA is not linked to this professor.' });
  await pool.query('UPDATE tas SET professor_id=(SELECT professor_id FROM ta_professors WHERE ta_id=$1 AND is_active=true ORDER BY created_at LIMIT 1) WHERE id=$1 AND professor_id=$2', [req.params.taId,req.params.id]);
  res.json({ ok: true });
}));

app.patch('/api/admin/synthesis/:id/status', requireAdmin, asyncRoute(async (req, res) => {
  if (!['pending','approved','rejected','draft'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status.' });
  const result = await pool.query('UPDATE synthesis_records SET status=$2,updated_at=now() WHERE id=$1 RETURNING id,status', [req.params.id,req.body.status]);
  res.json(result.rows[0] || { error: 'Synthesis record not found.' });
}));

app.get('/api/admin/profiles', requireAdmin, asyncRoute(async (_req, res) => {
  const [professors, tas] = await Promise.all([
    pool.query('SELECT id,name FROM professors WHERE archived_at IS NULL ORDER BY name'),
    pool.query(`SELECT t.id,t.name,COALESCE(string_agg(DISTINCT p.name, ', ' ORDER BY p.name), '') AS professor_name
      FROM tas t LEFT JOIN ta_professors tp ON tp.ta_id=t.id AND tp.is_active=true
      LEFT JOIN professors p ON p.id=tp.professor_id AND p.archived_at IS NULL
      WHERE t.archived_at IS NULL GROUP BY t.id ORDER BY t.name`)
  ]);
  res.json({ professors: professors.rows, tas: tas.rows });
}));

app.delete('/api/admin/professors/:id', requireAdmin, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const professor = await client.query('UPDATE professors SET archived_at=now(),updated_at=now() WHERE id=$1 AND archived_at IS NULL RETURNING id', [req.params.id]);
    if (!professor.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Professor not found.' });
    }
    await client.query('UPDATE ta_professors SET is_active=false,updated_at=now() WHERE professor_id=$1 AND is_active=true', [req.params.id]);
    await client.query(`UPDATE tas SET professor_id=(SELECT professor_id FROM ta_professors WHERE ta_id=tas.id AND is_active=true ORDER BY created_at LIMIT 1),updated_at=now()
      WHERE professor_id=$1 AND archived_at IS NULL`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, archived: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

app.delete('/api/admin/tas/:id', requireAdmin, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ta = await client.query('UPDATE tas SET archived_at=now(),updated_at=now() WHERE id=$1 AND archived_at IS NULL RETURNING id', [req.params.id]);
    if (!ta.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'TA not found.' });
    }
    await client.query('UPDATE ta_professors SET is_active=false,updated_at=now() WHERE ta_id=$1 AND is_active=true', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, archived: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

app.post('/api/admin/tas/:id/professors', requireAdmin, asyncRoute(async (req, res) => {
  const professorId = text(req.body.professorId, 36);
  if (!professorId) return res.status(400).json({ error: 'Choose a faculty profile.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ta = await client.query('SELECT id FROM tas WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [req.params.id]);
    if (!ta.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'TA not found.' });
    }
    const current = await client.query('SELECT professor_id FROM ta_professors WHERE ta_id=$1 AND is_active=true', [req.params.id]);
    await setTaProfessors(client, req.params.id, [...current.rows.map((row) => row.professor_id), professorId]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));

app.post('/api/admin/regenerate/:kind/:id', requireAdmin, asyncRoute(async (req, res) => {
  const table = req.params.kind === 'professor' ? 'professors' : req.params.kind === 'ta' ? 'tas' : null;
  if (!table) return res.status(400).json({ error: 'Kind must be professor or ta.' });
  const token = newToken();
  const result = await pool.query(`UPDATE ${table} SET edit_token_hash=$2,updated_at=now() WHERE id=$1 RETURNING id`, [req.params.id, tokenHash(token)]);
  if (!result.rowCount) return res.status(404).json({ error: 'Profile not found.' });
  res.json({ id: result.rows[0].id, editToken: token });
}));

app.get('/api/admin/pending', requireAdmin, asyncRoute(async (_req, res) => {
  const result = await pool.query(`${compoundView} WHERE s.status IN ('pending','rejected','draft') GROUP BY c.id,s.id,p.id ORDER BY s.created_at DESC`);
  res.json({ records: result.rows });
}));

app.get(['/professor/:id','/ta/:id','/compound/:id'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/admin/roll/:rollNumber', requireAdmin, asyncRoute(async (req, res) => {
  const result = await pool.query(`SELECT t.id,t.name,t.batch_year,COALESCE(string_agg(DISTINCT p.name, ', ' ORDER BY p.name), '') AS professor_name
    FROM tas t LEFT JOIN ta_professors tp ON tp.ta_id=t.id AND tp.is_active=true
    LEFT JOIN professors p ON p.id=tp.professor_id AND p.archived_at IS NULL
    WHERE t.roll_number=$1 AND t.archived_at IS NULL GROUP BY t.id`, [text(req.params.rollNumber,80)]);
  res.json({ tas: result.rows });
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `File exceeds ${process.env.MAX_UPLOAD_MB || 10} MB.` : error.message });
  res.status(error.status || 500).json({ error: error.message || 'Internal server error.' });
});

const port = Number(process.env.PORT || 3000);
if (require.main === module) app.listen(port, () => console.log(`LabScholar running at http://localhost:${port}`));
module.exports = { app, pool };
