require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('node:crypto');

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const ids = {
  professorA: '10000000-0000-4000-8000-000000000001', professorB: '10000000-0000-4000-8000-000000000002',
  taA: '20000000-0000-4000-8000-000000000001', taB: '20000000-0000-4000-8000-000000000002', taC: '20000000-0000-4000-8000-000000000003',
  benzene: '30000000-0000-4000-8000-000000000001', waterCompound: '30000000-0000-4000-8000-000000000002', methane: '30000000-0000-4000-8000-000000000003',
  benzeneA: '40000000-0000-4000-8000-000000000001', benzeneB: '40000000-0000-4000-8000-000000000002', waterRecord: '40000000-0000-4000-8000-000000000003', methaneRecord: '40000000-0000-4000-8000-000000000004'
};

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const profs = [
      [ids.professorA, 'Dr. Mira Sen', 'Department of Chemistry', 'Molecular Materials Lab', 'Organic materials and functional molecules', 'demo-professor-sen-edit-link'],
      [ids.professorB, 'Prof. Arjun Rao', 'Department of Chemistry', 'Catalysis & Coordination Lab', 'Coordination chemistry and catalysis', 'demo-professor-rao-edit-link']
    ];
    for (const item of profs) await client.query(`INSERT INTO professors (id,name,department,lab_name,research_area,edit_token_hash) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`, [...item.slice(0,5),hash(item[5])]);
    const tas = [
      [ids.taA, 'Ananya Iyer', 'LS-2024-01', 'ananya@example.test', 2024, 'Working on small aromatic systems and spectroscopy.', ids.professorA, 'demo-ta-ananya-edit-link'],
      [ids.taB, 'Rohan Das', null, null, 2023, 'Interested in synthesis and structure-property relationships.', ids.professorA, 'demo-ta-rohan-edit-link'],
      [ids.taC, 'Zoya Khan', 'LS-2025-08', 'zoya@example.test', 2025, 'Exploring coordination compounds and their properties.', ids.professorB, 'demo-ta-zoya-edit-link']
    ];
    for (const item of tas) await client.query(`INSERT INTO tas (id,name,roll_number,email,batch_year,bio,professor_id,edit_token_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`, [...item.slice(0,7),hash(item[7])]);
    for (const item of tas) await client.query('INSERT INTO ta_professors (ta_id,professor_id) VALUES ($1,$2) ON CONFLICT (ta_id,professor_id) DO NOTHING', [item[0],item[6]]);
    const compounds = [
      [ids.benzene, 'Benzene', 'C6H6', 78.114, 'c1ccccc1', 'organic', ids.taA],
      [ids.waterCompound, 'Water', 'H2O', 18.015, 'O', 'inorganic', ids.taC],
      [ids.methane, 'Methane', 'CH4', 16.043, 'C', 'organic', ids.taB]
    ];
    for (const item of compounds) await client.query(`INSERT INTO compounds (id,name,molecular_formula,molecular_weight,smiles,compound_type,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, item);
    const records = [
      [ids.benzeneA, ids.benzene, ids.professorA, ids.taA, 'Aromatic reference compound prepared for the teaching collection.', '84%', '2025-02-11', 'approved', '/samples/benzene.svg', '/samples/benzene.cdxml'],
      [ids.benzeneB, ids.benzene, ids.professorA, ids.taB, 'Independent preparation and characterization.', '79%', '2025-03-04', 'approved', '/samples/benzene.svg', '/samples/benzene.cdxml'],
      [ids.waterRecord, ids.waterCompound, ids.professorB, ids.taC, 'Reference sample for the coordination chemistry lab.', '—', '2025-04-18', 'approved', '/samples/water.svg', '/samples/water.cdxml'],
      [ids.methaneRecord, ids.methane, ids.professorA, ids.taB, 'Demo record awaiting professor review.', '—', '2025-05-02', 'pending', '/samples/methane.svg', '/samples/methane.cdxml']
    ];
    for (const row of records) {
      const [recordId,compoundId,professorId,taId,procedure,yieldValue,dateMade,status,imagePath,filePath] = row;
      await client.query(`INSERT INTO synthesis_records (id,compound_id,professor_id,procedure,yield,date_made,status,image_path,chemdraw_file_path,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`, [recordId,compoundId,professorId,procedure,yieldValue,dateMade,status,imagePath,filePath,taId]);
      await client.query('INSERT INTO synthesis_creators (synthesis_record_id,ta_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [recordId,taId]);
    }
    await client.query('COMMIT');
    console.log('Seed data added. Demo edit tokens are listed in README.md.');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
}
seed().catch((error) => { console.error('Seeding failed:', error.message); process.exitCode = 1; });