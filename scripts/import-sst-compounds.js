require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { Pool } = require('pg');
const { parseCdx } = require('../lib/chemistry');

const archivePath = path.resolve(process.argv[2] || '');
const apply = process.argv.includes('--apply');
const targetProfessor = 'Dr. Sushant Kumar Shrivastava';
const targetTa = 'Subhanshi Shukla';
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function readZipEntries(zip) {
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdOffset = zip.lastIndexOf(eocdSignature, zip.length - 22);
  if (eocdOffset < 0) throw new Error('The supplied file is not a supported ZIP archive.');
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let cursor = zip.readUInt32LE(eocdOffset + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP central directory.');
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP entry: ${name}`);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (!data) throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    if (data.length !== size) throw new Error(`ZIP entry size check failed for ${name}.`);
    entries.push({ name: path.basename(name), data });
  }
  return entries;
}

async function main() {
  if (!process.argv[2] || !fs.existsSync(archivePath)) throw new Error('Pass the path to SST MS01 Compounds.zip.');
  const copiedFiles = [];
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;
  try {
    const files = readZipEntries(await fsp.readFile(archivePath))
      .filter((entry) => /^SST MS01 - MS 21-\d{2}\.cdx$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (files.length !== 17) throw new Error(`Expected 17 SST MS01 ChemDraw files; found ${files.length}. No database changes were made.`);
    const entries = files.map(({ name, data }) => {
      if (data.length > 10 * 1024 * 1024) throw new Error(`${name} exceeds the 10 MB ChemDraw upload limit.`);
      const preview = parseCdx(data);
      return { name, buffer: data, preview };
    });
    if (!apply) {
      console.log(`Dry run: parsed ${entries.length} ChemDraw structures; would keep ${targetProfessor}, add ${targetTa} under that professor, clear other lab data, and import the originals with SVG previews.`);
      console.log(`Preview parser found ${entries.reduce((sum, entry) => sum + entry.preview.atomCount, 0)} atoms and ${entries.reduce((sum, entry) => sum + entry.preview.bondCount, 0)} bonds across the archive.`);
      return;
    }

    const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
    await fsp.mkdir(uploadDir, { recursive: true });
    for (const entry of entries) {
      const storedName = `${crypto.randomUUID()}.cdx`;
      await fsp.writeFile(path.join(uploadDir, storedName), entry.buffer, { flag: 'wx' });
      copiedFiles.push(path.join(uploadDir, storedName));
      entry.path = `/uploads/${storedName}`;
      const previewName = `${crypto.randomUUID()}.svg`;
      await fsp.writeFile(path.join(uploadDir, previewName), entry.preview.svg, { flag: 'wx' });
      copiedFiles.push(path.join(uploadDir, previewName));
      entry.imagePath = `/uploads/${previewName}`;
    }

    const editToken = crypto.randomBytes(32).toString('base64url');
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('ALTER TABLE ta_compounds ALTER COLUMN image_path DROP NOT NULL');

    const foundProfessor = await client.query(`SELECT id FROM professors
      WHERE archived_at IS NULL AND lower(regexp_replace(name, '^dr\\.?\\s*', '')) = lower('Sushant Kumar Shrivastava') FOR UPDATE`);
    if (foundProfessor.rowCount > 1) throw new Error('More than one active Sushant Kumar Shrivastava professor profile exists. No data was committed.');
    let professorId = foundProfessor.rows[0]?.id;
    if (!professorId) {
      const professor = await client.query(`INSERT INTO professors (name,department,research_area,edit_token_hash)
        VALUES ($1,$2,$3,$4) RETURNING id`, [targetProfessor,'Department of Pharmaceutical Engineering and Technology, IIT (BHU) Varanasi','Pharmaceutical, medicinal and computational chemistry',tokenHash(crypto.randomBytes(32).toString('base64url'))]);
      professorId = professor.rows[0].id;
    }

    await client.query('DELETE FROM characterization_data');
    await client.query('DELETE FROM synthesis_creators');
    await client.query('DELETE FROM synthesis_records');
    await client.query('DELETE FROM compounds');
    await client.query('DELETE FROM ta_professor_history');
    await client.query('DELETE FROM ta_professors');
    await client.query('DELETE FROM ta_compounds');
    await client.query('DELETE FROM tas WHERE lower(name) <> lower($1)', [targetTa]);
    await client.query('UPDATE tas SET name=$1,roll_number=NULL,email=NULL,batch_year=NULL,bio=$2,photo=NULL,professor_id=$3,edit_token_hash=$4,archived_at=NULL,is_alumni=false,roster_active=true,updated_at=now() WHERE lower(name)=lower($1)', [targetTa,'Student researcher at IIT (BHU), Varanasi.',professorId,tokenHash(editToken)]);
    let ta = await client.query('SELECT id FROM tas WHERE lower(name)=lower($1) FOR UPDATE', [targetTa]);
    if (!ta.rowCount) ta = await client.query(`INSERT INTO tas (name,bio,professor_id,edit_token_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [targetTa,'Student researcher at IIT (BHU), Varanasi.',professorId,tokenHash(editToken)]);
    const taId = ta.rows[0].id;
    await client.query('DELETE FROM professors WHERE id<>$1', [professorId]);
    await client.query('INSERT INTO ta_professors (ta_id,professor_id,is_active) VALUES ($1,$2,true)', [taId,professorId]);
    for (const entry of entries) {
      const code = path.basename(entry.name, path.extname(entry.name)).replace(/^SST MS01 - /i, '');
      await client.query(`INSERT INTO ta_compounds (ta_id,compound_name,image_path,cdx_file_path,cdx_file_name,notes)
        VALUES ($1,$2,$3,$4,$5,'')`, [taId,`SST MS01 · ${code}`,entry.imagePath,entry.path,entry.name]);
    }
    await client.query('COMMIT');
    console.log(`Imported ${entries.length} ChemDraw files to ${targetTa} under ${targetProfessor}.`);
    console.log(`TA edit URL: ${process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`}/ta/${taId}?ta=${taId}&edit=${editToken}`);
    console.log('The ZIP contained no separate image exports; profile previews were rendered from the original ChemDraw atom coordinates, labels, charges, and bonds. Original CDX downloads remain unchanged.');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    await Promise.all(copiedFiles.map((file) => fsp.unlink(file).catch(() => {})));
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(`Import failed: ${error.message}`); process.exitCode = 1; });
