# LabScholar

A small public showcase for chemistry lab work. Visitors can search people and compounds, browse professor and TA profiles, and download original ChemDraw files. TA and professor editing is protected by private random links; professors review synthesis records from an owner-only queue. Phase 1 has no login or passwords.

## Stack

- Node.js 20 or newer, Express, plain HTML/CSS/JavaScript
- PostgreSQL 13+ with `pg_trgm`
- Local disk uploads in `uploads/`

## Run locally

1. Install Node.js 20+ and PostgreSQL 13+.
2. Create an empty database, for example `createdb labscholar`.
3. Copy `.env.example` to `.env`, then set `DATABASE_URL` and replace `ADMIN_KEY` with a long random value. `pg_trgm` must be installable by the database user used for schema initialization.
4. Install dependencies and initialize the schema:

   ```sh
   npm install
   npm run db:init
   ```

   Re-run `npm run db:init` after updating an existing installation. It adds profile archive fields and allows TA profiles to exist without a faculty link. Admin profile deletion archives the profile and preserves historical lab records.

5. Start the app:

   ```sh
   npm start
   ```

6. Open `http://localhost:3000`.

For development, `npm run dev` restarts Node when server files change. `npm test` runs CDXML parser tests.

## Run with Docker

1. Install Docker Engine with the Compose plugin.
2. Copy `.env.example` to `.env`. Replace `POSTGRES_PASSWORD` and `ADMIN_KEY` before sharing the environment. Use a URL-safe database password because Compose builds the PostgreSQL connection URL from it.
3. Build and start the app and database:

   ```sh
   docker compose up --build
   ```

   Compose waits for PostgreSQL, initializes the schema, and starts the app. Open `http://localhost:3000`.

4. Stop the services with `docker compose down`. Database and uploads persist in named volumes. To remove the volumes and all local data as well, run `docker compose down -v`.

The app uses a two-stage `node:22-alpine` image, production-only dependencies, a non-root user, a read-only root filesystem, and a health check. PostgreSQL uses `postgres:17-alpine`. The sample `.env` values are for local development only.

## Local SST MS01 profile data

Use the import command below to populate the local SST MS01 prototype. Docker startup does not add demo profiles, so imported data remains the active dataset after app restarts. The admin dialog accepts the value from `ADMIN_KEY`.

## TA compound uploads

TA profiles have a separate compound gallery for personal uploads. Each entry stores one structure image (PNG, JPG, or SVG, maximum 5 MB) and one original ChemDraw file (CDX or CDXML, maximum 10 MB). The public profile displays the image and offers the ChemDraw download; the TA edit link is required to add, edit, or delete entries. These uploads use the `ta_compounds` table in `db/schema.sql`, separate from the existing molecule catalog and professor-approved synthesis records. Run `npm run db:init` to apply the table to an existing database.

For the local SST MS01 prototype, `npm run db:import-sst -- "/path/to/SST MS01 Compounds.zip"` parses the 17 expected CDX files. Add `--apply` to keep Dr. Sushant Kumar Shrivastava, replace other lab data with Subhanshi Shukla under that professor, and import the original CDX files with SVG structure previews rendered from their atom coordinates, labels, charges, and bonds. This import clears synthesis records and other TA profiles. Previews use the saved ChemDraw structure data; original CDX downloads keep the source filenames. The import prints Subhanshi's private edit URL once.

## Chemistry files

Uploads accept `.cdxml` and `.cdx` attachments, plus PNG/JPEG/WEBP/SVG structure images. Files are stored as received on disk and served as downloads. `.cdxml` is parsed on the server for atom/bond preview rendering and a formula/molecular-weight estimate. The estimate uses common element valences and adds implicit hydrogens; it is a prototype calculation, not a validated chemistry engine. `.cdx` is not parsed; it requires a matching image export. `.chm` is unsupported. Upload size defaults to 10 MB and can be changed with `MAX_UPLOAD_MB`.

A molecule is stored once in `compounds`; each synthesis by a creator group is its own `synthesis_records` row. Every synthesis record captures its professor and creator TA IDs. Changing the TA's current professor adds an affiliation-history row and leaves old synthesis records attached to their original professor.

## Done and simplified

- Public home, fuzzy people/compound search, exact formula matching, professor/TA/compound views.
- Token-protected TA compound create/edit/delete and profile editing; professor token-protected TA add/remove; admin-key creation, link regeneration, and approval/rejection.
- Pending records are visible only to owner/admin views until approved. Editing a record returns it to pending.
- PostgreSQL schema includes a reserved unused `users` table with `password_hash` and `role`, timestamps, JSONB properties, characterization data, and TA-professor history.
- CDXML molecular weight/formula inference is intentionally basic. SMILES is saved as text but is not independently parsed into a structure. No binary CDX conversion is included.
- Profile photo uploads, rich characterization-entry UI, pagination, rate limiting, audit logs, and production deployment hardening are not included.

## Login phase

The `users` table is reserved, but no authentication code uses it. The next phase should add password hashing (Argon2id or bcrypt), account-to-TA/professor links, session or short-lived token handling, authorization migration from secret links, and a process to attach existing profiles to accounts. Rotate `ADMIN_KEY`, disable or replace the predictable seed links, use HTTPS, and review the security model before public deployment.
