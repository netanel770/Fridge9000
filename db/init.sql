CREATE EXTENSION IF NOT EXISTS citext;

-- Items
CREATE TABLE items (
  id SERIAL PRIMARY KEY,
  name CITEXT NOT NULL UNIQUE,
  category TEXT NOT NULL
);

-- Inventory (accumulated state)
CREATE TABLE inventory (
  item_id INT PRIMARY KEY REFERENCES items(id),
  quantity INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  status TEXT NOT NULL DEFAULT 'OK',
  last_updated TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Scans (independent)
CREATE TABLE scans (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  image_ref TEXT
);

-- Events (log only)
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  scan_id INT REFERENCES scans(id),
  item_id INT REFERENCES items(id),
  action TEXT NOT NULL, -- DETECTED | MANUAL_ADD | MANUAL_REMOVE
  confidence REAL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Detections per scan
CREATE TABLE scan_detections (
  id SERIAL PRIMARY KEY,
  scan_id INT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scan_detections_scan_id ON scan_detections(scan_id);