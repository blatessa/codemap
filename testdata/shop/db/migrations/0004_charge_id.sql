ALTER TABLE orders ADD COLUMN charge_id text;
CREATE INDEX orders_charge_id_idx ON orders (charge_id);
