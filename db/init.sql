-- Core tables
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  name CITEXT NOT NULL UNIQUE,
  category TEXT NOT NULL
);



CREATE TABLE IF NOT EXISTS inventory (
  item_id INT PRIMARY KEY REFERENCES items(id),
  quantity INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OK',
  last_updated TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scans (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  image_ref TEXT,
  delta_skipped BOOLEAN NOT NULL DEFAULT FALSE,
  prev_scan_id INT REFERENCES scans(id)
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  scan_id INT REFERENCES scans(id),
  item_id INT REFERENCES items(id),
  action TEXT NOT NULL, -- Added | Removed | DoorOpened | DoorClosed
  confidence REAL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Detections per scan (for CV flow)
CREATE TABLE IF NOT EXISTS scan_detections (
  id SERIAL PRIMARY KEY,
  scan_id INT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);



CREATE INDEX IF NOT EXISTS idx_scan_detections_scan_id ON scan_detections(scan_id);

-- Seed (safe / idempotent-ish)
INSERT INTO items(name, category) VALUES
('Milk','Dairy'),
('Eggs','Dairy'),
('Yogurt','Dairy'),
('Broccoli','Vegetables')
ON CONFLICT (name) DO NOTHING;

-- Seed inventory
INSERT INTO inventory(item_id, quantity, status)
SELECT id, 0, 'MISSING' FROM items WHERE name IN ('Eggs','Milk')
ON CONFLICT (item_id) DO NOTHING;

INSERT INTO inventory(item_id, quantity, status)
SELECT id, 1, 'OK' FROM items WHERE name IN ('Yogurt','Broccoli')
ON CONFLICT (item_id) DO NOTHING;
