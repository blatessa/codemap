CREATE TABLE stock (
  sku        text PRIMARY KEY,
  on_hand    int NOT NULL DEFAULT 0,
  reserved   int NOT NULL DEFAULT 0,
  expires_at timestamptz
);
