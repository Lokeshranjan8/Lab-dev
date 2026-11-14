require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { Pool } = require('pg');
const { parseCdx } = require('../lib/chemistry');

const archiveDir = process.env.SST_ARCHIVE_DIR || '/home/lokeshranjan/Downloads/SKS-LAB';
const archives = [
  { file: path.join(archiveDir, 'SST KS01.zip'), group: 'SST KS01' },
  { file: path.join(archiveDir, 'SST KS02.zip'), group: 'SST KS02' },
  { file: path.join(archiveDir, 'SST KS03.zip'), group: 'SST KS03' }
];
const professorName = 'Dr. Sushant Kumar Shrivastava';
const taName = 'Kamal Shah';
const professorId = '9c3031f5-404e-4618-857b-33bc57fae46d';
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function readZipEntries(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), zip.length - 22);
  if (eocd < 0) throw new Error('Invalid ZIP archive.');
  const count = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
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
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP entry ${name}.`);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = zip.subarray(start, start + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (!data || data.length !== size) throw new Error(`Unable to read ZIP entry ${name}.`);
    entries.push({ name: path.basename(name), data });
  }
  return entries;
}

async function readArchive(archive) {
  if (!fs.existsSync(archive.file)) throw new Error(`Archive not found: ${archive.file}`);
  const entries = readZipEntries(await fsp.readFile(archive.file)).filter((entry) => /\.cdx$/i.test(entry.name));
  if (!entries.length) throw new Error(`${path.basename(archive.file)} has no CDX files.`);
  return entries.map((entry) => {
    const stem = entry.name.replace(/\.cdx$/i, '');
    const match = stem.match(/^(SST KS0[123]) (C\d+ .+)$/i);
    if (!match || match[1].toUpperCase() !== archive.group) throw new Error(`Cannot identify collection, code, and compound name from ${entry.name}.`);
    if (entry.data.length > 10 * 1024 * 1024) throw new Error(`${entry.name} exceeds the 10 MB ChemDraw limit.`);
    const preview = parseCdx(entry.data);
    return { ...entry, compoundName: `${archive.group} · ${match[2]}`, preview, group: archive.group };
  }).sort((a, b) => a.compoundName.localeCompare(b.compoundName, undefined, { numeric: true }));
}

async function main() {
  const entries = (await Promise.all(archives.map(readArchive))).flat();
  const counts = archives.map((archive) => entries.filter((entry) => entry.group === archive.group).length);
  if (counts.some((count) => count === 0)) throw new Error(`Every archive must contain at least one ChemDraw file; found ${counts.join(', ')}.`);
  if (!process.argv.includes('--apply')) {
    console.log(`Dry run: parsed ${entries.length} structures from ${archives.length} archives (${counts.join(', ')} compounds).`);
    console.log(`Rendered preview data: ${entries.reduce((sum, entry) => sum + entry.preview.atomCount, 0)} atoms and ${entries.reduce((sum, entry) => sum + entry.preview.bondCount, 0)} bonds.`);
    console.log(`On apply: add these compounds to ${taName} under ${professorName}; other profiles and data are untouched.`);
    return;
  }

  const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
  await fsp.mkdir(uploadDir, { recursive: true });
  const copied = [];
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;
  let newEditToken;
  let imported = 0;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const professors = await client.query('SELECT id,name FROM professors WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [professorId]);
    if (professors.rowCount !== 1 || professors.rows[0].name !== professorName) throw new Error(`The known professor profile for ${professorName} was not found.`);
    let ta = await client.query('SELECT id FROM tas WHERE lower(name)=lower($1) AND archived_at IS NULL FOR UPDATE', [taName]);
    if (ta.rowCount > 1) throw new Error(`Multiple active ${taName} profiles were found.`);
    let taId;
    if (!ta.rowCount) {
      newEditToken = crypto.randomBytes(32).toString('base64url');
      ta = await client.query(`INSERT INTO tas (name,bio,professor_id,edit_token_hash)
        VALUES ($1,$2,$3,$4) RETURNING id`, [taName, 'Compounds from the SST KS01, SST KS02, and SST KS03 collections.', professorId, tokenHash(newEditToken)]);
    }
    taId = ta.rows[0].id;
    await client.query('UPDATE tas SET professor_id=$2,updated_at=now() WHERE id=$1', [taId, professorId]);
    await client.query(`INSERT INTO ta_professors (ta_id,professor_id,is_active) VALUES ($1,$2,true)
      ON CONFLICT (ta_id,professor_id) DO UPDATE SET is_active=true,updated_at=now()`, [taId, professorId]);
    const alreadyThere = await client.query('SELECT cdx_file_name FROM ta_compounds WHERE ta_id=$1 AND cdx_file_name IS NOT NULL', [taId]);
    const existingNames = new Set(alreadyThere.rows.map((row) => row.cdx_file_name));
    for (const entry of entries) {
      if (existingNames.has(entry.name)) continue;
      const cdxName = `${crypto.randomUUID()}.cdx`;
      const cdxLocalPath = path.join(uploadDir, cdxName);
      await fsp.writeFile(cdxLocalPath, entry.data, { flag: 'wx' });
      copied.push(cdxLocalPath);
      const svgName = `${crypto.randomUUID()}.svg`;
      const svgLocalPath = path.join(uploadDir, svgName);
      await fsp.writeFile(svgLocalPath, entry.preview.svg, { flag: 'wx' });
      copied.push(svgLocalPath);
      await client.query(`INSERT INTO ta_compounds (ta_id,compound_name,image_path,cdx_file_path,cdx_file_name,notes)
        VALUES ($1,$2,$3,$4,$5,'')`, [taId, entry.compoundName, `/uploads/${svgName}`, `/uploads/${cdxName}`, entry.name]);
      imported += 1;
    }
    await client.query('COMMIT');
    console.log(`Added ${imported} compounds to ${taName} under ${professorName}.`);
    if (newEditToken) console.log(`TA edit URL: ${process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`}/ta/${taId}?ta=${taId}&edit=${newEditToken}`);
    else console.log(`${taName} already had a profile; its existing edit token was preserved.`);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    await Promise.all(copied.map((file) => fsp.unlink(file).catch(() => {})));
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(`Import failed: ${error.message}`); process.exitCode = 1; });
