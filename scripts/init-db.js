require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const schema = await fs.readFile(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('Database schema is ready.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Database initialization failed:', error.message);
  process.exitCode = 1;
});