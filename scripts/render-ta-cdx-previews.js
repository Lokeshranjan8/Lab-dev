require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { parseCdx } = require('../lib/chemistry');

async function main() {
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;
  const written = [];
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const compounds = await client.query(`SELECT id,compound_name,cdx_file_path FROM ta_compounds
      WHERE image_path IS NULL AND cdx_file_path LIKE '/uploads/%' ORDER BY compound_name FOR UPDATE`);
    for (const compound of compounds.rows) {
      const cdxName = path.basename(compound.cdx_file_path);
      const cdxBuffer = await fs.readFile(path.join(uploadDir, cdxName));
      const rendered = parseCdx(cdxBuffer);
      const imageName = `${crypto.randomUUID()}.svg`;
      const imageFile = path.join(uploadDir, imageName);
      await fs.writeFile(imageFile, rendered.svg, { flag: 'wx' });
      written.push(imageFile);
      await client.query('UPDATE ta_compounds SET image_path=$2 WHERE id=$1 AND image_path IS NULL', [compound.id,`/uploads/${imageName}`]);
      console.log(`${compound.compound_name}: rendered ${rendered.atomCount} atoms and ${rendered.bondCount} bonds.`);
    }
    await client.query(`UPDATE ta_compounds SET notes=''
      WHERE compound_name LIKE 'SST MS01 · MS 21-%' AND image_path IS NOT NULL`);
    await client.query('COMMIT');
    console.log(`Added ${written.length} structure previews.`);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    await Promise.all(written.map((file) => fs.unlink(file).catch(() => {})));
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(`Preview generation failed: ${error.message}`); process.exitCode = 1; });
