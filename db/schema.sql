CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS professors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  lab_name TEXT NOT NULL DEFAULT '',
  photo TEXT,
  research_area TEXT NOT NULL DEFAULT '',
  edit_token_hash TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  roll_number TEXT,
  email TEXT,
  batch_year INTEGER,
  bio TEXT NOT NULL DEFAULT '',
  photo TEXT,
  professor_id UUID REFERENCES professors(id) ON DELETE RESTRICT,
  edit_token_hash TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  is_alumni BOOLEAN NOT NULL DEFAULT false,
  roster_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE professors ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE tas ALTER COLUMN professor_id DROP NOT NULL;
ALTER TABLE tas ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ta_professor_history (
  id BIGSERIAL PRIMARY KEY,
  ta_id UUID NOT NULL REFERENCES tas(id) ON DELETE CASCADE,
  professor_id UUID NOT NULL REFERENCES professors(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ta_professors (
  ta_id UUID NOT NULL REFERENCES tas(id) ON DELETE CASCADE,
  professor_id UUID NOT NULL REFERENCES professors(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ta_id, professor_id)
);

DROP TRIGGER IF EXISTS ta_professor_history_trigger ON tas;
DROP FUNCTION IF EXISTS record_ta_professor_change();

CREATE OR REPLACE FUNCTION record_ta_professor_link() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.is_active THEN
    INSERT INTO ta_professor_history (ta_id, professor_id) VALUES (NEW.ta_id, NEW.professor_id);
  ELSIF TG_OP = 'UPDATE' AND NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    IF NEW.is_active THEN
      INSERT INTO ta_professor_history (ta_id, professor_id) VALUES (NEW.ta_id, NEW.professor_id);
    ELSE
      UPDATE ta_professor_history SET ended_at = now()
        WHERE ta_id = OLD.ta_id AND professor_id = OLD.professor_id AND ended_at IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ta_professor_link_history_trigger ON ta_professors;
CREATE TRIGGER ta_professor_link_history_trigger
AFTER INSERT OR UPDATE OF is_active ON ta_professors
FOR EACH ROW EXECUTE FUNCTION record_ta_professor_link();

INSERT INTO ta_professors (ta_id, professor_id)
SELECT id, professor_id FROM tas WHERE roster_active=true AND professor_id IS NOT NULL
ON CONFLICT (ta_id, professor_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS ta_professors_professor_idx ON ta_professors (professor_id, is_active);

CREATE TABLE IF NOT EXISTS compounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  molecular_formula TEXT NOT NULL DEFAULT '',
  molecular_weight NUMERIC(12, 4),
  smiles TEXT,
  inchikey TEXT,
  compound_type TEXT NOT NULL DEFAULT 'other' CHECK (compound_type IN ('organic', 'inorganic', 'organometallic', 'polymer', 'other')),
  extra_properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES tas(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ta_compounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ta_id UUID NOT NULL REFERENCES tas(id) ON DELETE CASCADE,
  compound_name TEXT NOT NULL,
  molecular_formula TEXT,
  image_path TEXT,
  cdx_file_path TEXT NOT NULL,
  cdx_file_name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ta_compounds ADD COLUMN IF NOT EXISTS cdx_file_name TEXT NOT NULL DEFAULT '';
ALTER TABLE ta_compounds ALTER COLUMN image_path DROP NOT NULL;

CREATE INDEX IF NOT EXISTS ta_compounds_ta_created_idx ON ta_compounds (ta_id, created_at DESC);

CREATE TABLE IF NOT EXISTS synthesis_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compound_id UUID NOT NULL REFERENCES compounds(id) ON DELETE CASCADE,
  professor_id UUID NOT NULL REFERENCES professors(id) ON DELETE RESTRICT,
  procedure TEXT NOT NULL DEFAULT '',
  yield TEXT NOT NULL DEFAULT '',
  date_made DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  image_path TEXT,
  chemdraw_file_path TEXT,
  created_by UUID REFERENCES tas(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS synthesis_creators (
  synthesis_record_id UUID NOT NULL REFERENCES synthesis_records(id) ON DELETE CASCADE,
  ta_id UUID NOT NULL REFERENCES tas(id) ON DELETE RESTRICT,
  PRIMARY KEY (synthesis_record_id, ta_id)
);

CREATE TABLE IF NOT EXISTS characterization_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  synthesis_record_id UUID NOT NULL REFERENCES synthesis_records(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('NMR', 'IR', 'MS', 'mp')),
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  file_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'professor', 'ta')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS professors_name_trgm_idx ON professors USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tas_name_trgm_idx ON tas USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS compounds_name_trgm_idx ON compounds USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS compounds_formula_idx ON compounds (molecular_formula);
CREATE INDEX IF NOT EXISTS tas_roll_number_idx ON tas (roll_number);
CREATE INDEX IF NOT EXISTS synthesis_status_idx ON synthesis_records (status);
CREATE INDEX IF NOT EXISTS synthesis_created_idx ON synthesis_records (created_at DESC);
